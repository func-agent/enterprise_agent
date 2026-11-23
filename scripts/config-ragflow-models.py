#!/usr/bin/env python3
"""RAGFlow 批量配置模型（MiniMax 经 agentgateway，不直连商业 API）。

背景
----
RAGFlow 的「模型提供商」页默认是**每个厂商直连自己的 API**，那会绕过平台的唯一出口
与出网代理（方案 9.3 / 4.4）。本平台统一接成：

    RAGFlow 容器 ──► agentgateway（OpenAI 兼容端口）──► Envoy 出网代理 ──► MiniMax

RAGFlow 侧用内置的 ``OpenAI-API-Compatible`` provider 指向网关，模型名填**网关的虚拟
模型名**（``smart-model`` / ``reasoning-model`` / ``fast-model`` / ``minimax``），底层落到
``MiniMax-M3.1-Flash`` 等真实模型。

⚠️ 不要用 RAGFlow 内置的「MiniMax」provider：它的 base_url 写死
``https://api.minimax.chat/v1/text/chatcompletion_v2``，UI 不给改写入口，等于容器直连
商业 API；而且它直连的是 MiniMax 开放平台，与本平台的 Mavis 侧凭证不是同一个服务。

用法
----
    sudo -n python3 scripts/config-ragflow-models.py              # 全部账号
    sudo -n python3 scripts/config-ragflow-models.py --only eap-ops
    sudo -n python3 scripts/config-ragflow-models.py --no-assistant
    sudo -n python3 scripts/config-ragflow-models.py --refresh-models
    sudo -n python3 scripts/config-ragflow-models.py --update-assistant

账号
----
三类登录方式，各走各的：

* ``sso``   —— Keycloak 账号（eap-admin / eap-ops / eap-manager / eap-demo），
  走 ``/v1/user/login/keycloak`` → Keycloak 授权页 → RAGFlow 回调 ``?auth=`` 令牌；
* ``local`` —— RAGFlow 本地账号（eap-admin@eap.local），走 ``/v1/user/login``，
  口令需用服务端公钥做 RSA PKCS1v1.5 加密（对 base64 后的密码再加密）。

口令默认值与仓库文档一致（本地开发口令），可用环境变量或根 ``.env`` 覆盖：
``RAGFLOW_PWD_<账号名大写>``，例如 ``RAGFLOW_PWD_EAP_OPS``；本地应急账号使用
``RAGFLOW_PWD_EAP_ADMIN_LOCAL``。

默认共享 ``RAGFLOW_GATEWAY_KEY`` 仅用于本地 POC。需要平台侧按用户区分审计与预算时，
给各账号配置独立的 ``RAGFLOW_GATEWAY_KEY_<账号名大写>``，并在网关的
``AUTH_SERVICE_TOKENS`` 中配置对应身份。修改凭证后用 ``--refresh-models`` 显式更新。
"""

from __future__ import annotations

import argparse
import functools
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import uuid

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 账号定义 ────────────────────────────────────────────────────────────
# kind=sso 走 Keycloak；kind=local 走 RAGFlow 本地账号
ACCOUNTS = [
    {"email": "eap-admin@example.com", "kind": "sso", "kc_user": "eap-admin", "slug": "EAP_ADMIN", "pwd": "EapAdmin@2026"},
    {"email": "eap-ops@example.com", "kind": "sso", "kc_user": "eap-ops", "slug": "EAP_OPS", "pwd": "EapOps@2026"},
    {"email": "eap-manager@example.com", "kind": "sso", "kc_user": "eap-manager", "slug": "EAP_MANAGER", "pwd": "EapManager@2026"},
    {"email": "eap-demo@example.com", "kind": "sso", "kc_user": "eap-demo", "slug": "EAP_DEMO", "pwd": "EapDemo@2026"},
    {"email": "eap-admin@eap.local", "kind": "local", "slug": "EAP_ADMIN_LOCAL", "pwd": "EapAdmin@2026"},
]

