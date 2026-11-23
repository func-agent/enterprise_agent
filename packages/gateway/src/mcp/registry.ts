/**
 * MCP 工具治理 —— 网关层核心职责（见 2.1 网关层：MCP 治理、工具白名单、租户隔离）。
 *
 * 治理链路（每次工具调用都走）：
 *   1) 工具目录按租户过滤（MCP Federation）
 *   2) 租户工具白名单校验
 *   3) 策略引擎评估（Cedar/CEL）
 *   4) 用户上下文透传（user_id/role/dept_id → MCP 层做行级过滤）
 *   5) Guardrails（注入检测 / 数据分级 / 脱敏）
 *   6) 预算预检
 *   7) 实际调用 MCP Server
 *   8) 返回值脱敏
 *   9) 审计（记录 user + tool + data_scope）
 */
import { createLogger, type Identity, type ToolSpec } from '@eap/platform-core';
import type { McpClientManager } from '@eap/mcp-hub';
import type { MetadataStore } from '@eap/platform-core';
import type { PolicyEngine } from '../policy/engine.js';
import type { GuardrailService } from '../guardrails/index.js';
import type { AuditService } from '../audit/service.js';
import type { BudgetService } from '../llm/budget.js';

const log = createLogger('gateway:mcp');

/** 入参脱敏（审计留痕用） */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === '__ctx') continue;
    out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface ToolCallOutcome {
  ok: boolean;
  content: string;
  structured?: unknown;
  isError?: boolean;
  reason?: string;
  traceId: string;
}

export class McpRegistry {
  constructor(
    private readonly clients: McpClientManager,
    private readonly store: MetadataStore,
    private readonly policy: PolicyEngine,
    private readonly guardrails: GuardrailService,
    private readonly audit: AuditService,
    private readonly budget: BudgetService,
  ) {}

  /** 全量工具目录 */
  async allTools(): Promise<ToolSpec[]> {
    const catalogs = await Promise.all(this.clients.listServers().map(async (s) => {
      try {
        return await this.clients.listToolsCached(s.id);
      } catch (err) {
        log.warn('MCP 工具目录拉取失败', { serverId: s.id, error: String(err) });
        return [];
      }
    }));
    return catalogs.flat();
  }

  /**
   * 按租户过滤的工具目录 —— MCP Federation（见 4.3）。
   * 租户工具白名单为空表示不限制；否则只下发白名单内工具。
   */
  async catalog(identity: Identity): Promise<ToolSpec[]> {
    const tenant = await this.store.getTenant(identity.tenantId);
    const all = await this.allTools();
    if (!tenant || !tenant.enabled) return [];
    if (tenant.tools.length === 0) return all;
    const allowed = new Set(tenant.tools);
    return all.filter((t) => allowed.has(t.name) || allowed.has(t.serverId));
  }

  /** 按名称查找工具 */
  async findTool(identity: Identity, serverId: string, toolName: string): Promise<ToolSpec | undefined> {
    const cat = await this.catalog(identity);
    return cat.find((t) => t.serverId === serverId && t.name === toolName);
  }

