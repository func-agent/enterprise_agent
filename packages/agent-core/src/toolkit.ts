/**
 * Toolkit —— Agent 可用工具集合（见 4.1 AgentScope 关键配置：Toolkit 的 MCP Server 地址
 * 全部指向 agentgateway 的 MCP 端点）。
 *
 * 工具目录从网关下发（按租户过滤），实际调用也必须经网关，Agent 侧不直连 MCP Server。
 */
import type { ToolSpec } from '@eap/platform-core';

export interface ToolDefinition {
  spec: ToolSpec;
}

export class Toolkit {
  private tools = new Map<string, ToolDefinition>();

  register(spec: ToolSpec): void {
    this.tools.set(spec.name, { spec });
  }

  replaceAll(specs: ToolSpec[]): void {
    this.tools.clear();
    for (const s of specs) this.register(s);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 转换为 OpenAI 兼容的 function calling 描述 */
  toFunctionSchemas(): {
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }[] {
    return this.specs().map((s) => ({
      type: 'function' as const,
      function: {
        name: s.name,
        description: s.description,
        parameters: s.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
  }
}
