import {
  DEFAULT_CONCURRENCY_LIMITS,
  PLATFORM_CONCURRENCY_LIMIT_CAPS,
  effectiveConcurrencyLimitCap,
  type WorkflowConcurrencyLimitKey,
} from './limits.js';

export interface WorkflowConcurrencyLimits {
  perTenant: number;
  perUser: number;
  perWorkflow: number;
}

export interface WorkflowConcurrencyRequest {
  runId: string;
  tenantId: string;
  userId: string;
  workflowId: string;
  limits: WorkflowConcurrencyLimits;
}

export interface WorkflowConcurrencyLease {
  release(): Promise<void> | void;
}

export interface WorkflowConcurrencyPort {
  acquire(request: WorkflowConcurrencyRequest): Promise<WorkflowConcurrencyLease | undefined> | WorkflowConcurrencyLease | undefined;
}

/**
 * 解析并发限额：取产品默认值、调用方提交值与平台上限的交集。
 *
 * 语义与 `resolveLimits` 一致（见 7.5 与 R5）：
 * - 业务用户只能调低，不能突破平台上限 —— 提交值一律被天花板夹住；
 * - 内部防御性归一化**绝不放大正数请求** —— 小数向下取整且至少为 1，
 *   并且不会因为取整或回落把限额放大；
 * - 非法覆盖值（NaN / 0 / 负数 / 非有限）回落到默认值，不产生 `NaN`；
 * - 缺省值仍保持 `DEFAULT_CONCURRENCY_LIMITS` 不变。
 *
 * `caps` 可以只覆盖部分限额，缺失项按内置平台上限处理。
 */
export function resolveConcurrencyLimits(
  overrides: Partial<WorkflowConcurrencyLimits> = {},
  caps: Partial<Record<WorkflowConcurrencyLimitKey, number>> = PLATFORM_CONCURRENCY_LIMIT_CAPS,
): WorkflowConcurrencyLimits {
  const pick = (key: keyof WorkflowConcurrencyLimits): number => {
    const cap = effectiveConcurrencyLimitCap(caps, key);
    const base = Math.min(DEFAULT_CONCURRENCY_LIMITS[key], cap);
    const wanted = overrides[key];
    if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0) return base;
    return Math.min(Math.max(1, Math.floor(wanted)), cap);
  };
  return { perTenant: pick('perTenant'), perUser: pick('perUser'), perWorkflow: pick('perWorkflow') };
}

/** V1 单进程默认实现；多进程或 Redis 重建由部署宿主替换端口。 */
export class InMemoryWorkflowConcurrencyPort implements WorkflowConcurrencyPort {
  private readonly counts = new Map<string, number>();
  private readonly leases = new Map<string, { tenant: string; user: string; workflow: string }>();

  acquire(request: WorkflowConcurrencyRequest): WorkflowConcurrencyLease | undefined {
    const runKey = `${request.tenantId}:${request.runId}`;
    if (this.leases.has(runKey)) return undefined;
    const tenant = `tenant:${request.tenantId}`;
    const user = `user:${request.tenantId}:${request.userId}`;
    const workflow = `workflow:${request.tenantId}:${request.workflowId}`;
    if ((this.counts.get(tenant) ?? 0) >= request.limits.perTenant) return undefined;
    if ((this.counts.get(user) ?? 0) >= request.limits.perUser) return undefined;
    if ((this.counts.get(workflow) ?? 0) >= request.limits.perWorkflow) return undefined;
    this.counts.set(tenant, (this.counts.get(tenant) ?? 0) + 1);
    this.counts.set(user, (this.counts.get(user) ?? 0) + 1);
    this.counts.set(workflow, (this.counts.get(workflow) ?? 0) + 1);
    this.leases.set(runKey, { tenant, user, workflow });
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(runKey);
        for (const key of [tenant, user, workflow]) {
          const left = Math.max(0, (this.counts.get(key) ?? 0) - 1);
          if (left === 0) this.counts.delete(key);
          else this.counts.set(key, left);
        }
      },
    };
  }
}
