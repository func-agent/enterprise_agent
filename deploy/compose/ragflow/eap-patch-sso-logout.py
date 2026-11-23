#!/usr/bin/env python3
"""RAGFlow 登出补丁：让「RAGFlow 登出」一并结束 Keycloak 的单点登录会话。

背景
----
RAGFlow 0.22 的登出只清它自己的会话（api/apps/user_app.py 的 log_out）：
把 user.access_token 置成 INVALID_xxx 后 logout_user()，前端再跳 /login。
而 nginx 把 /login 拦到 Keycloak 授权（见 eap-entrypoint.sh 的 render_sso_nginx），
Keycloak 里的 SSO 会话此时还活着 → 直接发 code 回来 → 用户表现为
「刚在 RAGFlow 登出，几秒后又被自动登进去了」。

平台控制台（5173）的做法是 RP-initiated logout：登出时带 id_token_hint 调
Keycloak 的 end_session，把单点登录会话一并结束（apps/webui/src/oidc.ts 的
endOidcSession）。本补丁把同样的能力补到 RAGFlow 侧。

补丁做三件事：
  ① 固定 LocalProxy 背后的同一个 ORM 用户对象再保存 `INVALID_...` token，
     避免上游分次解析导致旧 token 实际没有失效；
  ② OAuth 回调成功时，把 Keycloak 的 id_token 存进 HttpOnly Cookie
     `eap_kc_id_token` —— 供 nginx 在登出时作 id_token_hint；
  ③ 登出时按登录渠道写一次性标记 Cookie `eap_sso_logout=keycloak|password`
     —— 供 nginx 区分企业 SSO、本地账号与首次访问：
        企业 SSO 要结束 Keycloak 会话，本地账号只结束 RAGFlow 会话。

为什么优先带 id_token_hint
--------------------------
Keycloak 26.0.8 的 end_session 只给 client_id + post_logout_redirect_uri 时，
返回「Do you want to log out?」确认页，需要用户确认后才结束会话；带上有效的
id_token_hint 才会 302 直接跳回并终止会话。缺少 id_token 时不能提前展示成功页。
id_token 过期不影响：end_session 只用 verifyDecode 取 sid，不校验 exp（已实测）。

两个 Cookie 都是 HttpOnly + SameSite=Lax：
  · HttpOnly —— 页面 JS 读不到，id_token 不会泄到前端；
  · SameSite=Lax —— 浏览器顶层跳转到 /login 时会带上，且不阻断跨站跳转；
  · Secure —— 对外 RAGFlow 地址为 HTTPS 时自动启用，HTTP 演示环境保持可用。

幂等与失效保护
--------------
已打过补丁的文件里会出现特征串 `eap_kc_id_token`，重复执行直接跳过。
任何锚点文本对不上（上游版本变了）立即退出 1，不允许「补丁没生效但服务照常启动」。
写入前用 compile() 校验语法，避免把服务改到起不来。
"""

import os
import sys

TARGET = "/ragflow/api/apps/user_app.py"
MARK = "eap_kc_id_token"

# ── 锚点 1：新用户注册分支的登录重定向（16 空格缩进）─────────────────
OLD_REGISTER = '''                login_user(user)
                return redirect(f"/?auth={user.get_id()}")
'''

NEW_REGISTER = '''                login_user(user)
                # —— EAP 补丁：把 Keycloak id_token 存进 HttpOnly Cookie ——
                # 供 nginx 在登出时作 end_session 的 id_token_hint，
                # 从而把单点登录会话一并结束（否则登出后会被 SSO 秒登回来）。
                _eap_resp = redirect(f"/?auth={user.get_id()}")
                _eap_set_id_token_cookie(_eap_resp, id_token)
                return _eap_resp
'''

# ── 锚点 2：已有用户登录分支的重定向（8 空格缩进）──────────────────────
OLD_EXISTING = '''        login_user(user)
        user.save()
        return redirect(f"/?auth={user.get_id()}")
'''

