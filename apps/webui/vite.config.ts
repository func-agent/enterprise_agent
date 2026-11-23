import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 前端构建配置 —— 产物输出到仓库根 dist/webui，由部署层统一分发。
 */
export default defineConfig({
  root: __dirname,
  // tailwindcss() —— Tailwind 4 的 Vite 插件，负责处理 src/styles.css
  // 里的 @import "tailwindcss" 与 @theme 令牌。
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 本地开发时把网关与 Agent 接口转发到 Vite 服务，避免跨域。
      '/v1': { target: 'http://127.0.0.1:8080', changeOrigin: true, xfwd: true },
      '/api': { target: 'http://127.0.0.1:8090', changeOrigin: true, xfwd: true },
      // AG-UI 标准协议端点 —— agent-core 的 POST /ag-ui（SSE）。
      '/ag-ui': { target: 'http://127.0.0.1:8090', changeOrigin: true, xfwd: true },
    },
  },
  /**
   * 生产预览（vite preview）与 server.proxy 同构。
   *
   * 控制台前端走**同源相对路径**请求后端（见 src/api.ts 的 GATEWAY_URL /
   * AGENT_URL），由这一层反代到网关与 Agent 内核。这样浏览器只与 5173 通信，
   * 控制台经公网 IP 访问时不必额外开放 8080 / 8090 ——
   * 外网暴露面只剩「控制台 5173 + Keycloak 8082」。
   *
   * `xfwd: true` 让 http-proxy 带上 `x-forwarded-host`（原始 Host）。
   * 必须保留 —— 否则反代会改写 Host 头，网关按 Host 生成 Keycloak 地址时
   * 会把公网访问者错误地指向 127.0.0.1。
   */
  preview: {
    port: 5173,
    host: true,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8080', changeOrigin: true, xfwd: true },
      '/api': { target: 'http://127.0.0.1:8090', changeOrigin: true, xfwd: true },
      // AG-UI 标准协议端点 —— 与 server.proxy 同构，同样反代到 agent-core。
      '/ag-ui': { target: 'http://127.0.0.1:8090', changeOrigin: true, xfwd: true },
    },
  },
  build: {
    outDir: '../../dist/webui',
    emptyOutDir: true,
    sourcemap: false,
  },
});
