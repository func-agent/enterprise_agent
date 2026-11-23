/**
 * HITL —— 人工确认（见 4.1：敏感操作（写库、发通知、调外部系统）注册为需人工确认的工具）。
 *
 * 流程：Agent 触发需确认工具 → 生成审批单（pending）→ 等待控制台审批
 *      → approved 执行 / rejected 跳过并回告模型。
 */
import { createLogger, uuid, type ApprovalRequest, type Identity, type MetadataStore } from '@eap/platform-core';

const log = createLogger('agent:hitl');

export type HitlDecision = 'approved' | 'rejected' | 'expired';

export class HitlManager {
  constructor(private readonly store: MetadataStore) {}

  /** 生成审批单并返回 */
  async request(params: {
    identity: Identity;
    sessionId: string;
    traceId: string;
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  }): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: uuid(),
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      sessionId: params.sessionId,
      traceId: params.traceId,
      tool: params.tool,
      args: params.args,
      reason: params.reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.store.createApproval(approval);
    log.info('已生成人工确认请求', { id: approval.id, tool: params.tool, sessionId: params.sessionId });
    return approval;
  }

  /** 轮询等待审批结果 */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<HitlDecision> {
    const deadline = Date.now() + timeoutMs;
    const interval = 1000;
    let tenantId: string | undefined;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('请求已取消（客户端已断开）');
      const approval = await this.store.getApproval(id);
      if (!approval) return 'expired';
      tenantId = approval.tenantId;
      if (approval.status === 'approved') return 'approved';
      if (approval.status === 'rejected') return 'rejected';
      if (approval.status === 'expired') return 'expired';
      await new Promise((r) => setTimeout(r, interval));
    }
    if (tenantId) {
      await this.store.transitionApproval(id, tenantId, 'pending', {
        status: 'expired',
        decidedAt: new Date().toISOString(),
      });
    }
    log.warn('人工确认超时', { id });
    return 'expired';
  }
}
