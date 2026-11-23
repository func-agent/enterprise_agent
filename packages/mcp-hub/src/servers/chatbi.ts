/**
 * chatbi MCP Server —— 对应 DB-GPT MCP Server 职责（见 6.1 DB-GPT 调用链路）。
 *
 * 链路：AgentScope → agentgateway（鉴权/白名单/脱敏）→ 本 Server
 *      → Text2SQL 生成 → 沙箱执行（超时 + 资源限制 + 只读）→ 图表 / 分析报告
 *
 * 关键约束（见 6.2 关键配置）：
 *   - 数据源账号只读最小权限
 *   - 写操作一律禁止
 *   - 指标口径必须写清（配合指标口径字典）
 */
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { errorResult, textResult, type McpToolDef } from '../server-base.js';
import { callGateway } from '../gateway-client.js';
import { runReadOnlySql } from '../sandbox.js';
import { ctxFrom } from './knowledge.js';
import METRIC_DICTIONARY_DATA from './metrics.json' with { type: 'json' };

/**
 * 指标口径字典（见 5.2 语义层治理、12 风险 6：指标口径混乱）。
 * 生产形态为独立的元知识库并进 RAGFlow。
 *
 * 本文件抽成 JSON 是为了**单一数据源**：DB-GPT 的 MCP Server 适配器
 * （deploy/compose/dbgpt/mcp_adapter.py）挂载的是同一个文件，两边口径不会漂移。
 */
export const METRIC_DICTIONARY = METRIC_DICTIONARY_DATA;

/** 数据源 schema 描述，供 Text2SQL 使用 */
export const CHATBI_SCHEMA = `
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,      -- 订单号
  order_date TEXT NOT NULL,    -- 下单日期 YYYY-MM-DD
  region TEXT NOT NULL,        -- 大区：华东/华北/华南/西南
  dept TEXT NOT NULL,          -- 事业部
  customer TEXT NOT NULL,      -- 客户
  amount REAL NOT NULL,        -- 订单金额
  status TEXT NOT NULL         -- 状态：paid/refunded/pending
);
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,      -- 发票号
  invoice_date TEXT NOT NULL,  -- 开票日期
  order_id INTEGER NOT NULL,
  amount REAL NOT NULL,        -- 发票金额（含税）
  status TEXT NOT NULL         -- issued/void
);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,      -- 回款单号
  payment_date TEXT NOT NULL,  -- 到账日期
  invoice_id INTEGER NOT NULL,
  amount REAL NOT NULL,        -- 实收金额
);
`.trim();

const TEXT2SQL_SYSTEM = `你是企业数据分析助手。根据给定的数据库 schema 和指标口径字典，把用户问题翻译成一条只读 SQL。
硬性要求：
1. 只输出单条 SQL，以 SELECT 开头，禁止任何 INSERT/UPDATE/DELETE/DDL。
2. 必须使用给定口径字典中的表和字段，日期用 YYYY-MM-DD 字符串比较。
3. 涉及"环比/同比"时用子查询对比上一个周期。
4. 只返回 SQL，不要解释。`;

function buildPrompt(question: string, caliber: string): string {
  const dict = METRIC_DICTIONARY.map(
    (m) => `- ${m.metric}（${m.caliber}）：${m.definition}；表 ${m.table}，字段 ${m.field}${m.filter !== '1=1' ? `，过滤 ${m.filter}` : ''}`,
  ).join('\n');
  return [
    `数据库 schema：\n${CHATBI_SCHEMA}`,
    `指标口径字典：\n${dict}`,
    `本次查询口径偏好：${caliber}`,
    `用户问题：${question}`,
  ].join('\n\n');
}

/** 抽取 SQL */
function extractSql(text: string): string | undefined {
  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const m = candidate.match(/(SELECT[\s\S]*)/i);
  const sql = (m?.[1] ?? candidate).trim();
  if (!/^select\b/i.test(sql)) return undefined;
  // 去掉尾部多余说明
  return sql.replace(/;+\s*$/, '').trim();
}

