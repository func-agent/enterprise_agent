import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalCard } from '../apps/webui/src/components/ApprovalCard';
import { canAccessTab, type TabKey } from '../apps/webui/src/components/AppSidebar';
import { canDecideApproval, canManageUsers, canViewAdminPages } from '../apps/webui/src/permissions';
import type { Approval, Identity } from '../apps/webui/src/types';

const requester: Identity = {
  tenant_id: 't-1',
  user_id: 'u-1',
  role: 'employee',
  dept_id: 'd-1',
  sensitivity: 'internal',
};

const pendingApproval: Approval = {
  id: 'a-1',
  tenantId: 't-1',
  userId: 'u-2',
  sessionId: 's-1',
  traceId: 'trace-1',
  tool: 'knowledge.upsert_document',
  args: {},
  reason: 'test',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderCard(identity: Identity, approval: Approval): string {
  return renderToStaticMarkup(createElement(ApprovalCard, { identity, approval, onDecide: () => undefined }));
}

describe('审批操作显示权限', () => {
  it('普通员工只能看到只读等待状态', () => {
    const approval = { ...pendingApproval, userId: requester.user_id };
    const html = renderCard(requester, approval);
    expect(canDecideApproval(requester, approval)).toBe(false);
    expect(html).toContain('等待其他审批人处理');
    expect(html).not.toContain('>批准<');
    expect(html).not.toContain('>驳回<');
  });

  it('审批角色可以处理其他用户发起的待审批单', () => {
    for (const role of ['manager', 'admin', 'platform-admin']) {
      const identity = { ...requester, role };
      expect(canDecideApproval(identity, pendingApproval)).toBe(true);
      const html = renderCard(identity, pendingApproval);
      expect(html).toContain('>批准<');
      expect(html).toContain('>驳回<');
    }
  });

  it('审批角色也不能处理自己发起的工单', () => {
    const identity = { ...requester, role: 'manager' };
    const approval = { ...pendingApproval, userId: identity.user_id };
    const html = renderCard(identity, approval);
    expect(canDecideApproval(identity, approval)).toBe(false);
    expect(html).toContain('等待其他审批人处理');
    expect(html).not.toContain('>批准<');
  });

  it('已处理工单不显示审批操作', () => {
    const identity = { ...requester, role: 'manager' };
    const approval = { ...pendingApproval, status: 'executed' };
    const html = renderCard(identity, approval);
    expect(canDecideApproval(identity, approval)).toBe(false);
    expect(html).not.toContain('>批准<');
    expect(html).not.toContain('等待其他审批人处理');
  });
});


describe('管理页面访问权限', () => {
  it('普通员工和主管不能访问平台预算与审计页面', () => {
    for (const role of ['employee', 'manager']) {
      expect(canViewAdminPages({ ...requester, role })).toBe(false);
    }
  });

  it('普通员工和主管只能访问工作空间，不能进入厂商、模型、预算与审计管理', () => {
    const workspaceTabs: TabKey[] = ['chat', 'knowledge', 'approvals', 'tools'];
    const adminTabs: TabKey[] = ['providers', 'models', 'budget', 'audit'];
    for (const role of ['employee', 'manager']) {
      const identity = { ...requester, role };
      for (const tab of workspaceTabs) expect(canAccessTab(identity, tab)).toBe(true);
      for (const tab of adminTabs) expect(canAccessTab(identity, tab)).toBe(false);
    }
  });

  it('用户与权限页面仅平台管理员可访问', () => {
    for (const role of ['employee', 'manager', 'admin']) {
      const identity = { ...requester, role };
      expect(canManageUsers(identity)).toBe(false);
      expect(canAccessTab(identity, 'users')).toBe(false);
    }
    const identity = { ...requester, role: 'platform-admin' };
    expect(canManageUsers(identity)).toBe(true);
    expect(canAccessTab(identity, 'users')).toBe(true);
  });

  it('管理员与平台管理员可以访问各自的管理页面和全部工作空间页面', () => {
    const tabs: TabKey[] = ['chat', 'knowledge', 'approvals', 'tools', 'providers', 'models', 'budget', 'audit'];
    for (const role of ['admin', 'platform-admin']) {
      const identity = { ...requester, role };
      expect(canViewAdminPages(identity)).toBe(true);
      for (const tab of tabs) expect(canAccessTab(identity, tab)).toBe(true);
    }
  });
});
