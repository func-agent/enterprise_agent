#!/usr/bin/env python3
"""从健康 realm 抽取 Keycloak 内置 client scope 的完整定义（含协议映射器）。

用途：文件导入 realm 时 Keycloak 不会种下内置 client scope，导致
      access_token 缺 sub / preferred_username / realm_access，
      授权码流程虽能跑通但身份不完整。此脚本把这些内置 scope 抽出来，
      供 realm-eap.json 合并使用。

用法：
  python3 scripts/extract-keycloak-builtin-scopes.py [realm] > scopes.json

⚠️ kcadm.sh 的三个实测坑（Keycloak 26）：
  1. `kcadm.sh` **不在容器的 PATH 里**，绝对路径是 /opt/keycloak/bin/kcadm.sh；
  2. **认证 realm** 用 `--realm`（master），**目标 realm** 用
     `--target-realm`（或 `-r`）—— 两者不是一回事。
     只写 `-r <realm>` 不写 `--realm` 会报
     "No realm or token specified"（kcadm 不知道拿哪个 realm 去认证）；
  3. 容器里**没有**预置的 kcadm 凭据配置（~/.keycloak/kcadm.config 不存在），
     所以必须显式传 --server/--realm/--user/--password。
"""
import json
import os
import subprocess
import sys

KC = "/opt/keycloak/bin/kcadm.sh"
CONTAINER = "eapheavy-keycloak"
SERVER = "http://localhost:8080"
AUTH_REALM = "master"
REALM = sys.argv[1] if len(sys.argv) > 1 else "enterprise"
WANT = [
    "profile",
    "email",
    "roles",
    "web-origins",
    "basic",
    "acr",
    "organization",
    "role_list",
    "offline_access",
    "microprofile-jwt",
    "phone",
    "address",
    "saml_organization",
]


def admin_credentials() -> tuple[str, str]:
    """取 master realm 管理员凭据。

    与 scripts/keycloak-admin.py 同源：进程环境优先，其次 deploy/compose/.env。
    口令只用于容器内 kcadm.sh 的认证，**不会回显**。
    """
    user = os.environ.get("KC_ADMIN_USER") or os.environ.get("KEYCLOAK_ADMIN") or ""
    password = (
        os.environ.get("KC_ADMIN_PASSWORD") or os.environ.get("KEYCLOAK_ADMIN_PASSWORD") or ""
    )
    env_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "deploy",
        "compose",
        ".env",
    )
    if (not user or not password) and os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not password and line.startswith("KEYCLOAK_ADMIN_PASSWORD="):
                    password = line.split("=", 1)[1].strip()
                if not user and line.startswith("KEYCLOAK_ADMIN="):
                    user = line.split("=", 1)[1].strip()
    if not user or not password:
        raise SystemExit(
            "错误：没有可用的 Keycloak 管理凭据。请在 deploy/compose/.env 里配置 "
            "KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD，"
            "或用环境变量 KC_ADMIN_USER / KC_ADMIN_PASSWORD 覆盖。"
        )
    return user, password


def kc(args: list[str], target_realm: str | None = None) -> str:
    """在容器内跑 kcadm.sh。

    口令只通过 docker exec -e 从宿主环境传入容器，不进宿主 argv；
    因此管理员改密后不要求重建容器来刷新旧的 KC_BOOTSTRAP_ADMIN_PASSWORD。
    """
    admin_user, admin_password = admin_credentials()
    inner = (
        f'{KC} "$@" --server {SERVER} --realm {AUTH_REALM} '
        f'--user {admin_user} --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"'
    )
    if target_realm:
        inner += f" --target-realm {target_realm}"
    cmd = [
        "docker",
        "exec",
        "-e",
        "KC_BOOTSTRAP_ADMIN_PASSWORD",
        CONTAINER,
        "sh",
        "-c",
        inner,
        "--",
        *args,
    ]
    env = dict(os.environ)
    env["KC_BOOTSTRAP_ADMIN_PASSWORD"] = admin_password
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise SystemExit(
            f"kcadm.sh 执行失败（退出码 {proc.returncode}）：\n{proc.stderr.strip()}"
        )
    return proc.stdout


raw = kc(["get", "client-scopes"], target_realm=REALM)
scopes = json.loads(raw)
by_name = {s["name"]: s for s in scopes}

result = {}
for name in WANT:
    if name not in by_name:
        print(f"!! 缺少内置 scope: {name}", file=sys.stderr)
        continue
    full = json.loads(kc(["get", f"client-scopes/{by_name[name]['id']}"], target_realm=REALM))
    # 去掉运行时字段，只保留可导入的声明部分
    keep = {
        "name": full.get("name"),
        "description": full.get("description"),
        "protocol": full.get("protocol"),
        "attributes": full.get("attributes") or {},
        "protocolMappers": full.get("protocolMappers") or [],
    }
    result[name] = keep
    print(
        f"{name:22s} mappers={len(keep['protocolMappers']):2d} "
        f"attrs={'yes' if keep['attributes'] else 'no '}",
        file=sys.stderr,
    )

json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
