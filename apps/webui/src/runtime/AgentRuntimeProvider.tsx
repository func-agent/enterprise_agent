/**
 * Agent 运行时 —— 把 assistant-ui 的 Thread 绑定到平台会话。
 *
 * 来源与许可：
 *   移植自 https://github.com/Ken-LK/agentscope-agui-scaffold
 *   （frontend/src/runtime/AgentRuntimeProvider.tsx，许可 Apache License 2.0）
 *   Copyright 2024-2025 Ken-LK and the agentscope-agui-scaffold contributors.
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * 本平台改造点：
 *   1. 上游用固定字符串 "main" + 前端自造的 uuid 作为线程 id；本平台改为
 *      **threadId === sessionId**，即平台的会话 uuid，前端新建会话时生成 v4 uuid，
 *      agent-core 以该 id 建立/续用会话。
 *   2. 上游依赖后端下发的 manifest（/manifest 接口，Python 侧能力）来选择 Agent；
 *      本平台改为由页面层通过 props 传入 `appId` 与可选的 `agents` 列表，
 *      不再对上游后端产生任何依赖。
 *   3. `forwardedProps` 携带 `{ sessionId, appId, model }`，供 agent-core 读取。
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AssistantRuntimeProvider, type ThreadMessageLike } from '@assistant-ui/react';
import { useAgUiRuntime } from '@assistant-ui/react-ag-ui';

import { createAguiHttpAgent } from '../api/agui';
import { newSessionId } from '../lib/session';

/** 可选的应用（Agent）条目 —— 用于侧边栏的应用选择器 */
export type AgentAppOption = {
  id: string;
  name: string;
};

export type { ThreadMessageLike };

/** 线程摘要 —— 供侧边栏列表渲染 */
export type AgentThreadSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

export type AgentThreadRegistry = {
  /** 当前线程 id —— 与平台 sessionId 相同 */
  currentThreadId: string;
  /** 当前会话 id（= currentThreadId） */
  sessionId: string;
  /** 全部会话摘要，按最近更新倒序 */
  threads: readonly AgentThreadSummary[];
  /** 新建会话（生成新的 uuid） */
  createThread: () => void;
  /** 删除会话 */
  deleteThread: (threadId: string) => void;
  /** 切换会话 */
  switchThread: (threadId: string) => void;
  /** 当前应用 id */
  appId: string | undefined;
  /** 可选应用列表 */
  agents: readonly AgentAppOption[];
  /** 切换应用 */
  selectApp: (appId: string) => void;
};

export type AgentRuntimeProviderProps = {
  children: ReactNode;
  /**
   * 受控的当前会话 id。
   *
   * - 传 null / undefined：Provider 自行维护会话（新建会话会生成新的 uuid）。
   * - 传具体 id：页面层是唯一事实来源，Provider 跟随变化切换会话。
   */
  sessionId?: string | null;
  /** 当前应用 id，随 forwardedProps 下发给 agent-core */
  appId?: string;
  /** 当前会话显式选择的虚拟模型；缺省时使用服务端默认模型 */
  model?: string;
  /** 可选应用列表，供 ThreadListSidebar 渲染选择器 */
  agents?: readonly AgentAppOption[];
  /** 会话切换回调（新建 / 切换时触发），供页面层同步自己的选中态 */
  onSessionChange?: (sessionId: string) => void;
  /**
   * 历史加载器 —— 切换到**服务端已有**会话时按需拉取历史消息。
   *
   * 平台会话持久化在服务端（`/api/sessions/:id/messages`），前端只缓存内存态；
   * 不提供该加载器时，切换会话只会得到空线程。
   */
  loadHistory?: (sessionId: string) => Promise<readonly ThreadMessageLike[]>;
};

type StoredThread = {
  id: string;
  messages: readonly ThreadMessageLike[];
};

const AgentThreadRegistryContext = createContext<AgentThreadRegistry | null>(null);

/**
 * 读取会话注册表 —— 必须在 `AgentRuntimeProvider` 内部使用。
 */
export function useAgentThreadRegistry(): AgentThreadRegistry {
  const registry = useContext(AgentThreadRegistryContext);
  if (!registry) {
    throw new Error('useAgentThreadRegistry must be used inside AgentRuntimeProvider');
  }
  return registry;
}

