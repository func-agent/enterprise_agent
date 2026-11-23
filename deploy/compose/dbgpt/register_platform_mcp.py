#!/usr/bin/env python3
"""把平台的 MCP Server 注册为 **DB-GPT 的客户端连接器**。

DB-GPT 的 MCP 方向是客户端（上游原生能力）：``ConnectorManager.create_connector()``
支持 ``connector_type="custom_mcp"`` + ``transport="streamable_http"``，
即 DB-GPT 可以作为 MCP 客户端去消费别的 MCP Server。

本模块用**上游原生 API** 把平台的 MCP Server（knowledge / business）注册进来，
形成双向 MCP 拓扑：

    平台 Agent ──► 网关 ──► DB-GPT MCP Server（适配器）──► DB-GPT 模型 / 数据源
                              ▲
                              └── MCP 客户端连接器 ──► 平台 knowledge / business MCP

## 为什么必须在进程内注册

DB-GPT 的连接器状态是**进程内**的 —— ``CredentialStore`` 用 Fernet 加密但只存在内存里，
``create_connector`` 建立的 ``MCPToolPack`` 也只在当前进程的 ``_active_packs`` 中。
因此注册必须发生在**使用这些工具的那个进程**里，且要跑在**该进程自己的事件循环**上
（否则 MCP 客户端会话会绑在已关闭的 loop 上失效）。

本模块由 ``webserver_boot.py`` 在 uvicorn 的 startup 事件里调用，
因此注册发生在 **webserver 进程 + uvicorn 事件循环**中 ——
DB-GPT 的 agent / awesomes 随后就能直接调用平台 MCP 的工具。
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

# 日志挂在 dbgpt.* 层级下 —— DB-GPT 的 setup_logging() 只接管这个层级，
# 用别的 logger 名会被 root logger 的重配置吞掉。
log = logging.getLogger("dbgpt.platform_mcp")

# 平台 MCP Server 列表（DB-GPT 容器内经 host-gateway 访问宿主）
# 格式：<名称>=<server_uri>，逗号分隔
DEFAULT_SERVERS = "eap-knowledge=http://host.docker.internal:8091/mcp,eap-business=http://host.docker.internal:8093/mcp"


def _parse_servers(spec: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in (spec or "").split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        name, uri = item.split("=", 1)
        name, uri = name.strip(), uri.strip()
        if name and uri:
            out.append({"name": name, "uri": uri})
    return out


async def register_connectors(system_app: Any) -> list[dict[str, Any]]:
    """把平台 MCP Server 注册为 DB-GPT 的 MCP 客户端连接器。

    返回每个连接器的注册结果（含从平台拉到的工具清单），便于验收。
    """
    from dbgpt.agent.resource.connector.manager import ConnectorManager

    manager = system_app.get_component("connector_manager", ConnectorManager)

    spec = os.environ.get("DBGPT_PLATFORM_MCP_SERVERS", DEFAULT_SERVERS)
    results: list[dict[str, Any]] = []

    for srv in _parse_servers(spec):
        name, uri = srv["name"], srv["uri"]
        try:
            connector_id = await manager.create_connector(
                connector_type="custom_mcp",
                credentials={},
                name=name,
                extra_config={
                    "server_uri": uri,
                    "transport": "streamable_http",
                    "auth_type": os.environ.get("DBGPT_PLATFORM_MCP_AUTH_TYPE", "none"),
                },
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("注册平台 MCP 连接器失败 %s：%s", name, exc)
            results.append({"name": name, "uri": uri, "ok": False, "error": str(exc)})
            continue

        pack = manager.get_connector_tools(connector_id)
        # MCPToolPack 把工具登记在 tool_server_map（工具名 → MCP server 地址），
        # 并把工具对象放进 ResourcePack._resources；没有 `.tools` 属性。
        tools: list[str] = []
        if pack is not None:
            tools = sorted(getattr(pack, "tool_server_map", {}) or {})

        # ConnectorStatus 是枚举成员本身（.active / .error），没有 .status 属性
        status = manager.get_status(connector_id)
        state = getattr(status, "name", None) or (str(status) if status else None)
        ok = bool(tools) and (state is None or str(state).lower() == "active")
        log.info(
            "已注册平台 MCP 连接器 %s（%s）→ %s，工具 %d 个",
            name,
            uri,
            state,
            len(tools),
        )
        results.append(
            {
                "name": name,
                "uri": uri,
                "ok": ok,
                "connector_id": connector_id,
                "status": str(state),
                "tools": tools,
            }
        )

    _dump_result(results)
    return results


RESULT_PATH = os.environ.get("DBGPT_PLATFORM_MCP_RESULT", "/app/logs/platform_mcp.json")


def _dump_result(results: list[dict[str, Any]]) -> None:
    """把注册结果落盘 —— 不依赖日志配置，便于验收脚本读取。"""
    try:
        os.makedirs(os.path.dirname(RESULT_PATH), exist_ok=True)
        with open(RESULT_PATH, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "ok": sum(1 for r in results if r.get("ok")),
                    "total": len(results),
                    "connectors": results,
                },
                fh,
                ensure_ascii=False,
                indent=2,
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("写入注册结果文件失败：%s", exc)


def list_registered(system_app: Any) -> list[dict[str, Any]]:
    """列出当前进程内已激活的 MCP 客户端连接器（诊断用）。"""
    from dbgpt.agent.resource.connector.manager import ConnectorManager

    manager = system_app.get_component("connector_manager", ConnectorManager)
    out = []
    for item in manager.list_active() or []:
        pack = None
        cid = item.get("connector_id")
        if cid:
            pack = manager.get_connector_tools(cid)
        out.append(
            {
                "connector_id": cid,
                "name": item.get("name"),
                "type": item.get("connector_type"),
                "tools": [
                    getattr(t, "name", str(t)) for t in (getattr(pack, "tools", []) or [])
                ],
            }
        )
    return out
