/**
 * 工具目录 —— 按 MCP Server 分组展示工具元数据与治理属性。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage, fetchMcpHealth, listMcpTools } from '../api';
import type { GatewayTool, McpServerHealth } from '../types';
import { Badge, EmptyState, ErrorNotice, Loading, PageHead, Panel } from '../components/ui';
import { sensitivityLabel } from '../format';

export function ToolsPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tools, setTools] = useState<GatewayTool[]>([]);
  const [health, setHealth] = useState<McpServerHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [catalog, servers] = await Promise.all([listMcpTools(), fetchMcpHealth()]);
      setTools(catalog);
      setHealth(servers);
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

  const grouped = useMemo(() => {
    const map = new Map<string, GatewayTool[]>();
    for (const tool of tools) {
      const list = map.get(tool.server_id) ?? [];
      list.push(tool);
      map.set(tool.server_id, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools]);

  const healthById = useMemo(() => {
    const map = new Map<string, McpServerHealth>();
    for (const item of health) map.set(item.serverId, item);
    return map;
  }, [health]);

  return (
    <div className="page">
      <PageHead
        title="工具目录"
        subtitle="查看当前租户可用的 MCP 工具。"
        description="含健康状态、人工确认、数据范围与密级。"
        actions={
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            <RefreshCw className="size-4" />刷新
          </button>
        }
      />

      {loading ? <Loading text="工具目录加载中…" /> : null}
      {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}

      {!loading && !error ? (
        <>
          <Panel title="MCP Server 健康状态" className="mb">
            {health.length === 0 ? (
              <EmptyState text="暂无健康数据" />
            ) : (
              <div className="health-grid">
                {health.map((item) => (
                  <div key={item.serverId} className="health-card">
                    <span className="health-name">{item.serverId}</span>
                    <Badge tone={item.ok ? 'success' : 'error'}>{item.ok ? '正常' : '异常'}</Badge>
                    <span className="health-meta">{item.tools} 个工具</span>
                    {item.error ? <span className="health-error">{item.error}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {grouped.length === 0 ? (
            <EmptyState text="当前租户没有可用工具" hint="请检查租户工具白名单配置。" />
          ) : (
            grouped.map(([serverId, list]) => {
              const serverHealth = healthById.get(serverId);
              return (
                <Panel
                  key={serverId}
                  title={
                    <span className="panel-title-row">
                      <span>{serverId}</span>
                      <Badge tone="primary">{list.length} 个工具</Badge>
                      {serverHealth ? (
                        <Badge tone={serverHealth.ok ? 'success' : 'error'}>
                          {serverHealth.ok ? '服务正常' : '服务异常'}
                        </Badge>
                      ) : null}
                    </span>
                  }
                  className="mb"
                >
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>工具名</th>
                          <th>描述</th>
                          <th>人工确认</th>
                          <th>数据范围</th>
                          <th>密级</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((tool) => (
                          <tr key={tool.name}>
                            <td>
                              <code className="code-name">{tool.name}</code>
                            </td>
                            <td className="td-desc">{tool.description}</td>
                            <td>
                              {tool.requires_confirmation ? (
                                <Badge tone="warning">需确认</Badge>
                              ) : (
                                <Badge tone="neutral">自动执行</Badge>
                              )}
                            </td>
                            <td>{tool.data_scope ?? '—'}</td>
                            <td>
                              <Badge
                                tone={
                                  tool.sensitivity === 'confidential'
                                    ? 'error'
                                    : tool.sensitivity === 'internal'
                                      ? 'warning'
                                      : 'neutral'
                                }
                              >
                                {sensitivityLabel(tool.sensitivity)}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              );
            })
          )}
        </>
      ) : null}
    </div>
  );
}
