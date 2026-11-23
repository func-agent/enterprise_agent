import {
  Activity,
  BookOpen,
  Bot,
  ChevronUp,
  GaugeCircle,
  LayoutGrid,
  LogOut,
  MessageSquareText,
  MessagesSquare,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Trash2,
  UsersRound,
} from 'lucide-react';
import type { Identity, SessionSummary } from '../types';
import { formatRelativeTime, roleLabel, sensitivityLabel } from '../format';
import { ThemeToggle } from './ThemeToggle';
import { canManageUsers, canViewAdminPages } from '../permissions';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from './ui/sidebar';

export const TABS = [
  { key: 'chat', label: '工作台', icon: MessagesSquare },
  { key: 'approvals', label: '审批中心', icon: ShieldCheck },
  { key: 'knowledge', label: '知识库', icon: BookOpen },
  { key: 'tools', label: '工具目录', icon: LayoutGrid },
  { key: 'users', label: '用户与权限', icon: UsersRound },
  { key: 'providers', label: '厂商接入与凭证', icon: PlugZap },
  { key: 'models', label: '模型与路由', icon: Bot },
  { key: 'budget', label: '预算看板', icon: GaugeCircle },
  { key: 'audit', label: '审计与 Trace', icon: Activity },
] as const;

export type TabKey = (typeof TABS)[number]['key'];

const ADMIN_TAB_KEYS = new Set<TabKey>(['providers', 'models', 'budget', 'audit']);
const PLATFORM_ADMIN_TAB_KEYS = new Set<TabKey>(['users']);
const WORKSPACE_KEYS = new Set<TabKey>(['chat', 'knowledge', 'approvals', 'tools']);

export function canAccessTab(identity: Identity, tab: TabKey): boolean {
  if (PLATFORM_ADMIN_TAB_KEYS.has(tab)) return canManageUsers(identity);
  return !ADMIN_TAB_KEYS.has(tab) || canViewAdminPages(identity);
}

interface AppSidebarProps {
  active: TabKey;
  onChange: (tab: TabKey) => void;
  identity: Identity;
  onLogout: () => void;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onRemoveSession: (id: string) => void;
  onRefreshSessions: () => void;
  deletingSessionId: string | null;
}

