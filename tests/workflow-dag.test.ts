import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  PLATFORM_LIMIT_CAPS,
  STRUCTURE_LIMITS,
  ancestorsOf,
  checkSchemaSchema,
  collectRefs,
  evaluateCondition,
  parseRef,
  resolveLimits,
  resolveRef,
  validateDefinition,
  validateValue,
  type ConditionExpr,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../packages/workflow-core/src/index.js';

/** 构造一个最小可用的「输入 → 输出」工作流。 */
function baseDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    name: '制度审查',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string', maxLength: 200 } },
    },
    nodes: [
      {
        id: 'start',
        type: 'input',
        implVersion: 1,
        config: { fields: ['question'] },
      },
      {
        id: 'review',
        type: 'llm',
        implVersion: 1,
        config: {
          model: 'smart-model',
          systemPrompt: '你是制度审查助手',
          userPrompt: [{ $ref: 'input.question' }],
          maxOutputTokens: 512,
        },
        outputSchema: {
          type: 'object',
          properties: { risk: { type: 'string', enum: ['high', 'low'] } },
        },
      },
      { id: 'done', type: 'output', implVersion: 1, config: { fields: { text: { $ref: 'nodes.review.output.risk' } } } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'review' },
      { id: 'e2', source: 'review', target: 'done' },
    ],
  };
}

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((item) => item.code);
}

/** 在基础定义上追加节点与边。 */
function withNode(
  definition: WorkflowDefinition,
  node: WorkflowNode,
  edges: { id: string; source: string; target: string; branch?: 'true' | 'false' }[],
): WorkflowDefinition {
  return {
    ...definition,
    nodes: [...definition.nodes, node],
    edges: [...definition.edges, ...edges],
  };
}

