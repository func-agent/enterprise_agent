import { useMemo, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { AgentModel, ProviderCredential, ProviderOption, ProviderTarget } from '../types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

const FIELD_CLASS =
  'border-border bg-background focus-visible:border-primary w-full min-w-0 rounded-md border px-2.5 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60';

export function emptyModel(provider = ''): AgentModel {
  return {
    name: '', description: '', scenarios: [], enabled: true,
    targets: [{ provider, model: '', role: 'primary', weight: 100 }],
  };
}

export function ModelEditor({
  initial,
  creating,
  isDefault,
  providers,
  credentials,
  saving,
  onCancel,
  onSave,
}: {
  initial: AgentModel;
  creating: boolean;
  isDefault: boolean;
  providers: ProviderOption[];
  credentials: ProviderCredential[];
  saving: boolean;
  onCancel: () => void;
  onSave: (model: AgentModel) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentModel>(() => ({
    ...initial,
    scenarios: [...initial.scenarios],
    targets: initial.targets.map((target) => ({ ...target })),
  }));
  const [scenarios, setScenarios] = useState(initial.scenarios.join('，'));
  const [error, setError] = useState<string | null>(null);
  const providerOptions = useMemo(() => {
    const map = new Map(providers.map((provider) => [provider.name, provider]));
    for (const target of draft.targets) {
      if (!map.has(target.provider)) {
        map.set(target.provider, { name: target.provider, protocol: '未注册', baseUrl: '', accounts: [], enabled: false, source: 'console' });
      }
    }
    return [...map.values()];
  }, [providers, draft.targets]);
  const primaryWeight = draft.targets
    .filter((target) => target.role === 'primary')
    .reduce((sum, target) => sum + (target.weight ?? 1), 0);

  const updateTarget = (index: number, patch: Partial<ProviderTarget>): void => {
    setDraft((current) => ({
      ...current,
      targets: current.targets.map((target, position) =>
        position === index ? { ...target, ...patch } : target,
      ),
    }));
  };

  const moveTarget = (index: number, offset: -1 | 1): void => {
    setDraft((current) => {
      const targets = [...current.targets];
      const destination = index + offset;
      if (destination < 0 || destination >= targets.length) return current;
      [targets[index], targets[destination]] = [targets[destination], targets[index]];
      return { ...current, targets };
    });
  };

  const addTarget = (): void => {
    const provider = providers.find((item) => item.protocol !== 'tei')?.name ?? providers[0]?.name ?? '';
    const primary = !draft.targets.some((target) => target.role === 'primary');
    setDraft((current) => ({
      ...current,
      targets: [...current.targets, { provider, model: '', role: primary ? 'primary' : 'fallback', ...(primary ? { weight: 100 } : {}) }],
    }));
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const name = draft.name.trim();
    if (!name) {
      setError('请填写虚拟模型名');
      return;
    }
    if (draft.targets.some((target) => !target.provider.trim() || !target.model.trim())) {
      setError('每个路由目标都必须填写 Provider 和真实模型名');
      return;
    }
    const model: AgentModel = {
      ...draft,
      name,
      description: draft.description.trim(),
      enabled: isDefault || draft.enabled,
      scenarios: scenarios.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      targets: draft.targets.map((target) => ({
        ...target,
        provider: target.provider.trim(),
        model: target.model.trim(),
        account: target.account || undefined,
        weight: target.role === 'primary' ? target.weight : undefined,
      })),
    };
    try {
      await onSave(model);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl" showCloseButton={!saving}>
        <DialogHeader className="border-border shrink-0 border-b px-6 py-4">
          <DialogTitle>{creating ? '新增虚拟模型' : `编辑 ${initial.name}`}</DialogTitle>
          <DialogDescription>
            业务使用虚拟模型名；主用目标按权重分流，失败后按列表继续尝试，备用目标按顺序兜底。
          </DialogDescription>
        </DialogHeader>
        <form id="model-editor" className="min-h-0 flex-1 overflow-y-auto px-6 py-5" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium">虚拟模型名 <span className="text-destructive">*</span></span>
              <input
                className={`${FIELD_CLASS} font-mono`}
                value={draft.name}
                disabled={!creating || saving}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="例如 customer-service-model"
                maxLength={63}
                required
              />
              <span className="text-muted-foreground mt-1 block text-xs">小写字母开头，可含数字、点、下划线和连字符；创建后不可修改。</span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium">适用场景</span>
              <input className={FIELD_CLASS} value={scenarios} disabled={saving} onChange={(event) => setScenarios(event.target.value)} placeholder="日常对话，工具调用" />
              <span className="text-muted-foreground mt-1 block text-xs">使用逗号分隔，最多 10 项。</span>
            </label>
          </div>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-medium">模型描述</span>
            <textarea className={`${FIELD_CLASS} min-h-16 resize-y`} value={draft.description} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} maxLength={300} placeholder="说明用途、默认 Provider 和降级策略" />
          </label>
          <label className={`mt-3 flex items-center gap-2 text-sm ${isDefault ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
            <input type="checkbox" className="accent-primary size-4" checked={isDefault || draft.enabled} disabled={saving || isDefault} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
            {isDefault ? '系统缺省模型必须保持启用' : '保存后立即启用'}
          </label>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">路由目标</h3>
              <p className="text-muted-foreground mt-1 text-xs">主用权重为相对值，无需凑满 100；未填按 1 计算。备用目标不使用权重。</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving || draft.targets.length >= 20} onClick={addTarget}>
              <Plus className="size-3.5" /> 添加目标
            </button>
          </div>
          <div className="border-border mt-3 overflow-x-auto rounded-lg border">
            <div className="min-w-[960px]">
              <div className="bg-muted/60 text-muted-foreground grid grid-cols-[minmax(140px,1fr)_minmax(180px,1.3fr)_110px_100px_80px_100px_94px] gap-2 px-3 py-2 text-xs font-medium">
                <span>Provider</span><span>真实模型名</span><span>账号</span><span>角色</span><span>权重</span><span>输出上限</span><span>操作</span>
              </div>
              {draft.targets.map((target, index) => {
                const provider = providerOptions.find((item) => item.name === target.provider);
                const accounts = [...new Set([...(provider?.accounts ?? []), ...(target.account ? [target.account] : [])])];
                const credential = credentials.find((item) => item.provider === target.provider);
                return (
                  <div key={index} className="border-border grid grid-cols-[minmax(140px,1fr)_minmax(180px,1.3fr)_110px_100px_80px_100px_94px] items-center gap-2 border-t px-3 py-2.5">
                    <div>
                      <select
                        aria-label={`目标 ${index + 1} 的 Provider`}
                        className={FIELD_CLASS}
                        value={target.provider}
                        disabled={saving}
                        onChange={(event) => updateTarget(index, { provider: event.target.value, account: undefined })}
                      >
                        <option value="">选择 Provider</option>
                        {providerOptions.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.protocol}{item.enabled ? '' : ' · 已停用'}</option>)}
                      </select>
                      {credential && !credential.configured && provider?.protocol !== 'tei' ? <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-400">尚未配置密钥</span> : null}
                    </div>
                    <input aria-label={`目标 ${index + 1} 的真实模型名`} className={`${FIELD_CLASS} font-mono text-xs`} value={target.model} disabled={saving} onChange={(event) => updateTarget(index, { model: event.target.value })} placeholder="例如 MiniMax-M3" required />
                    <select aria-label={`目标 ${index + 1} 的账号`} className={FIELD_CLASS} value={target.account ?? ''} disabled={saving} onChange={(event) => updateTarget(index, { account: event.target.value || undefined })}>
                      <option value="">默认账号</option>
                      {accounts.filter((account) => account !== 'default').map((account) => <option key={account} value={account}>{account}{provider?.accounts.includes(account) ? '' : '（未配置）'}</option>)}
                    </select>
                    <select aria-label={`目标 ${index + 1} 的角色`} className={FIELD_CLASS} value={target.role} disabled={saving} onChange={(event) => updateTarget(index, { role: event.target.value as ProviderTarget['role'], weight: event.target.value === 'primary' ? (target.weight ?? 100) : undefined })}>
                      <option value="primary">主用</option><option value="fallback">备用</option>
                    </select>
                    <input aria-label={`目标 ${index + 1} 的权重`} className={FIELD_CLASS} type="number" min={0} max={1000000} step={1} value={target.weight ?? ''} disabled={saving || target.role !== 'primary'} onChange={(event) => updateTarget(index, { weight: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="1" />
                    <input aria-label={`目标 ${index + 1} 的输出上限`} className={FIELD_CLASS} type="number" min={1} max={65536} step={1} value={target.maxTokens ?? ''} disabled={saving} onChange={(event) => updateTarget(index, { maxTokens: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="默认" />
                    <div className="flex items-center gap-0.5">
                      <button type="button" className="btn btn-ghost size-7 px-0" title="上移" aria-label={`上移目标 ${index + 1}`} disabled={saving || index === 0} onClick={() => moveTarget(index, -1)}><ArrowUp className="size-3.5" /></button>
                      <button type="button" className="btn btn-ghost size-7 px-0" title="下移" aria-label={`下移目标 ${index + 1}`} disabled={saving || index === draft.targets.length - 1} onClick={() => moveTarget(index, 1)}><ArrowDown className="size-3.5" /></button>
                      <button type="button" className="btn btn-ghost text-destructive size-7 px-0" title="移除目标" aria-label={`移除目标 ${index + 1}`} disabled={saving || draft.targets.length === 1} onClick={() => setDraft((current) => ({ ...current, targets: current.targets.filter((_, position) => position !== index) }))}><Trash2 className="size-3.5" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="text-muted-foreground mt-2 flex flex-wrap justify-between gap-2 text-xs">
            <span>共 {draft.targets.length} 个目标，{draft.targets.filter((target) => target.role === 'primary').length} 个主用，{draft.targets.filter((target) => target.role === 'fallback').length} 个备用。</span>
            <span>主用权重合计 {primaryWeight}</span>
          </div>
          {error ? <div className="inline-error mt-4 mb-0" role="alert">{error}</div> : null}
        </form>
        <DialogFooter className="border-border shrink-0 border-t px-6 py-4">
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={onCancel}>取消</button>
          <button type="submit" form="model-editor" className="btn btn-primary" disabled={saving}>{saving ? '保存中…' : creating ? '创建模型' : '保存修改'}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
