/**
 * 审计服务（见 8.4 审计要求）。
 *
 * 全链路事件（LLM / 工具 / 管理 / 认证）双写：
 *   - 元数据库：可检索、可查询
 *   - 对象存储：脱敏后归档，保留 90 天以上（MinIO 版本化）
 */
import { createLogger, uuid, type AuditEvent, type Identity, type MetadataStore, type ObjectStore } from '@eap/platform-core';
import type { GuardrailService } from '../guardrails/index.js';

const log = createLogger('gateway:audit');

export interface AuditInput {
  kind: AuditEvent['kind'];
  identity: Identity;
  traceId: string;
  status: AuditEvent['status'];
  reason?: string;
  model?: string;
  provider?: string;
  tool?: string;
  serverId?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  sessionId?: string;
  appId?: string;
  detail?: Record<string, unknown>;
}

export class AuditService {
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
    private readonly guardrails?: GuardrailService,
  ) {}

  async record(input: AuditInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: uuid(),
      ts: new Date().toISOString(),
      kind: input.kind,
      tenantId: input.identity.tenantId,
      userId: input.identity.userId,
      role: input.identity.role,
      deptId: input.identity.deptId,
      appId: input.appId,
      sessionId: input.sessionId,
      traceId: input.traceId,
      model: input.model,
      provider: input.provider,
      tool: input.tool,
      serverId: input.serverId,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      costUsd: input.costUsd,
      status: input.status,
      reason: input.reason,
      detail: input.detail && this.guardrails
        ? this.guardrails.maskStructured(input.detail).value
        : input.detail,
    };

    await this.store.appendAudit(event);

    // 归档到对象存储（脱敏后的结构化 JSON）
    try {
      const day = event.ts.slice(0, 10);
      const key = `audit/${event.tenantId}/${day}/${event.id}.json`;
      await this.objects.put(key, JSON.stringify(event, null, 2), 'application/json');
    } catch (err) {
      log.error('审计归档写入对象存储失败', { eventId: event.id, error: String(err) });
    }

    return event;
  }

  async list(filter: { tenantId?: string; kind?: string; limit?: number }): Promise<AuditEvent[]> {
    return this.store.listAudit(filter);
  }

  /**
   * 按 trace 还原一次完整调用链（审计要求：审计日志可还原任一次调用）。
   */
  async reconstruct(traceId: string, tenantId?: string) {
    const events = await this.store.listAudit({ tenantId, limit: 1000 });
    const traces = await this.store.listTraces({ tenantId, limit: 1000 });
    return {
      traceId,
      events: events.filter((e) => e.traceId === traceId),
      traces: traces.filter((t) => t.traceId === traceId),
    };
  }
}
