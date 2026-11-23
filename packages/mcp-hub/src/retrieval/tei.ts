/**
 * TEI 客户端 —— 本地嵌入服务（见 4.2 本地 Embedding，数据不出域）。
 *
 * 只允许环回与私有网段地址：绝不借用商业 API 的出网白名单，
 * 否则嵌入请求会把业务正文发到外部模型域名（违反 4.2 与 8.3）。
 */
import { createLogger } from '@eap/platform-core';

const log = createLogger('mcp:tei');

/**
 * TEI /embed 响应解析。
 *
 * 实测 TEI 1.8 返回**裸数组**：多条输入 → [[v1],[v2]]；单条输入 → 扁平 [v1]。
 * OpenAI 风格返回 {"embeddings": [...]}。两种都认。
 */
export function parseEmbeddings(payload: unknown): number[][] {
  if (Array.isArray(payload)) {
    if (payload.length > 0 && typeof payload[0] === 'number') return [payload as number[]];
    return payload.filter((v): v is number[] => Array.isArray(v));
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const list = (obj.embeddings ?? obj.vectors) as unknown;
    if (Array.isArray(list)) {
      if (list.length > 0 && typeof list[0] === 'number') return [list as number[]];
      return list.filter((v): v is number[] => Array.isArray(v));
    }
  }
  return [];
}

export interface TeiOptions {
  baseUrl: string;
  timeoutMs?: number;
  /**
   * 查询侧前缀。e5 / bge-m3 系列要求「query: 」前缀，
   * 文档侧用「passage: 」，两侧不一致会明显拉低召回质量。
   */
  queryPrefix?: string;
  /** 文档（passage）侧前缀 */
  passagePrefix?: string;
}

export class TeiClient {
  constructor(private readonly opts: TeiOptions) {}

  /** 给查询文本加前缀 */
  withQueryPrefix(text: string): string {
    const p = this.opts.queryPrefix ?? '';
    return p ? `${p}${text}` : text;
  }

  /**
   * 给文档文本加前缀。
   * 与查询侧前缀不同 —— e5 / bge-m3 约定：查询用 query:，文档用 passage:。
   */
  withPassagePrefix(text: string): string {
    const p = this.opts.passagePrefix ?? '';
    return p ? `${p}${text}` : text;
  }

  /** 断言目标是内网地址 */
  private assertLocal(url: string): void {
    const { hostname } = new URL(url);
    const local = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
    if (
      local.includes(hostname) ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      return;
    }
    throw new Error(`TEI 地址必须是内网地址：${hostname}`);
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (!inputs.length) return [];
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/embed`;
    this.assertLocal(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`TEI HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as any;
      return parseEmbeddings(json);
    } catch (err: any) {
      log.warn('TEI 嵌入失败', { error: err?.message ?? String(err) });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
