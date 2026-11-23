/**
 * 出网代理测试（见 8.3 出网安全 / 9.3 网络要求）
 *
 * 要守住的三条：
 *  1) 配置了出网代理 → 请求必须走代理，不得直连目标
 *  2) 代理不可用 → **失败关闭**（抛错），绝不静默回落成直连
 *  3) 生产环境漏配代理 → 启动即拒绝
 *
 * 这里用两个本地 http server 模拟「目标服务」和「出网代理」，
 * 不依赖外网，结果稳定可复现。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
// 与被测模块同源：egress.ts 通过 '@eap/platform-core' 取 config，
// 这里也必须用包名引入，否则改的是另一份 config 对象，断言不生效
import { config } from '@eap/platform-core';
import { egressFetch, assertEgressProxyConfigured } from '../packages/gateway/src/llm/egress.js';

/** 监听一个随机端口的 http server */
async function listen(handler: (req: any, res: any) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

/** 找一个确定没人在监听的端口 */
async function closedPort(): Promise<number> {
  const { server, port } = await listen((_req, res) => res.end('x'));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const originalProxy = config.gateway.egressProxyUrl;
let servers: Server[] = [];

beforeEach(() => {
  servers = [];
});

afterEach(async () => {
  config.gateway.egressProxyUrl = originalProxy;
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  servers = [];
});

describe('出网代理 egressFetch', () => {
  it('未配置代理时直连目标（本地开发形态）', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('direct');
    });
    servers.push(server);
    config.gateway.egressProxyUrl = '';

    const res = await egressFetch(`http://127.0.0.1:${port}/hello`);
    expect(await res.text()).toBe('direct');
  });

  it('配置代理后请求打在代理上，而不是直连目标', async () => {
    // 目标服务：直接访问会返回 direct
    const target = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('direct');
    });
    servers.push(target.server);

    // 出网代理：收到 absolute-form 请求（即走了正向代理）返回 via-proxy
    const proxy = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`via-proxy:${req.url}`);
    });
    servers.push(proxy.server);

    config.gateway.egressProxyUrl = `http://127.0.0.1:${proxy.port}`;

    const res = await egressFetch(`http://127.0.0.1:${target.port}/hello`);
    const body = await res.text();
    expect(body.startsWith('via-proxy')).toBe(true);
    expect(body).not.toContain('direct');
  });

  it('代理不可用时失败关闭，绝不静默回落直连', async () => {
    const target = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('direct');
    });
    servers.push(target.server);

    config.gateway.egressProxyUrl = `http://127.0.0.1:${await closedPort()}`;

    // 代理不可达 → 必须抛错；直连成功说明回落了，是安全缺陷
    await expect(egressFetch(`http://127.0.0.1:${target.port}/hello`)).rejects.toThrow();
  });
});

describe('出网代理启动守卫 assertEgressProxyConfigured', () => {
  it('本地/开发环境不要求代理', () => {
    config.gateway.egressProxyUrl = '';
    expect(() => assertEgressProxyConfigured('local')).not.toThrow();
    expect(() => assertEgressProxyConfigured('dev')).not.toThrow();
  });

  it('生产环境漏配代理时拒绝启动', () => {
    config.gateway.egressProxyUrl = '';
    expect(() => assertEgressProxyConfigured('production')).toThrow(/出网代理/);
  });

  it('生产环境配置了代理则放行', () => {
    config.gateway.egressProxyUrl = 'http://127.0.0.1:15000';
    expect(() => assertEgressProxyConfigured('production')).not.toThrow();
  });
});