# 网关的 OpenAI 兼容端口（容器内走宿主回环桥 172.17.0.1；RAGFlow 服务没有
# host.docker.internal 的 extra_hosts，用主机名会 DNS 失败）
GATEWAY_BASE = os.environ.get("RAGFLOW_GATEWAY_BASE", "http://172.17.0.1:8080/v1")
# 服务间静态凭证（根 .env 的 AUTH_SERVICE_TOKENS），格式 <token>:<role>:<tenant>:<dept>:<密级>
GATEWAY_KEY = os.environ.get("RAGFLOW_GATEWAY_KEY", "eap-dbgpt-local-key")
# 填进 RAGFlow 的模型名（必须是网关的虚拟模型名）。
# `minimax` 是网关侧的 MiniMax 专属虚拟模型（只落 MiniMax，不跨厂商 failover），
# 与 `smart-model`（主力对话 + 多厂商 failover 链）并存，按场景选。
VIRTUAL_MODELS = [
    name.strip()
    for name in os.environ.get(
        "RAGFLOW_VIRTUAL_MODELS", "smart-model,reasoning-model,fast-model,minimax"
    ).split(",")
    if name.strip()
]
MAX_TOKENS = int(os.environ.get("RAGFLOW_MODEL_MAX_TOKENS", "32768"))
# 内置嵌入模型：必须与 TEI 的 TEI_MODEL 一致，否则 Builtin 分支不绑 TEI
EMBEDDING = os.environ.get("RAGFLOW_EMBEDDING", "BAAI/bge-m3@Builtin")
ASSISTANT_NAME = "企业知识助手"

RAGFLOW_CONTAINER = os.environ.get("RAGFLOW_CONTAINER", "eapheavy-ragflow")


