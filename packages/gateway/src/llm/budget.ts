/**
 * 三级预算与配额体系（见 4.3 预算与配额三级体系）：
 *
 *   平台级 —— 全平台月度 Token/金额上限；超限告警，不熔断
 *   租户级 —— 每租户月度预算硬上限；超限熔断，次月恢复
 *   应用级 —— 单应用 QPS / 单请求 Token 上限；超限限流
 */
import { config, monthKey } from '@eap/platform-core';
import type { Identity, UsageRecord } from '@eap/platform-core';
import type { MetadataStore } from '@eap/platform-core';
import type { Cache } from '@eap/platform-core';

export interface BudgetDecision {
  allowed: boolean;
  /** 触发的动作 */
  action: 'none' | 'alert' | 'throttle' | 'circuit_break';
  scope?: 'platform' | 'tenant' | 'app';
  reason?: string;
  usage?: UsageRecord;
}

export class BudgetService {
  /** 应用级 QPS 滑窗 —— 进程内降级用；生产走共享缓存以保证多副本计数准确 */
  private qpsWindows = new Map<string, number[]>();

  constructor(
    private readonly store: MetadataStore,
    private readonly cache?: Cache,
  ) {}

  /**
   * 应用级 QPS 判定。
   * 有共享缓存时用原子 INCR + TTL（跨副本准确）；否则退回进程内滑窗。
   */
  private async checkQps(appId: string, limit: number): Promise<{ allowed: boolean; reason?: string }> {
    if (this.cache) {
      const key = `eap:qps:${appId}`;
      const n = await this.cache.incr(key, 1);
      if (n > limit) {
        return { allowed: false, reason: `应用 ${appId} QPS 超限（${limit}/s），已限流` };
      }
      return { allowed: true };
    }
    const now = Date.now();
    const win = (this.qpsWindows.get(appId) ?? []).filter((t) => now - t < 1000);
    if (win.length >= limit) {
      this.qpsWindows.set(appId, win);
      return { allowed: false, reason: `应用 ${appId} QPS 超限（${limit}/s），已限流` };
    }
    win.push(now);
    this.qpsWindows.set(appId, win);
    return { allowed: true };
  }

  /**
   * 预检：在调用模型前判断是否放行。
   * 顺序：平台级 → 租户级 → 应用级。
   */
  async check(identity: Identity, appId?: string, estimatedTokens = 0): Promise<BudgetDecision> {
    const month = monthKey();
    let alert: BudgetDecision | undefined;

    const platformUsage = await this.store.getUsage('platform', config.platformId, month);
    const platformOver =
      platformUsage.costUsd >= config.budget.platformMonthlyUsd ||
      platformUsage.promptTokens + platformUsage.completionTokens >= config.budget.platformMonthlyTokens;
    if (platformOver) {
      alert = {
        allowed: true,
        action: 'alert',
        scope: 'platform',
        reason: `平台级月度预算超限（已用 $${platformUsage.costUsd.toFixed(4)} / 上限 $${config.budget.platformMonthlyUsd}），仅告警不熔断`,
        usage: platformUsage,
      };
    }

    const tenant = await this.store.getTenant(identity.tenantId);
    if (!tenant || !tenant.enabled) {
      return {
        allowed: false,
        action: 'circuit_break',
        scope: 'tenant',
        reason: `租户 ${identity.tenantId} 不存在或已禁用`,
      };
    }
    const tenantUsage = await this.store.getUsage('tenant', tenant.id, month);
    const overCost = tenant.monthlyBudgetUsd > 0 && tenantUsage.costUsd >= tenant.monthlyBudgetUsd;
    const overToken =
      tenant.monthlyTokenBudget > 0 &&
      tenantUsage.promptTokens + tenantUsage.completionTokens >= tenant.monthlyTokenBudget;
    if (overCost || overToken) {
      const action = config.budget.tenantOverrunAction === 'alert' ? 'alert' : 'circuit_break';
      return {
        allowed: action === 'alert',
        action,
        scope: 'tenant',
        reason: `租户 ${tenant.id} 月度预算超限（已用 $${tenantUsage.costUsd.toFixed(4)} / 上限 $${tenant.monthlyBudgetUsd}）`,
        usage: tenantUsage,
      };
    }

    if (appId) {
      const app = (await this.store.listApplications(identity.tenantId)).find((a) => a.id === appId);
      if (!app || !app.enabled) {
        return {
          allowed: false,
          action: 'circuit_break',
          scope: 'app',
          reason: `应用 ${appId} 不存在或已禁用`,
        };
      }
      const appUsage = await this.store.getUsage('app', app.id, month);
      if (app.monthlyBudgetUsd > 0 && appUsage.costUsd >= app.monthlyBudgetUsd) {
        return {
          allowed: false,
          action: 'circuit_break',
          scope: 'app',
          reason: `应用 ${appId} 月度预算超限（已用 $${appUsage.costUsd.toFixed(4)} / 上限 $${app.monthlyBudgetUsd}）`,
          usage: appUsage,
        };
      }
      if (app.qpsLimit > 0) {
        const qps = await this.checkQps(appId, app.qpsLimit);
        if (!qps.allowed) {
          return { allowed: false, action: 'throttle', scope: 'app', reason: qps.reason };
        }
      }
      if (app.perRequestTokenLimit > 0 && estimatedTokens > app.perRequestTokenLimit) {
        return {
          allowed: false,
          action: 'throttle',
          scope: 'app',
          reason: `应用 ${appId} 单请求 Token 上限 ${app.perRequestTokenLimit}，本次预估 ${estimatedTokens}`,
        };
      }
    }

    return alert ?? { allowed: true, action: 'none' };
  }

  /** 记账：同时写入平台 / 租户 / 应用三级用量 */
  async record(
    identity: Identity,
    appId: string | undefined,
    model: string,
    promptTokens: number,
    completionTokens: number,
    costUsd: number,
  ): Promise<void> {
    const month = monthKey();
    const scopes: UsageRecord[] = [
      { scope: 'platform', scopeId: config.platformId, month, promptTokens, completionTokens, costUsd, requests: 1 },
      { scope: 'tenant', scopeId: identity.tenantId, month, promptTokens, completionTokens, costUsd, requests: 1 },
    ];
    if (appId) {
      scopes.push({ scope: 'app', scopeId: appId, month, promptTokens, completionTokens, costUsd, requests: 1 });
    }
    for (const s of scopes) {
      await this.store.addUsage(s);
    }
  }

  /** 预算看板数据（Web 控制台用） */
  async summary(tenantId?: string) {
    const month = monthKey();
    const platform = await this.store.getUsage('platform', config.platformId, month);
    const tenants = await this.store.listTenants();
    const tenantRows = [];
    for (const t of tenants) {
      if (tenantId && t.id !== tenantId) continue;
      const usage = await this.store.getUsage('tenant', t.id, month);
      tenantRows.push({
        tenantId: t.id,
        name: t.name,
        budgetUsd: t.monthlyBudgetUsd,
        usedUsd: usage.costUsd,
        usedTokens: usage.promptTokens + usage.completionTokens,
        tokenBudget: t.monthlyTokenBudget,
        requests: usage.requests,
        ratio: t.monthlyBudgetUsd > 0 ? usage.costUsd / t.monthlyBudgetUsd : 0,
      });
    }
    return { month, platform, tenants: tenantRows };
  }
}