describe('工作流 DAG 校验', () => {
  it('合法定义通过校验且不产生任何问题', () => {
    const result = validateDefinition(baseDefinition());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('拒绝不支持的 schemaVersion 与空名称', () => {
    const definition = { ...baseDefinition(), schemaVersion: 99, name: '  ' };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('unsupported_schema_version');
    expect(codes(result.issues)).toContain('missing_name');
    expect(result.ok).toBe(false);
  });

  it('拒绝重复的节点 ID 与边 ID', () => {
    const definition = baseDefinition();
    definition.nodes.push({ ...definition.nodes[1] });
    definition.edges.push({ ...definition.edges[0] });
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('duplicate_node_id');
    expect(codes(result.issues)).toContain('duplicate_edge_id');
  });

  it('拒绝悬空边与自环', () => {
    const definition = baseDefinition();
    definition.edges.push({ id: 'e3', source: 'review', target: 'ghost' });
    definition.edges.push({ id: 'e4', source: 'review', target: 'review' });
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('dangling_edge');
    expect(codes(result.issues)).toContain('self_loop');
  });

  it('拒绝循环', () => {
    const definition = baseDefinition();
    definition.edges.push({ id: 'e5', source: 'done', target: 'review' });
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('cycle_detected');
  });

  it('拒绝无法从输入到达的节点与无法到达输出的死路节点', () => {
    const definition = withNode(
      baseDefinition(),
      { id: 'orphan', type: 'llm', implVersion: 1, config: { model: 'smart-model' } },
      [],
    );
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('unreachable_node');
    expect(codes(result.issues)).toContain('dead_end_node');
  });

  it('输入与输出节点必须各恰好一个', () => {
    const definition = baseDefinition();
    definition.nodes.push({ id: 'start2', type: 'input', implVersion: 1, config: {} });
    definition.nodes = definition.nodes.filter((node) => node.id !== 'done');
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_input_node_count');
    expect(codes(result.issues)).toContain('invalid_output_node_count');
  });

  it('条件节点必须同时具备 true 与 false 出口', () => {
    const definition = withNode(
      baseDefinition(),
      {
        id: 'branch',
        type: 'condition',
        implVersion: 1,
        config: { condition: { left: { $ref: 'nodes.review.output.risk' }, operator: 'eq', right: 'high' } },
      },
      [
        { id: 'b1', source: 'review', target: 'branch' },
        { id: 'b2', source: 'branch', target: 'done', branch: 'true' },
      ],
    );
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('missing_branch');
  });

  it('拒绝指向下游或旁支节点的引用', () => {
    const definition = baseDefinition();
    definition.nodes[1].config = {
      model: 'smart-model',
      // done 是 review 的下游，不允许被 review 引用
      userPrompt: [{ $ref: 'nodes.done.output.text' }],
    };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('non_upstream_ref');
  });

  it('拒绝引用不存在的节点与非法引用格式', () => {
    const definition = baseDefinition();
    definition.nodes[1].config = {
      model: 'smart-model',
      userPrompt: [{ $ref: 'nodes.ghost.output.x' }, { $ref: 'not-a-valid-ref' }],
    };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('unknown_ref_node');
    expect(codes(result.issues)).toContain('invalid_ref');
  });

  it('节点实现版本必须落在白名单内', () => {
    const definition = baseDefinition();
    definition.nodes[1].implVersion = 2;
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('unsupported_impl_version');
  });

  it('缺少必填节点配置时报错并指出字段路径', () => {
    const definition = baseDefinition();
    definition.nodes[1].config = { systemPrompt: '缺少模型' };
    const result = validateDefinition(definition);
    const missing = result.issues.find((item) => item.code === 'missing_config');
    expect(missing).toBeDefined();
    expect(missing?.path).toBe('nodes.review.config.model');
  });

  it('工具节点不允许覆盖网关注入的 __ctx', () => {
    const definition = withNode(
      baseDefinition(),
      {
        id: 'writer',
        type: 'tool',
        implVersion: 1,
        config: { serverId: 'knowledge', tool: 'knowledge.upsert_document', args: { __ctx: { role: 'admin' } } },
      },
      [{ id: 't1', source: 'review', target: 'writer' }],
    );
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('ctx_override_forbidden');
  });

  it('模型与工具必须在调用者可用的资源白名单内', () => {
    const definition = baseDefinition();
    const result = validateDefinition(definition, {
      resources: { models: ['fast-model'], tools: ['knowledge/knowledge.search'] },
    });
    expect(codes(result.issues)).toContain('model_not_allowed');
  });

  it('提示词超长时报错', () => {
    const definition = baseDefinition();
    definition.nodes[1].config = {
      model: 'smart-model',
      systemPrompt: 'x'.repeat(STRUCTURE_LIMITS.maxPromptChars + 1),
    };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('prompt_too_long');
  });

  it('一次列全所有问题而不是遇到第一个就返回', () => {
    const definition = baseDefinition();
    definition.schemaVersion = 99;
    definition.name = '';
    definition.nodes[1].config = {};
    const result = validateDefinition(definition);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('受限引用', () => {
  it('解析 input 与 nodes 两种引用', () => {
    expect(parseRef('input.question')).toEqual({ kind: 'input', field: 'question' });
    expect(parseRef('nodes.review.output.risk')).toEqual({
      kind: 'node',
      nodeId: 'review',
      field: 'risk',
    });
  });

  it('拒绝非法引用形态', () => {
    expect(parseRef('')).toBeNull();
    expect(parseRef('nodes.review')).toBeNull();
    expect(parseRef('nodes.review.output')).toBeNull();
    expect(parseRef('secret.token')).toBeNull();
    expect(parseRef('input.question extra')).toBeNull();
  });

  it('区分「引用非法」与「引用合法但取值缺失」', () => {
    const ctx = { input: { question: '你好' }, nodes: { review: { output: { risk: 'high' } } } };
    expect(resolveRef('input.question', ctx)).toMatchObject({ valid: true, found: true, value: '你好' });
    expect(resolveRef('input.missing', ctx)).toMatchObject({ valid: true, found: false });
    expect(resolveRef('bad ref', ctx)).toMatchObject({ valid: false, found: false });
  });

  it('递归收集配置中的全部引用', () => {
    const refs = collectRefs({
      a: { $ref: 'input.x' },
      b: [{ $ref: 'nodes.n1.output.y' }, { deep: { $ref: 'input.z' } }],
    });
    expect(refs.sort()).toEqual(['input.x', 'input.z', 'nodes.n1.output.y']);
  });

  it('计算节点的祖先集合', () => {
    const definition = baseDefinition();
    const ancestors = ancestorsOf(definition, 'done');
    expect([...ancestors].sort()).toEqual(['review', 'start']);
  });
});

describe('JSON Schema 最小子集', () => {
  it('接受受支持的关键字', () => {
    const result = checkSchemaSchema({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', minLength: 1, maxLength: 10 } },
      additionalProperties: false,
    });
    expect(result.ok).toBe(true);
  });

  it('拒绝 pattern / $ref / 组合关键字', () => {
    for (const schema of [
      { type: 'string', pattern: '.*' },
      { $ref: '#/definitions/x' },
      { allOf: [{ type: 'object' }] },
      { anyOf: [{ type: 'object' }] },
      { oneOf: [{ type: 'object' }] },
      { not: { type: 'object' } },
      { if: { type: 'object' }, then: { type: 'object' } },
    ]) {
      const result = checkSchemaSchema(schema);
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('不支持的 Schema 关键字');
    }
  });

  it('校验数据时给出字段路径', () => {
    const schema = {
      type: 'object' as const,
      required: ['q'],
      properties: { q: { type: 'string' as const, maxLength: 3 } },
      additionalProperties: false,
    };
    expect(validateValue({ q: 'abc' }, schema)).toEqual([]);
    expect(validateValue({}, schema)[0]).toContain('$.q');
    expect(validateValue({ q: 'abcd' }, schema)[0]).toContain('长度不能大于');
    expect(validateValue({ q: 'a', extra: 1 }, schema)[0]).toContain('extra');
  });

  it('数值与数组的边界', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        n: { type: 'integer' as const, minimum: 1, maximum: 3 },
        list: { type: 'array' as const, items: { type: 'string' as const } },
      },
    };
    expect(validateValue({ n: 2, list: ['a'] }, schema)).toEqual([]);
    expect(validateValue({ n: 4 }, schema).length).toBeGreaterThan(0);
    expect(validateValue({ list: [1] }, schema)[0]).toContain('$.list[0]');
  });
});

describe('条件 AST 求值', () => {
  const ctx = {
    input: { question: '你好' },
    nodes: { review: { output: { risk: 'high', score: 90 } } },
  };

  it('比较算子按类型工作', () => {
    const expr: ConditionExpr = {
      all: [
        { left: { $ref: 'nodes.review.output.risk' }, operator: 'eq', right: 'high' },
        { left: { $ref: 'nodes.review.output.score' }, operator: 'gte', right: 80 },
      ],
    };
    expect(evaluateCondition(expr, ctx).value).toBe(true);
  });

  it('any / not 组合正确', () => {
    expect(
      evaluateCondition(
        { any: [{ left: 1, operator: 'eq', right: 2 }, { left: 1, operator: 'eq', right: 1 }] },
        ctx,
      ).value,
    ).toBe(true);
    expect(evaluateCondition({ not: { left: 1, operator: 'eq', right: 1 } }, ctx).value).toBe(false);
  });

  it('引用非法时报错并判 false，绝不默认走 true 分支', () => {
    const result = evaluateCondition(
      { left: { $ref: 'bad ref' }, operator: 'eq', right: 'x' },
      ctx,
    );
    expect(result.value).toBe(false);
    expect(codes(result.issues)).toContain('invalid_ref');
  });

  it('取值缺失时判 false，不做隐式默认值', () => {
    const result = evaluateCondition(
      { left: { $ref: 'nodes.review.output.missing' }, operator: 'eq', right: 'x' },
      ctx,
    );
    expect(result.value).toBe(false);
  });

  it('exists / not_exists 反映存在性', () => {
    expect(
      evaluateCondition({ left: { $ref: 'nodes.review.output.risk' }, operator: 'exists', right: null }, ctx).value,
    ).toBe(true);
    expect(
      evaluateCondition({ left: { $ref: 'nodes.review.output.nope' }, operator: 'not_exists', right: null }, ctx).value,
    ).toBe(true);
  });

  it('类型不可比时判 false', () => {
    expect(evaluateCondition({ left: 'abc', operator: 'gt', right: 1 }, ctx).value).toBe(false);
  });

  it('空 all / any 视为非法条件', () => {
    expect(evaluateCondition({ all: [] }, ctx).issues[0].code).toBe('invalid_condition');
    expect(evaluateCondition({ any: [] }, ctx).issues[0].code).toBe('invalid_condition');
  });
});

describe('限额', () => {
  it('业务用户提交的限额被平台上限截断', () => {
    const resolved = resolveLimits({ maxSteps: 9999, maxLlmCalls: 3 });
    expect(resolved.maxSteps).toBe(PLATFORM_LIMIT_CAPS.maxSteps);
    expect(resolved.maxLlmCalls).toBe(3);
  });

  it('未提交的项保持产品默认值', () => {
    const resolved = resolveLimits({ maxLlmCalls: 4 });
    expect(resolved.maxSteps).toBe(DEFAULT_LIMITS.maxSteps);
    expect(resolved.maxLlmCalls).toBe(4);
  });

  it('非法输入回落到默认值', () => {
    const resolved = resolveLimits({ maxSteps: -1, maxLlmCalls: Number.NaN });
    expect(resolved.maxSteps).toBe(DEFAULT_LIMITS.maxSteps);
    expect(resolved.maxLlmCalls).toBe(DEFAULT_LIMITS.maxLlmCalls);
  });

  it('审批等待时限不超过运行时长上限', () => {
    const resolved = resolveLimits({ timeoutMs: 1000, approvalTimeoutMs: 900_000 });
    expect(resolved.approvalTimeoutMs).toBeLessThanOrEqual(resolved.timeoutMs);
  });

  it('校验器拒绝超过平台上限的限额声明', () => {
    const definition = { ...baseDefinition(), limits: { maxSteps: 9999 } };
    const result = validateDefinition(definition, { platformLimits: PLATFORM_LIMIT_CAPS });
    expect(codes(result.issues)).toContain('limit_exceeded');
  });
});
