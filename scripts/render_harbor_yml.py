#!/usr/bin/env python3
"""
从 Harbor 官方 harbor.yml.tmpl 生成实际使用的 harbor.yml。

只改 4 件事，其余原样保留（注释会丢，但生成物无所谓，键值一律保留）：
  1. hostname        → 对外访问地址
  2. http.port       → 宿主映射到的端口
  3. external_url    → 显式写死，避免 prepare 推导歧义
  4. https           → 默认走 HTTP-only（删除 https 段）

为什么默认 HTTP-only：
  · Docker daemon 的默认 insecure registries 含 127.0.0.0/8（docker info 实测确认），
    所以 http://127.0.0.1:8098 的推送**不需要改 daemon 配置、不需要重启 dockerd**。
  · 走 HTTPS 则要把 CA 装到 /etc/docker/certs.d/ 并改 harbor.yml 的证书路径，链路更长。
  Harbor 只绑回环、仅本机可达，风险由「不出本机」兜住；生产改回 HTTPS 见 docs/harbor.md。

用法：
  python3 render_harbor_yml.py <harbor.yml.tmpl> <输出 harbor.yml> \
      --hostname 127.0.0.1 --http-port 8098 --https-port 443
"""
from __future__ import annotations

import argparse
import re
import sys

import yaml


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--hostname", default="127.0.0.1")
    ap.add_argument("--http-port", type=int, default=8098)
    ap.add_argument("--https-port", type=int, default=443)
    ap.add_argument("--keep-https", action="store_true",
                    help="保留 https 段（需另行提供证书）")
    ap.add_argument("--data-volume", default=None,
                    help="Harbor 数据目录（宿主路径），默认沿用模板的 /data")
    a = ap.parse_args()

    with open(a.src, encoding="utf-8") as f:
        text = f.read()

    # 模板里若含 jinja 占位符，走文本替换（保留注释）
    if "{{" in text:
        text = re.sub(r"^hostname:.*$", f"hostname: {a.hostname}", text, flags=re.M)
        text = re.sub(r"^(\s*)port:.*$", rf"\g<1>port: {a.http_port}", text, count=1, flags=re.M)
        text = re.sub(r"^#\s*external_url:.*$",
                      f"external_url: http://{a.hostname}:{a.http_port}", text, flags=re.M)
        with open(a.dst, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"==> 已写出 {a.dst}（文本替换模式）")
        return 0

    doc = yaml.safe_load(text) or {}
    doc["hostname"] = a.hostname
    doc["http"] = {**(doc.get("http") or {}), "port": a.http_port}
    doc["external_url"] = f"http://{a.hostname}:{a.http_port}"
    if not a.keep_https:
        # 删掉 https 段 → prepare 走 HTTP-only 分支
        doc.pop("https", None)
    else:
        doc["https"] = {**(doc.get("https") or {}), "port": a.https_port}
    if a.data_volume:
        doc["data_volume"] = a.data_volume

    with open(a.dst, "w", encoding="utf-8") as f:
        yaml.safe_dump(doc, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    print(f"==> 已写出 {a.dst}")
    print(f"    hostname    : {doc['hostname']}")
    print(f"    external_url: {doc['external_url']}")
    print(f"    http.port   : {doc['http']['port']}")
    print(f"    https       : {'保留' if a.keep_https else '已移除（HTTP-only）'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
