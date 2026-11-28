import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  SqliteMetadataStore,
  type MetadataStore,
  type WorkflowRunRecord,
} from '../packages/platform-core/src/index.js';
import {
  WorkflowNodeError,
  WorkflowRuntime,
  WorkflowRuntimeError,
  DEFAULT_CONCURRENCY_LIMITS,
  InMemoryWorkflowConcurrencyPort,
  PLATFORM_CONCURRENCY_LIMIT_CAPS,
  assertRunTransition,
  canTransitionRun,
  canTransitionStep,
  resolveConcurrencyLimits,
  topologicalOrder,
  validateDefinition,
  type WorkflowConcurrencyPort,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeHandler,
  type WorkflowNodeSuccess,
  type WorkflowRuntimeOptions,
  type WorkflowStartRequest,
} from '../packages/workflow-core/src/index.js';

const T0 = Date.parse('2026-11-27T00:00:00.000Z');
const tenantId = 't-1';
const resources = {
  models: ['smart-model'],
  tools: ['mcp/read', 'mcp/write'],
  knowledgeScopes: ['scope-1'],
};

function startNode(): WorkflowNode {
  return { id: 'start', type: 'input', implVersion: 1, config: { fields: ['question', 'risk'] } };
}

function llmNode(id: string, userPrompt: unknown = [{ $ref: 'input.question' }]): WorkflowNode {
  return {
    id,
    type: 'llm',
    implVersion: 1,
    config: { model: 'smart-model', userPrompt, maxOutputTokens: 128 },
  };
}

function outputNode(fields: Record<string, unknown> = { text: { $ref: 'nodes.review.output.text' } }): WorkflowNode {
  return { id: 'done', type: 'output', implVersion: 1, config: { fields } };
}

function simpleDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    name: '运行时契约',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' }, risk: { type: 'string' } },
    },
    nodes: [startNode(), llmNode('review'), outputNode()],
    edges: [
      { id: 'e1', source: 'start', target: 'review' },
      { id: 'e2', source: 'review', target: 'done' },
    ],
  };
}

function toolDefinition(kind: 'read' | 'write' = 'write'): WorkflowDefinition {
  return {
    ...simpleDefinition(),
    nodes: [
      startNode(),
      {
        id: 'action', type: 'tool', implVersion: 1,
        config: { serverId: 'mcp', tool: kind, args: { query: { $ref: 'nodes.start.output.question' } } },
      },
      outputNode({ content: { $ref: 'nodes.action.output.content' } }),
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'action' },
      { id: 'e2', source: 'action', target: 'done' },
    ],
  };
}

function branchDefinition(): WorkflowDefinition {
  return {
    ...simpleDefinition(),
    nodes: [
      startNode(),
      {
        id: 'decide', type: 'condition', implVersion: 1,
        config: { condition: { left: { $ref: 'input.risk' }, operator: 'eq', right: 'high' } },
      },
      llmNode('high'),
      llmNode('low'),
      llmNode('lowDetail', [{ $ref: 'nodes.low.output.text' }]),
      outputNode({
        high: { $ref: 'nodes.high.output.text' },
        low: { $ref: 'nodes.lowDetail.output.text' },
      }),
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'decide' },
      { id: 'e2', source: 'decide', target: 'high', branch: 'true' },
      { id: 'e3', source: 'decide', target: 'low', branch: 'false' },
      { id: 'e4', source: 'low', target: 'lowDetail' },
      { id: 'e5', source: 'high', target: 'done' },
      { id: 'e6', source: 'lowDetail', target: 'done' },
    ],
  };
}

/** 人工审核节点：审核通过走写工具，驳回走通知分支。 */
function approvalDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    name: '人工审核分支',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
    nodes: [
      { id: 'start', type: 'input', implVersion: 1, config: { fields: ['question'] } },
      {
        id: 'review', type: 'approval', implVersion: 1,
        config: { title: '人工审核', description: '审核通过后才能写入' },
      },
      {
        id: 'write', type: 'tool', implVersion: 1,
        config: { serverId: 'mcp', tool: 'write', args: { query: { $ref: 'input.question' } } },
      },
      {
        id: 'notice', type: 'llm', implVersion: 1,
        config: { model: 'smart-model', userPrompt: [{ $ref: 'input.question' }], maxOutputTokens: 32 },
      },
      { id: 'done', type: 'output', implVersion: 1, config: { fields: { content: { $ref: 'nodes.write.output.content' } } } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'review' },
      { id: 'e2', source: 'review', target: 'write', branch: 'approved' },
      { id: 'e3', source: 'review', target: 'notice', branch: 'rejected' },
      { id: 'e4', source: 'write', target: 'done' },
      { id: 'e5', source: 'notice', target: 'done' },
    ],
  };
}

function llmSuccess(text: string): WorkflowNodeSuccess {
  return {
    kind: 'success',
    output: {
      text,
      promptTokens: 1,
      completionTokens: 1,
      model: 'smart-model',
      traceId: `trace-${text}`,
    },
  };
}

function toolSuccess(content = '工具结果'): WorkflowNodeSuccess {
  return {
    kind: 'success',
    output: { ok: true, content, structured: {}, reason: '', traceId: 'tool-trace' },
  };
}

const defaultHandlers: Record<string, WorkflowNodeHandler> = {
  'llm:1': ({ node }) => llmSuccess(node.id),
  'tool:1': () => toolSuccess(),
  'output:1': ({ config }) => ({ kind: 'success', output: (config.fields ?? {}) as Record<string, unknown> }),
};

/**
 * 在存储层注入一次「并发的另一方」，复现取消方与执行器同时收敛同一个运行的竞态。
 *
 * 钩子在被拦截的转换真正落库之前执行，因此后写入的一方必然因为乐观锁失败而冲突。
 */
