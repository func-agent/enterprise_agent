#!/usr/bin/env python3
"""DB-GPT 元数据库初始化（PostgreSQL 方言）。

## 为什么需要这个脚本

DB-GPT 自己的 `_migration_db_storage()` 只在 **dbtype == sqlite** 时执行
`db.create_all()`；postgres / mysql 分支只打印一条 warning，要求用户手工执行
`assets/schema/dbgpt.sql`：

    1. If you are use DB-GPT firstly, please manually execute the following command
       to initialize, `mysql -h127.0.0.1 -uroot -p{your_password} < ./assets/schema/dbgpt.sql`

而这份 `dbgpt.sql` 是 **MySQL 方言**（反引号标识符 / ENGINE=InnoDB / AUTO_INCREMENT /
`use dbgpt;`），**不能**直接在 PostgreSQL 上执行。镜像里的 alembic 脚本目录
（`pilot/meta_data/alembic/versions/`）也是**空的**（0 个迁移脚本），
所以 `alembic upgrade head` 什么都不会做 —— 表不会建，webserver 启动时会报
`relation "dbgpt_serve_flow" does not exist`。

## 这里怎么做

改用 SQLAlchemy 的 `metadata.create_all()`：
  * **方言无关** —— 由 SQLAlchemy 按当前方言生成 DDL，PG / MySQL 都能用；
  * 与 DB-GPT 对 SQLite 的处理路径**完全一致**（DB-GPT 自己就是 `db.create_all()`）；
  * 幂等 —— 已存在的表会被跳过。

代价是不产生 alembic 版本记录（没有 schema 变更历史）。本项目用于本地/开发形态，
生产部署应改为受控的迁移流程。

## 用法

    python init_db.py            # 从 DBGPT_CONFIG（默认 /app/dbgpt.toml）读配置
"""
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("dbgpt-init-db")

CONFIG_PATH = os.environ.get("DBGPT_CONFIG", "/app/dbgpt.toml")


def _install_pg_text_shim() -> None:
    """让 PostgreSQL 方言忽略 Text 的长度修饰符。

    DB-GPT 的模型用 `Text(length=2**31 - 1)` 声明长文本字段（如 chat_history.messages），
    这是 MySQL / SQLite 的写法。SQLAlchemy 在 PG 方言下会原样渲染成
    `TEXT(2147483647)`，而 PG 不接受 TEXT 的长度修饰符：

        psycopg2.errors.SyntaxError: type modifier is not allowed for type "text"

    PG 的 TEXT 本身就是无限长，直接渲染成 TEXT 即可。MySQL 方言本身就会忽略
    该长度（渲染为 `TEXT`），SQLite 亦可，故这个钩子只挂在 postgresql 上。
    """
    from sqlalchemy import Text
    from sqlalchemy.ext.compiler import compiles

    @compiles(Text, "postgresql")
    def _compile_text_postgresql(element, compiler, **kw):  # noqa: ANN001
        return "TEXT"

    log.info("已启用 PostgreSQL TEXT 兼容钩子")


def _db_url(db_config) -> str:
    """构造数据库 URL —— 不同 dbtype 的参数不同，逐个降级尝试。"""
    for kwargs in (
        {"ssl": True, "charset": "utf8mb4"},
        {"charset": "utf8mb4"},
        {},
    ):
        try:
            url = db_config.db_url(**kwargs)
            if url:
                return url
        except Exception:  # noqa: BLE001 —— 不同 dbtype 支持的参数不同，逐个降级
            continue
    raise RuntimeError("无法从配置构造数据库 URL")


def _import_all_models() -> int:
    """导入所有模型模块，保证元数据齐全。

    DB-GPT 自己的 `_MODELS` 清单**并不完整** —— 例如
    `dbgpt_serve.rag.models.wiki_db`（knowledge_wiki_task 表）就不在其中，
    漏导会导致 webserver 启动时报 `relation "knowledge_wiki_task" does not exist`。

    这里做一次全量扫描导入：遍历 dbgpt_serve / dbgpt_app / dbgpt_ext 下所有
    含 models / db 的模块，逐个 try-import（部分模块有可选依赖，失败不影响）。
    """
    import importlib
    import pkgutil

    from dbgpt_app.initialization.db_model_initialization import _MODELS  # noqa: F401

    roots = [
        "dbgpt_serve",
        "dbgpt_app",
        "dbgpt_ext",
        "dbgpt",
    ]
    imported = 0
    failed = 0
    for root in roots:
        try:
            pkg = importlib.import_module(root)
        except Exception:  # noqa: BLE001
            continue
        for mod in pkgutil.walk_packages(pkg.__path__, prefix=f"{root}."):
            name = mod.name
            if not any(k in name for k in ("models", "models_", ".db", "_db", "entities")):
                continue
            try:
                importlib.import_module(name)
                imported += 1
            except Exception:  # noqa: BLE001 —— 可选依赖缺失的模块跳过
                failed += 1
    log.info("模型模块扫描完成：导入 %d 个，跳过 %d 个", imported, failed)
    return imported


def main() -> int:
    # 先预注册所有 RDBMS 连接器 —— 否则类型注册表是空的，
    # parse_config 会抛 "Unknown type value: postgresql, known types: []"。
    # （DB-GPT 内部在 dbgpt_server.load_config() 里通过 scan_configs() 做同样的事）
    from dbgpt.component import SystemApp
    from dbgpt_serve.datasource.manages.connector_manager import ConnectorManager

    ConnectorManager(SystemApp()).on_init()

    from dbgpt.util.configure.manager import ConfigurationManager
    from dbgpt.datasource.base import BaseDatasourceParameters

    if not os.path.exists(CONFIG_PATH):
        log.error("配置文件不存在：%s", CONFIG_PATH)
        return 1

    cfg = ConfigurationManager.from_file(CONFIG_PATH)
    db_config = cfg.parse_config(
        BaseDatasourceParameters, prefix="service.web.database"
    )
    log.info("元数据库类型：%s", db_config.get_type_value())

    # 导入全部模型，保证元数据齐全（与 DB-GPT 内部初始化保持一致）
    _import_all_models()

    from dbgpt.storage.metadata.db_manager import db

    _install_pg_text_shim()

    url = _db_url(db_config)
    log.info("连接数据库：%s", url.split("@")[-1])
    db.init_db(url)

    db.create_all()

    # 汇报实际建出的表数量，便于验收
    from sqlalchemy import inspect

    tables = inspect(db.engine).get_table_names()
    log.info("元数据库就绪，共 %d 张表", len(tables))
    return 0


if __name__ == "__main__":
    sys.exit(main())
