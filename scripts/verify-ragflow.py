"""
RAGFlow v0.22.1 端到端功能验证（真实容器、真实解析、真实向量检索）

鉴权要点（实测踩坑）：
  1) 密码需用服务端 conf/public.pem 做 RSA PKCS1v1.5 加密（对 base64 后的密码再加密）
  2) Web API（/v1/*）的令牌在**登录响应头** Authorization 里（itsdangerous 签名串），
     不是响应 body 的 data 字段
  3) SDK API（/api/v1/*）用 Bearer <api_key>，api_key 由 POST /v1/system/new_token 生成

账号与数据复用（本轮改造的重点）：
  早期版本每次验收都注册一个随机用户 + 新建一个知识库，导致 RAGFlow 库里堆了
  几十个「EAP知识库 / 端到端验证」和几十个测试用户 —— 既污染数据，也让
  「怎么看 RAGFlow 的数据」变得毫无意义。
  现在改为：
    · 固定账号 eap-admin@eap.local（登录优先，仅首次缺失时注册）
    · 复用同名知识库，每次验收先清空旧文档再上传（知识库数量恒为 1）
  因此本脚本**不再产生新用户、新知识库**，可反复执行。

流程：登录 → 取 API key → 复用/建知识库 → 清空旧文档 → 上传文档 → 触发解析 → 等待完成 → 向量检索
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://127.0.0.1:9380"
API = BASE + "/api/v1"

# 固定验收账号（与平台其它账号同源命名）
EMAIL = "eap-admin@eap.local"
PASSWORD = "EapAdmin@2026"
# 固定知识库名（同名即复用，不再新建）
DS_NAME = "EAP知识库"
DS_DESC = "端到端验证"


def raw(method, path, body=None, headers=None, base=None, timeout=180):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request((base or BASE) + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Authorization"), json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        t = e.read().decode()[:500]
        try:
            return e.code, e.headers.get("Authorization"), json.loads(t)
        except Exception:
            return e.code, e.headers.get("Authorization"), {"raw": t}


def req(method, path, body=None, headers=None, base=None, timeout=180):
    return raw(method, path, body, headers, base, timeout)[::2]


def multipart(url, files, token, timeout=600):
    b = "----" + uuid.uuid4().hex
    out = []
    for k, (fn, content, ctype) in files.items():
        out.append(
            f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fn}\"\r\n"
            f"Content-Type: {ctype}\r\n\r\n".encode()
        )
        out.append(content if isinstance(content, bytes) else content.encode())
        out.append(b"\r\n")
    out.append(f"--{b}--\r\n".encode())
    r = urllib.request.Request(
        url, data=b"".join(out), method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={b}", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        t = e.read().decode()[:500]
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, {"raw": t}


def docker_cmd():
    """返回 docker 调用前缀：当前用户已加入 docker 组时直接调用，否则回退 sudo。"""
    try:
        subprocess.run(["docker", "version"], capture_output=True, timeout=30)
        if subprocess.run(["docker", "version"], capture_output=True).returncode == 0:
            return ["docker"]
    except Exception:
        pass
    return ["sudo", "docker"]


DOCKER = docker_cmd()


def enc(pw):
    out = subprocess.run(
        DOCKER + ["exec", "-w", "/ragflow", "eapheavy-ragflow", "python3", "-c",
                  "import sys; sys.path.insert(0,'/ragflow')\nfrom api.utils.crypt import crypt\nprint(crypt(%r))" % pw],
        capture_output=True, text=True, timeout=120,
    )
    lines = out.stdout.strip().splitlines()
    if not lines:
        raise RuntimeError(f"crypt 加密失败: rc={out.returncode} stderr={out.stderr.strip()[:200]}")
    return lines[-1]


PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  {detail}" if detail else ""))


print("══ RAGFlow v0.22.1 端到端功能验证 ══\n")

# ── 0. 密码加密 ──
EPW = enc(PASSWORD)
check("密码用服务端公钥加密", len(EPW) > 100, f"{len(EPW)} 字符")

# ── 1. 登录（账号不存在时才注册）──
st, auth, r = raw("POST", "/v1/user/login", {"email": EMAIL, "password": EPW})
if not auth:
    # 首次运行：账号还没建，先注册再登录。
    # 注意：RAGFlow 对外开放后 REGISTER_ENABLED=0 会拒绝注册，
    # 此时需要先把 REGISTER_ENABLED 临时置 1 跑一次，账号建好后即可长期关闭。
    st, _, rr = raw("POST", "/v1/user/register",
                    {"email": EMAIL, "nickname": "eap-admin",
                     "password": EPW, "confirm_password": EPW})
    if rr.get("code") == 0:
        print(f"      首次运行：已注册固定账号 {EMAIL}")
    else:
        print(f"      注册失败（{rr.get('message', '')}），若账号已存在可忽略")
    st, auth, r = raw("POST", "/v1/user/login", {"email": EMAIL, "password": EPW})

check("登录并取 Authorization 响应头", bool(auth), f"{(auth or '')[:36]}…")
if not auth:
    print(json.dumps(r, ensure_ascii=False)[:400])
    sys.exit(1)
AUTH = {"Authorization": auth}

# ── 2. 取 API key ──
st, _, r = raw("POST", "/v1/system/new_token?name=eap", {}, AUTH)
apikey = (r.get("data") or {}).get("token")
check("生成 API key", bool(apikey), str(apikey or "")[:32])
if not apikey:
    print(json.dumps(r, ensure_ascii=False)[:400])
    sys.exit(1)

# ── 3. 复用知识库（同名即用，不新建）──
st, r = req("GET", "/datasets?page=1&page_size=100", None,
            {"Authorization": f"Bearer {apikey}"}, base=API)
# 注意：SDK 的 data 是**数组**（不是 {datasets:[...]}）——早期版本按对象解析，
# 因空数组恰好为 falsy 而侥幸没报错，导致「复用知识库」从未真正生效。
existing = r.get("data") or []
ds = next((d.get("id") for d in existing if d.get("name") == DS_NAME), None)
if ds:
    print(f"      复用已有知识库 id={ds}")
    check("复用同名知识库（不新建）", True, f"id={ds}")
else:
    st, r = req("POST", "/datasets",
                {"name": DS_NAME, "description": DS_DESC, "chunk_method": "naive",
                 "embedding_model": "BAAI/bge-m3@Builtin"},
                {"Authorization": f"Bearer {apikey}"}, base=API)
    ds = (r.get("data") or {}).get("id")
    check("建知识库（SDK API）", bool(ds), f"id={ds} {str(r.get('message', ''))[:70]}")
if not ds:
    print(json.dumps(r, ensure_ascii=False)[:400])
    sys.exit(1)

# ── 3.1 清空该知识库里的旧文档（保证每次验收内容一致、不堆积）──
st, r = req("GET", f"/datasets/{ds}/documents?page=1&page_size=100", None,
            {"Authorization": f"Bearer {apikey}"}, base=API)
old_docs = ((r.get("data") or {}).get("docs") or [])
if old_docs:
    ids = [d.get("id") for d in old_docs]
    st, r = req("DELETE", f"/datasets/{ds}/documents", {"ids": ids},
                {"Authorization": f"Bearer {apikey}"}, base=API)
    check("清空旧文档", r.get("code") == 0, f"删除 {len(ids)} 个")
else:
    print("      知识库内无旧文档，跳过清理")

# ── 4. 上传文档 ──
doc = """公司差旅住宿标准：一线城市每晚不超过 600 元，二线城市不超过 450 元，其他城市不超过 350 元。
差旅住宿需凭发票报销，超标部分由个人承担。

