#!/usr/bin/env node
/**
 * 控制台「审批权限」端到端验收 —— 真浏览器跑完整链路。
 *
 * 对应前端 permissions.ts 的 canDecideApproval 三条判定，逐条实测：
 *   1. 审批角色集合：普通员工（employee）永远只读；
 *   2. 审批角色（manager / platform-admin）对**他人**发起的单可操作；
 *   3. 防自批：审批角色看**自己**发起的单同样只读。
 *
 * 以及后端配合的两条：
 *   4. 普通用户的审批列表降级为「只看自己发起的单」，看不到别人的工单；
 *   5. 前端只是体验层，后端 decide 接口对自审一律 403（绕过前端直接调也拦得住）；
 *   6. 交叉审批通过后工具**真正执行**（审批单被原子消费为 executed）。
 *
 * 全程不 mock：审批单由真实 Agent 运行时（对话里触发需人工确认的写工具）
 * 与真实网关写接口产生。正常结束或中途失败都会尽力清理临时知识文档和待审批单；
 * 审计、会话历史及模拟业务工具的输出不属于持久化业务数据，不在清理范围内。
 *
 * 用法：node scripts/verify-console-approvals.mjs [控制台地址]
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

/** 三种角色各一个账号：普通员工 / 主管（审批角色）/ 平台管理员（审批角色） */
const DEMO = { u: process.env.EAP_DEMO_USER ?? 'eap-demo', p: process.env.EAP_DEMO_PASSWORD ?? 'EapDemo@2026' };
const MGR = { u: process.env.EAP_MGR_USER ?? 'eap-manager', p: process.env.EAP_MGR_PASSWORD ?? 'EapManager@2026' };
const ADMIN = { u: process.env.EAP_ADMIN_USER ?? 'eap-admin', p: process.env.EAP_ADMIN_PASSWORD ?? 'EapAdmin@2026' };

/** 需人工确认的写工具（真实模型调用后会命中） */
const HITL_TOOL = 'business.write.submit_expense';

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

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

/** 切到审批中心 */
async function gotoApprovals(page) {
  await page.getByRole('button', { name: '审批中心', exact: true }).click();
  await page.waitForSelector('h1:has-text("审批中心")', { timeout: 15000 });
}

