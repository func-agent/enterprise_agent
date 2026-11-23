/**
 * 工作台外壳 —— 负责身份态、鉴权模式探测、OIDC 回调处理与工作区导航。
 *
 * 登录流程：
 *   1. 挂载时向网关读取 `GET /v1/auth/config`，得到鉴权模式（oidc / dev）。
 *   2. 若 URL 带授权码（Keycloak 回调），走「换令牌 → 解析身份 → 建立会话」。
 *   3. 否则渲染登录页：OIDC 模式给统一登录入口，开发态模式给身份选择。
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ApiError,
  clearAuth,
  deleteSession,
  errorMessage,
  getAuthConfig,
  getIdToken,
  getRefreshToken,
  getStoredIdentity,
  getToken,
  getTokenExpiresAt,
  isTokenExpired,
  listSessions,
  persistAuth,
  persistIdToken,
  persistRefreshToken,
} from './api';
import type { AuthConfig, Identity, SessionSummary } from './types';
import { ToastProvider, useToast } from './components/Toast';
import { AppSidebar, canAccessTab, TABS, type TabKey } from './components/AppSidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog';
import { LoginPage } from './pages/LoginPage';
import { newSessionId } from './lib/session';
import { endOidcSession, finishOidcLogin, isOidcCallback, refreshOidcToken, type OidcLoginResult } from './oidc';

const ChatPage = lazy(() => import('./pages/ChatPage').then((m) => ({ default: m.ChatPage })));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage').then((m) => ({ default: m.KnowledgePage })));
const ToolsPage = lazy(() => import('./pages/ToolsPage').then((m) => ({ default: m.ToolsPage })));
const UsersPage = lazy(() => import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })));
const ProvidersPage = lazy(() => import('./pages/ProvidersPage').then((m) => ({ default: m.ProvidersPage })));
const ModelsPage = lazy(() => import('./pages/ModelsPage').then((m) => ({ default: m.ModelsPage })));
const BudgetPage = lazy(() => import('./pages/BudgetPage').then((m) => ({ default: m.BudgetPage })));
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));

interface AuthState {
  token: string;
  identity: Identity;
}

/** 从 localStorage 恢复登录态；令牌过期或数据损坏时视为未登录 */
function restoreAuth(): AuthState | null {
  const token = getToken();
  if (!token) return null;
  if (isTokenExpired()) return null;
  const raw = getStoredIdentity();
  if (!raw) {
    clearAuth();
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('identity 格式错误');
    return { token, identity: parsed as Identity };
  } catch {
    clearAuth();
    return null;
  }
}

/** 去掉地址栏里的授权码，避免刷新时重复提交 */
function stripCallbackParams(): void {
  try {
    const url = new URL(window.location.href);
    ['code', 'state', 'session_state', 'iss', 'error', 'error_description'].forEach((k) =>
      url.searchParams.delete(k),
    );
    window.history.replaceState({}, '', url.pathname + url.search);
  } catch {
    /* ignore */
  }
}

