import { useState, type FormEvent } from 'react';
import type { ManagedTenant, ManagedUser, ManagedUserInput } from '../types';
import { ROLES, SENSITIVITIES } from '../types';
import { roleLabel, sensitivityLabel } from '../format';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

const FIELD_CLASS =
  'border-border bg-background focus-visible:border-primary w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60';

export function UserEditor({
  initial,
  currentUserId,
  tenants,
  saving,
  onCancel,
  onSave,
}: {
  initial: ManagedUser | null;
  currentUserId: string;
  tenants: ManagedTenant[];
  saving: boolean;
  onCancel: () => void;
  onSave: (input: ManagedUserInput) => Promise<void>;
}) {
  const editing = initial !== null;
  const self = initial?.id === currentUserId;
  const [draft, setDraft] = useState<ManagedUserInput>(() => ({
    username: initial?.username ?? '',
    email: initial?.email ?? '',
    firstName: initial?.firstName ?? '',
    lastName: initial?.lastName ?? '',
    role: initial?.role ?? 'employee',
    tenantId: initial?.tenantId ?? tenants.find((tenant) => tenant.enabled)?.id ?? 't-default',
    deptId: initial?.deptId ?? 'dept-general',
    sensitivity: initial?.sensitivity ?? 'internal',
  }));
  const [error, setError] = useState<string | null>(null);
  const tenantOptions = [...tenants];
  if (initial && !tenantOptions.some((tenant) => tenant.id === initial.tenantId)) {
    tenantOptions.push({ id: initial.tenantId, name: initial.tenantId, enabled: true });
  }

  const update = (patch: Partial<ManagedUserInput>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      await onSave({
        ...draft,
        username: draft.username.trim(),
        email: draft.email.trim(),
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        tenantId: draft.tenantId.trim(),
        deptId: draft.deptId.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{editing ? `编辑 ${initial.username}` : '新增用户'}</DialogTitle>
          <DialogDescription>
            {editing ? '属性保存到 Keycloak，并尝试注销该用户的现有会话。' : '创建后生成一次性随机密码，请立即复制并安全交付。'}
          </DialogDescription>
        </DialogHeader>
        <form id="user-editor" className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium">用户名</span>
            <input className={`${FIELD_CLASS} font-mono`} value={draft.username} disabled={editing || saving} onChange={(event) => update({ username: event.target.value })} placeholder="例如 zhangsan" aria-label="用户名" autoComplete="off" required />
            <span className="text-muted-foreground mt-1 block text-xs">小写字母开头，可含数字、点、下划线和连字符；创建后不可修改。</span>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium">邮箱</span>
            <input className={FIELD_CLASS} type="email" value={draft.email} disabled={saving} onChange={(event) => update({ email: event.target.value })} placeholder="zhangsan@example.com" aria-label="邮箱" autoComplete="off" required />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">姓氏</span>
            <input className={FIELD_CLASS} value={draft.lastName} disabled={saving} onChange={(event) => update({ lastName: event.target.value })} placeholder="张" aria-label="姓氏" maxLength={80} required />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">名字</span>
            <input className={FIELD_CLASS} value={draft.firstName} disabled={saving} onChange={(event) => update({ firstName: event.target.value })} placeholder="三" aria-label="名字" maxLength={80} required />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">平台角色</span>
            <select aria-label="平台角色" className={FIELD_CLASS} value={draft.role} disabled={saving || self} onChange={(event) => update({ role: event.target.value })}>
              {ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">数据密级</span>
            <select aria-label="数据密级" className={FIELD_CLASS} value={draft.sensitivity} disabled={saving} onChange={(event) => update({ sensitivity: event.target.value })}>
              {SENSITIVITIES.map((level) => <option key={level} value={level}>{sensitivityLabel(level)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">租户</span>
            <select aria-label="租户" className={FIELD_CLASS} value={draft.tenantId} disabled={saving || self} onChange={(event) => update({ tenantId: event.target.value })}>
              {tenantOptions.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}（{tenant.id}）</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">部门 ID</span>
            <input className={`${FIELD_CLASS} font-mono`} value={draft.deptId} disabled={saving} onChange={(event) => update({ deptId: event.target.value })} placeholder="dept-general" aria-label="部门 ID" required />
          </label>
          {self ? <p className="text-muted-foreground text-xs sm:col-span-2">当前登录账号不能修改自己的角色或租户。</p> : null}
          {draft.sensitivity === 'confidential' ? <p className="text-xs text-amber-600 dark:text-amber-400 sm:col-span-2">机密身份禁止通过商业模型出网，请确认该用户的使用场景。</p> : null}
          {error ? <div className="inline-error mb-0 sm:col-span-2" role="alert">{error}</div> : null}
        </form>
        <DialogFooter>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={onCancel}>取消</button>
          <button type="submit" form="user-editor" className="btn btn-primary" disabled={saving}>{saving ? '保存中…' : editing ? '保存修改' : '创建用户'}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
