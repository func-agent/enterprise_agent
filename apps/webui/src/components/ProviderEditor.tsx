import { useState, type FormEvent } from 'react';
import type { ProviderAuthMode, ProviderDefinitionInput, ProviderOption, ProviderProtocol } from '../types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

const FIELD_CLASS =
  'border-border bg-background focus-visible:border-primary w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-60';

export function emptyProvider(): ProviderDefinitionInput {
  return { name: '', protocol: 'openai', authMode: 'auto', baseUrl: '', accounts: ['default'], enabled: true };
}

export function ProviderEditor({
  initial,
  creating,
  saving,
  onCancel,
  onSave,
}: {
  initial: ProviderOption | ProviderDefinitionInput;
  creating: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (provider: ProviderDefinitionInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProviderDefinitionInput>({
    name: initial.name,
    protocol: initial.protocol as ProviderProtocol,
    authMode: initial.authMode ?? 'auto',
    baseUrl: initial.baseUrl,
    accounts: [...initial.accounts],
    enabled: initial.enabled,
  });
  const [accounts, setAccounts] = useState(initial.accounts.join('，'));
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const next = {
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      accounts: accounts.split(/[,，]/).map((account) => account.trim()).filter(Boolean),
    };
    try {
      await onSave(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <DialogContent showCloseButton={!saving} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{creating ? '新增厂商' : `编辑 ${initial.name}`}</DialogTitle>
          <DialogDescription>接入任意 OpenAI 或 Anthropic 兼容服务，保存后新请求即可使用，无需重启网关。</DialogDescription>
        </DialogHeader>
        <form id="provider-editor" className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium">Provider 标识 <span className="text-destructive">*</span></span>
              <input className={`${FIELD_CLASS} font-mono`} value={draft.name} disabled={!creating || saving} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如 volcengine" maxLength={63} required />
              <span className="text-muted-foreground mt-1 block text-xs">用于路由和审计，创建后不可修改。</span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium">接口协议</span>
              <select aria-label="接口协议" className={FIELD_CLASS} value={draft.protocol} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, protocol: event.target.value as ProviderProtocol }))}>
                <option value="openai">OpenAI Chat Completions</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
              <span className="text-muted-foreground mt-1 block text-xs">其他私有协议仍需开发对应适配器。</span>
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">API Base URL <span className="text-destructive">*</span></span>
            <input className={`${FIELD_CLASS} font-mono`} type="url" value={draft.baseUrl} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" maxLength={500} required />
            <span className="text-muted-foreground mt-1 block text-xs">公网必须使用 HTTPS；HTTP 仅限内网。不能包含账号、密码或查询参数。</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium">认证方式</span>
              <select aria-label="认证方式" className={FIELD_CLASS} value={draft.authMode} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, authMode: event.target.value as ProviderAuthMode }))}>
                <option value="auto">自动（按协议与密钥）</option>
                <option value="bearer">Authorization: Bearer</option>
                <option value="x-api-key">x-api-key</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium">账号池</span>
              <input className={`${FIELD_CLASS} font-mono`} value={accounts} disabled={saving} onChange={(event) => setAccounts(event.target.value)} placeholder="default，acct-2" required />
              <span className="text-muted-foreground mt-1 block text-xs">逗号分隔，必须包含 default，最多 8 个。</span>
            </label>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary size-4" checked={draft.enabled} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
            保存后立即启用
          </label>
          <div className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2.5 text-xs leading-relaxed">
            密钥在保存厂商后按账号分别配置。缩减账号池前必须先移除模型中的账号引用；被移除账号的控制台密钥会一并删除。公网域名还需同步加入部署侧出网白名单。
          </div>
          {error ? <div className="inline-error mb-0" role="alert">{error}</div> : null}
        </form>
        <DialogFooter>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={onCancel}>取消</button>
          <button type="submit" form="provider-editor" className="btn btn-primary" disabled={saving}>{saving ? '保存中…' : creating ? '创建厂商' : '保存修改'}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
