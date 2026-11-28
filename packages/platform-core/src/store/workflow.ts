export type WorkflowVisibility = 'private' | 'department' | 'tenant';
export type WorkflowVersionStatus = 'draft' | 'in_review' | 'published' | 'rejected';
export type WorkflowRunMode = 'debug' | 'published';
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'skipped';
export type WorkflowTemplateScope = 'platform' | 'tenant';
export type WorkflowTemplateStatus = 'draft' | 'published';

export interface WorkflowRecord {
  id: string;
  tenantId: string;
  ownerId: string;
  /**
   * 归属部门 —— `visibility='department'` 时用于可见范围判定（见 3.2）。
   *
   * 允许缺省：缺省时该工作流对任何部门都不可见（只有 tenant 作用域可见）。
   */
  deptId?: string;
  name: string;
  description?: string;
  visibility: WorkflowVisibility;
  currentDraftVersion?: number;
  latestPublishedVersion?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface WorkflowVersionRecord {
  workflowId: string;
  version: number;
  tenantId: string;
  definition: unknown;
  checksum: string;
  status: WorkflowVersionStatus;
  createdBy: string;
  createdAt: string;
  /**
   * 最后一次**改动内容**的人。
   *
   * 与 `createdBy` 分开：`createdBy` 是最初作者（不可变），`lastModifiedBy` 是最近改过定义的人。
   * 「禁止自审」必须同时看这两列 —— 只看 `createdBy` 会被绕过：
   * 管理员覆盖了别人的草稿后，`createdBy` 仍是原作者，但内容已经是管理员写的，
   * 只按原作者判定就等于允许管理员自审自发（见 §9.2 / §10.1）。
   *
   * 缺省表示「最后一次改动不是由已认证身份发起的」（平台内部写入），
   * 判定时按 `createdBy` 兜底。
   */
  lastModifiedBy?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  publishedBy?: string;
  publishedAt?: string;
}

export interface WorkflowRunRecord {
  id: string;
  tenantId: string;
  workflowId: string;
  workflowVersion: number;
  initiatorId: string;
  identitySnapshot: Record<string, unknown>;
  input: unknown;
  mode: WorkflowRunMode;
  status: WorkflowRunStatus;
  definitionSnapshot?: unknown;
  definitionChecksum: string;
  traceId: string;
  idempotencyKey?: string;
  lockVersion: number;
  errorCode?: string;
  errorMessage?: string;
  /**
   * 本次运行里**未能解析**的引用表达式汇总。
   *
   * 按 R3，引用不到值等价于「字段不存在」，非必填时不阻断运行；
   * 但缺失必须留痕，否则运行结束后无从判断结果是否缺字段。
   * 运行时在写入终态时汇总各步骤的 `missingRefs`。
   */
  missingRefs?: string[];
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface WorkflowRunTransitionPatch {
  status: WorkflowRunStatus;
  updatedAt: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  expiresAt?: string | null;
  /** 终态时写入的缺失引用汇总；null 表示清空。 */
  missingRefs?: string[] | null;
}

export interface WorkflowStepRunRecord {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: WorkflowStepStatus;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  approvalId?: string;
  idempotencyKey?: string;
  sideEffectUnknown: boolean;
  /** 当前步骤累计的模型/工具调用次数，用于审批恢复后重建运行限额。 */
  llmCalls?: number;
  toolCalls?: number;
  /**
   * 本步骤里**未能解析**的引用列表。
   *
   * 按 R3，引用不到值等价于「字段不存在」而非填默认值；
   * 但缺失本身必须留痕，否则运行成功后无法判断结果是否缺字段。
   */
  missingRefs?: string[];
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplateRecord {
  id: string;
  scope: WorkflowTemplateScope;
  tenantId?: string;
  name: string;
  description?: string;
  status: WorkflowTemplateStatus;
  currentDraftVersion?: number;
  latestPublishedVersion?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface WorkflowTemplateVersionRecord {
  templateId: string;
  version: number;
  definition: unknown;
  resourceSlots: unknown[];
  checksum: string;
  status: WorkflowTemplateStatus;
  createdBy: string;
  createdAt: string;
  publishedBy?: string;
  publishedAt?: string;
}

/** 列表分页参数。 */
export interface WorkflowListOptions {
  /** 单页条数，缺省 50，上限 200。 */
  limit?: number;
  /**
   * 游标：上一页最后一条记录的 `排序键|主键`。
   *
   * 工作流 / 模板用 `updatedAt|id`，运行用 `createdAt|id`，
   * 步骤用 `createdAt|nodeId`，版本类列表用纯数字版本号。
   */
  cursor?: string;
}

/** 列表默认页大小。 */
export const WORKFLOW_LIST_LIMIT_DEFAULT = 50;

/** 列表最大页大小 —— 防止调用方一次性拉走整张表。 */
export const WORKFLOW_LIST_LIMIT_MAX = 200;

/** 计算实际生效的页大小。 */
export function resolveWorkflowListLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return WORKFLOW_LIST_LIMIT_DEFAULT;
  }
  return Math.max(1, Math.min(Math.floor(limit), WORKFLOW_LIST_LIMIT_MAX));
}

/**
 * 归一化时间戳：统一成 toISOString()，避免同一时刻出现两种文本导致游标比较失真。
 *
 * 所有写入路径在写库前都必须调用：调用方可能传入 `2026-01-01T00:00:00Z` 这类
 * 不带毫秒的文本，SQLite 的 TEXT 列会原样保存，而游标用的是读回后的归一化值；
 * 两种文本混排会让 keyset 分页漏记录（列表契约见 9 章）。
 */
export function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`时间戳非法: ${value}`);
  }
  return date.toISOString();
}

/**
 * 调用者身份：可见范围与所有权判定必须在 SQL 层完成。
 */
