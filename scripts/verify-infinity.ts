/**
 * Infinity 检索引擎验收脚本 —— 用真实引擎验证「过滤下推 + 混合召回 + 幂等写入」。
 *
 * 用法：
 *   npx tsx scripts/verify-infinity.ts
 *
 * 环境变量：
 *   INFINITY_BASE_URL         默认 http://127.0.0.1:23821
 *   INFINITY_VERIFY_DATABASE  默认 eap_kb_verify（**验收专用库**）
 *   INFINITY_VERIFY_TABLE     默认 verify_infinity_chunks（**验收专用表**）
 *
 * ⚠ 必须在**独立库表**上跑，绝不能指向生产库表。
 * 原因：InfinityClient.init() 会校验向量列维度，不一致时走 DELETE + CREATE 重建表。
 * 在生产表上跑验收会 ①把生产表改成验收的低维度 ②清空表里全部知识库向量。
 * 历史上正是这个副作用导致平台检索静默降级成本地 BM25（见 docs/operations.md 9.1.11）。
 * 因此这里额外做了防呆：库表与生产值相同时直接拒绝执行。
 *
 * 验收要点（对应方案 5.2「禁止全库召回后再过滤」）：
 *   A. 可见文档能被召回
 *   B. 密级/部门不可见的文档不出现
 *   C. 密级/部门放宽后可见
 *   D. 跨租户文档不出现
 *   E. 重复写入不产生副本
 */
import { InfinityClient } from '../packages/mcp-hub/src/retrieval/infinity.js';

const BASE = process.env.INFINITY_BASE_URL ?? 'http://127.0.0.1:23821';
/** 验收专用库表 —— 刻意与生产隔离 */
const DB = process.env.INFINITY_VERIFY_DATABASE ?? 'eap_kb_verify';
const TABLE = process.env.INFINITY_VERIFY_TABLE ?? 'verify_infinity_chunks';
/** 生产库表 —— 仅用于防呆比对 */
const PROD_DB = process.env.INFINITY_DATABASE ?? 'eap_kb';
const PROD_TABLE = process.env.INFINITY_TABLE ?? 'eap_knowledge_chunks';

let pass = 0;
let fail = 0;
function ok(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
  pass++;
}
function bad(msg: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  fail++;
}
function check(msg: string, cond: boolean, detail?: string) {
  if (cond) ok(msg);
  else bad(msg + (detail ? `（${detail}）` : ''));
}