NEW_EXISTING = '''        login_user(user)
        user.save()
        # —— EAP 补丁：把 Keycloak id_token 存进 HttpOnly Cookie ——
        _eap_resp = redirect(f"/?auth={user.get_id()}")
        _eap_set_id_token_cookie(_eap_resp, id_token)
        return _eap_resp
'''

# ── 锚点 3：登出端点 ──────────────────────────────────────────────────
OLD_LOGOUT = '''    current_user.access_token = f"INVALID_{secrets.token_hex(16)}"
    current_user.save()
    logout_user()
    return get_json_result(data=True)
'''

NEW_LOGOUT = '''    # current_user 是 LocalProxy，分次解析会得到不同 ORM 对象；先固定对象再修改并保存。
    _eap_user = current_user._get_current_object()
    _eap_login_channel = getattr(_eap_user, "login_channel", "") or "password"
    _eap_user.access_token = f"INVALID_{secrets.token_hex(16)}"
    _eap_user.save()
    logout_user()
    # —— EAP 补丁：写「刚登出」一次性标记，区分企业 SSO 与本地账号 ——
    _eap_resp = get_json_result(data=True)
    _eap_resp.set_cookie(
        "eap_sso_logout",
        "keycloak" if _eap_login_channel == "keycloak" else "password",
        max_age=120,
        path="/",
        samesite="Lax",
        httponly=True,
        secure=_eap_cookie_secure(),
    )
    return _eap_resp
'''

# ── 追加到文件末尾的辅助函数 ──────────────────────────────────────────
HELPER = '''

# ─── EAP 补丁（SSO 登出）────────────────────────────────────────────────
# 追加在文件末尾：模块级名字在调用时才解析，位置前后都能用。
def _eap_cookie_secure():
    return os.environ.get("EAP_PUBLIC_RAGFLOW_ORIGIN", "").lower().startswith("https://")


def _eap_set_id_token_cookie(resp, id_token):
    """把 Keycloak 的 id_token 存进 HttpOnly Cookie，供 end_session 使用。"""
    if not id_token:
        return resp
    resp.set_cookie(
        "eap_kc_id_token",
        id_token,
        max_age=43200,
        path="/",
        samesite="Lax",
        httponly=True,
        secure=_eap_cookie_secure(),
    )
    return resp
'''


def fail(message: str) -> None:
    print(f"[eap-patch] 错误：{message}", file=sys.stderr)
    sys.exit(1)


def replace_once(src: str, old: str, new: str, label: str) -> str:
    count = src.count(old)
    if count != 1:
        fail(f"锚点「{label}」命中 {count} 次（应为 1 次），上游结构可能已变更，拒绝静默启动")
    return src.replace(old, new, 1)


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else TARGET
    if not os.path.isfile(target):
        fail(f"目标文件 {target} 不存在")

    with open(target, encoding="utf-8") as fp:
        src = fp.read()

    if MARK in src:
        print(f"[eap-patch] SSO 登出补丁已生效（{MARK}），跳过")
        return 0

    src = replace_once(src, OLD_REGISTER, NEW_REGISTER, "新用户登录重定向")
    src = replace_once(src, OLD_EXISTING, NEW_EXISTING, "已有用户登录重定向")
    src = replace_once(src, OLD_LOGOUT, NEW_LOGOUT, "登出端点")

    if not src.endswith("\n"):
        src += "\n"
    src += HELPER

    try:
        compile(src, target, "exec")
    except SyntaxError as exc:
        fail(f"补丁后语法校验失败：{exc}")

    tmp = target + ".eap.tmp"
    with open(tmp, "w", encoding="utf-8") as fp:
        fp.write(src)
    os.replace(tmp, target)

    print(f"[eap-patch] 已为 RAGFlow 打上 SSO 登出补丁（{target}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
