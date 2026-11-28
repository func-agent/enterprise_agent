import type {
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunTransitionPatch,
  WorkflowStepRunRecord,
  WorkflowStore,
} from '@eap/platform-core';
import { evaluateCondition } from './condition.js';
import {
  InMemoryWorkflowConcurrencyPort,
  resolveConcurrencyLimits,
  type WorkflowConcurrencyLease,
  type WorkflowConcurrencyLimits,
  type WorkflowConcurrencyPort,
} from './concurrency.js';
import { STRUCTURE_LIMITS, resolveLimits } from './limits.js';
import { resolveRef } from './refs.js';
import { validateValue } from './schema.js';
import { assertRunTransition, assertStepTransition, canTransitionRun } from './state.js';
import { topologicalOrder } from './topology.js';
import type {
  BranchKind,
  ConditionContext,
  ConditionExpr,
  ValidationContext,
  WorkflowDefinition,
  WorkflowLimits,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowResourceScope,
} from './types.js';
import { getEffectiveOutputSchema, validateDefinition } from './validate.js';

export type WorkflowSideEffect = 'none' | 'read' | 'write';

export interface WorkflowNodeErrorOptions {
  sideEffect: WorkflowSideEffect;
  retryable?: boolean;
  /** 请求是否已经发出。写请求发出后失败必须留下不确定副作用证据。 */
  requestSent?: boolean;
  cause?: unknown;
}

export class WorkflowNodeError extends Error {
  readonly code: string;
  readonly sideEffect: WorkflowSideEffect;
  readonly retryable: boolean;
  readonly requestSent: boolean;

  constructor(code: string, message: string, options: WorkflowNodeErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'WorkflowNodeError';
    this.code = code;
    this.sideEffect = options.sideEffect;
    this.retryable = options.retryable === true;
    this.requestSent = options.requestSent === true;
  }
}

export class WorkflowRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'WorkflowRuntimeError';
    this.code = code;
  }
}

export interface WorkflowNodeExecutionContext {
  run: WorkflowRunRecord;
  node: WorkflowNode;
  /** 已解析引用后的配置；缺失的可选对象字段会被省略，不会补成 null。 */
  config: Record<string, unknown>;
  input: Record<string, unknown>;
  context: ConditionContext;
  attempt: number;
  /** 从 waiting_approval 恢复时为 true，attempt 不增加。 */
  resuming: boolean;
  signal: AbortSignal;
  /** Agent 等复合节点在调用前必须遵守的剩余额度。 */
  remainingCalls: { llm: number; tool: number };
}

export interface WorkflowNodeSuccess {
  kind: 'success';
  output: Record<string, unknown>;
  /** 复合节点的内部实际调用次数；普通 LLM/工具节点由运行时自动计数。 */
  llmCalls?: number;
  toolCalls?: number;
}

export interface WorkflowNodeWaiting {
  kind: 'waiting_approval';
  approvalId: string;
  /** 本次挂起前已经发生的复合节点内部调用次数。 */
  llmCalls?: number;
  toolCalls?: number;
}

export type WorkflowNodeExecutionResult = WorkflowNodeSuccess | WorkflowNodeWaiting;

export type WorkflowNodeHandler = (
  context: WorkflowNodeExecutionContext,
) => Promise<WorkflowNodeExecutionResult> | WorkflowNodeExecutionResult;

export interface WorkflowRuntimeOptions {
  store: WorkflowStore;
  /** 键为 `${node.type}:${node.implVersion ?? 1}`；input 和 condition 由领域层直接执行。 */
  handlers?: Readonly<Record<string, WorkflowNodeHandler>>;
  now?: () => number;
  createRunId?: () => string;
  createTraceId?: () => string;
  /** 只读调用的额外重试次数，0–2，默认 2；写调用始终为 0。 */
  maxRetries?: number;
  retryDelayMs?: number;
  nodeTimeoutMs?: number;
  /** 缺省为单进程计数器；生产宿主可注入带启动重建能力的 Redis 实现。 */
  concurrency?: WorkflowConcurrencyPort;
  concurrencyLimits?: Partial<WorkflowConcurrencyLimits>;
}

export interface WorkflowStartRequest {
  tenantId: string;
  workflowId: string;
  workflowVersion: number;
  initiatorId: string;
  identitySnapshot: Record<string, unknown>;
  input: Record<string, unknown>;
  mode: 'debug' | 'published';
  definition: WorkflowDefinition;
  definitionChecksum: string;
  idempotencyKey?: string;
  resources?: WorkflowResourceScope;
  platformLimits?: Partial<WorkflowLimits>;
  expiresAt?: string;
}

export interface WorkflowExecuteOptions {
  resources?: WorkflowResourceScope;
  platformLimits?: Partial<WorkflowLimits>;
  signal?: AbortSignal;
}

interface RunProgress {
  steps: number;
  llmCalls: number;
  toolCalls: number;
}

function restoreProgress(steps: WorkflowStepRunRecord[]): RunProgress {
  return steps.reduce<RunProgress>((progress, step) => {
    if (step.status !== 'pending' && step.status !== 'skipped') progress.steps += 1;
    progress.llmCalls += step.llmCalls ?? 0;
    progress.toolCalls += step.toolCalls ?? 0;
    return progress;
  }, { steps: 0, llmCalls: 0, toolCalls: 0 });
}

function persistentState(
  run: WorkflowRunRecord,
  steps: Iterable<WorkflowStepRunRecord>,
): Record<string, unknown> {
  return {
    input: run.input,
    identitySnapshot: run.identitySnapshot,
    definitionSnapshot: run.definitionSnapshot,
    steps: [...steps].map((step) => ({ nodeId: step.nodeId, input: step.input, output: step.output })),
  };
}

interface NodeSuccessOutcome {
  kind: 'success';
  step: WorkflowStepRunRecord;
  context: ConditionContext;
  branch?: BranchKind;
}

interface NodeWaitingOutcome {
  kind: 'waiting_approval';
  step: WorkflowStepRunRecord;
}

interface NodeFailureOutcome {
  kind: 'failed';
  step: WorkflowStepRunRecord;
  code: string;
  message: string;
}

type NodeOutcome = NodeSuccessOutcome | NodeWaitingOutcome | NodeFailureOutcome;

