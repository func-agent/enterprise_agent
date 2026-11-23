import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, PlugZap, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import {
  ApiError,
  createModelConfig,
  deleteModelConfig,
  errorMessage,
  listModelConfigs,
  listModels,
  listProviderCredentials,
  setModelEnabled,
  updateModelConfig,
} from '../api';
import type { AgentModel, Identity, ProviderCredential, ProviderOption, ProviderTarget } from '../types';
import { Badge, EmptyState, ErrorNotice, Loading, PageHead } from '../components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { emptyModel, ModelEditor } from '../components/ModelEditor';
import { useToast } from '../components/Toast';
import { canViewAdminPages } from '../permissions';

export function ModelsPage({
  identity,
  onUnauthorized,
  onOpenProviders,
}: {
  identity: Identity;
  onUnauthorized: () => void;
  onOpenProviders: () => void;
}) {
  const toast = useToast();
  const [models, setModels] = useState<AgentModel[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ model: AgentModel; creating: boolean } | null>(null);
  const [deleting, setDeleting] = useState<AgentModel | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [credError, setCredError] = useState<string | null>(null);
  const isAdmin = useMemo(() => canViewAdminPages(identity), [identity]);

  const handleActionError = useCallback((err: unknown): void => {
    setActionError(errorMessage(err));
    if (err instanceof ApiError && err.status === 401) onUnauthorized();
  }, [onUnauthorized]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      if (isAdmin) {
        const payload = await listModelConfigs();
        setModels(payload.data);
        setProviders(payload.providers);
        setDefaultModel(payload.defaultModel);
      } else {
        const list = await listModels();
        setModels(list.map((model) => ({
          name: model.id,
          description: model.description ?? '',
          scenarios: model.scenarios ?? [],
          targets: model.targets,
          enabled: true,
        })));
        setProviders([]);
        setDefaultModel('');
      }
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [isAdmin, onUnauthorized]);

  const loadCredentials = useCallback(async (): Promise<void> => {
    setCredError(null);
    if (!isAdmin) {
      setCredentials([]);
      return;
    }
    try {
      const payload = await listProviderCredentials();
      setCredentials(payload.data ?? []);
    } catch (err) {
      setCredError(errorMessage(err));
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
    }
  }, [isAdmin, onUnauthorized]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCredentials(); }, [loadCredentials]);

  const saveModel = async (model: AgentModel): Promise<void> => {
    setBusy('save');
    setActionError(null);
    try {
      if (editor?.creating) await createModelConfig(model);
      else await updateModelConfig(model);
      setEditor(null);
      toast.push(`模型 ${model.name} 已保存，后续请求立即使用新配置`, 'success');
      await load();
    } catch (err) {
      handleActionError(err);
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (model: AgentModel): Promise<void> => {
    setBusy(model.name);
    setActionError(null);
    try {
      await setModelEnabled(model.name, !model.enabled);
      toast.push(`模型 ${model.name} 已${model.enabled ? '禁用' : '启用'}`, 'success');
      await load();
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const removeModel = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(deleting.name);
    setActionError(null);
    try {
      await deleteModelConfig(deleting.name);
      toast.push(`模型 ${deleting.name} 已删除`, 'success');
      setDeleting(null);
      await load();
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const summary = useMemo(() => ({
    total: models.length,
    enabled: models.filter((model) => model.enabled).length,
    targets: models.reduce((sum, model) => sum + model.targets.length, 0),
    failover: models.filter((model) => model.targets.some((target) => target.role === 'fallback')).length,
  }), [models]);
  const weightText = (model: AgentModel, target: ProviderTarget): string | null => {
    if (target.role !== 'primary') return null;
    const primary = model.targets.filter((item) => item.role === 'primary');
    if (!primary.some((item) => item.weight !== undefined)) return null;
    const total = primary.reduce((sum, item) => sum + (item.weight ?? 1), 0);
    const weight = target.weight ?? 1;
    const percentage = total > 0 ? Math.round(weight / total * 1000) / 10 : 0;
    return `权重 ${weight} · ${percentage}%`;
  };

  return (
    <div className="page">
      <PageHead
        title="模型与路由"
        subtitle="配置虚拟模型、流量权重与备用链。"
        description={<>系统缺省 <code className="code-name">{defaultModel || '加载中…'}</code>；可在工作台按会话切换。</>}
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={onOpenProviders}><PlugZap className="size-4" />管理厂商凭证</button>
            <button type="button" className="btn btn-ghost" onClick={() => { void load(); void loadCredentials(); }}><RefreshCw className="size-4" />刷新</button>
            {isAdmin ? <button type="button" className="btn btn-primary" onClick={() => { setActionError(null); setEditor({ model: emptyModel(providers.find((provider) => provider.protocol !== 'tei')?.name), creating: true }); }}><Plus className="size-4" />新增模型</button> : null}
          </>
        }
      />

      {loading ? <Loading text="模型列表加载中…" /> : null}
      {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}
      {actionError ? <div className="mb-4"><ErrorNotice title="操作失败" message={actionError} /></div> : null}
      {credError ? <div className="mb-4"><ErrorNotice title="厂商账号信息加载失败" message={credError} onRetry={() => void loadCredentials()} /></div> : null}

      {!loading && !error ? (
        <>
          <div className="stat-row mb">
            <div className="stat-card"><span className="stat-label">虚拟模型</span><span className="stat-value">{summary.total}</span></div>
            <div className="stat-card"><span className="stat-label">已启用</span><span className="stat-value">{summary.enabled}</span></div>
            <div className="stat-card"><span className="stat-label">真实模型目标</span><span className="stat-value">{summary.targets}</span></div>
            <div className="stat-card"><span className="stat-label">含备用链</span><span className="stat-value">{summary.failover}</span></div>
          </div>

          {models.length === 0 ? (
            <EmptyState text="暂无虚拟模型" hint={isAdmin ? '点击右上角「新增模型」创建第一条路由。' : '请联系管理员配置虚拟模型。'} />
          ) : (
            <div className="model-list">
              {models.map((model) => {
                const open = expanded === model.name;
                const isDefault = model.name === defaultModel;
                return (
                  <article key={model.name} className={`model-card ${open ? 'model-card-open' : ''}`}>
                    <div className="model-head">
                      <button type="button" className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-3 text-left" onClick={() => setExpanded(open ? null : model.name)} aria-expanded={open}>
                        {open ? <ChevronDown className="text-muted-foreground size-4 shrink-0" /> : <ChevronRight className="text-muted-foreground size-4 shrink-0" />}
                        <span className="model-name">{model.name}</span>
                        {isDefault ? <Badge tone="primary">系统缺省</Badge> : null}
                        <Badge tone={model.enabled ? 'success' : 'warning'}>{model.enabled ? '已启用' : '已禁用'}</Badge>
                        <span className="model-desc">{model.description}</span>
                        <span className="model-count">{model.targets.length} 个目标</span>
                      </button>
                      {isAdmin ? (
                        <div className="ml-auto flex shrink-0 items-center gap-1">
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => { setActionError(null); setEditor({ model, creating: false }); }}><Pencil className="size-3.5" />编辑</button>
                          <button type="button" className="btn btn-ghost btn-sm" title={isDefault && model.enabled ? '系统缺省模型不能禁用' : undefined} disabled={busy !== null || (isDefault && model.enabled)} onClick={() => void toggleEnabled(model)}><Power className="size-3.5" />{busy === model.name ? '处理中' : model.enabled ? '禁用' : '启用'}</button>
                          <button type="button" className="btn btn-ghost btn-sm text-destructive" title={isDefault ? '系统缺省模型不能删除' : '删除模型'} aria-label={`删除 ${model.name}`} disabled={busy !== null || isDefault} onClick={() => { setActionError(null); setDeleting(model); }}><Trash2 className="size-3.5" />删除</button>
                        </div>
                      ) : null}
                    </div>
                    {open ? (
                      <div className="model-body">
                        {model.scenarios.length > 0 ? <div className="model-scenarios"><span className="model-label">适用场景</span>{model.scenarios.map((scenario) => <span key={scenario} className="chip">{scenario}</span>)}</div> : null}
                        <div className="failover">
                          <span className="model-label">路由链（主用按权重分配，备用按顺序尝试）</span>
                          <ol className="failover-list">
                            {model.targets.map((target, index) => (
                              <li key={`${target.provider}-${target.model}-${target.account ?? 'default'}-${index}`} className="failover-item">
                                <span className="failover-index">{index + 1}</span>
                                <span className="failover-provider">{target.provider}</span>
                                <code className="failover-model">{target.model}</code>
                                <Badge tone={target.role === 'primary' ? 'primary' : 'neutral'}>{target.role === 'primary' ? '主用' : '备用'}</Badge>
                                {target.account ? <span className="text-muted-foreground text-xs">账号 {target.account}</span> : null}
                                {target.maxTokens ? <span className="text-muted-foreground text-xs">输出 ≤ {target.maxTokens}</span> : null}
                                {weightText(model, target) ? <span className="failover-weight">{weightText(model, target)}</span> : null}
                              </li>
                            ))}
                          </ol>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      {editor ? <ModelEditor key={`${editor.creating ? 'new' : editor.model.name}`} initial={editor.model} creating={editor.creating} isDefault={!editor.creating && editor.model.name === defaultModel} providers={providers} credentials={credentials} saving={busy === 'save'} onCancel={() => setEditor(null)} onSave={saveModel} /> : null}

      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && busy === null) setDeleting(null); }}>
        <DialogContent showCloseButton={busy === null}>
          <DialogHeader>
            <DialogTitle>删除虚拟模型</DialogTitle>
            <DialogDescription>确定删除 <code className="code-name">{deleting?.name}</code> 吗？删除后，使用该模型的请求会立即失败。仍被租户白名单引用时网关会拒绝删除。</DialogDescription>
          </DialogHeader>
          {actionError ? <div className="inline-error mb-0" role="alert">{actionError}</div> : null}
          <DialogFooter>
            <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setDeleting(null)}>取消</button>
            <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void removeModel()}>{busy ? '删除中…' : '确认删除'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
