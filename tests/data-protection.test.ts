import { describe, expect, it } from 'vitest';
import { SqliteMetadataStore, type AuditEvent, type Identity, type MetadataStore, type ObjectStore, type ToolSpec } from '@eap/platform-core';
import { GuardrailService } from '../packages/gateway/src/guardrails/index.js';
import { McpRegistry } from '../packages/gateway/src/mcp/registry.js';
import { AuditService, type AuditInput } from '../packages/gateway/src/audit/service.js';

const identity: Identity = {
  tenantId: 't-1',
  userId: 'u-1',
  role: 'employee',
  deptId: 'dept-general',
  sensitivity: 'internal',
  scopes: [],
  claims: {},
};

const tool: ToolSpec = {
  name: 'knowledge.search',
  description: 'search',
  inputSchema: { type: 'object' },
  serverId: 'knowledge',
  requiresConfirmation: false,
  sensitivity: 'internal',
};

describe('数据出口脱敏', () => {
  it('MCP 文本、结构化结果和审计参数均不泄露原文', async () => {
    let executedArgs: Record<string, unknown> = {};
    const audits: AuditInput[] = [];
    const clients = {
      listServers: () => [{ id: 'knowledge' }],
      listToolsCached: async () => [tool],
      callTool: async (_server: string, _tool: string, args: Record<string, unknown>) => {
        executedArgs = args;
        return {
          content: '联系电话 13812345678',
          structured: { hits: [{ content: '邮箱 user@example.com', phone: '13812345678' }] },
          isError: false,
        };
      },
    };
    const store = {
      getTenant: async () => ({ id: 't-1', models: [], tools: [], enabled: true }),
    } as unknown as MetadataStore;
    const registry = new McpRegistry(
      clients as never,
      store,
      { evaluate: () => ({ allowed: true, matched: [] }) } as never,
      new GuardrailService(),
      { record: async (input: AuditInput) => { audits.push(input); } } as never,
      { check: async () => ({ allowed: true, action: 'none' }) } as never,
    );

    const result = await registry.call({
      identity,
      serverId: 'knowledge',
      toolName: tool.name,
      args: { query: '联系 13812345678' },
      traceId: 'trace-1',
    });

    expect(executedArgs.query).toBe('联系 13812345678');
    expect(executedArgs.__ctx).toBeDefined();
    expect(result.content).not.toContain('13812345678');
    expect(JSON.stringify(result.structured)).not.toContain('13812345678');
    expect(JSON.stringify(result.structured)).not.toContain('user@example.com');
    expect(JSON.stringify(audits[0].detail)).not.toContain('13812345678');
    expect(JSON.stringify(audits[0].detail)).not.toContain('__ctx');
  });

  it('审计服务集中脱敏数据库与对象存储中的 detail', async () => {
    let saved: AuditEvent | undefined;
    let archived = '';
    const store = {
      appendAudit: async (event: AuditEvent) => { saved = event; },
    } as unknown as MetadataStore;
    const objects = {
      put: async (_key: string, body: string) => { archived = body; },
    } as unknown as ObjectStore;
    const service = new AuditService(store, objects, new GuardrailService());
    await service.record({
      kind: 'admin',
      identity,
      traceId: 'trace-2',
      status: 'ok',
      detail: { args: { phone: '13812345678', nested: ['user@example.com'] } },
    });
    expect(JSON.stringify(saved)).not.toContain('13812345678');
    expect(JSON.stringify(saved)).not.toContain('user@example.com');
    expect(archived).not.toContain('13812345678');
    expect(archived).not.toContain('user@example.com');
  });
});


describe('写工具审批与知识库租户条件', () => {
  it('直接调用写工具必须带匹配审批，审批消费后不能重放', async () => {
    const writeTool: ToolSpec = { ...tool, name: 'knowledge.upsert_document', requiresConfirmation: true };
    let calls = 0;
    const approval = {
      id: 'approval-1', tenantId: 't-1', userId: 'u-1', sessionId: 'session-1', traceId: 'trace-write',
      tool: writeTool.name, args: { id: 'doc-1', content: 'safe' }, reason: 'write', status: 'approved' as 'approved' | 'executed',
      createdAt: new Date().toISOString(),
    };
    const clients = {
      listServers: () => [{ id: 'knowledge' }],
      listToolsCached: async () => [writeTool],
      callTool: async () => ({ content: 'written', isError: false }),
    };
    const store = {
      getTenant: async () => ({ id: 't-1', models: [], tools: [], enabled: true }),
      getApproval: async () => approval,
      transitionApproval: async () => { approval.status = 'executed'; return true; },
    } as unknown as MetadataStore;
    const registry = new McpRegistry(
      clients as never,
      store,
      { evaluate: () => ({ allowed: true, matched: [] }) } as never,
      new GuardrailService(),
      { record: async () => undefined } as never,
      { check: async () => ({ allowed: true, action: 'none' }) } as never,
    );
    const input = {
      identity, serverId: 'knowledge', toolName: writeTool.name, args: approval.args,
      traceId: 'trace-write', sessionId: 'session-1',
    };
    const denied = await registry.call(input);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe('confirmation_required');
    expect(calls).toBe(0);

    clients.callTool = async () => { calls++; return { content: 'written', isError: false }; };
    const approved = await registry.call({ ...input, approvalId: approval.id });
    expect(approved.ok).toBe(true);
    expect(approval.status).toBe('executed');
    expect(calls).toBe(1);
    const replayed = await registry.call({ ...input, approvalId: approval.id });
    expect(replayed.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('知识库覆盖与删除都带租户条件', async () => {
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    const doc = {
      id: 'shared-id', deptId: 'd', title: 'tenant one', content: 'original', sensitivity: 'internal' as const,
      ownerId: 'u-1', updatedAt: new Date().toISOString(),
    };
    expect(await store.upsertKnowledgeDoc({ ...doc, tenantId: 't-1' })).toBe(true);
    expect(await store.upsertKnowledgeDoc({ ...doc, tenantId: 't-2', title: 'stolen' })).toBe(false);
    expect((await store.listKnowledgeDocs('t-1'))[0].title).toBe('tenant one');
    expect(await store.deleteKnowledgeDoc(doc.id, 't-2')).toBe(false);
    expect(await store.listKnowledgeDocs('t-1')).toHaveLength(1);
    expect(await store.deleteKnowledgeDoc(doc.id, 't-1')).toBe(true);
    await store.close();
  });
});
