/**
 * business MCP Server —— 对应 ERP/CRM/OA 等业务系统的 MCP 封装（见 5.1 接入方式 ③/④）。
 *
 * 关键约束（见 6.2 / 7.2）：
 *   - 写操作一律禁止自动执行，必须走 HITL 人工确认（见 4.1）
 *   - 工具绑定业务角色，调用时透传 user_id/role 做行级过滤
 */
import { z } from 'zod';
import { errorResult, textResult, type McpToolDef } from '../server-base.js';
import { ctxFrom } from './knowledge.js';

/** 模拟业务数据（生产由 ERP/OA REST API → OpenAPI → MCP 转化封装，见 5.1 ③） */
const MOCK_TASKS = [
  { id: 'OA-2024-001', type: '报销单', title: '差旅报销 3,280 元', amount: 3280, status: 'pending', applicant: 'zhangsan', createdAt: '2024-11-02' },
  { id: 'OA-2024-002', type: '请假单', title: '年假 3 天', amount: 0, status: 'pending', applicant: 'lisi', createdAt: '2024-11-05' },
  { id: 'OA-2024-003', type: '用印申请', title: '合同用印（华东大区）', amount: 0, status: 'approved', applicant: 'zhangsan', createdAt: '2024-10-28' },
  { id: 'ERP-2024-077', type: '采购单', title: '服务器采购 12 台', amount: 156000, status: 'pending', applicant: 'wangwu', createdAt: '2024-11-06' },
];

const MOCK_CONTRACTS = [
  { no: 'HT-2024-0088', name: '华东区年度采购框架协议', party: '某某科技有限公司', amount: 12000000, startDate: '2024-01-01', endDate: '2024-12-31', dept: '华东' },
  { no: 'HT-2024-0102', name: '数据中心运维服务协议', party: '某某信息技术服务有限公司', amount: 3600000, startDate: '2024-07-01', endDate: '2025-06-30', dept: 'IT' },
  { no: 'HT-2023-0517', name: '渠道分销补充协议', party: '某某贸易有限公司', amount: 2400000, startDate: '2023-10-01', endDate: '2024-09-30', dept: '华南' },
];

/** 行级过滤 —— 只能看到与自己部门/角色相关的记录 */
function visibleByScope<T extends { dept?: string; applicant?: string }>(rows: T[], ctx: { dept_id: string; user_id: string; role: string }): T[] {
  if (ctx.role === 'admin' || ctx.role === 'platform-admin') return rows;
  return rows.filter((r) => !r.dept || r.dept === 'all' || r.dept === ctx.dept_id || r.applicant === ctx.user_id);
}

export function createBusinessTools(): McpToolDef[] {
  return [
    {
      name: 'business.query_todo',
      title: '查询待办',
      description: '查询当前用户的 OA/ERP 待办事项（报销、请假、用印、采购等）。',
      inputSchema: {
        status: z.enum(['pending', 'approved', 'all']).optional().describe('状态过滤，默认 pending'),
      },
      meta: { requiresConfirmation: false, sensitivity: 'internal', dataScope: 'dept' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const status = String(args.status ?? 'pending');
        let rows = MOCK_TASKS;
        if (status !== 'all') rows = rows.filter((r) => r.status === status);
        rows = visibleByScope(rows, ctx);
        if (!rows.length) return textResult('当前没有符合条件的待办事项。', { count: 0, tasks: [] });
        return textResult(
          rows.map((r) => `${r.id} | ${r.type} | ${r.title} | 金额 ${r.amount} | 状态 ${r.status} | 申请人 ${r.applicant}`).join('\n'),
          { count: rows.length, tasks: rows },
        );
      },
    },
    {
      name: 'business.query_contract',
      title: '查询合同',
      description: '按合同编号或关键字查询合同要素。',
      inputSchema: {
        keyword: z.string().describe('合同编号或名称关键字'),
      },
      meta: { requiresConfirmation: false, sensitivity: 'confidential', dataScope: 'dept' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const kw = String(args.keyword ?? '').trim().toLowerCase();
        const rows = visibleByScope(
          MOCK_CONTRACTS.filter(
            (c) => !kw || c.no.toLowerCase().includes(kw) || c.name.toLowerCase().includes(kw),
          ),
          ctx,
        );
        if (!rows.length) return textResult('未找到匹配的合同。', { count: 0, contracts: [] });
        return textResult(
          rows
            .map(
              (c) =>
                `${c.no} | ${c.name} | 对方 ${c.party} | 金额 ${c.amount} | 期间 ${c.startDate}~${c.endDate} | 部门 ${c.dept}`,
            )
            .join('\n'),
          { count: rows.length, contracts: rows },
        );
      },
    },
    {
      name: 'business.write.submit_expense',
      title: '提交报销单',
      description: '提交报销单（写操作，必须人工确认后才会真正执行）。',
      inputSchema: {
        amount: z.number().describe('报销金额'),
        title: z.string().describe('费用事由'),
        category: z.string().optional().describe('费用类别'),
      },
      meta: { requiresConfirmation: true, sensitivity: 'internal', dataScope: 'write' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const id = `EXP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
        const amount = Number(args.amount ?? 0);
        return textResult(
          `报销单 ${id} 已提交：${args.title ?? '未填写事由'}，金额 ${amount}，提交人 ${ctx.user_id}。`,
          { id, amount, applicant: ctx.user_id },
        );
      },
    },
    {
      name: 'business.write.approve_task',
      title: '审批待办',
      description: '审批或驳回一条待办（写操作，必须人工确认后才会真正执行）。',
      inputSchema: {
        taskId: z.string().describe('待办 ID'),
        action: z.enum(['approve', 'reject']).describe('审批动作'),
        comment: z.string().optional().describe('审批意见'),
      },
      meta: { requiresConfirmation: true, sensitivity: 'internal', dataScope: 'write' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const taskId = String(args.taskId ?? '');
        const action = String(args.action ?? 'approve');
        const found = MOCK_TASKS.find((t) => t.id === taskId);
        if (!found) return errorResult(`待办不存在：${taskId}`);
        if (ctx.role !== 'admin' && ctx.role !== 'manager') {
          return errorResult(`当前角色 ${ctx.role} 无审批权限`);
        }
        return textResult(
          `待办 ${taskId} 已${action === 'approve' ? '通过' : '驳回'}（审批人 ${ctx.user_id}${args.comment ? `，意见：${args.comment}` : ''}）。`,
          { taskId, action },
        );
      },
    },
  ];
}