# ── 基础工具 ────────────────────────────────────────────────────────────
def load_sso_module():
    """复用 scripts/ragflow-sso.py 里的 SSO 流程与 base 解析。"""
    spec = importlib.util.spec_from_file_location(
        "ragflow_sso", os.path.join(REPO_ROOT, "scripts", "ragflow-sso.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@functools.lru_cache(maxsize=1)
def root_env() -> dict:
    return load_sso_module().load_env_file(os.path.join(REPO_ROOT, ".env"))


def setting(name: str) -> str:
    return os.environ.get(name) or root_env().get(name) or ""


def docker_cmd() -> list:
    if subprocess.run(["docker", "info"], capture_output=True).returncode == 0:
        return ["docker"]
    return ["sudo", "docker"]


def rsa_encrypt(password: str) -> str:
    """用 RAGFlow 服务端的公钥加密口令（RAGFlow 的本地账号登录要求 RSA 串）。"""
    out = subprocess.run(
        docker_cmd()
        + [
            "exec", "-w", "/ragflow", RAGFLOW_CONTAINER, "python3", "-c",
            "import sys; sys.path.insert(0,'/ragflow')\nfrom api.utils.crypt import crypt\nprint(crypt(%r))" % password,
        ],
        capture_output=True, text=True, timeout=120,
    )
    lines = out.stdout.strip().splitlines()
    if not lines:
        raise RuntimeError(f"口令加密失败：rc={out.returncode} {out.stderr.strip()[:200]}")
    return lines[-1]


def http(method: str, url: str, body=None, headers=None, timeout=180):
    hdrs = {"User-Agent": "eap-config-ragflow/1.0"}
    if body is not None:
        hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            # 保留 HTTPMessage 的大小写不敏感查找（响应头可能写成小写 authorization）
            return resp.status, resp.headers, raw
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


def jhttp(method: str, url: str, body=None, headers=None, timeout=180):
    st, hd, raw = http(method, url, body, headers, timeout)
    try:
        return st, json.loads(raw or "{}")
    except json.JSONDecodeError:
        return st, {"raw": raw[:400]}


# ── 登录 ────────────────────────────────────────────────────────────────
def login_sso(base: str, email: str, kc_user: str, password: str) -> str:
    """Keycloak SSO → RAGFlow 的 Authorization 令牌。"""
    sso = load_sso_module()
    token = sso.sso_auth_token(base, kc_user, password)
    st, _, raw = http("GET", f"{base}/v1/user/info", headers={"Authorization": token})
    data = json.loads(raw).get("data") or {}
    if data.get("email") != email:
        raise RuntimeError(f"SSO 登录到了 {data.get('email')}，期望 {email}")
    return token


def login_local(base: str, email: str, password: str) -> str:
    """RAGFlow 本地账号登录 → Authorization 响应头里的令牌。"""
    enc = rsa_encrypt(password)
    st, hd, raw = http("POST", f"{base}/v1/user/login", {"email": email, "password": enc})
    token = hd.get("Authorization")
    if not token:
        raise RuntimeError(f"本地账号登录失败：HTTP {st} {raw[:200]}")
    return token


# ── 配置动作 ────────────────────────────────────────────────────────────
def model_id(name: str) -> str:
    return f"{name}___OpenAI-API@OpenAI-API-Compatible"


def configured_models(base: str, token: str) -> dict:
    st, r = jhttp(
        "GET", f"{base}/v1/llm/my_llms?include_details=true",
        headers={"Authorization": token},
    )
    if st != 200 or r.get("code") != 0:
        raise RuntimeError(f"读取已配置模型失败：HTTP {st} {r.get('message') or r.get('raw')}")
    models = {}
    for factory, details in (r.get("data") or {}).items():
        for model in (details or {}).get("llm") or []:
            models[(factory, model.get("name"))] = model
    return models


def add_models(base: str, token: str, gateway_key: str, refresh: bool = False) -> list:
    """配置虚拟模型；配置一致时跳过，避免 add_llm 的真实模型探测。"""
    current = configured_models(base, token)
    results = []
    for name in VIRTUAL_MODELS:
        stored_name = f"{name}___OpenAI-API"
        existing = current.get(("OpenAI-API-Compatible", stored_name))
        unchanged = (
            existing
            and existing.get("type") == "chat"
            and (existing.get("api_base") or "") == GATEWAY_BASE
            and int(existing.get("max_tokens") or 0) == MAX_TOKENS
            and str(existing.get("status") or "1") == "1"
        )
        if unchanged and not refresh:
            results.append((name, True, "配置一致，跳过模型探测"))
            continue

        st, r = jhttp(
            "POST", f"{base}/v1/llm/add_llm",
            {
                "llm_factory": "OpenAI-API-Compatible",
                "api_key": gateway_key,
                "llm_name": name,
                "model_type": "chat",
                "max_tokens": MAX_TOKENS,
                "api_base": GATEWAY_BASE,
            },
            {"Authorization": token},
            timeout=240,
        )
        ok = st == 200 and r.get("code") == 0
        message = "已配置并通过连通性校验" if ok else r.get("message") or r.get("raw") or f"HTTP {st}"
        results.append((name, ok, message))
    return results


def set_defaults(base: str, token: str, llm_id: str) -> tuple[bool, str, str]:
    """分别补齐默认 LLM 与 Embedding，保留所有非空的人工选择。"""
    st, r = jhttp("GET", f"{base}/v1/user/tenant_info", headers={"Authorization": token})
    if st != 200 or r.get("code") != 0:
        raise RuntimeError(f"读取默认模型失败：HTTP {st} {r.get('message') or r.get('raw')}")
    data = r.get("data") or {}
    tenant_id = data.get("tenant_id") or data.get("id")
    if not tenant_id:
        raise RuntimeError("租户信息缺少 tenant_id")

    cur_llm = data.get("llm_id") or ""
    cur_embd = data.get("embd_id") or ""
    next_llm = cur_llm or llm_id
    next_embd = cur_embd or EMBEDDING
    if cur_llm and cur_embd:
        return False, f"LLM={cur_llm} | Embedding={cur_embd}（保留现有选择）", cur_llm

    payload = {
        "tenant_id": tenant_id,
        "llm_id": next_llm,
        "embd_id": next_embd,
        "asr_id": data.get("asr_id") or "",
        "img2txt_id": data.get("img2txt_id") or "",
        "rerank_id": data.get("rerank_id") or "",
        "tts_id": data.get("tts_id") or "",
    }
    st, r = jhttp("POST", f"{base}/v1/user/set_tenant_info", payload, {"Authorization": token})
    if st != 200 or r.get("code") != 0:
        raise RuntimeError(f"设置默认模型失败：HTTP {st} {r.get('message') or r.get('raw')}")
    return True, f"LLM={next_llm} | Embedding={next_embd}（仅补齐空缺）", next_llm


def list_kbs(base: str, token: str) -> list:
    """当前租户下的知识库（跨租户不可见，所以每个用户要各自建库）。"""
    st, r = jhttp("POST", f"{base}/v1/kb/list", {}, {"Authorization": token})
    if st != 200 or r.get("code") != 0:
        raise RuntimeError(f"读取知识库失败：HTTP {st} {r.get('message') or r.get('raw')}")
    kb_list = r.get("data") or []
    if isinstance(kb_list, dict):
        kb_list = kb_list.get("kbs") or []
    return kb_list


def assistant_config(kb_ids: list) -> dict:
    """助理配置。

    ⚠️ 参数怎么写，决定「能不能用」，两个硬约束（都是实测踩坑）：

    1. **参数只有 `knowledge` 一个** —— 用户问题是从 messages 里取的，
       不是参数。RAGFlow 自己的默认模板就是这样
       （`parameters:[{key:"knowledge",optional:false}]`，system 里写 `{knowledge}`）。
       若把问题也声明成参数（如 key=`user question`），前端**不会**在请求体里填这个字段，
       后端校验直接报 `Miss parameter: user question`（`dialog_service.py:395`），
       界面上表现为每条消息都是 ERROR。
    2. **没绑知识库时不能留 `{knowledge}`** —— 更新校验会直接拒绝：
       「Please remove `{knowledge}` in system prompt since no knowledge base / Tavily used here.」；
       而非 optional 的参数又必须出现在 system 里，于是无库时参数要置空。
    """
    if kb_ids:
        system = (
            "你是企业级 AI Agent 平台的智能助手。请依据下面这份知识库内容回答用户的问题，"
            "列出知识库里的相关数据并详细作答；若知识库内容与问题无关，"
            "回答里必须包含「知识库中未找到依据」这句话。回答要结合对话历史。\n"
            "以下是知识库内容：\n{knowledge}\n以上是知识库内容。"
        )
        parameters = [{"key": "knowledge", "optional": False, "description": "知识库检索结果"}]
    else:
        system = (
            "你是企业级 AI Agent 平台的智能助手，请结合对话历史回答用户的问题，"
            "回答准确、简洁；没有依据时明确说明「知识库中未找到依据」，不要编造。"
        )
        parameters = []

    return {
        "name": ASSISTANT_NAME,
        "description": "企业级 AI Agent 平台知识问答助手（模型经 agentgateway 统一治理）",
        "llm_setting": {"temperature": 0.1, "max_tokens": 1024},
        "prompt_config": {
            "prologue": "你好，我是企业知识助手，有什么可以帮你？",
            "system": system,
            "parameters": parameters,
        },
        "kb_ids": kb_ids,
    }


def ensure_assistant(
    base: str,
    token: str,
    llm_id: str,
    kb_ids: list,
    update: bool = False,
    preserve_kb_ids: bool = True,
) -> tuple[str, str]:
    """默认只创建缺失助理；显式更新时可保留原有知识库绑定。"""
    st, r = jhttp("GET", f"{base}/v1/dialog/list", headers={"Authorization": token})
    if st != 200 or r.get("code") != 0:
        raise RuntimeError(f"读取助理失败：HTTP {st} {r.get('message') or r.get('raw')}")
    dialogs = r.get("data") or []
    existing = next((d for d in dialogs if d.get("name") == ASSISTANT_NAME), None)
    if existing and not update:
        return existing["id"], "已存在，保留现有配置"

    effective_kb_ids = (existing.get("kb_ids") or []) if existing and preserve_kb_ids else kb_ids
    payload = assistant_config(effective_kb_ids)
    payload["llm_id"] = llm_id
    if existing:
        payload["dialog_id"] = existing["id"]
    st, r = jhttp("POST", f"{base}/v1/dialog/set", payload, {"Authorization": token}, timeout=120)
    if st != 200 or r.get("code") != 0:
        action = "更新" if existing else "创建"
        raise RuntimeError(f"{action}助理失败：HTTP {st} {r.get('message') or r.get('raw')}")

    assistant_id = existing["id"] if existing else (r.get("data") or {}).get("id", "")
    if not assistant_id:
        raise RuntimeError("创建助理成功但响应缺少 ID")
    action = "已更新" if existing else "已创建"
    return assistant_id, f"{action}，绑定知识库 {len(effective_kb_ids)} 个"


def clean_drafts(base: str, token: str) -> int:
    """删掉 RAGFlow 的空草稿助理（llm_id 为空 —— UI 点「新建助理」会先建一个叫 test 的空壳）。

    这类草稿在聊天页点开会因为没有模型而无法提问，属于噪声。默认不删，
    需要时用 --clean-drafts 显式触发。
    """
    st, _, raw = http("GET", f"{base}/v1/dialog/list", headers={"Authorization": token})
    drafts = [d for d in (json.loads(raw).get("data") or []) if not d.get("llm_id")]
    if not drafts:
        return 0
    st, r = jhttp(
        "POST", f"{base}/v1/dialog/rm",
        {"dialog_ids": [d["id"] for d in drafts]},
        {"Authorization": token},
    )
    return len(drafts) if r.get("code") == 0 else 0


# ── 演示知识库 ──────────────────────────────────────────────────────────
# 演示文档（与 scripts/verify-ragflow.py 的种子保持一致）。
# ⚠️ 不能出现「绝密 / 机密 / 涉密 / TOP SECRET / CONFIDENTIAL / 内部 秘密」——
# 网关护栏命中即把整条提示上调为涉密，而涉密数据禁止出网调商业模型（方案 8.1）。
DEMO_DOC = """公司差旅住宿标准：一线城市每晚不超过 600 元，二线城市不超过 450 元，其他城市不超过 350 元。
差旅住宿需凭发票报销，超标部分由个人承担。

年假制度：入职满 1 年享受 5 天年假，满 3 年 10 天，满 5 年 15 天。年假可跨年结转，结转部分需在次年 3 月底前使用。

保密提醒：项目类文档仅限项目组内部传阅，不得通过外部邮件或公共网盘传输。
"""

DEMO_KB_NAME = "EAP知识库"
DEMO_FILE_NAME = "travel_policy.txt"


def multipart_upload(url: str, fields: dict, files: dict, api_key: str):
    """multipart/form-data 上传（SDK API 走 Bearer api_key）。"""
    boundary = "----eapboundary" + uuid.uuid4().hex
    out = []
    for k, v in fields.items():
        out.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, (fname, content) in files.items():
        out.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fname}\"\r\n"
            f"Content-Type: text/plain\r\n\r\n".encode()
        )
        out.append(content.encode() + b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        url, data=b"".join(out), method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return e.code, {"raw": raw[:300]}


def seed_demo_kb(base: str, token: str, kb_name: str = DEMO_KB_NAME) -> str:
    """给当前租户建演示知识库并灌入演示文档（已有同名库则复用）。

    知识库是**按租户**的：SSO 账号各有自己的租户，看不到本地账号的库，
    所以每个要用知识库的账号都得自己有一份。
    """
    # 1) SDK API Key
    st, r = jhttp("POST", f"{base}/v1/system/new_token", {}, {"Authorization": token})
    api_key = (r.get("data") or {}).get("token")
    if not api_key:
        raise RuntimeError(f"生成 SDK Key 失败：{r.get('message')}")
    api_hdr = {"Authorization": f"Bearer {api_key}"}
    api = f"{base}/api/v1"

    # 2) 复用或新建知识库
    st, r = jhttp("GET", f"{api}/datasets?page=1&page_size=100", None, api_hdr)
    existing = r.get("data") or []
    ds = next((d.get("id") for d in existing if d.get("name") == kb_name), None)
    if not ds:
        st, r = jhttp(
            "POST", f"{api}/datasets",
            {"name": kb_name, "description": "企业级 AI Agent 平台演示知识库",
             "chunk_method": "naive", "embedding_model": EMBEDDING},
            api_hdr,
        )
        ds = (r.get("data") or {}).get("id")
        if not ds:
            raise RuntimeError(f"建知识库失败：{r.get('message')}")

    # 3) 清掉旧文档（保证内容一致，不堆积）
    st, r = jhttp("GET", f"{api}/datasets/{ds}/documents?page=1&page_size=100", None, api_hdr)
    old = (r.get("data") or {}).get("docs") or []
    if old:
        jhttp("DELETE", f"{api}/datasets/{ds}/documents",
              {"ids": [d.get("id") for d in old]}, api_hdr)

    # 4) 上传 + 触发解析
    st, r = multipart_upload(
        f"{api}/datasets/{ds}/documents", {},
        {"file": (DEMO_FILE_NAME, DEMO_DOC)}, api_key,
    )
    files = r.get("data") or []
    if not files:
        raise RuntimeError(f"上传演示文档失败：{r.get('message')}")
    jhttp("POST", f"{api}/datasets/{ds}/chunks", {"document_ids": [f.get("id") for f in files]}, api_hdr)

    # 5) 等解析完成（chunk_num > 0）
    for _ in range(40):
        time.sleep(5)
        st, r = jhttp("GET", f"{api}/datasets/{ds}/documents?page=1&page_size=10", None, api_hdr)
        docs = (r.get("data") or {}).get("docs") or []
        if docs and (docs[0].get("chunk_count") or docs[0].get("chunk_num")):
            return ds
    raise RuntimeError("演示文档解析超时")


# ── 主流程 ──────────────────────────────────────────────────────────────
def pwd_for(acct: dict) -> str:
    key = f"RAGFLOW_PWD_{acct['slug']}"
    legacy_key = "RAGFLOW_PWD_" + re.sub(r"[^A-Za-z0-9]+", "_", acct["email"].split("@")[0]).upper()
    return setting(key) or setting(legacy_key) or acct["pwd"]


def gateway_key_for(acct: dict) -> str:
    return setting(f"RAGFLOW_GATEWAY_KEY_{acct['slug']}") or setting("RAGFLOW_GATEWAY_KEY") or GATEWAY_KEY


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="RAGFlow 批量配置模型（MiniMax 经 agentgateway）")
    parser.add_argument("--only", help="只配某个账号（按 email 或 Keycloak 用户名匹配）")
    parser.add_argument("--no-assistant", action="store_true", help="不建助理，只配模型与默认模型")
    parser.add_argument("--refresh-models", action="store_true", help="重新探测并更新模型连接与凭证（会产生真实模型调用）")
    parser.add_argument("--update-assistant", action="store_true", help="更新已有同名助理；默认保留其全部配置")
    parser.add_argument("--bind-all-kbs", action="store_true", help="新建或显式更新助理时绑定全部知识库")
    parser.add_argument("--clean-drafts", action="store_true", help="顺手删掉 RAGFlow 的空草稿助理（llm_id 为空）")
    parser.add_argument("--seed-kb", action="store_true", help="给没有知识库的租户补建演示知识库（EAP知识库）并灌入演示文档")
    args = parser.parse_args(argv)

    # MiniMax 公有云接入（走网关）：只有根 .env / 进程环境里配了
    # MINIMAX_PUBLIC_API_KEY 才追加这个虚拟模型 —— 没有 key 时网关侧没有该
    # provider，连通性校验必然失败，白白把「模型不可用」写进租户配置。
    if setting("MINIMAX_PUBLIC_API_KEY") and "minimax-public" not in VIRTUAL_MODELS:
        VIRTUAL_MODELS.append("minimax-public")

    if not VIRTUAL_MODELS:
        parser.error("RAGFLOW_VIRTUAL_MODELS 至少要包含一个模型")
    if args.no_assistant and (args.update_assistant or args.bind_all_kbs):
        parser.error("--no-assistant 不能与 --update-assistant / --bind-all-kbs 同时使用")
    accounts = [
        acct for acct in ACCOUNTS
        if not args.only or args.only in (acct["email"], acct.get("kc_user", ""))
    ]
    if not accounts:
        parser.error(f"--only 未匹配任何账号：{args.only}")

    sso = load_sso_module()
    base = sso.ragflow_base()
    print(f"RAGFlow: {base}")
    print(f"网关: {GATEWAY_BASE} | 模型: {', '.join(VIRTUAL_MODELS)}\n")

    failures = 0
    for acct in accounts:
        email = acct["email"]
        pwd = pwd_for(acct)
        try:
            if acct["kind"] == "sso":
                token = login_sso(base, email, acct["kc_user"], pwd)
            else:
                token = login_local(base, email, pwd)
            print(f"✔ {email} 登录成功")

            results = add_models(base, token, gateway_key_for(acct), refresh=args.refresh_models)
            model_failed = False
            for name, ok, msg in results:
                if ok:
                    print(f"    模型 {name}: {msg}")
                else:
                    failures += 1
                    model_failed = True
                    print(f"    模型 {name}: 失败 —— {msg}")
            if model_failed:
                print(f"✘ {email}: 跳过默认模型与助理配置")
                continue

            default_llm_id = model_id(VIRTUAL_MODELS[0])
            _, note, selected_llm_id = set_defaults(base, token, default_llm_id)
            print(f"    默认模型: {note}")

            if args.seed_kb:
                kbs = list_kbs(base, token)
                if not kbs:
                    ds = seed_demo_kb(base, token)
                    print(f"    演示知识库已建: {ds[:8]}…（{DEMO_KB_NAME}）")

            if not args.no_assistant:
                kbs = list_kbs(base, token)
                if args.bind_all_kbs:
                    kb_ids = [k.get("id") for k in kbs if k.get("id")]
                else:
                    kb_ids = [k["id"] for k in kbs if k.get("name") == DEMO_KB_NAME and k.get("id")]
                aid, note = ensure_assistant(
                    base,
                    token,
                    selected_llm_id,
                    kb_ids,
                    update=args.update_assistant,
                    preserve_kb_ids=not args.bind_all_kbs,
                )
                print(f"    助理「{ASSISTANT_NAME}」: {aid[:8]}… | {note}")
            if args.clean_drafts:
                n = clean_drafts(base, token)
                if n:
                    print(f"    清理空草稿助理 {n} 个")
        except Exception as exc:  # noqa: BLE001 —— 逐账号推进，一个失败不挡住其它
            failures += 1
            print(f"✘ {email}: {exc}")

    print()
    print("全部完成" if not failures else f"完成，但有 {failures} 项失败")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
