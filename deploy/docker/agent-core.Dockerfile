# =============================================================================
# AgentScope Service（packages/agent-core）—— 自研 Agent 内核服务镜像
#
# 依据 3.1「AgentScope Service：多租户注册 / 会话管理 / 分布式协调」
#      4.1「ChatModel 全部指向 agentgateway，Toolkit 指向网关 MCP 端点」
#
# 构建上下文为仓库根目录：
#   docker build -f deploy/docker/agent-core.Dockerfile -t eap/agent-core:1.0.0 .
# =============================================================================
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages

RUN npm ci --no-audit --no-fund
RUN npm run build:backend && npm prune --omit=dev

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

RUN apk add --no-cache tini \
    && addgroup -S eap && adduser -S eap -G eap

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /app/data && chown -R eap:eap /app/data
USER eap

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/agent-core/dist/main.js"]
