#!/usr/bin/env python3
"""
Keycloak 公网暴露配置工具 —— 设置/探测 realm 的 hostname（前端与后端 URL）。

── 为什么需要这个 ─────────────────────────────────────────────────────
平台服务已全部收口到 127.0.0.1，宿主机做端口转发后，**外网浏览器**访问
控制台时需要跳转到 Keycloak 的**公网地址**（如 <公网IP>:8082），
否则浏览器会跳回用户自己电脑的 127.0.0.1，必然失败。

> 公网地址不在本仓库内写死（公开仓库不应内置目标地址）。
> 实际取值见内部参数表 `docs/internal/host-params.local.md`，
> 或用环境变量 `EAP_PUBLIC_IP` 提供。

但同时：
  - token 的 `iss`（issuer）必须与后端验签用的 issuer **逐字一致**；
  - 后端拉 JWKS 的地址必须**VM 内可达**（不能依赖宿主机转发是否已配好）。

Keycloak 的 hostname 配置正好把这两件事拆开：
  - `frontchannelDynamic=true` → 浏览器侧的跳转 URL **跟随请求的 Host 头**，
    本机测试走 127.0.0.1、外网访问走公网 IP，两种场景都自动正确；
  - `backchannelDynamic=false` → issuer / JWKS / 后端 URL **固定**，
    后端验签永远一致，且 JWKS 始终从 127.0.0.1 拉（不依赖转发）。

用法（203.0.113.10 是文档保留示例地址，执行前必须替换）：
  keycloak-hostname.py show
  keycloak-hostname.py set --frontend-url http://203.0.113.10:8082 \\
                           --backend-url  http://127.0.0.1:8082 \\
                           [--frontchannel-dynamic/--no-frontchannel-dynamic]
  keycloak-hostname.py probe --host 203.0.113.10:8082
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("KC_BASE_URL", "http://127.0.0.1:8082")
ADMIN_CLIENT = os.environ.get("KC_ADMIN_CLIENT", "admin-cli")
REALM = os.environ.get("KC_REALM", "enterprise")

# 引导管理员口令的来源与 scripts/keycloak-admin.py 保持一致：
#   进程环境 KC_ADMIN_USER / KC_ADMIN_PASSWORD
#   → deploy/compose/.env 的 KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD
# 之前这里写死一对引导管理员口令，一旦在 .env 或管理台改过，
# 本脚本就会静默 401，与另一个管理脚本对不上。
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ENV_FILE = os.path.join(REPO_ROOT, "deploy", "compose", ".env")


def _load_env_file(path: str) -> dict:
    env: dict = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip()
            if value[:1] in ("\"", "'"):
                quote = value[0]
                end = value.find(quote, 1)
                value = value[: end + 1] if end != -1 else value
            else:
                idx = value.find("#")  # 行尾注释
                value = value[:idx] if idx != -1 else value
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def admin_credentials() -> tuple[str, str]:
    file_env = _load_env_file(DEFAULT_ENV_FILE)
    user = (
        os.environ.get("KC_ADMIN_USER")
        or os.environ.get("KEYCLOAK_ADMIN")
        or file_env.get("KEYCLOAK_ADMIN")
        or ""
    )
    pwd = (
        os.environ.get("KC_ADMIN_PASSWORD")
        or os.environ.get("KEYCLOAK_ADMIN_PASSWORD")
        or file_env.get("KEYCLOAK_ADMIN_PASSWORD")
        or ""
    )
    if not user or not pwd:
        raise SystemExit(
            "错误：没有可用的 Keycloak 管理凭据。请在 deploy/compose/.env 里设置 "
            "KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD，或用环境变量 "
            "KC_ADMIN_USER / KC_ADMIN_PASSWORD 覆盖。"
        )
    return user, pwd


def _request(method: str, path: str, token: str, body=None, query=None):
    url = f"{BASE}/admin/realms/{REALM}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def get_token() -> str:
    admin_user, admin_pwd = admin_credentials()
    body = urllib.parse.urlencode(
        {"grant_type": "password", "client_id": ADMIN_CLIENT,
         "username": admin_user, "password": admin_pwd}
    ).encode()
    req = urllib.request.Request(f"{BASE}/realms/master/protocol/openid-connect/token", data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["access_token"]


def get_realm(token: str) -> dict:
    st, data = _request("GET", "", token)
    if st != 200:
        raise SystemExit(f"读取 realm 失败：HTTP {st} {data}")
    return data


def put_realm(token: str, realm: dict) -> None:
    st, data = _request("PUT", "", token, realm)
    if st not in (200, 204):
        raise SystemExit(f"写入 realm 失败：HTTP {st} {data}")


def current_hostname(realm: dict) -> dict:
    raw = (realm.get("attributes") or {}).get("hostname")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}


def cmd_show(_args) -> int:
    token = get_token()
    realm = get_realm(token)
    print("── realm hostname 属性 ──")
    print(json.dumps(current_hostname(realm), ensure_ascii=False, indent=2))
    print("\n── 实际对外暴露的 OIDC 元数据 ──")
    with urllib.request.urlopen(f"{BASE}/realms/{REALM}/.well-known/openid-configuration", timeout=30) as resp:
        meta = json.loads(resp.read())
    for k in ("issuer", "authorization_endpoint", "token_endpoint", "end_session_endpoint", "jwks_uri"):
        print(f"  {k}: {meta.get(k)}")
    return 0


def cmd_set(args) -> int:
    token = get_token()
    realm = get_realm(token)
    attrs = dict(realm.get("attributes") or {})
    host = current_hostname(realm)

    host["full"] = args.full or host.get("full") or BASE
    if args.frontend_url:
        host["frontendUrl"] = args.frontend_url
    if args.backend_url:
        host["backendUrl"] = args.backend_url
    if args.frontchannel_dynamic is not None:
        host["frontchannelDynamic"] = args.frontchannel_dynamic
    if args.backchannel_dynamic is not None:
        host["backchannelDynamic"] = args.backchannel_dynamic

    attrs["hostname"] = json.dumps(host, ensure_ascii=False)
    realm["attributes"] = attrs
    put_realm(token, realm)
    print("已写入 realm attributes.hostname：")
    print(json.dumps(host, ensure_ascii=False, indent=2))
    return 0


def cmd_probe(args) -> int:
    """用指定 Host 头打授权端点，看 Keycloak 生成的 redirect_uri 是否跟随。"""
    q = urllib.parse.urlencode({
        "client_id": args.client_id,
        "redirect_uri": args.redirect_uri,
        "response_type": "code",
        "scope": "openid",
        "state": "probe",
    })
    url = f"{BASE}/realms/{REALM}/protocol/openid-connect/auth?{q}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Host", args.host)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            final = resp.geturl()
            print(f"  Host={args.host}")
            print(f"  最终跳转: {final}")
            parsed = urllib.parse.parse_qs(urllib.parse.urlparse(final).query)
            print(f"  redirect_uri: {parsed.get('redirect_uri', ['<无>'])[0]}")
    except urllib.error.HTTPError as e:
        print(f"  Host={args.host} → HTTP {e.code}")
        loc = e.headers.get("Location", "")
        if loc:
            print(f"  Location: {loc}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Keycloak 公网 hostname 配置工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("show", help="显示当前配置与 OIDC 元数据").set_defaults(func=cmd_show)

    s = sub.add_parser("set", help="设置 hostname 属性")
    s.add_argument("--full", help="基础地址（issuer 的回退来源）")
    s.add_argument("--frontend-url", help="浏览器侧固定地址（配合 frontchannelDynamic=false 使用）")
    s.add_argument("--backend-url", help="后端侧固定地址（issuer / JWKS）")
    s.add_argument("--frontchannel-dynamic", dest="frontchannel_dynamic",
                   action="store_true", default=None, help="前端 URL 跟随请求 Host")
    s.add_argument("--no-frontchannel-dynamic", dest="frontchannel_dynamic",
                   action="store_false", help="前端 URL 使用固定 frontendUrl")
    s.add_argument("--backchannel-dynamic", dest="backchannel_dynamic",
                   action="store_true", default=None, help="后端 URL 跟随请求 Host")
    s.add_argument("--no-backchannel-dynamic", dest="backchannel_dynamic",
                   action="store_false", help="后端 URL 使用固定 backendUrl")
    s.set_defaults(func=cmd_set)

    s = sub.add_parser("probe", help="用指定 Host 头探测授权端点")
    s.add_argument("--host", required=True)
    s.add_argument("--client-id", default="eap-webui")
    s.add_argument("--redirect-uri", default="http://127.0.0.1:5173/auth/callback")
    s.set_defaults(func=cmd_probe)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
