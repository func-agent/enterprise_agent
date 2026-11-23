"""
DB-GPT 0.8.3 端到端功能验证（真实容器、真实模型调用、真实 MCP Server）

说明：DB-GPT 官方镜像不含 `dbgpt mcp server` 子命令 —— 实测核实 0.9.x 从未发布
      （Docker Hub 共 56 个标签最高 v0.8.3；PyPI 最高 0.8.2；GitHub eosphoros-ai/DB-GPT
      共 56 个 tag 最高 v0.8.3，且 main 分支版本号仍为 0.8.3、CLI 无 mcp 子命令）。
      DB-GPT 的 MCP 方向是客户端（connector）而非服务端，
      因此本实例以「模型 API Server + Web Server」原生形态运行，
      MCP Server 角色由容器内的薄适配器（deploy/compose/dbgpt/mcp_adapter.py）承担。

本脚本验证：
  1. apiserver 的 OpenAI 兼容端口可达
  2. 无 API Key → 401
  3. 模型列表可查（controller/worker 注册成功）
  4. /api/v1/chat/completions 真实经 DB-GPT → 网关 → 商业模型
  5. Web Server（DB-GPT 原生形态：datasource / Text2SQL / awesomes）可达
  6. DB-GPT 的 MCP Server 可握手，工具目录可列出
  7. chatbi.query 真实 Text2SQL → 只读执行 → 表格 + 图表规格
  8. chatbi.list_metrics 指标口径字典
  9. chatbi.run_sql 只读可执行 / 写操作被拒
 10. DB-GPT 作为 MCP 客户端已注册平台 MCP Server（反向互联）
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

DBGPT = "http://127.0.0.1:8094"
DBGPT_WEB = "http://127.0.0.1:8096"
DBGPT_MCP = "http://127.0.0.1:8097/mcp"   # 宿主端口
# MCP 客户端跑在容器内，走容器自己的端口
DBGPT_MCP_IN_CONTAINER = "http://127.0.0.1:8094/mcp"
API_KEY = "eap-dbgpt-local-key"
CONTAINER = "eapheavy-dbgpt"

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  {detail}" if detail else ""))


def req(method, path, body=None, key=None, timeout=180, base=None):
    h = {"Content-Type": "application/json"}
    if key:
        h["Authorization"] = f"Bearer {key}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request((base or DBGPT) + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]


# ─────────────────────────────────────────────────────────────
# MCP 客户端：宿主没有 mcp SDK，但容器里有官方 SDK，
# 用 `docker exec -i ... python3 -` 把客户端程序送进容器执行。
# ─────────────────────────────────────────────────────────────
MCP_CLIENT = r'''
import asyncio, json, sys
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = sys.argv[1]
CALLS = json.loads(sys.argv[2])

async def main():
    out = {"handshake": False, "tools": [], "results": {}}
    async with streamablehttp_client(URL) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            out["handshake"] = True
            res = await s.list_tools()
            out["tools"] = [t.name for t in res.tools]
            # CALLS 是 [[别名, 工具名, 参数], ...] —— 同一工具可能要被调多次
            for alias, tool_name, args in CALLS:
                r2 = await s.call_tool(tool_name, args)
                text = r2.content[0].text if r2.content else ""
                try:
                    out["results"][alias] = json.loads(text)
                except Exception:
                    out["results"][alias] = {"raw": text}
    print(json.dumps(out, ensure_ascii=False))

asyncio.run(main())
'''


def mcp_call(calls):
    """在容器内跑 MCP 客户端，返回 {handshake, tools, results}。"""
    try:
        p = subprocess.run(
            ["docker", "exec", "-i", CONTAINER, "python3", "-", DBGPT_MCP_IN_CONTAINER, json.dumps(calls)],
            input=MCP_CLIENT,
            capture_output=True,
            text=True,
            timeout=420,
        )
    except subprocess.TimeoutExpired:
        return {"handshake": False, "tools": [], "results": {}, "error": "MCP 客户端超时"}
    if p.returncode != 0:
        return {
            "handshake": False,
            "tools": [],
            "results": {},
            "error": (p.stderr or "")[-300:],
        }
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception as exc:
        return {"handshake": False, "tools": [], "results": {}, "error": f"解析失败: {exc}"}


print("══ DB-GPT 0.8.3 端到端功能验证 ══\n")

# ── 1. 端口可达 ──
st, _ = req("GET", "/openapi.json")
check("API Server 端口可达（Swagger）", st == 200, f"HTTP {st}")

# ── 2. 鉴权 ──
st, _ = req("GET", "/api/v1/models")
check("无 API Key → 401", st == 401, f"HTTP {st}")

st, body = req("GET", "/api/v1/models", key=API_KEY)
check("带 API Key 可查模型", st == 200, f"HTTP {st}")
models = []
if st == 200:
    try:
        models = json.loads(body).get("data") or []
    except Exception:
        models = []
check("模型已注册到 controller", bool(models), f"{[m.get('id') for m in models]}")

# ── 3. 真实模型调用（DB-GPT → worker → 网关 → 商业模型）──
st, body = req(
    "POST", "/api/v1/chat/completions",
    {"model": models[0]["id"] if models else "smart-model",
     "messages": [{"role": "user", "content": "用一句话说明差旅住宿标准"}],
     "max_tokens": 512},
    key=API_KEY, timeout=240,
)
content = ""
usage = {}
if st == 200:
    try:
        d = json.loads(body)
        content = (d["choices"][0]["message"].get("content") or "")
        usage = d.get("usage") or {}
    except Exception:
        pass
check("chat/completions 返回 200", st == 200, f"HTTP {st}")
check("返回真实模型内容", bool(content.strip()), content[:60])
check("返回 token 用量", usage.get("total_tokens", 0) > 0, str(usage))

# ── 4. Web Server（DB-GPT 原生形态）──
st, _ = req("GET", "/", base=DBGPT_WEB, timeout=30)
check("Web Server 可达（DB-GPT 原生形态）", st == 200, f"HTTP {st}")

# ── 5~8. MCP Server（适配器）──
mcp = mcp_call([
    ["query", "chatbi.query", {"question": "2024年11月华东区销售额是多少"}],
    ["metrics", "chatbi.list_metrics", {}],
    ["run_sql", "chatbi.run_sql", {"sql": "SELECT COUNT(*) AS c FROM orders"}],
    ["run_sql_write", "chatbi.run_sql", {"sql": "DELETE FROM orders"}],
])
check("MCP Server 握手成功（streamable-http）", bool(mcp.get("handshake")), str(mcp.get("error", ""))[:120])
tools = mcp.get("tools") or []
check(
    "MCP 工具目录可列出（chatbi.*）",
    any(t.startswith("chatbi.") for t in tools),
    ", ".join(tools),
)

res = mcp.get("results") or {}

q = res.get("query") or {}
check("chatbi.query 成功", bool(q.get("ok")), str(q.get("error", ""))[:120])
check("chatbi.query 返回 SQL", bool(q.get("sql")), str(q.get("sql"))[:90])
check("chatbi.query 返回图表规格", bool(q.get("chart")), json.dumps(q.get("chart"), ensure_ascii=False)[:80])
check("chatbi.query 查询到数据", (q.get("rowCount") or 0) > 0, f"rowCount={q.get('rowCount')}")

m = res.get("metrics") or {}
check(
    "chatbi.list_metrics 指标口径字典",
    len(m.get("metrics") or []) > 0,
    f"{len(m.get('metrics') or [])} 条",
)

r = res.get("run_sql") or {}
check("chatbi.run_sql 只读可执行", bool(r.get("ok")), str(r.get("rows", ""))[:80])

rw = res.get("run_sql_write") or {}
check("chatbi.run_sql 写操作被拒", rw.get("ok") is False, str(rw.get("error", ""))[:80])

# ── 9. DB-GPT 作为 MCP 客户端注册平台 MCP Server ──
reg = {"ok": 0, "total": 0, "connectors": []}
try:
    p = subprocess.run(
        ["docker", "exec", CONTAINER, "cat", "/app/logs/platform_mcp.json"],
        capture_output=True, text=True, timeout=60,
    )
    if p.returncode == 0:
        reg = json.loads(p.stdout)
except Exception as exc:  # noqa: BLE001
    reg = {"error": str(exc)}
check(
    "DB-GPT 已注册平台 MCP Server（客户端方向）",
    (reg.get("ok") or 0) > 0,
    f"{reg.get('ok')}/{reg.get('total')} 个连接器可用",
)
reg_tools = []
for c in reg.get("connectors") or []:
    reg_tools.extend(c.get("tools") or [])
check(
    "DB-GPT 拉取到平台 MCP 工具",
    len(reg_tools) > 0,
    f"{len(reg_tools)} 个：" + ", ".join(reg_tools[:4]),
)

print(f"\n══ DB-GPT 验收：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 ══")
if FAIL:
    print("失败项:", FAIL)
sys.exit(1 if FAIL else 0)