  /** 治理后的工具调用 */
  async call(params: {
    identity: Identity;
    serverId: string;
    toolName: string;
    args: Record<string, unknown>;
    traceId: string;
    approvalId?: string;
    sessionId?: string;
    appId?: string;
  }): Promise<ToolCallOutcome> {
    const { identity, serverId, toolName, traceId } = params;

    // —— 1/2) 目录过滤 + 白名单
    const spec = await this.findTool(identity, serverId, toolName);
    if (!spec) {
      await this.audit.record({
        kind: 'tool',
        identity,
        traceId,
        tool: toolName,
        serverId,
        status: 'blocked',
        reason: '工具不在该租户的白名单目录内',
        sessionId: params.sessionId,
        appId: params.appId,
      });
      return {
        ok: false,
        content: `工具 ${toolName} 不可用：不在租户 ${identity.tenantId} 的工具白名单内`,
        reason: 'tool_not_allowed',
        traceId,
      };
    }

    // —— 3) 策略
    // MCP Server 部署在域内（knowledge / chatbi / business），数据不出域（见 8.1）
    const decision = this.policy.evaluate({
      identity,
      service: 'tool',
      operation: 'call',
      tool: toolName,
      server: serverId,
      egress: 'local',
    });
    if (!decision.allowed) {
      await this.audit.record({
        kind: 'tool',
        identity,
        traceId,
        tool: toolName,
        serverId,
        status: 'blocked',
        reason: decision.reason,
        sessionId: params.sessionId,
        appId: params.appId,
        detail: { matchedPolicies: decision.matched, dataScope: spec.dataScope },
      });
      return { ok: false, content: decision.reason, reason: 'policy_denied', traceId };
    }

    // —— 5) Guardrails：入参检测 + 脱敏
    const argsText = JSON.stringify(params.args ?? {});
    const g = this.guardrails.apply({
      text: argsText,
      sensitivity: identity.sensitivity,
      egress: 'local',
    });
    if (g.blocked) {
      await this.audit.record({
        kind: 'tool',
        identity,
        traceId,
        tool: toolName,
        serverId,
        status: 'blocked',
        reason: g.reason,
        sessionId: params.sessionId,
        appId: params.appId,
        detail: { injectionSignals: g.injectionSignals },
      });
      return { ok: false, content: g.reason ?? '护栏拦截', reason: 'guardrail_blocked', traceId };
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(g.text) as Record<string, unknown>;
    } catch {
      args = params.args ?? {};
    }

    // —— 4) 上下文透传：MCP 层据此做行级 / 文档级过滤
    args.__ctx = {
      tenant_id: identity.tenantId,
      user_id: identity.userId,
      role: identity.role,
      dept_id: identity.deptId,
      sensitivity: identity.sensitivity,
    };

    // —— 6) 预算预检（应用级）
    const budgetDecision = await this.budget.check(identity, params.appId, 0);
    if (!budgetDecision.allowed) {
      await this.audit.record({
        kind: 'tool',
        identity,
        traceId,
        tool: toolName,
        serverId,
        status: 'blocked',
        reason: budgetDecision.reason,
        sessionId: params.sessionId,
        appId: params.appId,
      });
      return { ok: false, content: budgetDecision.reason ?? '预算超限', reason: 'budget_exceeded', traceId };
    }

    if (spec.requiresConfirmation) {
      const approval = params.approvalId ? await this.store.getApproval(params.approvalId) : undefined;
      const valid = approval &&
        approval.status === 'approved' &&
        approval.tenantId === identity.tenantId &&
        approval.userId === identity.userId &&
        approval.tool === toolName &&
        approval.sessionId === params.sessionId &&
        approval.traceId === traceId &&
        canonicalJson(approval.args) === canonicalJson(params.args ?? {});
      if (!valid) {
        await this.audit.record({
          kind: 'tool', identity, traceId, tool: toolName, serverId, status: 'blocked',
          reason: '写工具需要匹配的人工审批', sessionId: params.sessionId, appId: params.appId,
          detail: { approvalId: params.approvalId },
        });
        return {
          ok: false,
          content: `工具 ${toolName} 需要有效的人工审批，未执行`,
          reason: 'confirmation_required',
          traceId,
        };
      }
      const consumed = await this.store.transitionApproval(approval.id, identity.tenantId, 'approved', {
        status: 'executed',
      });
      if (!consumed) {
        return {
          ok: false,
          content: `审批 ${approval.id} 已被消费或状态已变化，未重复执行`,
          reason: 'approval_replayed',
          traceId,
        };
      }
    }

    // —— 7) 实际调用
    let result: { content: string; isError: boolean; structured?: unknown };
    try {
      result = await this.clients.callTool(serverId, toolName, args);
    } catch (err: any) {
      await this.audit.record({
        kind: 'tool',
        identity,
        traceId,
        tool: toolName,
        serverId,
        status: 'error',
        reason: err?.message ?? String(err),
        sessionId: params.sessionId,
        appId: params.appId,
        detail: { dataScope: spec.dataScope },
      });
      return {
        ok: false,
        content: `MCP 调用失败：${err?.message ?? err}`,
        reason: 'mcp_error',
        traceId,
      };
    }

    // —— 8) 返回值脱敏（文本与结构化字段使用同一规则）
    const masked = this.guardrails.maskOutput(result.content);
    const maskedStructured = this.guardrails.maskStructured(result.structured);

    // —— 9) 审计：记录 user + tool + data_scope
    await this.audit.record({
      kind: 'tool',
      identity,
      traceId,
      tool: toolName,
      serverId,
      status: result.isError ? 'error' : 'ok',
      sessionId: params.sessionId,
      appId: params.appId,
      detail: {
        dataScope: spec.dataScope,
        requiresConfirmation: spec.requiresConfirmation,
        sensitivity: spec.sensitivity,
        /** 入参（已脱敏） */
        args: this.guardrails.maskStructured(redactArgs(args)).value,
        /** 工具返回值（已脱敏） */
        toolOutput: masked.text,
        piiHits: [...masked.hits, ...maskedStructured.hits],
      },
    });

    return {
      ok: !result.isError,
      content: masked.text,
      structured: maskedStructured.value,
      isError: result.isError,
      traceId,
    };
  }
}