export interface WorkflowActor {
  /** 调用者用户 ID，与工作流 owner_id、运行 initiator_id 比对。 */
  userId: string;
  /** 调用者所属部门，用于 department 可见范围判定；为空时 department 记录对其不可见。 */
  departmentIds?: string[];
  /** 租户管理员或平台管理员：可越过所有权限制（可见他人 private 资源、可改他人工作流）。 */
  isAdmin?: boolean;
}

/**
 * 构造可见范围谓词（3.2 所有权和可见范围）。
 *
 * 两端必须完全同构，所以谓词只在这里生成一次，SQLite/PostgreSQL 各自只负责
 * 绑定占位符。`bind` 负责把值绑定成占位符并返回占位符文本。
 *
 * 口径（见 9.1）：
 * - 给出 `actor` 且不是管理员 → `private` 仅所有者可见，`department` 仅同部门可见；
 * - 给出 `actor` 且是管理员 → 不加限制（管理员可见租户内全部记录）；
 * - 省略 `actor` → 平台内部可信访问，不加限制。
 *
 * `ownerId` 不在这里承担授权语义：它只是纯过滤条件，由调用方单独拼进 WHERE。
 */
export function buildWorkflowVisibilityWhere(
  filter: {
    /** 调用者身份；省略表示平台内部可信访问。 */
    actor?: WorkflowActor;
    /** 可见性白名单；不传 = 不过滤。 */
    visibility?: WorkflowVisibility[];
  },
  bind: (value: unknown) => string,
  /** 表别名：运行可见范围判定要用 workflows 子查询关联，列名必须带别名。 */
  alias = '',
): string[] {
  const conditions: string[] = [];
  const prefix = alias ? `${alias}.` : '';
  const actor = filter.actor;
  // 管理员与平台内部可信访问不受 private / department 限制。
  if (actor && !actor.isAdmin) {
    // private：仅所有者可见。
    conditions.push(`(${prefix}visibility <> 'private' OR ${prefix}owner_id = ${bind(actor.userId)})`);
    // department：同部门可见；调用者没有部门归属时一律不可见。
    const departmentIds = actor.departmentIds ?? [];
    if (departmentIds.length > 0) {
      const placeholders = departmentIds.map((id) => bind(id)).join(', ');
      conditions.push(`(${prefix}visibility <> 'department' OR ${prefix}dept_id IN (${placeholders}))`);
    } else {
      conditions.push(`${prefix}visibility <> 'department'`);
    }
  }
  // 可见性白名单：不传 = 不过滤。
  if (filter.visibility && filter.visibility.length > 0) {
    const placeholders = filter.visibility.map((item) => bind(item)).join(', ');
    conditions.push(`${prefix}visibility IN (${placeholders})`);
  }
  return conditions;
}

/**
 * 构造运行记录的可见范围谓词（R6）。
 *
 * 可见给：运行发起人本人、该运行所属工作流的所有者（工作流管理员）、租户管理员。
 * 省略 `actor` = 平台内部可信访问，不做收窄。
 *
 * 判定同样落在 SQL 层：不允许把运行取回后在内存里过滤（会泄露他人运行的输入与节点输出）。
 */
export function buildWorkflowRunVisibilityWhere(
  filter: { actor?: WorkflowActor },
  bind: (value: unknown) => string,
  /** 运行表别名。 */
  alias = 'r',
): string[] {
  const actor = filter.actor;
  // 租户管理员可见租户内全部运行；平台内部可信访问同样不收窄。
  if (!actor || actor.isAdmin) return [];
  return [
    `(${alias}.initiator_id = ${bind(actor.userId)}`
    + ` OR EXISTS (SELECT 1 FROM workflows w WHERE w.id = ${alias}.workflow_id`
    + ` AND w.tenant_id = ${alias}.tenant_id AND w.owner_id = ${bind(actor.userId)}))`,
  ];
}

/**
 * 构造版本记录的可见范围谓词。
 *
 * 版本的可见性**跟随它所属的工作流**：工作流不可见 → 版本也不可见。
 * 版本里存着完整的定义、工具参数与校验和，绕过工作流直接读会绕过可见范围与所有权。
 * 省略 `actor` = 平台内部可信访问，不做收窄。
 */
export function buildWorkflowVersionVisibilityWhere(
  filter: { actor?: WorkflowActor },
  bind: (value: unknown) => string,
  /** 版本表别名。 */
  alias = 'v',
): string[] {
  const actor = filter.actor;
  if (!actor || actor.isAdmin) return [];
  const workflowConditions = buildWorkflowVisibilityWhere({ actor }, bind, 'w');
  const scope = workflowConditions.length > 0 ? ` AND ${workflowConditions.join(' AND ')}` : '';
  return [
    `EXISTS (SELECT 1 FROM workflows w WHERE w.id = ${alias}.workflow_id AND w.tenant_id = ${alias}.tenant_id${scope}`
    + ` AND (${alias}.status = 'published' OR w.owner_id = ${bind(actor.userId)}))`,
  ];
}

/** 构造游标。 */
export function formatWorkflowCursor(sortKey: string, id: string): string {
  return `${sortKey}|${id}`;
}

/**
 * 解析游标为「排序键 + 主键」。
 *
 * 游标来自客户端，不可信：结构或时间部分非法时直接抛 TypeError，
 * **不能**静默降级为「从头开始」——那会让客户端拿到重复数据。
 * 返回的排序键已归一化，保证与库里的排序键文本一致。
 */
