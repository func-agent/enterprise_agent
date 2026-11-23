/**
 * 审计与 Trace —— 审计事件明细（可展开 detail）与调用链摘要。
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage, fetchAudit, fetchTraces } from '../api';
import type { AuditEvent, TraceRecord } from '../types';
import { formatTime, formatTokens, formatUsd, prettyJson, truncate } from '../format';
import { Badge, EmptyState, ErrorNotice, Loading, PageHead, Panel } from '../components/ui';

type KindFilter = 'all' | 'llm' | 'tool' | 'admin';

const KINDS: { key: KindFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'llm', label: '模型调用' },
  { key: 'tool', label: '工具调用' },
  { key: 'admin', label: '管理操作' },
];

const STATUS_TONE: Record<string, 'success' | 'error' | 'warning'> = {
  ok: 'success',
  error: 'error',
  blocked: 'warning',
};

export function AuditPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tracesLoading, setTracesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await fetchAudit(kind, 200));
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      if (message.includes('登录') || message.includes('失效')) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [kind, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setTracesLoading(true);
    void fetchTraces()
      .then((list) => {
        if (!cancelled) setTraces(list);
      })
      .catch(() => {
        if (!cancelled) setTraces([]);
      })
      .finally(() => {
        if (!cancelled) setTracesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <PageHead
        title="审计与 Trace"
        subtitle="追溯模型、工具与管理操作。"
        description="筛选事件，展开查看审计详情与 Trace。"
        actions={
          <>
            <div className="seg">
              {KINDS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`seg-item ${kind === item.key ? 'seg-item-active' : ''}`}
                  onClick={() => setKind(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => void load()}>
              <RefreshCw className="size-4" />刷新
            </button>
          </>
        }
      />

      {loading ? <Loading text="审计日志加载中…" /> : null}
      {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}

      {!loading && !error ? (
        <Panel title={`审计事件（${events.length}）`} className="mb">
          {events.length === 0 ? (
            <EmptyState text="暂无审计事件" />
          ) : (
            <div className="table-wrap">
              <table className="table table-audit">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th className="min-w-72">主体</th>
                    <th>模型 / 工具</th>
                    <th>Token</th>
                    <th>成本</th>
                    <th>状态</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => {
                    const expanded = expandedId === event.id;
                    return (
                      <Fragment key={event.id}>
                        <tr
                          className={`row-clickable ${expanded ? 'row-expanded' : ''}`}
                          onClick={() => setExpandedId(expanded ? null : event.id)}
                        >
                          <td className="td-nowrap">{formatTime(event.ts)}</td>
                          <td>
                            <Badge tone="neutral">{event.kind}</Badge>
                          </td>
                          <td className="min-w-72 whitespace-nowrap">
                            <div className="td-subject">
                              <span>{event.userId}</span>
                              <span className="td-sub">
                                {event.role ?? '—'} · {event.tenantId}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="td-subject">
                              <code className="code-name">{event.model ?? event.tool ?? '—'}</code>
                              {event.serverId ? <span className="td-sub">server {event.serverId}</span> : null}
                            </div>
                          </td>
                          <td className="td-nowrap">
                            {formatTokens((event.promptTokens ?? 0) + (event.completionTokens ?? 0))}
                          </td>
                          <td className="td-nowrap">{formatUsd(event.costUsd ?? 0)}</td>
                          <td>
                            <Badge tone={STATUS_TONE[event.status] ?? 'neutral'}>{event.status}</Badge>
                          </td>
                          <td className="td-reason">{event.reason ?? '—'}</td>
                        </tr>
                        {expanded ? (
                          <tr className="row-detail">
                            <td colSpan={8}>
                              <div className="detail-grid">
                                <div>
                                  <span className="detail-label">Trace</span>
                                  <code className="code-name">{event.traceId}</code>
                                </div>
                                {event.sessionId ? (
                                  <div>
                                    <span className="detail-label">会话</span>
                                    <code className="code-name">{event.sessionId}</code>
                                  </div>
                                ) : null}
                                {event.deptId ? (
                                  <div>
                                    <span className="detail-label">部门</span>
                                    <span>{event.deptId}</span>
                                  </div>
                                ) : null}
                                {event.provider ? (
                                  <div>
                                    <span className="detail-label">Provider</span>
                                    <span>{event.provider}</span>
                                  </div>
                                ) : null}
                              </div>
                              <pre className="json-block">{prettyJson(event.detail ?? {})}</pre>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      <Panel title={`Trace 列表（${traces.length}）`}>
        {tracesLoading ? (
          <Loading text="Trace 加载中…" />
        ) : traces.length === 0 ? (
          <EmptyState text="暂无 Trace 记录" />
        ) : (
          <div className="trace-list">
            {traces.map((trace) => (
              <article key={trace.traceId} className="trace-card">
                <header className="trace-head">
                  <span className="trace-name">{trace.name}</span>
                  <code className="code-name">{trace.traceId.slice(0, 16)}</code>
                  <span className="trace-time">{formatTime(trace.ts)}</span>
                </header>
                <div className="trace-meta">
                  <span>用户 {trace.userId}</span>
                  <span>租户 {trace.tenantId}</span>
                  {trace.model ? <span>模型 {trace.model}</span> : null}
                  <span>Token {formatTokens(trace.promptTokens + trace.completionTokens)}</span>
                  <span>成本 {formatUsd(trace.costUsd)}</span>
                </div>
                {trace.input !== undefined ? (
                  <details className="trace-detail">
                    <summary>输入摘要</summary>
                    <pre className="json-block">{truncate(prettyJson(trace.input), 1200)}</pre>
                  </details>
                ) : null}
                {trace.output !== undefined ? (
                  <details className="trace-detail">
                    <summary>输出摘要</summary>
                    <pre className="json-block">{truncate(prettyJson(trace.output), 1200)}</pre>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
