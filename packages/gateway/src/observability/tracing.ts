/**
 * Trace 记录与 OTel 导出（见 4.1「原生 OpenTelemetry 埋点直推 Langfuse」、4.3「OTel 埋点 全链路 Trace → Langfuse」）。
 *
 * 双写：
 *   - 本地元数据库（可查询、可降级）
 *   - OTLP/HTTP JSON → Langfuse（生产唯一观测点）
 *
 * Langfuse v3 OTLP 接入要点（依据官方属性映射表）：
 *   - 端点    : {base}/api/public/otel + /v1/traces
 *   - 鉴权    : Authorization: Basic base64(pk-lf-xxx:sk-lf-xxx)
 *   - 即时入库: x-langfuse-ingestion-version: 4
 *   - 观察类型: span / generation / embedding / agent / tool / chain / retriever ...
 */
import { createLogger, type MetadataStore, type TraceRecord } from '@eap/platform-core';

const log = createLogger('gateway:tracing');

export interface SpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: number; message?: string };
}

/** OTLP AnyValue —— HTTP/JSON 编码 */
type OtlpValue =
  | { stringValue: string }
  | { intValue: number }
  | { doubleValue: number }
  | { boolValue: boolean };

function toOtlpValue(v: string | number | boolean): OtlpValue {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  }
  return { stringValue: v };
}

/** 保证 32 位十六进制 traceId */
function normalizeTraceId(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length === 32) return hex;
  return hex.padEnd(32, '0').slice(0, 32).padStart(32, '0');
}

/** 由 traceId+name 派生稳定的 16 位 spanId */
function deriveSpanId(seed: string): string {
  // FNV-1a 32 位 → 取 16 位十六进制
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(2);
}

/** 观察类型推断 —— 决定 Langfuse 里的 Observation Type */
function observationType(name: string): string {
  if (name.startsWith('chat:')) return 'generation';
  if (name.startsWith('embed:')) return 'embedding';
  if (name.startsWith('agent:')) return 'agent';
  if (name.startsWith('tool:')) return 'tool';
  if (name.startsWith('mcp:')) return 'tool';
  return 'span';
}

export interface TracingOptions {
  /** OTLP 接收端 base，例如 http://127.0.0.1:3001/api/public/otel */
  otlpEndpoint: string;
  /** Langfuse 公钥（pk-lf-...） */
  publicKey: string;
  /** Langfuse 私钥（sk-lf-...） */
  secretKey: string;
  /** 即时入库版本头，4 = v4 数据模型实时可见 */
  ingestionVersion: string;
  /** 平台环境标识 */
  environment: string;
  serviceName: string;
  timeoutMs?: number;
}

export class TracingService {
  private readonly authHeader?: string;

  constructor(
    private readonly store: MetadataStore,
    private readonly options: TracingOptions,
  ) {
    if (options.publicKey && options.secretKey) {
      this.authHeader = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64')}`;
    } else if (options.otlpEndpoint) {
      log.warn('Langfuse 凭证未配置，OTLP 导出将不带鉴权头', {});
    }
  }

  /** 记录 Trace：本地落库 + OTLP 导出（导出失败不影响主链路） */
  async record(trace: TraceRecord): Promise<void> {
    try {
      await this.store.appendTrace(trace);
    } catch (err) {
      log.error('Trace 本地落库失败', { traceId: trace.traceId, error: String(err) });
    }
    try {
      await this.exportSpan(this.toSpan(trace));
    } catch (err) {
      log.warn('Trace OTLP 导出失败', { traceId: trace.traceId, error: String(err) });
    }
  }