function racingStore(
  base: MetadataStore,
  hook: (patch: { status: string; updatedAt: string }) => Promise<void>,
): MetadataStore {
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'transitionWorkflowRun') {
        return async (tenantId: string, id: string, fromStatus: string, expectedLockVersion: number, patch: any) => {
          await hook(patch);
          return (value as (...args: unknown[]) => unknown).call(
            target, tenantId, id, fromStatus, expectedLockVersion, patch,
          );
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}

describe('A3 状态机与稳定拓扑', () => {
  it('运行和步骤终态不可重开，拓扑顺序不受边数组顺序影响', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true);
    expect(canTransitionRun('running', 'waiting_approval')).toBe(true);
    expect(canTransitionRun('waiting_approval', 'running')).toBe(true);
    expect(canTransitionRun('succeeded', 'running')).toBe(false);
    expect(canTransitionStep('pending', 'skipped')).toBe(true);
    expect(canTransitionStep('running', 'running')).toBe(true);
    expect(canTransitionStep('failed', 'running')).toBe(false);
    expect(() => assertRunTransition('cancelled', 'running')).toThrow(/非法运行状态转换/);

    const nodes = [startNode(), llmNode('a'), llmNode('b'), outputNode({ a: { $ref: 'nodes.a.output.text' } })];
    const edges = [
      { id: 'e4', source: 'b', target: 'done' },
      { id: 'e3', source: 'a', target: 'done' },
      { id: 'e2', source: 'start', target: 'b' },
      { id: 'e1', source: 'start', target: 'a' },
    ];
    expect(topologicalOrder(nodes, edges)?.map((node) => node.id)).toEqual(['start', 'a', 'b', 'done']);
    expect(topologicalOrder(nodes, [...edges].reverse())?.map((node) => node.id)).toEqual(['start', 'a', 'b', 'done']);
  });

  it('并发端口同时隔离租户、用户和工作流，释放后可以重新获取', async () => {
    const port = new InMemoryWorkflowConcurrencyPort();
    const base = {
      runId: 'run-1', tenantId: 't-1', userId: 'u-1', workflowId: 'wf-1',
      limits: { perTenant: 1, perUser: 1, perWorkflow: 1 },
    };
    const lease = await port.acquire(base);
    expect(lease).toBeDefined();
    expect(await port.acquire({ ...base, runId: 'run-2', workflowId: 'wf-2' })).toBeUndefined();
    expect(await port.acquire({ ...base, runId: 'run-3', userId: 'u-2' })).toBeUndefined();
    expect(await port.acquire({ ...base, runId: 'run-4', userId: 'u-2', workflowId: 'wf-2' })).toBeUndefined();
    const otherTenant = await port.acquire({ ...base, runId: 'run-5', tenantId: 't-2' });
    expect(otherTenant).toBeDefined();
    await lease!.release();
    await otherTenant!.release();
    expect(await port.acquire(base)).toBeDefined();
  });

  it('并发限额被平台天花板夹住，缺省值与非法覆盖值保持原有口径', () => {
    // 业务用户只能调低、不能突破平台上限：提交 1000 也不能放大到 1000（7.5 / R5）。
    const clamped = resolveConcurrencyLimits({ perTenant: 1000 });
    expect(clamped.perTenant).toBe(PLATFORM_CONCURRENCY_LIMIT_CAPS.perTenant);
    expect(clamped.perTenant).toBeLessThan(1000);
    // 未覆盖的项仍取默认值。
    expect(clamped.perUser).toBe(DEFAULT_CONCURRENCY_LIMITS.perUser);
    expect(clamped.perWorkflow).toBe(DEFAULT_CONCURRENCY_LIMITS.perWorkflow);

    // 缺省值不变。
    expect(resolveConcurrencyLimits()).toEqual({
      perTenant: DEFAULT_CONCURRENCY_LIMITS.perTenant,
      perUser: DEFAULT_CONCURRENCY_LIMITS.perUser,
      perWorkflow: DEFAULT_CONCURRENCY_LIMITS.perWorkflow,
    });

    // 非法覆盖值（NaN / 0 / 负数）回落到默认值，绝不产生 NaN。
    expect(resolveConcurrencyLimits({ perTenant: NaN, perUser: 0, perWorkflow: -1 })).toEqual({
      perTenant: DEFAULT_CONCURRENCY_LIMITS.perTenant,
      perUser: DEFAULT_CONCURRENCY_LIMITS.perUser,
      perWorkflow: DEFAULT_CONCURRENCY_LIMITS.perWorkflow,
    });

    // 调低允许；小数向下取整且至少为 1，内部归一化不得放大。
    expect(resolveConcurrencyLimits({ perTenant: 5 }).perTenant).toBe(5);
    expect(resolveConcurrencyLimits({ perUser: 2.9 }).perUser).toBe(2);
    expect(resolveConcurrencyLimits({ perUser: 0.5 }).perUser).toBe(1);
  });
});