export function parseWorkflowCursor(cursor?: string): { sortKey: string; id: string } | undefined {
  if (!cursor) return undefined;
  const index = cursor.indexOf('|');
  if (index <= 0 || index === cursor.length - 1) {
    throw new TypeError(`游标格式非法: ${cursor}`);
  }
  const rawSortKey = cursor.slice(0, index);
  const id = cursor.slice(index + 1);
  if (Number.isNaN(Date.parse(rawSortKey))) {
    throw new TypeError(`游标时间非法: ${rawSortKey}`);
  }
  return { sortKey: normalizeTimestamp(rawSortKey), id };
}

/** 解析版本类游标（纯数字）。 */
export function parseWorkflowVersionCursor(cursor?: string): number | undefined {
  if (!cursor) return undefined;
  if (!/^[1-9][0-9]*$/.test(cursor)) {
    throw new TypeError(`游标版本非法: ${cursor}`);
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`游标版本非法: ${cursor}`);
  }
  return value;
}

/**
 * 序列化必须存在的 JSON 字段。
 *
 * `JSON.stringify(undefined)` 返回 `undefined` 而不是字符串，直接绑进 SQL 会变成
 * NULL 并触发驱动原始错误（两端表现还不一样）。这里统一给出明确的领域错误。
 *
 * BigInt 与循环引用会让 `JSON.stringify` 抛 V8 原始错误（文案不带字段名），
 * 这里统一包成带字段名的领域错误，两端文案完全一致。
 */
export function requireJsonField(value: unknown, field: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`字段 ${field} 必须是可序列化的 JSON 值：${reason}`);
  }
  if (serialized === undefined) {
    throw new TypeError(`字段 ${field} 必须是可序列化的 JSON 值：undefined 不可序列化`);
  }
  return serialized;
}

/**
 * 入参组合校验：命中即抛统一的领域错误，让数据库 CHECK 只作最后兜底。
 *
 * 两端（SQLite / PostgreSQL）必须给出**同样的错误类型与文案**，
 * 否则调用方会看到 `SqliteError/SQLITE_CONSTRAINT_CHECK` 与 `DatabaseError/23514`
 * 两种截然不同的异常，无法用统一逻辑处理。
 */

/** 校验可见性取值域。 */
export function assertWorkflowVisibility(value: string): WorkflowVisibility {
  if (value !== 'private' && value !== 'department' && value !== 'tenant') {
    throw new TypeError(`字段 visibility 取值非法: ${String(value)}（合法值：private / department / tenant）`);
  }
  return value;
}

/**
 * 校验运行模式与定义快照的组合。
 *
 * `debug` 必须带快照（草稿随时会变，不存就复现不了），
 * `published` 不能带快照（只存版本引用 + 校验和，见 9.3 / R6）。
 */
export function assertWorkflowRunSnapshot(mode: string, hasSnapshot: boolean): WorkflowRunMode {
  if (mode !== 'debug' && mode !== 'published') {
    throw new TypeError(`字段 mode 取值非法: ${String(mode)}（合法值：debug / published）`);
  }
  if (mode === 'debug' && !hasSnapshot) {
    throw new TypeError('字段 definition_snapshot 组合非法: mode=debug 时必须带定义快照');
  }
  if (mode === 'published' && hasSnapshot) {
    throw new TypeError('字段 definition_snapshot 组合非法: mode=published 时不能带定义快照');
  }
  return mode;
}

/** 校验步骤尝试次数（必须大于 0）。 */
export function assertWorkflowStepAttempt(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new TypeError(`字段 attempt 取值非法: ${String(attempt)}（必须大于 0 的整数）`);
  }
  return attempt;
}

/** 校验步骤累计调用次数（不得为负）。 */
export function assertWorkflowStepCallCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`字段 ${field} 取值非法: ${String(value)}（必须是不小于 0 的整数）`);
  }
  return value;
}

/**
 * 校验模板作用域与租户归属互斥。
 *
 * `platform` 模板不能带租户归属，`tenant` 模板必须带租户归属（见 9.5）。
 */
export function assertWorkflowTemplateScope(scope: string, tenantId?: string | null): void {
  if (scope !== 'platform' && scope !== 'tenant') {
    throw new TypeError(`字段 scope 取值非法: ${String(scope)}（合法值：platform / tenant）`);
  }
  if (scope === 'platform' && tenantId !== undefined && tenantId !== null) {
    throw new TypeError(`字段 scope 与 tenant_id 组合非法: scope=platform 时不能带租户归属（当前值: ${String(tenantId)}）`);
  }
  if (scope === 'tenant' && (tenantId === undefined || tenantId === null)) {
    throw new TypeError('字段 scope 与 tenant_id 组合非法: scope=tenant 时必须带租户归属');
  }
}

/** 校验版本状态取值域。 */
export function assertWorkflowVersionStatus(status: string): WorkflowVersionStatus {
  if (status !== 'draft' && status !== 'in_review' && status !== 'published' && status !== 'rejected') {
    throw new TypeError(`字段 status 取值非法: ${String(status)}（合法值：draft / in_review / published / rejected）`);
  }
  return status;
}

/** 校验版本号（必须大于 0）。 */
export function assertWorkflowVersionNumber(version: number, field = 'version'): number {
  if (!Number.isInteger(version) || version <= 0) {
    throw new TypeError(`字段 ${field} 取值非法: ${String(version)}（必须大于 0 的整数）`);
  }
  return version;
}

/** 校验运行状态取值域。 */
export function assertWorkflowRunStatus(status: string): WorkflowRunStatus {
  const allowed: readonly string[] = [
    'queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted',
  ];
  if (!allowed.includes(status)) {
    throw new TypeError(`字段 status 取值非法: ${String(status)}（合法值：${allowed.join(' / ')}）`);
  }
  return status as WorkflowRunStatus;
}

