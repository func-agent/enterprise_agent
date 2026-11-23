/**
 * MCP 客户端「会话失效自动重连」测试。
 *
 * 背景（实测踩坑）：MCP Server 重启后，旧 session id 立即失效，
 * 服务端返回 `{"code":-32600,"message":"Session not found"}`。
 * 客户端若继续复用缓存的 transport，后续所有调用都会持续失败 ——
 * 表现为工具目录整个拉不到（网关日志里是一条条
 * "MCP 工具目录拉取失败 … Session not found"）。
 *
 * 正确行为：识别这类错误 → 丢弃缓存连接 → 重连一次 → 重试。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  connectCount: 0,
  listToolsCalls: 0,
  /** 下一次 listTools 要抛出的错误（null = 不抛） */
  nextListToolsError: null as Error | null,
  callToolCalls: 0,
  closedTransports: 0,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class FakeClient {
    async connect(): Promise<void> {
      state.connectCount += 1;
    }

    async listTools(): Promise<any> {
      state.listToolsCalls += 1;
      if (state.nextListToolsError) {
        const err = state.nextListToolsError;
        state.nextListToolsError = null;
        throw err;
      }
      return {
        tools: [
          {
            name: 'chatbi.query',
            description: '自然语言查数',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    }

    async callTool(): Promise<any> {
      state.callToolCalls += 1;
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  }
  return { Client: FakeClient };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class FakeTransport {
    async close(): Promise<void> {
      state.closedTransports += 1;
    }
  }
  return { StreamableHTTPClientTransport: FakeTransport };
});

import { McpClientManager } from '../packages/mcp-hub/src/client.js';

const SERVERS = [{ id: 'chatbi', url: 'http://127.0.0.1:8097/mcp' }];

describe('MCP 客户端会话失效处理', () => {
  beforeEach(() => {
    state.connectCount = 0;
    state.listToolsCalls = 0;
    state.callToolCalls = 0;
    state.closedTransports = 0;
    state.nextListToolsError = null;
  });

  it('会话失效时丢弃连接并重连一次', async () => {
    const mgr = new McpClientManager(SERVERS);
    state.nextListToolsError = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: ' +
        '{"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}',
    );
    const tools = await mgr.listTools('chatbi');

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('chatbi.query');
    expect(tools[0].serverId).toBe('chatbi');
    // 首次拉取失败 → 重连 → 成功
    expect(state.listToolsCalls).toBe(2);
    expect(state.connectCount).toBe(2);
    // 旧连接被显式关闭
    expect(state.closedTransports).toBe(1);
  });

  it('非会话类错误原样抛出，不触发重连', async () => {
    const mgr = new McpClientManager(SERVERS);
    // 先让一次调用成功，建立连接
    await mgr.listTools('chatbi');
    const connectsAfterFirst = state.connectCount;

    // 下一次抛一个与 session 无关的传输层错误
    state.nextListToolsError = new Error('connect ECONNREFUSED 127.0.0.1:8097');
    await expect(mgr.listTools('chatbi')).rejects.toThrow('ECONNREFUSED');

    // 不应重连（连接数不变），也不应关闭旧连接
    expect(state.connectCount).toBe(connectsAfterFirst);
    expect(state.closedTransports).toBe(0);
  });

  it('工具调用同样具备会话失效自愈能力', async () => {
    const mgr = new McpClientManager(SERVERS);
    // 建立连接（此次 listTools 成功）
    await mgr.listTools('chatbi');
    const res = await mgr.callTool('chatbi', 'chatbi.query', { question: 'x' });
    expect(res.content).toBe('ok');
    expect(res.isError).toBe(false);
  });
});
