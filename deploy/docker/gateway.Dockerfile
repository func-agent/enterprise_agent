# =============================================================================
# agentgateway —— 统一网关镜像（见 3.1 网关组件 / 4.3 核心能力）
#
# 构建上下文为仓库根目录：
#   docker build -f deploy/docker/gateway.Dockerfile -t eap/agentgateway:1.0.0 .
# =============================================================================
ARG NODE_VERSION=22

# —— 构建阶段：编译 TypeScript workspace
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

# better-sqlite3 等原生依赖需要编译工具链
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages

RUN npm ci --no-audit --no-fund
RUN npm run build:backend && npm prune --omit=dev

# —— 运行阶段：最小镜像
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

EXPOSE 8080

# 探针与 compose 中的 healthcheck 保持一致（/healthz，见 3.1 自研鉴权中间件）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/gateway/dist/main.js"]
