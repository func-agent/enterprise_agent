import type { Approval, Identity } from './types';

const APPROVER_ROLES = new Set(['admin', 'platform-admin', 'manager']);
const ADMIN_PAGE_ROLES = new Set(['admin', 'platform-admin']);

export function canViewAdminPages(identity: Identity): boolean {
  return ADMIN_PAGE_ROLES.has(identity.role);
}

export function canManageUsers(identity: Identity): boolean {
  return identity.role === 'platform-admin';
}

export function canDecideApproval(identity: Identity, approval: Approval): boolean {
  return (
    approval.status === 'pending' &&
    APPROVER_ROLES.has(identity.role) &&
    approval.userId !== identity.user_id
  );
}
