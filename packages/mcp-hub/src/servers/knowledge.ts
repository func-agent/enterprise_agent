/**
 * knowledge MCP Server —— 对应 RAGFlow 文档知识库职责（见 4.2）。
 *
 * 生产形态由 RAGFlow + Infinity + TEI 承担（Docker Compose 内）；本实现提供等价接口，
 * 采用「召回前过滤 + BM25 混合打分」，确保权限过滤发生在检索阶段而非全库召回后过滤
 * （见 5.2 关键实现要点 —— 最高优先级）。
 */
import { z } from 'zod';
import {
  createLogger,
  SqliteMetadataStore,
  uuid,
  type Identity,
  type MetadataStore,
  type SensitivityLevel,
} from '@eap/platform-core';
import { errorResult, textResult, type McpToolDef } from '../server-base.js';
import type { InfinityClient } from '../retrieval/infinity.js';
import type { TeiClient } from '../retrieval/tei.js';

const log = createLogger('mcp:knowledge');

const CLEARANCE: Record<SensitivityLevel, number> = { public: 0, internal: 1, confidential: 2 };

/** 网关透传的用户上下文（见 5.2 透传用户上下文） */
export interface ToolCtx {
  tenant_id: string;
  user_id: string;
  role: string;
  dept_id: string;
  sensitivity: SensitivityLevel;
}

/**
 * 从入参里取调用者上下文。
 *
 * ⚠ 兜底必须**保守**：网关会注入 `__ctx`（见 gateway/src/mcp/registry.ts）。
 * 一旦拿不到（schema strip、直接调用等），宁可一条都查不到，也不能退回
 * 一个「宽松的固定身份」—— 那会让所有人以同一个固定身份检索，绕过部门与密级隔离。
 * 这里默认 dept_id=''（不匹配任何部门）、sensitivity='public'（只匹配公开文档），
 * 并打 warn 日志，便于回归时第一时间发现。
 */
export function ctxFrom(args: Record<string, any>): ToolCtx {
  const c = (args.__ctx ?? {}) as Partial<ToolCtx>;
  if (!args.__ctx) {
    log.warn('入参缺少 __ctx，按最小权限处理（不应发生：调用应经网关）');
  }
  return {
    tenant_id: c.tenant_id ?? 't-default',
    user_id: c.user_id ?? 'anonymous',
    role: c.role ?? 'employee',
    dept_id: c.dept_id ?? '',
    sensitivity: (c.sensitivity as SensitivityLevel) ?? 'public',
  };
}

/** 中英混合分词：CJK 取 bigram，拉丁取词干 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) out.push(m[0]);
  const cjk = lower.match(/[一-龥]+/g) ?? [];
  for (const seg of cjk) {
    if (seg.length === 1) out.push(seg);
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/** BM25 打分 */
function bm25(queryTerms: string[], docTerms: string[], docLen: number, avgLen: number, idf: Map<string, number>): number {
  const k1 = 1.5;
  const b = 0.75;
  const tf = new Map<string, number>();
  for (const t of docTerms) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const q of new Set(queryTerms)) {
    const f = tf.get(q) ?? 0;
    if (f === 0) continue;
    const idfVal = idf.get(q) ?? 0;
    score += idfVal * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docLen) / avgLen)));
  }
  return score;
}

export interface KnowledgeDeps {
  /** Infinity 检索引擎（可选）；不可用时自动回退本地 BM25 */
  infinity?: InfinityClient;
  /** TEI 本地嵌入（可选）；用于向量化查询 */
  tei?: TeiClient;
}

