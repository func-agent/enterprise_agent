/**
 * MCP HTTP Server 基座 —— 基于官方 @modelcontextprotocol/sdk 的 Streamable HTTP 传输。
 * 无状态模式：每个请求新建 transport，兼容真实 MCP 客户端。
 */
import http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { createLogger } from '@eap/platform-core';

const log = createLogger('mcp-hub:server');

export interface McpToolDef {
  name: string;
  title?: string;
  description: string;
  /** zod raw shape；也可直接给 ZodObject（会自动补 passthrough） */
  inputSchema?: ZodRawShape | ZodTypeAny;
  /** 平台元数据 —— 经 _meta 下发给网关，用于治理与审计 */
  meta?: {
    requiresConfirmation?: boolean;
    sensitivity?: 'confidential' | 'internal' | 'public';
    dataScope?: string;
  };
  handler: (args: Record<string, any>) => Promise<McpToolResult> | McpToolResult;
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

export function textResult(text: string, structured?: unknown): McpToolResult {
  const res: McpToolResult = { content: [{ type: 'text', text }] };
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}

export function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * 把工具的入参 schema 统一处理成 **passthrough** 的 ZodObject。
 *
 * ⚠ 为什么必须 passthrough：
 * MCP SDK 在调用工具前会按 inputSchema 做一次 zod 校验，而 zod 对未声明的键
 * 默认是 **strip（直接删掉）**。网关会在参数里注入 `__ctx`（调用者身份：
 * 租户 / 部门 / 密级 / 角色），MCP 层靠它做「召回前过滤」（见 5.2 最高优先级）。
 * 一旦被 strip，`__ctx` 就丢失，`ctxFrom()` 只能退化成硬编码默认值
 * （t-default / dept-general / internal / anonymous）——
 * 表现是「过滤看起来生效、实际按固定身份过滤」，越权与漏召回都会出现。
 *
 * zod 的 passthrough 保留未声明的键，正好满足需求。
 */
function toPassthroughSchema(inputSchema: ZodRawShape | ZodTypeAny | undefined): ZodTypeAny {
  if (!inputSchema) return z.object({}).passthrough();
  // 已经是 ZodObject —— 直接补 passthrough
  if (inputSchema instanceof z.ZodObject) return inputSchema.passthrough();
  // raw shape —— 包一层 object 再 passthrough
  return z.object(inputSchema as ZodRawShape).passthrough();
}

/** 注册工具到 McpServer */
export function registerTools(server: McpServer, tools: McpToolDef[]): void {
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title ?? t.name,
        description: t.description,
        inputSchema: toPassthroughSchema(t.inputSchema) as any,
        ...(t.meta ? { _meta: t.meta as any } : {}),
      },
      async (args: any) => {
        try {
          const out = await t.handler(args ?? {});
          return out as any;
        } catch (err: any) {
          log.error('工具执行失败', { tool: t.name, error: String(err?.stack ?? err) });
          return errorResult(`工具 ${t.name} 执行失败：${err?.message ?? err}`) as any;
        }
      },
    );
  }
}

/**
 * 启动无状态 MCP HTTP Server。
 */
export function startMcpHttpServer(opts: {
  name: string;
  version: string;
  port: number;
  path?: string;
  tools: McpToolDef[];
  /**
   * 监听地址。
   *
   * 默认 0.0.0.0（容器内需要被同网络的其它容器按服务名访问；
   * compose 的 mcp-hub 服务也显式声明 MCP_HUB_HOST=0.0.0.0）；
   * 以宿主进程方式运行时必须设 MCP_HUB_HOST=127.0.0.1 收口到回环，
   * 避免 MCP 工具目录直接暴露在局域网/公网上。
   */
  host?: string;
}): Promise<http.Server> {
  const path = opts.path ?? '/mcp';
  const host = opts.host ?? process.env.MCP_HUB_HOST ?? '0.0.0.0';

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, server: opts.name, tools: opts.tools.length });
  });

  app.post(path, async (req, res) => {
    const server = new McpServer({ name: opts.name, version: opts.version });
    registerTools(server, opts.tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('MCP 请求处理失败', { error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(opts.port, host, () => {
      log.info('MCP Server 已启动', {
        name: opts.name,
        port: opts.port,
        host,
        path,
        tools: opts.tools.length,
      });
      resolve(httpServer);
    });
  });
}

/** 常用 zod schema 片段 */
export const zod = {
  string: (desc: string) => z.string().describe(desc),
  number: (desc: string) => z.number().describe(desc),
  boolean: (desc: string) => z.boolean().describe(desc),
  enumOf: (values: string[], desc: string) => z.enum(values as [string, ...string[]]).describe(desc),
  optional: <T extends z.ZodTypeAny>(s: T) => s.optional(),
};