async function main() {
  // —— 防呆：绝不允许在生产库表上执行验收
  if (DB === PROD_DB && TABLE === PROD_TABLE) {
    console.error(
      `\x1b[31m拒绝执行：验收库表与生产库表相同（db=${DB} table=${TABLE}）。\x1b[0m\n` +
        '验收会重建表并清空全部知识库向量，请改用独立的 INFINITY_VERIFY_DATABASE / INFINITY_VERIFY_TABLE。',
    );
    process.exit(1);
  }

  console.log(`\n\x1b[1m▸ Infinity 检索引擎验收\x1b[0m  base=${BASE} db=${DB} table=${TABLE}\n`);

  const c = new InfinityClient({
    baseUrl: BASE,
    database: DB,
    table: TABLE,
    dimensions: 4,
    timeoutMs: 60_000,
  });

  const ready = await c.init();
  check('引擎连接并建表成功', ready, '初始化失败');
  if (!ready) {
    console.log(`\n\x1b[31m失败 ${fail} 项\x1b[0m\n`);
    process.exit(1);
  }
  ok(`能力探测：vector=${c.capabilities.vector} fullText=${c.capabilities.fullText}`);

  const now = new Date().toISOString();
  const rows = [
    { docId: 'vfy-d1', tenantId: 't-default', deptId: 'dept-general', sensitivity: 'internal', title: '差旅住宿标准', content: '一线城市住宿标准每晚 600 元，超标需事前审批。', updatedAt: now, embedding: [1, 0, 0, 0] },
    { docId: 'vfy-d2', tenantId: 't-default', deptId: 'dept-general', sensitivity: 'internal', title: '年假制度', content: '入职满 1 年可享受 5 天带薪年假，最多结转 3 天。', updatedAt: now, embedding: [0, 1, 0, 0] },
    { docId: 'vfy-d3', tenantId: 't-default', deptId: 'dept-secret', sensitivity: 'confidential', title: '绝密并购方案', content: '绝密：拟收购标的估值 12 亿元。', updatedAt: now, embedding: [0, 0, 1, 0] },
    { docId: 'vfy-d4', tenantId: 't-other', deptId: 'all', sensitivity: 'public', title: '其他租户公告', content: '其他租户的公开公告内容。', updatedAt: now, embedding: [0, 0, 0, 1] },
  ];
  let wrote = 0;
  for (const r of rows) if (await c.upsert(r)) wrote++;
  check('4 条文档写入成功', wrote === 4, `实际 ${wrote}`);

  // A. 可见文档可召回
  const a = await c.search('住宿标准', { tenantId: 't-default', deptId: 'dept-general', maxSensitivity: 'internal' }, 5, [1, 0.1, 0, 0]);
  check('A. 可见文档被召回', a.some((h) => h.docId === 'vfy-d1'), `命中 ${a.map((h) => h.docId).join(',')}`);
  check('A. 同一文档不重复出现', new Set(a.map((h) => h.docId)).size === a.length, `命中 ${a.length} 条 / 去重后 ${new Set(a.map((h) => h.docId)).size}`);

  // B. 密级 + 部门不可见文档不出现
  const b = await c.search('并购', { tenantId: 't-default', deptId: 'dept-general', maxSensitivity: 'internal' }, 5, [0, 0, 1, 0]);
  check('B. 密级/部门不可见的文档被过滤', !b.some((h) => h.docId === 'vfy-d3'), `命中 ${b.map((h) => h.docId).join(',')}`);

  // C. 放宽密级与部门后可见
  const cc = await c.search('并购', { tenantId: 't-default', deptId: 'dept-secret', maxSensitivity: 'confidential' }, 5, [0, 0, 1, 0]);
  check('C. 放宽密级/部门后可见', cc.some((h) => h.docId === 'vfy-d3'), `命中 ${cc.map((h) => h.docId).join(',')}`);

  // D. 跨租户隔离
  const d = await c.search('公告', { tenantId: 't-default', deptId: 'dept-general', maxSensitivity: 'internal' }, 10, [0, 0, 0, 1]);
  check('D. 跨租户文档被隔离', !d.some((h) => h.docId === 'vfy-d4'), `命中 ${d.map((h) => h.docId).join(',')}`);

  // E. 幂等：重复写入同一批文档后不产生副本
  for (const r of rows) await c.upsert(r);
  const again = await c.search('住宿标准', { tenantId: 't-default', deptId: 'dept-general', maxSensitivity: 'internal' }, 20, [1, 0.1, 0, 0]);
  const dupCount = again.filter((h) => h.docId === 'vfy-d1').length;
  check('E. 重复写入不产生副本', dupCount <= 1, `vfy-d1 出现 ${dupCount} 次`);

  // 清理验收数据：先删行，再整个删掉验收库（不留垃圾库）
  await c.deleteByFilter("doc_id like 'vfy-%'");
  await dropDatabase();

  console.log(
    `\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}Infinity 验收：通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

/** 删除整个验收库，避免在 Infinity 里留下空库（drop_option 缺省会 500） */
async function dropDatabase(): Promise<void> {
  try {
    const res = await fetch(`${BASE.replace(/\/+$/, '')}/databases/${DB}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_option: 'ignore_if_not_exists' }),
    });
    if (!res.ok) console.log(`  \x1b[33m!\x1b[0m 验收库清理失败：HTTP ${res.status}`);
  } catch (err) {
    console.log(`  \x1b[33m!\x1b[0m 验收库清理异常：${String(err)}`);
  }
}

main().catch((e) => {
  console.error('验收脚本异常:', e);
  process.exit(1);
});
