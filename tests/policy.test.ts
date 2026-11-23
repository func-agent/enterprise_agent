/**
 * 策略引擎测试 —— 租户级 allow/deny 模型与工具（见 4.3 Cedar/CEL 策略）。
 */
import { describe, expect, it } from 'vitest';
import { PolicyEngine, type Policy } from '../packages/gateway/src/policy/engine.js';
import type { Identity } from '@eap/platform-core';

function identity(over: Partial<Identity> = {}): Identity {
  return {
    tenantId: 't-default',
    userId: 'u-1',
    role: 'employee',
    deptId: 'dept-general',
    sensitivity: 'internal',
    scopes: [],
    claims: {},
    ...over,
  };
}

describe('策略引擎默认策略', () => {
  const engine = new PolicyEngine();

  it('内部普通数据调用 LLM → 放行', () => {
    const d = engine.evaluate({ identity: identity(), service: 'llm', operation: 'chat', model: 'smart-model' });
    expect(d.allowed).toBe(true);
    expect(d.matched).toContain('allow-default-llm');
  });

  it('涉密数据调用 LLM → 拒绝（强制本地闭环）', () => {
    const d = engine.evaluate({
      identity: identity({ sensitivity: 'confidential' }),
      service: 'llm',
      operation: 'chat',
      model: 'smart-model',
    });
    expect(d.allowed).toBe(false);
    expect(d.effect).toBe('deny');
    expect(d.matched).toContain('deny-confidential-egress');
  });

  it('涉密数据调用本地推理（TEI）→ 放行（数据不出域，见 8.1）', () => {
    const d = engine.evaluate({
      identity: identity({ sensitivity: 'confidential' }),
      service: 'llm',
      operation: 'embed',
      model: 'embedding-model',
      egress: 'local',
    });
    expect(d.allowed).toBe(true);
    expect(d.matched).toContain('allow-default-llm');
    expect(d.matched).not.toContain('deny-confidential-egress');
  });

  it('涉密数据显式声明商业出网 → 拒绝', () => {
    const d = engine.evaluate({
      identity: identity({ sensitivity: 'confidential' }),
      service: 'llm',
      operation: 'chat',
      model: 'smart-model',
      egress: 'external',
    });
    expect(d.allowed).toBe(false);
    expect(d.matched).toContain('deny-confidential-egress');
  });

  it('普通数据走商业出网 → 放行', () => {
    const d = engine.evaluate({
      identity: identity({ sensitivity: 'internal' }),
      service: 'llm',
      operation: 'chat',
      model: 'smart-model',
      egress: 'external',
    });
    expect(d.allowed).toBe(true);
    expect(d.matched).toContain('allow-default-llm');
  });

  it('工具调用默认放行', () => {
    const d = engine.evaluate({
      identity: identity(),
      service: 'tool',
      operation: 'call',
      tool: 'knowledge.search',
      server: 'knowledge',
    });
    expect(d.allowed).toBe(true);
  });

  it('非管理员访问 admin 服务 → 默认拒绝', () => {
    const d = engine.evaluate({ identity: identity(), service: 'admin', operation: 'upsert' });
    expect(d.allowed).toBe(false);
    expect(d.effect).toBe('default');
  });

  it('管理员访问 admin 服务 → 放行', () => {
    const d = engine.evaluate({ identity: identity({ role: 'admin' }), service: 'admin', operation: 'upsert' });
    expect(d.allowed).toBe(true);
    expect(d.matched).toContain('allow-default-admin');
  });
});

describe('自定义策略', () => {
  it('显式 deny 优先于 allow', () => {
    const engine = new PolicyEngine();
    engine.replaceAll([
      { id: 'allow-all', effect: 'allow', action: { service: 'llm' }, enabled: true },
      {
        id: 'deny-expensive',
        effect: 'deny',
        action: { service: 'llm' },
        resource: { model: 'reasoning-model' },
        enabled: true,
      },
    ] as Policy[]);

    const allowed = engine.evaluate({
      identity: identity(),
      service: 'llm',
      operation: 'chat',
      model: 'smart-model',
    });
    expect(allowed.allowed).toBe(true);

    const denied = engine.evaluate({
      identity: identity(),
      service: 'llm',
      operation: 'chat',
      model: 'reasoning-model',
    });
    expect(denied.allowed).toBe(false);
    expect(denied.matched).toContain('deny-expensive');
  });

  it('按租户匹配', () => {
    const engine = new PolicyEngine();
    engine.replaceAll([
      {
        id: 'deny-other-tenant',
        effect: 'deny',
        principal: { tenant: 't-other' },
        action: { service: 'llm' },
        enabled: true,
      },
      { id: 'allow-llm', effect: 'allow', action: { service: 'llm' }, enabled: true },
    ] as Policy[]);

    const d = engine.evaluate({
      identity: identity({ tenantId: 't-other' }),
      service: 'llm',
      operation: 'chat',
    });
    expect(d.allowed).toBe(false);
  });

  it('按角色匹配', () => {
    const engine = new PolicyEngine();
    engine.replaceAll([
      {
        id: 'deny-employee',
        effect: 'deny',
        principal: { roles: ['employee'] },
        action: { service: 'tool' },
        enabled: true,
      },
    ] as Policy[]);
    const d = engine.evaluate({ identity: identity(), service: 'tool', operation: 'call' });
    expect(d.allowed).toBe(false);
  });

  it('条件表达式生效', () => {
    const engine = new PolicyEngine();
    engine.replaceAll([
      { id: 'allow-tool', effect: 'allow', action: { service: 'tool' }, enabled: true },
      {
        id: 'deny-write-tools',
        effect: 'deny',
        action: { service: 'tool' },
        condition: "request.tool.startsWith('business.write')",
        enabled: true,
      },
    ] as Policy[]);

    const denied = engine.evaluate({
      identity: identity(),
      service: 'tool',
      operation: 'call',
      tool: 'business.write.submit_expense',
    });
    expect(denied.allowed).toBe(false);

    const allowed = engine.evaluate({
      identity: identity(),
      service: 'tool',
      operation: 'call',
      tool: 'knowledge.search',
    });
    expect(allowed.allowed).toBe(true);
  });

  it('禁用的策略不参与匹配', () => {
    const engine = new PolicyEngine();
    engine.replaceAll([
      { id: 'deny-off', effect: 'deny', action: { service: 'llm' }, enabled: false },
    ] as Policy[]);
    const d = engine.evaluate({ identity: identity(), service: 'llm', operation: 'chat' });
    expect(d.allowed).toBe(false); // enforce 模式无 allow 命中 → 默认拒绝
    expect(d.effect).toBe('default');
  });
});