年假制度：入职满 1 年享受 5 天年假，满 3 年 10 天，满 5 年 15 天。年假可跨年结转，结转部分需在次年 3 月底前使用。

保密提醒：项目类文档仅限项目组内部传阅，不得通过外部邮件或公共网盘传输。
"""
# ⚠️ 这段示例文案**不能出现「绝密 / 机密 / 涉密 / TOP SECRET / CONFIDENTIAL / 内部 秘密」**
# —— 网关护栏的 CONFIDENTIAL_MARKERS（packages/gateway/src/guardrails/index.ts）命中任一个
# 就把整条提示上调为涉密，而涉密数据禁止出网调商业模型（方案 8.1）。本文件被检索进
# system 提示后就会触发阻断，表现为「明明绑了知识库，回答却是『知识库中未找到依据』，
# 引用 0 条」。护栏本身是对的，是**示例文案**踩了自己的雷。
st, r = multipart(f"{API}/datasets/{ds}/documents",
                  {"file": ("travel_policy.txt", doc, "text/plain")}, apikey)
files = r.get("data") or []
check("上传文档", bool(files), f"{len(files)} 个文件 {str(r.get('message', ''))[:70]}")
if not files:
    print(json.dumps(r, ensure_ascii=False)[:400])
    sys.exit(1)

# ── 5. 触发解析 ──
st, r = req("POST", f"/datasets/{ds}/chunks",
            {"document_ids": [f.get("id") for f in files]},
            {"Authorization": f"Bearer {apikey}"}, base=API, timeout=600)
check("触发解析（分块 + 向量化）", r.get("code") == 0, str(r.get("message", ""))[:90])

# ── 6. 轮询解析进度 ──
done = False
for i in range(40):
    time.sleep(6)
    st, r = req("GET", f"/datasets/{ds}/documents?page=1&page_size=10", None,
                {"Authorization": f"Bearer {apikey}"}, base=API)
    dl = ((r.get("data") or {}).get("docs") or [])
    if dl:
        d = dl[0]
        # SDK API 返回 chunk_count；DB 里是 chunk_num，两者任一非零即视为已分块
        if d.get("chunk_count") or d.get("chunk_num"):
            done = True
            print(f"      chunk_count={d.get('chunk_count')}  chunk_num={d.get('chunk_num')}  "
                  f"token_num={d.get('token_num')}  progress={d.get('progress')}")
            break
        print(f"      解析中 [{i + 1}] progress={d.get('progress')} run={str(d.get('run'))[:70]}")
if not done:
    st, r = req("GET", f"/datasets/{ds}/documents?page=1&page_size=10", None,
                {"Authorization": f"Bearer {apikey}"}, base=API)
    print("      最后状态:", json.dumps(r, ensure_ascii=False)[:400])
check("文档解析完成（生成 chunk）", done)

# ── 7. 向量检索 ──
st, r = req("POST", "/retrieval",
            {"dataset_ids": [ds], "question": "差旅住宿标准是多少钱一晚", "page_size": 5},
            {"Authorization": f"Bearer {apikey}"}, base=API, timeout=300)
chunks = (r.get("data") or {}).get("chunks") or []
hits = [(c.get("content") or "")[:70] for c in chunks]
check("向量检索返回结果", bool(chunks), f"{len(chunks)} 个 chunk")
if chunks:
    rel = any(("600" in h) or ("住宿" in h) or ("差旅" in h) for h in hits)
    check("检索命中「差旅住宿标准」内容", rel, hits[0][:56])

print(f"\n══ RAGFlow 验收：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 ══")
if FAIL:
    print("失败项:", FAIL)
sys.exit(1 if FAIL else 0)