/** 直接调网关接口：按状态列出当前身份可见的审批单 */
async function listByStatus(page, status) {
  return page.evaluate(async (approvalStatus) => {
    const token = localStorage.getItem('eap.token');
    const res = await fetch(`/v1/admin/approvals?status=${encodeURIComponent(approvalStatus)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { status: res.status, data: [] };
    const body = await res.json();
    return { status: res.status, data: body.data ?? [] };
  }, status);
}

async function listPending(page) {
  return listByStatus(page, 'pending');
}

/**
 * 轮询等待审批单进入指定状态。
 *
 * 状态从 approved → executed 是**异步**的（报销单要等 agent 真正执行工具
 * 才被原子消费），查一次必然是竞态。
 */
async function waitForApprovalStatus(page, approvalId, expected, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await listByStatus(page, expected);
    if (r.data.some((a) => a.id === approvalId)) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/** 直接调 decide 接口（用于验证后端兜底） */
async function decideViaApi(page, id, decision) {
  return page.evaluate(
    async ([approvalId, act]) => {
      const token = localStorage.getItem('eap.token');
      const res = await fetch(`/v1/admin/approvals/${approvalId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision: act }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [id, decision],
  );
}

/** 提交一条知识库文档（平台管理员专属入口，返回 202 + 审批单） */
async function submitKnowledgeDoc(page, title, docId) {
  return page.evaluate(async ({ docTitle, id }) => {
    const token = localStorage.getItem('eap.token');
    const res = await fetch('/v1/knowledge/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id,
        title: docTitle,
        content: '审批权限端到端验收用的临时文档正文，验收结束后会被删除。',
        deptId: 'dept-general',
        sensitivity: 'internal',
      }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { docTitle: title, id: docId });
}

async function deleteKnowledgeDocViaApi(page, docId) {
  return page.evaluate(async (id) => {
    const token = localStorage.getItem('eap.token');
    const res = await fetch(`/v1/knowledge/docs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, docId);
}

/** 在对话页真实触发一次需人工确认的写工具 */
async function triggerHitl(page, marker) {
  const composer = page.locator('textarea.aui-composer-input');
  await composer.waitFor({ timeout: 20000 });
  await composer.fill(`帮我提交一张报销单，费用事由必须原样填写为“${marker}”，金额 100 元`);
  await page.locator('.aui-composer-send').click();
}

/** 卡片（审批中心）里是否出现可点击的审批按钮 */
/**
 * 取审批卡上的操作按钮状态。
 *
 * excludeMarker：用于排除同一 marker 命中的其它卡片 ——
 * RUN_ID 同时出现在报销单的 args 和知识库文档的标题里，
 * 不排除的话 `.first()` 取到哪张不确定（实测会批错单）。
 */
async function cardHasDecideButtons(page, marker, excludeMarker) {
  const selector = excludeMarker
    ? `article:visible:has-text("${marker}"):not(:has-text("${excludeMarker}"))`
    : `article:visible:has-text("${marker}")`;
  const card = page.locator(selector).first();
  await card.waitFor({ timeout: 15000 });
  return {
    approve: (await card.locator('button', { hasText: '批准' }).count()) > 0,
    reject: (await card.locator('button', { hasText: '驳回' }).count()) > 0,
    readonly: (await card.locator('text=等待其他审批人处理').count()) > 0,
  };
}

async function main() {
  cleanOldShots(SHOT_DIR);
  console.log(`\n控制台审批权限验收：${CONSOLE_URL}`);
  console.log(`员工 ${DEMO.u} / 主管 ${MGR.u} / 管理员 ${ADMIN.u}\n`);

  const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
  const consoleErrors = [];
  const contextFor = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    return { ctx, page };
  };

  const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const DOC_ID = `verify-approval-${RUN_ID}`;
  const TEST_TITLE = `审批权限验收临时文档-${RUN_ID}`;
  let demoApprovalId = null;
  let adminApprovalId = null;
  let deleteApprovalId = null;
  let demoPage = null;
  let adminPage = null;
  let mgrPage = null;
  let adminReady = false;
  let mgrReady = false;

  try {
    /* ---------- 1. 普通员工在对话里真实触发 HITL ---------- */
    demoPage = (await contextFor()).page;
    await login(demoPage, DEMO.u, DEMO.p);
    check('普通员工 OIDC 登录成功', true);

    await triggerHitl(demoPage, RUN_ID);
    // 对话页每 4 秒轮询一次待审批列表，等审批等待区出现
    await demoPage
      .waitForSelector('text=/当前有 \\d+ 项待人工确认/', { timeout: 120000 })
      .catch(() => {});
    const demoPending = await listPending(demoPage);
    const demoHitl = demoPending.data.find(
      (a) => a.tool === HITL_TOOL && JSON.stringify(a.args ?? {}).includes(RUN_ID),
    );
    demoApprovalId = demoHitl?.id ?? null;
    check(
      '普通员工对话真实触发生成审批单（需人工确认的写工具）',
      demoPending.status === 200 && !!demoApprovalId,
      demoApprovalId ?? `status=${demoPending.status}`,
    );

    /* ---------- 2. 对话页：普通员工只读 ---------- */
    const chatItem = demoPage.locator('li', { hasText: HITL_TOOL }).first();
    const chatHasApprove = (await chatItem.locator('button', { hasText: '批准' }).count()) > 0;
    const chatHasReject = (await chatItem.locator('button', { hasText: '驳回' }).count()) > 0;
    const chatReadonly = (await chatItem.locator('text=等待其他审批人处理').count()) > 0;
    check(
      '对话页：普通员工只读，无批准/驳回按钮',
      !chatHasApprove && !chatHasReject && chatReadonly,
      `approve=${chatHasApprove} reject=${chatHasReject} readonly=${chatReadonly}`,
    );
    await demoPage.screenshot({ path: `${SHOT_DIR}/console-approvals-1-employee-readonly.png` });

    /* ---------- 3. 审批中心：普通员工看自己的单仍是只读 ---------- */
    await gotoApprovals(demoPage);
    const demoCard = await cardHasDecideButtons(demoPage, RUN_ID, TEST_TITLE);
    check(
      '审批中心：普通员工对已发起的单仍是只读',
      !demoCard.approve && !demoCard.reject && demoCard.readonly,
      `approve=${demoCard.approve} reject=${demoCard.reject} readonly=${demoCard.readonly}`,
    );

    /* ---------- 4. 管理员发起一张知识库单 ---------- */
    adminPage = (await contextFor()).page;
    await login(adminPage, ADMIN.u, ADMIN.p);
    adminReady = true;
    const submitted = await submitKnowledgeDoc(adminPage, TEST_TITLE, DOC_ID);
    adminApprovalId = submitted.body?.data?.approvalId ?? null;
    check(
      '平台管理员提交写操作 → 返回审批单（202，不直接落库）',
      submitted.status === 202 && !!adminApprovalId,
      `status=${submitted.status} approvalId=${adminApprovalId ?? '-'}`,
    );

    /* ---------- 5. 普通员工看不到别人的单 ---------- */
    const demoList = await listPending(demoPage);
    const seesAdmin = demoList.data.some((a) => a.id === adminApprovalId);
    check('普通员工的审批列表里看不到别人发起的单', !seesAdmin, `可见 ${demoList.data.length} 条`);
    check(
      '普通员工的审批列表只含自己发起的单',
      demoList.data.every((a) => a.userId === demoHitl?.userId),
      demoList.data.map((a) => a.tool).join(' | '),
    );

    /* ---------- 6. 管理员看自己发起的单 → 只读（防自批在前端就拦下） ---------- */
    await gotoApprovals(adminPage);
    const adminCard = await cardHasDecideButtons(adminPage, TEST_TITLE);
    check(
      '审批中心：审批角色对自己发起的单是只读',
      !adminCard.approve && !adminCard.reject && adminCard.readonly,
      `approve=${adminCard.approve} reject=${adminCard.reject} readonly=${adminCard.readonly}`,
    );
    await adminPage.screenshot({ path: `${SHOT_DIR}/console-approvals-2-self-readonly.png` });

    /* ---------- 7. 后端兜底：自审一律 403 ---------- */
    const selfDecide = await decideViaApi(adminPage, adminApprovalId, 'approved');
    check('绕过前端直接调 decide，自审被拒（403）', selfDecide.status === 403, `status=${selfDecide.status}`);

    /* ---------- 8. 主管（审批角色）看他人单 → 可操作 ---------- */
    mgrPage = (await contextFor()).page;
    await login(mgrPage, MGR.u, MGR.p);
    mgrReady = true;
    await gotoApprovals(mgrPage);
    const mgrCard = await cardHasDecideButtons(mgrPage, RUN_ID, TEST_TITLE);
    check(
      '审批中心：审批角色对他人发起的单可批准/驳回',
      mgrCard.approve && mgrCard.reject,
      `approve=${mgrCard.approve} reject=${mgrCard.reject}`,
    );
    const mgrList = await listPending(mgrPage);
    check(
      '审批角色可见本租户全部待审批单',
      mgrList.data.some((a) => a.id === adminApprovalId),
      `可见 ${mgrList.data.length} 条`,
    );
    await mgrPage.screenshot({ path: `${SHOT_DIR}/console-approvals-3-approver.png` });

    /* ---------- 9. 交叉审批 → 工具真正执行 ---------- */
    // 定位**报销单**那张卡 —— 必须排除文档卡（两者都含 RUN_ID）
    await mgrPage
      .locator(`article:visible:has-text("${RUN_ID}"):not(:has-text("${TEST_TITLE}"))`)
      .first()
      .locator('button', { hasText: '批准' })
      .click();
    await mgrPage.waitForSelector('text=已批准', { timeout: 20000 });
    check('主管交叉审批通过', true);

    const demoExecuted = await waitForApprovalStatus(mgrPage, demoApprovalId, 'executed');
    check(
      '审批通过后单据已原子消费为 executed',
      demoExecuted,
      `approvalId=${demoApprovalId ?? '-'}`,
    );

    /* ---------- 10. 知识库单：主管批准 → 落库 ---------- */
    await mgrPage
      .locator(`article:visible:has-text("${TEST_TITLE}")`)
      .first()
      .locator('button', { hasText: '批准' })
      .click();
    await mgrPage.waitForSelector('text=已批准', { timeout: 20000 });
    const adminExecuted = await waitForApprovalStatus(mgrPage, adminApprovalId, 'executed');
    check(
      '知识库写单审批通过后进入 executed',
      adminExecuted,
      `approvalId=${adminApprovalId ?? '-'}`,
    );

    /* ---------- 11. 清理：删除临时文档（同样走审批） ---------- */
    await adminPage.reload({ waitUntil: 'domcontentloaded' });
    await adminPage.waitForSelector('.app-shell', { timeout: 20000 });
    await adminPage.getByRole('button', { name: '知识库', exact: true }).click();
    await adminPage.waitForSelector('h1:has-text("知识库")', { timeout: 15000 });
    await adminPage.waitForSelector('table tbody tr', { timeout: 15000 });
    adminPage.once('dialog', (d) => d.accept());
    await adminPage
      .locator('table tbody tr', { hasText: TEST_TITLE })
      .locator('button', { hasText: '删除' })
      .click();
    await adminPage.waitForSelector('text=已提交删除审批', { timeout: 20000 });
    const delSubmit = await listPending(adminPage);
    deleteApprovalId = delSubmit.data.find(
      (a) => a.tool === 'knowledge.delete_document' && a.args?.id === DOC_ID,
    )?.id ?? null;
    check('删除走审批（生成删除工单）', !!deleteApprovalId, deleteApprovalId ?? '-');

    if (deleteApprovalId) {
      await mgrPage.reload({ waitUntil: 'domcontentloaded' });
      await mgrPage.waitForSelector('.app-shell', { timeout: 20000 });
      await gotoApprovals(mgrPage);
      await mgrPage
        .locator(`article:visible:has-text("${TEST_TITLE}")`)
        .first()
        .locator('button', { hasText: '批准' })
        .click();
      await mgrPage.waitForSelector('text=已批准', { timeout: 20000 });

      await adminPage.reload({ waitUntil: 'domcontentloaded' });
      await adminPage.waitForSelector('.app-shell', { timeout: 20000 });
      const listLoaded = adminPage.waitForResponse(
        (r) => r.request().method() === 'GET' && r.url().includes('/v1/knowledge/docs?') && r.status() === 200,
        { timeout: 15000 },
      );
      await adminPage.getByRole('button', { name: '知识库', exact: true }).click();
      await adminPage.waitForSelector('h1:has-text("知识库")', { timeout: 15000 });
      await listLoaded;
      const titles = await adminPage.$$eval('table tbody tr td:first-child button', (els) =>
        els.map((e) => e.textContent?.trim() ?? ''),
      );
      check(
        '临时文档已清理（列表中不再出现）',
        !titles.some((t) => t.includes(TEST_TITLE)),
        `列表 ${titles.length} 份`,
      );
    }

    /* ---------- 12. 无控制台报错 ---------- */
    const errs = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    check('无控制台异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (err) {
    check('验收脚本执行完成', false, String(err?.message ?? err));
  } finally {
    const cleanupProblems = [];
    try {
      const approvalIds = [...new Set([demoApprovalId, adminApprovalId, deleteApprovalId].filter(Boolean))];
      if ((approvalIds.length > 0 || adminReady) && !mgrReady) {
        mgrPage = (await contextFor()).page;
        await login(mgrPage, MGR.u, MGR.p);
        mgrReady = true;
      }
      if (mgrReady) {
        for (const id of approvalIds) {
          try {
            const result = await decideViaApi(mgrPage, id, 'rejected');
            if (![200, 404, 409].includes(result.status)) {
              cleanupProblems.push(`审批单 ${id} 清理返回 HTTP ${result.status}`);
            }
          } catch (err) {
            cleanupProblems.push(`审批单 ${id} 清理异常：${String(err?.message ?? err)}`);
          }
        }
      }
      if (adminReady && mgrReady) {
        const deleted = await deleteKnowledgeDocViaApi(adminPage, DOC_ID);
        if (deleted.status === 202 && deleted.body?.data?.approvalId) {
          const id = deleted.body.data.approvalId;
          const result = await decideViaApi(mgrPage, id, 'approved');
          if (result.status !== 200) cleanupProblems.push(`临时文档删除审批返回 HTTP ${result.status}`);
        } else if (deleted.status !== 404) {
          cleanupProblems.push(`临时文档删除请求返回 HTTP ${deleted.status}`);
        }
      }
    } catch (err) {
      cleanupProblems.push(String(err?.message ?? err));
    }
    check('临时数据兜底清理', cleanupProblems.length === 0, cleanupProblems.join(' | '));
    await browser.close();
  }

  console.log(`\n审批权限验收：通过 ${results.length - failures} 项，失败 ${failures} 项\n`);
  process.exit(failures ? 1 : 0);
}

await main();
