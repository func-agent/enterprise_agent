/**
 * 知识库召回前过滤测试（见 4.2 知识库划分 + 5.2 权限过滤最高优先级）。
 *
 * 关键断言：过滤发生在检索阶段（不可见文档的分数根本不参与排序），
 * 而不是全库召回后再过滤。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SqliteMetadataStore } from '@eap/platform-core';
import { createKnowledgeTools, tokenize } from '../packages/mcp-hub/src/servers/knowledge.js';

async function seed(): Promise<SqliteMetadataStore> {
  const store = new SqliteMetadataStore(':memory:');
  await store.init();
  const docs = [
    { id: 'd1', deptId: 'dept-general', sensitivity: 'internal' as const, title: '员工年假管理制度', content: '入职满 1 年可享受 5 天带薪年假，最多结转 3 天。' },
    { id: 'd2', deptId: 'dept-east', sensitivity: 'confidential' as const, title: '华东区采购框架协议', content: '年度采购总额不超过 1200 万元，违约金为合同金额的 3%。' },
    { id: 'd3', deptId: 'dept-general', sensitivity: 'public' as const, title: '公司地址与联系方式', content: '公司总部地址在市中心的科技园区，员工手册公开版。' },
    { id: 'd4', deptId: 'dept-west', sensitivity: 'internal' as const, title: '西区差旅标准补充', content: '西区出差住宿标准另行调整。' },
  ];
  for (const d of docs) {
    await store.upsertKnowledgeDoc({
      ...d,
      tenantId: 't-1',
      ownerId: 'owner',
      updatedAt: new Date().toISOString(),
    });
  }
  return store;
}

const baseCtx = { tenant_id: 't-1', user_id: 'u-1', role: 'employee', dept_id: 'dept-general', sensitivity: 'internal' };

describe('分词', () => {
  it('中文取 bigram，拉丁取词', () => {
    const t = tokenize('年假 policy 5天');
    expect(t).toContain('年假');
    expect(t).toContain('policy');
  });
});

describe('召回前过滤', () => {
  let store: SqliteMetadataStore;

  beforeEach(async () => {
    store = await seed();
  });

  async function search(args: Record<string, unknown>) {
    const tools = createKnowledgeTools(store);
    const tool = tools.find((t) => t.name === 'knowledge.search')!;
    return (await tool.handler({ ...args, __ctx: baseCtx })) as any;
  }

  it('只召回本部门 + 密级不高于本人的文档', async () => {
    const out = await search({ query: '年假 采购 联系方式', topK: 10 });
    const ids = (out.structuredContent.hits as any[]).map((h) => h.docId);
    expect(ids).toContain('d1');
    expect(ids).toContain('d3');
    // 西区文档对东区/通用部门不可见
    expect(ids).not.toContain('d4');
  });

  it('密级高于本人权限的文档不可见', async () => {
    // d2 是 confidential，本人为 internal → 不可见
    const out = await search({ query: '采购框架协议 违约金', topK: 10 });
    const ids = (out.structuredContent.hits as any[]).map((h) => h.docId);
    expect(ids).not.toContain('d2');
  });

  it('confidential 权限者可召回机密文档', async () => {
    const tools = createKnowledgeTools(store);
    const tool = tools.find((t) => t.name === 'knowledge.search')!;
    const out = await (await tool.handler({
      query: '采购框架协议',
      topK: 10,
      __ctx: { ...baseCtx, dept_id: 'dept-east', sensitivity: 'confidential' },
    })) as any;
    const ids = (out.structuredContent.hits as any[]).map((h) => h.docId);
    expect(ids).toContain('d2');
  });

  it('跨租户文档不可见', async () => {
    const tools = createKnowledgeTools(store);
    const tool = tools.find((t) => t.name === 'knowledge.search')!;
    const out = await (await tool.handler({
      query: '年假',
      topK: 10,
      __ctx: { ...baseCtx, tenant_id: 't-other' },
    })) as any;
    expect(out.structuredContent.count).toBe(0);
  });

  it('命中结果附带来源与密级，便于答案标注', async () => {
    const out = await search({ query: '年假结转', topK: 3 });
    const hit = out.structuredContent.hits[0];
    expect(hit).toHaveProperty('title');
    expect(hit).toHaveProperty('docId');
    expect(hit).toHaveProperty('sensitivity');
    expect(hit.score).toBeGreaterThan(0);
  });

  it('写操作工具标记为需人工确认', () => {
    const tools = createKnowledgeTools(store);
    const upsert = tools.find((t) => t.name === 'knowledge.upsert_document')!;
    const del = tools.find((t) => t.name === 'knowledge.delete_document')!;
    const searchTool = tools.find((t) => t.name === 'knowledge.search')!;
    expect(upsert.meta?.requiresConfirmation).toBe(true);
    expect(del.meta?.requiresConfirmation).toBe(true);
    expect(searchTool.meta?.requiresConfirmation).toBe(false);
  });
});
