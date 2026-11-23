#!/usr/bin/env node
/**
 * 控制台「知识库」页端到端验收 —— 真浏览器跑完整链路。
 *
 * 覆盖的关键事实：
 *   1. 知识文档列表按**身份**过滤（管理员跨部门 + 密级准入）；
 *   2. 点标题能拉到详情并显示正文；
 *   3. 检索测试走的是真实检索链路（引擎应为 infinity），不是假数据；
 *   4. 写操作是**审批制**：提交后不立即落库，审批通过后才生效；
 *   5. 不得审批自己发起的申请（防自批）。
 *
 * 用法：node scripts/verify-console-knowledge.mjs [控制台地址]
 */
import { chromium } from 'playwright';
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 清理旧截图 —— /tmp 是 sticky 位目录（1777），属主不同的文件无法被覆盖写，
 * 不先删掉会直接 EACCES。只删本项目前缀的 png，不碰 /tmp 下其他文件。
 */
function cleanOldShots(dir) {
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('console-') && f.endsWith('.png')) {
        rmSync(`${dir}/${f}`, { force: true });
      }
    }
  } catch {
    /* 目录不存在时忽略 */
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = resolve(ROOT, '.cache/chromium-libs');
if (existsSync(LIB_DIR) && !process.env.LD_LIBRARY_PATH?.includes(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
}
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

const CONSOLE_URL = process.argv[2] ?? process.env.EAP_CONSOLE_URL ?? 'http://127.0.0.1:5173';
const SHOT_DIR = process.env.EAP_SHOT_DIR ?? '/tmp';
/** 写操作发起人（平台管理员） */
const ADMIN_USER = process.env.EAP_ADMIN_USER ?? 'eap-admin';
const ADMIN_PASS = process.env.EAP_ADMIN_PASSWORD ?? 'EapAdmin@2026';
/** 审批人（另一位平台管理员，用于交叉审批） */
const OPS_USER = process.env.EAP_OPS_USER ?? 'eap-ops';
const OPS_PASS = process.env.EAP_OPS_PASSWORD ?? 'EapOps@2026';

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

/** 走 OIDC 登录，进入控制台 */
async function login(page, username, password) {
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 20000 });
  await page.locator('button', { hasText: '使用企业账号登录' }).first().click();
  await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 20000 });
  await page.waitForSelector('#username', { timeout: 20000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await Promise.all([page.waitForURL(/\/auth\/callback/, { timeout: 25000 }), page.click('#kc-login')]);
  await page.waitForSelector('.app-shell', { timeout: 25000 });
}

/** 切到知识库页签 */
async function gotoKnowledge(page) {
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await page.waitForSelector('h1:has-text("知识库")', { timeout: 15000 });
}

/** 读出当前可见的文档标题列表 */
async function listTitles(page) {
  return page.$$eval('table tbody tr td:first-child button', (els) => els.map((e) => e.textContent?.trim() ?? ''));
}

async function main() {
  cleanOldShots(SHOT_DIR);
  console.log(`\n控制台知识库页验收：${CONSOLE_URL}（发起人 ${ADMIN_USER}，审批人 ${OPS_USER}）\n`);

  const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  /** 自批被拒是**预期内**的 403，检查时不算失败 */
  let expectErrors = false;
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
  });

  const TEST_TITLE = `端到端验收临时文档-${Date.now().toString(36)}`;

  try {
    /* ---------- 1. 登录（平台管理员） ---------- */
    await login(page, ADMIN_USER, ADMIN_PASS);
    check('OIDC 登录成功并进入控制台', true);

    /* ---------- 2. 知识库页签 ---------- */
    await gotoKnowledge(page);
    check('「知识库」页签可进入', true);

    /* ---------- 3. 文档列表 ---------- */
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    const titles = await listTitles(page);
    check('文档列表已加载', titles.length > 0, `${titles.length} 份`);
    check(
      '列表含制度文档',
      titles.some((t) => t.includes('年假')) || titles.some((t) => t.includes('差旅')),
      titles.slice(0, 4).join(' / '),
    );

    /* ---------- 4. 密级过滤：机密文档对 confidential 身份可见 ---------- */
    const hasConfidential = await page.locator('table tbody tr', { hasText: '机密' }).count();
    check('列表标注了密级徽标（含机密）', hasConfidential > 0, `机密行 ${hasConfidential}`);

    /* ---------- 5. 详情 ---------- */
    await page.locator('table tbody tr td:first-child button').first().click();
    await page.waitForSelector('h4', { timeout: 15000 });
    const detailText = await page.locator('h4').first().textContent();
    check('点击标题可打开详情并显示正文', !!detailText && detailText.trim().length > 0, detailText ?? '');
    await page.screenshot({ path: `${SHOT_DIR}/console-knowledge-1-list.png` });

    /* ---------- 6. 检索测试 ---------- */
    const searchResponse = page.waitForResponse(
      (res) => res.url().includes('/v1/knowledge/search') && res.request().method() === 'POST',
      { timeout: 20000 },
    );
    await page.fill('input[placeholder*="年假"]', '年假怎么计算');
    await page.getByRole('button', { name: '检索', exact: true }).click();
    const searchPayload = await (await searchResponse).json();
    const engine = searchPayload.data?.engine ?? '';
    check('检索测试返回真实引擎', Boolean(engine), engine);
    check('检索走的是向量引擎（非 BM25 兜底）', engine === 'infinity', engine);
    await page.waitForSelector('button:has-text("得分")', { timeout: 20000 });
    const hitCount = await page.locator('button:has-text("得分")').count();
    check('检索返回命中结果', hitCount > 0, `${hitCount} 条`);
    await page.screenshot({ path: `${SHOT_DIR}/console-knowledge-2-search.png` });

    /* ---------- 7. 写操作：提交后不立即落库 ---------- */
    await page.locator('button', { hasText: '新增文档' }).first().click();
    await page.waitForSelector('#knowledge-title', { timeout: 10000 });
    await page.fill('#knowledge-title', TEST_TITLE);
    await page.fill('#knowledge-content', '这是端到端验收写入的临时文档正文，用于验证审批链路是否真正生效。');
    await page.getByRole('button', { name: '提交审批', exact: true }).click();
    await page.waitForSelector('text=已提交审批', { timeout: 15000 });
    check('写操作返回「已提交审批」', true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell', { timeout: 20000 });
    await gotoKnowledge(page);
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    const afterSubmit = await listTitles(page);
    check(
      '审批通过前文档未落库',
      !afterSubmit.some((t) => t.includes(TEST_TITLE)),
      `列表 ${afterSubmit.length} 份`,
    );

    /* ---------- 8. 审批单出现在审批中心 ---------- */
    // 注意：对话页的助手线程里也会渲染工具名（工具卡片），但那个面板在切走时是
    // display:none，Playwright 视其为不可见 —— 因此必须用 :visible 限定，
    // 并用本次文档标题精确定位到「刚提交的那一单」。
    const approvalCard = (scope) =>
      scope.locator(`article:visible:has-text("${TEST_TITLE}")`).first();
    await page.getByRole('button', { name: '审批中心', exact: true }).click();
    await page.waitForSelector(`article:visible:has-text("${TEST_TITLE}")`, { timeout: 15000 });
    check('审批中心出现知识库写操作审批单', true);

    /* ---------- 9. 发起人不得自批 ---------- */
    const errorMark = consoleErrors.length;
    const failMark = failedRequests.length;
    expectErrors = true;
    const selfDecide = await page.evaluate(async (title) => {
      const token = localStorage.getItem('eap.token');
      const list = await (await fetch('/v1/admin/approvals?status=pending', { headers: { Authorization: `Bearer ${token}` } })).json();
      const target = (list.data ?? []).find((a) => (a.reason ?? '').includes(title));
      if (!target) return { found: false };
      const res = await fetch(`/v1/admin/approvals/${target.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision: 'approved' }),
      });
      return { found: true, status: res.status };
    }, TEST_TITLE);
    expectErrors = false;
    check('发起人自批被拒（403）', selfDecide.found && selfDecide.status === 403, JSON.stringify(selfDecide));
    // 这两条错误是上面那次「故意自批」产生的，属于预期内，清掉
    consoleErrors.length = errorMark;
    failedRequests.length = failMark;

    /* ---------- 10. 交叉审批后落库 ---------- */
    // 必须用**独立浏览器上下文**：同上下文共享 localStorage，
    // 第二次登录时令牌还在，根本不会出现登录页。
    const opsContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opsPage = await opsContext.newPage();
    await login(opsPage, OPS_USER, OPS_PASS);
    await opsPage.getByRole('button', { name: '审批中心', exact: true }).click();
    await opsPage.waitForSelector(`article:visible:has-text("${TEST_TITLE}")`, { timeout: 15000 });
    await approvalCard(opsPage).locator('button', { hasText: '批准' }).click();
    await opsPage.waitForSelector('text=已批准', { timeout: 15000 });
    check('另一位平台管理员审批通过', true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell', { timeout: 20000 });
    await gotoKnowledge(page);
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    const afterApprove = await listTitles(page);
    check(
      '审批通过后文档已落库',
      afterApprove.some((t) => t.includes(TEST_TITLE)),
      `列表 ${afterApprove.length} 份`,
    );
    await page.screenshot({ path: `${SHOT_DIR}/console-knowledge-3-after-approve.png` });

    /* ---------- 11. 删除同样走审批，并清理临时数据 ---------- */
    // 必须先挂上 dialog 监听再点：window.confirm 一旦没人处理，页面会卡住
    page.once('dialog', (d) => d.accept());
    await page.locator('table tbody tr', { hasText: TEST_TITLE }).locator('button', { hasText: '删除' }).click();
    await page.waitForSelector('text=已提交删除审批', { timeout: 15000 });
    check('删除走审批（提示已提交删除审批）', true);

    await opsPage.reload({ waitUntil: 'domcontentloaded' });
    await opsPage.waitForSelector('.app-shell', { timeout: 20000 });
    await opsPage.getByRole('button', { name: '审批中心', exact: true }).click();
    await opsPage.waitForSelector(`article:visible:has-text("${TEST_TITLE}")`, { timeout: 15000 });
    await approvalCard(opsPage).locator('button', { hasText: '批准' }).click();
    await opsPage.waitForSelector('text=已批准', { timeout: 15000 });
    check('删除审批通过', true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell', { timeout: 20000 });
    await gotoKnowledge(page);
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    const afterDelete = await listTitles(page);
    check(
      '删除后文档已移除（临时数据已清理）',
      !afterDelete.some((t) => t.includes(TEST_TITLE)),
      `列表 ${afterDelete.length} 份`,
    );

    /* ---------- 12. 无失败请求 ---------- */
    // favicon 之类的浏览器自动请求不算失败
    const realFailures = failedRequests.filter(
      (f) => !f.includes('/v1/admin/approvals') && !f.includes('favicon'),
    );
    check('无失败请求', realFailures.length === 0, realFailures.slice(0, 3).join(' | '));
    const realConsoleErrors = consoleErrors.filter(
      (e) => !e.includes('favicon') && !e.includes('Failed to load resource'),
    );
    check('无控制台报错', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 2).join(' | '));
  } catch (err) {
    check('验收脚本执行完成', false, String(err?.message ?? err));
  } finally {
    await browser.close();
  }

  console.log(`\n知识库页验收：通过 ${results.length - failures} 项，失败 ${failures} 项\n`);
  process.exit(failures ? 1 : 0);
}

await main();
