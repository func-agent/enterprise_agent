/**
 * 策略引擎 —— 租户级 allow/deny 模型与工具（见 4.3「Cedar/CEL 策略」）。
 *
 * 语义对齐 Cedar：显式 deny 优先于 allow；无任何策略命中时按 defaultDecision 处理。
 * 匹配采用「主体 + 动作 + 资源」三元组，condition 为 CEL 表达式。
 */
import { readFileSync, existsSync } from 'node:fs';
import { config, createLogger } from '@eap/platform-core';
import type { Identity } from '@eap/platform-core';
import { CelEngine } from './cel.js';

const log = createLogger('gateway:policy');

export interface Policy {
  id: string;
  effect: 'allow' | 'deny';
  description?: string;
  principal?: {
    tenant?: string;
    role?: string;
    dept?: string;
    user?: string;
    /** 匹配任意角色列表 */
    roles?: string[];
  };
  action?: {
    /** llm | tool | admin */
    service?: string;
    /** chat | completions | call | list ... */
    operation?: string;
  };
  resource?: {
    model?: string;
    tool?: string;
    server?: string;
  };
  /** CEL 表达式 */
  condition?: string;
  enabled: boolean;
}

export interface PolicyContext {
  identity: Identity;
  service: string;
  operation: string;
  model?: string;
  tool?: string;
  server?: string;
  /**
   * 出网级别（见 8.1）：
   *   - `local`    —— 推理在内网/本机完成，数据不出域
   *   - `external` —— 推理在商业 API 完成，数据出网
   * 不传时按 `external` 处理（保守默认）。
   */
  egress?: 'local' | 'external';
}

export interface PolicyDecision {
  allowed: boolean;
  effect: 'allow' | 'deny' | 'default';
  matched: string[];
  reason: string;
}

export const DEFAULT_POLICIES: Policy[] = [
  {
    id: 'deny-confidential-egress',
    effect: 'deny',
    description: '涉密数据禁止通过商业模型出网（见 8.1 数据分级与路由）；本地推理（数据不出域）不受此限',
    action: { service: 'llm' },
    condition: "principal.sensitivity == 'confidential' && request.egress == 'external'",
    enabled: true,
  },
  {
    id: 'deny-write-tools-without-approval',
    effect: 'deny',
    description: '写类工具必须走 HITL 人工确认，不得自动执行',
    action: { service: 'tool' },
    condition: "request.tool != null && request.tool.startsWith('business.write')",
    enabled: false,
  },
  {
    id: 'allow-default-llm',
    effect: 'allow',
    description: '默认允许内部普通数据调用虚拟模型；涉密数据仅允许本地推理目标',
    action: { service: 'llm' },
    condition: "principal.sensitivity != 'confidential' || request.egress == 'local'",
    enabled: true,
  },
  {
    id: 'allow-default-tool',
    effect: 'allow',
    description: '默认允许调用白名单内工具',
    action: { service: 'tool' },
    enabled: true,
  },
  {
    id: 'allow-default-admin',
    effect: 'allow',
    description: '管理员操作默认放行（管理操作仍全量审计）',
    action: { service: 'admin' },
    condition: "principal.role == 'admin' || principal.role == 'platform-admin'",
    enabled: true,
  },
];

export class PolicyEngine {
  private policies: Policy[] = [];
  private readonly cel = new CelEngine();

  constructor() {
    this.policies = [...DEFAULT_POLICIES];
    this.loadFromFile();
  }

  private loadFromFile() {
    const file = config.policy.policyFile;
    if (!file) return;
    if (!existsSync(file)) {
      log.warn('策略文件不存在，使用内置默认策略', { file });
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { policies?: Policy[] };
      this.policies = [...DEFAULT_POLICIES, ...(raw.policies ?? [])];
      log.info('策略已加载', { file, count: this.policies.length });
    } catch (err) {
      log.error('策略文件解析失败，使用内置默认策略', { file, error: String(err) });
    }
  }

  list(): Policy[] {
    return this.policies;
  }

  replaceAll(policies: Policy[]) {
    this.policies = policies;
  }

  /** 判断某条策略的主体/动作/资源是否匹配 */
  private matches(p: Policy, ctx: PolicyContext): boolean {
    const { identity } = ctx;
    if (p.principal) {
      if (p.principal.tenant && p.principal.tenant !== identity.tenantId) return false;
      if (p.principal.role && p.principal.role !== identity.role) return false;
      if (p.principal.roles && !p.principal.roles.includes(identity.role)) return false;
      if (p.principal.dept && p.principal.dept !== identity.deptId) return false;
      if (p.principal.user && p.principal.user !== identity.userId) return false;
    }
    if (p.action) {
      if (p.action.service && p.action.service !== ctx.service) return false;
      if (p.action.operation && p.action.operation !== ctx.operation) return false;
    }
    if (p.resource) {
      if (p.resource.model && p.resource.model !== ctx.model) return false;
      if (p.resource.tool && p.resource.tool !== ctx.tool) return false;
      if (p.resource.server && p.resource.server !== ctx.server) return false;
    }
    if (p.condition) {
      const egress = ctx.egress ?? 'external';
      try {
        const ok = this.cel.evalBool(p.condition, {
          principal: {
            tenant: identity.tenantId,
            tenantId: identity.tenantId,
            user: identity.userId,
            userId: identity.userId,
            role: identity.role,
            dept: identity.deptId,
            deptId: identity.deptId,
            sensitivity: identity.sensitivity,
            scopes: identity.scopes,
          },
          request: {
            service: ctx.service,
            operation: ctx.operation,
            model: ctx.model ?? null,
            tool: ctx.tool ?? null,
            server: ctx.server ?? null,
            egress,
          },
          resource: {
            model: ctx.model ?? null,
            tool: ctx.tool ?? null,
            server: ctx.server ?? null,
            egress,
          },
        });
        if (!ok) return false;
      } catch (err) {
        // 条件求值失败 —— 保守处理：不命中
        log.error('策略条件求值失败，按不命中处理', { policy: p.id, error: String(err) });
        return false;
      }
    }
    return true;
  }

  evaluate(ctx: PolicyContext): PolicyDecision {
    const matchedAllow: string[] = [];
    const matchedDeny: string[] = [];
    const matchedAllowDesc: string[] = [];
    const matchedDenyDesc: string[] = [];

    for (const p of this.policies) {
      if (!p.enabled) continue;
      if (!this.matches(p, ctx)) continue;
      if (p.effect === 'deny') {
        matchedDeny.push(p.id);
        if (p.description) matchedDenyDesc.push(p.description);
      } else {
        matchedAllow.push(p.id);
        if (p.description) matchedAllowDesc.push(p.description);
      }
    }

    if (matchedDeny.length > 0) {
      return {
        allowed: false,
        effect: 'deny',
        matched: matchedDeny,
        reason: `命中 deny 策略：${matchedDeny.join(', ')}${
          matchedDenyDesc.length ? ` —— ${matchedDenyDesc.join('；')}` : ''
        }`,
      };
    }
    if (matchedAllow.length > 0) {
      return {
        allowed: true,
        effect: 'allow',
        matched: matchedAllow,
        reason: `命中 allow 策略：${matchedAllow.join(', ')}${
          matchedAllowDesc.length ? ` —— ${matchedAllowDesc.join('；')}` : ''
        }`,
      };
    }
    const allowed = config.policy.defaultDecision === 'permissive';
    return {
      allowed,
      effect: 'default',
      matched: [],
      reason: allowed
        ? '无策略命中，permissive 模式放行'
        : '无策略命中，enforce 模式默认拒绝',
    };
  }
}
