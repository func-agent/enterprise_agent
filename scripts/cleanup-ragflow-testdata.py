"""
RAGFlow 验收垃圾数据清理
========================

背景：早期版本的 scripts/verify-ragflow.py 每次执行都注册一个随机用户 +
新建一个知识库 + 传一份文档，导致 RAGFlow 库里堆了 60 个测试用户、
49 个同名知识库。既污染数据，也让「怎么看 RAGFlow 的数据」变得毫无意义。

本脚本做两件事：
  1. 用各测试账号自己登录（密码沿用旧脚本的 Eap@12345），通过 SDK API
     删除它们的知识库 —— 走 API 而不是直接删库行，是为了让 RAGFlow 自己
     把 MinIO 对象、Infinity 向量、chunk 一并清干净，不留孤儿数据。
  2. 再用 SQL 清掉剩余的 user / tenant / user_tenant 行（RAGFlow 没有
     删除用户的公开接口）。

保留：eap-admin@eap.local（平台固定账号）及其知识库一律不动。

用法：
  python3 scripts/cleanup-ragflow-testdata.py            # 清理
  python3 scripts/cleanup-ragflow-testdata.py --dry-run  # 只看会删什么
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:9380"
API = BASE + "/api/v1"

KEEP_EMAIL = "eap-admin@eap.local"
OLD_PASSWORD = "Eap@12345"  # 旧脚本注册时统一使用的口令
DB = "rag_flow"
MYSQL_ROOT_PW = "eap-local-mysql-2026"
MYSQL_CONTAINER = "eapheavy-mysql"
RAGFLOW_CONTAINER = "eapheavy-ragflow"

DRY_RUN = "--dry-run" in sys.argv


def docker_cmd():
    try:
        if subprocess.run(["docker", "version"], capture_output=True).returncode == 0:
            return ["docker"]
    except Exception:
        pass
    return ["sudo", "docker"]


DOCKER = docker_cmd()


def sql(query):
    """在 MySQL 容器里执行 SQL，返回行列表（无表头）。"""
    out = subprocess.run(
        DOCKER + ["exec", MYSQL_CONTAINER, "sh", "-c",
                  f"mysql -h127.0.0.1 -uroot -p{MYSQL_ROOT_PW} {DB} -N -B -e {json.dumps(query)}"],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"SQL 失败: {out.stderr.strip()[:300]}")
    return [line.split("\t") for line in out.stdout.strip().splitlines() if line]


def api(method, path, body=None, headers=None, base=BASE, timeout=180):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Authorization"), json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        t = e.read().decode()[:500]
        try:
            return e.code, e.headers.get("Authorization"), json.loads(t)
        except Exception:
            return e.code, e.headers.get("Authorization"), {"raw": t}


def enc(pw):
    """用服务端公钥加密口令（RAGFlow 要求 RSA PKCS1v1.5 加密 base64 后的密码）。"""
    out = subprocess.run(
        DOCKER + ["exec", "-w", "/ragflow", RAGFLOW_CONTAINER, "python3", "-c",
                  "import sys; sys.path.insert(0,'/ragflow')\nfrom api.utils.crypt import crypt\nprint(crypt(%r))" % pw],
        capture_output=True, text=True, timeout=120,
    )
    lines = out.stdout.strip().splitlines()
    if not lines:
        raise RuntimeError(f"crypt 加密失败: {out.stderr.strip()[:200]}")
    return lines[-1]


print("══ RAGFlow 验收垃圾数据清理 ══\n")
if DRY_RUN:
    print("（--dry-run：只统计，不做任何删除）\n")

# ── 1. 找出待清理的测试用户 ──
rows = sql(
    "SELECT id, email FROM user "
    f"WHERE email LIKE 'eap%@eap.local' AND email <> '{KEEP_EMAIL}' ORDER BY id"
)
print(f"待清理用户：{len(rows)} 个（保留 {KEEP_EMAIL}）")
if not rows:
    print("无需清理。")
    sys.exit(0)

# ── 2. 逐个登录 → 删光其知识库（走 API，让 MinIO / Infinity 一并清干净）──
EPW = enc(OLD_PASSWORD)
ok_users, failed_users, deleted_kb = 0, [], 0

for uid, email in rows:
    st, auth, r = api("POST", "/v1/user/login", {"email": email, "password": EPW})
    if not auth:
        failed_users.append((email, f"登录失败 HTTP {st}"))
        continue
    AUTH = {"Authorization": auth}
    st, _auth, r = api("POST", "/v1/system/new_token?name=eap", {}, AUTH)
    apikey = (r.get("data") or {}).get("token")
    if not apikey:
        failed_users.append((email, "取 API key 失败"))
        continue
    AK = {"Authorization": f"Bearer {apikey}"}
    st, _auth, r = api("GET", "/datasets?page=1&page_size=100", None, AK, base=API)
    datasets = r.get("data") or []  # SDK 的 data 是数组，不是 {datasets:[...]}
    if datasets:
        ids = [d.get("id") for d in datasets]
        if DRY_RUN:
            print(f"  [dry-run] {email}: 将删除 {len(ids)} 个知识库")
        else:
            st, _auth, r = api("DELETE", "/datasets", {"ids": ids}, AK, base=API)
            if r.get("code") == 0:
                deleted_kb += len(ids)
            else:
                failed_users.append((email, f"删知识库失败: {str(r.get('message'))[:60]}"))
                continue
    ok_users += 1

print(f"  登录并清理完成：{ok_users} 个用户，删除知识库 {deleted_kb} 个")
if failed_users:
    print(f"  失败 {len(failed_users)} 个（将用 SQL 兜底清理其残留）：")
    for e, why in failed_users[:10]:
        print(f"    {e}: {why}")

# ── 3. SQL 兜底：清掉剩余的 user / tenant / user_tenant 行 ──
# 关系链：user → user_tenant → tenant → knowledgebase → document / file
if not DRY_RUN:
    sql("SET FOREIGN_KEY_CHECKS=0")
    # 3.1 找出这些用户的租户
    # 注意：SQL LIKE 里的 % 与 Python 的 % 格式化冲突，这里用 f-string + 变量拼接，
    # 不走 % 格式化，避免 '%@' 被当成格式说明符。
    tenants = sql(
        "SELECT DISTINCT t.tenant_id FROM user_tenant t JOIN user u ON u.id = t.user_id "
        f"WHERE u.email LIKE 'eap%@eap.local' AND u.email <> '{KEEP_EMAIL}'"
    )
    tids = [t[0] for t in tenants]
    if tids:
        tl = ",".join(f"'{t}'" for t in tids)
        # 子表 → 父表，顺序不能反
        sql(f"DELETE f2 FROM file2document f2 JOIN document d ON d.id = f2.document_id "
            f"JOIN knowledgebase kb ON kb.id = d.kb_id WHERE kb.tenant_id IN ({tl})")
        sql(f"DELETE t FROM task t JOIN document d ON d.id = t.doc_id "
            f"JOIN knowledgebase kb ON kb.id = d.kb_id WHERE kb.tenant_id IN ({tl})")
        sql(f"DELETE FROM document WHERE kb_id IN "
            f"(SELECT id FROM knowledgebase WHERE tenant_id IN ({tl}))")
        sql(f"DELETE FROM knowledgebase WHERE tenant_id IN ({tl})")
        sql(f"DELETE FROM file WHERE tenant_id IN ({tl})")
        sql(f"DELETE FROM api_token WHERE tenant_id IN ({tl})")
        sql(f"DELETE FROM invitation_code WHERE tenant_id IN ({tl})")
        sql(f"DELETE FROM user_tenant WHERE tenant_id IN ({tl})")
        sql(f"DELETE FROM tenant WHERE id IN ({tl})")
    # 3.2 用户本身
    sql(f"DELETE FROM conversation WHERE user_id IN "
        f"(SELECT id FROM user WHERE email LIKE 'eap%@eap.local' AND email <> '{KEEP_EMAIL}')")
    sql(f"DELETE FROM invitation_code WHERE user_id IN "
        f"(SELECT id FROM user WHERE email LIKE 'eap%@eap.local' AND email <> '{KEEP_EMAIL}')")
    sql(f"DELETE FROM user_tenant WHERE user_id IN "
        f"(SELECT id FROM user WHERE email LIKE 'eap%@eap.local' AND email <> '{KEEP_EMAIL}')")
    sql(f"DELETE FROM user WHERE email LIKE 'eap%@eap.local' AND email <> '{KEEP_EMAIL}'")
    sql("SET FOREIGN_KEY_CHECKS=1")

# ── 4. 复核 ──
print()
for label, q in [
    ("user", "SELECT COUNT(*) FROM user"),
    ("knowledgebase", "SELECT COUNT(*) FROM knowledgebase"),
    ("document", "SELECT COUNT(*) FROM document"),
    ("file", "SELECT COUNT(*) FROM file"),
    ("tenant", "SELECT COUNT(*) FROM tenant"),
]:
    print(f"  {label}: {sql(q)[0][0]}")
print("\n完成。")
