/**
 * 会话侧边栏 —— 会话列表 + 应用选择器。
 *
 * 来源与许可：
 *   移植自 https://github.com/Ken-LK/agentscope-agui-scaffold
 *   （frontend/src/components/assistant-ui/threadlist-sidebar.tsx，许可 Apache License 2.0）
 *   Copyright 2024-2025 Ken-LK and the agentscope-agui-scaffold contributors.
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * 本平台改造点：
 *   1. 上游的 Agent 选择器依赖后端 /manifest 接口（Python 侧能力），
 *      这里改为读取 `useAgentThreadRegistry()` 里的 `agents` / `appId`，
 *      由页面层传入平台的应用列表，不再依赖上游后端。
 *   2. 文案与品牌改为企业级 AI Agent 平台，去掉指向 AgentScope 文档站的外部链接。
 */
import type * as React from 'react';
import { MessagesSquare, ServerCog } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '../ui/sidebar';
import { ThreadList } from './thread-list';
import { useAgentThreadRegistry } from '../../runtime/AgentRuntimeProvider';

/** 应用选择器 —— 仅在存在多个应用时显示 */
function AgentSelector() {
  const { agents, appId, selectApp } = useAgentThreadRegistry();
  if (agents.length <= 1) return null;
  return (
    <div className="px-2 pb-2">
      <label className="text-muted-foreground mb-1 block text-xs font-medium" htmlFor="eap-app-select">
        应用
      </label>
      <select
        id="eap-app-select"
        className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
        value={appId ?? ''}
        onChange={(event) => selectApp(event.target.value)}
      >
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ThreadListSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      <SidebarHeader className="aui-sidebar-header mb-2 border-b">
        <div className="aui-sidebar-header-content flex items-center justify-between">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg">
                <div className="aui-sidebar-header-icon-wrapper bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <MessagesSquare className="aui-sidebar-header-icon size-4" />
                </div>
                <div className="aui-sidebar-header-heading me-6 flex flex-col gap-0.5 leading-none">
                  <span className="aui-sidebar-header-title font-semibold">企业级 AI Agent 平台</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarHeader>
      <SidebarContent className="aui-sidebar-content px-2">
        <AgentSelector />
        <ThreadList />
      </SidebarContent>
      <SidebarRail />
      <SidebarFooter className="aui-sidebar-footer border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg">
              <div className="aui-sidebar-footer-icon-wrapper bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                <ServerCog className="aui-sidebar-footer-icon size-4" />
              </div>
              <div className="aui-sidebar-footer-heading flex flex-col gap-0.5 leading-none">
                <span className="aui-sidebar-footer-title font-semibold">AG-UI 协议</span>
                <span>POST /ag-ui · agent-core</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
