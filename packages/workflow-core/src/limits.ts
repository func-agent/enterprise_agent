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

/** 节点数、边数、提示词与状态体积上限。 */
export const STRUCTURE_LIMITS = {
  maxNodes: 50,
  maxEdges: 200,
  maxPromptChars: 32_000,
  maxNodePayloadBytes: 64 * 1024,
  maxRunStateBytes: 1024 * 1024,
  maxSchemaBytes: 32 * 1024,
} as const;

/**
 * 合并限额：取产品默认值、用户提交值与平台上限的交集。
 *
 * 语义是**业务用户只能调低**：用户提交的每一项若高于平台上限，一律按平台上限取值；
 * 未提交的项保持产品默认值。
 */
export function resolveLimits(
  requested: Partial<WorkflowLimits> | undefined,
  caps: WorkflowLimits = PLATFORM_LIMIT_CAPS,
): WorkflowLimits {
  const pick = (key: keyof WorkflowLimits): number => {
    const wanted = requested?.[key];
    const base = DEFAULT_LIMITS[key];
    if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0) return base;
    return Math.min(Math.floor(wanted), caps[key]);
  };
  return {
    maxSteps: pick('maxSteps'),
    maxLlmCalls: pick('maxLlmCalls'),
    maxToolCalls: pick('maxToolCalls'),
    timeoutMs: pick('timeoutMs'),
    approvalTimeoutMs: Math.min(pick('approvalTimeoutMs'), pick('timeoutMs')),
  };
}
