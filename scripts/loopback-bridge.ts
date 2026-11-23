/**
 * 回环桥 —— 把 docker 网桥地址上的请求转发到宿主机的 127.0.0.1。
 *
 * 为什么需要：
 *   平台服务（网关 8080 / Agent 8090 / MCP Hub 8091-8093）以宿主进程方式运行时，
 *   为避免暴露在局域网/公网，绑定到 127.0.0.1。
 *   但容器（DB-GPT）需要回调宿主的网关与 MCP Server，
 *   而容器只能通过 docker 网桥地址 172.17.0.1（host.docker.internal）访问宿主，
 *   **访问不到宿主的 loopback**。
 *
 *   本进程在 172.17.0.1 上监听若干端口，逐字节转发到 127.0.0.1 同端口：
 *     · 只有本机与本机上的容器能连上（172.17.0.1 是本地网桥地址，不对外路由）
 *     · 局域网与公网依然访问不到
 *   这样既满足「只允许本机访问」的收口要求，又不打断容器回调链路。
 *
 * 默认转发端口：8080（网关）、8090（Agent）、8091/8092/8093（MCP Server）。
 * 可用 LOOPBACK_BRIDGE_PORTS 覆盖，LOOPBACK_BRIDGE_BIND 覆盖监听地址。
 */
import net from 'node:net';

const DEFAULT_PORTS = [8080, 8090, 8091, 8092, 8093];
const BIND = process.env.LOOPBACK_BRIDGE_BIND ?? '172.17.0.1';
const TARGET = '127.0.0.1';

function ports(): number[] {
  const raw = process.env.LOOPBACK_BRIDGE_PORTS;
  if (!raw) return DEFAULT_PORTS;
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}

function log(level: 'info' | 'warn', message: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, scope: 'loopback-bridge', message, ...extra })}\n`,
  );
}

const servers: net.Server[] = [];

for (const port of ports()) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: TARGET, port });
    upstream.on('connect', () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    const drop = (who: string) => (err?: Error) => {
      log('warn', '连接中断', { port, who, error: err ? String(err.message ?? err) : 'closed' });
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop('client'));
    upstream.on('error', drop('upstream'));
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log('warn', '端口已被占用，跳过', { port, bind: BIND });
    } else {
      log('warn', '监听失败', { port, bind: BIND, error: String(err.message ?? err) });
    }
  });

  server.listen(port, BIND, () => {
    log('info', '回环桥已监听', { port, bind: BIND, target: `${TARGET}:${port}` });
  });
  servers.push(server);
}

const shutdown = (): void => {
  for (const s of servers) s.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