/** 校验步骤状态取值域。 */
export function assertWorkflowStepStatus(status: string): WorkflowStepStatus {
  const allowed: readonly string[] = ['pending', 'running', 'waiting_approval', 'succeeded', 'failed', 'skipped'];
  if (!allowed.includes(status)) {
    throw new TypeError(`字段 status 取值非法: ${String(status)}（合法值：${allowed.join(' / ')}）`);
  }
  return status as WorkflowStepStatus;
}

/** 校验模板状态取值域。 */
export function assertWorkflowTemplateStatus(status: string): WorkflowTemplateStatus {
  if (status !== 'draft' && status !== 'published') {
    throw new TypeError(`字段 status 取值非法: ${String(status)}（合法值：draft / published）`);
  }
  return status as WorkflowTemplateStatus;
}

/** 校验乐观锁版本号（不得为负）。 */
export function assertWorkflowLockVersion(lockVersion: number): number {
  if (!Number.isInteger(lockVersion) || lockVersion < 0) {
    throw new TypeError(`字段 lock_version 取值非法: ${String(lockVersion)}（必须是不小于 0 的整数）`);
  }
  return lockVersion;
}

/**
 * 解析写入工作流时的所有者。
 *
 * 所有者**从调用者身份取**，不认客户端传入的 ownerId：
 * 否则任何人都能把工作流挂到别人名下（所有权伪造），并借 tenant 可见范围
 * 让攻击者写的内容以受害者名义对全租户可见（见 9.1）。
 *
 * 管理员可以显式指定所有者（代他人维护工作流），但必须给出非空值；
 * 否则所有者退回管理员本人，避免出现「无人拥有」的工作流。
 * 省略 `actor` = 平台内部可信写入，沿用记录自带的所有者。
 */
export function resolveWorkflowOwnerId(record: { ownerId: string }, actor?: WorkflowActor): string {
  if (!actor) return record.ownerId;
  if (!actor.isAdmin) return actor.userId;
  return record.ownerId && record.ownerId.length > 0 ? record.ownerId : actor.userId;
}

/**
 * 部门归属解析结果。
 */
export interface WorkflowDepartmentResolution {
  /** 是否允许这次写入。 */
  allowed: boolean;
  /**
   * 调用方是否**显式**提供了部门归属。
   *
   * 显式与省略必须区分：省略时更新路径要**保留库中原值**，
   * 否则一次「只改名字」的更新会把部门归属清空，`visibility=department` 的工作流
   * 随即对所有者与整个部门同时消失（见 §9.1）。
   */
  provided: boolean;
  /** 最终写入的部门归属；`undefined` 表示清空。 */
  deptId?: string;
}

/**
 * 解析写入工作流时的部门归属。
 *
 * 口径（见 §9.1）：
 * - 非管理员只能把工作流放进**自己的**部门，不能指定他人部门；
 * - 省略 `deptId` 时：
 *   - 更新路径 → 保留库中原值（`provided=false`），不要求重新选择部门；
 *   - 新建路径且 `visibility='department'` → 只有一个部门时自动绑定，
 *     多部门必须显式选择（避免随意指定造成归属伪造）；
 * - 显式给出空串 → 显式清空部门归属（`visibility='department'` 时不允许）；
 * - 管理员与平台内部写入可显式指定任意部门。
 */
export function resolveWorkflowDepartment(
  record: { deptId?: string; visibility: WorkflowVisibility },
  actor: WorkflowActor | undefined,
  options: { updating: boolean },
): WorkflowDepartmentResolution {
  const raw = record.deptId;
  const provided = raw !== undefined;

  // 显式清空：空串表示「去掉部门归属」。
  if (provided && raw === '') {
    if (record.visibility === 'department') {
      // 部门可见的工作流必须有部门归属，否则对任何部门都不可见。
      return { allowed: false, provided: true, deptId: undefined };
    }
    return { allowed: true, provided: true, deptId: undefined };
  }

  if (!actor || actor.isAdmin) {
    return { allowed: true, provided, deptId: provided ? raw : undefined };
  }

  const departments = actor.departmentIds ?? [];
  if (!provided) {
    if (record.visibility !== 'department') {
      // 非部门可见的工作流不需要部门归属：省略即保留原值（更新）或留空（新建）。
      return { allowed: true, provided: false, deptId: undefined };
    }
    if (options.updating) {
      // 更新：省略即保留原值，不把「部门选择」变成任意字段更新的硬前置。
      return { allowed: true, provided: false, deptId: undefined };
    }
    if (departments.length === 1) {
      return { allowed: true, provided: false, deptId: departments[0] };
    }
    // 多部门用户必须显式选择，避免随意指定一个部门造成归属伪造。
    return { allowed: false, provided: false, deptId: undefined };
  }
  if (!departments.includes(raw!)) {
    // 指定了不属于调用者的部门 → 拒绝。
    return { allowed: false, provided: true, deptId: undefined };
  }
  return { allowed: true, provided: true, deptId: raw };
}

/**
 * 判定调用者是否可以管理该工作流（编辑草稿、提交审核）。
 *
 * 省略 `actor` = 平台内部可信操作；给出 `actor` 时只有所有者或管理员可以。
 */
export function canManageWorkflow(
  workflow: { ownerId: string } | undefined,
  actor?: WorkflowActor,
): boolean {
  if (!actor) return true;
  if (actor.isAdmin) return true;
  return Boolean(workflow) && workflow?.ownerId === actor.userId;
}

/**
 * 判定调用者是否可以执行审核 / 发布动作。
 *
 * 审核与发布是管理员专属动作（见 10.1 的 `review` / `publish` 端点）；
 * 省略 `actor` = 平台内部可信操作。
 */
export function canReviewWorkflow(actor?: WorkflowActor): boolean {
  if (!actor) return true;
  return actor.isAdmin === true;
}

