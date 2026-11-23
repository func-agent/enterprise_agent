# =============================================================================
# MCP Hub（packages/mcp-hub）—— 本地 MCP Server 镜像
#
# 依据 3.1「MCP Federation：按租户暴露不同 MCP 工具目录」
#      2.1「单一网关：MCP 工具统一收口在 agentgateway」
#
# 端口：8091 文档检索 / 8092 ChatBI / 8093 业务工具
#
# 构建上下文为仓库根目录：
#   docker build -f deploy/docker/mcp-hub.Dockerfile -t eap/mcp-hub:1.0.0 .
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

EXPOSE 8091 8092 8093

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8091/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/mcp-hub/dist/main.js"]
