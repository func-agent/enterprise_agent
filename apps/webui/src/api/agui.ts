/**
 * AG-UI 客户端接线 —— 基于标准 `@ag-ui/client` 的 `HttpAgent`。
 *
 * 来源与许可：
 *   移植自 https://github.com/Ken-LK/agentscope-agui-scaffold
 *   （frontend/src/api/agentscopeAgui.ts，许可 Apache License 2.0）
 *   Copyright 2024-2025 Ken-LK and the agentscope-agui-scaffold contributors.
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * 本平台改造点：
 *   1. 端点固定为**同源相对路径** `/ag-ui` —— 由 vite preview / 生产前置层反代到
 *      agent-core(8090)。控制台经公网访问时不写死绝对地址。
 *   2. 鉴权头**每次请求动态注入**：令牌在登录成功后才写入 localStorage，
 *      若在模块加载时固化会拿到空值，因此包一层 fetch 拦截。
 *   3. `forwardedProps` 携带 `{ sessionId, appId, model }` 供 agent-core 读取。
 */
import { HttpAgent, type AgentSubscriber, type HttpAgentConfig } from "@ag-ui/client";

/** AG-UI 端点 —— 同源相对路径 */
export const AGUI_ENDPOINT = "/ag-ui";

/** 令牌在 localStorage 中的键名 —— 与 `src/api.ts` 的 TOKEN_KEY 保持一致 */
const TOKEN_KEY = "eap.token";

export type CreateAguiHttpAgentOptions = {
  /** 端点，默认 `/ag-ui` */
  url?: string;
  /** 会话 id（= 平台 sessionId）；可以是函数，每次请求时求值 */
  threadId?: string | (() => string);
  /** 附加的静态请求头 */
  headers?: Record<string, string>;
  /** 自定义 fetch（默认使用内置的鉴权包装） */
  fetch?: HttpAgentConfig["fetch"];
  debug?: boolean;
  /** 透传给后端的附加字段，默认带 { sessionId, appId, model } */
  forwardedProps?: Record<string, unknown> | (() => Record<string, unknown>);
};

/**
 * 读取当前访问令牌。
 *
 * 刻意做成**每次调用都重新读**：控制台登录（OIDC / 开发态）之后令牌才写入
 * localStorage，模块加载期读取会固化空值。
 */
export function readAuthToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 不可用
    return null;
  }
}

/** 合并请求头并动态注入 Authorization */
function buildAuthHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  const token = readAuthToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
}

/**
 * 默认 fetch —— 每次调用都重新读取令牌并注入 Authorization。
 *
 * 不能直接传 `window.fetch`：HttpAgent 内部以 `this.fetch(...)` 调用，
 * 裸传会丢失 `this` 绑定并抛 "Illegal invocation"。
 */
const authFetch: HttpAgentConfig['fetch'] = (input, init) =>
  fetch(input, { ...init, headers: buildAuthHeaders(init?.headers) });

type HttpRunParameters = Parameters<HttpAgent['runAgent']>[0];

/** react-ag-ui 0.0.34 未桥接 onRunErrorEvent，且收尾会覆盖错误状态，这里在客户端边界补齐。 */
class PlatformHttpAgent extends HttpAgent {
  override runAgent(
    parameters?: HttpRunParameters,
    subscriber?: AgentSubscriber,
  ): ReturnType<HttpAgent['runAgent']> {
    if (!subscriber) return super.runAgent(parameters, subscriber);

    let failed = false;
    const wrapped: AgentSubscriber = {
      ...subscriber,
      onRunFailed: (params) => {
        failed = true;
        return subscriber.onRunFailed?.(params);
      },
      onRunErrorEvent: async (params) => {
        await subscriber.onRunErrorEvent?.(params);
        const error = new Error(params.event.message);
        if (params.event.code) Object.assign(error, { code: params.event.code });
        await wrapped.onRunFailed?.({ ...params, error });
      },
      onRunFinalized: (params) => failed ? undefined : subscriber.onRunFinalized?.(params),
    };
    return super.runAgent(parameters, wrapped);
  }
}

/**
 * 创建标准 AG-UI HttpAgent。
 *
 * 后端实现的是标准 `POST /ag-ui`（AG-UI `RunAgentInput` + SSE 事件流），
 * 复用官方 HTTP/SSE 协议处理，仅补充动态参数与错误状态适配。
 */
export function createAguiHttpAgent(options: CreateAguiHttpAgentOptions = {}): HttpAgent {
  const agent = new PlatformHttpAgent({
    url: options.url ?? AGUI_ENDPOINT,
    threadId: resolveOption(options.threadId),
    headers: options.headers,
    fetch: options.fetch ?? authFetch,
    debug: options.debug ?? false,
  });

  // 只有需要动态值（forwardedProps / 动态 threadId）时才打补丁，
  // 静态参数直接交给构造函数即可。
  if (options.forwardedProps || typeof options.threadId === 'function') {
    installRunInputPatch(agent, {
      forwardedProps: options.forwardedProps,
      threadId: options.threadId,
    });
  }
  return agent;
}

/**
 * 补丁 `prepareRunAgentInput`：把动态的 threadId 与 forwardedProps 注入每次运行。
 *
 * `HttpAgent` 构造函数里的 `threadId` / `headers` 是**一次性快照**，
 * 切换会话时需要新的取值，故在构造运行输入时覆盖。
 */
function installRunInputPatch(
  agent: HttpAgent,
  options: Pick<CreateAguiHttpAgentOptions, 'forwardedProps' | 'threadId'>,
): void {
  const target = agent as unknown as {
    prepareRunAgentInput: (params?: {
      forwardedProps?: Record<string, unknown>;
      resume?: unknown;
    }) => {
      forwardedProps?: Record<string, unknown>;
      threadId?: string;
      resume?: unknown;
    };
  };
  const original = target.prepareRunAgentInput;
  target.prepareRunAgentInput = function (params) {
    const input = original.call(this, params);
    const forwardedProps = resolveOption(options.forwardedProps);
    const threadId = resolveOption(options.threadId);
    return {
      ...input,
      ...(threadId ? { threadId } : {}),
      forwardedProps: {
        ...(input.forwardedProps ?? {}),
        ...(forwardedProps ?? {}),
      },
    };
  };
}

/** 允许选项写成常量或取值函数 */
function resolveOption<T>(value: T | (() => T) | undefined): T | undefined {
  return typeof value === 'function' ? (value as () => T)() : value;
}