/**
 * 构造「禁止自审」的 SQL 条件：审核人不能是作者，也不能是**最后改动内容**的人。
 *
 * 只看 `created_by` 会被绕过：管理员覆盖了别人的草稿后，`created_by` 仍是原作者，
 * 但内容已经是管理员写的 —— 按原作者判定就等于允许管理员自审自发。
 * `last_modified_by` 缺省（老库补列前的行、平台内部写入）时按 `created_by` 兜底：
 * 否则 NULL 比较得到 NULL，会把这些行整体挡在审核之外。
 *
 * 两端 SQL 文本完全一致，只有占位符不同，因此条件在这里生成一次。
 */
export function buildWorkflowSelfReviewCondition(
  bind: (value: unknown) => string,
  actorUserId: string,
): string {
  return `(created_by <> ${bind(actorUserId)}`
    + ` AND COALESCE(last_modified_by, created_by) <> ${bind(actorUserId)})`;
}

/**
 * 构造「版本所属工作流未被软删除」的条件。
 *
 * 软删除是**终态**：删除后的工作流不再接受送审与发布，
 * 否则「已删除」的流程还能被推到已发布，历史运行与版本证据对不上。
 */
export function buildWorkflowNotDeletedCondition(alias = 'workflow_versions'): string {
  return `EXISTS (SELECT 1 FROM workflows w WHERE w.id=${alias}.workflow_id`
    + ` AND w.tenant_id=${alias}.tenant_id AND w.deleted_at IS NULL)`;
}

/**
 * 构造版本「发布」的分支条件。
 *
 * - 审核流（`status='in_review'`）：审核人不能是作者或最后修改者；
 * - 直发（`status='draft'`）：只允许发布**自己所有**的工作流的草稿，且工作流未被软删除。
 *
 * 两条路径都要求工作流存在且未软删除。
 */
export function buildWorkflowPublishBranchCondition(
  bind: (value: unknown) => string,
  actorUserId: string,
): string {
  return `((status='in_review' AND ${buildWorkflowSelfReviewCondition(bind, actorUserId)})`
    + ` OR (status='draft' AND EXISTS (SELECT 1 FROM workflows w`
    + ` WHERE w.id=workflow_versions.workflow_id AND w.tenant_id=workflow_versions.tenant_id`
    + ` AND w.deleted_at IS NULL AND w.owner_id=${bind(actorUserId)})))`;
}

export interface WorkflowStore {
  /**
   * 写入工作流。
   *
   * 返回 false 表示**没有写入**，可能原因：
   * 1. 租户不匹配 —— 库中同 id 记录属于其他租户，拒绝跨租户覆盖；
   * 2. 记录已软删除 —— 软删除是终态，不允许被 upsert 复活；
   * 3. 冲突更新条件未命中（值无实质变化）；
   * 4. 给出 `actor` 时调用者既不是所有者也不是管理员 —— 无权改写他人工作流。
   *
   * `owner_id` **创建后不可变**：冲突更新不再改写所有者，
   * 否则同租户内任意成员都能把工作流据为己有（见 3.2）。
   *
   * `actor` 省略表示**平台内部可信写入**（测试播种、版本流程内部读写）；
   * 给出 `actor` 表示用户侧写入，必须受所有权判定约束。
   */
  upsertWorkflow(record: WorkflowRecord, actor?: WorkflowActor): Promise<boolean>;
  /**
   * 读取单条工作流。
   *
   * 给出 `actor` 时按可见范围过滤（private / department / tenant，见 3.2）；
   * 省略 `actor` 表示平台内部可信访问，行为不变。
   *
   * **软删除的工作流默认读不到**，与 `listWorkflows` 的默认口径一致；
   * `options.includeDeleted` 为 true 时才返回已删除记录（供内部判断存在性与 API 层展示）。
   */
  getWorkflow(
    tenantId: string,
    id: string,
    actor?: WorkflowActor,
    options?: { includeDeleted?: boolean },
  ): Promise<WorkflowRecord | undefined>;
  listWorkflows(filter: {
    tenantId: string;
    /** 调用者身份：给出时按可见范围过滤；省略表示平台内部可信访问。 */
    actor?: WorkflowActor;
    /** 纯 owner 过滤（管理场景）；不承担授权语义。 */
    ownerId?: string;
    includeDeleted?: boolean;
    /** 只返回这些可见性的记录；不传 = 不过滤。 */
    visibility?: WorkflowVisibility[];
  } & WorkflowListOptions): Promise<WorkflowRecord[]>;
  /**
   * 软删除工作流。**终态**：删除后不可恢复，普通 upsert 不能把它改回来。
   *
   * 删除也是「编辑」：给出 `actor` 时只有所有者或管理员能删（见 3.2）；
   * 省略 `actor` 表示平台内部可信操作。
   */
  deleteWorkflow(tenantId: string, id: string, deletedAt: string, actor?: WorkflowActor): Promise<boolean>;