describe('A3 工作流运行时', () => {
  let store: MetadataStore;
  let clock: number;
  let sequence: number;

  beforeEach(async () => {
    store = new SqliteMetadataStore(':memory:');
    await store.init();
    clock = T0;
    sequence = 0;
  });

  afterEach(async () => {
    await store.close();
  });

  function runtime(
    handlers: Record<string, WorkflowNodeHandler> = {},
    options: Partial<WorkflowRuntimeOptions> = {},
  ): WorkflowRuntime {
    return new WorkflowRuntime({
      store,
      handlers: { ...defaultHandlers, ...handlers },
      now: () => clock,
      createRunId: () => `run-${++sequence}`,
      createTraceId: () => `trace-${++sequence}`,
      ...options,
    });
  }

  function request(
    definition: WorkflowDefinition,
    overrides: Partial<WorkflowStartRequest> = {},
  ): WorkflowStartRequest {
    return {
      tenantId,
      workflowId: 'wf-1',
      workflowVersion: 1,
      initiatorId: 'u-1',
      identitySnapshot: { sub: 'u-1', tenantId, role: 'employee' },
      input: { question: '审查制度', risk: 'high' },
      mode: 'debug',
      definition,
      definitionChecksum: 'checksum-1',
      resources,
      ...overrides,
    };
  }

  async function seed(definition: WorkflowDefinition): Promise<void> {
    expect(await store.upsertWorkflow({
      id: 'wf-1', tenantId, ownerId: 'u-1', name: definition.name, visibility: 'private',
      currentDraftVersion: 1, latestPublishedVersion: 1,
      createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(),
    })).toBe(true);
    // 已发布版本不允许重复 upsert（存储层拦截同版本回写），先查后写保证幂等。
    const existing = await store.getWorkflowVersion(tenantId, 'wf-1', 1);
    if (existing) return;
    // 已发布版本必须走「草稿 → 提交审核 → 显式发布」通道：
    // 存储层不再允许用普通 upsert 把版本直接置为 published（否则绕过审核通道）。
    expect(await store.upsertWorkflowVersion({
      workflowId: 'wf-1', version: 1, tenantId, definition, checksum: 'checksum-1', status: 'draft',
      createdBy: 'u-1', createdAt: new Date(clock).toISOString(),
    })).toBe(true);
    expect(await store.submitWorkflowVersionForReview(tenantId, 'wf-1', 1)).toBe(true);
    expect(await store.publishWorkflowVersion(tenantId, 'wf-1', 1, {
      reviewer: 'admin', at: new Date(clock).toISOString(),
    })).toBe(true);
  }

  async function start(
    definition: WorkflowDefinition,
    executor: WorkflowRuntime,
    overrides: Partial<WorkflowStartRequest> = {},
  ): Promise<WorkflowRunRecord> {
    await seed(definition);
    return executor.start(request(definition, overrides));
  }

  async function execute(executor: WorkflowRuntime, run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    return executor.execute(tenantId, run.id, { resources });
  }

  async function step(runId: string, nodeId: string) {
    return store.getWorkflowStepRun(tenantId, runId, nodeId);
  }

  it('启动先固化 run 和全部 pending 步骤，幂等键不会创建第二次运行', async () => {
    const executor = runtime();
    const definition = simpleDefinition();
    await seed(definition);
    const firstRequest = request(definition, { idempotencyKey: 'key-1' });
    const first = await executor.start(firstRequest);
    expect(first.status).toBe('queued');
    const pending = await store.listWorkflowStepRuns(tenantId, first.id);
    expect(pending).toHaveLength(3);
    expect(pending.every((item) => item.status === 'pending' && item.attempt === 1)).toBe(true);

    const sameInputDifferentOrder = request(definition, {
      idempotencyKey: 'key-1',
      input: { risk: 'high', question: '审查制度' },
    });
    expect((await executor.start(sameInputDifferentOrder)).id).toBe(first.id);
    await expect(executor.start(request(definition, {
      idempotencyKey: 'key-1', input: { question: '另一个输入' },
    }))).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const concurrent = await Promise.all([
      executor.start(request(definition, { idempotencyKey: 'key-concurrent' })),
      executor.start(request(definition, { idempotencyKey: 'key-concurrent' })),
    ]);
    expect(concurrent[0].id).toBe(concurrent[1].id);
    expect(await store.listWorkflowStepRuns(tenantId, concurrent[0].id)).toHaveLength(3);
  });

  it('启动拒绝非法输入和未完成资源鉴权的定义', async () => {
    const executor = runtime();
    const definition = simpleDefinition();
    definition.inputSchema!.required = ['question'];
    await seed(definition);
    await expect(executor.start(request(definition, { input: {} })))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(executor.start(request(definition, { resources: undefined })))
      .rejects.toMatchObject({ code: 'resource_check_required' });
  });

  it('按稳定拓扑顺序逐节点执行并持久化有效输出与调用次数', async () => {
    const calls: string[] = [];
    const executor = runtime({
      'llm:1': ({ node }) => {
        calls.push(node.id);
        return llmSuccess(`${node.id}-text`);
      },
      'output:1': ({ config }) => {
        calls.push('done');
        return { kind: 'success', output: config.fields as Record<string, unknown> };
      },
    });
    const definition = simpleDefinition();
    definition.nodes = [startNode(), llmNode('a'), llmNode('b'), outputNode({
      a: { $ref: 'nodes.a.output.text' }, b: { $ref: 'nodes.b.output.text' },
    })];
    definition.edges = [
      { id: 'e4', source: 'b', target: 'done' },
      { id: 'e2', source: 'start', target: 'b' },
      { id: 'e3', source: 'a', target: 'done' },
      { id: 'e1', source: 'start', target: 'a' },
    ];
    const run = await start(definition, executor);
    const finished = await execute(executor, run);
    expect(finished.status).toBe('succeeded');
    expect(calls).toEqual(['a', 'b', 'done']);
    expect((await step(run.id, 'a'))?.llmCalls).toBe(1);
    expect((await step(run.id, 'done'))?.output).toEqual({ a: 'a-text', b: 'b-text' });
  });

  it.each([
    { risk: 'high', executed: ['high', 'done'], skipped: ['low', 'lowDetail'] },
    { risk: 'low', executed: ['low', 'lowDetail', 'done'], skipped: ['high'] },
  ])('条件 $risk 分支只执行选中路径，跳过沿 DAG 传播', async ({ risk, executed, skipped }) => {
    const calls: string[] = [];
    const executor = runtime({
      'llm:1': ({ node }) => {
        calls.push(node.id);
        return llmSuccess(node.id);
      },
      'output:1': ({ config }) => {
        calls.push('done');
        return { kind: 'success', output: config.fields as Record<string, unknown> };
      },
    });
    const run = await start(branchDefinition(), executor, { input: { question: 'q', risk } });
    expect((await execute(executor, run)).status).toBe('succeeded');
    expect(calls).toEqual(executed);
    for (const nodeId of skipped) expect((await step(run.id, nodeId))?.status).toBe('skipped');
    expect((await step(run.id, 'decide'))?.status).toBe('succeeded');
  });

  it('条件引用缺失或求值有问题时运行失败，不走 false 分支', async () => {
    const executor = runtime();
    const run = await start(branchDefinition(), executor, { input: { question: 'q' } });
    const finished = await execute(executor, run);
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('condition_evaluation');
    expect((await step(run.id, 'decide'))?.status).toBe('failed');
    expect((await step(run.id, 'low'))?.status).toBe('pending');
  });

  it('合流节点有选中入边但必填引用来自跳过分支时返回 missing_input', async () => {
    const definition = branchDefinition();
    definition.nodes = definition.nodes.filter((node) => !['lowDetail', 'done'].includes(node.id));
    const merge = llmNode('merge', [{ $ref: 'nodes.low.output.text' }]);
    merge.inputSchema = {
      type: 'object',
      properties: { userPrompt: { type: 'array', items: { type: 'string' } } },
      required: ['userPrompt'],
    };
    definition.nodes.push(merge, outputNode({ text: { $ref: 'nodes.merge.output.text' } }));
    definition.edges = definition.edges.filter((edge) => !['e4', 'e5', 'e6'].includes(edge.id));
    definition.edges.push(
      { id: 'e7', source: 'high', target: 'merge' },
      { id: 'e8', source: 'low', target: 'merge' },
      { id: 'e9', source: 'merge', target: 'done' },
    );
    let mergeCalled = false;
    const executor = runtime({
      'llm:1': ({ node }) => {
        if (node.id === 'merge') mergeCalled = true;
        return llmSuccess(node.id);
      },
    });
    const run = await start(definition, executor);
    const finished = await execute(executor, run);
    expect(finished.status).toBe('failed');
    expect((await step(run.id, 'merge'))?.errorCode).toBe('missing_input');
    expect(mergeCalled).toBe(false);
  });

  it('显式可重试的只读 LLM 最多重试两次，策略拒绝不重试', async () => {
    let attempts = 0;
    const retrying = runtime({
      'llm:1': () => {
        attempts += 1;
        if (attempts < 3) {
          throw new WorkflowNodeError('temporary_unavailable', '暂时不可用', {
            sideEffect: 'read', requestSent: true, retryable: true,
          });
        }
        return llmSuccess('成功');
      },
    });
    const run = await start(simpleDefinition(), retrying);
    expect((await execute(retrying, run)).status).toBe('succeeded');
    expect(attempts).toBe(3);
    expect(await step(run.id, 'review')).toMatchObject({ attempt: 3, llmCalls: 3, status: 'succeeded' });

    let deniedCalls = 0;
    const denied = runtime({
      'llm:1': () => {
        deniedCalls += 1;
        throw new WorkflowNodeError('policy_denied', '策略拒绝', {
          sideEffect: 'none', requestSent: false, retryable: false,
        });
      },
    });
    const deniedRun = await denied.start(request(simpleDefinition()));
    expect((await execute(denied, deniedRun)).errorCode).toBe('policy_denied');
    expect(deniedCalls).toBe(1);
  });

  it('只读工具可重试，写工具结果不明时禁止重试并留下持久化标志', async () => {
    let readAttempts = 0;
    const readable = runtime({
      'tool:1': () => {
        readAttempts += 1;
        if (readAttempts === 1) {
          throw new WorkflowNodeError('read_timeout', '读取超时', {
            sideEffect: 'read', requestSent: true, retryable: true,
          });
        }
        return toolSuccess('读取成功');
      },
    });
    const readRun = await start(toolDefinition('read'), readable);
    expect((await execute(readable, readRun)).status).toBe('succeeded');
    expect(readAttempts).toBe(2);
    expect(await step(readRun.id, 'action')).toMatchObject({ attempt: 2, toolCalls: 2, sideEffectUnknown: false });

    let writeAttempts = 0;
    const writing = runtime({
      'tool:1': () => {
        writeAttempts += 1;
        throw new WorkflowNodeError('connection_lost', '写请求发出后断连', {
          sideEffect: 'write', requestSent: true, retryable: true,
        });
      },
    });
    const writeRun = await writing.start(request(toolDefinition()));
    expect((await execute(writing, writeRun)).status).toBe('failed');
    expect(writeAttempts).toBe(1);
    expect(await step(writeRun.id, 'action')).toMatchObject({
      attempt: 1, toolCalls: 1, status: 'failed', sideEffectUnknown: true, errorCode: 'connection_lost',
    });
    expect((await step(writeRun.id, 'done'))?.status).toBe('pending');
  });

  it('节点超时传递 AbortSignal，运行失败后不调度下游', async () => {
    let aborts = 0;
    const executor = runtime({
      'llm:1': ({ signal }) => new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          aborts += 1;
          reject(signal.reason);
        }, { once: true });
      }),
    }, { maxRetries: 0, nodeTimeoutMs: 5 });
    const run = await start(simpleDefinition(), executor);
    const finished = await execute(executor, run);
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('node_timeout');
    expect(aborts).toBe(1);
    expect((await step(run.id, 'done'))?.status).toBe('pending');
  });

  it('写工具超时只执行一次，并持久化不确定副作用标志', async () => {
    let calls = 0;
    const executor = runtime({
      'tool:1': ({ signal }) => {
        calls += 1;
        return new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }, { nodeTimeoutMs: 5 });
    const run = await start(toolDefinition(), executor);
    const finished = await execute(executor, run);
    expect(finished.errorCode).toBe('node_timeout');
    expect(calls).toBe(1);
    expect(await step(run.id, 'action')).toMatchObject({
      attempt: 1, status: 'failed', sideEffectUnknown: true, errorCode: 'node_timeout',
    });
  });

  it('取消通过 AbortController 到达处理器，重复执行同一运行会被拒绝', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const executor = runtime({
      'llm:1': ({ signal }) => {
        markStarted?.();
        return new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const run = await start(simpleDefinition(), executor);
    const executing = execute(executor, run);
    await started;
    await expect(execute(executor, run)).rejects.toMatchObject({ code: 'run_already_active' });
    expect((await executor.cancel(tenantId, run.id)).status).toBe('cancelled');
    expect((await executing).status).toBe('cancelled');
    expect((await step(run.id, 'review'))?.errorCode).toBe('run_cancelled');
  });

  it('审批挂起后从同一 attempt 恢复，参数快照与工具额度均不重复计算', async () => {
    const attempts: Array<{ attempt: number; resuming: boolean }> = [];
    const configs: Array<Record<string, unknown>> = [];
    const executor = runtime({
      'tool:1': ({ attempt, resuming, config }) => {
        attempts.push({ attempt, resuming });
        configs.push(config);
        if (!resuming) return { kind: 'waiting_approval', approvalId: 'approval-1' };
        return toolSuccess('审批后执行');
      },
    });
    const run = await start(toolDefinition(), executor);
    const waiting = await execute(executor, run);
    expect(waiting.status).toBe('waiting_approval');
    expect(await step(run.id, 'action')).toMatchObject({
      attempt: 1,
      status: 'waiting_approval',
      approvalId: 'approval-1',
      // 挂起那一次只是去申请审批，没有完成外部动作：额度已退回，不计入调用次数。
      // 真正执行外部调用的是恢复后的那次（下面断言 toolCalls = 1）。
      toolCalls: 0,
      input: { args: { query: '审查制度' } },
    });

    const startStep = await step(run.id, 'start');
    await store.upsertWorkflowStepRun(tenantId, {
      ...startStep!, output: { question: '被改写的值', risk: 'high' },
    });
    const resumed = await executor.resume(tenantId, run.id, { resources });
    expect(resumed.status).toBe('succeeded');
    expect(attempts).toEqual([{ attempt: 1, resuming: false }, { attempt: 1, resuming: true }]);
    expect(configs[1].args).toEqual({ query: '审查制度' });
    expect(await step(run.id, 'action')).toMatchObject({ attempt: 1, toolCalls: 1, status: 'succeeded' });
  });

  it('审批只能消费一次：恢复后不得再次挂起，处理器不会被无限次调用', async () => {
    let calls = 0;
    const executor = runtime({
      'tool:1': () => {
        calls += 1;
        return { kind: 'waiting_approval', approvalId: 'approval-loop' };
      },
    });
    const definition = toolDefinition();
    definition.limits = { maxToolCalls: 1, timeoutMs: 900_000, approvalTimeoutMs: 900_000 };
    const run = await start(definition, executor);
    expect((await execute(executor, run)).status).toBe('waiting_approval');
    expect(calls).toBe(1);

    // 恢复后处理器再次要求审批 → 协议错误（审批只能消费一次），运行直接失败。
    const resumed = await executor.resume(tenantId, run.id, { resources });
    expect(resumed.status).toBe('failed');
    expect(resumed.errorCode).toBe('repeated_approval');
    expect(calls).toBe(2);

    // 运行已终态，再恢复被拒绝：处理器不会被无限次调用。
    await expect(executor.resume(tenantId, run.id, { resources }))
      .rejects.toMatchObject({ code: 'invalid_run_state' });
    expect(calls).toBe(2);
  });

  it('并发同幂等键但输入不同时必须报幂等冲突', async () => {
    const executor = runtime();
    const definition = simpleDefinition();
    await seed(definition);
    const concurrent = await Promise.allSettled([
      executor.start(request(definition, { idempotencyKey: 'key-race', input: { question: 'AAA', risk: 'high' } })),
      executor.start(request(definition, { idempotencyKey: 'key-race', input: { question: 'BBB', risk: 'high' } })),
    ]);
    const rejected = concurrent.filter((item) => item.status === 'rejected');
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'idempotency_conflict' });
  });

  it('审批超时和不确定副作用都会阻止恢复调用', async () => {
    let calls = 0;
    const executor = runtime({
      'tool:1': ({ resuming }) => {
        calls += 1;
        return resuming ? toolSuccess() : { kind: 'waiting_approval', approvalId: 'approval-1' };
      },
    });
    const definition = toolDefinition();
    definition.limits = { timeoutMs: 2_000, approvalTimeoutMs: 1_000 };
    const run = await start(definition, executor);
    await execute(executor, run);
    clock += 1_001;
    const timedOut = await executor.resume(tenantId, run.id, { resources });
    expect(timedOut.errorCode).toBe('approval_timeout');
    expect(calls).toBe(1);

    clock = T0;
    const second = await executor.start(request(toolDefinition()));
    await execute(executor, second);
    const waitingStep = await step(second.id, 'action');
    await store.upsertWorkflowStepRun(tenantId, { ...waitingStep!, sideEffectUnknown: true });
    const blocked = await executor.resume(tenantId, second.id, { resources });
    expect(blocked.errorCode).toBe('side_effect_unknown');
    expect(calls).toBe(2);
  });

  it('审批无需恢复也会自动超时，等待期间占额度且终态释放额度', async () => {
    const executor = runtime({
      'tool:1': () => ({ kind: 'waiting_approval', approvalId: 'approval-timeout' }),
    }, { concurrencyLimits: { perUser: 1 } });
    const definition = toolDefinition();
    definition.limits = { timeoutMs: 100, approvalTimeoutMs: 10 };
    const run = await start(definition, executor);
    expect((await execute(executor, run)).status).toBe('waiting_approval');
    await expect(executor.start(request(simpleDefinition())))
      .rejects.toMatchObject({ code: 'too_many_running_runs' });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await store.getWorkflowRun(tenantId, run.id)).toMatchObject({
      status: 'failed', errorCode: 'approval_timeout',
    });
    expect((await step(run.id, 'action'))?.status).toBe('failed');

    const afterTimeout = await executor.start(request(simpleDefinition()));
    expect(afterTimeout.status).toBe('queued');
    expect((await executor.cancel(tenantId, afterTimeout.id)).status).toBe('cancelled');
  });

  it('审批等待也受运行总时限约束', async () => {
    const executor = runtime({
      'tool:1': () => ({ kind: 'waiting_approval', approvalId: 'approval-run-timeout' }),
    });
    const definition = toolDefinition();
    definition.limits = { timeoutMs: 5, approvalTimeoutMs: 5 };
    const run = await start(definition, executor);
    expect((await execute(executor, run)).status).toBe('waiting_approval');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.getWorkflowRun(tenantId, run.id)).toMatchObject({
      status: 'failed', errorCode: 'run_timeout',
    });
  });

  it('运行步骤数与 LLM 调用次数都在外部调用前执行限额', async () => {
    let calls = 0;
    const executor = runtime({
      'llm:1': ({ node }) => {
        calls += 1;
        return llmSuccess(node.id);
      },
    });
    const definition = simpleDefinition();
    definition.nodes = [startNode(), llmNode('a'), llmNode('b', [{ $ref: 'nodes.a.output.text' }]), outputNode({
      text: { $ref: 'nodes.b.output.text' },
    })];
    definition.edges = [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'done' },
    ];
    definition.limits = { maxLlmCalls: 1 };
    const run = await start(definition, executor);
    const finished = await execute(executor, run);
    expect(finished.errorCode).toBe('llm_call_limit_exceeded');
    expect(calls).toBe(1);
    expect((await step(run.id, 'b'))?.llmCalls).toBe(0);

    calls = 0;
    const limited = { ...definition, limits: { maxSteps: 1 } };
    const limitedRun = await executor.start(request(limited));
    expect((await execute(executor, limitedRun)).errorCode).toBe('step_limit_exceeded');
    expect(calls).toBe(0);
  });

  it('输出违反有效 Schema 或超过 64 KiB 时失败', async () => {
    const invalidDefinition = simpleDefinition();
    invalidDefinition.nodes[1].outputSchema = {
      type: 'object', properties: { risk: { type: 'string' } }, required: ['risk'],
    };
    const invalid = runtime();
    const invalidRun = await start(invalidDefinition, invalid);
    expect((await execute(invalid, invalidRun)).errorCode).toBe('invalid_output');

    const oversized = runtime({
      'llm:1': () => llmSuccess('x'.repeat(65_537)),
    });
    const oversizedRun = await oversized.start(request(simpleDefinition()));
    expect((await execute(oversized, oversizedRun)).errorCode).toBe('output_too_large');
  });

  it('运行状态总量同时计算节点输入与输出，超限不会留下 running 步骤', async () => {
    const definition = simpleDefinition();
    const chain = Array.from({ length: 10 }, (_, index) => {
      const id = `llm-${index}`;
      return llmNode(id, index === 0 ? [{ $ref: 'input.question' }] : [{ $ref: `nodes.llm-${index - 1}.output.text` }]);
    });
    definition.nodes = [startNode(), ...chain, outputNode({ text: { $ref: 'nodes.llm-9.output.text' } })];
    definition.edges = [
      { id: 'e-start', source: 'start', target: 'llm-0' },
      ...chain.slice(1).map((node, index) => ({
        id: `e-${index}`, source: `llm-${index}`, target: node.id,
      })),
      { id: 'e-done', source: 'llm-9', target: 'done' },
    ];
    const executor = runtime({
      'llm:1': ({ node }) => ({
        kind: 'success',
        output: { ...llmSuccess(node.id).output, text: 'x'.repeat(60_000) },
      }),
    });
    const run = await start(definition, executor);
    const finished = await execute(executor, run);
    expect(finished.errorCode).toBe('state_limit_exceeded');
    const steps = await store.listWorkflowStepRuns(tenantId, run.id);
    expect(steps.filter((item) => item.status === 'running')).toEqual([]);
    expect(steps.find((item) => item.status === 'failed')?.errorCode).toBe('state_limit_exceeded');
    expect((await step(run.id, 'done'))?.status).toBe('pending');
  });

  it('已发布运行重新核对版本校验和，乐观锁冲突不会启动外部调用', async () => {
    const executor = runtime();
    const definition = simpleDefinition();
    const mismatch = await start(definition, executor, { mode: 'published', definitionChecksum: 'wrong' });
    expect((await execute(executor, mismatch)).errorCode).toBe('definition_checksum_mismatch');

    const queued = await executor.start(request(definition));
    const timestamp = new Date(clock).toISOString();
    expect(await store.transitionWorkflowRun(tenantId, queued.id, 'queued', 0, {
      status: 'running', startedAt: timestamp, updatedAt: timestamp,
    })).toBeDefined();
    await expect(execute(executor, queued)).rejects.toMatchObject({ code: 'invalid_run_state' });
  });

  it('上游分支被跳过时缺失引用不阻断运行，但在步骤与运行上留痕', async () => {
    const executor = runtime();
    const run = await start(branchDefinition(), executor, { input: { question: 'q', risk: 'high' } });
    const finished = await execute(executor, run);
    expect(finished.status).toBe('succeeded');
    // 被跳过的分支不会产生缺失引用
    expect((await step(run.id, 'high'))?.missingRefs).toBeUndefined();
    expect((await step(run.id, 'low'))?.missingRefs).toBeUndefined();
    // 合流节点引用了被跳过分支的输出字段：字段缺省，但必须留痕
    expect((await step(run.id, 'done'))?.missingRefs).toEqual(['nodes.lowDetail.output.text']);
    expect(finished.missingRefs).toEqual(['nodes.lowDetail.output.text']);
    // 缺失字段不会被补成 null
    expect((await step(run.id, 'done'))?.output).toEqual({ high: 'high' });
  });

  it('运行输入缺少已声明但非必填的字段时，引用缺失同样留痕', async () => {
    const executor = runtime();
    const definition = simpleDefinition();
    definition.inputSchema = {
      type: 'object',
      properties: { question: { type: 'string' }, risk: { type: 'string' }, note: { type: 'string' } },
    };
    definition.nodes = [
      { id: 'start', type: 'input', implVersion: 1, config: { fields: ['question', 'risk', 'note'] } },
      llmNode('review', [{ $ref: 'input.note' }]),
      outputNode(),
    ];
    const run = await start(definition, executor, { input: { question: '审查制度' } });
    const finished = await execute(executor, run);
    expect(finished.status).toBe('succeeded');
    expect((await step(run.id, 'review'))?.missingRefs).toEqual(['input.note']);
    expect(finished.missingRefs).toEqual(['input.note']);
    expect((await step(run.id, 'done'))?.missingRefs).toBeUndefined();
  });

  it('执行器收敛与取消并发时，双方都拿到最终运行记录而不是转换冲突', async () => {
    // 执行器准备写 succeeded 时，另一方抢先写了 cancelled —— 乐观锁必然冲突。
    let targetRunId = '';
    const racing = racingStore(store, async (patch) => {
      if (patch.status !== 'succeeded') return;
      const current = await store.getWorkflowRun(tenantId, targetRunId);
      if (current?.status !== 'running') return;
      await store.transitionWorkflowRun(tenantId, targetRunId, 'running', current.lockVersion, {
        status: 'cancelled', errorCode: 'run_cancelled', errorMessage: '运行已取消', updatedAt: patch.updatedAt,
      });
    });
    const executor = runtime({}, { store: racing });
    const run = await start(simpleDefinition(), executor);
    targetRunId = run.id;
    const finished = await execute(executor, run);
    expect(finished.status).toBe('cancelled');
    expect((await store.getWorkflowRun(tenantId, run.id))?.status).toBe('cancelled');
  });

  it('取消与执行器收敛并发时，取消方返回最终运行记录而不是转换冲突', async () => {
    // 取消方准备写 cancelled 时，执行器抢先收敛为 succeeded —— 乐观锁必然冲突。
    let targetRunId = '';
    const racing = racingStore(store, async (patch) => {
      if (patch.status !== 'cancelled') return;
      const current = await store.getWorkflowRun(tenantId, targetRunId);
      if (current?.status !== 'running') return;
      await store.transitionWorkflowRun(tenantId, targetRunId, 'running', current.lockVersion, {
        status: 'succeeded', updatedAt: patch.updatedAt,
      });
    });
    const executor = runtime({}, { store: racing });
    const run = await start(simpleDefinition(), executor);
    targetRunId = run.id;
    // 模拟运行已被执行器接管（running），此时另一方抢先完成收敛。
    const timestamp = new Date(clock).toISOString();
    expect(await store.transitionWorkflowRun(tenantId, run.id, 'queued', 0, {
      status: 'running', startedAt: timestamp, updatedAt: timestamp,
    })).toBeDefined();
    const cancelled = await executor.cancel(tenantId, run.id);
    expect(cancelled.status).toBe('succeeded');
    expect((await store.getWorkflowRun(tenantId, run.id))?.status).toBe('succeeded');
  });

  it('原型污染键在发布校验阶段被拒绝，正常配置的解析结果使用 null 原型', async () => {
    // 第一层：校验层直接拒绝原型污染键（所有配置层级），不允许进入执行阶段。
    const polluted = toolDefinition();
    polluted.nodes[1].config = {
      serverId: 'mcp',
      tool: 'write',
      // 载荷：通过原型注入属性
      args: JSON.parse('{"__proto__": {"tenantId": "evil-tenant", "userId": "admin"}}'),
    };
    const validation = validateDefinition(polluted);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'invalid_config' && issue.message.includes('原型污染')))
      .toBe(true);

    // 第二层：即使定义合法，解析结果也用 null 原型对象承接，没有原型可污染。
    let seen: Record<string, unknown> | undefined;
    const executor = runtime({
      'tool:1': ({ config }) => {
        seen = config.args as Record<string, unknown>;
        return toolSuccess();
      },
    });
    const definition = toolDefinition();
    const run = await start(definition, executor);
    expect((await execute(executor, run)).status).toBe('succeeded');
    expect(Object.getPrototypeOf(seen!)).toBeNull();
    expect((seen as Record<string, unknown>).tenantId).toBeUndefined();
    expect((seen as Record<string, unknown>).userId).toBeUndefined();
  });

  it('写工具已执行但返回值不合法时，留不确定副作用标志', async () => {
    const executor = runtime({
      // 写工具已经写成功，但返回的 ok 字段类型非法 → 结果校验失败
      'tool:1': () => ({ kind: 'success', output: { ok: 'not-a-boolean', content: 'x' } }),
    });
    const run = await start(toolDefinition(), executor);
    const finished = await execute(executor, run);
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('invalid_output');
    // 外部写操作可能已经落地，必须留痕，否则恢复逻辑会误以为可以重放
    expect(await step(run.id, 'action')).toMatchObject({
      status: 'failed', errorCode: 'invalid_output', sideEffectUnknown: true,
    });
  });

  it('人工审核节点按通过/驳回选边，驳回后不会执行写工具', async () => {
    const executed: string[] = [];
    let approved = true;
    const executor = runtime({
      'approval:1': () => ({ kind: 'success', output: { approved } }),
      'tool:1': () => { executed.push('write'); return toolSuccess(); },
      'llm:1': ({ node }) => { executed.push(node.id); return llmSuccess('已通知'); },
    });

    approved = true;
    const passed = await start(approvalDefinition(), executor);
    expect((await execute(executor, passed)).status).toBe('succeeded');
    expect(executed).toContain('write');
    expect(await step(passed.id, 'write')).toMatchObject({ status: 'succeeded' });

    executed.length = 0;
    approved = false;
    const rejected = await start(approvalDefinition(), executor);
    expect((await execute(executor, rejected)).status).toBe('succeeded');
    expect(executed).not.toContain('write');
    expect(executed).toContain('notice');
    expect(await step(rejected.id, 'write')).toMatchObject({ status: 'skipped' });
  });

  it('审核被驳回但定义里没有驳回分支时运行失败，不会跳过下游继续执行', async () => {
    let toolCalls = 0;
    const executor = runtime({
      'approval:1': () => ({ kind: 'success', output: { approved: false } }),
      'tool:1': () => { toolCalls += 1; return toolSuccess(); },
    });
    const definition = approvalDefinition();
    definition.nodes = definition.nodes.filter((node) => node.id !== 'notice');
    definition.edges = definition.edges.filter((edge) => edge.source !== 'notice' && edge.target !== 'notice');
    const run = await start(definition, executor);
    const finished = await execute(executor, run);
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('approval_branch_missing');
    expect(toolCalls).toBe(0);
  });

  it('运行已是终态时不再占用并发额度', async () => {
    const executor = runtime({}, { concurrencyLimits: { perTenant: 1 } });
    const run = await start(simpleDefinition(), executor);
    // 模拟运行被别的执行者取消：直接改库置为终态，本进程仍持有并发租约
    expect(await store.transitionWorkflowRun(tenantId, run.id, 'queued', 0, {
      status: 'cancelled', errorCode: 'run_cancelled', updatedAt: new Date(clock).toISOString(),
    })).toBeDefined();
    await expect(execute(executor, run)).rejects.toMatchObject({ code: 'invalid_run_state' });
    // 租约已释放：还能再启动一个运行
    const second = await executor.start(request(simpleDefinition()));
    expect(second.status).toBe('queued');
  });

  it('并发同幂等键时先发起的请求启动失败，不会牵连后发起的合法请求', async () => {
    const executor = runtime();
    const definition = simpleDefinition();
    await seed(definition);
    const key = 'key-shared-init-failure';
    // 两个 start 同步发起：后一个必然命中 single-flight 的共享 promise。
    const results = await Promise.allSettled([
      // 先发起：资源白名单里没有模型，启动阶段就失败。
      executor.start(request(definition, {
        idempotencyKey: key,
        resources: { models: [], tools: [], knowledgeScopes: [] },
      })),
      // 后发起：请求完全合法。
      executor.start(request(definition, { idempotencyKey: key })),
    ]);
    const [failed, succeeded] = results;
    expect(failed.status).toBe('rejected');
    expect((failed as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid_definition' });
    // 合法请求不能继承别人的失败：自己成功，并且真的创建出运行。
    expect(succeeded.status).toBe('fulfilled');
    const run = (succeeded as PromiseFulfilledResult<WorkflowRunRecord>).value;
    expect(run.status).toBe('queued');
    expect(await store.getWorkflowRun(tenantId, run.id)).toBeDefined();
    const runs = await store.listWorkflowRuns({ tenantId, workflowId: 'wf-1' });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run.id);
  });

  it('节点超时是运行时合成的错误，不触发自动重试，处理器只被调用一次', async () => {
    let calls = 0;
    const executor = runtime({
      'llm:1': () => {
        calls += 1;
        // 挂起不返回：处理器从未抛出任何异常，超时完全由运行时合成。
        return new Promise<never>(() => undefined);
      },
    }, { nodeTimeoutMs: 40 });
    const run = await start(simpleDefinition(), executor);
    const finished = await execute(executor, run);
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('node_timeout');
    // 超时不重试：处理器只被调用一次，attempt 停在 1。
    expect(calls).toBe(1);
    expect(await step(run.id, 'review')).toMatchObject({
      attempt: 1, llmCalls: 1, status: 'failed', errorCode: 'node_timeout',
    });
    expect((await step(run.id, 'done'))?.status).toBe('pending');
  });

  it('额度耗尽拦下的那次尝试不算写副作用，真正写请求发出后失败仍留痕', async () => {
    // 场景一：第 1 次尝试是只读错误（可重试），第 2 次尝试在额度预留阶段就被拦下，
    // 处理器根本没有被再次调用 → 不应该留下「写操作可能已落地」的痕迹。
    let readCalls = 0;
    const exhausted = runtime({
      'tool:1': () => {
        readCalls += 1;
        throw new WorkflowNodeError('read_timeout', '读取超时', {
          sideEffect: 'read', requestSent: true, retryable: true,
        });
      },
    });
    const limited = toolDefinition('read');
    limited.limits = { maxToolCalls: 1, timeoutMs: 900_000, approvalTimeoutMs: 900_000 };
    const limitedRun = await start(limited, exhausted);
    const finished = await execute(exhausted, limitedRun);
    expect(finished.errorCode).toBe('tool_call_limit_exceeded');
    expect(readCalls).toBe(1);
    expect(await step(limitedRun.id, 'action')).toMatchObject({
      status: 'failed', errorCode: 'tool_call_limit_exceeded', sideEffectUnknown: false, attempt: 2,
    });

    // 场景二：写请求确实已经发出后才失败 → 必须仍然是 true（不能被改坏）。
    let writeCalls = 0;
    const writing = runtime({
      'tool:1': () => {
        writeCalls += 1;
        throw new WorkflowNodeError('connection_lost', '写请求发出后断连', {
          sideEffect: 'write', requestSent: true, retryable: true,
        });
      },
    });
    const writeRun = await start(toolDefinition(), writing);
    expect((await execute(writing, writeRun)).status).toBe('failed');
    expect(writeCalls).toBe(1);
    expect(await step(writeRun.id, 'action')).toMatchObject({
      status: 'failed', errorCode: 'connection_lost', sideEffectUnknown: true,
    });
  });

  it('运行已被其他执行者收敛为终态时，执行器异常也必须释放并发租约', async () => {
    let releases = 0;
    const concurrency: WorkflowConcurrencyPort = {
      acquire: () => ({ release: () => { releases += 1; } }),
    };
    // 存储层在执行器读取已发布版本时模拟「另一方已把运行收敛为终态」，随后抛出读故障。
    // 执行器因此进入 catch，而运行已经是终态 —— 这条路径必须交还并发名额。
    let targetRunId = '';
    const faulty = new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'getWorkflowVersion') {
          return async (tenantId: string, workflowId: string, version: number) => {
            const current = await (target.getWorkflowRun as any)(tenantId, targetRunId);
            if (current?.status === 'running') {
              await (target.transitionWorkflowRun as any)(
                tenantId, targetRunId, 'running', current.lockVersion,
                {
                  status: 'cancelled', errorCode: 'run_cancelled', errorMessage: '运行已取消',
                  updatedAt: new Date(clock).toISOString(),
                },
              );
            }
            throw new Error('存储读故障');
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    const executor = runtime({}, { store: faulty, concurrency });
    const run = await start(simpleDefinition(), executor, { mode: 'published' });
    targetRunId = run.id;
    const finished = await execute(executor, run);
    expect(finished.status).toBe('cancelled');
    // 租约已释放：不会因这条异常路径泄漏并发名额；且只释放一次，不会重复释放。
    expect(releases).toBe(1);
  });
});
