import type { Identity, SessionRecord } from '@eap/platform-core';

export function hasSessionAccess(session: SessionRecord, identity: Identity): boolean {
  return session.tenantId === identity.tenantId && session.userId === identity.userId;
}