  /**
   * 写入版本草稿。
   *
   * 普通 upsert **只能写草稿态**（`draft` / `rejected`）：
   * `in_review` 与 `published` 既不能被普通 upsert 改写，也不能被 upsert 直接写入 ——
   * 否则可以绕过审核通道，把未审核的定义直接置为已发布（见 9.2）。
   * 旧状态同样只允许 `draft` / `rejected`。
   *
   * 普通 upsert **不写任何审核 / 发布留痕字段**（`reviewed_* / published_*`）：
   * 那几个字段只由审核通道写，否则可以伪造「已审核」证据，或抹掉真实的驳回意见。
   *
   * 给出 `actor` 时只有该工作流的所有者或管理员能改（见 3.2）；
   * 省略 `actor` 表示平台内部可信操作。
   *
   * **版本号必须单调递增**：新版本号必须大于该工作流已有的最大版本号，
   * 否则返回 false（见 10.1「版本号由服务端分配，不接受客户端指定」）。
   *
   * `created_by` 记录**最初作者**且不可变；`last_modified_by` 记录**最后改动内容的人**，
   * 给出 `actor` 时取 `actor.userId`。「禁止自审」同时看这两列（见 9.2）。
   */
  upsertWorkflowVersion(record: WorkflowVersionRecord, actor?: WorkflowActor): Promise<boolean>;
  /**
   * 提交审核：`draft` → `in_review`。
   *
   * 只改状态，**不写任何审核 / 发布字段** —— 审核留痕由审核通道完成。
   * 当前状态不是 `draft`、版本不存在或租户不匹配时返回 false。
   *
   * 给出 `actor` 时只有该工作流的所有者或管理员能提交（见 3.2）。
   */
  submitWorkflowVersionForReview(
    tenantId: string,
    workflowId: string,
    version: number,
    actor?: WorkflowActor,
  ): Promise<boolean>;
  /**
   * 驳回审核中的版本：`in_review` → `rejected`，并记录审核人与意见。
   *
   * 当前状态不是 `in_review`、版本不存在或租户不匹配时返回 false。
   * 驳回后该版本可被普通 upsert 改回草稿（`rejected` 不在锁定集合内）。
   *
   * 审核是管理员专属动作（见 10.1）：给出 `actor` 时非管理员返回 false。
   */
  rejectWorkflowVersion(
    tenantId: string,
    workflowId: string,
    version: number,
    review: { reviewer: string; comment: string; at: string },
    actor?: WorkflowActor,
  ): Promise<boolean>;

  /**
   * 审核通过 → 发布。
   *
   * 处理 `in_review` 的版本（管理员直接发布自己维护的草稿也走这里，见 10.1）；
   * 其余状态、版本不存在或租户不匹配时返回 false。
   * 只改状态与发布信息，**不改定义与校验和** —— 发布的就是审核时的那一份。
   *
   * 发布是管理员专属动作（见 10.1）：给出 `actor` 时非管理员返回 false。
   */
  publishWorkflowVersion(
    tenantId: string,
    workflowId: string,
    version: number,
    publish: { reviewer: string; at: string },
    actor?: WorkflowActor,
  ): Promise<boolean>;
  /**
   * 读取单个版本。
   *
   * 版本的可见性跟随它所属的工作流：给出 `actor` 时，工作流对该调用者不可见则版本也不可见。
   * 省略 `actor` 表示平台内部可信访问（Worker 按版本号取已发布定义、测试播种）。
   */
  getWorkflowVersion(
    tenantId: string,
    workflowId: string,
    version: number,
    actor?: WorkflowActor,
  ): Promise<WorkflowVersionRecord | undefined>;
  listWorkflowVersions(
    tenantId: string,
    workflowId: string,
    options?: WorkflowListOptions & { actor?: WorkflowActor },
  ): Promise<WorkflowVersionRecord[]>;

  insertWorkflowRun(record: WorkflowRunRecord): Promise<boolean>;
  /**
   * 读取单条运行。
   *
   * 给出 `actor` 时按 R6 授权：运行发起人本人、该运行所属工作流的所有者、租户管理员可见；
   * 省略 `actor` 表示平台内部可信访问，行为不变。
   */
  getWorkflowRun(tenantId: string, id: string, actor?: WorkflowActor): Promise<WorkflowRunRecord | undefined>;
  getWorkflowRunByIdempotencyKey(
    tenantId: string,
    workflowId: string,
    initiatorId: string,
    key: string,
  ): Promise<WorkflowRunRecord | undefined>;
  listWorkflowRuns(filter: {
    tenantId: string;
    /** 调用者身份：给出时按运行可见范围过滤；省略表示平台内部可信访问。 */
    actor?: WorkflowActor;
    workflowId?: string;
    initiatorId?: string;
    status?: WorkflowRunStatus;
  } & WorkflowListOptions): Promise<WorkflowRunRecord[]>;
  transitionWorkflowRun(
    tenantId: string,
    id: string,
    fromStatus: WorkflowRunStatus,
    expectedLockVersion: number,
    patch: WorkflowRunTransitionPatch,
  ): Promise<WorkflowRunRecord | undefined>;

  upsertWorkflowStepRun(tenantId: string, record: WorkflowStepRunRecord): Promise<boolean>;
  /** 读取单条步骤；可见性跟随其所属运行（R6）。 */
  getWorkflowStepRun(
    tenantId: string,
    runId: string,
    nodeId: string,
    actor?: WorkflowActor,
  ): Promise<WorkflowStepRunRecord | undefined>;
  listWorkflowStepRuns(
    tenantId: string,
    runId: string,
    options?: { actor?: WorkflowActor } & WorkflowListOptions,
  ): Promise<WorkflowStepRunRecord[]>;

