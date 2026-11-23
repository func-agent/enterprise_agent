/**
 * 三级预算与配额测试（见 4.3 预算与配额三级体系）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SqliteMetadataStore, monthKey, type Identity } from '@eap/platform-core';
import { BudgetService } from '../packages/gateway/src/llm/budget.js';

const identity: Identity = {
  tenantId: 't-test',
  userId: 'u-1',
  role: 'employee',
  deptId: 'dept-general',
  sensitivity: 'internal',
  scopes: [],
  claims: {},
};

async function freshStore(): Promise<SqliteMetadataStore> {
  const store = new SqliteMetadataStore(':memory:');
  await store.init();
  await store.upsertTenant({
    id: 't-test',
    name: '测试租户',
    models: [],
    tools: [],
    knowledgeBases: [],
    monthlyBudgetUsd: 0,
    monthlyTokenBudget: 0,
    enabled: true,
  });
  return store;
}

describe('预算三级体系', () => {
  let store: SqliteMetadataStore;
  let budget: BudgetService;

  beforeEach(async () => {
    store = await freshStore();
    budget = new BudgetService(store);
  });

  it('初始状态放行', async () => {
    const d = await budget.check(identity);
    expect(d.allowed).toBe(true);
    expect(d.action).toBe('none');
  });

  it('记账同时写入平台/租户/应用三级', async () => {
    await budget.record(identity, 'app-1', 'MiniMax-M3.1-Flash', 100, 50, 0.01);
    const month = monthKey();
    const platform = await store.getUsage('platform', 'eap-main', month);
    const tenant = await store.getUsage('tenant', 't-test', month);
    const app = await store.getUsage('app', 'app-1', month);
    expect(platform.costUsd).toBeCloseTo(0.01);
    expect(tenant.costUsd).toBeCloseTo(0.01);
    expect(app.costUsd).toBeCloseTo(0.01);
    expect(platform.requests).toBe(1);
  });

  it('租户超限熔断', async () => {
    await store.upsertTenant({
      id: 't-test',
      name: '测试租户',
      models: [],
      tools: [],
      knowledgeBases: [],
      monthlyBudgetUsd: 0.01,
      monthlyTokenBudget: 0,
      enabled: true,
    });
    await budget.record(identity, undefined, 'MiniMax-M3.1-Flash', 0, 0, 0.05);

    const d = await budget.check(identity);
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('tenant');
    expect(d.action).toBe('circuit_break');
    expect(d.reason).toContain('租户');
  });

  it('租户 Token 预算同样触发熔断', async () => {
    await store.upsertTenant({
      id: 't-test',
      name: '测试租户',
      models: [],
      tools: [],
      knowledgeBases: [],
      monthlyBudgetUsd: 0,
      monthlyTokenBudget: 100,
      enabled: true,
    });
    await budget.record(identity, undefined, 'MiniMax-M3.1-Flash', 200, 0, 0);
    const d = await budget.check(identity);
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('tenant');
  });

  it('平台级超限只告警不熔断', async () => {
    // 直接把平台用量推到超限
    await store.addUsage({
      scope: 'platform',
      scopeId: 'eap-main',
      month: monthKey(),
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 10_000_000,
      requests: 1,
    });
    const d = await budget.check(identity);
    expect(d.allowed).toBe(true);
    expect(d.action).toBe('alert');
    expect(d.scope).toBe('platform');
  });

  it('应用级单请求 Token 上限触发限流', async () => {
    await store.upsertApplication({
      id: 'app-1',
      tenantId: 't-test',
      name: '测试应用',
      qpsLimit: 100,
      perRequestTokenLimit: 1000,
      monthlyBudgetUsd: 10,
      enabled: true,
    });
    const d = await budget.check(identity, 'app-1', 5000);
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('app');
    expect(d.action).toBe('throttle');
  });

  it('应用级 QPS 超限触发限流', async () => {
    await store.upsertApplication({
      id: 'app-qps',
      tenantId: 't-test',
      name: '限流应用',
      qpsLimit: 2,
      perRequestTokenLimit: 0,
      monthlyBudgetUsd: 10,
      enabled: true,
    });
    expect((await budget.check(identity, 'app-qps')).allowed).toBe(true);
    expect((await budget.check(identity, 'app-qps')).allowed).toBe(true);
    const third = await budget.check(identity, 'app-qps');
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain('QPS');
  });

  it('禁用租户和未知应用默认拒绝', async () => {
    const tenant = await store.getTenant('t-test');
    await store.upsertTenant({ ...tenant!, enabled: false });
    expect((await budget.check(identity)).allowed).toBe(false);
    await store.upsertTenant({ ...tenant!, enabled: true });
    const unknownApp = await budget.check(identity, 'missing-app');
    expect(unknownApp.allowed).toBe(false);
    expect(unknownApp.scope).toBe('app');
  });

  it('平台告警不会跳过租户硬熔断', async () => {
    const tenant = await store.getTenant('t-test');
    await store.upsertTenant({ ...tenant!, monthlyBudgetUsd: 0.01 });
    await store.addUsage({ scope: 'platform', scopeId: 'eap-main', month: monthKey(), promptTokens: 0, completionTokens: 0, costUsd: 10_000, requests: 1 });
    await store.addUsage({ scope: 'tenant', scopeId: 't-test', month: monthKey(), promptTokens: 0, completionTokens: 0, costUsd: 1, requests: 1 });
    const decision = await budget.check(identity);
    expect(decision.allowed).toBe(false);
    expect(decision.scope).toBe('tenant');
  });

  it('应用月度预算硬上限生效', async () => {
    await store.upsertApplication({ id: 'app-budget', tenantId: 't-test', name: '预算应用', qpsLimit: 0, perRequestTokenLimit: 0, monthlyBudgetUsd: 0.01, enabled: true });
    await store.addUsage({ scope: 'app', scopeId: 'app-budget', month: monthKey(), promptTokens: 0, completionTokens: 0, costUsd: 0.02, requests: 1 });
    const decision = await budget.check(identity, 'app-budget');
    expect(decision.allowed).toBe(false);
    expect(decision.scope).toBe('app');
  });

  it('预算看板汇总租户用量', async () => {
    await store.upsertTenant({
      id: 't-test',
      name: '测试租户',
      models: [],
      tools: [],
      knowledgeBases: [],
      monthlyBudgetUsd: 100,
      monthlyTokenBudget: 0,
      enabled: true,
    });
    await budget.record(identity, undefined, 'MiniMax-M3.1-Flash', 1000, 500, 1.5);
    const summary = await budget.summary();
    expect(summary.month).toBe(monthKey());
    const row = summary.tenants.find((t) => t.tenantId === 't-test');
    expect(row?.usedUsd).toBeCloseTo(1.5);
    expect(row?.ratio).toBeCloseTo(0.015);
  });
});
