#!/usr/bin/env python3
"""
Keycloak realm 管理工具 —— 宿主侧直连 Admin REST API。

为什么需要它：
  Keycloak 26 的 `--import-realm` **文件导入路径不会种下内置 client scope**
  （basic / email / profile / roles / web-origins / acr / ... ），
  而管理 API 创建 realm 时才会。结果是导入出来的 realm 里：
    - 客户端 defaultClientScopes 被静默裁剪成只剩自定义 scope
    - access_token 缺 sub / preferred_username / realm_access
  所以本工具负责「导入后补齐内置 scope 并重新挂载到客户端」。

用法：
  keycloak-admin.py token                     # 打印管理令牌
  keycloak-admin.py ensure-admin              # 幂等创建永久管理员并清理临时引导管理员
  keycloak-admin.py ensure-user-admin <realm> # 配置网关用户管理面最小权限（view/manage-users）
  keycloak-admin.py scopes <realm>            # 列出 realm 的 client scope
  keycloak-admin.py client-scopes <realm>     # 导出 realm 的 client scope 定义
  keycloak-admin.py restore-builtin <realm> <scope.json>
  keycloak-admin.py assign <realm> <clientId> <scopeName> [--default|--optional]
  keycloak-admin.py export <realm> <out.json>
  keycloak-admin.py apply-client <realm> <clientId> [realm.json]
                                               # 把 realm 文件里的客户端建/改到运行中的 realm
  keycloak-admin.py rotate-secret <realm> <clientId>
                                               # 生成新客户端密钥并打印，需自行同步到组件配置

  用户管理（enterprise realm 的业务账号）：
  keycloak-admin.py users <realm>            # 列出用户与平台属性
  keycloak-admin.py set-attrs <realm> <username> <key=value>... [--clear <key>]
                                               # 改平台属性（role/tenant_id/dept_id/sensitivity）
  keycloak-admin.py reset-password <realm> <username> [新口令]
                                               # 重置口令；不给口令就生成随机并打印
  keycloak-admin.py create-user <realm> <username> [--email E] [--password P] [--attr k=v ...]
  keycloak-admin.py enable-user|disable-user|delete-user <realm> <username>
  keycloak-admin.py sync-users <realm> [username] [realm.json]
                                               # 把 realm 文件里的用户定义应用到运行中的 realm
"""
from __future__ import annotations

import json
import os
import re
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("KC_BASE_URL", "http://127.0.0.1:8082")
ADMIN_CLIENT = os.environ.get("KC_ADMIN_CLIENT", "admin-cli")
REALM = os.environ.get("KC_REALM", "enterprise")

# 仓库根目录（脚本位于 <repo>/scripts/）
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_REALM_FILE = os.path.join(REPO_ROOT, "deploy", "compose", "keycloak", "realm-eap.json")
DEFAULT_ENV_FILE = os.path.join(REPO_ROOT, "deploy", "compose", ".env")

# 内置 client scope 全集（Keycloak 26 BuiltInClientScope 枚举）
BUILTIN_SCOPES = [
    "acr",
    "address",
    "basic",
    "email",
    "microprofile-jwt",
    "offline_access",
    "organization",
    "phone",
    "profile",
    "role_list",
    "roles",
    "saml_organization",
    "web-origins",
]

# realm 级默认挂载集合（对齐 Keycloak 新建 realm 的默认行为）
REALM_DEFAULT_SCOPES = [
    "acr",
    "basic",
    "email",
    "microprofile-jwt",
    "profile",
    "roles",
    "web-origins",
]
REALM_OPTIONAL_SCOPES = [
    "address",
    "offline_access",
    "organization",
    "phone",
    "saml_organization",
]


class KcError(RuntimeError):
    pass


def _request(method: str, path: str, token: str, body=None, query=None) -> tuple[int, object, dict]:
    url = f"{BASE}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl.create_default_context() if url.startswith("https") else None
    try:
        with urllib.request.urlopen(req, context=ctx) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if raw and "json" in ctype:
                return resp.status, json.loads(raw), dict(resp.headers)
            return resp.status, raw.decode("utf-8", "replace"), dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw
        raise KcError(f"{method} {path} -> HTTP {e.code}: {parsed}") from None


