#!/usr/bin/env python3
"""
Harbor 编排改造脚本 —— 把 Harbor 官方离线安装包生成的 docker-compose.yml
改造成符合本项目部署约定的版本。

为什么要改而不是直接用官方 install.sh：
  官方默认行为与本项目约定冲突三处 ——
    1. 容器名 harbor-core / harbor-db …（本项目重型栈统一 eapheavy- 前缀）
    2. 端口绑 0.0.0.0（本项目全部收口到 127.0.0.1，见 docs/network-access.md）
    3. 网络名 harbor（本项目重型栈统一 eapheavy_ 前缀）

改造只动「标识与暴露面」，**不动 Harbor 自身的服务拓扑与内部配置** ——
env 变量、依赖关系、健康检查、bind mount、数据卷路径一律保留官方原样。

注意：输出文件必须与官方生成的 common/ 目录**同级**，
因为 compose 里用的是 ./common/config/... 相对路径。

用法：
  python3 prepare_harbor.py <官方生成的 docker-compose.yml> <输出路径> [--host-port 8098]
"""
from __future__ import annotations

import argparse
import sys

import yaml

CONTAINER_PREFIX = "eapheavy-harbor-"
NETWORK_PREFIX = "eapheavy_"
# 发布 Harbor UI + Registry API 的服务（官方叫 proxy / nginx）
UI_SERVICES = {"proxy", "nginx"}


def eap_container_name(official: str) -> str:
    """官方名 → 本项目重型栈命名。

    官方名字不统一（harbor-log / registry / redis / nginx 混用），
    这里统一去掉 harbor- 前缀后再加 eapheavy-harbor- 前缀：
        harbor-log      → eapheavy-harbor-log
        registry        → eapheavy-harbor-registry
        redis           → eapheavy-harbor-redis
        nginx           → eapheavy-harbor-nginx
    """
    base = official[len("harbor-"):] if official.startswith("harbor-") else official
    return CONTAINER_PREFIX + base


def bind_loopback(port: str, host_port: int | None, svc: str) -> str:
    """把端口映射改成只绑回环。host_port 只作用于 UI 服务。"""
    parts = port.split(":")
    if len(parts) == 3:
        # 已是 host_ip:host:container —— 只替换 host_ip
        parts[0] = "127.0.0.1"
        return ":".join(parts)
    if len(parts) == 2:
        # host:container
        host = parts[0]
        if svc in UI_SERVICES and host_port:
            host = str(host_port)
        return f"127.0.0.1:{host}:{parts[1]}"
    # 单端口（container only）—— 不发布
    return port


def transform(doc: dict, host_port: int | None) -> dict:
    services = doc.get("services", {}) or {}

    # 1) 容器名统一为 eapheavy-harbor-*
    for svc in services.values():
        cn = svc.get("container_name")
        if cn:
            svc["container_name"] = eap_container_name(cn)

    # 2) 端口：全部收口到 127.0.0.1
    for name, svc in services.items():
        ports = svc.get("ports")
        if not ports:
            continue
        new_ports = []
        for p in ports:
            if isinstance(p, str):
                new_ports.append(bind_loopback(p, host_port, name))
            elif isinstance(p, dict):
                q = dict(p)
                if "published" in q:
                    q["host_ip"] = "127.0.0.1"
                    if name in UI_SERVICES and host_port:
                        q["published"] = host_port
                new_ports.append(q)
        svc["ports"] = new_ports

    # 3) 网络名加前缀（internal network，仅 Harbor 组件之间）
    nets = doc.get("networks")
    if nets:
        renamed = {}
        for k, v in nets.items():
            nk = NETWORK_PREFIX + k if not k.startswith(NETWORK_PREFIX) else k
            renamed[nk] = v
        doc["networks"] = renamed
        # 服务里的引用同步改
        for svc in services.values():
            sn = svc.get("networks")
            if isinstance(sn, list):
                svc["networks"] = [NETWORK_PREFIX + n if not n.startswith(NETWORK_PREFIX) else n
                                   for n in sn]
            elif isinstance(sn, dict):
                svc["networks"] = {NETWORK_PREFIX + k if not k.startswith(NETWORK_PREFIX) else k: v
                                   for k, v in sn.items()}

    return doc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--host-port", type=int, default=None,
                    help="UI/Registry 的宿主端口；缺省沿用官方生成值")
    a = ap.parse_args()

    with open(a.src, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    if not doc or "services" not in doc:
        print("源文件不像 compose 文件", file=sys.stderr)
        return 1

    out = transform(doc, a.host_port)
    with open(a.dst, "w", encoding="utf-8") as f:
        yaml.safe_dump(out, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    print(f"==> 已写出 {a.dst}")
    print(f"    容器: {', '.join(s['container_name'] for s in out['services'].values() if s.get('container_name'))}")
    for sn, s in out["services"].items():
        if s.get("ports"):
            print(f"    端口[{sn}]: {s['ports']}")
    print(f"    网络: {list((out.get('networks') or {}).keys())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
