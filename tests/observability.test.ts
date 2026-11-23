/**
 * 观测层测试 —— Trace → Langfuse OTLP 属性映射（见 4.1 / 4.3）。
 *
 * 关键断言：
 *   - 观察类型按名称推断（chat → generation / embed → embedding）
 *   - token 用量与成本按 Langfuse 约定落到 usage_details / cost_details
 *   - 平台自定义元数据必须带 langfuse.observation.metadata.<key> 前缀，
 *     否则 Langfuse 只会把它塞进不可过滤的 attributes 桶
 */
import { describe, expect, it } from 'vitest';
import { TracingService } from '../packages/gateway/src/observability/tracing.js';
import type { MetadataStore, TraceRecord } from '@eap/platform-core';

const fakeStore = {
  appendTrace: async () => {},
} as unknown as MetadataStore;

const svc = new TracingService(fakeStore, {
  otlpEndpoint: 'http://127.0.0.1:3001/api/public/otel',
  publicKey: 'pk-lf-test',
  secretKey: 'sk-lf-test',
  ingestionVersion: '4',
  environment: 'local',
  serviceName: 'agentgateway',
});

function trace(over: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: 'a'.repeat(32),
    sessionId: 'sess-1',
    tenantId: 't-default',
    userId: 'u-1',
    name: 'chat:smart-model',
    ts: '2026-11-18T06:00:00.000Z',
    input: [{ role: 'user', content: '你好' }],
    output: { content: '在的' },
    promptTokens: 120,
    completionTokens: 45,
    costUsd: 0.00123456,
    model: 'smart-model',
    metadata: { provider: 'minimax', realModel: 'MiniMax-M3.1-Flash', latencyMs: 820 },
    ...over,
  };
}

describe('Trace → Langfuse 属性映射', () => {
  it('chat 轨迹映射为 generation 类型', () => {
    const span = svc.toSpan(trace());
    expect(span.attributes['langfuse.observation.type']).toBe('generation');
    expect(span.attributes['langfuse.observation.name']).toBe('chat:smart-model');
    expect(span.attributes['langfuse.trace.name']).toBe('chat:smart-model');
    expect(span.attributes['langfuse.session.id']).toBe('sess-1');
    expect(span.attributes['langfuse.user.id']).toBe('u-1');
    expect(span.attributes['langfuse.observation.model.name']).toBe('smart-model');
    expect(span.attributes['langfuse.environment']).toBe('local');
  });

  it('embed 轨迹映射为 embedding 类型，且不带 usage/cost', () => {
    const span = svc.toSpan(trace({ name: 'embed:embedding-model', model: 'embedding-model' }));
    expect(span.attributes['langfuse.observation.type']).toBe('embedding');
    expect(span.attributes['langfuse.observation.usage_details']).toBeUndefined();
    expect(span.attributes['langfuse.observation.cost_details']).toBeUndefined();
  });

  it('token 用量与成本按 Langfuse 约定序列化', () => {
    const span = svc.toSpan(trace());
    const usage = JSON.parse(span.attributes['langfuse.observation.usage_details'] as string);
    expect(usage).toEqual({ input: 120, output: 45, total: 165 });
    const cost = JSON.parse(span.attributes['langfuse.observation.cost_details'] as string);
    expect(cost.total).toBeCloseTo(0.00123456, 8);
  });

  it('同时下发 GenAI 语义约定 —— 实测 Langfuse 只解析这一套用量/成本', () => {
    const span = svc.toSpan(trace());
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(120);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(45);
    expect(span.attributes['gen_ai.usage.total_tokens']).toBe(165);
    expect(span.attributes['gen_ai.usage.cost']).toBeCloseTo(0.00123456, 8);
    expect(span.attributes['gen_ai.request.model']).toBe('smart-model');
    expect(span.attributes['gen_ai.response.model']).toBe('smart-model');
    expect(span.attributes['gen_ai.operation.name']).toBe('chat');
  });

  it('嵌入类型不带用量与成本', () => {
    const span = svc.toSpan(trace({ name: 'embed:embedding-model' }));
    expect(span.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(span.attributes['gen_ai.usage.cost']).toBeUndefined();
    expect(span.attributes['gen_ai.operation.name']).toBe('embeddings');
  });

  it('自定义元数据带 metadata 前缀（否则 Langfuse 无法过滤）', () => {
    const span = svc.toSpan(trace());
    expect(span.attributes['langfuse.observation.metadata.provider']).toBe('minimax');
    expect(span.attributes['langfuse.observation.metadata.latencyMs']).toBe(820);
    expect(span.attributes['langfuse.observation.metadata.tenant_id']).toBe('t-default');
  });

  it('输入输出序列化为 JSON 字符串', () => {
    const span = svc.toSpan(trace());
    expect(JSON.parse(span.attributes['langfuse.observation.input'] as string)).toEqual([
      { role: 'user', content: '你好' },
    ]);
    expect(JSON.parse(span.attributes['langfuse.observation.output'] as string)).toEqual({ content: '在的' });
  });

  it('traceId 规范为 32 位十六进制，spanId 为 16 位', () => {
    const span = svc.toSpan(trace({ traceId: 'not-hex-at-all' }));
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('同一 traceId + name 派生稳定 spanId', () => {
    const a = svc.toSpan(trace());
    const b = svc.toSpan(trace());
    expect(a.spanId).toBe(b.spanId);
  });

  it('开始/结束时间为纳秒且结束不早于开始', () => {
    const span = svc.toSpan(trace());
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    expect(start).toBeGreaterThan(0n);
    expect(end).toBeGreaterThanOrEqual(start);
  });
});

describe('OTLP 导出', () => {
  it('未配置端点时不发起请求', async () => {
    const noop = new TracingService(fakeStore, {
      otlpEndpoint: '',
      publicKey: '',
      secretKey: '',
      ingestionVersion: '4',
      environment: 'local',
      serviceName: 'agentgateway',
    });
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true } as Response;
    }) as typeof fetch;
    try {
      await noop.exportSpan(noop.toSpan(trace()));
    } finally {
      globalThis.fetch = orig;
    }
    expect(calls).toHaveLength(0);
  });

  it('导出到 {base}/v1/traces 并带 Basic 鉴权与版本头', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers ?? {};
      return { ok: true } as Response;
    }) as typeof fetch;
    try {
      await svc.exportSpan(svc.toSpan(trace()));
    } finally {
      globalThis.fetch = orig;
    }
    expect(capturedUrl).toBe('http://127.0.0.1:3001/api/public/otel/v1/traces');
    expect(capturedHeaders['x-langfuse-ingestion-version']).toBe('4');
    expect(capturedHeaders.authorization).toBe(
      `Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`,
    );
  });
});
