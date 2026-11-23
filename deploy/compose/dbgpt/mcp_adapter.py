#!/usr/bin/env python3
"""DB-GPT 的 MCP Server 适配器（FastMCP + streamable-http）。

## 为什么需要这个适配器

《企业级 AI Agent 平台建设方案》3.1 要求「DB-GPT 以 MCP Server 暴露」，
但 DB-GPT 上游**从来没有过 MCP Server 形态** —— 已实测核实：

  * Docker Hub ``eosphorosai/dbgpt`` 共 56 个标签，最高 ``v0.8.3``（0.9.x 从未发布）
  * PyPI ``dbgpt`` / ``dbgpt-serve`` / ``dbgpt-app`` / ``dbgpt-client`` 最高均 0.8.2
  * GitHub ``eosphoros-ai/DB-GPT`` 共 56 个 tag，最高 ``v0.8.3``，
    且 **main 分支 pyproject 版本号仍是 0.8.3**、CLI（``cli_scripts.py``）注册的命令中
    **无 ``mcp``**、``dbgpt_serve/`` 下**无 ``mcp`` 子模块**

DB-GPT 的 MCP 方向是**客户端**（``connector`` / ``ConnectorManager``，支持
``sse`` / ``streamable_http`` 传输），不是服务端。

因此本适配器在 DB-GPT 容器内用官方 MCP Python SDK（镜像内已装 ``mcp 1.27.2``，
``FastMCP.run(transport="streamable-http")`` 已验证可用）把 DB-GPT 的 ChatBI 能力
按 MCP 协议暴露出去，让 3.1 的口径在平台边界上**真实成立**。

> 性质说明：这是**平台侧集成适配**，不是上游原生功能。对外如实标注。

## 对外工具（工具名与平台原有 chatbi 工具一致，便于平滑切换）

  * ``chatbi.query``        自然语言查数 → Text2SQL → 只读执行 → 表格 + 图表规格
  * ``chatbi.list_metrics`` 指标口径字典
  * ``chatbi.run_sql``      执行一条只读 SQL（写操作一律拒绝）

## 调用链

    问题
      → DB-GPT apiserver ``/api/v1/chat/completions`` 生成 SQL
        （模型出口指向 agentgateway 的 proxy/openai，不直连商业 API —— 方案 4.4）
      → DB-GPT 数据源 ``RDBMSConnector.query_ex()`` 执行（只读校验在此之前）
      → 表格 + 图表规格

## 运行

    python3 /app/mcp_adapter.py      # 默认监听 0.0.0.0:8094
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("dbgpt-mcp-adapter")

# ─────────────────────────── 配置 ───────────────────────────

APISERVER = os.environ.get("DBGPT_APISERVER", "http://127.0.0.1:8092")
API_KEY = os.environ.get("DBGPT_API_KEY", "eap-dbgpt-local-key")
CONFIG_PATH = os.environ.get("DBGPT_CONFIG", "/app/dbgpt.toml")
DS_NAME = os.environ.get("DBGPT_DATASOURCE", "eap_sales")
DS_PATH = os.environ.get("DBGPT_DATASOURCE_PATH", "/app/datasources/chatbi.db")
METRICS_PATH = os.environ.get("DBGPT_METRICS_PATH", "/app/metrics.json")
MCP_HOST = os.environ.get("DBGPT_MCP_HOST", "0.0.0.0")
MCP_PORT = int(os.environ.get("DBGPT_MCP_PORT", "8094"))
MODEL = os.environ.get("DBGPT_MODEL", "smart-model")
MAX_ROWS = int(os.environ.get("DBGPT_MAX_ROWS", "1000"))

# 与平台侧只读沙箱（packages/mcp-hub/src/sandbox.ts）保持一致
FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|replace|truncate|pragma|attach|detach"
    r"|vacuum|reindex|grant|revoke|begin|commit|rollback|savepoint)\b",
    re.IGNORECASE,
)

# ─────────────────────── DB-GPT 连接器初始化 ───────────────────────

_connector = None
_connector_lock = threading.Lock()


def _build_connector():
    """注册演示数据源到 DB-GPT 自己的连接配置表，并取回连接器。

    走的是 DB-GPT 原生的 ``ConnectConfigDao`` + ``ConnectorManager``，
    所以该数据源会出现在 DB-GPT 自己的数据源管理里（Web UI / API 可见）。
    """
    from dbgpt.component import SystemApp
    from dbgpt_serve.datasource.manages.connector_manager import ConnectorManager

    # 预注册所有 RDBMS 连接器类型，否则 parse_config 找不到 postgresql
    ConnectorManager(SystemApp()).on_init()

    from dbgpt.util.configure.manager import ConfigurationManager
    from dbgpt.datasource.base import BaseDatasourceParameters
    from dbgpt.storage.metadata.db_manager import db

    cfg = ConfigurationManager.from_file(CONFIG_PATH)
    db_config = cfg.parse_config(
        BaseDatasourceParameters, prefix="service.web.database"
    )
    url = None
    for kwargs in ({"ssl": True, "charset": "utf8mb4"}, {"charset": "utf8mb4"}, {}):
        try:
            url = db_config.db_url(**kwargs)
            if url:
                break
        except Exception:  # noqa: BLE001 —— 不同 dbtype 支持的参数不同
            continue
    if not url:
        raise RuntimeError("无法从配置构造元数据库 URL")
    db.init_db(url)

    # 注册演示数据源（幂等）
    from dbgpt_serve.datasource.manages.connect_config_db import ConnectConfigDao

    dao = ConnectConfigDao()
    if not dao.get_by_names(DS_NAME):
        if not os.path.exists(DS_PATH):
            raise RuntimeError(f"演示数据源不存在：{DS_PATH}")
        dao.add_file_db(
            db_name=DS_NAME,
            db_type="sqlite",
            db_path=DS_PATH,
            comment="平台 ChatBI 演示数据集（orders / invoices / payments）",
        )
        log.info("已向 DB-GPT 注册数据源 %s（%s）", DS_NAME, DS_PATH)

    cm = ConnectorManager(SystemApp())
    cm.on_init()
    connector = cm.get_connector(DS_NAME)
    log.info("DB-GPT 连接器就绪：%s", DS_NAME)
    return connector


def get_connector():
    global _connector
    if _connector is None:
        with _connector_lock:
            if _connector is None:
                _connector = _build_connector()
    return _connector


# ─────────────────────────── 工具辅助 ───────────────────────────


def load_metrics() -> list[dict[str, Any]]:
    """指标口径字典 —— 与平台侧共用同一个 JSON 文件（单一数据源）。"""
    try:
        with open(METRICS_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:  # noqa: BLE001
        log.warning("读取指标字典失败：%s", exc)
        return []


def validate_read_only(sql: str) -> tuple[bool, str]:
    """语句级只读校验（与平台侧沙箱同语义）。"""
    trimmed = (sql or "").strip()
    if not trimmed:
        return False, "SQL 为空"
    if FORBIDDEN.search(trimmed):
        return False, "检测到写操作或 DDL，已拒绝执行"
    if not re.match(r"^(select|with)\b", trimmed, re.IGNORECASE):
        return False, "仅允许 SELECT / WITH 只读查询"
    without_strings = re.sub(r"'[^']*'", "''", trimmed)
    if ";" in without_strings:
        return False, "仅允许单条语句"
    return True, ""


def bound_sql(sql: str) -> str:
    """补 LIMIT，避免大结果集。"""
    bounded = sql.strip().rstrip(";").strip()
    if not re.search(r"\blimit\b", bounded, re.IGNORECASE):
        bounded += f" LIMIT {MAX_ROWS}"
    return bounded


def extract_sql(text: str) -> str | None:
    """从模型输出里抽取 SQL。"""
    if not text:
        return None
    fenced = re.search(r"```(?:sql)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    candidate = (fenced.group(1) if fenced else text).strip()
    match = re.search(r"(SELECT[\s\S]*)", candidate, re.IGNORECASE)
    sql = (match.group(1) if match else candidate).strip()
    sql = re.sub(r";+\s*$", "", sql).strip()
    if not re.match(r"^select\b", sql, re.IGNORECASE):
        return None
    return sql


def build_chart(rows: list[dict[str, Any]], question: str) -> dict[str, Any] | None:
    """图表规格推导（与平台侧 buildChart 同逻辑）。"""
    if not rows:
        return None
    cols = list(rows[0].keys())
    if re.search(r"趋势|走势|变化", question):
        ctype = "line"
    elif re.search(r"占比|构成|比例", question):
        ctype = "pie"
    else:
        ctype = "bar"

    if len(cols) == 1:
        col = cols[0]
        return {
            "type": ctype,
            "x": "category",
            "y": col,
            "title": question,
            "data": [{"category": "结果", col: row.get(col)} for row in rows],
        }

    label_col = next(
        (c for c in cols if re.search(r"date|month|region|dept|customer|name|category|label", c, re.IGNORECASE)),
        cols[0],
    )
    value_col = next(
        (
            c
            for c in cols
            if c != label_col and re.search(r"amount|count|total|value|num|qty", c, re.IGNORECASE)
        ),
        next((c for c in cols if c != label_col), cols[-1]),
    )
    return {
        "type": ctype,
        "x": label_col,
        "y": value_col,
        "title": question,
        "data": [{label_col: row.get(label_col), value_col: row.get(value_col)} for row in rows],
    }


def call_dbgpt_llm(system: str, user: str, max_tokens: int = 800) -> str:
    """经 DB-GPT apiserver 调模型（模型出口指向 agentgateway，不直连商业 API）。"""
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.0,
    }
    req = urllib.request.Request(
        f"{APISERVER}/api/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        body = json.loads(resp.read().decode() or "{}")
    choices = body.get("choices") or []
    if not choices:
        raise RuntimeError(f"DB-GPT 未返回结果：{json.dumps(body, ensure_ascii=False)[:200]}")
    return (choices[0].get("message") or {}).get("content") or ""


def run_query(sql: str) -> tuple[bool, list[str], list[dict[str, Any]], str]:
    """只读执行 —— 校验通过后交给 DB-GPT 的连接器执行。"""
    ok, err = validate_read_only(sql)
    if not ok:
        return False, [], [], err
    try:
        connector = get_connector()
        fields, rows = connector.query_ex(bound_sql(sql))
    except Exception as exc:  # noqa: BLE001
        return False, [], [], f"SQL 执行失败：{exc}"
    columns = list(fields or [])
    out: list[dict[str, Any]] = []
    for row in rows or []:
        if isinstance(row, dict):
            out.append(row)
        else:
            out.append(dict(zip(columns, row)))
    return True, columns, out, ""


def schema_text() -> str:
    """从 DB-GPT 连接器取真实表结构（用于 Text2SQL 提示词）。"""
    try:
        connector = get_connector()
        info = connector.get_table_info()
        if isinstance(info, str):
            return info
        return str(info)
    except Exception as exc:  # noqa: BLE001
        log.warning("取表结构失败：%s", exc)
        return ""


# ─────────────────────────── MCP Server ───────────────────────────

from mcp.server.fastmcp import FastMCP  # noqa: E402

mcp = FastMCP(
    "dbgpt-chatbi",
    instructions=(
        "DB-GPT ChatBI MCP Server。把 DB-GPT 的 Text2SQL 能力按 MCP 协议暴露：\n"
        "- chatbi.query：自然语言查数（生成只读 SQL → 只读执行 → 表格 + 图表规格）\n"
        "- chatbi.list_metrics：指标口径字典\n"
        "- chatbi.run_sql：执行一条只读 SQL\n"
        "写操作一律被拒绝。"
    ),
    host=MCP_HOST,
    port=MCP_PORT,
    # 无状态模式 —— 与平台自身的 MCP Server 一致
    #（packages/mcp-hub/src/server-base.ts 用 sessionIdGenerator: undefined）。
    #
    # 必须无状态的原因：FastMCP 默认走有状态会话（session id 由 initialize 下发），
    # 服务端重启后旧 session 立即失效，客户端会收到
    #   {"code":-32600,"message":"Session not found"}
    # 而 MCP 客户端通常缓存连接不重连 —— 导致重启后工具目录整个拉不到。
    stateless_http=True,
)

TEXT2SQL_SYSTEM = (
    "你是一个只读 SQL 生成器。根据给定的数据库 schema 与指标口径字典，"
    "把用户问题翻译成 **一条** PostgreSQL 风格的 SELECT 语句。\n"
    "硬性要求：\n"
    "1. 只输出 SQL，不要解释文字；\n"
    "2. 必须以 SELECT 开头（可用 WITH ... SELECT）；\n"
    "3. 禁止任何写操作与 DDL；\n"
    "4. 必须遵守给定的指标口径字典（表、字段、过滤条件）；\n"
    "5. 若问题涉及时间范围，使用 schema 中实际存在的日期字段过滤。\n"
    "输出格式：\n```sql\nSELECT ...\n```"
)


@mcp.tool(
    name="chatbi.query",
    description=(
        "自然语言查数。生成只读 SQL → DB-GPT 数据源只读执行 → 返回表格与图表规格。"
        "口径：默认下单口径销售额。"
    ),
)
def chatbi_query(question: str, caliber: str = "下单口径") -> dict[str, Any]:
    question = (question or "").strip()
    if not question:
        return {"ok": False, "error": "问题不能为空"}

    metrics = load_metrics()
    dict_lines = "\n".join(
        f"- {m['metric']}（{m['caliber']}）：{m['definition']}；表 {m['table']}，字段 {m['field']}"
        + (f"，过滤 {m['filter']}" if m.get("filter") and m["filter"] != "1=1" else "")
        for m in metrics
    )
    user_prompt = "\n\n".join(
        [
            f"数据库 schema：\n{schema_text()}",
            f"指标口径字典：\n{dict_lines}",
            f"本次查询口径偏好：{caliber}",
            f"用户问题：{question}",
        ]
    )

    try:
        raw = call_dbgpt_llm(TEXT2SQL_SYSTEM, user_prompt)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"Text2SQL 调用失败：{exc}"}

    sql = extract_sql(raw)
    if not sql:
        return {"ok": False, "error": f"模型未返回可执行 SQL：{(raw or '')[:200]}"}

    ok, columns, rows, err = run_query(sql)
    if not ok:
        return {"ok": False, "error": f"SQL 执行被拒绝或失败：{err}", "sql": sql}

    chart = build_chart(rows, question)
    if rows:
        text = "\n".join(
            [
                f"口径：{caliber}",
                f"SQL：{sql}",
                f"列：{', '.join(columns)}",
                "",
                " | ".join(columns),
                *[" | ".join(str(r.get(c, "")) for c in columns) for r in rows],
            ]
        )
    else:
        text = f"口径：{caliber}\nSQL：{sql}\n查询结果为空。"

    return {
        "ok": True,
        "caliber": caliber,
        "sql": sql,
        "columns": columns,
        "rows": rows,
        "rowCount": len(rows),
        "chart": chart,
        "text": text,
    }


@mcp.tool(
    name="chatbi.list_metrics",
    description="列出可用指标及其口径定义（同名指标多口径问题的统一出口）。",
)
def chatbi_list_metrics() -> dict[str, Any]:
    metrics = load_metrics()
    text = "\n".join(
        f"{m['metric']}（{m['caliber']}）：{m['definition']}｜表 {m['table']}.{m['field']}"
        for m in metrics
    )
    return {"ok": True, "metrics": metrics, "text": text}


@mcp.tool(
    name="chatbi.run_sql",
    description="直接执行一条只读 SQL（禁止写操作）。仅用于调试与自助分析。",
)
def chatbi_run_sql(sql: str) -> dict[str, Any]:
    ok, columns, rows, err = run_query(sql or "")
    if not ok:
        return {"ok": False, "error": err}
    text = (
        "\n".join(
            [
                " | ".join(columns),
                *[" | ".join(str(r.get(c, "")) for c in columns) for r in rows],
            ]
        )
        if rows
        else "查询结果为空。"
    )
    return {"ok": True, "columns": columns, "rows": rows, "text": text}


def main() -> int:
    # host / port 已在 FastMCP 构造时设置 —— run() 不接受这两个参数，
    # 默认值是 127.0.0.1:8000（与 DB-GPT 的 controller 端口冲突）。
    log.info(
        "启动 DB-GPT MCP Server：%s:%s（数据源 %s → %s）",
        MCP_HOST,
        MCP_PORT,
        DS_NAME,
        DS_PATH,
    )
    # 预热连接器，失败不阻断启动（工具调用时会再试一次并报错）
    try:
        get_connector()
    except Exception as exc:  # noqa: BLE001
        log.warning("连接器预热失败（工具调用时会重试）：%s", exc)
    mcp.run(transport="streamable-http")
    return 0


if __name__ == "__main__":
    sys.exit(main())
