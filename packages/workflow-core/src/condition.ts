/**
 * 条件 AST 与自带求值器 —— 见设计文档 5.2。
 *
 * V1 的条件是**结构化 AST**，不接受字符串表达式，更不接受任意 JavaScript。
 * 求值器只认白名单算子，输入只能是 JSON 值。
 *
 * 实施口径：A1 阶段本包自带最小求值器，**不 import gateway 的 `policy/cel.ts`**
 * （会造成包依赖倒置）；到 D 阶段再把两边的求值能力抽取到 `platform-core` 共享。
 */
import { resolveRef } from './refs.js';
import type {
  ConditionContext,
  ConditionExpr,
  ConditionOperator,
  TemplatedValue,
  ValidationIssue,
} from './types.js';

/** 受支持的算子集合。 */
export const SUPPORTED_OPERATORS: readonly ConditionOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
  'is_true',
  'is_false',
];

/** 条件求值结果。 */
export interface ConditionEvaluation {
  /** 求值是否成立。 */
  value: boolean;
  /** 求值过程中的问题（引用非法、类型不可比等）。 */
  issues: ValidationIssue[];
}

/** 取值：字面量直接返回，引用走上下文解析。 */
function readValue(
  raw: TemplatedValue,
  ctx: ConditionContext,
  issues: ValidationIssue[],
): { present: boolean; value?: unknown } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const ref = (raw as Record<string, unknown>).$ref;
    if (typeof ref === 'string') {
      const resolution = resolveRef(ref, ctx);
      if (!resolution.valid) {
        issues.push({ code: 'invalid_ref', message: `引用格式非法：${ref}` });
        return { present: false };
      }
      if (!resolution.found) return { present: false };
      return { present: true, value: resolution.value };
    }
  }
  return { present: true, value: raw };
}

function compare(
  operator: ConditionOperator,
  left: unknown,
  right: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'gt':
      return typeof left === 'number' && typeof right === 'number' && left > right;
    case 'gte':
      return typeof left === 'number' && typeof right === 'number' && left >= right;
    case 'lt':
      return typeof left === 'number' && typeof right === 'number' && left < right;
    case 'lte':
      return typeof left === 'number' && typeof right === 'number' && left <= right;
    case 'contains':
      if (typeof left === 'string') return left.includes(String(right));
      if (Array.isArray(left)) return left.some((item) => item === right);
      return false;
    case 'not_contains':
      if (typeof left === 'string') return !left.includes(String(right));
      if (Array.isArray(left)) return !left.some((item) => item === right);
      return false;
    case 'is_true':
      return left === true;
    case 'is_false':
      return left === false;
    default:
      return false;
  }
}

/**
 * 求值条件 AST。
 *
 * 任一分支出现非法引用时，求值结果为 false 并附带 issue —— 条件出错不能默认走 true 分支，
 * 否则会把控制流推向未预期的分支。
 */
export function evaluateCondition(expr: ConditionExpr | undefined, ctx: ConditionContext): ConditionEvaluation {
  const issues: ValidationIssue[] = [];
  if (!expr) return { value: false, issues };

  if ('all' in expr) {
    if (!Array.isArray(expr.all) || expr.all.length === 0) {
      issues.push({ code: 'invalid_condition', message: 'all 条件必须是非空数组' });
      return { value: false, issues };
    }
    let result = true;
    for (const item of expr.all) {
      const sub = evaluateCondition(item, ctx);
      issues.push(...sub.issues);
      if (!sub.value) result = false;
    }
    return { value: result, issues };
  }

  if ('any' in expr) {
    if (!Array.isArray(expr.any) || expr.any.length === 0) {
      issues.push({ code: 'invalid_condition', message: 'any 条件必须是非空数组' });
      return { value: false, issues };
    }
    let result = false;
    for (const item of expr.any) {
      const sub = evaluateCondition(item, ctx);
      issues.push(...sub.issues);
      if (sub.value) result = true;
    }
    return { value: result, issues };
  }

  if ('not' in expr) {
    const sub = evaluateCondition(expr.not, ctx);
    return { value: !sub.value, issues: sub.issues };
  }

  const operator = expr.operator;
  if (!SUPPORTED_OPERATORS.includes(operator)) {
    issues.push({ code: 'unsupported_operator', message: `不支持的条件算子：${operator}` });
    return { value: false, issues };
  }

  const left = readValue(expr.left, ctx, issues);
  const right = readValue(expr.right, ctx, issues);
  if (issues.length > 0) return { value: false, issues };

  if (operator === 'exists') return { value: left.present, issues };
  if (operator === 'not_exists') return { value: !left.present, issues };
  if (!left.present) {
    // 取值缺失时，除 exists/not_exists 外一律判 false，不做任何隐式默认值。
    return { value: false, issues };
  }
  return { value: compare(operator, left.value, right.value), issues };
}
