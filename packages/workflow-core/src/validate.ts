/**
 * DAG 校验器 —— 见设计文档 5.3、R3、R4、R8。
 *
 * 纯函数：输入定义 + 校验上下文，输出问题列表。
 * 发布时与每次运行前都会执行，**已发布版本也必须重新校验**，不能只信任发布时的结果。
 */
import { checkSchemaSchema } from './schema.js';
import { STRUCTURE_LIMITS, resolveLimits } from './limits.js';
import { NODE_ID_PATTERN, ancestorsOf, collectRefs, parseRef } from './refs.js';
import {
  SUPPORTED_NODE_IMPLEMENTATIONS,
  SUPPORTED_SCHEMA_VERSIONS,
  type ConditionExpr,
  type ValidationContext,
  type ValidationIssue,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from './types.js';

const NODE_TYPES = Object.keys(SUPPORTED_NODE_IMPLEMENTATIONS) as WorkflowNodeType[];

function issue(
  code: string,
  message: string,
  extra: { nodeId?: string; edgeId?: string; path?: string } = {},
): ValidationIssue {
  return { code, message, ...extra };
}

/** 拓扑排序；存在环时返回 null。 */
function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] | null {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) indegree.set(node.id, 0);
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const order: WorkflowNode[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (node) order.push(node);
    for (const next of outgoing.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return order.length === nodes.length ? order : null;
}

/** 从指定起点出发可达的节点集合。 */
function reachableFrom(nodeIds: string[], edges: WorkflowEdge[]): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const seen = new Set<string>();
  const stack = [...nodeIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of outgoing.get(id) ?? []) stack.push(next);
  }
  return seen;
}

/** 反向可达：从终点集合出发能到达的节点。 */
function canReach(targets: string[], edges: WorkflowEdge[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }
  const seen = new Set<string>();
  const stack = [...targets];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const prev of incoming.get(id) ?? []) stack.push(prev);
  }
  return seen;
}

/** 节点配置里必须出现的字段。 */
const REQUIRED_CONFIG: Partial<Record<WorkflowNodeType, string[]>> = {
  llm: ['model'],
  tool: ['serverId', 'tool'],
  knowledge: ['query'],
  agent: ['model'],
};

