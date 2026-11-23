import { randomUUID } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

/** trace_id：Langfuse 对齐字段（见 8.4 审计要求 —— 含 tenant/user/session/trace_id） */
export function traceId(): string {
  return randomUUID().replace(/-/g, '');
}

/** 稳定的请求摘要，用于审计留痕而不落原文 */
export async function digest(value: unknown): Promise<string> {
  const { createHash } = await import('node:crypto');
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** 月份键，用于预算周期（见 4.3 三级预算） */
export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
