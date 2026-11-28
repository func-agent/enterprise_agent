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
import { STRUCTURE_LIMITS } from './limits.js';
import { FORBIDDEN_PROPERTY_KEYS } from './schema.js';
import type {
  ConditionContext,
  ConditionExpr,
  ConditionOperator,
  TemplatedValue,
  ValidationIssue,
} from './types.js';

export const MAX_CONDITION_DEPTH = STRUCTURE_LIMITS.maxConditionDepth;

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

const UNARY_OPERATORS = new Set<ConditionOperator>([
  'exists',
  'not_exists',
  'is_true',
  'is_false',
]);

/** 需要在左值上做「包含」匹配的算子 —— 左值必须是字符串或数组。 */
const SEARCH_OPERATORS = new Set<ConditionOperator>(['contains', 'not_contains']);

/** 二元算子必须带右操作数。 */
const BINARY_OPERATORS = new Set<ConditionOperator>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 左值是否可以参与「包含」匹配。 */
function isSearchable(value: unknown): boolean {
  return typeof value === 'string' || Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidCondition(message: string, path: string): ValidationIssue {
  return { code: 'invalid_condition', message, path };
}

/**
 * 校验比较操作数。
 *
 * 操作数只允许两种形态（见 5.2）：
 * 1. **顶层 `$ref` 对象** —— 只有一个 `$ref` 字段；
 * 2. **字面量** —— 字符串 / 数字 / 布尔 / null / 数组 / 对象字面量。
 *
 * 不允许在操作数内部嵌套 `$ref`：求值器只解析顶层 `$ref`，
 * 嵌套引用会被当成字面量对象，比较恒为 false 且不留任何痕迹。
 * 同时禁止原型污染键（`__proto__` / `constructor` / `prototype`），
 * 与其余配置层级的口径保持一致（见 13 章）。
 */
function validateOperand(value: unknown, path: string): ValidationIssue[] {
  if (isRecord(value) && hasOwn(value, '$ref')) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string') {
      return [{ code: 'invalid_ref', message: '引用对象只能包含字符串类型的 $ref 字段', path }];
    }
    return [];
  }
  return scanOperandLiteral(value, path, 0);
}

/**
 * 递归检查字面量操作数：原型污染键与嵌套引用。
 *
 * 「嵌套引用」指操作数内部（对象属性**或数组元素**）出现的 `$ref` 对象 ——
 * 求值器只解析顶层 `$ref`，嵌套引用会被当成字面量，比较恒为 false 且不留痕迹。
 * 数组元素与对象属性同等对待，否则同一条规则会出现两种口径。
 *
 * 深度超限**必须报问题**：静默截断会让超出上限的嵌套里的 `$ref` 与原型污染键
 * 一起逃过检查，与其余配置层级（同一上限、同一 `config_too_deep` 口径）不一致。
 */
function scanOperandLiteral(value: unknown, path: string, depth: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (depth > STRUCTURE_LIMITS.maxConfigDepth) {
    issues.push({
      code: 'config_too_deep',
      message: `操作数嵌套深度不能超过 ${STRUCTURE_LIMITS.maxConfigDepth}`,
      path,
    });
    return issues;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      issues.push(...scanOperandLiteral(item, `${path}[${index}]`, depth + 1));
    });
    return issues;
  }
  if (!isRecord(value)) return issues;
  // 走到这里的对象已经不是顶层操作数：它内部再出现 `$ref` 就是嵌套引用。
  if (hasOwn(value, '$ref')) {
    issues.push(invalidCondition('操作数只支持字面量或顶层 $ref，不允许嵌套引用', path));
    return issues;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PROPERTY_KEYS.includes(key)) {
      issues.push(invalidCondition(`不允许使用会造成原型污染的键名：${key}`, `${path}.${key}`));
      continue;
    }
    issues.push(...scanOperandLiteral(item, `${path}.${key}`, depth + 1));
  }
  return issues;
}