function validateNodeConfig(
  node: WorkflowNode,
  issues: ValidationIssue[],
): void {
  const config = (node.config ?? {}) as Record<string, unknown>;

  for (const key of REQUIRED_CONFIG[node.type] ?? []) {
    const value = config[key];
    if (value === undefined || value === null || value === '') {
      issues.push(
        issue('missing_config', `节点缺少必填配置 ${key}`, {
          nodeId: node.id,
          path: `nodes.${node.id}.config.${key}`,
        }),
      );
    }
  }

  if (node.type === 'llm' || node.type === 'agent') {
    const model = config.model;
    if (typeof model === 'string' && model.length > 128) {
      issues.push(
        issue('invalid_model', '虚拟模型名过长', { nodeId: node.id, path: `nodes.${node.id}.config.model` }),
      );
    }
  }

  if (node.type === 'llm') {
    const maxTokens = config.maxOutputTokens;
    if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
      issues.push(
        issue('invalid_config', 'maxOutputTokens 必须是正整数', {
          nodeId: node.id,
          path: `nodes.${node.id}.config.maxOutputTokens`,
        }),
      );
    }
    // 提示词允许两种形态（见设计文档 5.2）：
    // 1) 纯字符串；
    // 2) 文本片段与引用片段组成的数组，执行器负责拼接。
    for (const key of ['systemPrompt', 'userPrompt'] as const) {
      const prompt = config[key];
      if (prompt === undefined) continue;
      const path = `nodes.${node.id}.config.${key}`;
      if (typeof prompt === 'string') {
        if (prompt.length > STRUCTURE_LIMITS.maxPromptChars) {
          issues.push(issue('prompt_too_long', `${key} 超过长度上限 ${STRUCTURE_LIMITS.maxPromptChars}`, { nodeId: node.id, path }));
        }
        continue;
      }
      if (!Array.isArray(prompt)) {
        issues.push(issue('invalid_config', `${key} 必须是字符串或片段数组`, { nodeId: node.id, path }));
        continue;
      }
      let total = 0;
      for (const fragment of prompt) {
        if (typeof fragment === 'string') {
          total += fragment.length;
          continue;
        }
        if (
          fragment &&
          typeof fragment === 'object' &&
          !Array.isArray(fragment) &&
          typeof (fragment as Record<string, unknown>).$ref === 'string'
        ) {
          // 引用片段不计入长度，但引用本身会在后续的引用校验中检查
          continue;
        }
        issues.push(issue('invalid_config', `${key} 的片段必须是字符串或引用`, { nodeId: node.id, path }));
      }
      if (total > STRUCTURE_LIMITS.maxPromptChars) {
        issues.push(issue('prompt_too_long', `${key} 超过长度上限 ${STRUCTURE_LIMITS.maxPromptChars}`, { nodeId: node.id, path }));
      }
    }
  }

  if (node.type === 'knowledge') {
    const topK = config.topK;
    if (topK !== undefined && (typeof topK !== 'number' || !Number.isInteger(topK) || topK <= 0 || topK > 100)) {
      issues.push(
        issue('invalid_config', 'topK 必须是 1–100 的整数', {
          nodeId: node.id,
          path: `nodes.${node.id}.config.topK`,
        }),
      );
    }
  }

  if (node.type === 'tool') {
    const args = config.args;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      issues.push(
        issue('invalid_config', 'args 必须是对象', { nodeId: node.id, path: `nodes.${node.id}.config.args` }),
      );
    }
    // 工具节点不允许覆盖网关注入的 __ctx
    if (args && typeof args === 'object' && !Array.isArray(args) && '__ctx' in (args as Record<string, unknown>)) {
      issues.push(
        issue('ctx_override_forbidden', '工具参数不允许覆盖 __ctx', {
          nodeId: node.id,
          path: `nodes.${node.id}.config.args.__ctx`,
        }),
      );
    }
  }

  if (node.type === 'condition') {
    const expr = config.condition as ConditionExpr | undefined;
    if (!expr || typeof expr !== 'object') {
      issues.push(
        issue('missing_config', '条件节点必须配置 condition', {
          nodeId: node.id,
          path: `nodes.${node.id}.config.condition`,
        }),
      );
    }
  }

  // Schema 只能是受支持的最小子集
  for (const key of ['inputSchema', 'outputSchema'] as const) {
    const schema = node[key];
    if (schema === undefined) continue;
    const result = checkSchemaSchema(schema);
    for (const error of result.errors) {
      issues.push(
        issue('invalid_schema', error, { nodeId: node.id, path: `nodes.${node.id}.${key}` }),
      );
    }
    const size = JSON.stringify(schema).length;
    if (size > STRUCTURE_LIMITS.maxSchemaBytes) {
      issues.push(
        issue('schema_too_large', `${key} 超过体积上限`, { nodeId: node.id, path: `nodes.${node.id}.${key}` }),
      );
    }
  }
}

/**
 * 校验工作流定义。
 *
 * 返回所有问题（一次列全），而不是遇到第一个就返回 —— 业务人员需要一次看到全部错误。
 */
