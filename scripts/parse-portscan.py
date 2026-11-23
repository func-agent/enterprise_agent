#!/usr/bin/env python3
"""
check-host.net 外部多节点 TCP 扫描结果解析 —— 判定「某个公网 IP 的某个端口
从真正的外网是否可达」。

为什么需要它：VM/宿主机内部的自测**无法证明外网可达**（宿主机没做转发时，
内部一切正常，外网依然超时）。check-host.net 从多个国家的节点发起真实 TCP
连接，是最权威的公网视角判定。

用法：
  1) 先发起扫描并记录「端口 → request_id」对应关系：
     for PORT in 5173 8080 8082 5433; do
       RID=$(curl -s -H 'Accept: application/json' \\
         "https://check-host.net/check-tcp?host=$PUB_IP:$PORT&max_nodes=3" \\
         | python3 -c 'import sys,json;print(json.load(sys.stdin).get("request_id",""))')
       echo "$PORT $RID" >> /tmp/scan-map.txt
       sleep 2
     done

  2) 等结果生成后解析：
     python3 scripts/parse-portscan.py /tmp/scan-map.txt

  3) 只想看汇总（可选 --summary）：
     python3 scripts/parse-portscan.py /tmp/scan-map.txt --summary

退出码：0 = 所有「期望可达」的端口都可达；1 = 有端口不可达或无法判定。

公网地址不在仓库内写死：用环境变量 `EAP_PUBLIC_IP` 提供
（实际值见内部参数表 docs/internal/host-params.local.md）。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

RESULT_URL = "https://check-host.net/check-result/{rid}"
API = "https://check-host.net/check-tcp?host={host}:{port}&max_nodes={nodes}"

# check-host 的节点结论 → 语义
OK_WORDS = ("ok", "success", "accepted", "connection ok")
FAIL_WORDS = ("timeout", "timed out", "connection refused", "no route", "unreachable",
              "filtered", "connection reset", "error", "failed", "closed")


def fetch_json(url: str, timeout: int = 20):
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/json")
    # check-host.net 会拒绝 Python-urllib 的默认 UA（返回 403），必须伪装成浏览器
    req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                                 "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def classify(node: str) -> str:
    """把节点结论归一化成 成功 / 失败 / 未知。"""
    text = str(node).lower()
    if any(w in text for w in OK_WORDS):
        return "OK"
    if any(w in text for w in FAIL_WORDS):
        return "FAIL"
    return "?"


def node_message(res) -> str:
    """从单节点结果里取出可读结论。

    check-host.net 的返回形态：
      成功 → {"time": 123.45, "address": "1.2.3.4"}
      失败 → {"error": "Connection timed out"}
    """
    if isinstance(res, dict):
        if "error" in res:
            return str(res["error"])
        if "time" in res or "address" in res:
            return "ok"
        return str(res.get("message") or res.get("result") or res)
    return str(res)


def main(argv: list[str]) -> int:
    # argv 已是 sys.argv[1:]（不含程序名）
    if not argv:
        print(__doc__)
        return 2
    map_path = argv[0]
    summary_only = "--summary" in argv[1:]
    # 公网地址来自环境变量，仓库内不写死（公开仓库不应内置目标地址）。
    # 仅用于在结果里标注扫描目标；实际值见内部参数表 docs/internal/host-params.local.md
    host_default = os.environ.get("EAP_PUBLIC_IP", "")

    pairs: list[tuple[int, str]] = []
    with open(map_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            try:
                pairs.append((int(parts[0]), parts[1]))
            except ValueError:
                continue

    if not pairs:
        print(f"{map_path} 里没有可解析的「端口 request_id」记录")
        return 2

    # 等 check-host 出结果（最多等 3 轮，每轮 15s）
    results: dict[str, dict] = {}
    for attempt in range(3):
        results = {}
        for _, rid in pairs:
            try:
                results[rid] = fetch_json(RESULT_URL.format(rid=rid))
            except Exception as exc:  # 网络抖动 / 尚未生成
                results[rid] = {"_error": str(exc)}
        pending = [rid for rid, data in results.items() if "_error" in data or not data]
        if not pending:
            break
        if attempt < 2:
            time.sleep(15)

    ok_ports: list[int] = []
    bad_ports: list[int] = []
    unknown_ports: list[int] = []

    target = f"（目标 {host_default}）" if host_default else "（目标未指定 —— 设 EAP_PUBLIC_IP 可标注）"
    print(f"══ 外部多节点 TCP 扫描结果（公网视角）{target}\n")
    for port, rid in pairs:
        data = results.get(rid) or {}
        if "_error" in data or not data:
            print(f"  端口 {port}: 结果不可用（{data.get('_error', '尚未生成')}）")
            unknown_ports.append(port)
            continue
        verdicts: dict[str, str] = {}
        for node, res in data.items():
            verdicts[node] = classify(node_message(res))
        counts = {v: list(verdicts.values()).count(v) for v in set(verdicts.values())}
        ok_n = counts.get("OK", 0)
        fail_n = counts.get("FAIL", 0)
        total = len(verdicts)
        if ok_n and not fail_n:
            state = "✅ 可达"
            ok_ports.append(port)
        elif ok_n:
            state = f"⚠ 部分可达（{ok_n}/{total} 成功）"
            bad_ports.append(port)
        elif fail_n:
            state = "❌ 不可达"
            bad_ports.append(port)
        else:
            state = "❓ 无法判定"
            unknown_ports.append(port)

        print(f"  端口 {port:<6} {state}   （{ok_n} 成功 / {fail_n} 失败 / 共 {total} 节点）")
        if not summary_only:
            for node, verdict in sorted(verdicts.items()):
                mark = {"OK": "✓", "FAIL": "✗"}.get(verdict, "?")
                print(f"      {mark} {node}: {verdict}")

    print()
    print(f"  可达端口：{ok_ports or '无'}")
    print(f"  不可达端口：{bad_ports or '无'}")
    if unknown_ports:
        print(f"  无法判定：{unknown_ports}")
    print()
    if bad_ports or unknown_ports:
        print("  结论：外网尚未完全打通（宿主机转发 / 防火墙 / 云安全组三道闸任一未配都会这样）")
        return 1
    print("  结论：扫描到的端口从外网全部可达")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
