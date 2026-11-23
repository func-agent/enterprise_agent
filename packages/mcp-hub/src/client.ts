/**
 * MCP 客户端 —— 所有 MCP 工具调用的唯一通道（见 2.1 网关层职责：MCP 治理、工具白名单、租户隔离）。
 *
 * AgentScope 的 Toolkit 只拿网关下发的工具目录；工具实际调用全部经网关 → MCP Server。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger, type Cache, type JsonSchema, type ToolSpec } from '@eap/platform-core';

const log = createLogger('mcp-hub:client');

export interface McpServerConfig {
  id: string;
  url: string;
}

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  connectedAt: number;
}

export class McpClientManager {
  private connections = new Map<string, Connection>();
  private toolsCache = new Map<string, { at: number; tools: ToolSpec[] }>();

  constructor(
    private readonly servers: McpServerConfig[],
    /** 可选的共享缓存（生产用 Redis，多网关副本共享工具目录） */
    private readonly cache?: Cache,
  ) {}

  /** 从 MCP_SERVERS 环境变量格式解析：serverId=url[,url2] */
  static parseServers(spec: string[]): McpServerConfig[] {
    const out: McpServerConfig[] = [];
    for (const item of spec) {
      const idx = item.indexOf('=');
      if (idx <= 0) continue;
      const id = item.slice(0, idx).trim();
      const url = item.slice(idx + 1).trim();
      if (id && url) out.push({ id, url });
    }
    return out;
  }

  listServers(): McpServerConfig[] {
    return this.servers;
  }

  private async connect(serverId: string): Promise<Connection> {
    const existing = this.connections.get(serverId);
    if (existing) return existing;

    const cfg = this.servers.find((s) => s.id === serverId);
    if (!cfg) throw new Error(`未注册的 MCP Server: ${serverId}`);

    const client = new Client({ name: 'eap-gateway', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: {
        headers: { 'x-mcp-server': serverId },
      },
    });
    await client.connect(transport);
    const conn: Connection = { client, transport, connectedAt: Date.now() };
    this.connections.set(serverId, conn);
    log.info('MCP Server 已连接', { serverId, url: cfg.url });
    return conn;
  }

  /** 关闭并丢弃某个 server 的缓存连接（用于会话失效后强制重连） */
  private async dropConnection(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    this.connections.delete(serverId);
    this.toolsCache.delete(serverId);
    try {
      await conn.transport.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * 判断错误是否是「MCP 会话已失效」，需要丢弃缓存连接后重连。
   *
   * MCP Server 重启后，旧 session id 立即失效，服务端会返回
   * `{"code":-32600,"message":"Session not found"}`。
   * 客户端若继续复用缓存的 transport，后续所有调用都会持续失败 ——
   * 必须丢弃连接重连一次。
   */
  private isSessionInvalid(err: unknown): boolean {
    const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    return /session not found|session terminated|invalid session/i.test(text);
  }

  /**
   * 带缓存的工具目录
   */
  async listToolsCached(serverId: string, ttlMs = 30_000): Promise<ToolSpec[]> {
    // 优先读共享缓存（跨副本命中）
    if (this.cache) {
      const shared = await this.cache.get<ToolSpec[]>(`eap:mcp:catalog:${serverId}`);
      if (shared && shared.length) return shared;
    }
    const cached = this.toolsCache.get(serverId);
    if (cached && Date.now() - cached.at < ttlMs) return cached.tools;
    const tools = await this.listTools(serverId);
    if (this.cache) {
      await this.cache.set(`eap:mcp:catalog:${serverId}`, tools, Math.ceil(ttlMs / 1000));
    }
    return tools;
  }

  /** 拉取工具目录并转换为平台 ToolSpec（会话失效时自动重连一次） */
  async listTools(serverId: string): Promise<ToolSpec[]> {
    let tools: ToolSpec[];
    try {
      tools = await this.fetchTools(serverId);
    } catch (err) {
      if (!this.isSessionInvalid(err)) throw err;
      log.warn('MCP 会话已失效，丢弃连接后重连', { serverId });
      await this.dropConnection(serverId);
      tools = await this.fetchTools(serverId);
    }
    this.toolsCache.set(serverId, { at: Date.now(), tools });
    return tools;
  }

  private async fetchTools(serverId: string): Promise<ToolSpec[]> {
    const conn = await this.connect(serverId);
    const res = await conn.client.listTools();
    const tools: ToolSpec[] = (res.tools ?? []).map((t: any) => {
      const meta = (t._meta ?? {}) as Record<string, any>;
      return {
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as JsonSchema,
        serverId,
        requiresConfirmation: meta.requiresConfirmation === true,
        sensitivity: (meta.sensitivity ?? 'internal') as ToolSpec['sensitivity'],
        dataScope: meta.dataScope as string | undefined,
      };
    });
    return tools;
  }

  /**
   * 调用工具（会话失效时丢弃连接重连一次）
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean; structured?: unknown }> {
    try {
      return await this.invokeTool(serverId, toolName, args);
    } catch (err) {
      if (!this.isSessionInvalid(err)) throw err;
      log.warn('MCP 会话已失效，丢弃连接后重试', { serverId, toolName });
      await this.dropConnection(serverId);
      return this.invokeTool(serverId, toolName, args);
    }
  }

  private async invokeTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean; structured?: unknown }> {
    const conn = await this.connect(serverId);
    const res: any = await conn.client.callTool({ name: toolName, arguments: args });
    const blocks: any[] = res.content ?? [];
    const text = blocks
      .map((b) => (typeof b.text === 'string' ? b.text : JSON.stringify(b)))
      .join('\n');
    return {
      content: text,
      isError: res.isError === true,
      structured: res.structuredContent,
    };
  }

  async health(): Promise<{ serverId: string; ok: boolean; tools: number; error?: string }[]> {
    const out: { serverId: string; ok: boolean; tools: number; error?: string }[] = [];
    for (const s of this.servers) {
      try {
        const tools = await this.listToolsCached(s.id);
        out.push({ serverId: s.id, ok: true, tools: tools.length });
      } catch (err) {
        out.push({ serverId: s.id, ok: false, tools: 0, error: String(err) });
      }
    }
    return out;
  }

  async closeAll(): Promise<void> {
    for (const [id, conn] of this.connections) {
      try {
        await conn.transport.close();
      } catch {
        /* ignore */
      }
      this.connections.delete(id);
    }
  }
}