function Console() {
  const toast = useToast();
  const [auth, setAuth] = useState<AuthState | null>(restoreAuth);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configNonce, setConfigNonce] = useState(0);
  const [tab, setTab] = useState<TabKey>('chat');
  const [activeSessionId, setActiveSessionId] = useState(newSessionId);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionPendingDeletion, setSessionPendingDeletion] = useState<SessionSummary | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  /** 已访问过的标签页（懒挂载，但保持挂载以保留页面状态） */
  const [visited, setVisited] = useState<Set<TabKey>>(() => new Set<TabKey>(['chat']));
  const draftSessionIdsRef = useRef(new Set<string>([activeSessionId]));
  /** OIDC 回调处理中 —— 避免重复提交授权码 */
  const handlingCallback = useRef(false);
  const refreshInFlight = useRef<Promise<boolean> | null>(null);

  const changeTab = useCallback((next: TabKey): void => {
    if (!auth || !canAccessTab(auth.identity, next)) return;
    setTab(next);
    setVisited((prev) => {
      if (prev.has(next)) return prev;
      const nextSet = new Set(prev);
      nextSet.add(next);
      return nextSet;
    });
  }, [auth]);

  const resetWorkspace = useCallback((): void => {
    const sessionId = newSessionId();
    draftSessionIdsRef.current = new Set([sessionId]);
    setActiveSessionId(sessionId);
    setSessions([]);
    setSessionPendingDeletion(null);
    setDeletingSessionId(null);
    setTab('chat');
    setVisited(new Set<TabKey>(['chat']));
  }, []);

  const createSession = useCallback((): void => {
    const sessionId = newSessionId();
    draftSessionIdsRef.current.add(sessionId);
    setActiveSessionId(sessionId);
    setTab('chat');
  }, []);

  const login = useCallback(
    (token: string, identity: Identity, expiresIn: number, preserveWorkspace = false): void => {
      persistAuth(token, JSON.stringify(identity), expiresIn);
      if (!preserveWorkspace) resetWorkspace();
      setAuth({ token, identity });
      toast.push(`已以 ${identity.username ?? identity.user_id} 身份登录`, 'success');
    },
    [resetWorkspace, toast],
  );

  const applyOidcResult = useCallback((result: OidcLoginResult, preserveWorkspace = false): void => {
    if (result.refreshToken) persistRefreshToken(result.refreshToken);
    if (result.idToken) persistIdToken(result.idToken);
    login(result.token, result.identity, result.expiresIn, preserveWorkspace);
  }, [login]);

  const logout = useCallback((): void => {
    // 先取 id_token —— RP-initiated 登出需要它作 id_token_hint
    const idToken = getIdToken();
    clearAuth();
    resetWorkspace();
    setAuth(null);
    toast.push('已退出登录', 'info');
    // 单点登出：清理 Keycloak 侧会话（失败不阻断本地登出）
    if (config) void endOidcSession(config, window.location.origin, idToken ?? undefined);
  }, [toast, config, resetWorkspace]);

  const refreshSession = useCallback((): Promise<boolean> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const promise = (async () => {
      if (!config) return false;
      const refreshToken = getRefreshToken();
      if (!refreshToken) return false;
      const result = await refreshOidcToken(config, refreshToken);
      if (!result) {
        clearAuth();
        setAuth(null);
        return false;
      }
      applyOidcResult(result, true);
      return true;
    })().finally(() => {
      refreshInFlight.current = null;
    });
    refreshInFlight.current = promise;
    return promise;
  }, [config, applyOidcResult]);

  const onUnauthorized = useCallback((): void => {
    void refreshSession().then((refreshed) => {
      if (refreshed) {
        toast.push('登录状态已续期，请重试刚才的操作', 'success');
        return;
      }
      clearAuth();
      setAuth(null);
      toast.push('登录状态已失效，请重新登录', 'warning');
    });
  }, [refreshSession, toast]);

  const loadSessions = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setSessionsLoading(true);
    try {
      setSessions(await listSessions(signal));
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      toast.push(errorMessage(err), 'error');
    } finally {
      if (!signal?.aborted) setSessionsLoading(false);
    }
  }, [toast, onUnauthorized]);

  const settleSession = useCallback((sessionId: string): void => {
    draftSessionIdsRef.current.delete(sessionId);
    void loadSessions();
  }, [loadSessions]);

  const isDraftSession = useCallback((sessionId: string): boolean => {
    return draftSessionIdsRef.current.has(sessionId);
  }, []);

  const requestSessionRemoval = useCallback((sessionId: string): void => {
    if (deletingSessionId) return;
    const session = sessions.find((item) => item.id === sessionId);
    if (session) setSessionPendingDeletion(session);
  }, [deletingSessionId, sessions]);

  const removeSession = useCallback(async (): Promise<void> => {
    const target = sessionPendingDeletion;
    if (!target || deletingSessionId) return;
    setDeletingSessionId(target.id);
    try {
      await deleteSession(target.id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        toast.push(`删除失败：${errorMessage(err)}`, 'error');
        setDeletingSessionId(null);
        return;
      }
    }
    draftSessionIdsRef.current.delete(target.id);
    setSessions((previous) => previous.filter((session) => session.id !== target.id));
    if (activeSessionId === target.id) createSession();
    setSessionPendingDeletion(null);
    setDeletingSessionId(null);
    toast.push('会话及其消息已删除', 'success');
  }, [activeSessionId, createSession, deletingSessionId, onUnauthorized, sessionPendingDeletion, toast]);

  useEffect(() => {
    if (!auth) return;
    const controller = new AbortController();
    void loadSessions(controller.signal);
    return () => controller.abort();
  }, [auth?.identity.tenant_id, auth?.identity.user_id, loadSessions]);

  /* ---------------- 读取鉴权配置 ---------------- */
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    getAuthConfig(controller.signal)
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setConfigError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setConfigError(err instanceof Error ? err.message : '无法获取鉴权配置');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [configNonce]);

  /* ---------------- 处理 OIDC 回调 ---------------- */
  useEffect(() => {
    if (!config || handlingCallback.current) return;
    if (!isOidcCallback()) return;
    handlingCallback.current = true;
    let cancelled = false;
    finishOidcLogin(config)
      .then((result) => {
        if (cancelled) return;
        stripCallbackParams();
        applyOidcResult(result);
      })
      .catch((err) => {
        if (cancelled) return;
        stripCallbackParams();
        const message = err instanceof Error ? err.message : '统一登录失败';
        setConfigError(message);
        toast.push(message, 'warning');
      });
    return () => {
      cancelled = true;
    };
  }, [config, applyOidcResult, toast]);

  useEffect(() => {
    if (config && !auth && getRefreshToken()) void refreshSession();
  }, [config, auth, refreshSession]);

  useEffect(() => {
    if (!auth || !config || !getRefreshToken()) return;
    const expiresAt = getTokenExpiresAt();
    if (!expiresAt) return;
    const delay = Math.max(0, expiresAt - Date.now() - 60_000);
    const timer = window.setTimeout(() => void refreshSession(), delay);
    return () => window.clearTimeout(timer);
  }, [auth, config, refreshSession]);

  if (!auth) {
    return (
      <LoginPage
        onLogin={login}
        config={config}
        configError={configError}
        onRetryConfig={() => setConfigNonce((n) => n + 1)}
      />
    );
  }

  const activeTab = canAccessTab(auth.identity, tab) ? tab : 'chat';

  // 对话页自带滚动视口（assistant-ui Thread），外层不滚动；其余页签由外层滚动
  const pane = (key: TabKey, node: ReactNode, scroll = true): ReactNode => (
    <div
      className={
        activeTab === key
          ? `h-full min-h-0 flex-1 ${scroll ? 'overflow-y-auto' : 'overflow-hidden'}`
          : 'hidden'
      }
    >
      {node}
    </div>
  );

  const activeTitle = activeTab === 'chat'
    ? sessions.find((session) => session.id === activeSessionId)?.title || '新任务'
    : TABS.find((item) => item.key === activeTab)?.label ?? '工作台';

  return (
    <SidebarProvider
      className="app-shell bg-sidebar text-foreground h-svh min-h-0 overflow-hidden"
      style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.5rem' } as CSSProperties}
    >
      <AppSidebar
        active={activeTab}
        onChange={changeTab}
        identity={auth.identity}
        onLogout={logout}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onNewSession={createSession}
        onRemoveSession={requestSessionRemoval}
        onRefreshSessions={() => void loadSessions()}
        deletingSessionId={deletingSessionId}
      />
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="border-border/70 bg-background/95 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur">
          <SidebarTrigger aria-label="收起或展开导航" title="收起或展开导航" />
          <div className="border-border/80 hidden h-4 border-l sm:block" />
          <div className="flex min-w-0 items-center gap-2 px-1">
            <span className="truncate text-sm font-medium">{activeTitle}</span>
            {activeTab === 'chat' ? (
              <span className="text-muted-foreground hidden text-xs sm:inline">企业智能助手</span>
            ) : null}
          </div>
        </header>
        <Suspense fallback={<div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">页面加载中…</div>}>
          <div className="flex min-h-0 flex-1 flex-col">
            {pane(
              'chat',
              <ChatPage
                identity={auth.identity}
                activeId={activeSessionId}
                isActive={activeTab === 'chat'}
                onSessionChange={setActiveSessionId}
                onSessionSettled={settleSession}
                isDraftSession={isDraftSession}
                onUnauthorized={onUnauthorized}
              />,
              false,
            )}
            {visited.has('approvals') ? (
              pane('approvals', <ApprovalsPage identity={auth.identity} onUnauthorized={onUnauthorized} />)
            ) : null}
            {visited.has('knowledge') ? (
              pane('knowledge', <KnowledgePage identity={auth.identity} onUnauthorized={onUnauthorized} />)
            ) : null}
            {visited.has('tools') ? pane('tools', <ToolsPage onUnauthorized={onUnauthorized} />) : null}
            {visited.has('users') ? pane('users', <UsersPage identity={auth.identity} onUnauthorized={onUnauthorized} />) : null}
            {visited.has('providers') ? pane('providers', <ProvidersPage identity={auth.identity} onUnauthorized={onUnauthorized} onOpenModels={() => changeTab('models')} />) : null}
            {visited.has('models') ? pane('models', <ModelsPage identity={auth.identity} onUnauthorized={onUnauthorized} onOpenProviders={() => changeTab('providers')} />) : null}
            {visited.has('budget') ? pane('budget', <BudgetPage onUnauthorized={onUnauthorized} />) : null}
            {visited.has('audit') ? pane('audit', <AuditPage onUnauthorized={onUnauthorized} />) : null}
          </div>
        </Suspense>
      </SidebarInset>
      <Dialog open={sessionPendingDeletion !== null} onOpenChange={(open) => { if (!open && !deletingSessionId) setSessionPendingDeletion(null); }}>
        <DialogContent showCloseButton={!deletingSessionId}>
          <DialogHeader>
            <DialogTitle>删除最近任务</DialogTitle>
            <DialogDescription>
              确定删除“{sessionPendingDeletion?.title || '新任务'}”吗？会话及其消息将永久删除，无法恢复；关联审批、审计和 Trace 保留。正在生成的任务需先停止生成。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="btn btn-ghost" disabled={deletingSessionId !== null} onClick={() => setSessionPendingDeletion(null)}>取消</button>
            <button type="button" className="btn btn-danger" disabled={deletingSessionId !== null} onClick={() => void removeSession()}>{deletingSessionId ? '删除中…' : '确认删除'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Console />
    </ToastProvider>
  );
}