  /**
   * 写入**租户**模板：只能写 `scope='tenant'` 且 `tenant_id=tenantId` 的行。
   *
   * 库中同 id 的平台模板不在可写范围内（冲突更新条件会拦截），因此租户无法
   * 借这条路径改写平台模板。作用域或归属不匹配时返回 false。
   */
  upsertTenantWorkflowTemplate(tenantId: string, record: WorkflowTemplateRecord): Promise<boolean>;
  /**
   * 写入**平台**模板：只能写 `scope='platform'`（`tenant_id` 为空）的行。
   *
   * 作用域与租户归属的**组合**非法（platform 带租户 / tenant 不带租户）时抛
   * `TypeError` 领域错误（与其它字段校验同口径）；仅作用域取值不对的记录返回 false。
   */
  upsertPlatformWorkflowTemplate(record: WorkflowTemplateRecord): Promise<boolean>;
  getWorkflowTemplate(tenantId: string, id: string): Promise<WorkflowTemplateRecord | undefined>;
  /** 目录查询：平台模板 + 调用者本租户模板（见 9.5）。 */
  listWorkflowTemplates(tenantId: string, options?: WorkflowListOptions): Promise<WorkflowTemplateRecord[]>;
  /** 写入租户模板的版本：模板必须是该租户的 tenant 模板，否则返回 false。 */
  upsertTenantWorkflowTemplateVersion(
    tenantId: string,
    record: WorkflowTemplateVersionRecord,
  ): Promise<boolean>;
  /** 写入平台模板的版本：模板必须是 platform 模板，否则返回 false。 */
  upsertPlatformWorkflowTemplateVersion(record: WorkflowTemplateVersionRecord): Promise<boolean>;
  getWorkflowTemplateVersion(
    tenantId: string,
    templateId: string,
    version: number,
  ): Promise<WorkflowTemplateVersionRecord | undefined>;
  listWorkflowTemplateVersions(
    tenantId: string,
    templateId: string,
    options?: WorkflowListOptions,
  ): Promise<WorkflowTemplateVersionRecord[]>;
}

