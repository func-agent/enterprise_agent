import type { ProviderTarget, VirtualModel } from '@eap/platform-core';

export class ModelConfigError extends Error {
  /**
   * 全部校验问题。
   *
   * 与 Provider 配置同理：一次性列全，避免用户一轮只改一个字段。
   */
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    const list = issues.length ? issues : [message];
    // 多个问题时加个抬头，界面上才知道这是一份清单而不是一句话
    super(list.length > 1 ? `以下 ${list.length} 项需要修正：\n${list.join('\n')}` : message);
    this.name = 'ModelConfigError';
    this.issues = list;
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,62}$/;

function text(value: unknown, label: string, maxLength: number, required = true): string {
  if (typeof value !== 'string') throw new ModelConfigError(`${label}必须为字符串`);
  const result = value.trim();
  if (required && !result) throw new ModelConfigError(`${label}不能为空`);
  if (result.length > maxLength) throw new ModelConfigError(`${label}不能超过 ${maxLength} 个字符`);
  return result;
}

function optionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ModelConfigError(`${label}必须是 ${min}–${max} 的整数`);
  }
  return value;
}

function parseTarget(value: unknown, index: number): ProviderTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelConfigError(`第 ${index + 1} 个目标必须是对象`);
  }
  const input = value as Record<string, unknown>;
  const provider = text(input.provider, `第 ${index + 1} 个目标的 Provider`, 63);
  if (!NAME_PATTERN.test(provider)) {
    throw new ModelConfigError(`Provider '${provider}' 格式不正确，仅支持小写字母、数字、点、下划线和连字符`);
  }
  if (input.role !== 'primary' && input.role !== 'fallback') {
    throw new ModelConfigError(`第 ${index + 1} 个目标的角色必须为 primary 或 fallback`);
  }
  const account = input.account === undefined || input.account === ''
    ? undefined
    : text(input.account, `第 ${index + 1} 个目标的账号别名`, 64);
  if (account && !/^[A-Za-z0-9._-]+$/.test(account)) {
    throw new ModelConfigError(`第 ${index + 1} 个目标的账号别名格式不正确`);
  }
  const weight = input.role === 'primary'
    ? optionalInteger(input.weight, `第 ${index + 1} 个目标的权重`, 0, 1_000_000)
    : undefined;
  return {
    provider,
    model: text(input.model, `第 ${index + 1} 个目标的真实模型名`, 200),
    role: input.role,
    ...(account ? { account } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(optionalInteger(input.maxTokens, `第 ${index + 1} 个目标的 maxTokens`, 1, 65_536) !== undefined
      ? { maxTokens: input.maxTokens as number }
      : {}),
  };
}

export function parseVirtualModel(value: unknown, fixedName?: string): VirtualModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelConfigError('请求体必须是模型配置对象');
  }
  const input = value as Record<string, unknown>;
  // 收集**全部**问题再一次性抛出
  const issues: string[] = [];

  let name = fixedName ?? '';
  if (!fixedName) {
    try {
      name = text(input.name, '虚拟模型名', 63);
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (name && !NAME_PATTERN.test(name)) {
    issues.push('虚拟模型名须以小写字母开头，仅含小写字母、数字、点、下划线和连字符，最长 63 字符');
  }
  if (fixedName && input.name !== undefined && input.name !== fixedName) {
    issues.push('虚拟模型名创建后不可修改');
  }
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 20) {
    issues.push('路由目标数量必须为 1–20 个');
  }
  if (!Array.isArray(input.scenarios) || input.scenarios.length > 10) {
    issues.push('适用场景必须是数组，最多 10 项');
  }
  if (typeof input.enabled !== 'boolean') issues.push('enabled 必须为布尔值');

  let description = '';
  try {
    description = text(input.description ?? '', '模型描述', 300, false);
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
  }

  let scenarios: string[] = [];
  if (Array.isArray(input.scenarios)) {
    const collected: string[] = [];
    input.scenarios.forEach((scenario, index) => {
      try {
        const value = text(scenario, `第 ${index + 1} 个适用场景`, 40);
        if (value) collected.push(value);
      } catch (err) {
        issues.push(err instanceof Error ? err.message : String(err));
      }
    });
    scenarios = [...new Set(collected)];
  }

  const targets: ProviderTarget[] = [];
  if (Array.isArray(input.targets)) {
    input.targets.forEach((raw, index) => {
      try {
        targets.push(parseTarget(raw, index));
      } catch (err) {
        issues.push(err instanceof Error ? err.message : String(err));
      }
    });
  }

  // 依赖完整 targets 的交叉校验 —— 有目标解析失败时跳过（错误已在 issues 里）
  if (targets.length === (Array.isArray(input.targets) ? input.targets.length : 0)) {
    const weighted = targets.filter((target) => target.role === 'primary' && target.weight !== undefined);
    if (weighted.length > 0 && weighted.reduce((sum, target) => sum + (target.weight ?? 0), 0) <= 0) {
      issues.push('主用目标的权重之和必须大于 0');
    }
    if (targets.some((target) => target.provider === 'tei') && targets.some((target) => target.provider !== 'tei')) {
      issues.push('TEI 嵌入目标不能与对话目标混用');
    }
  }

  if (issues.length) {
    throw new ModelConfigError(issues.join('\n'), issues);
  }
  return {
    name,
    description,
    targets,
    scenarios,
    enabled: input.enabled as boolean,
  };
}

/**
 * 主用目标配置了权重时按权重选取首个目标，其余主用目标保留为故障转移候选。
 * 全部未配置权重时保持原有顺序；备用目标始终按声明顺序尝试。
 */
export function orderRouteTargets(targets: ProviderTarget[], random = Math.random): ProviderTarget[] {
  const primary = targets.filter((target) => target.role === 'primary');
  const fallback = targets.filter((target) => target.role === 'fallback');
  if (!primary.some((target) => target.weight !== undefined)) return [...primary, ...fallback];
  const total = primary.reduce((sum, target) => sum + (target.weight ?? 1), 0);
  if (total <= 0) return [...primary, ...fallback];
  let cursor = Math.max(0, Math.min(0.9999999999999999, random())) * total;
  let selected = primary.length - 1;
  for (let index = 0; index < primary.length; index++) {
    cursor -= primary[index].weight ?? 1;
    if (cursor < 0) {
      selected = index;
      break;
    }
  }
  return [primary[selected], ...primary.filter((_, index) => index !== selected), ...fallback];
}
