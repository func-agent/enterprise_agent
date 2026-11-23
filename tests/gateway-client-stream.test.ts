import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GatewayClient } from '../packages/agent-core/src/gateway-client.js';

describe('GatewayClient 流式错误处理', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      res.write('data: {"error":{"message":"upstream exploded","type":"provider_error"}}\n\n');
      res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('HTTP 200 中的 SSE error 帧会 reject 而不是返回空答案', async () => {
    const client = new GatewayClient(baseUrl);
    await expect(client.streamChat('token', {
      model: 'smart-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, () => undefined)).rejects.toThrow('upstream exploded');
  });
});