/** 校验来自不可信 JSON 的条件 AST，并限制逻辑嵌套深度。 */
export function validateConditionExpression(
  expr: unknown,
  path = 'condition',
  depth = 0,
): ValidationIssue[] {
  if (depth > MAX_CONDITION_DEPTH) {
    return [invalidCondition(`条件嵌套深度不能超过 ${MAX_CONDITION_DEPTH}`, path)];
  }
  if (!isRecord(expr)) {
    return [invalidCondition('条件必须是对象', path)];
  }

  const keys = Object.keys(expr);
  const logicalKeys = ['all', 'any', 'not'].filter((key) => hasOwn(expr, key));
  if (logicalKeys.length > 0) {
    const issues: ValidationIssue[] = [];
    if (logicalKeys.length !== 1 || keys.length !== 1) {
      issues.push(invalidCondition('逻辑条件只能包含 all、any、not 中的一种', path));
    }
    const key = logicalKeys[0];
    if (key === 'all' || key === 'any') {
      const children = expr[key];
      if (!Array.isArray(children) || children.length === 0) {
        issues.push(invalidCondition(`${key} 条件必须是非空数组`, `${path}.${key}`));
        return issues;
      }
      children.forEach((child, index) => {
        issues.push(...validateConditionExpression(child, `${path}.${key}[${index}]`, depth + 1));
      });
      return issues;
    }
    if (key === 'not') {
      issues.push(...validateConditionExpression(expr.not, `${path}.not`, depth + 1));
    }
    return issues;
  }

  const issues: ValidationIssue[] = [];
  for (const key of ['left', 'operator']) {
    if (!hasOwn(expr, key)) issues.push(invalidCondition(`比较条件缺少 ${key}`, `${path}.${key}`));
  }
  // 一元算子（exists / not_exists / is_true / is_false）不接受右操作数；
  // 二元算子必须带右操作数。求值器与本校验器共用同一份算子分类。
  const operator = hasOwn(expr, 'operator') && typeof expr.operator === 'string'
    ? (expr.operator as ConditionOperator)
    : undefined;
  const isUnary = operator !== undefined && UNARY_OPERATORS.has(operator);
  const isBinary = operator !== undefined && BINARY_OPERATORS.has(operator);
  if (isBinary && !hasOwn(expr, 'right')) {
    issues.push(invalidCondition('比较条件缺少 right', `${path}.right`));
  }
  if (isUnary && hasOwn(expr, 'right')) {
    issues.push(invalidCondition(`一元算子 ${operator} 不接受 right 操作数`, `${path}.right`));
  }
  for (const key of keys) {
    if (!['left', 'operator', 'right'].includes(key)) {
      issues.push(invalidCondition(`比较条件包含未知字段 ${key}`, `${path}.${key}`));
    }
  }
  if (
    hasOwn(expr, 'operator') &&
    (typeof expr.operator !== 'string' || !SUPPORTED_OPERATORS.includes(expr.operator as ConditionOperator))
  ) {
    issues.push({
      code: 'unsupported_operator',
      message: `不支持的条件算子：${String(expr.operator)}`,
      path: `${path}.operator`,
    });
  }
  if (hasOwn(expr, 'left')) issues.push(...validateOperand(expr.left, `${path}.left`));
  if (hasOwn(expr, 'right')) issues.push(...validateOperand(expr.right, `${path}.right`));
  return issues;
}

/** 条件求值结果。 */
export interface ConditionEvaluation {
  /** 求值是否成立。 */
  value: boolean;
  /** 求值过程中的问题（引用非法、操作数缺失或条件结构非法）。 */
  issues: ValidationIssue[];
}

function readValue(
  raw: TemplatedValue,
  ctx: ConditionContext,
): { present: boolean; value?: unknown; issues: ValidationIssue[] } {
  if (isRecord(raw) && typeof raw.$ref === 'string') {
    const resolution = resolveRef(raw.$ref, ctx);
    if (!resolution.valid) {
      return {
        present: false,
        issues: [{ code: 'invalid_ref', message: `引用格式非法：${raw.$ref}` }],
      };
    }
    if (!resolution.found) return { present: false, issues: [] };
    return { present: true, value: resolution.value, issues: [] };
  }
  return { present: true, value: raw, issues: [] };
}

