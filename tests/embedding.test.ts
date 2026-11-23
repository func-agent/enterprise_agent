/**
 * 本地嵌入测试 —— TEI 适配器（见 4.2 本地 Embedding，数据不出域）。
 *
 * 关键断言：
 *   - 嵌入请求只允许内网地址（TEI / Infinity），不得把数据发往外部域名
 *   - 解析 TEI /embed 的 {embeddings: [[...]]} 响应
 */
import { describe, expect, it } from 'vitest';
import { TeiAdapter, ProviderError } from '../packages/gateway/src/llm/providers.js';

describe('TEI 适配器', () => {
  it('空输入直接返回空数组，不发请求', async () => {
    let called = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return { ok: true } as Response;
    }) as typeof fetch;
    try {
      const tei = new TeiAdapter('http://127.0.0.1:6380');
      expect(await tei.embed([])).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
    expect(called).toBe(false);
  });

  it('解析 /embed 响应', async () => {
    const orig = globalThis.fetch;
    let capturedUrl = '';
    let capturedBody: any = null;
    globalThis.fetch = (async (url: string, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] }),
      } as Response;
    }) as typeof fetch;
    try {
      const tei = new TeiAdapter('http://127.0.0.1:6380');
      const vectors = await tei.embed(['第一段', '第二段']);
      expect(vectors).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
      expect(capturedUrl).toBe('http://127.0.0.1:6380/embed');
      expect(capturedBody).toEqual({ inputs: ['第一段', '第二段'] });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('解析 TEI 裸数组响应（实测 1.8 返回的就是裸数组）', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [
        [0.01, 0.02],
        [0.03, 0.04],
      ],
    })) as unknown as typeof fetch;
    try {
      const tei = new TeiAdapter('http://127.0.0.1:6380');
      expect(await tei.embed(['a', 'b'])).toEqual([
        [0.01, 0.02],
        [0.03, 0.04],
      ]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('解析 TEI 单条输入的扁平向量', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [0.1, 0.2, 0.3],
    })) as unknown as typeof fetch;
    try {
      const tei = new TeiAdapter('http://127.0.0.1:6380');
      expect(await tei.embed(['a'])).toEqual([[0.1, 0.2, 0.3]]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('无法识别的响应解析为空数组而不是抛错', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ foo: 'bar' }) })) as unknown as typeof fetch;
    try {
      const tei = new TeiAdapter('http://127.0.0.1:6380');
      expect(await tei.embed(['a'])).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('HTTP 错误抛出可重试标记正确的 ProviderError', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      text: async () => 'model loading',
    })) as unknown as typeof fetch;
    try {
      const tei = new TeiAdapter('http://127.0.0.1:6380');
      await expect(tei.embed(['x'])).rejects.toThrow(ProviderError);
      await tei.embed(['x']).catch((err: ProviderError) => {
        expect(err.status).toBe(503);
        expect(err.retryable).toBe(true);
      });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('4xx 视为不可重试', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => 'bad input',
    })) as unknown as typeof fetch;
    try {
      const tei = new TeiAdapter('http://127.0.0.1:6380');
      await tei.embed(['x']).catch((err: ProviderError) => {
        expect(err.status).toBe(400);
        expect(err.retryable).toBe(false);
      });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('拒绝把嵌入请求发往外部域名（数据不出域）', async () => {
    // api.openai.com 在商业 API 出网白名单里，但内网嵌入服务绝不能借用该白名单
    const tei = new TeiAdapter('https://api.openai.com');
    await expect(tei.embed(['敏感内容'])).rejects.toThrow(/仅允许环回与私有网段/);
  });

  it('拒绝公网 IP 地址', async () => {
    const tei = new TeiAdapter('http://93.184.216.34:6380');
    await expect(tei.embed(['敏感内容'])).rejects.toThrow(/仅允许环回与私有网段/);
  });

  it('允许私有网段地址', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ embeddings: [[1]] }) })) as unknown as typeof fetch;
    try {
      const tei = new TeiAdapter('http://10.0.0.5:6380');
      expect(await tei.embed(['x'])).toEqual([[1]]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
