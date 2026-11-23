#!/usr/bin/env python3
"""DB-GPT Web Server 的启动包装器。

**为什么需要它**：DB-GPT 的 MCP 客户端连接器状态是**进程内 + 绑定事件循环**的
（``CredentialStore`` 只在内存，``MCPToolPack`` 的 MCP 会话绑定创建它的事件循环），
所以「把平台 MCP Server 注册为 DB-GPT 客户端」必须在 **webserver 自己的进程与
uvicorn 事件循环**里完成。

本包装器**不改 DB-GPT 源码**，只用其官方扩展点：

1. 复用 DB-GPT 自己的 ``run_webserver(config)`` 入口（配置解析、组件初始化、
   alembic 迁移、数据源注册全部照旧）；
2. 通过 ``dbgpt.util.fastapi.register_event_handler(app, "startup", handler)``
   注册启动钩子 —— DB-GPT 的 lifespan 会调用这些 handler。

   注意：**不能用** ``app.on_event("startup")`` —— DB-GPT 的 app 设置了
   ``lifespan_context``，FastAPI 会**静默忽略** on_event 处理器（只打一条 warning）。

3. 钩子里用上游原生的 ``ConnectorManager.create_connector()`` 注册平台 MCP Server。

注册完成后，DB-GPT 的 agent / awesomes 即可直接调用平台的 MCP 工具。

用法::

    python3 /app/webserver_boot.py /app/dbgpt.toml
"""
from __future__ import annotations

import logging
import sys

log = logging.getLogger("dbgpt.webserver_boot")

import dbgpt_app.dbgpt_server as ds  # noqa: E402

from dbgpt.util.fastapi import register_event_handler  # noqa: E402

from register_platform_mcp import register_connectors  # noqa: E402


async def _on_startup() -> None:
    """在 uvicorn 的事件循环里注册平台 MCP 客户端连接器。"""
    try:
        results = await register_connectors(ds.system_app)
        ok = sum(1 for r in results if r.get("ok"))
        log.info("平台 MCP 客户端注册完成：%d/%d 个连接器可用", ok, len(results))
        for r in results:
            log.info(
                "  · %s → %s（状态 %s，工具 %d 个：%s）",
                r.get("name"),
                r.get("uri"),
                r.get("status"),
                len(r.get("tools") or []),
                ", ".join(r.get("tools") or [])[:120],
            )
    except Exception as exc:  # noqa: BLE001 —— 注册失败不应阻断 webserver 启动
        log.warning("注册平台 MCP 连接器失败（不影响 webserver 启动）：%s", exc)


def main() -> int:
    register_event_handler(ds.app, "startup", _on_startup)
    config_file = sys.argv[1] if len(sys.argv) > 1 else "/app/dbgpt.toml"
    log.info("以平台 MCP 客户端增强模式启动 DB-GPT Web Server：%s", config_file)
    ds.run_webserver(config_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
