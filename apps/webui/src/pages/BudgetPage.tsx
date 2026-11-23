/**
 * 预算看板 —— 平台用量与租户预算水位。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage, fetchBudget } from '../api';
import type { BudgetSummary } from '../types';
import { formatNumber, formatTokens, formatUsd } from '../format';
import { EmptyState, ErrorNotice, Loading, PageHead, Panel, UsageBar } from '../components/ui';

export function BudgetPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [data, setData] = useState<BudgetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchBudget());
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      if (message.includes('登录') || message.includes('失效')) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <PageHead
        title="预算看板"
        subtitle={data ? `${data.month} 月度用量与租户预算水位` : '月度用量与租户预算水位'}
        description="跟踪请求、Token、费用与预算水位。"
        actions={
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            <RefreshCw className="size-4" />刷新
          </button>
        }
      />

      {loading ? <Loading text="预算数据加载中…" /> : null}
      {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}

      {!loading && !error && data ? (
        <>
          <div className="stat-row mb">
            <div className="stat-card">
              <span className="stat-label">本月请求数</span>
              <span className="stat-value">{formatNumber(data.platform.requests)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">输入 Token</span>
              <span className="stat-value">{formatTokens(data.platform.promptTokens)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">输出 Token</span>
              <span className="stat-value">{formatTokens(data.platform.completionTokens)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">预估成本</span>
              <span className="stat-value">{formatUsd(data.platform.costUsd)}</span>
            </div>
          </div>

          <Panel title="租户预算">
            {data.tenants.length === 0 ? (
              <EmptyState text="暂无租户预算数据" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>租户</th>
                      <th>名称</th>
                      <th>月度预算</th>
                      <th>已用成本</th>
                      <th>已用 Token</th>
                      <th>请求数</th>
                      <th>使用率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tenants.map((tenant) => (
                      <tr key={tenant.tenantId}>
                        <td>
                          <code className="code-name">{tenant.tenantId}</code>
                        </td>
                        <td>{tenant.name}</td>
                        <td>{formatUsd(tenant.budgetUsd)}</td>
                        <td>{formatUsd(tenant.usedUsd)}</td>
                        <td>
                          {formatTokens(tenant.usedTokens)}
                          <span className="td-sub"> / {formatTokens(tenant.tokenBudget)}</span>
                        </td>
                        <td>{formatNumber(tenant.requests)}</td>
                        <td className="td-usage">
                          <UsageBar ratio={tenant.ratio} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
