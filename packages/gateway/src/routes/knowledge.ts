/**
 * 知识库管理接口 —— 控制台「知识库」页的后端。
 *
 * 数据位置：平台真正的业务知识在主库的 knowledge_docs 表（见 4.2 知识库划分），
 * 由 knowledge MCP 服务负责「召回前过滤 + 混合打分」检索，并同步到 Infinity。
 * RAGFlow 是同一职责的**外购/可选组件**（PDF 3.1 组件总览里的 P1 项），
 * 本平台的 Agent 检索链路并不走它 —— 两者数据互不相通。
 *
 * 可见性口径（与 knowledge MCP 工具保持一致，见 5.2 召回前过滤）：
 *   1. 租户隔离：只能看自己租户的文档
 *   2. **密级优先**：文档密级高于本人密级的一律不可见（管理员也不例外）
 *   3. 部门隔离：管理员跨部门可见；普通用户只能看本部门 + dept_id='all' 的文档
 *
 * 写操作（增/删）**不直接执行**：只生成审批单（202 + approvalId），
 * 由另一位有审批权限的人在「审批中心」通过后才真正落库 ——
 * 与 Agent 调用需确认工具走同一条 HITL 链路（见 4.1 HITL）。
 */
import { Router, type Request, type Response } from 'express';
import { createLogger, uuid, type ApprovalRequest, type Identity, type KnowledgeDoc } from '@eap/platform-core';
import type { AppContext } from '../context.js';
import { requireIdentity } from '@eap/auth-middleware';

const log = createLogger('gateway:route:knowledge');

/** 可发起知识库写操作的角色（平台管理员） */
const WRITER_ROLES = new Set(['admin', 'platform-admin']);
/** 密级准入等级 —— 与 knowledge MCP 服务的 CLEARANCE 一致 */
const CLEARANCE: Record<string, number> = { public: 0, internal: 1, confidential: 2 };

/** 写操作对应的工具名 —— 审批单按此标识，执行时回放对应 MCP 工具 */
export const KB_UPSERT_TOOL = 'knowledge.upsert_document';
export const KB_DELETE_TOOL = 'knowledge.delete_document';

/** 文档摘要 —— 列表接口不返回全文，避免一次拉取大量正文 */
export interface KnowledgeSummary {
  id: string;
  title: string;
  deptId: string;
  sensitivity: string;
  ownerId: string;
  updatedAt: string;
  contentLength: number;
  snippet: string;
}

/** 判断文档对某身份是否可见（密级优先，其次部门） */
export function isDocVisible(doc: KnowledgeDoc, identity: Identity): boolean {
  if (doc.tenantId !== identity.tenantId) return false;
  // 密级是硬约束：管理员也不越级查看
  const clearance = CLEARANCE[identity.sensitivity] ?? CLEARANCE.internal;
  if ((CLEARANCE[doc.sensitivity] ?? CLEARANCE.internal) > clearance) return false;
  if (WRITER_ROLES.has(identity.role)) return true;
  return doc.deptId === 'all' || doc.deptId === identity.deptId;
}

/** 按可见性过滤文档列表 */
export function visibleDocs(docs: KnowledgeDoc[], identity: Identity): KnowledgeDoc[] {
  return docs.filter((d) => isDocVisible(d, identity));
}

/** 列表项 → 摘要 */
function toSummary(doc: KnowledgeDoc): KnowledgeSummary {
  return {
    id: doc.id,
    title: doc.title,
    deptId: doc.deptId,
    sensitivity: doc.sensitivity,
    ownerId: doc.ownerId,
    updatedAt: doc.updatedAt,
    contentLength: doc.content.length,
    snippet: doc.content.slice(0, 120),
  };
}

/**
 * 审批通过后执行知识库写操作。
 *
 * 由 /v1/admin/approvals/:id/decide 在判定为 approved 时调用。
 * 用**申请人**的身份上下文执行（owner 记为申请人），审批人另行记入审计。
 */