function compare(operator: ConditionOperator, left: unknown, right: unknown): boolean {
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

function evaluateValidCondition(expr: ConditionExpr, ctx: ConditionContext): ConditionEvaluation {
  if ('all' in expr) {
    const results = expr.all.map((item) => evaluateValidCondition(item, ctx));
    const issues = results.flatMap((result) => result.issues);
    return {
      value: issues.length === 0 && results.every((result) => result.value),
      issues,
    };
  }
  if ('any' in expr) {
    const results = expr.any.map((item) => evaluateValidCondition(item, ctx));
    const issues = results.flatMap((result) => result.issues);
    return {
      value: issues.length === 0 && results.some((result) => result.value),
      issues,
    };
  }
  if ('not' in expr) {
    const sub = evaluateValidCondition(expr.not, ctx);
    return { value: sub.issues.length === 0 && !sub.value, issues: sub.issues };
  }

  const left = readValue(expr.left, ctx);
  if (left.issues.length > 0) return { value: false, issues: left.issues };
  if (expr.operator === 'exists') return { value: left.present, issues: [] };
  if (expr.operator === 'not_exists') return { value: !left.present, issues: [] };
  if (!left.present) {
    return {
      value: false,
      issues: [{ code: 'missing_operand', message: '左操作数引用不存在' }],
    };
  }
  if (UNARY_OPERATORS.has(expr.operator)) {
    return { value: compare(expr.operator, left.value, undefined), issues: [] };
  }
  // 包含类算子的左值必须是字符串或数组；其他类型不可判定，
  // 一律判 false 并给出问题，不能让 not_contains 静默变成「必须包含」。
  if (SEARCH_OPERATORS.has(expr.operator) && !isSearchable(left.value)) {
    return {
      value: false,
      issues: [{
        code: 'invalid_operand',
        message: 'contains / not_contains 的左操作数必须是字符串或数组',
      }],
    };
  }
  if (expr.right === undefined) {
    return {
      value: false,
      issues: [{ code: 'missing_operand', message: '右操作数缺失' }],
    };
  }

  const right = readValue(expr.right, ctx);
  if (right.issues.length > 0) return { value: false, issues: right.issues };
  if (!right.present) {
    return {
      value: false,
      issues: [{ code: 'missing_operand', message: '右操作数引用不存在' }],
    };
  }
  return { value: compare(expr.operator, left.value, right.value), issues: [] };
}

/**
 * 收集条件 AST 里的全部 `$ref`。
 *
 * 条件 AST 的深度按**逻辑层级**计（每层 all/any/not 算 1 层，上限 `MAX_CONDITION_DEPTH`），
 * 而通用对象遍历每层逻辑嵌套要吃 2 层深度（一层数组 + 一层表达式对象）：
 * 32 层逻辑嵌套需要 64 层以上对象深度，超出配置的深度上限，
 * 用通用遍历收集会**漏掉深层引用**，让条件里的悬空/下游引用逃过发布期校验。
 * 因此条件单独走这个按逻辑层级计深度的收集器。
 */
export function collectConditionRefs(expr: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > MAX_CONDITION_DEPTH) return acc;
  if (!isRecord(expr)) return acc;
  const logicalKeys = ['all', 'any', 'not'].filter((key) => hasOwn(expr, key));
  if (logicalKeys.length > 0) {
    const key = logicalKeys[0];
    if (key === 'not') return collectConditionRefs(expr.not, acc, depth + 1);
    const children = expr[key];
    if (Array.isArray(children)) {
      for (const child of children) collectConditionRefs(child, acc, depth + 1);
    }
    return acc;
  }
  // 比较条件：left / right 可能是 $ref，也可能是嵌套对象里的引用。
  collectOperandRefs(expr.left, acc);
  collectOperandRefs(expr.right, acc);
  return acc;
}

/**
 * 收集比较操作数里的 `$ref`。
 *
 * 只认操作数**顶层**的引用：嵌套引用在发布期已被 `validateOperand` 拒绝，
 * 采集它们会让校验层按真实引用去校验一个求值器根本不会解析的表达式。
 */
function collectOperandRefs(value: unknown, acc: string[]): void {
  if (!isRecord(value)) return;
  if (typeof value.$ref === 'string') acc.push(value.$ref);
}

/**
 * 求值条件 AST。结构、引用或操作数错误一律返回 false；错误不会被 not 反转。
 */
export function evaluateCondition(expr: ConditionExpr | undefined, ctx: ConditionContext): ConditionEvaluation {
  const structureIssues = validateConditionExpression(expr);
  if (structureIssues.length > 0) return { value: false, issues: structureIssues };
  return evaluateValidCondition(expr as ConditionExpr, ctx);
}
