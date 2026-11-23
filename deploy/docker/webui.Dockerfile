# =============================================================================
# AgentScope Web UI —— 唯一用户入口（见 2.1「单一前端」/ 3.1「AgentScope Web UI」）
#
# 构建上下文为仓库根目录：
#   docker build -f deploy/docker/webui.Dockerfile -t eap/webui:1.0.0 .
#
# 说明：
#   · 前端源码位于 apps/webui，构建产物约定在 dist/webui
#   · 前端构建失败时镜像构建同步失败，不生成占位页
# =============================================================================
ARG NODE_VERSION=22

# —— 构建阶段
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps ./apps

RUN npm ci --no-audit --no-fund

# —— 前端构建；任何失败都必须终止镜像构建
RUN npm run build:web

# —— 运行阶段：nginx 静态服务
FROM nginx:1.27-alpine AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist/webui /usr/share/nginx/html
COPY deploy/compose/nginx/webui.conf /etc/nginx/conf.d/webui.conf

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:5173/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