  /** TraceRecord → Langfuse 属性映射 */
  toSpan(trace: TraceRecord): SpanPayload {
    const type = observationType(trace.name);
    const start = Date.parse(trace.ts);
    const endMs = Number(trace.metadata?.latencyMs ?? 0) + (Number.isFinite(start) ? start : Date.now());
    const startMs = Number.isFinite(start) ? start : Date.now();

    const attributes: Record<string, string | number | boolean> = {
      'langfuse.observation.name': trace.name,
      'langfuse.observation.type': type,
      'langfuse.trace.name': trace.name,
      'langfuse.trace.id': normalizeTraceId(trace.traceId),
      'langfuse.user.id': trace.userId,
      'langfuse.environment': this.options.environment,
      'langfuse.version': 'eap-platform/1.0',
    };
    if (trace.sessionId) attributes['langfuse.session.id'] = trace.sessionId;
    if (trace.model) attributes['langfuse.observation.model.name'] = trace.model;

    if (trace.input !== undefined) {
      attributes['langfuse.observation.input'] = JSON.stringify(trace.input);
    }
    if (trace.output !== undefined) {
      attributes['langfuse.observation.output'] = JSON.stringify(trace.output);
    }

    // token 用量 / 成本 —— 仅 generation 类型生效
    // 同时下发两套：Langfuse 专有 JSON 串 + OTEL GenAI 语义约定（两者都被 Langfuse 识别）
    if (type === 'generation') {
      const total = trace.promptTokens + trace.completionTokens;
      attributes['langfuse.observation.usage_details'] = JSON.stringify({
        input: trace.promptTokens,
        output: trace.completionTokens,
        total,
      });
      attributes['langfuse.observation.cost_details'] = JSON.stringify({
        total: Number(trace.costUsd.toFixed(8)),
      });
      attributes['gen_ai.usage.input_tokens'] = trace.promptTokens;
      attributes['gen_ai.usage.output_tokens'] = trace.completionTokens;
      attributes['gen_ai.usage.total_tokens'] = total;
      attributes['gen_ai.usage.cost'] = Number(trace.costUsd.toFixed(8));
    }

    // GenAI 语义约定（Langfuse 与 OpenTelemetry 生态通用）
    if (trace.model) {
      attributes['gen_ai.request.model'] = trace.model;
      attributes['gen_ai.response.model'] = trace.model;
    }
    attributes['gen_ai.operation.name'] = type === 'generation' ? 'chat' : 'embeddings';

    // 平台自定义元数据 —— 用 langfuse.observation.metadata.<key> 前缀才能在 Langfuse 顶层过滤
    for (const [k, v] of Object.entries(trace.metadata ?? {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') {
        attributes[`langfuse.observation.metadata.${k}`] = JSON.stringify(v);
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        attributes[`langfuse.observation.metadata.${k}`] = v;
      }
    }
    attributes['langfuse.observation.metadata.tenant_id'] = trace.tenantId;

    return {
      traceId: normalizeTraceId(trace.traceId),
      spanId: deriveSpanId(`${trace.traceId}:${trace.name}`),
      name: trace.name,
      startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
      endTimeUnixNano: String(BigInt(Math.max(endMs, startMs)) * 1_000_000n),
      attributes,
      status: { code: 1 },
    };
  }

  /** 导出 span 到 OTLP 接收端（Langfuse OTLP 端口 4318） */
  async exportSpan(span: SpanPayload): Promise<void> {
    if (!this.options.otlpEndpoint) return;
    const url = `${this.options.otlpEndpoint.replace(/\/$/, '')}/v1/traces`;
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: this.options.serviceName } },
              { key: 'telemetry.sdk.name', value: { stringValue: 'eap-platform' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'eap-platform' },
              spans: [
                {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                  name: span.name,
                  kind: 1,
                  startTimeUnixNano: span.startTimeUnixNano,
                  endTimeUnixNano: span.endTimeUnixNano,
                  attributes: Object.entries(span.attributes).map(([key, value]) => ({
                    key,
                    value: toOtlpValue(value),
                  })),
                  status: span.status ?? { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.authHeader) headers.authorization = this.authHeader;
    if (this.options.ingestionVersion) {
      headers['x-langfuse-ingestion-version'] = this.options.ingestionVersion;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn('OTLP 导出失败', { status: res.status, traceId: span.traceId, body: text.slice(0, 200) });
      }
    } catch (err) {
      log.warn('OTLP 导出异常', { error: String(err) });
    }
  }
}
