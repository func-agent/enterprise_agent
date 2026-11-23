# DB-GPT 0.8.3 官方镜像的补充层
#
# 官方镜像内置 SQLAlchemy，但**不含 PostgreSQL 驱动**。DB-GPT 的 webserver
# 元数据库配置 type = "postgresql" 时会走到
#   dbgpt_ext/datasource/rdbms/conn_postgresql.py → create_engine → import psycopg2
# 从而抛 ModuleNotFoundError: No module named 'psycopg2'，webserver 直接起不来。
#
# 这里补一个 manylinux 二进制 wheel（无需编译工具链），只增加约 4MB。
# 基础镜像已在本机，build 不会重新下载 21GB。
FROM eosphorosai/dbgpt:latest

RUN /opt/.uv.venv/bin/pip install --no-cache-dir psycopg2-binary==2.9.13
