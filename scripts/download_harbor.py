#!/usr/bin/env python3
"""
Harbor 离线安装包下载器（分块 + 断点续传 + 快速轮换源）

背景（均为实测结论）：
  · 直连 registry-1.docker.io 不可达（HTTP 000）
  · 三个 Docker 镜像加速站全部拒绝 goharbor 命名空间（403 / not found）
    → goharbor/* 镜像无法 docker pull
  · GitHub API 与 release 资产可达，官方提供离线包
    harbor-offline-installer-vX.Y.Z.tgz，内含全部镜像 tar，docker load 后完全离线运行
  · 单流直连 release-assets.githubusercontent.com 仅约 12 KB/s，ghfast.top 代理约 505 KB/s

为什么用 8 MiB 小块而不是大段：
  大分片一旦落在慢源上，要等整段超时才换源（实测掉速到 8MB/几分钟）。
  小块 + 每次 120 秒换源，慢源的代价被限制在 120 秒内。

用法：
  ./download_harbor.py <输出文件> [版本] [--workers N] [--chunk-mib N]
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

API = "https://api.github.com/repos/goharbor/harbor/releases"
SOURCES = [
    "https://ghfast.top/{asset}",
    "https://gh-proxy.com/{asset}",
    "{asset}",
]
ATTEMPT_TIMEOUT = 120          # 单次尝试上限（秒）
MAX_ATTEMPTS = 12             # 单块最大尝试次数


def fetch_release_meta(version: str) -> tuple[int, str, str]:
    """从 GitHub API 取离线包的 大小 / sha256 / 下载地址。"""
    url = f"{API}/tags/{version}" if version.startswith("v") else f"{API}/latest"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    for a in data.get("assets", []):
        n = a.get("name", "")
        if n.endswith(".tgz") and "offline" in n:
            digest = (a.get("digest") or "").split(":")[-1]
            return int(a["size"]), digest, a["browser_download_url"]
    raise SystemExit("在 release 中找不到离线安装包")


def download_chunk(asset: str, start: int, end: int, out_path: str, idx: int) -> bool:
    """下载单个块；成功返回 True。已存在且尺寸正确则直接跳过。"""
    want = end - start + 1
    if os.path.exists(out_path) and os.path.getsize(out_path) == want:
        return True
    tmp = out_path + ".part"
    for attempt in range(MAX_ATTEMPTS):
        src = SOURCES[(idx + attempt) % len(SOURCES)].format(asset=asset)
        if os.path.exists(tmp):
            os.remove(tmp)
        cmd = [
            "curl", "-sL", "--max-time", str(ATTEMPT_TIMEOUT),
            "-r", f"{start}-{end}", "-o", tmp, src,
        ]
        try:
            subprocess.run(cmd, timeout=ATTEMPT_TIMEOUT + 20,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            pass
        if os.path.exists(tmp) and os.path.getsize(tmp) == want:
            os.replace(tmp, out_path)
            return True
    return False


def main() -> int:
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/harbor-offline-installer.tgz"
    version = sys.argv[2] if len(sys.argv) > 2 else "v2.15.5"
    workers = 8
    chunk_mib = 8
    args = sys.argv[3:]
    for i, a in enumerate(args):
        if a == "--workers" and i + 1 < len(args):
            workers = int(args[i + 1])
        if a == "--chunk-mib" and i + 1 < len(args):
            chunk_mib = int(args[i + 1])

    size, expect_sha, asset = fetch_release_meta(version)
    chunk = chunk_mib * 1024 * 1024
    work = os.path.join(os.path.dirname(out), "harbor_dl_v2")
    os.makedirs(work, exist_ok=True)

    n_chunks = (size + chunk - 1) // chunk
    print(f"==> 版本 {version}  大小 {size/1024/1024:.0f} MB  {n_chunks} 块 × {chunk_mib} MiB  {workers} 并发")
    print(f"==> 期望 sha256 {expect_sha}")

    todo = []
    for i in range(n_chunks):
        s = i * chunk
        e = min(s + chunk - 1, size - 1)
        p = os.path.join(work, f"chunk.{i:04d}")
        if os.path.exists(p) and os.path.getsize(p) == e - s + 1:
            continue
        todo.append((i, s, e, p))

    print(f"==> 待下载 {len(todo)} 块（已命中缓存 {n_chunks - len(todo)} 块）")
    done = 0
    failed: list[int] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(download_chunk, asset, s, e, p, i): i for i, s, e, p in todo}
        for fut in as_completed(futs):
            idx = futs[fut]
            if fut.result():
                done += 1
                if done % 10 == 0 or done == len(todo):
                    print(f"    已完成 {done}/{len(todo)} 块", flush=True)
            else:
                failed.append(idx)

    if failed:
        print(f"==> 失败块: {failed}（缓存保留，重复运行可续传）", file=sys.stderr)
        return 1

    print("==> 拼接")
    with open(out, "wb") as w:
        for i in range(n_chunks):
            p = os.path.join(work, f"chunk.{i:04d}")
            with open(p, "rb") as r:
                while True:
                    b = r.read(4 * 1024 * 1024)
                    if not b:
                        break
                    w.write(b)

    actual_size = os.path.getsize(out)
    if actual_size != size:
        print(f"大小校验失败 {actual_size} != {size}", file=sys.stderr)
        return 1
    print(f"==> 校验 sha256（{size/1024/1024:.0f}MB，约 1 分钟）")
    h = hashlib.sha256()
    with open(out, "rb") as r:
        while True:
            b = r.read(8 * 1024 * 1024)
            if not b:
                break
            h.update(b)
    if h.hexdigest() != expect_sha:
        print(f"sha256 校验失败 {h.hexdigest()} != {expect_sha}", file=sys.stderr)
        return 1
    for i in range(n_chunks):
        os.remove(os.path.join(work, f"chunk.{i:04d}"))
    os.rmdir(work)
    print(f"==> 完成 {out}\n    sha256 {h.hexdigest()} ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