def get_token(credentials: tuple[str, str] | None = None) -> str:
    admin_user, admin_pwd = credentials or admin_credentials()
    payload = urllib.parse.urlencode(
        {
            "grant_type": "password",
            "client_id": ADMIN_CLIENT,
            "username": admin_user,
            "password": admin_pwd,
            "scope": "openid",
        }
    ).encode()
    req = urllib.request.Request(
        f"{BASE}/realms/master/protocol/openid-connect/token",
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise KcError(
            f"取管理令牌失败（HTTP {e.code}）：{detail}\n"
            "      引导管理员口令只在首次启动（数据卷为空）时创建；"
            "若之后在管理台改过口令，请同步 deploy/compose/.env 的 "
            "KEYCLOAK_ADMIN_PASSWORD，或用 KC_ADMIN_PASSWORD 覆盖；"
            "首次启动时由 ensure-admin 使用临时引导账号创建永久管理员。"
        ) from None
    except (urllib.error.URLError, OSError) as e:
        raise KcError(
            f"连不上 Keycloak（{BASE}）：{e}\n"
            "      容器可能正在启动或未运行；先确认：docker ps | grep keycloak"
        ) from None
    token = body.get("access_token")
    if not token:
        raise KcError(f"取管理令牌失败: {body}")
    return token


def realm_client_scopes(token: str, realm: str) -> list[dict]:
    status, data, _ = _request("GET", f"/admin/realms/{realm}/client-scopes", token)
    return data if isinstance(data, list) else []


def client_by_id(token: str, realm: str, client_id: str) -> str:
    status, data, _ = _request(
        "GET", f"/admin/realms/{realm}/clients", token, query={"clientId": client_id}
    )
    if not data:
        raise KcError(f"客户端不存在: {client_id}")
    return data[0]["id"]


def create_client_scope(token: str, realm: str, scope: dict) -> None:
    body = {
        "name": scope["name"],
        "description": scope.get("description") or scope["name"],
        "protocol": scope.get("protocol") or "openid-connect",
        "attributes": scope.get("attributes") or {},
        "protocolMappers": scope.get("protocolMappers") or [],
    }
    _request("POST", f"/admin/realms/{realm}/client-scopes", token, body)


def assign_scope(token: str, realm: str, client_uuid: str, scope_uuid: str, default: bool) -> None:
    kind = "default-client-scopes" if default else "optional-client-scopes"
    try:
        _request("POST", f"/admin/realms/{realm}/clients/{client_uuid}/{kind}", token, {})
    except KcError:
        pass
    try:
        _request(
            "PUT",
            f"/admin/realms/{realm}/clients/{client_uuid}/{kind}/{scope_uuid}",
            token,
        )
    except KcError as e:
        raise KcError(f"挂载 scope 失败: {e}") from None


# ── 用户管理 ─────────────────────────────────────────────────────────

# 平台上下文属性：与 realm-eap.json 里 eap-context scope 的 protocol mapper
# 一一对应。属性写错名字不会报错，只会让令牌里缺这个 claim，
# 网关侧就会降级取默认值（如 role 缺失 → employee），所以这里强校验。
PLATFORM_ATTRS = ("role", "tenant_id", "dept_id", "sensitivity")
VALID_ROLES = ("employee", "manager", "admin", "platform-admin")
VALID_SENSITIVITY = ("public", "internal", "confidential")

# 令牌里的 claim 来自用户属性，改完属性不会改写已签发的令牌。
TOKEN_CLAIM_TTL_HINT = (
    "已签发的 access token 仍带旧 claim（最长 30 分钟）；"
    "刷新令牌或重新登录后生效。"
)


def user_by_username(token: str, realm: str, username: str) -> dict | None:
    """取用户的完整表示。

    注意：**列表接口** `/users?username=` 才返回 attributes，
    **单条接口** `/users/{id}` 不返回（实测 Keycloak 26）。
    所以这里以列表接口为准，别用单条接口取属性。
    """
    _, found, _ = _request(
        "GET", f"/admin/realms/{realm}/users", token, query={"username": username, "exact": "true"}
    )
    if isinstance(found, list) and found:
        return found[0]
    return None


def realm_file_users(realm_file: str) -> dict:
    """读 realm 文件里的用户定义（用户名 → 定义）。"""
    with open(realm_file, encoding="utf-8") as fh:
        doc = json.load(fh)
    return {u.get("username"): u for u in doc.get("users", []) if u.get("username")}


def user_body_from_spec(
    spec: dict,
    *,
    attrs: dict | None = None,
    password: str | None = None,
    enabled: bool | None = None,
    email: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
) -> dict:
    """构造**完整**的用户表示。

    为什么必须是完整的（实测踩坑记录）：
    1. Keycloak 的 `PUT /admin/realms/{realm}/users/{id}` 是**全量替换** ——
       body 里没带的字段会被清空。早期只传 `{"attributes": ...}` 的写法
       把 email 和**凭据**一起抹了，用户直接登不上。
    2. User Profile 把 `email` / `firstName` / `lastName` 设为**必填**，
       缺任意一项，Keycloak 判定「Account is not fully set up」直接拒绝登录。
    3. 凭据读不回来（GET 不回显哈希），所以一旦漏传 credentials 就等于清口令。

    因此所有用户更新都从 realm 文件的完整定义出发，只改指定字段。
    """
    attrs_src = {k: list(v) for k, v in (spec.get("attributes") or {}).items()}
    if attrs is not None:
        attrs_src.update({k: list(v) for k, v in attrs.items()})
    creds = spec.get("credentials") or []
    pwd = password if password is not None else (creds[0].get("value") if creds else None)
    body = {
        "username": spec["username"],
        "email": email if email is not None else spec.get("email"),
        "firstName": first_name if first_name is not None else spec.get("firstName"),
        "lastName": last_name if last_name is not None else spec.get("lastName"),
        "enabled": enabled if enabled is not None else bool(spec.get("enabled", True)),
        "emailVerified": bool(spec.get("emailVerified", True)),
        "attributes": attrs_src,
    }
    if pwd:
        body["credentials"] = [{"type": "password", "value": pwd, "temporary": False}]
    missing = [k for k in ("email", "firstName", "lastName") if not body.get(k)]
    if missing:
        raise KcError(
            f"用户 {spec['username']} 缺少 {', '.join(missing)}："
            "User Profile 把它们设为必填，缺了会被判「Account is not fully set up」，"
            "该账号将无法登录。"
        )
    return body


def user_body_from_live(
    user: dict,
    *,
    attrs: dict | None = None,
    enabled: bool | None = None,
    replace_attrs: bool = False,
) -> dict:
    """从**运行中**的用户表示构造完整的 PUT body。

    实测结论（Keycloak 26）：
    - `PUT /admin/realms/{realm}/users/{id}` 是**全量替换**：body 里没带的字段
      会被清空。`email` / `firstName` / `lastName` 被清空后，User Profile 的
      必填校验会让这个账号**直接登不上**（"Account is not fully set up"）——
      这是实测踩过的坑，也是本函数存在的理由。
    - **credentials 不在 body 里也不会被清**（实测：只改 enabled 后凭据仍在），
      所以改属性 / 启停账号都不需要知道口令，也就不依赖 realm 文件。

    `replace_attrs=True` 时 `attrs` 被当作**最终属性全集**直接写入；
    默认是**并集**语义（live 属性 + 新属性）。
    ⚠️ 必须区分这两种语义：并集语义会让「删除某个属性」变成假操作 ——
    被删掉的键因为还在 live 属性里，又被并回来，等于没删（实测踩过）。
    """
    body = {
        "username": user.get("username"),
        "email": user.get("email"),
        "firstName": user.get("firstName"),
        "lastName": user.get("lastName"),
        "enabled": enabled if enabled is not None else bool(user.get("enabled", True)),
        "emailVerified": bool(user.get("emailVerified", True)),
        "attributes": {k: list(v) for k, v in (user.get("attributes") or {}).items()},
    }
    if attrs is not None:
        if replace_attrs:
            body["attributes"] = {k: list(v) for k, v in attrs.items()}
        else:
            body["attributes"].update({k: list(v) for k, v in attrs.items()})
    missing = [k for k in ("email", "firstName", "lastName") if not body.get(k)]
    if missing:
        raise KcError(
            f"用户 {user.get('username')} 缺少 {', '.join(missing)}："
            "User Profile 把它们设为必填，缺了该账号会登不上。"
            "请先在管理控制台补齐，或把它写进 realm 文件后用 sync-users 同步。"
        )
    return body


def ensure_profile_policy(token: str, realm: str) -> bool:
    """确保 realm 的 User Profile 允许「未申报属性」，否则平台属性写不进去。

    Keycloak 24+ 的声明式 User Profile 默认 `unmanagedAttributePolicy=DISABLED`，
    未申报的属性在**任何写入**时都会被静默丢弃（不报错、看不出失败）。
    平台的 role / tenant_id / dept_id / sensitivity 正属于未申报属性
    （User Profile 只声明了 username / email / firstName / lastName），
    所以必须打开 ENABLED，否则「改完属性看着没生效」。

    为什么不在 realm 文件里写死：Keycloak 26 的 REST 建 realm 路径带
    `components` 段会直接 500（实测三种写法都试过），不可靠。
    这里改成运行时自愈 —— 重建 realm 后跑一次命令就自动恢复。
    """
    _, profile, _ = _request("GET", f"/admin/realms/{realm}/users/profile", token)
    if not isinstance(profile, dict):
        return False
    if profile.get("unmanagedAttributePolicy") == "ENABLED":
        return False
    profile["unmanagedAttributePolicy"] = "ENABLED"
    _request("PUT", f"/admin/realms/{realm}/users/profile", token, profile)
    print("  · 已把 realm 的 unmanagedAttributePolicy 打开为 ENABLED（否则平台属性会被丢弃）")
    return True


def ensure_user_admin_access(token: str, realm: str) -> None:
    """给网关管理面服务账号授予最小用户管理权限，并确保自定义属性可写。"""
    ensure_profile_policy(token, realm)
    gateway_uuid = client_by_id(token, realm, "eap-gateway")
    _, service_user, _ = _request(
        "GET", f"/admin/realms/{realm}/clients/{gateway_uuid}/service-account-user", token
    )
    realm_management_uuid = client_by_id(token, realm, "realm-management")
    wanted = []
    for name in ("view-users", "manage-users"):
        _, role, _ = _request(
            "GET", f"/admin/realms/{realm}/clients/{realm_management_uuid}/roles/{name}", token
        )
        wanted.append(role)
    _, existing, _ = _request(
        "GET",
        f"/admin/realms/{realm}/users/{service_user['id']}/role-mappings/clients/{realm_management_uuid}",
        token,
    )
    existing_names = {role.get("name") for role in existing}
    missing = [role for role in wanted if role.get("name") not in existing_names]
    if missing:
        _request(
            "POST",
            f"/admin/realms/{realm}/users/{service_user['id']}/role-mappings/clients/{realm_management_uuid}",
            token,
            missing,
        )
    print("网关用户管理服务账号已就绪：eap-gateway / view-users + manage-users")


def put_user(token: str, realm: str, uid: str, body: dict) -> None:
    """全量写回用户，并回读校验关键字段真的落库了。

    校验是**双向**的：
    - 正向：body 里带的属性必须与回读一致；
    - 反向：body 里**没带**的平台属性必须真的消失 ——
      只做正向校验会漏掉「删除属性其实是假删除」这类失败
      （实测踩过：`--clear` 打印成功但属性还在）。
    """
    _request("PUT", f"/admin/realms/{realm}/users/{uid}", token, body)
    _, check, _ = _request(
        "GET", f"/admin/realms/{realm}/users", token, query={"username": body["username"], "exact": "true"}
    )
    if isinstance(check, list) and check:
        u = check[0]
        if u.get("email") != body.get("email"):
            raise KcError(f"写入后 email 不一致（期望 {body.get('email')}，实际 {u.get('email')}）")
        got = {k: list(v) for k, v in (u.get("attributes") or {}).items()}
        want = {k: list(v) for k, v in (body.get("attributes") or {}).items()}
        for key, value in want.items():
            if got.get(key) != list(value):
                raise KcError(
                    f"写入后属性 {key} 不一致（期望 {value}，实际 {got.get(key)}）"
                    "——多半是 realm 的 unmanagedAttributePolicy 不是 ENABLED，"
                    "未申报属性会被 Keycloak 直接丢弃。"
                )
        # 反向校验只针对平台属性：Keycloak 自己的托管属性不在工具管辖范围内，
        # 一并要求消失会误报。
        for key in PLATFORM_ATTRS:
            if key in got and key not in want:
                raise KcError(
                    f"写入后属性 {key} 仍存在（本次要求删除）——删除没有生效，"
                    "请检查写入 body 是否带了旧属性。"
                )


def parse_attrs(pairs: list[str]) -> dict:
    """解析 k=v 形式的属性对；值统一存成单元素列表（与 realm 文件一致）。"""
    attrs: dict = {}
    for item in pairs:
        if "=" not in item:
            raise KcError(f"属性要写成 key=value：{item}")
        key, _, value = item.partition("=")
        key = key.strip()
        value = value.strip()
        if key not in PLATFORM_ATTRS:
            raise KcError(
                f"未知属性 {key}；平台只认 {', '.join(PLATFORM_ATTRS)}"
                "（它们对应 eap-context scope 的 claim 映射，写错名字不会报错，"
                "只会让令牌缺 claim 并被降级）"
            )
        if key == "role" and value not in VALID_ROLES:
            raise KcError(f"role 只支持 {', '.join(VALID_ROLES)}，收到 {value}")
        if key == "sensitivity" and value not in VALID_SENSITIVITY:
            raise KcError(f"sensitivity 只支持 {', '.join(VALID_SENSITIVITY)}，收到 {value}")
        attrs[key] = [value]
    return attrs


def reset_user_password(token: str, realm: str, uid: str, password: str) -> None:
    """用专用端点改口令：只动凭据，不碰 email / 属性 / 启用状态。"""
    _request(
        "PUT",
        f"/admin/realms/{realm}/users/{uid}/reset-password",
        token,
        {"type": "password", "value": password, "temporary": False},
    )


def create_user(token: str, realm: str, username: str, body: dict) -> str:
    """新建用户。body 必须是完整表示（见 user_body_from_spec 的说明）。"""
    _, created, _ = _request("POST", f"/admin/realms/{realm}/users", token, body)
    uid = created.get("id") if isinstance(created, dict) else None
    if not uid:
        # Keycloak 的创建接口返回 201 + 空 body，id 要回查
        found = user_by_username(token, realm, username)
        if not found:
            raise KcError(f"用户创建后回查失败: {username}")
        uid = found["id"]
    return uid


# 客户端表示里允许从 realm 文件直接搬运的字段
CLIENT_FIELDS = (
    "clientId",
    "name",
    "enabled",
    "publicClient",
    "secret",
    "protocol",
    "standardFlowEnabled",
    "implicitFlowEnabled",
    "directAccessGrantsEnabled",
    "serviceAccountsEnabled",
    "redirectUris",
    "webOrigins",
    "attributes",
)


def _strip_inline_comment(value: str) -> str:
    """去掉未加引号的值后面的行尾注释。

    env 文件没有统一的行尾注释规范，但 .env 是人工维护的，写成
    `KEY=value # 说明` 很常见。若不处理，注释会被当成值的一部分，
    口令类变量会因此变成「口令 + 注释」，认证必然失败且极难排查。
    加了引号的内容里的 # 视为值的一部分，不做处理。
    """
    if not value:
        return value
    if value[0] in "\"'":
        quote = value[0]
        end = value.find(quote, 1)
        if end != -1:
            return value[: end + 1]
        return value  # 引号未闭合，整体当值
    idx = value.find("#")
    if idx != -1:
        value = value[:idx]
    return value.strip()


def load_env_file(path: str) -> dict:
    """读取 KEY=VALUE 形式的 env 文件（忽略整行注释、空行与行尾注释）。"""
    env: dict = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = _strip_inline_comment(value.strip())
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def admin_credentials() -> tuple[str, str]:
    """master realm 永久管理员凭据；KC_ADMIN_* 可显式覆盖。

    口径（与 deploy/compose/docker-compose.yml 的 keycloak 服务一致）：
        进程环境 KC_ADMIN_USER / KC_ADMIN_PASSWORD
      → 进程环境 KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD
      → deploy/compose/.env 里的同名键

    注意：这里管的是 **master realm 的系统管理员**，与
    scripts/ragflow-sso.py 用的 enterprise 演示管理员
    （RAGFLOW_SSO_ADMIN_USER / RAGFLOW_SSO_ADMIN_PWD）是两套凭据，
    不要混用同一个环境变量名。
    """
    file_env = load_env_file(DEFAULT_ENV_FILE)
    user = (
        os.environ.get("KC_ADMIN_USER")
        or os.environ.get("KEYCLOAK_ADMIN")
        or file_env.get("KEYCLOAK_ADMIN")
        or ""
    )
    password = (
        os.environ.get("KC_ADMIN_PASSWORD")
        or os.environ.get("KEYCLOAK_ADMIN_PASSWORD")
        or file_env.get("KEYCLOAK_ADMIN_PASSWORD")
        or ""
    )
    if not user or not password:
        raise KcError(
            "没有可用的 Keycloak 管理凭据。请在 deploy/compose/.env 里设置 "
            "KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD，"
            "或用环境变量 KC_ADMIN_USER / KC_ADMIN_PASSWORD 覆盖。"
        )
    if password.startswith("CHANGE_ME"):
        raise KcError(
            "deploy/compose/.env 的 KEYCLOAK_ADMIN_PASSWORD 还是占位值，"
            "请先改成真实口令。首次启动时它会同时用于临时引导账号和永久管理员。"
        )
    return user, password


def bootstrap_username() -> str:
    file_env = load_env_file(DEFAULT_ENV_FILE)
    return (
        os.environ.get("KC_BOOTSTRAP_ADMIN_USER")
        or os.environ.get("KEYCLOAK_BOOTSTRAP_ADMIN")
        or file_env.get("KEYCLOAK_BOOTSTRAP_ADMIN")
        or "eap-bootstrap"
    )


def require_master_admin(token: str, username: str) -> dict:
    user = user_by_username(token, "master", username)
    if not user:
        raise KcError(f"管理员 {username} 能认证但用户查询失败，请检查其 admin 角色")
    _, roles, _ = _request("GET", f"/admin/realms/master/users/{user['id']}/role-mappings/realm", token)
    if not any(role.get("name") == "admin" for role in roles):
        raise KcError(f"用户 {username} 缺少 master realm 的 admin 角色")
    return user


def ensure_login_appearance(token: str) -> None:
    theme_root = os.path.join(REPO_ROOT, "deploy", "compose", "keycloak", "themes", "eap")
    required_files = [
        os.path.join(theme_root, "login", "theme.properties"),
        os.path.join(theme_root, "admin", "theme.properties"),
    ]
    if not all(os.path.isfile(path) for path in required_files):
        return

    expected_by_realm = {
        "master": {
            "loginTheme": "eap",
            "adminTheme": "eap",
            "displayNameHtml": "管理员 keycloak 登录",
        },
        "enterprise": {
            # 主题也一并兜住：realm-eap.json 只在建 realm 时生效，
            # 已有环境被改过 loginTheme 后不会自动重导，这里保证拉回 eap
            "loginTheme": "eap",
            "displayNameHtml": "企业级 AI Agent 平台 用户 Keycloak 登录",
        },
    }
    changed = []
    for realm_name, expected in expected_by_realm.items():
        path = f"/admin/realms/{realm_name}"
        _, realm, _ = _request("GET", path, token)
        if all(realm.get(field) == value for field, value in expected.items()):
            continue
        realm.update(expected)
        _request("PUT", path, token, realm)
        changed.append(realm_name)
    if changed:
        print(f"登录页主题与品牌文案已同步：{', '.join(changed)}")


def ensure_permanent_admin() -> None:
    admin_user, admin_pwd = admin_credentials()
    bootstrap_user = bootstrap_username()
    if admin_user == bootstrap_user:
        raise KcError(
            "KEYCLOAK_ADMIN 与 KEYCLOAK_BOOTSTRAP_ADMIN 不能同名；"
            "请保留永久管理员 kc-admin，并为临时引导账号使用独立名称。"
        )

    try:
        admin_token = get_token((admin_user, admin_pwd))
    except KcError:
        admin_token = ""
    if admin_token:
        require_master_admin(admin_token, admin_user)
        bootstrap = user_by_username(admin_token, "master", bootstrap_user)
        if bootstrap:
            _request("DELETE", f"/admin/realms/master/users/{bootstrap['id']}", admin_token)
            print(f"已清理临时引导管理员 {bootstrap_user}")
        ensure_login_appearance(admin_token)
        ensure_user_admin_access(admin_token, REALM)
        print(f"永久管理员 {admin_user} 已就绪")
        return

    bootstrap_token = get_token((bootstrap_user, admin_pwd))
    try:
        bootstrap = user_by_username(bootstrap_token, "master", bootstrap_user)
    except KcError as e:
        hint = (
            "\n      HTTP 403 通常表示引导账号缺少 master realm 的 admin 角色；"
            "Keycloak 自建的引导账号自带该角色，手工创建的账号需自行授予。"
            if "HTTP 403" in str(e)
            else ""
        )
        raise KcError(f"查询临时引导管理员 {bootstrap_user} 失败：{e}{hint}") from None
    if not bootstrap:
        raise KcError(f"临时引导管理员 {bootstrap_user} 不存在，无法初始化永久管理员")
    try:
        existing_admin = user_by_username(bootstrap_token, "master", admin_user)
    except KcError as e:
        hint = (
            "\n      HTTP 403 通常表示引导账号缺少 master realm 的 admin 角色。"
            if "HTTP 403" in str(e)
            else ""
        )
        raise KcError(f"用引导账号 {bootstrap_user} 查询用户 {admin_user} 失败：{e}{hint}") from None
    if existing_admin:
        raise KcError(
            f"用户 {admin_user} 已存在但当前口令认证失败；为避免覆盖已有账号，未自动修改。"
            "请核对 KEYCLOAK_ADMIN_PASSWORD。"
        )

    uid = create_user(
        bootstrap_token,
        "master",
        admin_user,
        {
            "username": admin_user,
            "enabled": True,
            "credentials": [{"type": "password", "value": admin_pwd, "temporary": False}],
        },
    )
    _, admin_role, _ = _request("GET", "/admin/realms/master/roles/admin", bootstrap_token)
    _request("POST", f"/admin/realms/master/users/{uid}/role-mappings/realm", bootstrap_token, [admin_role])

    admin_token = get_token((admin_user, admin_pwd))
    require_master_admin(admin_token, admin_user)
    _request("DELETE", f"/admin/realms/master/users/{bootstrap['id']}", admin_token)
    ensure_login_appearance(admin_token)
    ensure_user_admin_access(admin_token, REALM)
    print(f"已创建永久管理员 {admin_user} 并授予 admin 角色")
    print(f"已验证新账号可认证，并删除临时引导管理员 {bootstrap_user}")


def subst_placeholders(node, env: dict, path: str = ""):
    """递归替换字符串里的 ${VAR}；解析不到直接报错。

    Keycloak 在变量缺失时会把占位符**原样**写进 redirect URI 且不告警，
    与 --import-realm 的行为一致，所以这里宁可失败也不让占位符落库。
    """
    if isinstance(node, dict):
        return {k: subst_placeholders(v, env, f"{path}.{k}") for k, v in node.items()}
    if isinstance(node, list):
        return [subst_placeholders(v, env, f"{path}[{i}]") for i, v in enumerate(node)]
    if isinstance(node, str):

        def repl(match):
            name = match.group(1)
            if name not in env:
                raise KcError(f"{path}: 占位符 ${{{name}}} 无法解析（.env 与进程环境都没有）")
            return env[name]

        return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", repl, node)
    return node


def rotate_client_secret(token: str, realm: str, client_id: str) -> str:
    uuid = client_by_id(token, realm, client_id)
    _, credential, _ = _request(
        "POST", f"/admin/realms/{realm}/clients/{uuid}/client-secret", token
    )
    secret = credential.get("value") if isinstance(credential, dict) else None
    if not isinstance(secret, str) or not secret:
        raise KcError("Keycloak 未返回新客户端密钥")
    return secret


def apply_client(token: str, realm: str, spec: dict) -> None:
    """把 realm 文件里的客户端定义建 / 改到运行中的 realm。

    为什么不用 --import-realm 重导：文件导入会**丢弃 client 的 attributes**
    （两条导入路径都是），且会连带覆盖已在线上跑通的其它客户端配置。
    管理 API 是增量的，只动指定的那个客户端。
    """
    body = {k: spec[k] for k in CLIENT_FIELDS if k in spec}
    # scope 稍后按名字挂载：管理 API 的 defaultClientScopes 收的是 scope id
    body.pop("defaultClientScopes", None)

    _, found, _ = _request(
        "GET", f"/admin/realms/{realm}/clients", token, query={"clientId": spec["clientId"]}
    )
    existing = found if isinstance(found, list) else []

    if existing:
        uuid = existing[0]["id"]
        expected_secret = spec.get("secret")
        if expected_secret:
            _, credential, _ = _request(
                "GET", f"/admin/realms/{realm}/clients/{uuid}/client-secret", token
            )
            current_secret = credential.get("value") if isinstance(credential, dict) else None
            if current_secret != expected_secret:
                raise KcError(
                    f"客户端 {spec['clientId']} 的密钥与 deploy/compose/.env（或进程环境）里的"
                    f" RAGFLOW_OAUTH_CLIENT_SECRET 不一致，未更新客户端。"
                    f"需要轮换时执行: keycloak-admin.py rotate-secret {realm} {spec['clientId']}，"
                    "再把生成的新密钥同步到组件配置。"
                )
        body.pop("secret", None)  # 已有客户端只能通过 client-secret 接口轮换
        _request("PUT", f"/admin/realms/{realm}/clients/{uuid}", token, body)
        secret_status = "，密钥已核对" if expected_secret else ""
        print(f"  ~ {spec['clientId']}（已存在，属性已更新{secret_status}）")
    else:
        _request("POST", f"/admin/realms/{realm}/clients", token, body)
        uuid = client_by_id(token, realm, spec["clientId"])
        print(f"  + {spec['clientId']}（新建）")

    scopes = {s["name"]: s["id"] for s in realm_client_scopes(token, realm)}
    for name in spec.get("defaultClientScopes") or []:
        if name not in scopes:
            raise KcError(f"scope 不存在: {name}（先执行 restore-builtin）")
        assign_scope(token, realm, uuid, scopes[name], True)
    print(f"    默认 scope: {', '.join(spec.get('defaultClientScopes') or []) or '（无）'}")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    cmd = argv[0]

    # 帮助要放在取令牌之前：--help 不该依赖管理凭据是否可用
    if cmd in ("-h", "--help", "help"):
        print(__doc__)
        return 0

    if cmd == "token":
        print(get_token())
        return 0

    if cmd == "ensure-admin":
        ensure_permanent_admin()
        return 0

    token = get_token()

    if cmd == "ensure-user-admin":
        realm = argv[1] if len(argv) > 1 else REALM
        ensure_user_admin_access(token, realm)
        return 0

    if cmd == "scopes":
        realm = argv[1] if len(argv) > 1 else REALM
        for s in realm_client_scopes(token, realm):
            print(f"{s['name']:22s} id={s['id']} mappers={len(s.get('protocolMappers') or [])}")
        return 0

    if cmd == "client-scopes":
        realm = argv[1] if len(argv) > 1 else REALM
        out = {}
        for s in realm_client_scopes(token, realm):
            _, full, _ = _request("GET", f"/admin/realms/{realm}/client-scopes/{s['id']}", token)
            out[s["name"]] = {
                "name": full.get("name"),
                "description": full.get("description"),
                "protocol": full.get("protocol"),
                "attributes": full.get("attributes") or {},
                "protocolMappers": full.get("protocolMappers") or [],
            }
        json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
        return 0

    if cmd == "restore-builtin":
        realm = argv[1] if len(argv) > 1 else REALM
        path = argv[2]
        with open(path, encoding="utf-8") as fh:
            definitions = json.load(fh)
        existing = {s["name"]: s for s in realm_client_scopes(token, realm)}
        created = []
        for name, scope in definitions.items():
            if name in existing:
                print(f"  = {name}（已存在，跳过）")
                continue
            create_client_scope(token, realm, scope)
            created.append(name)
            print(f"  + {name}（新建，{len(scope.get('protocolMappers') or [])} 个映射器）")
        print(f"新建 {len(created)} 个 client scope")
        return 0

    if cmd == "assign":
        realm, client_id, scope_name = argv[1], argv[2], argv[3]
        default = "--optional" not in argv
        scopes = {s["name"]: s["id"] for s in realm_client_scopes(token, realm)}
        if scope_name not in scopes:
            raise KcError(f"scope 不存在: {scope_name}")
        uuid = client_by_id(token, realm, client_id)
        assign_scope(token, realm, uuid, scopes[scope_name], default)
        print(f"{client_id} + {scope_name} ({'default' if default else 'optional'})")
        return 0

    if cmd == "users":
        realm = argv[1] if len(argv) > 1 else REALM
        _, data, _ = _request("GET", f"/admin/realms/{realm}/users", token)
        for u in data:
            attrs = {k: v for k, v in (u.get("attributes") or {}).items()}
            print(
                f"{u.get('username'):24s} enabled={u.get('enabled')} "
                f"email={u.get('email') or '-'} attrs={attrs}"
            )
        return 0

    if cmd == "set-attrs":
        realm = argv[1] if len(argv) > 1 else REALM
        username = argv[2] if len(argv) > 2 else ""
        if not username:
            raise KcError("用法: set-attrs <realm> <username> <key=value>... [--clear <key>]")
        rest = argv[3:]
        clear: list[str] = []
        if "--clear" in rest:
            idx = rest.index("--clear")
            if idx + 1 >= len(rest):
                raise KcError("--clear 后面要跟属性名")
            clear = [rest[idx + 1]]
            rest = rest[:idx] + rest[idx + 2 :]
            for key in clear:
                if key not in PLATFORM_ATTRS:
                    raise KcError(
                        f"未知属性 {key}；平台只认 {', '.join(PLATFORM_ATTRS)}"
                    )
        attrs = parse_attrs(rest)
        if not attrs and not clear:
            raise KcError("没有要改的属性")
        user = user_by_username(token, realm, username)
        if not user:
            raise KcError(f"用户不存在: {username}")
        # 从运行中的表示出发改属性：带齐 email/firstName/lastName（User Profile 必填，
        # 缺了会把账号改成登不上），凭据不用带（实测不会被清）。
        ensure_profile_policy(token, realm)
        merged = {k: list(v) for k, v in (user.get("attributes") or {}).items()}
        merged.update(attrs)
        for key in clear:
            if key not in merged:
                raise KcError(f"属性 {key} 本来就没有，无需删除")
            merged.pop(key, None)
        # replace_attrs=True：merged 已经是**最终属性全集**（含被删掉的键的移除结果），
        # 必须整体覆盖，不能用并集语义 —— 并集会把刚删掉的属性又并回来。
        body = user_body_from_live(user, attrs=merged, replace_attrs=True)
        put_user(token, realm, user["id"], body)
        print(f"{username} 属性已更新：{merged}")
        print(f"  提醒：{TOKEN_CLAIM_TTL_HINT}")
        return 0

    if cmd == "reset-password":
        realm = argv[1] if len(argv) > 1 else REALM
        username = argv[2] if len(argv) > 2 else ""
        if not username:
            raise KcError("用法: reset-password <realm> <username> [新口令]")
        user = user_by_username(token, realm, username)
        if not user:
            raise KcError(f"用户不存在: {username}")
        password = argv[3] if len(argv) > 3 else None
        generated = password is None
        if generated:
            password = secrets.token_urlsafe(18)
        # 用专用的 reset-password 端点：它只改凭据，不动 email / 属性 / 启用状态
        reset_user_password(token, realm, user["id"], password)
        print(f"{username} 口令已重置")
        if generated:
            print(f"  新口令（只显示这一次）：{password}")
        print("  提醒：改口令后旧令牌仍在有效期内，需等其过期或让用户重新登录。")
        return 0

    if cmd == "create-user":
        realm = argv[1] if len(argv) > 1 else REALM
        username = argv[2] if len(argv) > 2 else ""
        if not username:
            raise KcError("用法: create-user <realm> <username> [--email E] [--password P] [--attr k=v ...]")
        rest = argv[3:]

        def take_opt(flag: str) -> str | None:
            nonlocal rest
            if flag in rest:
                idx = rest.index(flag)
                if idx + 1 >= len(rest):
                    raise KcError(f"{flag} 后面要跟值")
                value = rest[idx + 1]
                rest = rest[:idx] + rest[idx + 2 :]
                return value
            return None

        email = take_opt("--email")
        password = take_opt("--password")
        first_name = take_opt("--first-name")
        last_name = take_opt("--last-name")
        attr_pairs: list[str] = []
        while "--attr" in rest:
            idx = rest.index("--attr")
            if idx + 1 >= len(rest):
                raise KcError("--attr 后面要跟 key=value")
            attr_pairs.append(rest[idx + 1])
            rest = rest[:idx] + rest[idx + 2 :]
        if rest:
            raise KcError(f"无法识别的参数: {' '.join(rest)}")
        attrs = parse_attrs(attr_pairs)
        if user_by_username(token, realm, username):
            raise KcError(f"用户已存在: {username}（改属性请用 set-attrs）")
        generated = password is None
        if generated:
            password = secrets.token_urlsafe(18)
        # User Profile 把 email / firstName / lastName 设为必填，缺了就登不上
        spec = {
            "username": username,
            "email": email or f"{username}@example.com",
            "firstName": first_name or username,
            "lastName": last_name or username,
            "enabled": True,
            "emailVerified": True,
        }
        ensure_profile_policy(token, realm)
        body = user_body_from_spec(spec, attrs=attrs, password=password)
        uid = create_user(token, realm, username, body)
        print(f"已创建 {username}（id={uid}）属性={attrs or '（无）'}")
        if generated:
            print(f"  新口令（只显示这一次）：{password}")
        print(
            "  提醒：新建的账号不在 realm-eap.json 里，"
            "重建 realm 会丢失它；要长期保留请把它写回 realm 文件。"
        )
        return 0

    if cmd in ("enable-user", "disable-user"):
        realm = argv[1] if len(argv) > 1 else REALM
        username = argv[2] if len(argv) > 2 else ""
        if not username:
            raise KcError(f"用法: {cmd} <realm> <username>")
        user = user_by_username(token, realm, username)
        if not user:
            raise KcError(f"用户不存在: {username}")
        enabled = cmd == "enable-user"
        body = user_body_from_live(user, enabled=enabled)
        put_user(token, realm, user["id"], body)
        print(f"{username} enabled={enabled}")
        return 0

    if cmd == "delete-user":
        realm = argv[1] if len(argv) > 1 else REALM
        username = argv[2] if len(argv) > 2 else ""
        if not username:
            raise KcError("用法: delete-user <realm> <username>")
        user = user_by_username(token, realm, username)
        if not user:
            raise KcError(f"用户不存在: {username}")
        _request("DELETE", f"/admin/realms/{realm}/users/{user['id']}", token)
        print(f"已删除 {username}")
        print("  提醒：删除的是运行中的 realm；realm-eap.json 里的定义仍在，重建 realm 会复活它。")
        return 0

    if cmd == "sync-users":
        # 把 realm 文件里的用户定义增量应用到运行中的 realm
        # （与 apply-client 同构：文件是事实来源，已有 realm 不会自动跟着变）
        realm = argv[1] if len(argv) > 1 else REALM
        only = argv[2] if len(argv) > 2 else ""
        realm_file = argv[3] if len(argv) > 3 else DEFAULT_REALM_FILE
        specs = realm_file_users(realm_file)
        if not specs:
            raise KcError(f"{realm_file} 里没有用户定义")
        targets = {only: specs[only]} if only else specs
        for username, spec in targets.items():
            if username not in specs:
                raise KcError(f"realm 文件里没有用户: {username}")
            # 服务账号由 Keycloak 自己管理，没有 email/姓名，也不走口令登录，
            # 用户档案的必填校验对它不适用 —— 跳过，别去动它。
            if username.startswith("service-account-"):
                print(f"  · {username}：服务账号，跳过")
                continue
            attrs = {k: list(v) for k, v in (spec.get("attributes") or {}).items()}
            for key in attrs:
                if key not in PLATFORM_ATTRS:
                    print(f"  警告：{username} 的属性 {key} 不在平台属性集合内，已按原样写入")
            ensure_profile_policy(token, realm)
            body = user_body_from_spec(spec, attrs=attrs)
            user = user_by_username(token, realm, username)
            if user:
                put_user(token, realm, user["id"], body)
                print(f"  ~ {username}：档案/属性/凭据已按文件同步")
            else:
                uid = create_user(token, realm, username, body)
                print(f"  + {username}：已按文件创建（id={uid}）")
        print(f"提醒：{TOKEN_CLAIM_TTL_HINT}")
        return 0

    if cmd == "rotate-secret":
        realm = argv[1] if len(argv) > 1 else REALM
        client_id = argv[2] if len(argv) > 2 else ""
        if not client_id:
            raise KcError("用法: rotate-secret <realm> <clientId>")
        secret = rotate_client_secret(token, realm, client_id)
        print(f"客户端 {client_id} 的新密钥（只显示这一次）：")
        print(f"  {secret}")
        print("")
        print("下一步（旧密钥此刻已失效，SSO 在同步完成前不可用）：")
        print("  1. 把上面的值写入 deploy/compose/.env 的 RAGFLOW_OAUTH_CLIENT_SECRET")
        print("  2. 重建用到该密钥的容器（env 变更需要 recreate，restart 不够）：")
        print("     ./scripts/start-heavy.sh start ragflow keycloak")
        print("  3. 复核：python3 scripts/ragflow-sso.py verify")
        return 0

    if cmd == "apply-client":
        realm = argv[1] if len(argv) > 1 else REALM
        client_id = argv[2] if len(argv) > 2 else ""
        realm_file = argv[3] if len(argv) > 3 else DEFAULT_REALM_FILE
        if not client_id:
            raise KcError("用法: apply-client <realm> <clientId> [realm.json]")
        with open(realm_file, encoding="utf-8") as fh:
            realm_doc = json.load(fh)
        specs = {c.get("clientId"): c for c in realm_doc.get("clients", [])}
        if client_id not in specs:
            raise KcError(f"realm 文件里没有客户端: {client_id}")
        # 进程环境优先于 .env 文件（与 start-heavy.sh 的取值口径一致）
        env = load_env_file(DEFAULT_ENV_FILE)
        env.update(os.environ)
        spec = subst_placeholders(specs[client_id], env, client_id)
        apply_client(token, realm, spec)
        return 0

    if cmd == "export":
        realm, path = argv[1], argv[2]
        _, data, _ = _request("GET", f"/admin/realms/{realm}", token)
        # realm 表示本身**不含** clients / clientScopes / roles / users，
        # 只导出会得到一个看着完整、实则丢掉全部客户端与密钥的文件。
        # 这里把各子集合单独取回再拼回去，让导出结果能当备份用。
        extra = {
            "clients": "/clients",
            "clientScopes": "/client-scopes",
            "roles": "/roles",
            "groups": "/groups",
            "users": "/users?briefRepresentation=true",
        }
        counts = {}
        for key, suffix in extra.items():
            try:
                _, sub, _ = _request("GET", f"/admin/realms/{realm}{suffix}", token)
            except KcError as e:
                print(f"  警告：读取 {key} 失败，已跳过（{e}）", file=sys.stderr)
                continue
            if isinstance(sub, list):
                counts[key] = len(sub)
                if isinstance(data, dict):
                    data[key] = sub
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        print(f"已导出 {path}")
        print(
            "  包含："
            + "、".join(f"{k}={v}" for k, v in counts.items())
            + "（用户口令不可导出，Keycloak 也不提供反解）"
        )
        return 0

    print(__doc__)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KcError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        sys.exit(1)
