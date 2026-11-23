/**
 * 只读 SQL 沙箱 —— 对应 DB-GPT「沙箱执行（带超时与资源限制）」（见 6.1 调用链路第 4 步）。
 *
 * 三重限制：
 *   1) 语句级 —— 仅允许 SELECT / WITH，拒绝 DDL 与写操作
 *   2) 资源级 —— 只读连接 + 结果行数上限 + worker 线程内存隔离
 *   3) 时间级 —— worker 超时强制终止
 */
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync } from 'node:fs';

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|truncate|pragma|attach|detach|vacuum|reindex|grant|revoke|begin|commit|rollback|savepoint)\b/i;

export interface SqlExecResult {
  ok: boolean;
  columns: string[];
  rows: any[];
  error?: string;
}

/** 语句级校验 */
export function validateReadOnly(sql: string): { ok: boolean; error?: string } {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: 'SQL 为空' };
  // 先识别写操作/DDL，给出更精确的拒绝原因
  if (FORBIDDEN.test(trimmed)) {
    return { ok: false, error: '检测到写操作或 DDL，已拒绝执行' };
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    return { ok: false, error: '仅允许 SELECT / WITH 只读查询' };
  }
  // 多语句拦截
  const withoutStrings = trimmed.replace(/'[^']*'/g, "''");
  if (withoutStrings.includes(';')) {
    return { ok: false, error: '仅允许单条语句' };
  }
  return { ok: true };
}

const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
(async () => {
  try {
    const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const stmt = db.prepare(workerData.sql);
    const columns = stmt.columns().map((column) => column.name);
    const rows = [];
    for (const row of stmt.iterate()) {
      rows.push(row);
      if (rows.length >= workerData.maxRows) break;
    }
    await db.close();
    parentPort.postMessage({ ok: true, columns, rows });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
  }
})();
`;

/** 在 worker 中执行只读 SQL，带超时 */
export async function runReadOnlySql(
  dbPath: string,
  sql: string,
  timeoutMs = 5000,
  maxRows = 1000,
): Promise<SqlExecResult> {
  const check = validateReadOnly(sql);
  if (!check.ok) return { ok: false, columns: [], rows: [], error: check.error };

  if (!existsSync(dbPath)) {
    return { ok: false, columns: [], rows: [], error: `数据库不存在：${dbPath}` };
  }

  // 行数上限：缺失 LIMIT 时自动追加；worker 还会按 rowLimit 停止迭代。
  const rowLimit = Math.min(10_000, Math.max(1, Math.floor(maxRows) || 1000));
  let bounded = sql.trim().replace(/;\s*$/, '');
  if (!/\blimit\b/i.test(bounded)) {
    bounded += ` LIMIT ${rowLimit}`;
  }

  return new Promise<SqlExecResult>((resolve) => {
    let settled = false;
    const finish = (r: SqlExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };

    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { dbPath, sql: bounded, maxRows: rowLimit },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });

    const timer = setTimeout(() => {
      finish({ ok: false, columns: [], rows: [], error: `SQL 执行超时（${timeoutMs}ms），已终止` });
    }, timeoutMs);

    worker.on('message', (msg: SqlExecResult) => finish(msg));
    worker.on('error', (err) =>
      finish({ ok: false, columns: [], rows: [], error: `沙箱异常：${err.message}` }),
    );
    worker.on('exit', (code) => {
      if (!settled) {
        finish({ ok: false, columns: [], rows: [], error: `沙箱进程退出，code=${code}` });
      }
    });
  });
}
