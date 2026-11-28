/**
 * 限额 —— 见设计文档 7.5 与 R5。
 *
 * 两层含义：
 * - 产品默认值：平台给工作流作者的初始额度；
 * - 平台上限：业务用户只能调低、不能突破。
 */
import type { WorkflowLimits } from './types.js';

/** 产品默认值。 */
export const DEFAULT_LIMITS: WorkflowLimits = {
  maxSteps: 50,
  maxLlmCalls: 10,
  maxToolCalls: 10,
  timeoutMs: 900_000,
  approvalTimeoutMs: 300_000,
};

/** 平台硬上限 —— 业务用户提交的限额不得突破这些值。 */
export const PLATFORM_LIMIT_CAPS: WorkflowLimits = {
  maxSteps: 200,
  maxLlmCalls: 50,
  maxToolCalls: 50,
  timeoutMs: 3_600_000,
  approvalTimeoutMs: 900_000,
};

/** 单次运行并发上限（见 R5）。 */
export const DEFAULT_CONCURRENCY_LIMITS = {
  perTenant: 20,
  perUser: 3,
  perWorkflow: 5,
} as const;

/**
 * 并发平台上限 —— 业务用户只能调低、不能突破（见 7.5 的 R5）。
 *
 * 选值理由：
 * - `perTenant: 200` —— 单租户同时在跑 200 个运行已经远超单实例 Worker 的承载能力，
 *   再放宽只会让「租户把整个平台额度吃光」变得更容易，因此留一个数量级的余量后封顶；
 * - `perUser: 50` —— 单人 50 路并发足以覆盖压测场景，又不至于让一个人占满整个租户额度；
 * - `perWorkflow: 100` —— 同一流程版本的并发压测保护，量级高于单用户上限以允许批量压测。
 *
 * 这些值是**平台天花板**：内部归一化只能把请求往下夹，不能往上放大。
 */
export const PLATFORM_CONCURRENCY_LIMIT_CAPS = {
  perTenant: 200,
  perUser: 50,
  perWorkflow: 100,
} as const;

/** 并发限额的键集合 —— 与 `PLATFORM_CONCURRENCY_LIMIT_CAPS` 保持一致。 */
export type WorkflowConcurrencyLimitKey = keyof typeof PLATFORM_CONCURRENCY_LIMIT_CAPS;

/**
 * 取某一项并发限额的有效平台上限。
 *
 * 与 `effectiveLimitCap` 同一口径：平台上限允许只覆盖其中几项，
 * 缺失或非法的项一律回落到内置上限，绝不能产生 `NaN`（`NaN` 会让限额比较恒为假，等于限额失效）。
 */
export function effectiveConcurrencyLimitCap(
  caps: Partial<Record<WorkflowConcurrencyLimitKey, number>> | undefined,
  key: WorkflowConcurrencyLimitKey,
): number {
  const value = caps?.[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.floor(value));
  }
  return PLATFORM_CONCURRENCY_LIMIT_CAPS[key];
}

/** 节点数、边数、提示词与状态体积上限。 */
export const STRUCTURE_LIMITS = {
  maxNodes: 50,
  maxEdges: 200,
  maxPromptChars: 32_000,
  maxNodePayloadBytes: 64 * 1024,
  maxRunStateBytes: 1024 * 1024,
  maxSchemaBytes: 32 * 1024,
  /** 节点配置嵌套深度上限。 */
  maxConfigDepth: 64,
  /** 条件 AST 逻辑嵌套深度上限。 */
  maxConditionDepth: 32,
  /** JSON Schema 自身嵌套深度上限（防止深 Schema 拖垮校验与栈溢出）。 */
  maxSchemaDepth: 16,
} as const;

/**
 * 取某一项的有效平台上限。
 *
 * 平台上限可能来自配置或环境变量，**允许只覆盖其中几项**；
 * 缺失或非法的项一律回落到内置平台上限，绝不能产生 `NaN`。
 *
 * 上限写成小数时**向下取整并至少为 1**（10.8 → 10、0.5 → 1）：
 * 平台上限只能收紧，不能回落到更大的内置上限。
 */
export function effectiveLimitCap(
  caps: Partial<WorkflowLimits> | undefined,
  key: keyof WorkflowLimits,
): number {
  const value = caps?.[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.floor(value));
  }
  return PLATFORM_LIMIT_CAPS[key];
}

/**
 * 合并限额：取产品默认值、用户提交值与平台上限的交集。
 *
 * 语义是**业务用户只能调低**：默认值和用户提交值都不能超过平台上限。
 * 非法输入在这里回落到受限默认值；对外提交的定义仍由 validateDefinition 拒绝。
 *
 * `caps` 可以只覆盖部分限额，缺失项按内置平台上限处理。
 * 请求值写成小数时**向下取整并至少为 1**（1.5 → 1、0.5 → 1），
 * 不允许因为取整或回落把限额放大。
 */
export function resolveLimits(
  requested: Partial<WorkflowLimits> | undefined,
  caps: Partial<WorkflowLimits> = PLATFORM_LIMIT_CAPS,
): WorkflowLimits {
  const pick = (key: keyof WorkflowLimits): number => {
    const cap = effectiveLimitCap(caps, key);
    const wanted = requested?.[key];
    const base = Math.min(DEFAULT_LIMITS[key], cap);
    if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0) return base;
    return Math.min(Math.max(1, Math.floor(wanted)), cap);
  };
  return {
    maxSteps: pick('maxSteps'),
    maxLlmCalls: pick('maxLlmCalls'),
    maxToolCalls: pick('maxToolCalls'),
    timeoutMs: pick('timeoutMs'),
    approvalTimeoutMs: Math.min(pick('approvalTimeoutMs'), pick('timeoutMs')),
  };
}