export function createKnowledgeTools(store: MetadataStore, deps: KnowledgeDeps = {}): McpToolDef[] {
  return [
    {
      name: 'knowledge.search',
      title: '文档检索',
      description:
        '在企业文档知识库中检索（制度/合同/手册）。检索阶段即按用户部门与密级过滤，返回带来源的片段。',
      inputSchema: {
        query: z.string().describe('自然语言查询或关键词'),
        topK: z.number().optional().describe('返回条数，默认 5（控制 Token 成本）'),
        deptScope: z.string().optional().describe('额外部门范围，逗号分隔'),
      },
      meta: { requiresConfirmation: false, sensitivity: 'internal', dataScope: 'tenant+dept+sensitivity' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const query = String(args.query ?? '');
        const topK = Math.min(Number(args.topK ?? 5), 20);

        const all = await store.listKnowledgeDocs(ctx.tenant_id);
        // —— 召回前过滤（tenant / 部门 / 密级）
        const clearance = CLEARANCE[ctx.sensitivity];
        const extraDepts = new Set(
          String(args.deptScope ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );

        // —— 优先走 Infinity 检索引擎：过滤条件直接下推到 SQL WHERE，
        //    比应用层过滤更强（见 5.2 禁止全库召回后再过滤）
        if (deps.infinity?.isAvailable) {
          try {
            let queryVector: number[] | undefined;
            if (deps.infinity.capabilities.vector && deps.tei) {
              try {
                queryVector = (await deps.tei.embed([deps.tei.withQueryPrefix(query)]))[0];
              } catch {
                queryVector = undefined;
              }
            }
            const infHits = await deps.infinity.search(
              query,
              {
                tenantId: ctx.tenant_id,
                deptId: ctx.dept_id,
                maxSensitivity: ctx.sensitivity,
                extraDepts: [...extraDepts],
              },
              topK,
              queryVector,
            );
            if (infHits.length) {
              return textResult(renderHits(infHits), {
                count: infHits.length,
                hits: infHits,
                engine: 'infinity',
              });
            }
          } catch {
            // Infinity 异常不阻塞检索，静默降级到本地 BM25
          }
        }

        const visible = all.filter((d) => {
          if (d.tenantId !== ctx.tenant_id) return false;
          if (CLEARANCE[d.sensitivity] > clearance) return false;
          if (d.deptId === 'all' || d.deptId === ctx.dept_id) return true;
          if (extraDepts.has(d.deptId)) return true;
          return false;
        });

        if (visible.length === 0) {
          return textResult('未检索到权限范围内的文档。', { count: 0, hits: [] });
        }

        const queryTerms = tokenize(query);
        const docTokens = visible.map((d) => tokenize(`${d.title}\n${d.content}`));
        const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / Math.max(1, docTokens.length);
        const df = new Map<string, number>();
        for (const terms of docTokens) {
          for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
        }
        const N = visible.length;
        const idf = new Map<string, number>();
        for (const [t, d] of df) idf.set(t, Math.log(1 + (N - d + 0.5) / (d + 0.5)));

        const scored = visible
          .map((d, i) => ({
            doc: d,
            score: bm25(queryTerms, docTokens[i], docTokens[i].length, avgLen, idf),
          }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);

        const hits = scored.map((x) => ({
          docId: x.doc.id,
          title: x.doc.title,
          deptId: x.doc.deptId,
          sensitivity: x.doc.sensitivity,
          score: Number(x.score.toFixed(4)),
          snippet: x.doc.content.slice(0, 400),
        }));

        return textResult(renderHits(hits), { count: hits.length, hits, engine: 'local-bm25' });
      },
    },
    {
      name: 'knowledge.list_documents',
      title: '文档列表',
      description: '列出当前用户权限范围内的知识库文档。',
      inputSchema: {},
      meta: { requiresConfirmation: false, sensitivity: 'internal', dataScope: 'tenant+dept' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const docs = (await store.listKnowledgeDocs(ctx.tenant_id)).filter(
          (d) => d.deptId === 'all' || d.deptId === ctx.dept_id,
        );
        return textResult(
          docs.map((d) => `${d.id} | ${d.title} | 部门 ${d.deptId} | 密级 ${d.sensitivity}`).join('\n') || '暂无文档',
          { count: docs.length },
        );
      },
    },
    {
      name: 'knowledge.upsert_document',
      title: '写入文档',
      description: '新增或更新知识库文档（写操作，需人工确认）。',
      inputSchema: {
        id: z.string().optional().describe('文档 ID，留空则新建'),
        title: z.string().describe('标题'),
        content: z.string().describe('正文'),
        deptId: z.string().describe('归属部门'),
        sensitivity: z.enum(['public', 'internal', 'confidential']).describe('密级'),
      },
      meta: { requiresConfirmation: true, sensitivity: 'internal', dataScope: 'write' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const id = String(args.id ?? `doc-${uuid()}`);
        const doc = {
          id,
          tenantId: ctx.tenant_id,
          deptId: String(args.deptId ?? ctx.dept_id),
          title: String(args.title ?? ''),
          content: String(args.content ?? ''),
          sensitivity: (args.sensitivity as SensitivityLevel) ?? 'internal',
          ownerId: ctx.user_id,
          updatedAt: new Date().toISOString(),
        };
        const written = await store.upsertKnowledgeDoc(doc);
        if (!written) return errorResult(`文档 ${id} 属于其他租户，拒绝覆盖。`);
        // 同步到 Infinity 检索引擎（不可用时忽略，本地检索仍生效）
        if (deps.infinity?.isAvailable) {
          // 必须带上向量：不带向量写入的行在 dense 召回时等价于「没有向量」，
          // 文档就永远召不回来（全文检索仍能命中，掩盖了问题）。
          // 文档侧用 passage 前缀，与查询侧的 query 前缀区分。
          let embedding: number[] | undefined;
          if (deps.tei) {
            try {
              const text = deps.tei.withPassagePrefix(`${doc.title}\n${doc.content}`);
              embedding = (await deps.tei.embed([text]))[0];
            } catch {
              embedding = undefined;
            }
          }
          await deps.infinity.upsert({
            docId: doc.id,
            tenantId: doc.tenantId,
            deptId: doc.deptId,
            sensitivity: doc.sensitivity,
            title: doc.title,
            content: doc.content,
            updatedAt: doc.updatedAt,
            embedding,
          });
        }
        return textResult(`文档 ${id} 已写入知识库。`, { id });
      },
    },
    {
      name: 'knowledge.delete_document',
      title: '删除文档',
      description: '从知识库删除文档（破坏性操作，需人工确认）。',
      inputSchema: { id: z.string().describe('文档 ID') },
      meta: { requiresConfirmation: true, sensitivity: 'internal', dataScope: 'write' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const id = String(args.id ?? '');
        const deleted = await store.deleteKnowledgeDoc(id, ctx.tenant_id);
        if (!deleted) return errorResult(`文档 ${id} 不存在或不属于当前租户，未删除。`);
        // 同步清理 Infinity 索引 —— 早期版本只删了主库，导致已删文档的向量
        // 仍留在检索引擎里，召回后返回「文档不存在」的空壳结果。
        if (deps.infinity?.isAvailable) {
          await deps.infinity.deleteByFilter(`doc_id = '${id.replace(/'/g, "''")}'`);
        }
        return textResult(`文档 ${id} 已删除。`, { id });
      },
    },
  ];
}

/** 命中结果统一渲染 —— 带来源标注，便于 Agent 溯源 */
export function renderHits(
  hits: { docId: string; title: string; sensitivity: string; score: number; snippet: string }[],
): string {
  if (!hits.length) return '未检索到权限范围内的文档。';
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] 《${h.title}》（来源 ${h.docId}，密级 ${h.sensitivity}，得分 ${h.score}）\n${h.snippet}`,
    )
    .join('\n\n');
}
