/**
 * 审批中心 —— 人工确认（HITL）工单列表。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ApiError, decideApproval, errorMessage, listApprovals } from '../api';
import type { Approval, Identity } from '../types';
import { ApprovalCard } from '../components/ApprovalCard';
import { EmptyState, ForbiddenNotice, Loading, PageHead, Segmented } from '../components/ui';
import { useToast } from '../components/Toast';

type StatusFilter = 'pending' | 'approved' | 'executed' | 'rejected' | 'all';

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已批准' },
  { key: 'executed', label: '已执行' },
  { key: 'rejected', label: '已驳回' },
  { key: 'all', label: '全部' },
];

export function ApprovalsPage({
  identity,
  onUnauthorized,
}: {
  identity: Identity;
  onUnauthorized: () => void;
}) {
  const toast = useToast();
  const [filter, setFilter] = useState<StatusFilter>('pending');
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listApprovals(filter));
      setForbidden(false);
    } catch (err) {
      const message = errorMessage(err);
      // 用 HTTP 状态码判定权限不足，不依赖后端错误文案
      // （文案会随后端调整而变，匹配文案是脆弱的）。
      if (err instanceof ApiError && err.isForbidden) {
        setForbidden(true);
      } else {
        setError(message);
        if (message.includes('登录') || message.includes('失效')) onUnauthorized();
      }
    } finally {
      setLoading(false);
    }
  }, [filter, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, decision: 'approved' | 'rejected'): Promise<void> => {
    setDeciding(id);
    try {
      await decideApproval(id, decision);
      toast.push(decision === 'approved' ? '已批准' : '已驳回', 'success');
      await load();
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="page">
      <PageHead
        title="审批中心"
        subtitle="处理敏感工具的人工确认工单。"
        description="批准后，等待中的工具调用继续执行。"
        actions={
          <>
            <Segmented items={FILTERS} value={filter} onChange={setFilter} />
            <button type="button" className="btn btn-ghost" onClick={() => void load()}>
              <RefreshCw className="size-4" />刷新
            </button>
          </>
        }
      />

      {forbidden ? <ForbiddenNotice /> : null}
      {error ? (
        <p className="inline-error border-destructive/30 bg-destructive/5 text-destructive mb-4 rounded-lg border px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}
      {loading ? <Loading text="审批列表加载中…" /> : null}

      {!loading && !forbidden && !error ? (
        items.length === 0 ? (
          <EmptyState text="暂无审批工单" hint="当 Agent 调用需要人工确认的工具时，工单会出现在这里。" />
        ) : (
          <div className="approval-list grid gap-3 lg:grid-cols-2">
            {items.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                identity={identity}
                busy={deciding === approval.id}
                onDecide={(id, decision) => void decide(id, decision)}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