export const SQLITE_WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, dept_id TEXT, name TEXT NOT NULL,
  description TEXT, visibility TEXT NOT NULL CHECK (visibility IN ('private','department','tenant')),
  current_draft_version INTEGER, latest_published_version INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0), tenant_id TEXT NOT NULL,
  definition_json TEXT NOT NULL, checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','in_review','published','rejected')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_modified_by TEXT,
  reviewed_by TEXT, reviewed_at TEXT,
  review_comment TEXT, published_by TEXT, published_at TEXT,
  PRIMARY KEY (workflow_id, version)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
  initiator_id TEXT NOT NULL, identity_snapshot TEXT NOT NULL, input_json TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('debug','published')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled','interrupted')),
  definition_snapshot TEXT, definition_checksum TEXT NOT NULL, trace_id TEXT NOT NULL,
  idempotency_key TEXT, lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, started_at TEXT,
  ended_at TEXT, updated_at TEXT NOT NULL, expires_at TEXT,
  missing_refs TEXT,
  CHECK ((mode = 'debug' AND definition_snapshot IS NOT NULL) OR
         (mode = 'published' AND definition_snapshot IS NULL))
);
CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','running','waiting_approval','succeeded','failed','skipped')),
  input_json TEXT, output_json TEXT, error_code TEXT, error_message TEXT,
  approval_id TEXT, idempotency_key TEXT, side_effect_unknown INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  missing_refs TEXT,
  started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (run_id, node_id)
);
CREATE TABLE IF NOT EXISTS workflow_templates (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('platform','tenant')), tenant_id TEXT,
  name TEXT NOT NULL, description TEXT, status TEXT NOT NULL CHECK (status IN ('draft','published')),
  current_draft_version INTEGER, latest_published_version INTEGER, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  CHECK ((scope = 'platform' AND tenant_id IS NULL) OR (scope = 'tenant' AND tenant_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS workflow_template_versions (
  template_id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
  definition_json TEXT NOT NULL, resource_slots TEXT NOT NULL DEFAULT '[]', checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published')), created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, published_by TEXT, published_at TEXT,
  PRIMARY KEY (template_id, version)
);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant_owner_updated ON workflows(tenant_id, owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_workflow_versions_tenant_workflow ON workflow_versions(tenant_id, workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant_initiator_created ON workflow_runs(tenant_id, initiator_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(tenant_id, workflow_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_run_idempotency
  ON workflow_runs(tenant_id, workflow_id, initiator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_created ON workflow_step_runs(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_scope_tenant_updated ON workflow_templates(scope, tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_workflow_template_versions_template ON workflow_template_versions(template_id, version);
`;

export const PG_WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, dept_id TEXT, name TEXT NOT NULL,
  description TEXT, visibility TEXT NOT NULL CHECK (visibility IN ('private','department','tenant')),
  current_draft_version INTEGER, latest_published_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0), tenant_id TEXT NOT NULL,
  definition_json JSONB NOT NULL, checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','in_review','published','rejected')),
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, last_modified_by TEXT,
  reviewed_by TEXT, reviewed_at TIMESTAMPTZ,
  review_comment TEXT, published_by TEXT, published_at TIMESTAMPTZ,
  PRIMARY KEY (workflow_id, version)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
  initiator_id TEXT NOT NULL, identity_snapshot JSONB NOT NULL, input_json JSONB NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('debug','published')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled','interrupted')),
  definition_snapshot JSONB, definition_checksum TEXT NOT NULL, trace_id TEXT NOT NULL,
  idempotency_key TEXT, lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  error_code TEXT, error_message TEXT, created_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ,
  missing_refs JSONB,
  CHECK ((mode = 'debug' AND definition_snapshot IS NOT NULL) OR
         (mode = 'published' AND definition_snapshot IS NULL))
);
CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','running','waiting_approval','succeeded','failed','skipped')),
  input_json JSONB, output_json JSONB, error_code TEXT, error_message TEXT,
  approval_id TEXT, idempotency_key TEXT, side_effect_unknown BOOLEAN NOT NULL DEFAULT FALSE,
  llm_calls INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  missing_refs JSONB,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, node_id)
);
CREATE TABLE IF NOT EXISTS workflow_templates (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('platform','tenant')), tenant_id TEXT,
  name TEXT NOT NULL, description TEXT, status TEXT NOT NULL CHECK (status IN ('draft','published')),
  current_draft_version INTEGER, latest_published_version INTEGER, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ,
  CHECK ((scope = 'platform' AND tenant_id IS NULL) OR (scope = 'tenant' AND tenant_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS workflow_template_versions (
  template_id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
  definition_json JSONB NOT NULL, resource_slots JSONB NOT NULL DEFAULT '[]', checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published')), created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, published_by TEXT, published_at TIMESTAMPTZ,
  PRIMARY KEY (template_id, version)
);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant_owner_updated ON workflows(tenant_id, owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_versions_tenant_workflow ON workflow_versions(tenant_id, workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant_initiator_created ON workflow_runs(tenant_id, initiator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(tenant_id, workflow_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_run_idempotency
  ON workflow_runs(tenant_id, workflow_id, initiator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_created ON workflow_step_runs(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_scope_tenant_updated ON workflow_templates(scope, tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_template_versions_template ON workflow_template_versions(template_id, version);
`;

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function optionalJson(value: unknown): unknown {
  return value === null || value === undefined ? undefined : parseJson(value);
}

/**
 * 把读回的时间列转成 ISO 文本。
 *
 * 非法时间抛 TypeError（领域错误），不能抛原生 RangeError —— 两端表现必须一致，
 * 且调用方能据此判断是数据脏了而不是代码崩了。
 */
function iso(value: unknown, field?: string): string {
  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`时间戳非法: ${String(value)}${field ? `（${field}）` : ''}`);
  }
  return date.toISOString();
}

function optionalIso(value: unknown, field?: string): string | undefined {
  return value === null || value === undefined ? undefined : iso(value, field);
}

function bool(value: unknown): boolean {
  return value === true || value === 1;
}

/**
 * 解析「字符串数组」型 JSON 列。
 *
 * 列内容缺失或格式非法时返回 undefined —— 缺失引用留痕属于附加信息，
 * 读不出来不应该让整条运行记录不可用。
 */
export function parseStringArray(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    // 脏数据不能让整页查询失败：缺失引用留痕属于附加信息，读不出来就当没有。
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return undefined;
  return parsed;
}

export function mapWorkflowRow(row: any): WorkflowRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    deptId: row.dept_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    visibility: row.visibility,
    currentDraftVersion: row.current_draft_version ?? undefined,
    latestPublishedVersion: row.latest_published_version ?? undefined,
    createdAt: iso(row.created_at, '工作流创建时间'),
    updatedAt: iso(row.updated_at, '工作流更新时间'),
    deletedAt: optionalIso(row.deleted_at, '工作流删除时间'),
  };
}

export function mapWorkflowVersionRow(row: any): WorkflowVersionRecord {
  return {
    workflowId: row.workflow_id,
    version: Number(row.version),
    tenantId: row.tenant_id,
    definition: parseJson(row.definition_json),
    checksum: row.checksum,
    status: row.status,
    createdBy: row.created_by,
    createdAt: iso(row.created_at, '版本创建时间'),
    lastModifiedBy: row.last_modified_by ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: optionalIso(row.reviewed_at, '版本审核时间'),
    reviewComment: row.review_comment ?? undefined,
    publishedBy: row.published_by ?? undefined,
    publishedAt: optionalIso(row.published_at, '版本发布时间'),
  };
}

export function mapWorkflowRunRow(row: any): WorkflowRunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    workflowVersion: Number(row.workflow_version),
    initiatorId: row.initiator_id,
    identitySnapshot: parseJson(row.identity_snapshot) as Record<string, unknown>,
    input: parseJson(row.input_json),
    mode: row.mode,
    status: row.status,
    definitionSnapshot: optionalJson(row.definition_snapshot),
    definitionChecksum: row.definition_checksum,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key ?? undefined,
    lockVersion: Number(row.lock_version),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    missingRefs: parseStringArray(row.missing_refs),
    createdAt: iso(row.created_at, '运行创建时间'),
    startedAt: optionalIso(row.started_at, '运行开始时间'),
    endedAt: optionalIso(row.ended_at, '运行结束时间'),
    updatedAt: iso(row.updated_at, '运行更新时间'),
    expiresAt: optionalIso(row.expires_at, '运行过期时间'),
  };
}

export function mapWorkflowStepRunRow(row: any): WorkflowStepRunRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: Number(row.attempt),
    status: row.status,
    input: optionalJson(row.input_json),
    output: optionalJson(row.output_json),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    approvalId: row.approval_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    sideEffectUnknown: bool(row.side_effect_unknown),
    llmCalls: Number(row.llm_calls ?? 0),
    toolCalls: Number(row.tool_calls ?? 0),
    missingRefs: parseStringArray(row.missing_refs),
    startedAt: optionalIso(row.started_at, '步骤开始时间'),
    endedAt: optionalIso(row.ended_at, '步骤结束时间'),
    createdAt: iso(row.created_at, '步骤创建时间'),
    updatedAt: iso(row.updated_at, '步骤更新时间'),
  };
}

export function mapWorkflowTemplateRow(row: any): WorkflowTemplateRecord {
  return {
    id: row.id,
    scope: row.scope,
    tenantId: row.tenant_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    currentDraftVersion: row.current_draft_version ?? undefined,
    latestPublishedVersion: row.latest_published_version ?? undefined,
    createdBy: row.created_by,
    createdAt: iso(row.created_at, '模板创建时间'),
    updatedAt: iso(row.updated_at, '模板更新时间'),
    deletedAt: optionalIso(row.deleted_at, '模板删除时间'),
  };
}

export function mapWorkflowTemplateVersionRow(row: any): WorkflowTemplateVersionRecord {
  return {
    templateId: row.template_id,
    version: Number(row.version),
    definition: parseJson(row.definition_json),
    resourceSlots: (parseJson(row.resource_slots) ?? []) as unknown[],
    checksum: row.checksum,
    status: row.status,
    createdBy: row.created_by,
    createdAt: iso(row.created_at, '模板版本创建时间'),
    publishedBy: row.published_by ?? undefined,
    publishedAt: optionalIso(row.published_at, '模板版本发布时间'),
  };
}
