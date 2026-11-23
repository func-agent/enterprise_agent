/**
 * MCP 入参 schema 透传测试（回归守卫）。
 *
 * 背景：网关在调用 MCP 工具前会往参数里注入 `__ctx`（调用者身份：
 * 租户 / 部门 / 密级 / 角色），MCP 层靠它做「召回前过滤」。
 * MCP SDK 在调用前按 inputSchema 做一次 zod 校验，而 zod 对未声明的键
 * 默认 **strip（删掉）** —— 一旦 `__ctx` 被剥掉，检索就会退化成按
 * 「固定默认身份」过滤，部门与密级隔离形同虚设。
 *
 * 因此这里必须端到端验证：**经真实 MCP HTTP Server 调一次**，
 * `__ctx` 仍然能到达工具处理函数。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SqliteMetadataStore } from '@eap/platform-core';
import { startMcpHttpServer } from '../packages/mcp-hub/src/server-base.js';
import { createKnowledgeTools } from '../packages/mcp-hub/src/servers/knowledge.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

describe('MCP 入参 schema 透传', () => {
  let store: SqliteMetadataStore;
  let close: (() => Promise<void>) | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    store = new SqliteMetadataStore(':memory:');
    await store.init();
    for (const d of [
      { id: 'd-east', deptId: 'dept-east', sensitivity: 'confidential' as const, title: '华东区采购框架协议', content: '采购总额不超过 1200 万元，违约金为合同金额的 3%。' },
      { id: 'd-west', deptId: 'dept-west', sensitivity: 'internal' as const, title: '西区差旅标准补充', content: '西区出差住宿标准另行调整。' },
    ]) {
      await store.upsertKnowledgeDoc({
        ...d,
        tenantId: 't-1',
        ownerId: 'owner',
        updatedAt: new Date().toISOString(),
      });
    }
  });

  afterEach(async () => {
    await close?.();
    await store.close();
  });

  it('经真实 MCP 服务调用时 __ctx 不被 zod 校验剥离', async () => {
    const handle = await startMcpHttpServer({
      name: 'test-knowledge',
      version: '1.0.0',
      port: 0,
      host: '127.0.0.1',
      tools: createKnowledgeTools(store),
    });
    close = async () => {
      await new Promise<void>((r) => handle.close(() => r()));
    };
    const port = (handle.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/mcp`;

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));

    try {
      // 调用者是「东区 + confidential」身份 —— 只有 __ctx 完整传下去才会命中 d-east
      const res: any = await client.callTool({
        name: 'knowledge.search',
        arguments: {
          query: '采购框架协议 违约金',
          topK: 10,
          __ctx: {
            tenant_id: 't-1',
            user_id: 'u-1',
            role: 'employee',
            dept_id: 'dept-east',
            sensitivity: 'confidential',
          },
        },
      });
      const hits = res.structuredContent?.hits ?? [];
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.map((h: any) => h.docId)).toContain('d-east');

      // 反之：西区文档对东区身份不可见 —— 证明 dept 过滤也按调用者身份生效
      expect(hits.map((h: any) => h.docId)).not.toContain('d-west');
    } finally {
      await client.close();
    }
  });

  it('__ctx 缺失时按最小权限处理（查不到任何文档）', async () => {
    const tools = createKnowledgeTools(store);
    const tool = tools.find((t) => t.name === 'knowledge.search')!;
    // 不传 __ctx —— 兜底必须是「什么都查不到」，而不是退回宽松的固定身份
    const out = (await tool.handler({ query: '采购框架协议 违约金', topK: 10 })) as any;
    expect(out.structuredContent.count).toBe(0);
  });
});