/** 取消息正文 —— content 可能是纯文本，也可能是分片数组 */
function getMessageText(message: ThreadMessageLike): string {
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  return content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

/** 用首条用户消息作为会话标题 */
function getThreadTitle(messages: readonly ThreadMessageLike[]): string {
  const firstUserText = messages.find((message) => message.role === 'user');
  const title = firstUserText ? getMessageText(firstUserText) : '';
  return title ? title.slice(0, 42) : '新会话';
}

export function AgentRuntimeProvider({
  children,
  sessionId,
  appId,
  model,
  agents,
  onSessionChange,
  loadHistory,
}: AgentRuntimeProviderProps) {
  // 初始会话：优先用外部传入的 sessionId，否则新建一个 uuid。
  // 用惰性初始化，避免在渲染期调用 setState。
  const [initialThreadId] = useState<string>(() => sessionId || newSessionId());
  const initialHistoryRequestedRef = useRef(false);
  const threadsRef = useRef<Map<string, StoredThread>>(
    new Map([[initialThreadId, { id: initialThreadId, messages: [] }]]),
  );
  const currentThreadIdRef = useRef<string>(initialThreadId);
  const [currentThreadId, setCurrentThreadIdState] = useState<string>(initialThreadId);
  const [threads, setThreads] = useState<readonly AgentThreadSummary[]>([
    { id: initialThreadId, title: '新会话', updatedAt: Date.now() },
  ]);

  // 历史加载器用 ref 持有 —— 它通常每次渲染都是新函数，
  // 直接进依赖数组会让 switchThread 频繁重建。
  const loadHistoryRef = useRef(loadHistory);
  useEffect(() => {
    loadHistoryRef.current = loadHistory;
  }, [loadHistory]);

  const setCurrentThreadId = useCallback((threadId: string) => {
    currentThreadIdRef.current = threadId;
    setCurrentThreadIdState(threadId);
    if (!threadsRef.current.has(threadId)) {
      threadsRef.current.set(threadId, { id: threadId, messages: [] });
    }
  }, []);

  const upsertThreadSummary = useCallback(
    (threadId: string, messages: readonly ThreadMessageLike[]) => {
      setThreads((previous) => {
        const nextSummary: AgentThreadSummary = {
          id: threadId,
          title: getThreadTitle(messages),
          updatedAt: Date.now(),
        };
        const exists = previous.some((thread) => thread.id === threadId);
        const next = exists
          ? previous.map((thread) => (thread.id === threadId ? nextSummary : thread))
          : [nextSummary, ...previous];
        return [...next].sort((left, right) => right.updatedAt - left.updatedAt);
      });
    },
    [],
  );

  // 当前应用 id —— 内部状态，页面层可通过 appId 属性同步，
  // 也可经注册表的 selectApp 自行切换。
  const [selectedAppId, setSelectedAppId] = useState<string>(appId ?? '');
  useEffect(() => {
    setSelectedAppId(appId ?? '');
  }, [appId]);

  // 供 agent 工厂按最新值求值（工厂只创建一次，故用 ref 持有）
  const appIdRef = useRef(selectedAppId);
  const modelRef = useRef(model);
  useEffect(() => {
    appIdRef.current = selectedAppId;
  }, [selectedAppId]);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  /**
   * 标准 AG-UI 客户端 —— threadId 即平台 sessionId，
   * forwardedProps 额外带上 { sessionId, appId, model } 供 agent-core 读取。
   */
  const agent = useMemo(
    () =>
      createAguiHttpAgent({
        threadId: () => currentThreadIdRef.current,
        debug: false,
        forwardedProps: () => {
          const props: Record<string, unknown> = { sessionId: currentThreadIdRef.current };
          if (appIdRef.current) props.appId = appIdRef.current;
          if (modelRef.current) props.model = modelRef.current;
          return props;
        },
      }),
    [],
  );

  const runtime = useAgUiRuntime({
    agent,
    // 思考过程暂不展示：上游注释说明 REASONING_* 通路未做端到端验证，
    // 保持关闭以免渲染出未验证的中间态。
    showThinking: false,
    logger: {
      debug: (...args: unknown[]) => console.debug('[agui]', ...args),
      error: (...args: unknown[]) => console.error('[agui]', ...args),
    },
    onError: (error: unknown) => console.error('[agui]', error),
  });

  const persistCurrentThread = useCallback(() => {
    const threadId = currentThreadIdRef.current;
    const messages = runtime.thread.getState().messages;
    threadsRef.current.set(threadId, { id: threadId, messages });
    upsertThreadSummary(threadId, messages);
  }, [runtime, upsertThreadSummary]);

  const switchThread = useCallback(
    (threadId: string, forceLoad = false) => {
      if (!forceLoad && threadId === currentThreadIdRef.current) return;
      if (threadId !== currentThreadIdRef.current) {
        persistCurrentThread();
        setCurrentThreadId(threadId);
        onSessionChange?.(threadId);
      }

      // 内存里有该会话 → 直接恢复；否则从服务端拉历史。
      const cached = threadsRef.current.get(threadId);
      if (cached && cached.messages.length > 0) {
        runtime.thread.reset(cached.messages);
        return;
      }
      const loader = loadHistoryRef.current;
      if (!loader) {
        runtime.thread.reset([]);
        return;
      }
      runtime.thread.reset([]);
      void loader(threadId)
        .then((messages) => {
          // 期间用户可能已切走或已发送新消息 —— 不用过期结果覆盖当前线程
          if (currentThreadIdRef.current !== threadId) return;
          const cached = threadsRef.current.get(threadId);
          if (cached && cached.messages.length > 0) return;
          threadsRef.current.set(threadId, { id: threadId, messages });
          runtime.thread.reset(messages);
        })
        .catch(() => {
          if (currentThreadIdRef.current !== threadId) return;
          const cached = threadsRef.current.get(threadId);
          if (!cached || cached.messages.length === 0) runtime.thread.reset([]);
        });
    },
    [persistCurrentThread, runtime, setCurrentThreadId, onSessionChange],
  );

  const createThread = useCallback(() => {
    persistCurrentThread();
    const threadId = newSessionId();
    threadsRef.current.set(threadId, { id: threadId, messages: [] });
    setThreads((previous) => [{ id: threadId, title: '新会话', updatedAt: Date.now() }, ...previous]);
    setCurrentThreadId(threadId);
    runtime.thread.reset([]);
    onSessionChange?.(threadId);
  }, [persistCurrentThread, runtime, setCurrentThreadId, onSessionChange]);

  const deleteThread = useCallback(
    (threadId: string) => {
      if (threadsRef.current.size <= 1) return;
      threadsRef.current.delete(threadId);
      setThreads((previous) => previous.filter((thread) => thread.id !== threadId));
      if (threadId !== currentThreadIdRef.current) return;

      const fallbackId = newSessionId();
      const nextThread = [...threadsRef.current.values()][0] ?? {
        id: fallbackId,
        messages: [],
      };
      threadsRef.current.set(nextThread.id, nextThread);
      // 兜底新建的会话要出现在列表里，否则侧边栏会空掉一项
      setThreads((previous) =>
        previous.some((thread) => thread.id === nextThread.id)
          ? previous
          : [{ id: nextThread.id, title: '新会话', updatedAt: Date.now() }, ...previous],
      );
      setCurrentThreadId(nextThread.id);
      runtime.thread.reset(nextThread.messages);
      onSessionChange?.(nextThread.id);
    },
    [runtime, setCurrentThreadId, onSessionChange],
  );

  const selectApp = useCallback((nextAppId: string) => {
    setSelectedAppId(nextAppId);
  }, []);

  // 页面层受控 sessionId 变化时跟随切换；首次直接打开已有会话也要加载历史。
  useEffect(() => {
    if (!sessionId) return;
    if (sessionId === currentThreadIdRef.current) {
      if (sessionId !== initialThreadId || initialHistoryRequestedRef.current) return;
      initialHistoryRequestedRef.current = true;
      switchThread(sessionId, true);
      return;
    }
    switchThread(sessionId);
  }, [sessionId, switchThread, initialThreadId]);

  useEffect(() => {
    return runtime.thread.subscribe(() => {
      const threadId = currentThreadIdRef.current;
      const messages = runtime.thread.getState().messages;
      threadsRef.current.set(threadId, { id: threadId, messages });
      upsertThreadSummary(threadId, messages);
    });
  }, [runtime, upsertThreadSummary]);

  const threadRegistry = useMemo<AgentThreadRegistry>(
    () => ({
      currentThreadId,
      sessionId: currentThreadId,
      threads,
      createThread,
      deleteThread,
      switchThread,
      appId: selectedAppId || undefined,
      agents: agents ?? [],
      selectApp,
    }),
    [
      currentThreadId,
      threads,
      createThread,
      deleteThread,
      switchThread,
      selectApp,
      selectedAppId,
      agents,
    ],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentThreadRegistryContext.Provider value={threadRegistry}>
        {children}
      </AgentThreadRegistryContext.Provider>
    </AssistantRuntimeProvider>
  );
}
