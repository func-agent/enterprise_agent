-- =============================================================================
-- PostgreSQL 初始化脚本（容器首次启动时由 /docker-entrypoint-initdb.d 执行）
--
-- 依据《建设方案》3.1 存储组件：PostgreSQL 16 承载全平台元数据；
--          8.5 凭证安全：数据库账号最小权限。
--
-- 说明：
--   1) 平台自身元数据库 eap（POSTGRES_DB 已创建）；
--   2) Langfuse v3 需要独立数据库 langfuse；
--   3) DB-GPT 元数据数据库 dbgpt（可选，按需保留）。
-- =============================================================================

-- —— Langfuse 观测库
CREATE DATABASE langfuse OWNER eap;

-- —— DB-GPT 元数据库
CREATE DATABASE dbgpt OWNER eap;

-- —— Langfuse worker 需要独立 schema 权限
GRANT ALL PRIVILEGES ON DATABASE langfuse TO eap;
GRANT ALL PRIVILEGES ON DATABASE dbgpt TO eap;

\connect langfuse
GRANT ALL ON SCHEMA public TO eap;
ALTER SCHEMA public OWNER TO eap;

\connect dbgpt
GRANT ALL ON SCHEMA public TO eap;
ALTER SCHEMA public OWNER TO eap;
