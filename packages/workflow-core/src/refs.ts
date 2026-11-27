/**
 * 受限引用解析 —— 见设计文档 5.2 与 R3。
 *
 * 引用只有两种形态：
 * - `input.<字段>`：本次运行的启动输入；
 * - `nodes.<节点ID>.output.<字段>`：上游节点的输出字段。
 *
 * 节点 ID 不允许包含 `.`、空白或控制字符，因此按 `.` 切分不会出现歧义。
 */
import type { ConditionContext, TemplatedValue, WorkflowDefinition } from './types.js';

/** 节点 ID 允许的字符集：首字符为字母或数字，其余为字母数字、点、下划线、连字符。 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 引用的目标类型。 */
export type RefTarget =
  | { kind: 'input'; field: string }
  | { kind: 'node'; nodeId: string; field: string };

/** 解析引用字符串；格式非法时返回 null。 */
export function parseRef(ref: string): RefTarget | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 256) return null;
  if (/\s/.test(ref)) return null;
  const parts = ref.split('.');
  if (parts[0] === 'input') {
    if (parts.length !== 2 || !parts[1]) return null;
    return { kind: 'input', field: parts[1] };
  }
  if (parts[0] === 'nodes') {
    // nodes.<nodeId>.output.<field>
    if (parts.length !== 4 || parts[2] !== 'output' || !parts[1] || !parts[3]) return null;
    if (!NODE_ID_PATTERN.test(parts[1])) return null;
    return { kind: 'node', nodeId: parts[1], field: parts[3] };
  }
  return null;
}

/** 引用解析结果。 */
export interface RefResolution {
  /** 路径是否合法。 */
  valid: boolean;
  /** 路径合法时，值是否存在。 */
  found: boolean;
  value?: unknown;
}

/**
 * 在给定上下文中解析引用。
 *
 * `valid=false` 表示路径本身非法（格式错或指向不允许的位置）；
 * `valid=true, found=false` 表示路径合法但当前没有值（例如上游被跳过）。
 */
export function resolveRef(ref: string, ctx: ConditionContext): RefResolution {
  const target = parseRef(ref);
  if (!target) return { valid: false, found: false };
  if (target.kind === 'input') {
    const source = ctx.input ?? {};
    if (!Object.prototype.hasOwnProperty.call(source, target.field)) {
      return { valid: true, found: false };
    }
    return { valid: true, found: true, value: source[target.field] };
  }
  const node = ctx.nodes?.[target.nodeId];
  if (!node || !node.output) return { valid: true, found: false };
  if (!Object.prototype.hasOwnProperty.call(node.output, target.field)) {
    return { valid: true, found: false };
  }
  return { valid: true, found: true, value: node.output[target.field] };
}

/**
 * 递归收集配置片段里出现的全部 `$ref`。
 *
 * 深度上限 64，与审计侧的嵌套深度限制一致，避免深结构导致的栈溢出。
 */
export function collectRefs(value: TemplatedValue, acc: string[] = [], depth = 0): string[] {
  if (depth > 64) return acc;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, acc, depth + 1);
    return acc;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === 'string') {
      acc.push(record.$ref);
      return acc;
    }
    for (const item of Object.values(record)) collectRefs(item, acc, depth + 1);
  }
  return acc;
}

/**
 * 计算某节点的**祖先集合**（能到达该节点的所有节点）。
 *
 * 用于校验「引用必须指向真实存在的上游节点」—— 引用下游节点或旁支节点都不合法。
 */
export function ancestorsOf(definition: WorkflowDefinition, nodeId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of definition.edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }
  const result = new Set<string>();
  const stack = [...(incoming.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const parent of incoming.get(current) ?? []) stack.push(parent);
  }
  return result;
}