const RETRYABLE_NODE_TYPES = new Set<WorkflowNodeType>(['llm', 'knowledge', 'tool']);
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 运行的终态集合 —— 进入后不可再转换。 */
const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** 是否为「运行已被其他执行者推进」类的转换冲突。 */
function isTransitionConflict(error: unknown): boolean {
  return error instanceof WorkflowRuntimeError && error.code === 'run_transition_conflict';
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function canonicalJson(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'bigint') throw new TypeError('BigInt 不是 JSON 值');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  if (typeof value === 'object') {
    const entries: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const encoded = canonicalJson((value as Record<string, unknown>)[key]);
      if (encoded !== undefined) entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(',')}}`;
  }
  return undefined;
}

function jsonBytes(value: unknown, field: string): number {
  let serialized: string | undefined;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw new WorkflowRuntimeError('invalid_json', `${field} 必须是可序列化的 JSON 值`, { cause: error });
  }
  if (serialized === undefined) {
    throw new WorkflowRuntimeError('invalid_json', `${field} 必须是可序列化的 JSON 值`);
  }
  return textEncoder.encode(serialized).length;
}

function assertPayloadLimit(value: unknown, field: string, limit: number, code: string): void {
  if (jsonBytes(value, field) > limit) {
    throw new WorkflowRuntimeError(code, `${field} 超过大小上限 ${limit} 字节`);
  }
}

function assertUsableDefinition(
  definition: WorkflowDefinition,
  input: Record<string, unknown>,
  context: ValidationContext,
): void {
  const result = validateDefinition(definition, context);
  if (!result.ok) {
    const detail = result.issues.slice(0, 3).map((issue) => `${issue.code}: ${issue.message}`).join('；');
    throw new WorkflowRuntimeError('invalid_definition', detail || '工作流定义不合法');
  }
  const skipped = Object.entries(result.resourceCheck)
    .filter(([, status]) => status === 'skipped')
    .map(([resource]) => resource);
  if (skipped.length > 0) {
    throw new WorkflowRuntimeError(
      'resource_check_required',
      `以下资源必须按当前运行者重新校验：${skipped.join(', ')}`,
    );
  }
  const inputErrors = validateValue(input, definition.inputSchema, '$.input');
  if (inputErrors.length > 0) {
    throw new WorkflowRuntimeError('invalid_input', inputErrors.join('；'));
  }
  assertPayloadLimit(input, '运行输入', STRUCTURE_LIMITS.maxNodePayloadBytes, 'input_too_large');
  assertPayloadLimit(input, '运行输入', STRUCTURE_LIMITS.maxRunStateBytes, 'state_limit_exceeded');
}

interface TemplateResolution {
  value?: unknown;
  missing?: boolean;
  /** 本次解析中未能取到值的引用表达式（保持出现顺序，可能重复）。 */
  missingRefs: string[];
}

/**
 * 解析配置模板。
 *
 * 按 R3，引用不到值等价于「字段不存在」：非必填字段直接省略，不补默认值。
 * 但缺失必须留痕 —— `missingRefs` 收集所有未能解析的引用表达式，
 * 由调用方写入步骤记录，避免运行结束后无从判断结果是否缺字段。
 *
 * 解析结果用 **null 原型对象** 承接：普通对象上的 `output['__proto__'] = v`
 * 会触发原型 setter，把配置里的 `__proto__` 键变成原型污染
 * （注入的属性会被下游读到，序列化后又看不见）。
 */
function resolveTemplate(
  value: unknown,
  context: ConditionContext,
  missingRefs: string[] = [],
): TemplateResolution {
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const resolved = resolveTemplate(item, context, missingRefs);
      if (resolved.missing) return { missing: true, missingRefs };
      output.push(resolved.value);
    }
    return { value: output, missingRefs };
  }
  if (!isRecord(value)) return { value, missingRefs };
  if (Object.prototype.hasOwnProperty.call(value, '$ref')) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string') {
      throw new WorkflowNodeError('invalid_input', '引用对象只能包含字符串类型的 $ref 字段', {
        sideEffect: 'none', requestSent: false,
      });
    }
    const resolved = resolveRef(value.$ref, context);
    if (!resolved.valid) {
      throw new WorkflowNodeError('invalid_input', `引用格式非法：${value.$ref}`, {
        sideEffect: 'none', requestSent: false,
      });
    }
    if (!resolved.found) {
      missingRefs.push(value.$ref);
      return { missing: true, missingRefs };
    }
    return { value: resolved.value, missingRefs };
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    const resolved = resolveTemplate(item, context, missingRefs);
    if (!resolved.missing) output[key] = resolved.value;
  }
  return { value: output, missingRefs };
}

/** 归一化缺失引用列表：去重并排序，保证落库内容稳定、可比对。 */
function normalizeMissingRefs(refs: string[]): string[] {
  return [...new Set(refs)].sort();
}

function abortReason(node: WorkflowNode, signal: AbortSignal): WorkflowNodeError {
  const reason = signal.reason;
  const code = reason instanceof WorkflowRuntimeError && reason.code === 'run_interrupted'
    ? 'run_interrupted'
    : 'run_cancelled';
  const mayWrite = node.type === 'tool' || node.type === 'agent';
  return new WorkflowNodeError(code, code === 'run_interrupted' ? '运行已中断' : '运行已取消', {
    sideEffect: mayWrite ? 'write' : ['llm', 'knowledge'].includes(node.type) ? 'read' : 'none',
    requestSent: mayWrite,
    retryable: false,
    cause: reason,
  });
}

function timeoutReason(node: WorkflowNode): WorkflowNodeError {
  const mayWrite = node.type === 'tool' || node.type === 'agent';
  return new WorkflowNodeError('node_timeout', `节点 ${node.id} 执行超时`, {
    sideEffect: mayWrite ? 'write' : ['llm', 'knowledge'].includes(node.type) ? 'read' : 'none',
    requestSent: mayWrite,
    // 超时是**运行时自己合成**的错误，不是处理器显式声明的可重试错误。
    // 处理器可能仍在执行（只是没返回），重放等于重复发起同一次外部调用，
    // 与 7.4「只有处理器显式抛出 retryable=true 且 sideEffect=read 才重试」的口径冲突。
    retryable: false,
  });
}

async function invokeWithTimeout(
  node: WorkflowNode,
  parentSignal: AbortSignal,
  timeoutMs: number,
  handler: (signal: AbortSignal) => Promise<WorkflowNodeExecutionResult> | WorkflowNodeExecutionResult,
): Promise<WorkflowNodeExecutionResult> {
  if (parentSignal.aborted) throw abortReason(node, parentSignal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forwardAbort = () => controller.abort(abortReason(node, parentSignal));
  parentSignal.addEventListener('abort', forwardAbort, { once: true });
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutReason(node);
      controller.abort(error);
      reject(error);
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([Promise.resolve().then(() => handler(controller.signal)), aborted, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener('abort', forwardAbort);
  }
}

function normalizeNodeError(error: unknown, node: WorkflowNode): WorkflowNodeError {
  if (error instanceof WorkflowNodeError) return error;
  if (error instanceof WorkflowRuntimeError) {
    return new WorkflowNodeError(error.code, error.message, { sideEffect: 'none', requestSent: false, cause: error });
  }
  const mayWrite = node.type === 'tool' || node.type === 'agent';
  return new WorkflowNodeError('node_execution_failed', safeMessage(error), {
    sideEffect: mayWrite ? 'write' : ['llm', 'knowledge'].includes(node.type) ? 'read' : 'none',
    requestSent: mayWrite,
    retryable: false,
    cause: error,
  });
}

function normalizeUsage(value: number | undefined, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowNodeError('invalid_node_result', `${field} 必须是非负整数`, {
      sideEffect: 'none', requestSent: false,
    });
  }
  return value;
}

export class WorkflowRuntime {
  private readonly store: WorkflowStore;
  private readonly handlers: Readonly<Record<string, WorkflowNodeHandler>>;
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private readonly createTraceId: () => string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly nodeTimeoutMs: number;
  private readonly concurrency: WorkflowConcurrencyPort;
  private readonly concurrencyLimits: WorkflowConcurrencyLimits;
  private readonly leases = new Map<string, WorkflowConcurrencyLease>();
  private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly starting = new Map<string, Promise<WorkflowRunRecord>>();
  private readonly active = new Map<string, AbortController>();

  constructor(options: WorkflowRuntimeOptions) {
    this.store = options.store;
    this.handlers = options.handlers ?? {};
    this.now = options.now ?? Date.now;
    this.createRunId = options.createRunId ?? (() => globalThis.crypto.randomUUID());
    this.createTraceId = options.createTraceId ?? (() => globalThis.crypto.randomUUID());
    const maxRetries = typeof options.maxRetries === 'number' && Number.isFinite(options.maxRetries)
      ? options.maxRetries
      : 2;
    const retryDelayMs = typeof options.retryDelayMs === 'number' && Number.isFinite(options.retryDelayMs)
      ? options.retryDelayMs
      : 0;
    const nodeTimeoutMs = typeof options.nodeTimeoutMs === 'number' && Number.isFinite(options.nodeTimeoutMs) && options.nodeTimeoutMs > 0
      ? options.nodeTimeoutMs
      : 60_000;
    this.maxRetries = Math.max(0, Math.min(2, Math.floor(maxRetries)));
    this.retryDelayMs = Math.max(0, Math.floor(retryDelayMs));
    this.nodeTimeoutMs = Math.max(1, Math.floor(nodeTimeoutMs));
    this.concurrency = options.concurrency ?? new InMemoryWorkflowConcurrencyPort();
    this.concurrencyLimits = resolveConcurrencyLimits(options.concurrencyLimits);
  }

  async start(request: WorkflowStartRequest): Promise<WorkflowRunRecord> {
    if (!request.idempotencyKey) return this.startInternal(request);
    const key = JSON.stringify([request.tenantId, request.workflowId, request.initiatorId, request.idempotencyKey]);
    const existing = this.starting.get(key);
    if (existing) {
      // 并发同键：共享同一次初始化，但**仍要比对定义与输入是否一致**。
      // 否则并发同键不同输入的调用方会拿到用别人输入构造的运行，却以为是自己提交的。
      let shared: WorkflowRunRecord;
      try {
        shared = await existing;
      } catch {
        // 共享初始化失败**不等于本请求也失败**：先发起的那次可能在启动阶段就失败
        // （定义不合法、资源白名单不足等），而本请求完全合法。
        // 把别人的失败继承到自己头上会让合法请求被静默丢弃、运行数变成 0，
        // 因此这里回退到自己的初始化路径，由自己的校验与幂等判定决定结果。
        // 直接调 startInternal 而不是 start：否则会再次命中同一个共享 promise 而无限递归。
        return this.startInternal(request);
      }
      return this.matchIdempotentRun(shared, request, canonicalJson(request.input) ?? '');
    }
    const operation = this.startInternal(request);
    this.starting.set(key, operation);
    try {
      return await operation;
    } finally {
      this.starting.delete(key);
    }
  }

  private async startInternal(request: WorkflowStartRequest): Promise<WorkflowRunRecord> {
    if (!request.tenantId || !request.workflowId || !request.initiatorId || !request.definitionChecksum) {
      throw new WorkflowRuntimeError('invalid_run_request', '租户、工作流、发起人及定义校验和不能为空');
    }
    if (!Number.isInteger(request.workflowVersion) || request.workflowVersion <= 0) {
      throw new WorkflowRuntimeError('invalid_run_request', 'workflowVersion 必须是正整数');
    }
    if (!isRecord(request.input)) {
      throw new WorkflowRuntimeError('invalid_input', '运行输入必须是对象');
    }
    assertUsableDefinition(request.definition, request.input, {
      resources: request.resources,
      platformLimits: request.platformLimits,
    });
    jsonBytes(request.identitySnapshot, '身份快照');
    const inputJson = canonicalJson(request.input);

    if (request.idempotencyKey) {
      const existing = await this.store.getWorkflowRunByIdempotencyKey(
        request.tenantId,
        request.workflowId,
        request.initiatorId,
        request.idempotencyKey,
      );
      if (existing) return this.matchIdempotentRun(existing, request, inputJson!);
    }

    const timestamp = iso(this.now());
    const run: WorkflowRunRecord = {
      id: this.createRunId(),
      tenantId: request.tenantId,
      workflowId: request.workflowId,
      workflowVersion: request.workflowVersion,
      initiatorId: request.initiatorId,
      identitySnapshot: request.identitySnapshot,
      input: request.input,
      mode: request.mode,
      status: 'queued',
      definitionSnapshot: request.mode === 'debug' ? request.definition : undefined,
      definitionChecksum: request.definitionChecksum,
      traceId: this.createTraceId(),
      idempotencyKey: request.idempotencyKey,
      lockVersion: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: request.expiresAt,
    };
    const pendingSteps: WorkflowStepRunRecord[] = request.definition.nodes.map((node) => ({
      id: `${run.id}:${node.id}`,
      runId: run.id,
      nodeId: node.id,
      attempt: 1,
      status: 'pending',
      sideEffectUnknown: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    assertPayloadLimit(
      persistentState(run, pendingSteps),
      '运行状态',
      STRUCTURE_LIMITS.maxRunStateBytes,
      'state_limit_exceeded',
    );
    const leaseKey = `${run.tenantId}:${run.id}`;
    const lease = await this.concurrency.acquire({
      runId: run.id,
      tenantId: run.tenantId,
      userId: run.initiatorId,
      workflowId: run.workflowId,
      limits: this.concurrencyLimits,
    });
    if (!lease && request.idempotencyKey) {
      const existing = await this.store.getWorkflowRunByIdempotencyKey(
        request.tenantId, request.workflowId, request.initiatorId, request.idempotencyKey,
      );
      if (existing) return this.matchIdempotentRun(existing, request, inputJson!);
    }
    if (!lease) {
      throw new WorkflowRuntimeError('too_many_running_runs', '租户、用户或工作流的并发运行数已达上限');
    }
    this.leases.set(leaseKey, lease);
    let inserted: boolean;
    try {
      inserted = await this.store.insertWorkflowRun(run);
    } catch (error) {
      await this.releaseLease(leaseKey);
      throw error;
    }
    if (!inserted) {
      await this.releaseLease(leaseKey);
      if (request.idempotencyKey) {
        const existing = await this.store.getWorkflowRunByIdempotencyKey(
          request.tenantId, request.workflowId, request.initiatorId, request.idempotencyKey,
        );
        if (existing) return this.matchIdempotentRun(existing, request, inputJson!);
      }
      throw new WorkflowRuntimeError('run_already_exists', '运行 ID 或幂等键已存在');
    }

    try {
      for (const step of pendingSteps) {
        if (!await this.store.upsertWorkflowStepRun(request.tenantId, step)) {
          throw new WorkflowRuntimeError('step_persistence_failed', `无法创建节点 ${step.nodeId} 的 pending 记录`);
        }
      }
    } catch (error) {
      try {
        await this.store.transitionWorkflowRun(run.tenantId, run.id, 'queued', 0, {
          status: 'failed', errorCode: 'step_persistence_failed', errorMessage: safeMessage(error),
          endedAt: iso(this.now()), updatedAt: iso(this.now()),
        });
      } finally {
        await this.releaseLease(leaseKey);
      }
      throw error;
    }
    return run;
  }

  async execute(tenantId: string, runId: string, options: WorkflowExecuteOptions = {}): Promise<WorkflowRunRecord> {
    return this.runActive(tenantId, runId, options, false);
  }

  async resume(tenantId: string, runId: string, options: WorkflowExecuteOptions = {}): Promise<WorkflowRunRecord> {
    return this.runActive(tenantId, runId, options, true);
  }

  async cancel(tenantId: string, runId: string): Promise<WorkflowRunRecord> {
    return this.stop(tenantId, runId, 'cancelled');
  }

  async interrupt(tenantId: string, runId: string): Promise<WorkflowRunRecord> {
    return this.stop(tenantId, runId, 'interrupted');
  }

  private clearApprovalTimer(key: string): void {
    const timer = this.approvalTimers.get(key);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(key);
  }

  private async releaseLease(key: string): Promise<void> {
    const lease = this.leases.get(key);
    this.leases.delete(key);
    await lease?.release();
  }

  private matchIdempotentRun(
    existing: WorkflowRunRecord,
    request: WorkflowStartRequest,
    inputJson: string,
  ): WorkflowRunRecord {
    let existingInput: string | undefined;
    try {
      existingInput = canonicalJson(existing.input);
    } catch {
      existingInput = undefined;
    }
    if (
      existing.mode !== request.mode ||
      existing.workflowVersion !== request.workflowVersion ||
      existing.definitionChecksum !== request.definitionChecksum ||
      existingInput !== inputJson
    ) {
      throw new WorkflowRuntimeError('idempotency_conflict', '相同幂等键不能复用于不同定义、版本、模式或输入');
    }
    return existing;
  }

  private async transition(
    run: WorkflowRunRecord,
    status: WorkflowRunRecord['status'],
    patch: Omit<WorkflowRunTransitionPatch, 'status' | 'updatedAt'> & { updatedAt?: string } = {},
  ): Promise<WorkflowRunRecord> {
    assertRunTransition(run.status, status);
    const updated = await this.store.transitionWorkflowRun(
      run.tenantId,
      run.id,
      run.status,
      run.lockVersion,
      { ...patch, status, updatedAt: patch.updatedAt ?? iso(this.now()) },
    );
    if (!updated) {
      throw new WorkflowRuntimeError('run_transition_conflict', '运行已被其他执行者更新，请重新读取后再操作');
    }
    return updated;
  }

  /**
   * 推进运行到终态；与取消方并发时以数据库中的最终状态为准。
   *
   * `cancel()` 与执行器收敛会同时推进同一个运行：先写入的一方决定终态，
   * 后写入的一方必须拿到「最终运行记录」，而不是抛转换冲突让调用方无从判断结果。
   */
  private async transitionToTerminal(
    run: WorkflowRunRecord,
    target: WorkflowRunStatus,
    patch: Omit<WorkflowRunTransitionPatch, 'status' | 'updatedAt'> & { updatedAt?: string } = {},
  ): Promise<WorkflowRunRecord> {
    try {
      return await this.transition(run, target, patch);
    } catch (error) {
      if (!isTransitionConflict(error)) throw error;
      const latest = await this.store.getWorkflowRun(run.tenantId, run.id);
      if (latest && isTerminalRunStatus(latest.status)) return latest;
      throw error;
    }
  }

  /**
   * 汇总本次运行所有步骤的缺失引用。
   *
   * 写入运行终态时调用，让「运行结束后结果是否缺字段」有据可查；
   * 没有缺失时返回 undefined，不写库。
   */
  private async collectMissingRefs(tenantId: string, runId: string): Promise<string[] | undefined> {
    const steps = await this.store.listWorkflowStepRuns(tenantId, runId, { limit: STRUCTURE_LIMITS.maxNodes });
    const refs = new Set<string>();
    for (const step of steps) {
      for (const ref of step.missingRefs ?? []) refs.add(ref);
    }
    return refs.size > 0 ? [...refs].sort() : undefined;
  }

  private async definitionForRun(run: WorkflowRunRecord): Promise<WorkflowDefinition> {
    if (run.mode === 'debug') {
      if (!run.definitionSnapshot) {
        throw new WorkflowRuntimeError('missing_definition', '调试运行缺少定义快照');
      }
      return run.definitionSnapshot as WorkflowDefinition;
    }
    const version = await this.store.getWorkflowVersion(run.tenantId, run.workflowId, run.workflowVersion);
    if (!version || version.status !== 'published') {
      throw new WorkflowRuntimeError('missing_definition', '正式运行找不到对应的已发布版本');
    }
    if (version.checksum !== run.definitionChecksum) {
      throw new WorkflowRuntimeError('definition_checksum_mismatch', '运行定义校验和与已发布版本不一致');
    }
    return version.definition as WorkflowDefinition;
  }

  private async runActive(
    tenantId: string,
    runId: string,
    options: WorkflowExecuteOptions,
    resuming: boolean,
  ): Promise<WorkflowRunRecord> {
    const key = `${tenantId}:${runId}`;
    if (this.active.has(key)) {
      throw new WorkflowRuntimeError('run_already_active', '该运行已在当前进程中执行');
    }
    if (resuming) this.clearApprovalTimer(key);
    const controller = new AbortController();
    this.active.set(key, controller);
    const externalAbort = () => controller.abort(new WorkflowRuntimeError('run_cancelled', '运行已取消'));
    if (options.signal?.aborted) externalAbort();
    else options.signal?.addEventListener('abort', externalAbort, { once: true });
    let ownedRun: WorkflowRunRecord | undefined;
    try {
      let run = await this.store.getWorkflowRun(tenantId, runId);
      if (!run) throw new WorkflowRuntimeError('run_not_found', '运行不存在');
      const expected = resuming ? 'waiting_approval' : 'queued';
      if (run.status !== expected) {
        throw new WorkflowRuntimeError('invalid_run_state', `${resuming ? '恢复' : '启动'}要求状态为 ${expected}，实际为 ${run.status}`);
      }
      run = await this.transition(run, 'running', {
        startedAt: run.startedAt ?? iso(this.now()),
        errorCode: null,
        errorMessage: null,
        endedAt: null,
      });
      ownedRun = run;
      if (controller.signal.aborted) {
        return await this.settleFailure(run, 'run_cancelled', '运行已取消');
      }

      const definition = await this.definitionForRun(run);
      if (!isRecord(run.input)) throw new WorkflowRuntimeError('invalid_input', '运行输入必须是对象');
      assertUsableDefinition(definition, run.input, {
        resources: options.resources,
        platformLimits: options.platformLimits,
      });
      const limits = resolveLimits(definition.limits, options.platformLimits);
      const startedAt = Date.parse(run.startedAt ?? run.createdAt);
      if (!Number.isFinite(startedAt)) throw new WorkflowRuntimeError('invalid_run_state', '运行开始时间非法');
      const deadline = startedAt + limits.timeoutMs;
      const order = topologicalOrder(definition.nodes, definition.edges);
      if (!order) throw new WorkflowRuntimeError('invalid_definition', '工作流无法形成稳定拓扑顺序');
      const storedSteps = await this.store.listWorkflowStepRuns(tenantId, runId, { limit: STRUCTURE_LIMITS.maxNodes });
      const steps = new Map(storedSteps.map((step) => [step.nodeId, step]));
      if (steps.size !== definition.nodes.length) {
        throw new WorkflowRuntimeError('missing_pending_steps', '运行的 pending 步骤不完整，禁止产生外部副作用');
      }
      if ([...steps.values()].some((step) => step.sideEffectUnknown)) {
        const code = 'side_effect_unknown';
        const message = '存在结果不明的写操作，禁止自动恢复或重放';
        const current = [...steps.values()].find((step) => step.sideEffectUnknown)!;
        if (current.status !== 'failed') {
          const failed = { ...current, status: 'failed' as const, errorCode: code, errorMessage: message,
            endedAt: iso(this.now()), updatedAt: iso(this.now()) };
          await this.store.upsertWorkflowStepRun(tenantId, failed);
        }
        return await this.settleFailure(run, code, message);
      }

      let context: ConditionContext = { input: run.input, nodes: {} };
      const selectedEdges = new Map<string, boolean>();
      const progress = restoreProgress([...steps.values()]);
      for (const node of order) {
        const step = steps.get(node.id);
        if (!step) throw new WorkflowRuntimeError('missing_pending_steps', `缺少节点 ${node.id} 的步骤记录`);
        if (step.status === 'succeeded') {
          if (!isRecord(step.output)) {
            throw new WorkflowRuntimeError('invalid_step_state', `已完成节点 ${node.id} 缺少对象输出`);
          }
          context.nodes![node.id] = { output: step.output };
          const branch = node.type === 'condition'
            ? this.conditionBranch(node, context)
            : node.type === 'approval'
              ? this.approvalBranch(definition, node, step.output)
              : undefined;
          this.selectOutgoing(definition, node.id, true, branch, selectedEdges);
          continue;
        }
        if (step.status === 'skipped') {
          this.selectOutgoing(definition, node.id, false, undefined, selectedEdges);
          continue;
        }
        if (step.status === 'failed' || (step.status === 'running' && !resuming) ||
            (step.status === 'waiting_approval' && !resuming)) {
          throw new WorkflowRuntimeError('invalid_step_state', `节点 ${node.id} 的状态 ${step.status} 无法继续执行`);
        }
        const incoming = definition.edges.filter((edge) => edge.target === node.id);
        const selected = node.type === 'input' || incoming.some((edge) => selectedEdges.get(edge.id) === true);
        if (!selected) {
          if (step.status !== 'pending') {
            throw new WorkflowRuntimeError('invalid_step_state', `非 pending 节点 ${node.id} 不能被跳过`);
          }
          assertStepTransition(step.status, 'skipped');
          const skipped: WorkflowStepRunRecord = {
            ...step, status: 'skipped', endedAt: iso(this.now()), updatedAt: iso(this.now()),
          };
          await this.persistStep(tenantId, skipped);
          steps.set(node.id, skipped);
          this.selectOutgoing(definition, node.id, false, undefined, selectedEdges);
          continue;
        }

        const outcome = await this.executeNode({
          run, node, step, definition, context, limits, progress, steps,
          deadline, controller, resuming: resuming && step.status === 'waiting_approval',
        });
        steps.set(node.id, outcome.step);
        if (outcome.kind === 'failed') {
          return await this.settleFailure(run, outcome.code, outcome.message);
        }
        if (outcome.kind === 'waiting_approval') {
          run = await this.transition(run, 'waiting_approval');
          ownedRun = run;
          this.scheduleApprovalTimeout(run, outcome.step, limits, deadline);
          return run;
        }
        context = outcome.context;
        this.selectOutgoing(definition, node.id, true, outcome.branch, selectedEdges);
      }
      run = await this.transitionToTerminal(run, 'succeeded', {
        endedAt: iso(this.now()),
        missingRefs: await this.collectMissingRefs(tenantId, runId),
      });
      ownedRun = run;
      this.clearApprovalTimer(key);
      await this.releaseLease(key);
      return run;
    } catch (error) {
      // 并发取消 / 中断：取消方与执行器会同时推进运行状态，
      // 此时以数据库中的最终状态为准 —— 返回最终运行记录，而不是抛转换冲突。
      if (isTransitionConflict(error)) {
        const latest = await this.store.getWorkflowRun(tenantId, runId);
        if (latest && isTerminalRunStatus(latest.status)) {
          this.clearApprovalTimer(key);
          await this.releaseLease(key);
          return latest;
        }
        throw error;
      }
      if (!ownedRun || (error instanceof WorkflowRuntimeError &&
          ['run_not_found', 'invalid_run_state', 'run_already_active'].includes(error.code))) {
        // 运行已不存在或已是终态时，不再占用并发额度。
        // run_already_active 例外：那次执行还在跑，租约不能动。
        if (error instanceof WorkflowRuntimeError && error.code !== 'run_already_active') {
          const latest = await this.store.getWorkflowRun(tenantId, runId);
          if (!latest || isTerminalRunStatus(latest.status)) {
            this.clearApprovalTimer(key);
            await this.releaseLease(key);
          }
        }
        throw error;
      }
      const latest = await this.store.getWorkflowRun(tenantId, runId);
      if (latest && isTerminalRunStatus(latest.status)) {
        // 运行已是终态（被其他执行者收敛）：按 R5「运行进入终态即释放租约」交还并发额度，
        // 否则并发名额会随着这类异常路径持续泄漏。
        // releaseLease 幂等（先摘除再释放），重复调用不会重复释放租约。
        this.clearApprovalTimer(key);
        await this.releaseLease(key);
        return latest;
      }
      const code = error instanceof WorkflowRuntimeError || error instanceof WorkflowNodeError
        ? error.code
        : 'runtime_error';
      return await this.settleFailure(ownedRun, code, safeMessage(error));
    } finally {
      options.signal?.removeEventListener('abort', externalAbort);
      this.active.delete(key);
    }
  }

  private scheduleApprovalTimeout(
    run: WorkflowRunRecord,
    step: WorkflowStepRunRecord,
    limits: ReturnType<typeof resolveLimits>,
    runDeadline: number,
  ): void {
    const key = `${run.tenantId}:${run.id}`;
    this.clearApprovalTimer(key);
    const startedAt = Date.parse(step.startedAt ?? step.updatedAt);
    const approvalDeadline = (Number.isFinite(startedAt) ? startedAt : this.now()) + limits.approvalTimeoutMs;
    const deadline = Math.min(approvalDeadline, runDeadline);
    const code = deadline === runDeadline ? 'run_timeout' : 'approval_timeout';
    const expectedLockVersion = run.lockVersion;
    const timer = setTimeout(() => {
      this.approvalTimers.delete(key);
      void this.expireWaitingRun(run.tenantId, run.id, expectedLockVersion, step.nodeId, code)
        .catch(() => undefined);
    }, Math.max(1, deadline - this.now()));
    timer.unref?.();
    this.approvalTimers.set(key, timer);
  }

  private async expireWaitingRun(
    tenantId: string,
    runId: string,
    expectedLockVersion: number,
    nodeId: string,
    code: 'run_timeout' | 'approval_timeout',
  ): Promise<void> {
    const run = await this.store.getWorkflowRun(tenantId, runId);
    if (!run || run.status !== 'waiting_approval' || run.lockVersion !== expectedLockVersion) return;
    const message = code === 'run_timeout' ? '运行总时限已耗尽' : '审批等待时限已耗尽';
    await this.transitionToTerminal(run, 'failed', {
      errorCode: code, errorMessage: message, endedAt: iso(this.now()),
      missingRefs: await this.collectMissingRefs(tenantId, runId),
    });
    try {
      const step = await this.store.getWorkflowStepRun(tenantId, runId, nodeId);
      if (step?.status === 'waiting_approval') {
        await this.persistStep(tenantId, {
          ...step, status: 'failed', errorCode: code, errorMessage: message,
          endedAt: iso(this.now()), updatedAt: iso(this.now()),
        });
      }
    } finally {
      await this.releaseLease(`${tenantId}:${runId}`);
    }
  }

  private conditionBranch(node: WorkflowNode, context: ConditionContext): BranchKind {
    const expression = isRecord(node.config) ? node.config.condition : undefined;
    const evaluation = evaluateCondition(expression as ConditionExpr | undefined, context);
    if (evaluation.issues.length > 0) {
      throw new WorkflowRuntimeError(
        'condition_evaluation',
        evaluation.issues.map((issue) => `${issue.code}: ${issue.message}`).join('；'),
      );
    }
    return evaluation.value ? 'true' : 'false';
  }

  /**
   * 人工审核节点的分支出口。
   *
   * - 定义里没有任何带分支标记的出边 → 线性流程，按普通节点处理（返回 undefined）。
   * - 有分支标记 → `output.approved` 必须显式给出布尔值：
   *   false 走 `rejected`，true 走 `approved`；缺少对应分支时直接失败，
   *   **不能**默认按通过处理，更不能静默跳过下游继续执行写工具。
   */
  private approvalBranch(definition: WorkflowDefinition, node: WorkflowNode, output: unknown): BranchKind | undefined {
    const labelled = definition.edges.filter((edge) => edge.source === node.id && edge.branch !== undefined);
    if (labelled.length === 0) return undefined;
    const approved = isRecord(output) ? output.approved : undefined;
    if (typeof approved !== 'boolean') {
      throw new WorkflowNodeError(
        'invalid_node_result',
        `审核节点 ${node.id} 必须返回布尔型的 output.approved`,
        { sideEffect: 'none', requestSent: false, retryable: false },
      );
    }
    const branch: BranchKind = approved ? 'approved' : 'rejected';
    if (!labelled.some((edge) => edge.branch === branch)) {
      throw new WorkflowNodeError(
        'approval_branch_missing',
        `审核节点 ${node.id} 缺少 ${branch} 分支`,
        { sideEffect: 'none', requestSent: false, retryable: false },
      );
    }
    return branch;
  }

  private selectOutgoing(
    definition: WorkflowDefinition,
    nodeId: string,
    succeeded: boolean,
    branch: BranchKind | undefined,
    selected: Map<string, boolean>,
  ): void {
    for (const edge of definition.edges) {
      if (edge.source !== nodeId) continue;
      selected.set(edge.id, succeeded && (branch === undefined || edge.branch === branch));
    }
  }

  private async persistStep(tenantId: string, step: WorkflowStepRunRecord): Promise<void> {
    if (!await this.store.upsertWorkflowStepRun(tenantId, step)) {
      throw new WorkflowRuntimeError('step_persistence_failed', `无法持久化节点 ${step.nodeId} 的状态`);
    }
  }

  private async persistExecutionStep(
    run: WorkflowRunRecord,
    steps: Map<string, WorkflowStepRunRecord>,
    step: WorkflowStepRunRecord,
  ): Promise<void> {
    const next = new Map(steps);
    next.set(step.nodeId, step);
    assertPayloadLimit(
      persistentState(run, next.values()),
      '运行状态',
      STRUCTURE_LIMITS.maxRunStateBytes,
      'state_limit_exceeded',
    );
    await this.persistStep(run.tenantId, step);
    steps.set(step.nodeId, step);
  }

  private async executeNode(args: {
    run: WorkflowRunRecord;
    node: WorkflowNode;
    step: WorkflowStepRunRecord;
    steps: Map<string, WorkflowStepRunRecord>;
    definition: WorkflowDefinition;
    context: ConditionContext;
    limits: ReturnType<typeof resolveLimits>;
    progress: RunProgress;
    deadline: number;
    controller: AbortController;
    resuming: boolean;
  }): Promise<NodeOutcome> {
    const { run, node, definition, context, limits, progress, deadline, controller, resuming } = args;
    let step = args.step;
    const finishFailure = async (
      code: string,
      message: string,
      sideEffectUnknown = step.sideEffectUnknown,
    ): Promise<NodeFailureOutcome> => {
      assertStepTransition(step.status, 'failed');
      step = {
        ...step,
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        sideEffectUnknown,
        endedAt: iso(this.now()),
        updatedAt: iso(this.now()),
      };
      await this.persistExecutionStep(run, args.steps, step);
      return { kind: 'failed', step, code, message };
    };
    if (step.sideEffectUnknown) {
      return finishFailure('side_effect_unknown', '写操作结果不明，禁止自动重放');
    }
    if (step.status !== 'pending' && !(resuming && step.status === 'waiting_approval')) {
      throw new WorkflowRuntimeError('invalid_step_state', `节点 ${node.id} 不能从 ${step.status} 启动`);
    }
    assertStepTransition(step.status, 'running');
    step = {
      ...step,
      status: 'running',
      startedAt: step.startedAt ?? iso(this.now()),
      endedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: iso(this.now()),
    };
    await this.persistExecutionStep(run, args.steps, step);

    if (controller.signal.aborted) {
      const error = abortReason(node, controller.signal);
      return finishFailure(error.code, error.message);
    }
    if (this.now() >= deadline) return finishFailure('run_timeout', '运行总时限已耗尽');
    if (resuming && step.startedAt && this.now() - Date.parse(step.startedAt) >= limits.approvalTimeoutMs) {
      return finishFailure('approval_timeout', '审批等待时限已耗尽');
    }
    if (resuming && progress.steps > limits.maxSteps) {
      return finishFailure('step_limit_exceeded', `运行步骤数超过上限 ${limits.maxSteps}`);
    }
    if (!resuming) {
      if (progress.steps >= limits.maxSteps) {
        return finishFailure('step_limit_exceeded', `运行步骤数超过上限 ${limits.maxSteps}`);
      }
      progress.steps += 1;
    }
    // 本次尝试预留的额度类型：处理器返回 waiting_approval 时要退回，
    // 因为那一次只是去申请审批，并没有真正执行外部动作。
    let reservedCall: 'llm' | 'tool' | undefined;

    while (true) {
      if (controller.signal.aborted) {
        const error = abortReason(node, controller.signal);
        return finishFailure(error.code, error.message);
      }
      if (this.now() >= deadline) return finishFailure('run_timeout', '运行总时限已耗尽');
      reservedCall = undefined;
      // 处理器是否已经被调用过 / 是否已经返回结果：
      // 调用过说明外部副作用可能已经发生；返回过说明写操作很可能已经落地，
      // 后续的结果校验失败必须按「结果不确定」留痕。
      // 这两个标志**按 attempt 计**（声明在重试循环内）：
      // 上一轮尝试调用过处理器，不代表本轮也调用过 ——
      // 额度在预留阶段就被拦下时本轮根本没有发生外部调用，
      // 不能把上一轮的证据当成这一轮的写副作用（见 7.4「没有发生调用，就不该计费」）。
      let handlerInvoked = false;
      let handlerCompleted = false;
      try {
        let result: WorkflowNodeExecutionResult;
        let branch: BranchKind | undefined;
        if (node.type === 'input') {
          result = { kind: 'success', output: run.input as Record<string, unknown> };
        } else if (node.type === 'condition') {
          branch = this.conditionBranch(node, context);
          result = { kind: 'success', output: {} };
        } else {
          let config: Record<string, unknown>;
          // 恢复路径沿用挂起前持久化的配置与缺失引用，不重新解析。
          let missingRefs = step.missingRefs;
          if (resuming) {
            if (!isRecord(step.input)) {
              throw new WorkflowNodeError('invalid_step_state', '审批恢复缺少挂起前持久化的节点输入', {
                sideEffect: 'none', requestSent: false,
              });
            }
            config = step.input;
          } else {
            const resolved = resolveTemplate(node.config ?? {}, context);
            const value = resolved.missing ? {} : resolved.value;
            if (!isRecord(value)) {
              throw new WorkflowNodeError('invalid_input', '节点配置解析结果必须是对象', {
                sideEffect: 'none', requestSent: false,
              });
            }
            config = value;
            missingRefs = normalizeMissingRefs(resolved.missingRefs);
            if (missingRefs.length > 0) {
              // 缺失引用先落库：后续校验失败时，运行结束后仍能判断缺了哪些字段。
              step = { ...step, missingRefs, updatedAt: iso(this.now()) };
              await this.persistExecutionStep(run, args.steps, step);
            }
          }
          const inputErrors = validateValue(config, node.inputSchema, `$.nodes.${node.id}.input`);
          if (inputErrors.length > 0) {
            const missing = inputErrors.some((error) => error.includes('缺少必填字段'));
            throw new WorkflowNodeError(missing ? 'missing_input' : 'invalid_input', inputErrors.join('；'), {
              sideEffect: 'none', requestSent: false, retryable: false,
            });
          }
          assertPayloadLimit(config, `节点 ${node.id} 输入`, STRUCTURE_LIMITS.maxNodePayloadBytes, 'input_too_large');
          const configured: WorkflowStepRunRecord = {
            ...step,
            input: config,
            // 缺失引用必须留痕，否则运行结束后无从判断结果是否缺字段。
            missingRefs: missingRefs && missingRefs.length > 0 ? missingRefs : undefined,
            updatedAt: iso(this.now()),
          };
          await this.persistExecutionStep(run, args.steps, configured);
          step = configured;
          // 额度预留：调用处理器之前先占位，超限就不再发起外部调用。
          // 处理器查找放在额度预留之前：**没有处理器就没有调用，不该占额度**。
          const handler = this.handlers[`${node.type}:${node.implVersion ?? 1}`];
          if (!handler) {
            throw new WorkflowNodeError('missing_node_handler', `未注册 ${node.type}:${node.implVersion ?? 1} 节点处理器`, {
              sideEffect: 'none', requestSent: false,
            });
          }
          // **每次调用都占额度，恢复执行同样要占** —— 否则反复 resume 可以无限超发外部调用。
          if (node.type === 'llm') {
            if (progress.llmCalls >= limits.maxLlmCalls) {
              throw new WorkflowNodeError('llm_call_limit_exceeded', `LLM 调用次数超过上限 ${limits.maxLlmCalls}`, {
                sideEffect: 'none', requestSent: false,
              });
            }
            progress.llmCalls += 1;
            step.llmCalls = (step.llmCalls ?? 0) + 1;
            reservedCall = 'llm';
          }
          if (node.type === 'tool' || node.type === 'knowledge') {
            if (progress.toolCalls >= limits.maxToolCalls) {
              throw new WorkflowNodeError('tool_call_limit_exceeded', `工具调用次数超过上限 ${limits.maxToolCalls}`, {
                sideEffect: 'none', requestSent: false,
              });
            }
            progress.toolCalls += 1;
            step.toolCalls = (step.toolCalls ?? 0) + 1;
            reservedCall = 'tool';
          }
          if (reservedCall) {
            step.updatedAt = iso(this.now());
            await this.persistExecutionStep(run, args.steps, step);
          }
          const timeoutMs = Math.min(this.nodeTimeoutMs, Math.max(1, deadline - this.now()));
          handlerInvoked = true;
          // 每次尝试重新计数：只有处理器真的返回了结果，才算「结果已到手」。
          handlerCompleted = false;
          result = await invokeWithTimeout(node, controller.signal, timeoutMs, (signal) => handler({
            run,
            node,
            config,
            input: run.input as Record<string, unknown>,
            context,
            attempt: step.attempt,
            resuming,
            signal,
            remainingCalls: {
              llm: Math.max(0, limits.maxLlmCalls - progress.llmCalls),
              tool: Math.max(0, limits.maxToolCalls - progress.toolCalls),
            },
          }));
          // 处理器已经返回：外部写操作可能已经落地，后续任何失败都要按「结果不明」留痕。
          handlerCompleted = true;
        }
        if (!result || (result.kind !== 'success' && result.kind !== 'waiting_approval')) {
          throw new WorkflowNodeError('invalid_node_result', '节点处理器返回了未知结果', {
            sideEffect: 'none', requestSent: false,
          });
        }
        if (node.type === 'approval' && result.kind === 'success') {
          // 审核节点按通过/驳回选边；缺少对应分支时直接失败，不静默跳过下游。
          branch = this.approvalBranch(definition, node, result.output);
        }
        const additionalLlmCalls = normalizeUsage(result.llmCalls, 'llmCalls');
        const additionalToolCalls = normalizeUsage(result.toolCalls, 'toolCalls');
        progress.llmCalls += additionalLlmCalls;
        progress.toolCalls += additionalToolCalls;
        step.llmCalls = (step.llmCalls ?? 0) + additionalLlmCalls;
        step.toolCalls = (step.toolCalls ?? 0) + additionalToolCalls;
        if (progress.llmCalls > limits.maxLlmCalls) {
          throw new WorkflowNodeError('llm_call_limit_exceeded', `LLM 调用次数超过上限 ${limits.maxLlmCalls}`, {
            sideEffect: 'none', requestSent: false,
          });
        }
        if (progress.toolCalls > limits.maxToolCalls) {
          throw new WorkflowNodeError('tool_call_limit_exceeded', `工具调用次数超过上限 ${limits.maxToolCalls}`, {
            sideEffect: 'none', requestSent: false,
          });
        }
        if (result.kind === 'waiting_approval') {
          if (!result.approvalId) {
            throw new WorkflowNodeError('invalid_node_result', '等待审批结果必须包含 approvalId', {
              sideEffect: 'none', requestSent: false,
            });
          }
          // 这次调用只是去申请审批，没有完成外部动作：退回预留额度。
          // 额度与副作用用**同一口径**：既然没有外部动作，就不该留下「结果不明」的痕迹。
          if (reservedCall === 'llm') {
            progress.llmCalls = Math.max(0, progress.llmCalls - 1);
            step.llmCalls = Math.max(0, (step.llmCalls ?? 1) - 1);
          } else if (reservedCall === 'tool') {
            progress.toolCalls = Math.max(0, progress.toolCalls - 1);
            step.toolCalls = Math.max(0, (step.toolCalls ?? 1) - 1);
          }
          if (resuming) {
            // 审批只能消费一次：恢复执行后不允许再次挂起，
            // 否则同一节点可以被反复 resume，无限次调用处理器而不受额度约束。
            // 处理器这次同样没有完成外部动作 → 不留 `side_effect_unknown`，
            // 不能凭空造出一次「需要人工核查外部系统」的责任。
            return finishFailure('repeated_approval', `节点 ${node.id} 在恢复后不能再次等待审批`);
          }
          assertStepTransition(step.status, 'waiting_approval');
          step = { ...step, status: 'waiting_approval', approvalId: result.approvalId, updatedAt: iso(this.now()) };
          await this.persistExecutionStep(run, args.steps, step);
          return { kind: 'waiting_approval', step };
        }
        if (!isRecord(result.output)) {
          throw new WorkflowNodeError('invalid_output', '节点输出必须是对象', {
            sideEffect: 'none', requestSent: false,
          });
        }
        assertPayloadLimit(result.output, `节点 ${node.id} 输出`, STRUCTURE_LIMITS.maxNodePayloadBytes, 'output_too_large');
        const outputErrors = validateValue(
          result.output,
          getEffectiveOutputSchema(node, definition),
          `$.nodes.${node.id}.output`,
        );
        if (outputErrors.length > 0) {
          throw new WorkflowNodeError('invalid_output', outputErrors.join('；'), {
            sideEffect: 'none', requestSent: false,
          });
        }
        const nextContext: ConditionContext = {
          input: context.input,
          nodes: { ...context.nodes, [node.id]: { output: result.output } },
        };
        assertPayloadLimit(nextContext, '运行状态', STRUCTURE_LIMITS.maxRunStateBytes, 'state_limit_exceeded');
        if (controller.signal.aborted) throw abortReason(node, controller.signal);
        assertStepTransition(step.status, 'succeeded');
        const completed: WorkflowStepRunRecord = {
          ...step,
          status: 'succeeded',
          output: result.output,
          errorCode: undefined,
          errorMessage: undefined,
          endedAt: iso(this.now()),
          updatedAt: iso(this.now()),
        };
        await this.persistExecutionStep(run, args.steps, completed);
        step = completed;
        return { kind: 'success', step, context: nextContext, branch };
      } catch (rawError) {
        const error = normalizeNodeError(rawError, node);
        // 已经调用过处理器的写节点，即使失败原因是「返回值不合法」，
        // 外部写操作也可能已经落地 —— 必须留 `side_effect_unknown`，
        // 否则恢复逻辑会误以为这次写是干净的可重放（见 8.3 安全恢复）。
        // 副作用判定以处理器显式声明为准，而不是只看节点类型：
        // - 处理器已返回但结果校验失败 → 写操作可能已经落地，结果不明；
        // - 处理器声明 sideEffect=write 且请求已发出 → 结果不明；
        // - 处理器声明 sideEffect=none（对 tool/agent 而言语义不明）→ 保守按结果不明处理；
        // - 处理器声明 sideEffect=read（只读工具）→ 明确没有写副作用，可按只读错误重试。
        const mayHaveWritten = node.type === 'tool' || node.type === 'agent';
        const sideEffectUnknown = step.sideEffectUnknown
          || (error.sideEffect === 'write' && error.requestSent)
          || (handlerInvoked && mayHaveWritten && (handlerCompleted || error.sideEffect === 'none'));
        const retry = !controller.signal.aborted &&
          RETRYABLE_NODE_TYPES.has(node.type) &&
          error.retryable && error.sideEffect === 'read' && !sideEffectUnknown &&
          step.attempt <= this.maxRetries;
        if (!retry) return finishFailure(error.code, error.message, sideEffectUnknown);
        step = {
          ...step,
          attempt: step.attempt + 1,
          status: 'running',
          startedAt: iso(this.now()),
          errorCode: error.code,
          errorMessage: error.message,
          updatedAt: iso(this.now()),
        };
        await this.persistExecutionStep(run, args.steps, step);
        if (this.retryDelayMs > 0) await this.retryDelay(this.retryDelayMs, controller.signal);
      }
    }
  }

  private async retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async settleFailure(
    run: WorkflowRunRecord,
    code: string,
    message: string,
  ): Promise<WorkflowRunRecord> {
    const latest = await this.store.getWorkflowRun(run.tenantId, run.id);
    if (!latest) throw new WorkflowRuntimeError('run_not_found', '运行不存在');
    const key = `${run.tenantId}:${run.id}`;
    if (isTerminalRunStatus(latest.status)) {
      this.clearApprovalTimer(key);
      await this.releaseLease(key);
      return latest;
    }
    const target = code === 'run_cancelled' ? 'cancelled' : code === 'run_interrupted' ? 'interrupted' : 'failed';
    if (!canTransitionRun(latest.status, target)) {
      throw new WorkflowRuntimeError('run_transition_conflict', `无法从 ${latest.status} 转换为 ${target}`);
    }
    const updated = await this.transitionToTerminal(latest, target, {
      errorCode: code,
      errorMessage: message,
      endedAt: iso(this.now()),
      missingRefs: await this.collectMissingRefs(run.tenantId, run.id),
    });
    this.clearApprovalTimer(key);
    await this.releaseLease(key);
    return updated;
  }

  private async stop(
    tenantId: string,
    runId: string,
    target: 'cancelled' | 'interrupted',
  ): Promise<WorkflowRunRecord> {
    const code = target === 'cancelled' ? 'run_cancelled' : 'run_interrupted';
    const message = target === 'cancelled' ? '运行已取消' : '运行已中断';
    const key = `${tenantId}:${runId}`;
    this.clearApprovalTimer(key);
    this.active.get(key)?.abort(new WorkflowRuntimeError(code, message));
    const run = await this.store.getWorkflowRun(tenantId, runId);
    if (!run) throw new WorkflowRuntimeError('run_not_found', '运行不存在');
    if (isTerminalRunStatus(run.status)) {
      await this.releaseLease(key);
      return run;
    }
    // 与执行器收敛并发时：先写入的一方决定终态，
    // 后写入的一方拿到数据库里的最终运行记录，而不是抛转换冲突。
    const finalRun = await this.transitionToTerminal(run, target, {
      errorCode: code,
      errorMessage: message,
      endedAt: iso(this.now()),
      missingRefs: await this.collectMissingRefs(tenantId, runId),
    });
    try {
      const steps = await this.store.listWorkflowStepRuns(tenantId, runId, { limit: STRUCTURE_LIMITS.maxNodes });
      for (const step of steps) {
        if (step.status !== 'running' && step.status !== 'waiting_approval') continue;
        assertStepTransition(step.status, 'failed');
        await this.persistStep(tenantId, {
          ...step,
          status: 'failed',
          errorCode: code,
          errorMessage: message,
          endedAt: iso(this.now()),
          updatedAt: iso(this.now()),
        });
      }
      return finalRun;
    } finally {
      await this.releaseLease(key);
    }
  }
}