/** 简单的图表规格推导 */
function buildChart(rows: any[], question: string) {
  if (!rows.length) return undefined;
  const cols = Object.keys(rows[0]);
  const type = /趋势|走势|变化/.test(question)
    ? 'line'
    : /占比|构成|比例/.test(question)
      ? 'pie'
      : 'bar';

  // 单列聚合结果：无维度列，用通用标签
  if (cols.length === 1) {
    const col = cols[0];
    return {
      type,
      x: 'category',
      y: col,
      title: question,
      data: rows.map((r) => ({ category: '结果', [col]: r[col] })),
    };
  }

  const labelCol =
    cols.find((c) => /date|month|region|dept|customer|name|category|label/i.test(c)) ?? cols[0];
  const valueCol =
    cols.find((c) => c !== labelCol && /amount|count|total|value|num|qty/i.test(c)) ??
    cols.find((c) => c !== labelCol) ??
    cols[cols.length - 1];
  return {
    type,
    x: labelCol,
    y: valueCol,
    title: question,
    data: rows.map((r) => ({ [labelCol]: r[labelCol], [valueCol]: r[valueCol] })),
  };
}

export function createChatbiTools(dbPath: string): McpToolDef[] {
  return [
    {
      name: 'chatbi.query',
      title: '自助查数',
      description:
        '自然语言查数。生成只读 SQL → 沙箱执行 → 返回表格与图表规格。口径：默认下单口径销售额。',
      inputSchema: {
        question: z.string().describe('自然语言问题，如「上月华东区销售额环比多少」'),
        caliber: z.enum(['下单口径', '开票口径', '回款口径']).optional().describe('口径，默认下单口径'),
      },
      meta: { requiresConfirmation: false, sensitivity: 'internal', dataScope: 'sales.*' },
      async handler(args) {
        const ctx = ctxFrom(args);
        const question = String(args.question ?? '').trim();
        const caliber = String(args.caliber ?? '下单口径');
        if (!question) return errorResult('问题不能为空');

        let sql: string | undefined;
        let llmError: string | undefined;
        try {
          const llm = await callGateway({
            model: 'reasoning-model',
            system: TEXT2SQL_SYSTEM,
            user: buildPrompt(question, caliber),
            maxTokens: 800,
            tenantId: ctx.tenant_id,
          });
          sql = extractSql(llm.content);
          if (!sql) llmError = `模型未返回可执行 SQL：${llm.content.slice(0, 200)}`;
        } catch (err: any) {
          return errorResult(`Text2SQL 调用失败：${err?.message ?? err}`);
        }
        if (!sql) return errorResult(llmError ?? 'SQL 生成失败');

        const exec = await runReadOnlySql(dbPath, sql, 5000);
        if (!exec.ok) return errorResult(`SQL 执行被拒绝或失败：${exec.error}`);

        const chart = buildChart(exec.rows, question);
        const tableText = exec.rows.length
          ? [
              `口径：${caliber}`,
              `SQL：${sql}`,
              `列：${exec.columns.join(', ')}`,
              '',
              exec.columns.map((c) => c).join(' | '),
              ...exec.rows.map((r: any) => exec.columns.map((c) => String(r[c] ?? '')).join(' | ')),
            ].join('\n')
          : `口径：${caliber}\nSQL：${sql}\n查询结果为空。`;

        return textResult(tableText, {
          caliber,
          sql,
          columns: exec.columns,
          rows: exec.rows,
          rowCount: exec.rows.length,
          chart,
        });
      },
    },
    {
      name: 'chatbi.list_metrics',
      title: '指标口径字典',
      description: '列出可用指标及其口径定义（同名指标多口径问题的统一出口）。',
      inputSchema: {},
      meta: { requiresConfirmation: false, sensitivity: 'internal', dataScope: 'metadata' },
      async handler() {
        const text = METRIC_DICTIONARY.map(
          (m) => `${m.metric}（${m.caliber}）：${m.definition}｜表 ${m.table}.${m.field}`,
        ).join('\n');
        return textResult(text, { metrics: METRIC_DICTIONARY });
      },
    },
    {
      name: 'chatbi.run_sql',
      title: '执行只读 SQL',
      description: '直接执行一条只读 SQL（禁止写操作）。仅用于调试与自助分析。',
      inputSchema: {
        sql: z.string().describe('单条 SELECT 语句'),
      },
      meta: { requiresConfirmation: false, sensitivity: 'internal', dataScope: 'sales.*' },
      async handler(args) {
        const exec = await runReadOnlySql(dbPath, String(args.sql ?? ''), 5000);
        if (!exec.ok) return errorResult(exec.error ?? 'SQL 执行失败');
        return textResult(
          exec.rows.length
            ? [exec.columns.join(' | '), ...exec.rows.map((r: any) => exec.columns.map((c) => String(r[c] ?? '')).join(' | '))].join('\n')
            : '查询结果为空。',
          { columns: exec.columns, rows: exec.rows },
        );
      },
    },
  ];
}
