/**
 * 知识库 —— 企业文档知识库的管理与检索验证页。
 *
 * 页面数据来自平台主库 knowledge_docs，由 knowledge MCP 服务供 Agent 检索。
 * RAGFlow 是可选独立组件，与本页数据互不相通。
 * 列表与检索按当前身份的部门和密级过滤；新增与删除均需审批后生效。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Eye,
  FileText,
  Files,
  Info,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  createKnowledgeDoc,
  deleteKnowledgeDoc,
  errorMessage,
  getKnowledgeDoc,
  listKnowledgeDocs,
  searchKnowledge,
} from '../api';
import type { Identity, KnowledgeDoc, KnowledgeSearchResult, KnowledgeSummary } from '../types';
import { Badge, EmptyState, ErrorNotice, Loading, PageHead, PageShell, Panel } from '../components/ui';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { useToast } from '../components/Toast';

const SENSITIVITY_OPTIONS = [
  { key: '', label: '全部密级' },
  { key: 'public', label: '公开' },
  { key: 'internal', label: '内部' },
  { key: 'confidential', label: '机密' },
];

const SENSITIVITY_LABEL: Record<string, string> = {
  public: '公开',
  internal: '内部',
  confidential: '机密',
};

const FIELD_CLASS =
  'border-border bg-background focus-visible:border-primary w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/20';

function sensitivityTone(level: string): 'neutral' | 'primary' | 'warning' {
  if (level === 'confidential') return 'warning';
  if (level === 'public') return 'neutral';
  return 'primary';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function KnowledgePage({
  identity,
  onUnauthorized,
}: {
  identity: Identity;
  onUnauthorized: () => void;
}) {
  const toast = useToast();
  const canWrite = identity.role === 'platform-admin' || identity.role === 'admin';

  const [docs, setDocs] = useState<KnowledgeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [deptFilter, setDeptFilter] = useState('');
  const [sensFilter, setSensFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 50, total: 0, totalPages: 0 });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeDoc | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [deptId, setDeptId] = useState(identity.dept_id ?? 'dept-general');
  const [sensitivity, setSensitivity] = useState('internal');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await listKnowledgeDocs({
        deptId: deptFilter || undefined,
        sensitivity: sensFilter || undefined,
        q: keyword.trim() || undefined,
        page,
        pageSize: 50,
      });
      setDocs(result.data);
      setPagination(result.pagination);
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      if (message.includes('登录') || message.includes('失效')) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [deptFilter, sensFilter, keyword, page, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(
    async (id: string): Promise<void> => {
      setSelectedId(id);
      setDetailLoading(true);
      setDetail(null);
      try {
        setDetail(await getKnowledgeDoc(id));
      } catch (err) {
        toast.push(errorMessage(err), 'error');
        setSelectedId(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [toast],
  );

  const runSearch = useCallback(async (): Promise<void> => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    try {
      setSearchResult(await searchKnowledge(q, 5));
    } catch (err) {
      setSearchError(errorMessage(err));
      setSearchResult(null);
    } finally {
      setSearching(false);
    }
  }, [query]);

  const submitCreate = useCallback(async (): Promise<void> => {
    if (!title.trim() || !content.trim()) {
      toast.push('标题与正文均不能为空', 'warning');
      return;
    }
    setSubmitting(true);
    try {
      const ticket = await createKnowledgeDoc({
        title: title.trim(),
        content: content.trim(),
        deptId,
        sensitivity,
      });
      toast.push(`已提交审批（${ticket.approvalId.slice(0, 8)}…），审批通过后生效`, 'success');
      setTitle('');
      setContent('');
      setFormOpen(false);
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setSubmitting(false);
    }
  }, [title, content, deptId, sensitivity, toast]);

  const submitDelete = useCallback(
    async (doc: KnowledgeSummary): Promise<void> => {
      if (!window.confirm(`确认删除《${doc.title}》？\n删除同样需要审批，通过后才会真正移除。`)) return;
      try {
        const ticket = await deleteKnowledgeDoc(doc.id);
        toast.push(`已提交删除审批（${ticket.approvalId.slice(0, 8)}…）`, 'success');
        if (selectedId === doc.id) {
          setSelectedId(null);
          setDetail(null);
        }
      } catch (err) {
        toast.push(errorMessage(err), 'error');
      }
    },
    [selectedId, toast],
  );

  const deptOptions = useMemo(() => {
    const set = new Set<string>();
    for (const d of docs) set.add(d.deptId);
    return [...set].sort();
  }, [docs]);

  const stat = useMemo(
    () => ({
      total: pagination.total,
      current: docs.length,
      confidential: docs.filter((d) => d.sensitivity === 'confidential').length,
    }),
    [docs, pagination.total],
  );

  const overview = [
    { label: '可见文档', value: stat.total, hint: '当前权限与筛选范围', icon: BookOpen },
    { label: '本页文档', value: stat.current, hint: '每页最多 50 篇', icon: Files },
    { label: '本页机密文档', value: stat.confidential, hint: '仅统计当前列表', icon: ShieldCheck },
  ];
  const hasFilters = Boolean(deptFilter || sensFilter || keyword);

  const resetFilters = () => {
    setDeptFilter('');
    setSensFilter('');
    setKeyword('');
    setPage(1);
  };

  return (
    <PageShell>
      <PageHead
        title="知识库"
        subtitle="管理知识文档，验证 Agent 检索效果。"
        description="按部门与密级隔离，写入和删除需审批。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => void load()}>
              <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
              刷新
            </button>
            {canWrite ? (
              <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                新增文档
              </button>
            ) : null}
          </>
        }
      />

      {!canWrite ? (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          当前角色为只读。写入与删除仅限管理员，且需经审批后生效。
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {overview.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="border-border bg-card flex items-center gap-3 rounded-xl border p-4 shadow-sm">
              <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums">{item.value}</span>
                  <span className="text-xs font-medium">{item.label}</span>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">{item.hint}</p>
              </div>
            </div>
          );
        })}
      </div>

      <Panel title="检索验证" className="mb-5">
        <p className="text-muted-foreground mb-3 text-sm">输入问题，快速验证文档能否被 Agent 检索到。</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden="true" />
            <input
              className={`${FIELD_CLASS} ps-9`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch();
              }}
              placeholder="例如：年假怎么计算"
              aria-label="检索问题"
            />
          </div>
          <button
            type="button"
            className="btn btn-primary sm:min-w-24"
            disabled={searching || !query.trim()}
            onClick={() => void runSearch()}
          >
            <Search className="size-4" aria-hidden="true" />
            {searching ? '检索中…' : '检索'}
          </button>
        </div>

        {searchError ? <div className="mt-3"><ErrorNotice message={searchError} /></div> : null}

        {searchResult ? (
          <div className="border-border mt-4 border-t pt-4" aria-live="polite">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium">检索结果</h4>
              <span className="text-muted-foreground text-xs">命中 {searchResult.count} 条</span>
            </div>
            {searchResult.hits.length === 0 ? (
              <EmptyState text="未检索到权限范围内的文档" hint="换一个说法试试，或确认文档归属部门与密级。" />
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                {searchResult.hits.map((hit) => (
                  <button
                    key={hit.docId}
                    type="button"
                    onClick={() => void openDetail(hit.docId)}
                    className="border-border bg-muted/20 hover:border-primary/40 hover:bg-accent/50 rounded-lg border px-3 py-3 text-start transition-colors"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 text-sm font-medium">{hit.title}</span>
                      <Badge tone={sensitivityTone(hit.sensitivity)}>
                        {SENSITIVITY_LABEL[hit.sensitivity] ?? hit.sensitivity}
                      </Badge>
                      <span className="text-muted-foreground ml-auto text-xs tabular-nums">得分 {hit.score}</span>
                    </div>
                    <p className="text-muted-foreground mt-1.5 line-clamp-2 text-xs leading-relaxed">{hit.snippet}</p>
                    <p className="text-muted-foreground mt-2 text-xs">{hit.deptId}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Panel>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title={
            <span className="flex items-center gap-2">
              <FileText className="text-primary size-4" aria-hidden="true" />
              知识文档
            </span>
          }
          extra={<span className="text-muted-foreground text-xs whitespace-nowrap">共 {pagination.total} 篇</span>}
        >
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <div className="relative min-w-0 flex-1 sm:min-w-52">
              <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden="true" />
              <input
                className={`${FIELD_CLASS} ps-9`}
                value={keyword}
                onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
                placeholder="搜索标题或正文"
                aria-label="关键字过滤"
              />
            </div>
            <select
              className={`${FIELD_CLASS} sm:w-36`}
              value={deptFilter}
              onChange={(e) => { setDeptFilter(e.target.value); setPage(1); }}
              aria-label="按部门过滤"
            >
              <option value="">全部部门</option>
              {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select
              className={`${FIELD_CLASS} sm:w-32`}
              value={sensFilter}
              onChange={(e) => { setSensFilter(e.target.value); setPage(1); }}
              aria-label="按密级过滤"
            >
              {SENSITIVITY_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            {hasFilters ? (
              <button type="button" className="btn btn-ghost" onClick={resetFilters}>重置</button>
            ) : null}
          </div>

          {loading ? <Loading text="文档列表加载中…" /> : null}
          {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}

          {!loading && !error ? (
            docs.length === 0 ? (
              <EmptyState
                text={hasFilters ? '没有符合筛选条件的文档' : '当前身份没有可见的知识文档'}
                hint={hasFilters ? '尝试重置筛选条件。' : '文档按部门与密级控制可见范围。'}
              />
            ) : (
              <>
                <div className="hidden md:block">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>标题</th>
                        <th>部门</th>
                        <th>密级</th>
                        <th>更新时间</th>
                        <th className="text-end">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {docs.map((doc) => (
                        <tr key={doc.id} className={selectedId === doc.id ? 'bg-accent/50' : 'hover:bg-accent/30 transition-colors'}>
                          <td>
                            <button type="button" className="max-w-64 text-start font-medium hover:text-primary" onClick={() => void openDetail(doc.id)}>
                              <span className="line-clamp-2">{doc.title}</span>
                            </button>
                            <div className="text-muted-foreground mt-0.5 text-xs">{doc.contentLength} 字</div>
                          </td>
                          <td className="text-muted-foreground">{doc.deptId}</td>
                          <td><Badge tone={sensitivityTone(doc.sensitivity)}>{SENSITIVITY_LABEL[doc.sensitivity] ?? doc.sensitivity}</Badge></td>
                          <td className="text-muted-foreground whitespace-nowrap">{formatTime(doc.updatedAt)}</td>
                          <td className="text-end">
                            <div className="flex items-center justify-end gap-1">
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openDetail(doc.id)}>
                                <Eye className="size-3.5" aria-hidden="true" />详情
                              </button>
                              {canWrite ? (
                                <button type="button" className="btn btn-ghost btn-sm text-destructive hover:text-destructive" onClick={() => void submitDelete(doc)}>
                                  <Trash2 className="size-3.5" aria-hidden="true" />删除
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-col gap-3 md:hidden">
                  {docs.map((doc) => (
                    <article key={doc.id} className={`rounded-lg border p-3 ${selectedId === doc.id ? 'border-primary/40 bg-accent/40' : 'border-border bg-muted/20'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <button type="button" className="min-w-0 text-start text-sm font-medium hover:text-primary" onClick={() => void openDetail(doc.id)}>{doc.title}</button>
                        <Badge tone={sensitivityTone(doc.sensitivity)}>{SENSITIVITY_LABEL[doc.sensitivity] ?? doc.sensitivity}</Badge>
                      </div>
                      <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <span>{doc.deptId}</span>
                        <span>{doc.contentLength} 字</span>
                        <span>{formatTime(doc.updatedAt)}</span>
                      </div>
                      <div className="border-border/60 mt-3 flex justify-end gap-1 border-t pt-2">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openDetail(doc.id)}>
                          <Eye className="size-3.5" aria-hidden="true" />查看详情
                        </button>
                        {canWrite ? (
                          <button type="button" className="btn btn-ghost btn-sm text-destructive hover:text-destructive" onClick={() => void submitDelete(doc)}>
                            <Trash2 className="size-3.5" aria-hidden="true" />删除
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )
          ) : null}

          {pagination.totalPages > 1 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">共 {pagination.total} 条 · 第 {pagination.page}/{pagination.totalPages} 页</span>
              <div className="flex gap-2">
                <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel
          title="文档详情"
          className="min-w-0 xl:sticky xl:top-4"
          extra={detail ? (
            <button
              type="button"
              className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-7 items-center justify-center rounded-md"
              onClick={() => { setSelectedId(null); setDetail(null); }}
              aria-label="关闭文档详情"
              title="关闭文档详情"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : undefined}
        >
          {detailLoading ? <Loading text="详情加载中…" /> : null}
          {!detailLoading && !detail ? (
            <EmptyState text="选择一篇文档查看详情" hint="可点击文档标题或检索结果。" />
          ) : null}
          {detail ? (
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={sensitivityTone(detail.sensitivity)}>{SENSITIVITY_LABEL[detail.sensitivity] ?? detail.sensitivity}</Badge>
                  <span className="text-muted-foreground text-xs">{detail.deptId}</span>
                </div>
                <h4 className="mt-2 text-base leading-snug font-semibold">{detail.title}</h4>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">所有者</dt>
                  <dd className="mt-1 break-all font-mono">{detail.ownerId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">更新时间</dt>
                  <dd className="mt-1">{formatTime(detail.updatedAt)}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">文档 ID</dt>
                  <dd className="mt-1 break-all font-mono">{detail.id}</dd>
                </div>
              </dl>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h5 className="text-xs font-medium">正文</h5>
                  <span className="text-muted-foreground text-xs">{detail.contentLength} 字</span>
                </div>
                <div className="border-border bg-muted/30 max-h-96 overflow-y-auto rounded-lg border p-3">
                  <p className="text-foreground text-sm leading-6 whitespace-pre-wrap">{detail.content}</p>
                </div>
              </div>

              {canWrite ? (
                <button type="button" className="btn btn-ghost text-destructive hover:bg-destructive/10 hover:text-destructive self-end" onClick={() => void submitDelete(detail)}>
                  <Trash2 className="size-4" aria-hidden="true" />删除文档
                </button>
              ) : null}
            </div>
          ) : null}
        </Panel>
      </div>

      <footer className="border-border bg-muted/20 text-muted-foreground mt-5 flex items-start gap-2 rounded-lg border px-4 py-3 text-xs leading-relaxed">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>文档按部门与密级控制可见范围，新增和删除须经审批后生效。RAGFlow 使用独立的数据与界面，与本页不互通。</p>
      </footer>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>新增知识文档</DialogTitle>
            <DialogDescription>提交后生成审批单，审批通过后文档才会生效。</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <label className="flex flex-col gap-1.5 text-xs font-medium" htmlFor="knowledge-title">
              标题
              <input
                id="knowledge-title"
                className={FIELD_CLASS}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：员工年假管理制度"
                autoFocus
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-xs font-medium" htmlFor="knowledge-dept">
                归属部门
                <input
                  id="knowledge-dept"
                  className={FIELD_CLASS}
                  value={deptId}
                  onChange={(e) => setDeptId(e.target.value)}
                  placeholder="dept-general"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium" htmlFor="knowledge-sensitivity">
                密级
                <select
                  id="knowledge-sensitivity"
                  className={FIELD_CLASS}
                  value={sensitivity}
                  onChange={(e) => setSensitivity(e.target.value)}
                >
                  {SENSITIVITY_OPTIONS.filter((o) => o.key).map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1.5 text-xs font-medium" htmlFor="knowledge-content">
              正文
              <textarea
                id="knowledge-content"
                className={`${FIELD_CLASS} min-h-48 resize-y leading-relaxed`}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="输入供 Agent 检索的文档正文"
              />
            </label>
            <DialogFooter className="border-border border-t pt-4">
              <DialogClose asChild>
                <button type="button" className="btn btn-ghost">取消</button>
              </DialogClose>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? '提交中…' : '提交审批'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
