#!/usr/bin/env python3
"""RAGFlow ↔ Keycloak 账号打通 —— SSO 流程驱动、渠道核对与管理员提权。

背景
----
RAGFlow 0.22 自带第三方登录渠道：common/settings.py 的
``OAUTH_CONFIG = get_base_config("oauth", {})``，来源是
conf/service_conf.yaml 的 oauth 段（本项目由
deploy/compose/ragflow/eap-entrypoint.sh 渲染到 conf/local.service_conf.yaml）。

本项目把 Keycloak 作为 RAGFlow 的身份源：

    浏览器 → RAGFlow 登录页的 "Keycloak" 按钮
           → Keycloak 授权（realm enterprise，客户端 eap-ragflow）
           → 回调 /v1/user/oauth/callback/keycloak
           → RAGFlow 用 userinfo 的 email 自动建号并登录

于是终端用户不必在 RAGFlow 侧单独记口令，账号口径以 Keycloak 为准；
RAGFlow 侧的行 data 保留本地账号作为应急入口。

本脚本做五件事
    channels  核对登录渠道是否已生效
    login     模拟浏览器走完整个 SSO 流程，输出 RAGFlow 侧的用户信息
    token     只输出 RAGFlow Authorization 令牌，供其他 API 脚本使用
    promote   把指定账号提为 RAGFlow 管理员
    verify    上面几件事的组合验收（幂等，缺管理员会自动补提权）

关于 promote
------------
RAGFlow 没有「提权」API（用户创建接口一律 is_superuser=False），
只能改库的 user.is_superuser —— 这与 RAGFlow 自身 api/db/init_data.py
建内置 root 账号的做法一致。改完立刻用 /v1/user/info 复核，不靠"应该生效"。

用法
    python3 scripts/ragflow-sso.py channels
    python3 scripts/ragflow-sso.py login --user eap-demo
    python3 scripts/ragflow-sso.py token --user eap-demo
    python3 scripts/ragflow-sso.py promote eap-admin@example.com
    python3 scripts/ragflow-sso.py verify
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(REPO_ROOT, "deploy", "compose", ".env")
MYSQL_CONTAINER = os.environ.get("RAGFLOW_MYSQL_CONTAINER", "eapheavy-mysql")
MYSQL_DB = os.environ.get("RAGFLOW_MYSQL_DB", "rag_flow")
CHANNEL = os.environ.get("RAGFLOW_SSO_CHANNEL", "keycloak")

# 演示账号（realm-eap.json 里的明文开发口令，与 docs/access.md 一致）
DEFAULT_USER = os.environ.get("KC_USER", "eap-demo")
DEFAULT_PWD = os.environ.get("KC_PWD", "EapDemo@2026")

# 管理员（enterprise realm 的演示管理员，不是 Keycloak 的 master 引导管理员）
#
# 这里**刻意不用** KC_ADMIN_USER / KC_ADMIN_PWD：
#   · scripts/keycloak-admin.py 里的 KC_ADMIN_USER / KC_ADMIN_PASSWORD 指的是
#     **master realm 的系统管理员 kc-admin**；
#   · 同一个环境变量名在两个脚本里指向不同 realm 的账号，误设会直接认证失败。
# 因此本脚本用 RAGFLOW_SSO_ADMIN_USER / RAGFLOW_SSO_ADMIN_PWD；
# 旧变量名仍可覆盖，但会打印弃用提示。
ADMIN_USER = os.environ.get("RAGFLOW_SSO_ADMIN_USER", "")
ADMIN_PWD = os.environ.get("RAGFLOW_SSO_ADMIN_PWD", "")
if not ADMIN_USER or not ADMIN_PWD:
    _legacy_user = os.environ.get("KC_ADMIN_USER", "")
    _legacy_pwd = os.environ.get("KC_ADMIN_PWD", "")
    if _legacy_user and _legacy_pwd:
        ADMIN_USER = ADMIN_USER or _legacy_user
        ADMIN_PWD = ADMIN_PWD or _legacy_pwd
        print(
            "警告：KC_ADMIN_USER / KC_ADMIN_PWD 已弃用（与 keycloak-admin.py 的 master "
            "realm 管理员同名易混），请改用 RAGFLOW_SSO_ADMIN_USER / RAGFLOW_SSO_ADMIN_PWD。",
            file=sys.stderr,
        )
ADMIN_USER = ADMIN_USER or "eap-admin"
ADMIN_PWD = ADMIN_PWD or "EapAdmin@2026"


class SsoError(RuntimeError):
    pass


# ── 基础工具 ──────────────────────────────────────────────────────────


def load_env_file(path: str) -> dict:
    """读取 KEY=VALUE 形式的 env 文件。

    支持行尾注释（`KEY=value # 说明`）——.env 是人工维护的，
    不处理的话注释会被当成值的一部分，口令类变量必然认证失败。
    加了引号的内容里的 # 视为值的一部分。
    """
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
                idx = value.find("#")
                value = value[:idx] if idx != -1 else value
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def ragflow_base() -> str:
    """RAGFlow 的对外地址。

    必须与 RAGFlow 容器里配置的 redirect_uri 同源 —— Keycloak 要求授权请求
    与换 token 用的 redirect_uri 完全一致，不一致直接 invalid_redirect_uri。
    因此这里优先取 deploy/compose/.env 的 EAP_PUBLIC_RAGFLOW_ORIGIN
    （eap-entrypoint.sh 渲染 oauth 配置时用的就是同一个变量）。
    """
    env = load_env_file(ENV_FILE)
    base = (
        os.environ.get("RAGFLOW_BASE_URL")
        or env.get("EAP_PUBLIC_RAGFLOW_ORIGIN")
        or "http://127.0.0.1:8095"
    )
    return base.rstrip("/")


def docker_cmd() -> list:
    if subprocess.run(["docker", "info"], capture_output=True).returncode == 0:
        return ["docker"]
    return ["sudo", "docker"]


class RelaxedSecurePolicy(http.cookiejar.DefaultCookiePolicy):
    """允许把 Secure cookie 也发回明文 http 站点。

    Keycloak 26 在**明文 HTTP** 下同样会给认证 cookie 打上
    `Secure; SameSite=None`（实测 Set-Cookie：
    `AUTH_SESSION_ID=...;Version=1;Path=/realms/...;Secure;HttpOnly;SameSite=None`）。
    Python 的 cookiejar 默认策略是「cookie 带 Secure 而请求不是 https 就不发」，
    于是登录表单提交时会缺 cookie，表现为 400 + 日志 `error="cookie_not_found"`。
    真实浏览器不受影响（Chrome / Firefox 把 http://127.0.0.1 视为潜在可信源），
    这里放宽到明文 http 也照发，与浏览器行为对齐。
    """

    def return_ok_secure(self, cookie, request):
        if request.type != "https":
            return True
        return super().return_ok_secure(cookie, request)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_opener() -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    jar.set_policy(RelaxedSecurePolicy())
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar), NoRedirect()
    )


def request(opener, method: str, url: str, data: dict | None = None, headers: dict | None = None):
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    hdrs = {"User-Agent": "ragflow-sso-check/1.0"}
    if body is not None:
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        resp = opener.open(req, timeout=20)
        return resp.status, resp.headers, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        raise SsoError(f"请求失败 {url}: {e.reason}") from None


# ── 渠道与登录 ────────────────────────────────────────────────────────


def list_channels(base: str) -> list:
    st, _, body = request(build_opener(), "GET", f"{base}/v1/user/login/channels")
    if st != 200:
        raise SsoError(f"/v1/user/login/channels 返回 {st}：{body[:200]}")
    payload = json.loads(body)
    return payload.get("data") or []


def sso_auth_token(base: str, user: str, pwd: str) -> str:
    """走完 Keycloak SSO，返回 RAGFlow 侧的 Authorization 令牌。

    RAGFlow 的 API 鉴权不走会话 Cookie，而是 Authorization 头里的签名令牌
    （api/apps/__init__.py 的 _load_user 用 itsdangerous 解 Authorization）；
    回调把令牌放在 ?auth= 里，前端原样存下来再放进请求头。
    """
    opener = build_opener()

    # 1) 渠道入口 → 302 到 Keycloak 授权页（同时种下 RAGFlow 的 state 会话 cookie）
    st, hd, body = request(opener, "GET", f"{base}/v1/user/login/{CHANNEL}")
    if st not in (301, 302, 303, 307):
        raise SsoError(f"/v1/user/login/{CHANNEL} 返回 {st}（期望 302）：{body[:200]}")
    auth_url = hd.get("Location") or ""
    if not auth_url:
        raise SsoError("渠道入口没有返回 Location")

    # 2) Keycloak 登录页
    st, _, body = request(opener, "GET", auth_url)
    if st != 200:
        raise SsoError(f"Keycloak 授权页返回 {st}")
    m = re.search(r'<form[^>]*action="([^"]+)"', body)
    if not m:
        raise SsoError("Keycloak 登录页里没找到表单，登录页结构可能变了")
    fields = dict(re.findall(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"', body))
    payload = dict(fields)
    payload.update({"username": user, "password": pwd, "credentialId": ""})
    action = urllib.parse.urljoin(auth_url, m.group(1).replace("&amp;", "&"))

    # 3) 提交凭据 → 302 回 RAGFlow 回调（带 code 与 state）
    st, hd, body = request(opener, "POST", action, payload)
    if st not in (301, 302, 303, 307):
        errs = re.findall(r'class="[^"]*kc-feedback-text[^"]*"[^>]*>([^<]*)<', body)
        raise SsoError(f"提交 Keycloak 凭据返回 {st}：{errs or body[:200]}")
    loc = hd.get("Location") or ""
    if "error=" in loc:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
        raise SsoError(f"Keycloak 返回错误：{q.get('error', ['?'])[0]} {q.get('error_description', [''])[0]}")

    # 4) RAGFlow 回调 → 建号/登录 → 302 到 /?auth=<签名令牌>
    if f"/v1/user/oauth/callback/{CHANNEL}" not in loc:
        raise SsoError(f"回调地址不是 RAGFlow 渠道回调：{loc}")
    st, hd, body = request(opener, "GET", loc)
    if st not in (301, 302, 303, 307):
        raise SsoError(f"RAGFlow 回调返回 {st}：{body[:200]}")
    final = hd.get("Location") or ""
    if "error=" in final:
        raise SsoError(f"RAGFlow 回调报错：{urllib.parse.unquote(final)}")

    # RAGFlow 的 API 鉴权不走会话 Cookie，而是 Authorization 头里的签名令牌
    # （api/apps/__init__.py 的 _load_user 用 itsdangerous 解 Authorization）；
    # 回调把令牌放在 ?auth= 里，前端原样存下来再放进请求头。
    q = urllib.parse.parse_qs(urllib.parse.urlparse(final).query)
    token = (q.get("auth") or [""])[0]
    if not token:
        raise SsoError(f"回调没有带回 auth 令牌：{final}")
    return token


def sso_login(base: str, user: str, pwd: str) -> dict:
    """模拟浏览器走完 SSO，返回 RAGFlow 侧的用户信息。"""
    token = sso_auth_token(base, user, pwd)
    opener = build_opener()

    # 5) 取 RAGFlow 侧的用户信息
    st, _, body = request(
        opener, "GET", f"{base}/v1/user/info", headers={"Authorization": token}
    )
    if st != 200:
        raise SsoError(f"/v1/user/info 返回 {st}：{body[:200]}")
    data = json.loads(body)
    if data.get("code") != 0:
        raise SsoError(f"/v1/user/info 返回异常：{data}")
    return data.get("data") or {}


# ── 提权 ──────────────────────────────────────────────────────────────


def mysql_query(sql: str) -> str:
    cmd = docker_cmd() + [
        "exec",
        MYSQL_CONTAINER,
        "sh",
        "-c",
        f"mysql -uroot -p\"$MYSQL_ROOT_PASSWORD\" -N -e {shlex.quote(sql)} {shlex.quote(MYSQL_DB)}",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SsoError(f"MySQL 执行失败：{proc.stderr.strip()[:300]}")
    return proc.stdout.strip()


def promote(email: str) -> bool:
    """把账号提为 RAGFlow 管理员；返回是否发生了实际变更。"""
    before = mysql_query(f"SELECT is_superuser FROM user WHERE email={sql_str(email)}")
    if not before:
        raise SsoError(f"RAGFlow 里没有这个账号：{email}（先跑一次 login 让它自动建号）")
    mysql_query(f"UPDATE user SET is_superuser = 1 WHERE email={sql_str(email)}")
    after = mysql_query(f"SELECT is_superuser FROM user WHERE email={sql_str(email)}")
    return before != after


# 允许出现在 SQL 字符串字面量里的值：邮箱形态。
# 只做转义不如直接拒绝非法字符 —— MySQL 的反斜杠转义还会被
# NO_BACKSLASH_ESCAPES 模式改变语义，转义是否生效取决于服务端配置。
SAFE_LITERAL = re.compile(r"^[A-Za-z0-9._%+\-@]{1,254}$")


def sql_str(value: str) -> str:
    """把值拼进 SQL 字符串字面量。

    这里只接受邮箱形态的字符集；出现引号、反斜杠、空白、控制字符等
    一律拒绝 —— 值来自 SSO 的 userinfo，属于外部输入，不能拼进 SQL。
    """
    if not value or not SAFE_LITERAL.match(value):
        raise SsoError(f"拒绝把非法值拼进 SQL：{value[:64]!r}")
    return f"'{value}'"


def user_row(email: str) -> dict:
    raw = mysql_query(
        "SELECT id,email,nickname,login_channel,is_superuser,status FROM user "
        f"WHERE email={sql_str(email)}"
    )
    if not raw:
        return {}
    parts = raw.split("\t")
    keys = ["id", "email", "nickname", "login_channel", "is_superuser", "status"]
    return dict(zip(keys, parts))


# ── 子命令 ────────────────────────────────────────────────────────────


def cmd_channels(args) -> int:
    base = ragflow_base()
    channels = list_channels(base)
    print(f"RAGFlow: {base}")
    if not channels:
        print("  （没有登录渠道 —— SSO 未启用）")
        return 1
    for c in channels:
        print(f"  - {c.get('channel'):12s} 显示名={c.get('display_name')} 图标={c.get('icon')}")
    if CHANNEL not in [c.get("channel") for c in channels]:
        print(f"  !! 期望的渠道 {CHANNEL} 不在其中", file=sys.stderr)
        return 1
    return 0


def cmd_login(args) -> int:
    base = ragflow_base()
    info = sso_login(base, args.user, args.password)
    print(f"RAGFlow: {base}")
    print(f"  email       : {info.get('email')}")
    print(f"  nickname    : {info.get('nickname')}")
    print(f"  is_superuser: {info.get('is_superuser')}")
    print(f"  login_id    : {info.get('login_id') or info.get('id')}")
    row = user_row(info.get("email", ""))
    if row:
        print(f"  DB 行       : login_channel={row.get('login_channel')} "
              f"is_superuser={row.get('is_superuser')} status={row.get('status')}")
    return 0


def cmd_promote(args) -> int:
    changed = promote(args.email)
    row = user_row(args.email)
    print(f"账号 {args.email} → is_superuser={row.get('is_superuser')} "
          f"login_channel={row.get('login_channel')}"
          f"{'（本次已变更）' if changed else '（本来就是管理员）'}")
    return 0 if row.get("is_superuser") == "1" else 1


def cmd_verify(args) -> int:
    base = ragflow_base()
    ok = True

    print("[1/3] 登录渠道")
    channels = list_channels(base)
    names = [c.get("channel") for c in channels]
    print(f"  渠道：{names}")
    if CHANNEL not in names:
        print(f"  !! 缺少 {CHANNEL} 渠道", file=sys.stderr)
        ok = False

    print("[2/3] SSO 登录（自动建号）")
    info = sso_login(base, args.user, args.password)
    print(f"  {args.user} → email={info.get('email')} nickname={info.get('nickname')}")
    row = user_row(info.get("email", ""))
    if row.get("login_channel") != CHANNEL:
        print(f"  !! 期望 login_channel={CHANNEL}，实际 {row.get('login_channel')}", file=sys.stderr)
        ok = False

    print("[3/3] 管理员映射")
    admin_info = sso_login(base, args.admin_user, args.admin_password)
    admin_email = admin_info.get("email", "")
    admin_row = user_row(admin_email)
    print(f"  {args.admin_user} → email={admin_email} is_superuser={admin_row.get('is_superuser')}")
    if admin_row.get("is_superuser") != "1":
        changed = promote(admin_email)
        admin_row = user_row(admin_email)
        print(f"  已提权（{'本次变更' if changed else '无需变更'}）→ is_superuser={admin_row.get('is_superuser')}")
    if admin_row.get("is_superuser") != "1":
        print("  !! 提权失败", file=sys.stderr)
        ok = False

    print("验收通过" if ok else "验收未通过")
    return 0 if ok else 1


def cmd_token(args) -> int:
    """只打印 RAGFlow 的 Authorization 令牌 —— 供脚本化调用其他 API 用。"""
    base = ragflow_base()
    token = sso_auth_token(base, args.user, args.password)
    # 只输出令牌本身，方便 $(...) 捕获
    print(token)
    return 0


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="RAGFlow ↔ Keycloak 账号打通工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("channels", help="核对 RAGFlow 的登录渠道")

    p_login = sub.add_parser("login", help="模拟浏览器走完 SSO 流程")
    p_login.add_argument("--user", default=DEFAULT_USER, help="Keycloak 用户名")
    p_login.add_argument("--password", default=DEFAULT_PWD, help="Keycloak 口令")

    p_token = sub.add_parser("token", help="只打印 RAGFlow 的 Authorization 令牌（脚本用）")
    p_token.add_argument("--user", default=DEFAULT_USER, help="Keycloak 用户名")
    p_token.add_argument("--password", default=DEFAULT_PWD, help="Keycloak 口令")

    p_promote = sub.add_parser("promote", help="把账号提为 RAGFlow 管理员")
    p_promote.add_argument("email", help="RAGFlow 侧的 email")

    p_verify = sub.add_parser("verify", help="组合验收（幂等，缺管理员会自动补提权）")
    p_verify.add_argument("--user", default=DEFAULT_USER, help="用于验收的普通用户")
    p_verify.add_argument("--password", default=DEFAULT_PWD, help="普通用户的 Keycloak 口令")
    p_verify.add_argument("--admin-user", default=ADMIN_USER, help="要提升为 RAGFlow 管理员的 Keycloak 用户")
    p_verify.add_argument("--admin-password", default=ADMIN_PWD, help="管理员的 Keycloak 口令")

    args = parser.parse_args(argv)
    handlers = {
        "channels": cmd_channels,
        "login": cmd_login,
        "token": cmd_token,
        "promote": cmd_promote,
        "verify": cmd_verify,
    }
    try:
        return handlers[args.cmd](args)
    except SsoError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
