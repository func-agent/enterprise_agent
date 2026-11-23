import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Pencil, Plus, Power, RefreshCw, Search, Trash2 } from 'lucide-react';
import {
  ApiError,
  createManagedUser,
  deleteManagedUser,
  errorMessage,
  listManagedTenants,
  listManagedUsers,
  resetManagedUserPassword,
  setManagedUserEnabled,
  updateManagedUser,
} from '../api';
import type { Identity, ManagedTenant, ManagedUser, ManagedUserInput } from '../types';
import { Badge, EmptyState, ErrorNotice, Loading, PageHead, Panel } from '../components/ui';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { UserEditor } from '../components/UserEditor';
import { useToast } from '../components/Toast';
import { roleLabel, sensitivityLabel } from '../format';

export function UsersPage({ identity, onUnauthorized }: { identity: Identity; onUnauthorized: () => void }) {
  const toast = useToast();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [tenants, setTenants] = useState<ManagedTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ user: ManagedUser | null } | null>(null);
  const [confirming, setConfirming] = useState<{ action: 'reset' | 'delete'; user: ManagedUser } | null>(null);
  const [password, setPassword] = useState<{ username: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [userList, tenantList] = await Promise.all([listManagedUsers(), listManagedTenants()]);
      setUsers(userList);
      setTenants(tenantList);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => { void load(); }, [load]);

  const handleActionError = useCallback((err: unknown): void => {
    setActionError(errorMessage(err));
    if (err instanceof ApiError && err.status === 401) onUnauthorized();
  }, [onUnauthorized]);

  const saveUser = async (input: ManagedUserInput): Promise<void> => {
    if (!editor) return;
    setBusy('save');
    setActionError(null);
    try {
      const target = editor.user;
      const creating = target === null;
      const result = creating
        ? await createManagedUser(input)
        : await updateManagedUser(target.id, {
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
            role: input.role,
            tenantId: input.tenantId,
            deptId: input.deptId,
            sensitivity: input.sensitivity,
          });
      if (result.password) setPassword({ username: result.user.username, value: result.password });
      setEditor(null);
      toast.push(creating ? `用户 ${result.user.username} 已创建` : `用户 ${result.user.username} 已更新${result.sessionRevoked ? '，现有会话已注销' : '，请重新登录后生效'}`, 'success');
      await load();
    } catch (err) {
      handleActionError(err);
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (user: ManagedUser): Promise<void> => {
    setBusy(user.id);
    setActionError(null);
    try {
      const result = await setManagedUserEnabled(user.id, !user.enabled);
      toast.push(`用户 ${user.username} 已${user.enabled ? '停用' : '启用'}${result.sessionRevoked ? '，现有会话已注销' : ''}`, 'success');
      await load();
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const runConfirmedAction = async (): Promise<void> => {
    if (!confirming) return;
    const { action, user } = confirming;
    setBusy(user.id);
    setActionError(null);
    try {
      if (action === 'reset') {
        const result = await resetManagedUserPassword(user.id);
        setPassword({ username: user.username, value: result.password });
        toast.push(`用户 ${user.username} 的密码已重置`, 'success');
      } else {
        await deleteManagedUser(user.id);
        toast.push(`用户 ${user.username} 已删除`, 'success');
      }
      setConfirming(null);
      await load();
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const copyPassword = async (): Promise<void> => {
    if (!password) return;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(password.value);
      toast.push('密码已复制', 'success');
    } catch {
      toast.push('浏览器未允许剪贴板访问，请选中密码手动复制', 'warning');
    }
  };

  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return users;
    return users.filter((user) => [
      user.username, user.email, user.firstName, user.lastName,
      user.role, user.tenantId, user.deptId,
    ].some((value) => value.toLowerCase().includes(keyword)));
  }, [query, users]);
  const summary = useMemo(() => ({
    total: users.length,
    enabled: users.filter((user) => user.enabled).length,
    admins: users.filter((user) => user.enabled && user.role === 'platform-admin').length,
    disabled: users.filter((user) => !user.enabled).length,
  }), [users]);

  return (
    <div className="page">
      <PageHead
        title="用户与权限"
        subtitle="管理 enterprise realm 的人员账号。"
        description="属性保存到 Keycloak，修改后用户需重新登录。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" disabled={loading || busy !== null} onClick={() => void load()}><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />刷新</button>
            <button type="button" className="btn btn-primary" disabled={loading || busy !== null} onClick={() => { setActionError(null); setEditor({ user: null }); }}><Plus className="size-4" />新增用户</button>
          </>
        }
      />

      {loading ? <Loading text="用户列表加载中…" /> : null}
      {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}
      {actionError ? <div className="mb-4"><ErrorNotice title="操作失败" message={actionError} /></div> : null}

      {!loading && !error ? (
        <>
          <div className="stat-row mb">
            <div className="stat-card"><span className="stat-label">人员账号</span><span className="stat-value">{summary.total}</span></div>
            <div className="stat-card"><span className="stat-label">已启用</span><span className="stat-value">{summary.enabled}</span></div>
            <div className="stat-card"><span className="stat-label">平台管理员</span><span className="stat-value">{summary.admins}</span></div>
            <div className="stat-card"><span className="stat-label">已停用</span><span className="stat-value">{summary.disabled}</span></div>
          </div>

          <Panel title={`人员账号（${filteredUsers.length}）`}>
            <div className="border-border mb-3 flex items-center gap-2 rounded-md border px-3 py-2">
              <Search className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              <input className="bg-transparent min-w-0 flex-1 text-sm outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户名、邮箱、角色、租户或部门" aria-label="搜索用户" />
            </div>
            {filteredUsers.length === 0 ? (
              <EmptyState text={query ? '没有匹配的用户' : '暂无人员账号'} hint={query ? '请调整搜索条件。' : '点击右上角「新增用户」创建账号。'} />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>用户</th><th>角色</th><th>租户 / 部门</th><th>密级</th><th>状态</th><th className="min-w-64">操作</th></tr></thead>
                  <tbody>
                    {filteredUsers.map((user) => {
                      const self = user.id === identity.user_id;
                      const lastAdmin = summary.admins <= 1 && user.enabled && user.role === 'platform-admin';
                      return (
                        <tr key={user.id} data-user-id={user.id}>
                          <td>
                            <div className="flex items-center gap-2"><span className="font-medium">{user.username}</span>{self ? <Badge tone="primary">当前账号</Badge> : null}</div>
                            <div className="text-muted-foreground mt-1 text-xs">{user.lastName}{user.firstName} · {user.email}</div>
                            <div className="text-muted-foreground mt-1 max-w-40 truncate font-mono text-[11px]" title={user.id}>{user.id}</div>
                          </td>
                          <td><Badge tone={user.role === 'platform-admin' ? 'primary' : 'neutral'}>{roleLabel(user.role)}</Badge></td>
                          <td><code className="text-xs">{user.tenantId}</code><div className="text-muted-foreground mt-1 text-xs">{user.deptId}</div></td>
                          <td><Badge tone={user.sensitivity === 'confidential' ? 'warning' : 'neutral'}>{sensitivityLabel(user.sensitivity)}</Badge></td>
                          <td><Badge tone={user.enabled ? 'success' : 'warning'}>{user.enabled ? '已启用' : '已停用'}</Badge></td>
                          <td>
                            <div className="flex flex-wrap items-center gap-1">
                              <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => { setActionError(null); setEditor({ user }); }}><Pencil className="size-3.5" />编辑</button>
                              <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => { setActionError(null); setConfirming({ action: 'reset', user }); }}><KeyRound className="size-3.5" />重置密码</button>
                              <button type="button" className="btn btn-ghost btn-sm" title={self && user.enabled ? '不能停用当前登录账号' : lastAdmin ? '不能停用最后一个平台管理员' : undefined} disabled={busy !== null || (self && user.enabled) || lastAdmin} onClick={() => void toggleEnabled(user)}><Power className="size-3.5" />{user.enabled ? '停用' : '启用'}</button>
                              <button type="button" className="btn btn-ghost btn-sm text-destructive" title={self ? '不能删除当前登录账号' : lastAdmin ? '不能删除最后一个平台管理员' : '删除用户'} aria-label={`删除用户 ${user.username}`} disabled={busy !== null || self || lastAdmin} onClick={() => { setActionError(null); setConfirming({ action: 'delete', user }); }}><Trash2 className="size-3.5" />删除</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}

      {editor ? <UserEditor key={editor.user?.id ?? 'new'} initial={editor.user} currentUserId={identity.user_id} tenants={tenants} saving={busy === 'save'} onCancel={() => setEditor(null)} onSave={saveUser} /> : null}

      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open && busy === null) setConfirming(null); }}>
        <DialogContent showCloseButton={busy === null}>
          <DialogHeader>
            <DialogTitle>{confirming?.action === 'delete' ? '删除用户' : '重置用户密码'}</DialogTitle>
            <DialogDescription>
              {confirming?.action === 'delete'
                ? `确定删除 ${confirming.user.username} 吗？删除后无法恢复；历史会话与审计保留原 sub，重新创建同名用户也会成为新的身份主体。`
                : `确定重置 ${confirming?.user.username} 的密码吗？将生成一次性随机密码，并注销该用户的现有会话。`}
            </DialogDescription>
          </DialogHeader>
          {actionError ? <div className="inline-error mb-0" role="alert">{actionError}</div> : null}
          <DialogFooter>
            <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setConfirming(null)}>取消</button>
            <button type="button" className={confirming?.action === 'delete' ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy !== null} onClick={() => void runConfirmedAction()}>{busy ? '处理中…' : confirming?.action === 'delete' ? '确认删除' : '确认重置'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={password !== null} onOpenChange={(open) => { if (!open) setPassword(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>请立即保存新密码</DialogTitle>
            <DialogDescription>用户 {password?.username} 的新密码只显示这一次，关闭后无法从平台再次查看。</DialogDescription>
          </DialogHeader>
          <input className="border-border bg-muted rounded-md border px-3 py-2 font-mono text-sm" value={password?.value ?? ''} readOnly aria-label="一次性新密码" onFocus={(event) => event.target.select()} />
          <DialogFooter>
            <button type="button" className="btn btn-ghost" onClick={() => setPassword(null)}>关闭</button>
            <button type="button" className="btn btn-primary" onClick={() => void copyPassword()}>复制密码</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