export async function executeApprovedKnowledgeWrite(
  ctx: AppContext,
  approval: ApprovalRequest,
  decidedBy: string,
): Promise<{ ok: boolean; message: string }> {
  if (approval.tool !== KB_UPSERT_TOOL && approval.tool !== KB_DELETE_TOOL) {
    return { ok: false, message: '不是知识库写操作' };
  }
  const args = (approval.args ?? {}) as Record<string, unknown>;
  // 以申请人身份执行：owner_id 应记为发起人，而不是审批人
  const identity: Identity = {
    tenantId: approval.tenantId,
    userId: approval.userId,
    role: 'platform-admin',
    deptId: String(args.deptId ?? 'dept-general'),
    scopes: [],
    sensitivity: 'confidential',
    claims: { approvedBy: decidedBy },
  };
  const outcome = await ctx.mcp.call({
    identity,
    serverId: 'knowledge',
    toolName: approval.tool,
    args,
    traceId: approval.traceId || `knowledge-${uuid()}`,
    approvalId: approval.id,
    sessionId: approval.sessionId,
  });
  return {
    ok: outcome.ok,
    message: outcome.ok ? '写入成功' : (outcome.content || '写入失败'),
  };
}

export function knowledgeRoutes(ctx: AppContext): Router {
  const router = Router();

  /** 仅平台管理员可发起写操作 */
  const assertWriter = (req: Request, res: Response): boolean => {
    const identity = requireIdentity(req);
    if (!WRITER_ROLES.has(identity.role)) {
      res.status(403).json({ error: 'forbidden', message: '知识库写操作仅限平台管理员' });
      return false;
    }
    return true;
  };

  /** 生成写操作的审批单并返回（不直接执行） */
  const requestWrite = async (
    req: Request,
    res: Response,
    tool: string,
    args: Record<string, unknown>,
    reason: string,
  ): Promise<void> => {
    const identity = requireIdentity(req);
    const traceId = `knowledge-${uuid()}`;
    const approval: ApprovalRequest = {
      id: uuid(),
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionId: 'console',
      traceId,
      tool,
      args,
      reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await ctx.store.createApproval(approval);
    await ctx.audit.record({
      kind: 'admin',
      identity,
      traceId,
      status: 'ok',
      reason: `knowledge.${tool.endsWith('upsert_document') ? 'upsert.requested' : 'delete.requested'}`,
      detail: { approvalId: approval.id, tool, args },
    });
    log.info('已生成知识库写操作审批单', { approvalId: approval.id, tool, user: identity.userId });
    res.status(202).json({
      data: {
        approvalId: approval.id,
        status: 'pending',
        tool,
        reason,
        createdAt: approval.createdAt,
        message: '已提交审批：需由另一位有审批权限的角色在「审批中心」通过后才会生效',
      },
    });
  };

  // —— 列表（支持按部门 / 密级 / 关键字过滤）——
  router.get('/v1/knowledge/docs', async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const all = await ctx.store.listKnowledgeDocs(identity.tenantId);
    let docs = visibleDocs(all, identity);

    const dept = req.query.dept_id as string | undefined;
    if (dept) docs = docs.filter((d) => d.deptId === dept);
    const sens = req.query.sensitivity as string | undefined;
    if (sens) docs = docs.filter((d) => d.sensitivity === sens);
    const q = (req.query.q as string | undefined)?.trim();
    if (q) {
      const kw = q.toLowerCase();
      docs = docs.filter(
        (d) => d.title.toLowerCase().includes(kw) || d.content.toLowerCase().includes(kw),
      );
    }

    docs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const total = docs.length;
    const page = Math.max(1, Math.floor(Number(req.query.page ?? 1)) || 1);
    const pageSize = Math.min(200, Math.max(1, Math.floor(Number(req.query.pageSize ?? 50)) || 50));
    const start = (page - 1) * pageSize;
    res.json({
      data: docs.slice(start, start + pageSize).map(toSummary),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  });

  // —— 详情（不可见即 404，不泄露文档是否存在）——
  router.get('/v1/knowledge/docs/:id', async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const id = String(req.params.id);
    const all = await ctx.store.listKnowledgeDocs(identity.tenantId);
    const doc = visibleDocs(all, identity).find((d) => d.id === id);
    if (!doc) {
      res.status(404).json({ error: 'not_found', message: '文档不存在或无权查看' });
      return;
    }
    res.json({ data: doc });
  });

  // —— 检索测试（走 knowledge MCP 的真实检索链路：Infinity + BM25）——
  router.post('/v1/knowledge/search', async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const query = String(req.body?.query ?? '').trim();
    if (!query) {
      res.status(400).json({ error: 'bad_request', message: '检索词不能为空' });
      return;
    }
    const topK = Math.min(Number(req.body?.topK ?? 5), 20);

    // 管理员可跨部门检索：把租户内所有部门作为额外范围传给 MCP 工具
    let deptScope: string[] | undefined;
    if (WRITER_ROLES.has(identity.role)) {
      const all = await ctx.store.listKnowledgeDocs(identity.tenantId);
      deptScope = [...new Set(all.map((d) => d.deptId))].filter((d) => d && d !== 'all');
    }

    const outcome = await ctx.mcp.call({
      identity,
      serverId: 'knowledge',
      toolName: 'knowledge.search',
      args: { query, topK, ...(deptScope?.length ? { deptScope: deptScope.join(',') } : {}) },
      traceId: `knowledge-search-${uuid()}`,
    });
    if (!outcome.ok) {
      res.status(400).json({ error: 'search_failed', message: outcome.content || '检索失败' });
      return;
    }
    const structured = (outcome.structured ?? {}) as { count?: number; hits?: unknown[]; engine?: string };
    res.json({
      data: {
        query,
        topK,
        engine: structured.engine ?? 'unknown',
        count: structured.count ?? 0,
        hits: structured.hits ?? [],
        content: outcome.content,
      },
    });
  });

  // —— 新增 / 更新（生成审批单，审批通过后才落库）——
  router.post('/v1/knowledge/docs', async (req: Request, res: Response) => {
    if (!assertWriter(req, res)) return;
    const body = req.body ?? {};
    const title = String(body.title ?? '').trim();
    const content = String(body.content ?? '').trim();
    if (!title || !content) {
      res.status(400).json({ error: 'bad_request', message: '标题与正文均不能为空' });
      return;
    }
    const sensitivity = String(body.sensitivity ?? 'internal');
    if (!(sensitivity in CLEARANCE)) {
      res.status(400).json({ error: 'bad_request', message: '密级必须是 public / internal / confidential' });
      return;
    }
    const id = body.id ? String(body.id) : `doc-${Date.now().toString(36)}`;
    const deptId = String(body.deptId ?? requireIdentity(req).deptId);
    await requestWrite(
      req,
      res,
      KB_UPSERT_TOOL,
      { id, title, content, deptId, sensitivity },
      `控制台写入知识库文档《${title}》`,
    );
  });

  // —— 删除（生成审批单）——
  router.delete('/v1/knowledge/docs/:id', async (req: Request, res: Response) => {
    if (!assertWriter(req, res)) return;
    const id = String(req.params.id);
    const identity = requireIdentity(req);
    const all = await ctx.store.listKnowledgeDocs(identity.tenantId);
    const doc = all.find((d) => d.id === id);
    if (!doc) {
      res.status(404).json({ error: 'not_found', message: '文档不存在' });
      return;
    }
    // 密级仍受约束：不能删除高于自身密级的文档
    if (!isDocVisible(doc, identity)) {
      res.status(403).json({ error: 'forbidden', message: '文档密级高于当前身份，不可操作' });
      return;
    }
    await requestWrite(req, res, KB_DELETE_TOOL, { id }, `控制台删除知识库文档《${doc.title}》`);
  });

  return router;
}
