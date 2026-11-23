/**
 * HITL 审批卡片 —— 审批中心与对话页共用。
 */
import type { Approval, Identity } from '../types';
import { formatDateTime, prettyJson } from '../format';
import { canDecideApproval } from '../permissions';
import { Badge, JsonBlock } from './ui';
import { cn } from '../lib/utils';

export function ApprovalCard({
  approval,
  identity,
  busy = false,
  onDecide,
}: {
  approval: Approval;
  identity: Identity;
  busy?: boolean;
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
}) {
  const pending = approval.status === 'pending';
  const canDecide = canDecideApproval(identity, approval);

  return (
    <article
      className={cn(
        'rounded-xl border bg-card p-4 shadow-sm',
        pending ? 'border-amber-300 ring-1 ring-amber-100 dark:border-amber-700 dark:ring-amber-900' : 'border-border',
      )}
    >
      <header className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono text-sm font-semibold">{approval.tool}</span>
        {pending ? (
          <Badge tone="warning">等待人工确认</Badge>
        ) : (
          <Badge
            tone={
              approval.status === 'approved'
                ? 'success'
                : approval.status === 'rejected'
                  ? 'error'
                  : approval.status === 'expired'
                    ? 'warning'
                    : 'neutral'
            }
          >
            {approval.status}
          </Badge>
        )}
      </header>

      <p className="text-muted-foreground mb-3 text-sm">{approval.reason || '（未填写原因）'}</p>

      <div className="mb-3">
        <span className="text-muted-foreground mb-1 block text-xs font-medium">调用参数</span>
        <JsonBlock value={prettyJson(approval.args)} compact />
      </div>

      <div className="text-muted-foreground mb-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <span>
          <em className="not-italic">申请人 </em>
          {approval.userId}
        </span>
        <span>
          <em className="not-italic">时间 </em>
          {formatDateTime(approval.createdAt)}
        </span>
        <span className="min-w-0 truncate">
          <em className="not-italic">会话 </em>
          <code className="font-mono">{approval.sessionId || '—'}</code>
        </span>
        <span className="min-w-0 truncate">
          <em className="not-italic">Trace </em>
          <code className="font-mono">{approval.traceId ? approval.traceId.slice(0, 16) : '—'}</code>
        </span>
      </div>

      {pending ? (
        canDecide ? (
          <footer className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(approval.id, 'approved')}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            >
              批准
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(approval.id, 'rejected')}
              className="border-destructive/40 text-destructive hover:bg-destructive/10 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            >
              驳回
            </button>
          </footer>
        ) : (
          <footer className="text-muted-foreground text-xs">等待其他审批人处理</footer>
        )
      ) : (
        <footer className="text-muted-foreground text-xs">
          由 {approval.decidedBy ?? '—'} 于 {approval.decidedAt ? formatDateTime(approval.decidedAt) : '—'} 处理
        </footer>
      )}
    </article>
  );
}