export function AppSidebar({
  active,
  onChange,
  identity,
  onLogout,
  sessions,
  sessionsLoading,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onRemoveSession,
  onRefreshSessions,
  deletingSessionId,
}: AppSidebarProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  const username = identity.username ?? identity.user_id;
  const currentIsStored = sessions.some((session) => session.id === activeSessionId);
  const recentSessions = currentIsStored
    ? sessions
    : [
        {
          id: activeSessionId,
          tenantId: identity.tenant_id,
          userId: identity.user_id,
          title: '新任务',
          createdAt: '',
          updatedAt: '',
        },
        ...sessions,
      ];

  const closeMobile = (): void => {
    if (isMobile) setOpenMobile(false);
  };
  const selectTab = (tab: TabKey): void => {
    onChange(tab);
    closeMobile();
  };
  const newSession = (): void => {
    onNewSession();
    closeMobile();
  };

  const renderNavigation = (management: boolean) => (
    <SidebarMenu>
      {TABS.filter((tab) => WORKSPACE_KEYS.has(tab.key) !== management)
        .filter((tab) => canAccessTab(identity, tab.key))
        .map((tab) => {
          const Icon = tab.icon;
          return (
            <SidebarMenuItem key={tab.key}>
              <SidebarMenuButton
                type="button"
                isActive={active === tab.key}
                tooltip={tab.label}
                onClick={() => selectTab(tab.key)}
                aria-current={active === tab.key ? 'page' : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{tab.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
    </SidebarMenu>
  );

  return (
    <Sidebar collapsible="icon" aria-label="主导航">
      <SidebarHeader className="h-16 justify-center px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-xl shadow-sm">
            <Sparkles className="size-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-semibold tracking-tight">企业级 AI Agent 平台</p>
            <p className="text-muted-foreground mt-0.5 text-[11px]">智能工作台</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="overflow-hidden px-1">
        <SidebarGroup className="pb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                tooltip="新建任务"
                onClick={newSession}
                className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 h-9 justify-center font-medium shadow-sm"
              >
                <SquarePen aria-hidden="true" />
                <span>新建任务</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="py-1">
          <SidebarGroupLabel>工作空间</SidebarGroupLabel>
          <SidebarGroupContent>{renderNavigation(false)}</SidebarGroupContent>
        </SidebarGroup>

        {canViewAdminPages(identity) ? (
          <SidebarGroup className="py-1">
            <SidebarGroupLabel>管理与运维</SidebarGroupLabel>
            <SidebarGroupContent>{renderNavigation(true)}</SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        <SidebarGroup className="min-h-0 flex-1 py-1 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>最近任务</SidebarGroupLabel>
          <SidebarGroupAction type="button" title="刷新最近任务" aria-label="刷新最近任务" onClick={onRefreshSessions}>
            <RefreshCw className={sessionsLoading ? 'animate-spin' : undefined} aria-hidden="true" />
          </SidebarGroupAction>
          <SidebarGroupContent className="min-h-0 flex-1 overflow-y-auto">
            {sessionsLoading && sessions.length === 0 ? (
              <p className="text-muted-foreground px-2 py-2 text-xs">正在加载任务…</p>
            ) : (
              <SidebarMenu>
                {recentSessions.map((session) => {
                  const isActive = active === 'chat' && activeSessionId === session.id;
                  const title = session.title || '新任务';
                  const time = session.updatedAt ? formatRelativeTime(session.updatedAt) : '当前任务';
                  return (
                    <SidebarMenuItem key={session.id}>
                      <SidebarMenuButton
                        type="button"
                        size="sm"
                        data-session-id={session.id}
                        isActive={isActive}
                        onClick={() => {
                          onSelectSession(session.id);
                          selectTab('chat');
                        }}
                        title={`${title} · ${time}`}
                        className="h-8"
                      >
                        <MessageSquareText className="text-muted-foreground" aria-hidden="true" />
                        <span>{title}</span>
                      </SidebarMenuButton>
                      {session.updatedAt ? (
                        <SidebarMenuAction
                          type="button"
                          showOnHover
                          title="删除会话（审批、审计与 Trace 保留）"
                          aria-label={`删除会话：${title}`}
                          disabled={deletingSessionId !== null}
                          onClick={() => onRemoveSession(session.id)}
                        >
                          {deletingSessionId === session.id ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                        </SidebarMenuAction>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-sidebar-border border-t p-2">
        <div className="flex h-8 items-center justify-between px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <span className="text-muted-foreground text-xs group-data-[collapsible=icon]:hidden">外观</span>
          <ThemeToggle />
        </div>
        <details
          className="group/account relative"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }}
        >
          <summary
            className="hover:bg-sidebar-accent flex h-11 cursor-pointer list-none items-center gap-2 rounded-lg p-2 outline-none transition-colors focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
            aria-label="查看当前登录身份"
            title={username}
          >
            <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
              {username.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
              <span className="block truncate text-xs font-medium">{username}</span>
              <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">{roleLabel(identity.role)}</span>
            </span>
            <ChevronUp className="text-muted-foreground size-3.5 group-data-[collapsible=icon]:hidden" aria-hidden="true" />
          </summary>
          <div className="border-border bg-popover text-popover-foreground absolute bottom-13 start-0 z-50 w-64 rounded-xl border p-3 shadow-lg">
            <p className="text-sm font-medium">{username}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">当前登录身份</p>
            <dl className="border-border mt-3 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-y-2 border-t pt-3 text-xs">
              <dt className="text-muted-foreground">角色</dt>
              <dd>{roleLabel(identity.role)}</dd>
              <dt className="text-muted-foreground">租户</dt>
              <dd className="break-all font-mono">{identity.tenant_id}</dd>
              <dt className="text-muted-foreground">部门</dt>
              <dd className="break-all font-mono">{identity.dept_id}</dd>
              <dt className="text-muted-foreground">密级</dt>
              <dd>{sensitivityLabel(identity.sensitivity)}</dd>
            </dl>
            <button
              type="button"
              onClick={onLogout}
              /* 字号与面板内其余文字一致（12px）；全局层叠已修正，
                 Tailwind 的 text-xs 在按钮上可正常生效。 */
              className="text-muted-foreground hover:bg-accent hover:text-foreground border-border mt-3 flex w-full cursor-pointer items-center gap-2 border-t px-2 pt-3 text-xs font-medium transition-colors"
            >
              <LogOut className="size-3.5" aria-hidden="true" />
              退出登录
            </button>
          </div>
        </details>
      </SidebarFooter>
      <SidebarRail aria-label="收起或展开导航" title="收起或展开导航" />
    </Sidebar>
  );
}
