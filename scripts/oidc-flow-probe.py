#!/usr/bin/env python3
"""探针：实测 Keycloak 授权码 + PKCE 全流程（仅用于诊断，不含业务逻辑）。"""
import base64
import hashlib
import http.cookiejar
import os
import re
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("KC_BASE", "http://127.0.0.1:8082")
REALM = os.environ.get("KC_REALM", "enterprise")
CLIENT = os.environ.get("KC_CLIENT", "eap-webui")
USER = os.environ.get("KC_USER", "eap-demo")
PWD = os.environ.get("KC_PWD", "EapDemo@2026")
REDIRECT = os.environ.get("KC_REDIRECT", "http://127.0.0.1:5173/auth/callback")

jar = http.cookiejar.CookieJar()


class LoopbackSecurePolicy(http.cookiejar.DefaultCookiePolicy):
    """
    放宽 Secure cookie 在回环地址上的限制。

    Keycloak 26 固定给 AUTH_SESSION_ID / KC_RESTART 打上 `Secure; SameSite=None`
    （跨站跳转流程需要），而 Python 的 http.cookiejar 只在 https 下回传 Secure cookie。
    真实浏览器（Chrome/Firefox）把 http://127.0.0.1 与 http://localhost 视为
    「潜在可信源」，会正常回传 —— 这里对齐浏览器行为，避免探针误判。
    """

    def return_ok_secure(self, cookie, request):
        host = request.host.split(":")[0]
        if host in ("127.0.0.1", "localhost", "::1") or host.startswith("127."):
            return True
        return super().return_ok_secure(cookie, request)


jar.set_policy(LoopbackSecurePolicy())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "probe/1.0"})
    try:
        r = opener.open(req)
        return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


def post(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        url, data=body, headers={"User-Agent": "probe/1.0", "Content-Type": "application/x-www-form-urlencoded"}
    )
    try:
        r = opener.open(req)
        return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


def pkce():
    verifier = base64.urlsafe_b64encode(os.urandom(48)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


verifier, challenge = pkce()
state = base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip("=")

scope = sys.argv[1] if len(sys.argv) > 1 else "openid"

auth_url = (
    f"{BASE}/realms/{REALM}/protocol/openid-connect/auth?"
    + urllib.parse.urlencode(
        {
            "client_id": CLIENT,
            "redirect_uri": REDIRECT,
            "response_type": "code",
            "scope": scope,
            "state": state,
            "nonce": base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip("="),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
)

st, hd, body = get(auth_url)
print(f"[1] auth 端点 -> HTTP {st}  scope={scope!r}")
if st in (301, 302, 303, 307):
    loc = hd.get("Location", "")
    print(f"    Location: {loc[:200]}")
    m = re.search(r"error=([^&]+)", loc)
    if m:
        print(f"    !! OAuth 错误: {m.group(1)}")
        sys.exit(1)
    st, hd, body = get(loc)
    print(f"[2] 跟随到登录页 -> HTTP {st}, {len(body)} 字节")
elif st != 200:
    print(body[:800])
    sys.exit(1)

# 解析登录表单
form_action = re.search(r'<form[^>]*action="([^"]+)"', body)
fields = dict(re.findall(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"', body))
print(f"[3] 表单 action: {form_action.group(1) if form_action else 'NOT FOUND'}")
print(f"    隐藏字段: {sorted(fields.keys())}")

if not form_action:
    err = re.findall(r'<span[^>]*class="[^"]*kc-feedback-text[^"]*"[^>]*>([^<]*)</span>', body)
    print("    页面错误:", err)
    sys.exit(1)

action = urllib.parse.urljoin(f"{BASE}/realms/{REALM}/", form_action.group(1).replace("&amp;", "&"))
payload = dict(fields)
payload.update({"username": USER, "password": PWD, "credentialId": ""})
if "kc-form-login" not in body:
    print("    (非登录表单，可能是其它页面)")

st, hd, body = post(action, payload)
print(f"[4] 提交凭据 -> HTTP {st}")
loc = hd.get("Location", "")
if st in (301, 302, 303, 307):
    print(f"    Location: {loc[:250]}")
    if "error=" in loc:
        print(f"    !! OAuth 错误: {loc}")
        sys.exit(1)
    q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
    code = q.get("code", [None])[0]
    print(f"    code: {str(code)[:30]}...")
    if not code:
        sys.exit(1)
    # 换 token
    st, hd, tok = post(
        f"{BASE}/realms/{REALM}/protocol/openid-connect/token",
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "client_id": CLIENT,
            "code_verifier": verifier,
        },
    )
    print(f"[5] 换 token -> HTTP {st}")
    if st != 200:
        print("   ", tok[:400])
        sys.exit(1)
    import json

    t = json.loads(tok)
    print(f"    access_token len={len(t.get('access_token',''))} expires_in={t.get('expires_in')}")
    print(f"    scope 返回: {t.get('scope')}")
    claims = t.get("access_token", "")
    if claims.count(".") == 2:
        p = claims.split(".")[1]
        p += "=" * (-len(p) % 4)
        cl = json.loads(base64.urlsafe_b64decode(p))
        print("    claims:")
        for k in ("sub", "preferred_username", "name", "email", "tenant_id", "role", "dept_id", "sensitivity", "scope", "realm_access"):
            if k in cl:
                print(f"      {k} = {json.dumps(cl[k], ensure_ascii=False)}")
        print("    全部 claim keys:", sorted(cl.keys()))
else:
    errs = re.findall(r'class="[^"]*kc-feedback-text[^"]*"[^>]*>([^<]*)<', body)
    print("    页面错误提示:", errs)
    print("    片段:", re.sub(r"\s+", " ", body[:600]))
    sys.exit(1)