export function validateDefinition(
  definition: WorkflowDefinition,
  ctx: ValidationContext = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!definition || typeof definition !== 'object') {
    return { ok: false, issues: [issue('invalid_definition', '工作流定义必须是对象')] };
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(definition.schemaVersion)) {
    issues.push(
      issue('unsupported_schema_version', `不支持的 schemaVersion：${definition.schemaVersion}`),
    );
  }

  if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
    issues.push(issue('missing_name', '工作流名称不能为空'));
  }

  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const edges = Array.isArray(definition.edges) ? definition.edges : [];

  if (nodes.length === 0) {
    issues.push(issue('no_nodes', '工作流至少要有一个节点'));
  }
  if (nodes.length > STRUCTURE_LIMITS.maxNodes) {
    issues.push(issue('too_many_nodes', `节点数超过上限 ${STRUCTURE_LIMITS.maxNodes}`));
  }
  if (edges.length > STRUCTURE_LIMITS.maxEdges) {
    issues.push(issue('too_many_edges', `边数超过上限 ${STRUCTURE_LIMITS.maxEdges}`));
  }

  // —— 节点 ID 唯一
  const byId = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !NODE_ID_PATTERN.test(node.id)) {
      issues.push(
        issue('invalid_node_id', `节点 ID 非法：${String(node?.id)}`, { nodeId: String(node?.id ?? '') }),
      );
      continue;
    }
    if (byId.has(node.id)) {
      issues.push(issue('duplicate_node_id', `节点 ID 重复：${node.id}`, { nodeId: node.id }));
      continue;
    }
    byId.set(node.id, node);
  }

  // —— 节点类型与实现版本
  const supported = ctx.nodeImplementations ?? SUPPORTED_NODE_IMPLEMENTATIONS;
  for (const node of nodes) {
    if (!node || !NODE_ID_PATTERN.test(node.id)) continue;
    if (!NODE_TYPES.includes(node.type)) {
      issues.push(
        issue('unknown_node_type', `不支持的节点类型：${String(node.type)}`, { nodeId: node.id }),
      );
      continue;
    }
    const implVersion = node.implVersion ?? 1;
    const allowed = supported[node.type] ?? [];
    if (!allowed.includes(implVersion)) {
      issues.push(
        issue(
          'unsupported_impl_version',
          `节点 ${node.id} 的实现版本 ${implVersion} 不受支持（支持：${allowed.join(', ')}）`,
          { nodeId: node.id, path: `nodes.${node.id}.implVersion` },
        ),
      );
    }
    validateNodeConfig(node, issues);
  }

  // —— 边
  const edgeIds = new Set<string>();
  const seenEdge = new Set<string>();
  for (const edge of edges) {
    if (!edge || typeof edge.id !== 'string' || edge.id.length === 0) {
      issues.push(issue('invalid_edge_id', '边必须有 id'));
      continue;
    }
    if (edgeIds.has(edge.id)) {
      issues.push(issue('duplicate_edge_id', `边 ID 重复：${edge.id}`, { edgeId: edge.id }));
      continue;
    }
    edgeIds.add(edge.id);

    if (!byId.has(edge.source)) {
      issues.push(issue('dangling_edge', `边的起点不存在：${edge.source}`, { edgeId: edge.id }));
    }
    if (!byId.has(edge.target)) {
      issues.push(issue('dangling_edge', `边的终点不存在：${edge.target}`, { edgeId: edge.id }));
    }
    if (edge.source === edge.target) {
      issues.push(issue('self_loop', `不允许自环：${edge.id}`, { edgeId: edge.id }));
    }
    const key = `${edge.source}->${edge.target}::${edge.branch ?? ''}`;
    if (seenEdge.has(key)) {
      issues.push(issue('duplicate_edge', `重复的边：${edge.source} → ${edge.target}`, { edgeId: edge.id }));
    }
    seenEdge.add(key);
  }

  // —— 输入/输出节点各恰好一个
  const inputNodes = nodes.filter((node) => node?.type === 'input');
  const outputNodes = nodes.filter((node) => node?.type === 'output');
  if (inputNodes.length !== 1) {
    issues.push(issue('invalid_input_node_count', `输入节点必须恰好一个，实际 ${inputNodes.length}`));
  }
  if (outputNodes.length !== 1) {
    issues.push(issue('invalid_output_node_count', `输出节点必须恰好一个，实际 ${outputNodes.length}`));
  }

  // —— 无环
  const order = topologicalOrder(nodes, edges);
  if (order === null) {
    issues.push(issue('cycle_detected', '工作流存在循环'));
  }

  // —— 可达性
  if (inputNodes.length === 1 && outputNodes.length === 1) {
    const fromInput = reachableFrom([inputNodes[0].id], edges);
    for (const node of nodes) {
      if (!node || !NODE_ID_PATTERN.test(node.id)) continue;
      if (!fromInput.has(node.id)) {
        issues.push(
          issue('unreachable_node', `节点无法从输入节点到达：${node.id}`, { nodeId: node.id }),
        );
      }
    }
    const toOutput = canReach([outputNodes[0].id], edges);
    for (const node of nodes) {
      if (!node || !NODE_ID_PATTERN.test(node.id)) continue;
      if (!toOutput.has(node.id)) {
        issues.push(
          issue('dead_end_node', `节点无法到达输出节点：${node.id}`, { nodeId: node.id }),
        );
      }
    }
  }

  // —— 条件节点必须同时具备 true / false 出口
  for (const node of nodes) {
    if (!node || node.type !== 'condition') continue;
    const branches = new Set(
      edges.filter((edge) => edge.source === node.id).map((edge) => edge.branch ?? 'true'),
    );
    if (!branches.has('true') || !branches.has('false')) {
      issues.push(
        issue('missing_branch', `条件节点必须同时有 true 与 false 出口：${node.id}`, { nodeId: node.id }),
      );
    }
  }

  // —— 引用必须指向真实存在且为上游的节点
  for (const node of nodes) {
    if (!node || !NODE_ID_PATTERN.test(node.id)) continue;
    const ancestors = ancestorsOf({ ...definition, nodes, edges }, node.id);
    const refs = collectRefs(node.config ?? {});
    for (const ref of refs) {
      const target = parseRef(ref);
      if (!target) {
        issues.push(
          issue('invalid_ref', `引用格式非法：${ref}`, { nodeId: node.id, path: `nodes.${node.id}.config` }),
        );
        continue;
      }
      if (target.kind === 'node') {
        if (!byId.has(target.nodeId)) {
          issues.push(
            issue('unknown_ref_node', `引用指向不存在的节点：${ref}`, {
              nodeId: node.id,
              path: `nodes.${node.id}.config`,
            }),
          );
          continue;
        }
        if (!ancestors.has(target.nodeId)) {
          issues.push(
            issue('non_upstream_ref', `引用必须指向上游节点：${ref}`, {
              nodeId: node.id,
              path: `nodes.${node.id}.config`,
            }),
          );
        }
      }
    }
  }

  // —— 资源白名单（运行者可用的逻辑资源）
  const resources = ctx.resources;
  if (resources) {
    for (const node of nodes) {
      if (!node || !NODE_ID_PATTERN.test(node.id)) continue;
      const config = (node.config ?? {}) as Record<string, unknown>;
      if (node.type === 'llm' || node.type === 'agent') {
        const model = config.model;
        if (typeof model === 'string' && resources.models && !resources.models.includes(model)) {
          issues.push(
            issue('model_not_allowed', `模型不在当前可用范围：${model}`, {
              nodeId: node.id,
              path: `nodes.${node.id}.config.model`,
            }),
          );
        }
      }
      if (node.type === 'tool') {
        const serverId = config.serverId;
        const tool = config.tool;
        if (typeof serverId === 'string' && typeof tool === 'string' && resources.tools) {
          if (!resources.tools.includes(`${serverId}/${tool}`)) {
            issues.push(
              issue('tool_not_allowed', `工具不在当前可用范围：${serverId}/${tool}`, {
                nodeId: node.id,
                path: `nodes.${node.id}.config.tool`,
              }),
            );
          }
        }
      }
    }
  }

  // —— 限额：业务用户只能调低，不能突破平台上限
  if (definition.limits) {
    const resolved = resolveLimits(definition.limits, ctx.platformLimits);
    for (const key of Object.keys(definition.limits) as (keyof typeof definition.limits)[]) {
      const requested = definition.limits[key];
      if (requested === undefined) continue;
      const cap = ctx.platformLimits?.[key];
      if (cap !== undefined && requested > cap) {
        issues.push(
          issue('limit_exceeded', `限额 ${key} 超过平台上限 ${cap}`, { path: `limits.${key}` }),
        );
      }
    }
    if (resolved.approvalTimeoutMs > resolved.timeoutMs) {
      issues.push(
        issue('invalid_limits', '审批等待时限不能超过运行时长上限', { path: 'limits.approvalTimeoutMs' }),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
