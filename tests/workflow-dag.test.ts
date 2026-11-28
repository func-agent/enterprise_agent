import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  PLATFORM_LIMIT_CAPS,
  STRUCTURE_LIMITS,
  WorkflowRuntime,
  WorkflowRuntimeError,
  ancestorsOf,
  checkSchemaSchema,
  collectRefs,
  effectiveLimitCap,
  evaluateCondition,
  getEffectiveOutputSchema,
  parseRef,
  resolveLimits,
  resolveRef,
  validateDefinition,
  validateValue,
  type ConditionExpr,
  type ValidationContext,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../packages/workflow-core/src/index.js';
import type { WorkflowStore } from '../packages/platform-core/src/index.js';

/**
 * 定义校验不通过时运行时就该停住，存储不该被访问。
 * 用「调用即失败」的桩，让用例真正卡在校验这一步而不是被存储实现带偏。
 */
function unreachableStore(): WorkflowStore {
  return new Proxy({}, {
    get() {
      throw new Error('定义校验未通过时不应访问存储');
    },
  }) as unknown as WorkflowStore;
}

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
  edges: { id: string; source: string; target: string; branch?: 'true' | 'false' | 'approved' | 'rejected' }[],
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
      evaluateCondition({ left: { $ref: 'nodes.review.output.risk' }, operator: 'exists' }, ctx).value,
    ).toBe(true);
    expect(
      evaluateCondition({ left: { $ref: 'nodes.review.output.nope' }, operator: 'not_exists' }, ctx).value,
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


describe('A1 不可信输入与边界回归', () => {
  function conditionDefinition(branch: unknown = 'true'): WorkflowDefinition {
    return {
      schemaVersion: 1,
      name: '条件校验',
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'branch', type: 'condition', config: { condition: { all: [1] } } },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'branch' },
        { id: 'e2', source: 'branch', target: 'done', branch: branch as 'true' },
        { id: 'e3', source: 'branch', target: 'done', branch: 'false' },
      ],
    };
  }

  it('节点 ID 不允许包含引用路径分隔符', () => {
    const definition = baseDefinition();
    definition.nodes[1].id = 'review.v1';
    expect(codes(validateDefinition(definition).issues)).toContain('invalid_node_id');
  });

  it('顶层 inputSchema 也必须符合受支持子集', () => {
    const definition = baseDefinition();
    definition.inputSchema = { type: 'string', pattern: '.*' } as unknown as WorkflowDefinition['inputSchema'];
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_schema');
    expect(result.issues.find((item) => item.code === 'invalid_schema')?.path).toBe('inputSchema');
  });

  it('config.outputSchema 不再成为第二套输出声明入口', () => {
    const definition = baseDefinition();
    definition.nodes[1].config = {
      model: 'smart-model',
      outputSchema: { type: 'string', pattern: '.*' },
    };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_config');
    expect(result.issues.some((item) => item.path === 'nodes.review.config.outputSchema')).toBe(true);
  });

  it('Schema 体积按 UTF-8 字节而不是字符数计算', () => {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = {
      type: 'object',
      description: '汉'.repeat(11_000),
      properties: { risk: { type: 'string' } },
    };
    expect(codes(validateDefinition(definition).issues)).toContain('schema_too_large');
  });

  it('拒绝引用未声明的输入和节点输出字段', () => {
    const definition = baseDefinition();
    definition.nodes[1].config = {
      model: 'smart-model',
      userPrompt: [{ $ref: 'input.nonexistent' }],
    };
    definition.nodes[2].config = {
      fields: { text: { $ref: 'nodes.review.output.nonexistent' } },
    };
    const result = validateDefinition(definition);
    expect(result.issues.filter((item) => item.code === 'unknown_ref_field')).toHaveLength(2);
  });

  it('未显式声明输出 Schema 时使用节点内置输出契约', () => {
    const definition = baseDefinition();
    delete definition.nodes[1].outputSchema;
    definition.nodes[2].config = { fields: { text: { $ref: 'nodes.review.output.text' } } };
    expect(validateDefinition(definition).ok).toBe(true);
  });

  it('显式输出 Schema 补充内置字段集合，内置字段仍可寻址', () => {
    const definition = baseDefinition();
    // baseDefinition 的 review 节点显式声明了 outputSchema（只含 risk），
    // 但执行器照样会产出 text / promptTokens 等内置字段，因此内置字段必须仍可寻址。
    definition.nodes[2].config = { fields: { text: { $ref: 'nodes.review.output.text' } } };
    expect(validateDefinition(definition).ok).toBe(true);
  });

  it('显式输出 Schema 与内置字段都不存在的字段仍被拒绝', () => {
    const definition = baseDefinition();
    definition.nodes[2].config = { fields: { text: { $ref: 'nodes.review.output.nope' } } };
    expect(codes(validateDefinition(definition).issues)).toContain('unknown_ref_field');
  });

  it('null 节点和边只返回校验问题，不抛异常', () => {
    const nullNode = { ...baseDefinition(), nodes: [null] } as unknown as WorkflowDefinition;
    const nullEdge = { ...baseDefinition(), edges: [null] } as unknown as WorkflowDefinition;
    expect(() => validateDefinition(nullNode)).not.toThrow();
    expect(() => validateDefinition(nullEdge)).not.toThrow();
    expect(validateDefinition(nullNode).ok).toBe(false);
    expect(validateDefinition(nullEdge).ok).toBe(false);
  });

  it('非法条件 AST 在发布校验和直接求值时均安全失败', () => {
    const definition = conditionDefinition();
    expect(codes(validateDefinition(definition).issues)).toContain('invalid_condition');
    const result = evaluateCondition({ all: [1] } as unknown as ConditionExpr, {});
    expect(result.value).toBe(false);
    expect(codes(result.issues)).toContain('invalid_condition');
  });

  it('not 不会把非法引用反转为 true', () => {
    const result = evaluateCondition(
      { not: { left: { $ref: 'bad ref' }, operator: 'eq', right: 'x' } },
      {},
    );
    expect(result.value).toBe(false);
    expect(codes(result.issues)).toContain('invalid_ref');
  });

  it('二元比较的任一操作数缺失都不会形成肯定结果', () => {
    const result = evaluateCondition(
      { left: 'configured', operator: 'ne', right: { $ref: 'input.missing' } },
      {},
    );
    expect(result.value).toBe(false);
    expect(codes(result.issues)).toContain('missing_operand');
    const negated = evaluateCondition(
      { not: { left: { $ref: 'input.missing' }, operator: 'eq', right: 'x' } },
      {},
    );
    expect(negated.value).toBe(false);
    expect(codes(negated.issues)).toContain('missing_operand');
  });

  it('限制条件 AST 嵌套深度', () => {
    let expr: ConditionExpr = { left: true, operator: 'is_true' };
    for (let index = 0; index < 40; index += 1) expr = { not: expr };
    const result = evaluateCondition(expr, {});
    expect(result.value).toBe(false);
    expect(codes(result.issues)).toContain('invalid_condition');
  });

  it('普通节点禁止 branch，条件节点必须显式标记合法分支', () => {
    const normal = baseDefinition();
    normal.edges[1].branch = 'true';
    expect(codes(validateDefinition(normal).issues)).toContain('invalid_branch');

    const missing = conditionDefinition();
    delete missing.edges[1].branch;
    const missingResult = validateDefinition(missing);
    expect(codes(missingResult.issues)).toContain('invalid_branch');
    expect(codes(missingResult.issues)).toContain('missing_branch');
    expect(codes(validateDefinition(conditionDefinition('maybe')).issues)).toContain('invalid_branch');
  });

  it('必填配置必须通过运行时类型检查，未知配置字段被拒绝', () => {
    const definition = baseDefinition();
    definition.nodes[1].config = { model: 123, baseUrl: 'https://provider.invalid' };
    const result = validateDefinition(definition, { resources: { models: ['smart-model'] } });
    expect(result.ok).toBe(false);
    expect(result.issues.filter((item) => item.code === 'invalid_config').length).toBeGreaterThanOrEqual(2);
  });

  it('校验 Agent 配置及其工具白名单', () => {
    const definition = withNode(
      baseDefinition(),
      {
        id: 'agent',
        type: 'agent',
        config: { model: 'smart-model', maxIterations: 1, allowedTools: ['knowledge/knowledge.search'] },
      },
      [
        { id: 'a1', source: 'review', target: 'agent' },
        { id: 'a2', source: 'agent', target: 'done' },
      ],
    );
    const result = validateDefinition(definition, { resources: { models: ['smart-model'], tools: [] } });
    expect(codes(result.issues)).toContain('tool_not_allowed');
    definition.nodes[3].config = { model: 'smart-model', maxIterations: 0, allowedTools: [1] };
    expect(codes(validateDefinition(definition).issues)).toContain('invalid_config');
  });

  it('知识范围按当前调用者白名单校验', () => {
    const definition = withNode(
      baseDefinition(),
      {
        id: 'knowledge',
        type: 'knowledge',
        config: { query: { $ref: 'input.question' }, knowledgeScope: 'hr', topK: 5 },
      },
      [
        { id: 'k1', source: 'review', target: 'knowledge' },
        { id: 'k2', source: 'knowledge', target: 'done' },
      ],
    );
    const denied = validateDefinition(definition, { resources: { knowledgeScopes: ['finance'] } });
    expect(codes(denied.issues)).toContain('knowledge_scope_not_allowed');
    const allowed = validateDefinition(definition, { resources: { knowledgeScopes: ['hr'] } });
    expect(codes(allowed.issues)).not.toContain('knowledge_scope_not_allowed');
  });

  it('平台上限同时约束产品默认值和用户提交值', () => {
    const caps = {
      maxSteps: 10,
      maxLlmCalls: 5,
      maxToolCalls: 3,
      timeoutMs: 60_000,
      approvalTimeoutMs: 30_000,
    };
    expect(resolveLimits(undefined, caps)).toEqual(caps);
    expect(resolveLimits({ maxSteps: 20 }, caps).maxSteps).toBe(10);
  });

  it('非法限额和审批时间倒序会被定义校验拒绝', () => {
    const definition = {
      ...baseDefinition(),
      limits: { maxSteps: 1.5, timeoutMs: 1000, approvalTimeoutMs: 2000 },
    };
    const result = validateDefinition(definition);
    expect(result.issues.filter((item) => item.code === 'invalid_limits')).toHaveLength(2);
  });

  it('超深配置和带额外字段的引用对象会被拒绝', () => {
    const definition = baseDefinition();
    let prompt: unknown = 'x';
    for (let index = 0; index < 70; index += 1) prompt = { next: prompt };
    definition.nodes[1].config = { model: 'smart-model', userPrompt: prompt };
    expect(codes(validateDefinition(definition).issues)).toContain('config_too_deep');

    definition.nodes[1].config = {
      model: 'smart-model',
      userPrompt: [{ $ref: 'input.question', unexpected: true }],
    };
    expect(codes(validateDefinition(definition).issues)).toContain('invalid_ref');
  });

  it('Schema null、额外字段放行及矛盾边界均被拒绝', () => {
    expect(checkSchemaSchema(null).ok).toBe(false);
    expect(checkSchemaSchema({ type: 'object', additionalProperties: true }).ok).toBe(false);
    expect(checkSchemaSchema({ type: 'string', minLength: -1 }).ok).toBe(false);
    expect(checkSchemaSchema({ type: 'string', minLength: 5, maxLength: 2 }).ok).toBe(false);
    expect(checkSchemaSchema({ type: 'number', minimum: 5, maximum: 2 }).ok).toBe(false);
    expect(validateValue(Number.NaN, { type: 'number' })).not.toEqual([]);
    expect(validateValue(Number.POSITIVE_INFINITY, { type: 'number' })).not.toEqual([]);
  });
});

