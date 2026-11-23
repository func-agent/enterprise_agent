import { useMemo, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Pencil, PlugZap, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import {
  ApiError,
  createProviderDefinition,
  deleteProviderCredential,
  deleteProviderDefinition,
  errorMessage,
  setProviderCredential,
  setProviderEnabled,
  testProviderConnection,
  updateProviderDefinition,
} from '../api';
import type { ProviderCredential, ProviderDefinitionInput, ProviderOption, ProviderTestResult } from '../types';
import { Badge, EmptyState, ErrorNotice, Loading, PageHead } from './ui';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { emptyProvider, ProviderEditor } from './ProviderEditor';
import { useToast } from './Toast';
import { formatDateTime } from '../format';

const FIELD_CLASS =
  'border-border bg-background focus-visible:border-primary w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-60';
const SOURCE_META: Record<ProviderCredential['source'], { label: string; tone: 'primary' | 'neutral' | 'warning' }> = {
  console: { label: '控制台', tone: 'primary' },
  env: { label: '环境变量', tone: 'neutral' },
  'credential-file': { label: 'OAuth 文件', tone: 'neutral' },
  none: { label: '未配置', tone: 'warning' },
};

export function ProviderManager({
  isAdmin,
  providers,
  credentials,
  masterKeyConfigured,
  loading,
  error,
  credentialError,
  onUnauthorized,
  onOpenModels,
  onRetry,
  onProvidersChanged,
  onCredentialsChanged,
}: {
  isAdmin: boolean;
  providers: ProviderOption[];
  credentials: ProviderCredential[];
  masterKeyConfigured: boolean;
  loading: boolean;
  error: string | null;
  credentialError: string | null;
  onUnauthorized: () => void;
  onOpenModels: () => void;
  onRetry: () => Promise<void>;
  onProvidersChanged: () => Promise<void>;
  onCredentialsChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [editor, setEditor] = useState<{ provider: ProviderOption | ProviderDefinitionInput; creating: boolean } | null>(null);
  const [deleting, setDeleting] = useState<ProviderOption | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [credentialBusy, setCredentialBusy] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});

  const cards = useMemo<ProviderOption[]>(() => {
    if (isAdmin) return providers.filter((provider) => provider.protocol !== 'tei');
    const names = [...new Set(credentials.map((credential) => credential.provider))];
    return names.map((name) => ({
      name, protocol: '', baseUrl: '', enabled: true, source: 'env',
      accounts: credentials.filter((credential) => credential.provider === name).map((credential) => credential.account ?? 'default'),
    }));
  }, [isAdmin, providers, credentials]);
  const configuredAccounts = credentials.filter((credential) =>
    credential.configured && cards.some((provider) => provider.name === credential.provider),
  ).length;
  const accountCount = cards.reduce((sum, provider) => sum + Math.max(provider.accounts.length, 1), 0);
  const enabledCount = cards.filter((provider) => provider.enabled).length;

  const handleError = (err: unknown): void => {
    setActionError(errorMessage(err));
    if (err instanceof ApiError && err.status === 401) onUnauthorized();
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await Promise.all([onProvidersChanged(), onCredentialsChanged()]);
    setRefreshing(false);
  };

  const saveProvider = async (input: ProviderDefinitionInput): Promise<void> => {
    setProviderBusy('save');
    setActionError(null);
    try {
      if (editor?.creating) await createProviderDefinition(input);
      else await updateProviderDefinition(input.name, input);
      setEditor(null);
      setExpanded(input.name);
      toast.push(`厂商 ${input.name} 已保存，后续请求立即生效`, 'success');
      await Promise.all([onProvidersChanged(), onCredentialsChanged()]);
    } catch (err) {
      handleError(err);
      throw err;
    } finally {
      setProviderBusy(null);
    }
  };

  const toggleProvider = async (provider: ProviderOption): Promise<void> => {
    setProviderBusy(provider.name);
    setActionError(null);
    try {
      await setProviderEnabled(provider.name, !provider.enabled);
      toast.push(`厂商 ${provider.name} 已${provider.enabled ? '停用' : '启用'}`, 'success');
      await onProvidersChanged();
    } catch (err) {
      handleError(err);
    } finally {
      setProviderBusy(null);
    }
  };

  const removeProvider = async (): Promise<void> => {
    if (!deleting) return;
    setProviderBusy(deleting.name);
    setActionError(null);
    try {
      await deleteProviderDefinition(deleting.name);
      toast.push(`厂商 ${deleting.name} 及其控制台密钥已删除`, 'success');
      setDeleting(null);
      await Promise.all([onProvidersChanged(), onCredentialsChanged()]);
    } catch (err) {
      handleError(err);
    } finally {
      setProviderBusy(null);
    }
  };

  const saveKey = async (provider: string, account: string): Promise<void> => {
    const id = `${provider}#${account}`;
    const apiKey = (drafts[id] ?? '').trim();
    if (!apiKey) return;
    setCredentialBusy(id);
    setActionError(null);
    try {
      await setProviderCredential(provider, apiKey, account);
      setDrafts((current) => ({ ...current, [id]: '' }));
      await onCredentialsChanged();
      toast.push(`${provider}/${account} 密钥已保存`, 'success');
    } catch (err) {
      handleError(err);
    } finally {
      setCredentialBusy(null);
    }
  };

  const removeKey = async (provider: string, account: string): Promise<void> => {
    if (!window.confirm(`确定删除 ${provider}/${account} 的控制台密钥吗？环境变量凭证不受影响。`)) return;
    const id = `${provider}#${account}`;
    setCredentialBusy(id);
    setActionError(null);
    try {
      await deleteProviderCredential(provider, account);
      await onCredentialsChanged();
      toast.push(`${provider}/${account} 控制台密钥已删除`, 'success');
    } catch (err) {
      handleError(err);
    } finally {
      setCredentialBusy(null);
    }
  };

  const test = async (provider: string, account: string): Promise<void> => {
    const id = `${provider}#${account}`;
    setTesting(id);
    setActionError(null);
    try {
      const result = await testProviderConnection(provider, account);
      setTestResults((current) => ({ ...current, [id]: result }));
      toast.push(`${provider}/${account}：${result.message}`, result.ok ? 'success' : 'error');
    } catch (err) {
      handleError(err);
    } finally {
      setTesting(null);
    }
  };

  return (
    <>
      <PageHead
        title="厂商接入与凭证"
        subtitle="接入兼容厂商，按账号管理密钥。"
        description="保存后热生效，可在「模型与路由」绑定目标。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={onOpenModels}><Bot className="size-4" />配置模型路由</button>
            <button type="button" className="btn btn-ghost" disabled={refreshing || loading} onClick={() => void refresh()}><RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />刷新</button>
            {isAdmin ? <button type="button" className="btn btn-primary" disabled={loading || error !== null} onClick={() => { setActionError(null); setEditor({ provider: emptyProvider(), creating: true }); }}><Plus className="size-4" />新增厂商</button> : null}
          </>
        }
      />

      {loading ? <Loading text="厂商与凭证加载中…" /> : null}
      {error ? <ErrorNotice message={error} onRetry={() => void onRetry()} /> : null}

      {!loading && !error ? (
        <>
          <div className="stat-row mb">
            <div className="stat-card"><span className="stat-label">已接入厂商</span><span className="stat-value">{cards.length}</span></div>
            <div className="stat-card"><span className="stat-label">已启用</span><span className="stat-value">{enabledCount}</span></div>
            <div className="stat-card"><span className="stat-label">厂商账号</span><span className="stat-value">{accountCount}</span></div>
            <div className="stat-card"><span className="stat-label">已配密钥</span><span className="stat-value">{configuredAccounts}</span></div>
          </div>

          {!masterKeyConfigured && isAdmin ? <div className="inline-error mb-3">未配置 <code className="code-name">EAP_CREDENTIAL_MASTER_KEY</code>，可以维护厂商连接，但不能保存密钥。请配置主密钥后重启网关。</div> : null}
          {credentialError ? <div className="mb-3"><ErrorNotice message={credentialError} onRetry={() => void onCredentialsChanged()} /></div> : null}
          {actionError ? <div className="mb-3"><ErrorNotice title="操作失败" message={actionError} /></div> : null}

          {cards.length === 0 ? (
            <EmptyState text="暂无厂商" hint={isAdmin ? '点击右上角「新增厂商」创建第一个 Provider。' : '尚未配置厂商凭证。'} />
          ) : (
            <div className="model-list">
              {cards.map((provider) => {
                const custom = provider.source === 'console';
                const accounts = provider.accounts.length ? provider.accounts : ['default'];
                const open = expanded === provider.name;
                const managedByEnv = custom ? undefined : '内置厂商由环境变量管理';
                return (
                  <article key={provider.name} className={`provider-card model-card ${open ? 'model-card-open' : ''}`} data-provider={provider.name}>
                    <div className="model-head">
                      <button type="button" className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-3 text-left" onClick={() => setExpanded(open ? null : provider.name)} aria-expanded={open}>
                        {open ? <ChevronDown className="text-muted-foreground size-4 shrink-0" /> : <ChevronRight className="text-muted-foreground size-4 shrink-0" />}
                        <span className="model-name">{provider.name}</span>
                        <Badge tone={custom ? 'primary' : 'neutral'}>{custom ? '自定义' : '内置'}</Badge>
                        <Badge tone={provider.enabled ? 'success' : 'warning'}>{provider.enabled ? '已启用' : '已停用'}</Badge>
                        <span className="model-desc">{provider.protocol}{provider.authMode ? ` · ${provider.authMode}` : ''}{custom ? '' : ' · 环境变量管理'}</span>
                        <span className="model-count">{accounts.length} 个账号</span>
                      </button>
                      {isAdmin ? (
                        <div className="ml-auto flex shrink-0 items-center gap-1">
                          <button type="button" className="btn btn-ghost btn-sm" title={managedByEnv} disabled={!custom || providerBusy !== null} onClick={() => { setActionError(null); setEditor({ provider, creating: false }); }}><Pencil className="size-3.5" />编辑</button>
                          <button type="button" className="btn btn-ghost btn-sm" title={managedByEnv} disabled={!custom || providerBusy !== null} onClick={() => void toggleProvider(provider)}><Power className="size-3.5" />{providerBusy === provider.name ? '处理中' : provider.enabled ? '停用' : '启用'}</button>
                          <button type="button" className="btn btn-ghost btn-sm text-destructive" title={managedByEnv ? '内置厂商由环境变量管理，不能删除' : '删除厂商'} aria-label={`删除厂商 ${provider.name}`} disabled={!custom || providerBusy !== null} onClick={() => { setActionError(null); setDeleting(provider); }}><Trash2 className="size-3.5" />删除</button>
                        </div>
                      ) : null}
                    </div>
                    {open ? (
                      <div className="model-body">
                        <div className="model-scenarios">
                          <span className="model-label">Base URL</span>
                          <code className="failover-model break-all">{provider.baseUrl || '由环境变量管理'}</code>
                          {provider.updatedAt ? <span className="text-muted-foreground ml-auto text-xs">更新于 {formatDateTime(provider.updatedAt)} · {provider.updatedBy}</span> : null}
                        </div>
                        <div className="failover">
                          <span className="model-label">账号与凭证</span>
                          <div className="failover-list">
                            {accounts.map((account) => {
                              const id = `${provider.name}#${account}`;
                              const credential = credentials.find((item) => item.provider === provider.name && (item.account ?? 'default') === account);
                              const source = credential?.source ?? 'none';
                              const configured = credential?.configured ?? false;
                              const draft = drafts[id] ?? '';
                              const result = testResults[id];
                              return (
                                <div key={id} className="failover-item block">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <code className="code-name">{account}</code>
                                    <Badge tone={SOURCE_META[source].tone}>{SOURCE_META[source].label}</Badge>
                                    <Badge tone={configured ? 'success' : 'warning'}>{configured ? '密钥可用' : '未配置密钥'}</Badge>
                                    <code>{credential?.masked || '——'}</code>
                                    {credential?.updatedAt ? <span className="text-muted-foreground ml-auto">{formatDateTime(credential.updatedAt)} · {credential.updatedBy}</span> : null}
                                  </div>
                                  {isAdmin ? (
                                    <div className="mt-2 flex flex-col gap-2 xl:flex-row xl:items-center">
                                      <input className={FIELD_CLASS} type="password" autoComplete="new-password" spellCheck={false} value={draft} disabled={!masterKeyConfigured || credentialBusy === id} onChange={(event) => setDrafts((current) => ({ ...current, [id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') void saveKey(provider.name, account); }} placeholder={configured ? '输入新 Key（留空表示不改动）' : '粘贴该账号的 API Key'} aria-label={`${provider.name}/${account} 的 API Key`} />
                                      <div className="flex shrink-0 items-center gap-1">
                                        <button type="button" className="btn btn-primary btn-sm" disabled={!masterKeyConfigured || credentialBusy === id || !draft.trim()} onClick={() => void saveKey(provider.name, account)}>{credentialBusy === id ? '保存中…' : '保存密钥'}</button>
                                        {source === 'console' ? <button type="button" className="btn btn-ghost btn-sm text-destructive" disabled={credentialBusy === id} onClick={() => void removeKey(provider.name, account)}>删除密钥</button> : null}
                                        <button type="button" className="btn btn-ghost btn-sm" disabled={!configured || !provider.enabled || testing === id} onClick={() => void test(provider.name, account)}><PlugZap className="size-3.5" />{testing === id ? '测试中…' : '测试连接'}</button>
                                      </div>
                                    </div>
                                  ) : null}
                                  {result ? <div className={`mt-2 flex flex-wrap items-center gap-2 ${result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`} role="status"><span>{result.message}</span><span>{result.latencyMs} ms</span></div> : null}
                                </div>
                              );
                            })}
                          </div>
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

      {editor ? <ProviderEditor key={`${editor.creating ? 'new' : editor.provider.name}`} initial={editor.provider} creating={editor.creating} saving={providerBusy === 'save'} onCancel={() => setEditor(null)} onSave={saveProvider} /> : null}
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && providerBusy === null) setDeleting(null); }}>
        <DialogContent showCloseButton={providerBusy === null}>
          <DialogHeader>
            <DialogTitle>删除自定义厂商</DialogTitle>
            <DialogDescription>确定删除 <code className="code-name">{deleting?.name}</code> 吗？其所有控制台账号密钥也会删除，环境变量凭证不受影响。仍被虚拟模型引用时网关会拒绝删除。</DialogDescription>
          </DialogHeader>
          {actionError ? <div className="inline-error mb-0" role="alert">{actionError}</div> : null}
          <DialogFooter>
            <button type="button" className="btn btn-ghost" disabled={providerBusy !== null} onClick={() => setDeleting(null)}>取消</button>
            <button type="button" className="btn btn-danger" disabled={providerBusy !== null} onClick={() => void removeProvider()}>{providerBusy ? '删除中…' : '确认删除'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