describe('A1 复核修复回归', () => {
  const ctx = {
    input: { question: '你好', count: 3 },
    nodes: { review: { output: { risk: 'high', text: '结论' } } },
  };

  it('一元算子不必带 right，且带 right 会被拒绝', () => {
    const exists = evaluateCondition({ left: { $ref: 'nodes.review.output.risk' }, operator: 'exists' }, ctx);
    expect(exists.value).toBe(true);
    expect(exists.issues).toEqual([]);

    const missing = evaluateCondition({ left: { $ref: 'nodes.review.output.nope' }, operator: 'not_exists' }, ctx);
    expect(missing.value).toBe(true);
    expect(missing.issues).toEqual([]);

    const withRight = evaluateCondition(
      { left: { $ref: 'nodes.review.output.risk' }, operator: 'exists', right: null },
      ctx,
    );
    expect(withRight.value).toBe(false);
    expect(codes(withRight.issues)).toContain('invalid_condition');
  });

  it('一元算子可以发布，二元算子缺 right 仍被拒绝', () => {
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      name: '存在性条件',
      inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
      nodes: [
        { id: 'start', type: 'input', config: { fields: ['question'] } },
        { id: 'cond', type: 'condition', config: { condition: { left: { $ref: 'input.question' }, operator: 'exists' } } },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'cond' },
        { id: 'e2', source: 'cond', target: 'done', branch: 'true' },
        { id: 'e3', source: 'cond', target: 'done', branch: 'false' },
      ],
    };
    expect(validateDefinition(definition).ok).toBe(true);

    definition.nodes[1].config = { condition: { left: { $ref: 'input.question' }, operator: 'eq' } as never };
    expect(codes(validateDefinition(definition).issues)).toContain('invalid_condition');
  });

  it('contains / not_contains 的左值不可比较时判 false 并给出问题', () => {
    const result = evaluateCondition(
      { left: { $ref: 'input.count' }, operator: 'not_contains', right: 'x' },
      ctx,
    );
    expect(result.value).toBe(false);
    expect(codes(result.issues)).toContain('invalid_operand');

    const searchable = evaluateCondition(
      { left: { $ref: 'nodes.review.output.text' }, operator: 'not_contains', right: 'zzz' },
      ctx,
    );
    expect(searchable.value).toBe(true);
    expect(searchable.issues).toEqual([]);
  });

  it('平台上限只覆盖部分项时不产生 NaN', () => {
    const resolved = resolveLimits(undefined, { maxSteps: 10 });
    expect(resolved.maxSteps).toBe(10);
    for (const value of Object.values(resolved)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(resolved.maxLlmCalls).toBe(DEFAULT_LIMITS.maxLlmCalls);
    expect(resolved.timeoutMs).toBe(DEFAULT_LIMITS.timeoutMs);
  });

  it('平台上限只覆盖部分项时超限提交仍被拒绝', () => {
    const definition = { ...baseDefinition(), limits: { timeoutMs: 9_999_999 } };
    const result = validateDefinition(definition, { platformLimits: { maxSteps: 10 } });
    expect(codes(result.issues)).toContain('limit_exceeded');
  });

  it('资源白名单按类别报告，未注入所需类别时明确标记为未校验', () => {
    expect(validateDefinition(baseDefinition()).resourceCheck).toEqual({
      models: 'skipped',
      tools: 'not_required',
      knowledgeScopes: 'not_required',
    });
    expect(
      validateDefinition(baseDefinition(), { resources: { models: [] } }).resourceCheck,
    ).toEqual({
      models: 'performed',
      tools: 'not_required',
      knowledgeScopes: 'not_required',
    });
    expect(
      validateDefinition(baseDefinition(), { resources: {} }).resourceCheck,
    ).toEqual({
      models: 'skipped',
      tools: 'not_required',
      knowledgeScopes: 'not_required',
    });
  });

  it('输入表单必须覆盖 inputSchema 的必填字段', () => {
    const definition = baseDefinition();
    definition.nodes[0].config = { fields: ['other'] };
    definition.inputSchema = {
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string' }, other: { type: 'string' } },
    };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_config');
    expect(result.issues.some((item) => item.message.includes('必填字段'))).toBe(true);
  });

  it('Schema 的必填字段必须在 properties 中声明', () => {
    const result = checkSchemaSchema({
      type: 'object',
      required: ['missing'],
      properties: { question: { type: 'string' } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('missing');
  });

  it('Agent 工具标识必须是 serverId/tool 格式', () => {
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      name: 'Agent 工具',
      inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
      nodes: [
        { id: 'start', type: 'input', config: { fields: ['question'] } },
        { id: 'agent', type: 'agent', config: { model: 'smart-model', allowedTools: ['knowledge.search'] } },
        { id: 'done', type: 'output' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'agent' },
        { id: 'e2', source: 'agent', target: 'done' },
      ],
    };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_config');
    expect(result.issues.some((item) => item.message.includes('serverId/tool'))).toBe(true);
  });

  it('深度上限统一来自结构常量', () => {
    expect(STRUCTURE_LIMITS.maxConfigDepth).toBeGreaterThan(0);
    expect(STRUCTURE_LIMITS.maxConditionDepth).toBeGreaterThan(0);
    expect(STRUCTURE_LIMITS.maxConditionDepth).toBeLessThan(STRUCTURE_LIMITS.maxConfigDepth);
  });
});


describe('A1 二次复核修复回归', () => {
  function definitionWithTool(): WorkflowDefinition {
    const definition = baseDefinition();
    definition.nodes.splice(2, 0, {
      id: 'writer',
      type: 'tool',
      config: { serverId: 'knowledge', tool: 'knowledge.search' },
    });
    definition.edges.push(
      { id: 't1', source: 'review', target: 'writer' },
      { id: 't2', source: 'writer', target: 'done' },
    );
    return definition;
  }

  it('部分资源注入不会被误报为其他类别已校验', () => {
    expect(validateDefinition(baseDefinition(), { resources: { tools: [] } }).resourceCheck).toEqual({
      models: 'skipped',
      tools: 'not_required',
      knowledgeScopes: 'not_required',
    });

    const partial = validateDefinition(definitionWithTool(), {
      resources: { models: ['smart-model'] },
    });
    expect(partial.resourceCheck).toEqual({
      models: 'performed',
      tools: 'skipped',
      knowledgeScopes: 'not_required',
    });

    const complete = validateDefinition(definitionWithTool(), {
      resources: { models: ['smart-model'], tools: ['knowledge/knowledge.search'] },
    });
    expect(complete.ok).toBe(true);
    expect(complete.resourceCheck).toEqual({
      models: 'performed',
      tools: 'performed',
      knowledgeScopes: 'not_required',
    });
  });

  it('不使用外部资源的流程不需要资源白名单', () => {
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      name: '纯数据流程',
      inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
      nodes: [
        { id: 'start', type: 'input', config: { fields: ['question'] } },
        { id: 'done', type: 'output', config: { fields: {} } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'done' }],
    };
    expect(validateDefinition(definition).resourceCheck).toEqual({
      models: 'not_required',
      tools: 'not_required',
      knowledgeScopes: 'not_required',
    });
  });

  it('正小数限额向下取整且最小为 1，不会回落放大', () => {
    expect(resolveLimits(undefined, { maxSteps: 0.5 }).maxSteps).toBe(1);
    expect(resolveLimits({ maxSteps: 0.5 }).maxSteps).toBe(1);
    expect(resolveLimits({ timeoutMs: 0.5 }).timeoutMs).toBe(1);
    expect(resolveLimits({ maxSteps: 20 }, { maxSteps: 10.8 }).maxSteps).toBe(10);
    expect(resolveLimits({ maxSteps: 1.5 }).maxSteps).toBe(1);
    expect(resolveLimits({ timeoutMs: 1500.5 }).timeoutMs).toBe(1500);
    expect(effectiveLimitCap({ maxSteps: 10.8 }, 'maxSteps')).toBe(10);
    expect(effectiveLimitCap({ timeoutMs: 60_000.5 }, 'timeoutMs')).toBe(60_000);
    expect(effectiveLimitCap({ maxSteps: 0.5 }, 'maxSteps')).toBe(1);
    for (const value of Object.values(resolveLimits(undefined, { timeoutMs: 60_000.5 }))) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('非空 required 必须配合 properties 声明', () => {
    const result = checkSchemaSchema({ type: 'object', required: ['question'] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('properties');
    expect(checkSchemaSchema({ type: 'object', required: [] }).ok).toBe(true);
  });

  it('普通工具节点与 Agent 使用同一工具标识格式', () => {
    const definition = definitionWithTool();
    definition.nodes[2].config = { serverId: 'bad/server', tool: 'search' };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_config');
    expect(result.issues.some((item) => item.message.includes('serverId/tool'))).toBe(true);
  });

  it('有效输出 Schema 合并内置字段，additionalProperties 不会误伤它们', () => {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = {
      type: 'object',
      properties: { risk: { type: 'string' } },
      additionalProperties: false,
    };
    const schema = getEffectiveOutputSchema(definition.nodes[1], definition);
    expect(schema?.properties).toMatchObject({
      risk: { type: 'string' },
      text: { type: 'string' },
      traceId: { type: 'string' },
    });
    expect(validateValue({ risk: 'high', text: '结论', traceId: 'trace-1' }, schema)).toEqual([]);
    expect(validateValue({ risk: 'high', unexpected: true }, schema)).not.toEqual([]);
  });

  it('节点输出 Schema 根类型必须是对象', () => {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = { type: 'string' };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_schema');
    expect(result.issues.some((item) => item.path === 'nodes.review.outputSchema.type')).toBe(true);
  });
});

describe('A1 三次复核修复回归', () => {
  it('平台上限写成小数时按向下取整后的上限判定', () => {
    const definition = { ...baseDefinition(), limits: { maxSteps: 12 } };
    const result = validateDefinition(definition, { platformLimits: { maxSteps: 11.5 } });
    expect(codes(result.issues)).toContain('limit_exceeded');

    const under = { ...baseDefinition(), limits: { maxSteps: 11 } };
    expect(codes(validateDefinition(under, { platformLimits: { maxSteps: 11.5 } }).issues))
      .not.toContain('limit_exceeded');

    const subOne = { ...baseDefinition(), limits: { maxSteps: 2 } };
    expect(codes(validateDefinition(subOne, { platformLimits: { maxSteps: 0.5 } }).issues))
      .toContain('limit_exceeded');
  });

  it('请求限额写成小数时向下取整，不放大到默认值', () => {
    expect(resolveLimits({ maxSteps: 1.5 }).maxSteps).toBe(1);
    expect(resolveLimits({ timeoutMs: 1500.5 }).timeoutMs).toBe(1500);
    expect(resolveLimits({ maxSteps: 0.5 }).maxSteps).toBe(1);
  });

  it('自定义输出 Schema 不得改写内置字段的类型', () => {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = {
      type: 'object',
      properties: { text: { type: 'number' } },
    };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_schema');
    expect(
      result.issues.some((item) => item.path === 'nodes.review.outputSchema.properties.text.type'),
    ).toBe(true);

    // 即便绕过了发布校验，合并结果仍以内置类型为准，
    // 执行器拿到的口径不会被自定义 Schema 改写。
    const schema = getEffectiveOutputSchema(definition.nodes[1], definition);
    expect(schema?.properties?.text).toMatchObject({ type: 'string' });
    expect(validateValue({ text: '结论' }, schema)).toEqual([]);
  });

  it('自定义输出 Schema 补充内置字段的约束不算改写', () => {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 10 } },
    };
    expect(codes(validateDefinition(definition).issues)).not.toContain('invalid_schema');
    const schema = getEffectiveOutputSchema(definition.nodes[1], definition);
    expect(schema?.properties?.text).toMatchObject({ type: 'string', maxLength: 10 });
  });

  it('顶层 inputSchema 根类型必须显式为 object', () => {
    const definition = baseDefinition();
    definition.inputSchema = { type: 'string' } as unknown as WorkflowDefinition['inputSchema'];
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_schema');
    expect(result.issues.some((item) => item.path === 'inputSchema.type')).toBe(true);

    definition.inputSchema = {
      properties: { question: { type: 'string' } },
    } as unknown as WorkflowDefinition['inputSchema'];
    expect(codes(validateDefinition(definition).issues)).toContain('invalid_schema');
  });

  it('节点输出 Schema 缺少 type 时同样被拒绝', () => {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = {
      properties: { risk: { type: 'string' } },
    } as unknown as WorkflowDefinition['nodes'][number]['outputSchema'];
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_schema');
    expect(result.issues.some((item) => item.path === 'nodes.review.outputSchema.type')).toBe(true);
  });

  it('节点被丢弃时资源需求不能跟着漏报', () => {
    const definition = baseDefinition();
    definition.nodes[1].id = 'bad.id';
    const result = validateDefinition(definition);
    expect(result.ok).toBe(false);
    // 该定义实际含 llm 节点，模型白名单属于「需要但未校验」，
    // 不能因为节点 ID 非法被丢弃就报成不需要。
    expect(result.resourceCheck.models).toBe('skipped');
  });
});


describe('A1 四次复核修复回归', () => {
  it('自定义 Schema 不能放松内置 Token 非负约束', () => {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = {
      type: 'object',
      properties: { promptTokens: { type: 'integer', minimum: -100 } },
    };
    definition.nodes[2].config = { fields: { tokens: { $ref: 'nodes.review.output.promptTokens' } } };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_schema');
    expect(result.issues.some((item) => item.path === 'nodes.review.outputSchema.properties.promptTokens.minimum')).toBe(true);

    const schema = getEffectiveOutputSchema(definition.nodes[1], definition);
    expect(schema?.properties?.promptTokens).toMatchObject({ type: 'integer', minimum: 0 });
    expect(validateValue({ promptTokens: -5 }, schema)).not.toEqual([]);

    definition.nodes[1].outputSchema = {
      type: 'object',
      properties: { promptTokens: { type: 'integer', maximum: -1 } },
    };
    expect(codes(validateDefinition(definition).issues)).toContain('invalid_schema');
  });

  it('自定义 Schema 可以收紧但不能越过内置范围', () => {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = {
      type: 'object',
      properties: { promptTokens: { type: 'integer', minimum: 1, maximum: 100 } },
    };
    definition.nodes[2].config = { fields: { tokens: { $ref: 'nodes.review.output.promptTokens' } } };
    expect(validateDefinition(definition).ok).toBe(true);
    const schema = getEffectiveOutputSchema(definition.nodes[1], definition);
    expect(schema?.properties?.promptTokens).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    expect(validateValue({ promptTokens: 1 }, schema)).toEqual([]);
    expect(validateValue({ promptTokens: 0 }, schema)).not.toEqual([]);
    expect(validateValue({ promptTokens: 101 }, schema)).not.toEqual([]);
  });

  it('人工审核节点的线性流程（出边不带 branch）可以发布', () => {
    const definition = withNode(
      baseDefinition(),
      { id: 'gate', type: 'approval', implVersion: 1, config: { title: '人工复核' } },
      [
        { id: 'g1', source: 'review', target: 'gate' },
        { id: 'g2', source: 'gate', target: 'done' },
      ],
    );
    const result = validateDefinition(definition);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('人工审核节点一旦带分支标记，所有出边都必须使用 approved / rejected', () => {
    const definition = withNode(
      baseDefinition(),
      { id: 'gate', type: 'approval', implVersion: 1, config: { title: '人工复核' } },
      [
        { id: 'g1', source: 'review', target: 'gate' },
        { id: 'g2', source: 'gate', target: 'done', branch: 'approved' },
        // 同一审核节点的另一条出边没带分支标记 → 分支语义不完整
        { id: 'g3', source: 'gate', target: 'start' },
      ],
    );
    const result = validateDefinition(definition);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('invalid_branch');
  });

  it('条件操作数内部不允许出现原型污染键', () => {
    const definition = withNode(
      baseDefinition(),
      {
        id: 'branch',
        type: 'condition',
        implVersion: 1,
        // 载荷：通过原型注入属性
        config: { condition: JSON.parse('{"left": {"__proto__": {"x": 1}}, "operator": "eq", "right": 1}') },
      },
      [
        { id: 'b1', source: 'review', target: 'branch' },
        { id: 'b2', source: 'branch', target: 'done', branch: 'true' },
        { id: 'b3', source: 'branch', target: 'done', branch: 'false' },
      ],
    );
    const result = validateDefinition(definition);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('invalid_condition');
    expect(result.issues.some((item) => item.message.includes('原型污染'))).toBe(true);
  });

  it('条件操作数只允许字面量或顶层引用，嵌套引用在发布期被拒绝', () => {
    const definition = withNode(
      baseDefinition(),
      {
        id: 'branch',
        type: 'condition',
        implVersion: 1,
        config: { condition: { left: { v: { $ref: 'input.question' } }, operator: 'eq', right: 'hello' } },
      },
      [
        { id: 'b1', source: 'review', target: 'branch' },
        { id: 'b2', source: 'branch', target: 'done', branch: 'true' },
        { id: 'b3', source: 'branch', target: 'done', branch: 'false' },
      ],
    );
    const result = validateDefinition(definition);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('invalid_condition');
    expect(result.issues.some((item) => item.message.includes('嵌套引用'))).toBe(true);
  });

  it('节点类型取自原型链上的名字时只报问题，不抛异常', () => {
    // 不可信输入可能把 type 写成 constructor / toString 这类继承自 Object.prototype 的名字。
    // 查表必须只认自有属性，否则校验器会从原型链上取到函数并崩掉。
    for (const type of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const definition = baseDefinition();
      definition.nodes[1] = { ...definition.nodes[1], type } as never;
      const result = validateDefinition(definition);
      expect(result.ok).toBe(false);
      expect(codes(result.issues)).toContain('unknown_node_type');
    }
  });

  it('条件操作数里的嵌套引用在数组元素中同样被拒绝', () => {
    const definition = withNode(
      baseDefinition(),
      {
        id: 'branch',
        type: 'condition',
        implVersion: 1,
        config: { condition: { left: [{ $ref: 'input.question' }], operator: 'eq', right: 'hello' } },
      },
      [
        { id: 'b1', source: 'review', target: 'branch' },
        { id: 'b2', source: 'branch', target: 'done', branch: 'true' },
        { id: 'b3', source: 'branch', target: 'done', branch: 'false' },
      ],
    );
    const result = validateDefinition(definition);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('invalid_condition');
  });

  it('条件操作数超过配置深度上限时报错，不允许静默放行', () => {
    let nested: unknown = { $ref: 'input.question' };
    for (let i = 0; i < 70; i += 1) nested = { v: nested };
    const definition = withNode(
      baseDefinition(),
      {
        id: 'branch',
        type: 'condition',
        implVersion: 1,
        config: { condition: { left: nested, operator: 'eq', right: 'hello' } },
      },
      [
        { id: 'b1', source: 'review', target: 'branch' },
        { id: 'b2', source: 'branch', target: 'done', branch: 'true' },
        { id: 'b3', source: 'branch', target: 'done', branch: 'false' },
      ],
    );
    const result = validateDefinition(definition);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('config_too_deep');
  });

  it('节点数超过平台上限时立即拒绝，不做全量祖先计算', () => {
    // 超限定义本来就不可能通过发布；继续全量计算会把一次校验放大成 O(N×(N+E))，
    // 给发布 / 启动接口留下可被恶意输入放大的 CPU 消耗点。
    const definition = baseDefinition();
    definition.nodes = [];
    definition.edges = [];
    for (let i = 0; i < 6000; i += 1) {
      definition.nodes.push({
        id: `n${i}`, type: 'llm', implVersion: 1,
        config: { model: 'smart-model', systemPrompt: 's', userPrompt: [], maxOutputTokens: 8 },
      } as never);
      if (i > 0) definition.edges.push({ id: `e${i}`, source: `n${i - 1}`, target: `n${i}` } as never);
    }
    const started = Date.now();
    const result = validateDefinition(definition);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('too_many_nodes');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('同名字段的 enum 只能缩小内置取值集合', () => {
    const definition = baseDefinition();
    definition.inputSchema = {
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string', enum: ['a', 'b'] } },
    };
    definition.nodes[0].outputSchema = {
      type: 'object',
      properties: { question: { type: 'string', enum: ['a', 'c'] } },
    };
    definition.nodes[2].config = { fields: { text: { $ref: 'nodes.start.output.question' } } };
    const result = validateDefinition(definition);
    expect(codes(result.issues)).toContain('invalid_schema');
    expect(result.issues.some((item) => item.path === 'nodes.start.outputSchema.properties.question.enum')).toBe(true);

    const schema = getEffectiveOutputSchema(definition.nodes[0], definition);
    expect(schema?.properties?.question?.enum).toEqual(['a']);
  });
});

describe('A1 五次复核修复回归', () => {
  /** 构造「内置输出字段名 + 非法 required」的畸形定义。 */
  function malformedRequiredDefinition(required: unknown): WorkflowDefinition {
    const definition = baseDefinition();
    definition.nodes[1].outputSchema = {
      type: 'object',
      properties: { text: { type: 'string', required } },
    } as unknown as WorkflowDefinition['nodes'][number]['outputSchema'];
    return definition;
  }

  it('自定义输出 Schema 的 required 形态非法时只报校验问题，不抛异常', () => {
    for (const required of [5, true, 'risk', { a: 1 }]) {
      const definition = malformedRequiredDefinition(required);
      // 合并内置字段与自定义字段是这条路径的必经环节：形态非法时不能在这里崩掉。
      expect(() => validateDefinition(definition)).not.toThrow();
      const result = validateDefinition(definition);
      expect(result.ok).toBe(false);
      expect(codes(result.issues)).toContain('invalid_schema');
    }
  });

  it('字符串形态的 required 不会被逐字符展开成假约束', () => {
    const definition = malformedRequiredDefinition('risk');
    const result = validateDefinition(definition);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('invalid_schema');

    // 合并结果里不能出现 ['r','i','s','k'] 这种看着合法的假必填列表。
    const schema = getEffectiveOutputSchema(definition.nodes[1], definition);
    expect(schema?.properties?.text?.required ?? []).toEqual([]);
  });

  it('畸形定义走运行时启动时抛 WorkflowRuntimeError 而不是裸 TypeError', async () => {
    const definition = malformedRequiredDefinition(5);
    const runtime = new WorkflowRuntime({ store: unreachableStore() });
    const error = await runtime.start({
      tenantId: 't-1',
      workflowId: 'wf-1',
      workflowVersion: 1,
      initiatorId: 'u-1',
      identitySnapshot: { sub: 'u-1' },
      input: { question: '制度有哪些风险？' },
      mode: 'debug',
      definition,
      definitionChecksum: 'checksum-1',
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkflowRuntimeError);
    expect((error as WorkflowRuntimeError).code).toBe('invalid_definition');
  });

  it('节点实现版本白名单表项不是数组时只报校验问题，不抛异常', () => {
    for (const table of [{ llm: {} }, { llm: '1' }, { llm: 5 }]) {
      expect(() => validateDefinition(baseDefinition(), {
        nodeImplementations: table as unknown as ValidationContext['nodeImplementations'],
      })).not.toThrow();
      const result = validateDefinition(baseDefinition(), {
        nodeImplementations: table as unknown as ValidationContext['nodeImplementations'],
      });
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('validateValue 对畸形 Schema 返回错误列表而不是抛异常', () => {
    const malformed: unknown[] = [
      { type: 'object', required: true },
      { type: 'object', required: 5 },
      { type: 'object', enum: 'abc' },
      { type: 'object', enum: 5 },
      { type: 'object', properties: 'abc' },
      { type: 'object', items: 5 },
    ];
    for (const schema of malformed) {
      let errors: string[] | null = null;
      expect(() => {
        errors = validateValue({ a: 1 }, schema as never);
      }).not.toThrow();
      expect(errors).not.toEqual([]);
      // 发布期与数据期对同一形态必须给出同一结论。
      expect(checkSchemaSchema(schema).ok).toBe(false);
    }
  });

  it('Agent 配置了工具键时必须计入工具需求，形态非法也不能标成不需要工具', () => {
    const definition = baseDefinition();
    definition.nodes[1] = {
      id: 'agent',
      type: 'agent',
      implVersion: 1,
      config: { model: 'smart-model', allowedTools: 'srv/tool' },
    } as unknown as WorkflowDefinition['nodes'][number];
    definition.edges = [
      { id: 'e1', source: 'start', target: 'agent' },
      { id: 'e2', source: 'agent', target: 'done' },
    ];

    const result = validateDefinition(definition);
    expect(result.resourceCheck.tools).not.toBe('not_required');
    // 形态非法本身仍是配置问题。
    expect(codes(result.issues)).toContain('invalid_config');
  });

  it('Agent 合法工具数组与未配置工具时保持原有资源口径', () => {
    const withTools = baseDefinition();
    withTools.nodes[1] = {
      id: 'agent',
      type: 'agent',
      implVersion: 1,
      config: { model: 'smart-model', allowedTools: ['srv/tool'] },
    } as unknown as WorkflowDefinition['nodes'][number];
    withTools.edges = [
      { id: 'e1', source: 'start', target: 'agent' },
      { id: 'e2', source: 'agent', target: 'done' },
    ];
    expect(validateDefinition(withTools, { resources: { tools: ['srv/tool'] } }).resourceCheck.tools)
      .toBe('performed');

    const withoutTools = baseDefinition();
    withoutTools.nodes[1] = {
      id: 'agent',
      type: 'agent',
      implVersion: 1,
      config: { model: 'smart-model' },
    } as unknown as WorkflowDefinition['nodes'][number];
    withoutTools.edges = [
      { id: 'e1', source: 'start', target: 'agent' },
      { id: 'e2', source: 'agent', target: 'done' },
    ];
    expect(validateDefinition(withoutTools).resourceCheck.tools).toBe('not_required');
  });
});
