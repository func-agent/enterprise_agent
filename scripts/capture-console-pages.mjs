#!/usr/bin/env node
/**
 * 生成 README 的桌面端浅色页面截图。
 *
 * 使用真实 OIDC 登录、服务端已持久化的真实 AG-UI 对话和平台 API，不伪造页面 DOM。
 * 复用历史对话可避免截图依赖当前模型凭证；用于展示待审批状态的临时知识写入单
 * 会在 finally 中由另一位平台管理员驳回，不会生成知识文档。
 *
 * 用法：node scripts/capture-console-pages.mjs [控制台地址] [输出目录]
 * 默认输出：docs/screenshots；输出 2560×1600，CSS 视口约 1138×711（DPR 2.25）。
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_URL = process.argv[2] ?? process.env.EAP_CONSOLE_URL ?? 'http://127.0.0.1:5173';
const OUT_DIR = resolve(ROOT, process.argv[3] ?? 'docs/screenshots');
const IMAGE_WIDTH = 2560;
const IMAGE_HEIGHT = 1600;
const SCREENSHOT_DPR = Number(process.env.EAP_SCREENSHOT_DPR ?? 2.25);
if (!Number.isFinite(SCREENSHOT_DPR) || SCREENSHOT_DPR <= 0) {
  throw new Error('EAP_SCREENSHOT_DPR 必须是正数');
}
const CSS_VIEWPORT = {
  width: Math.round(IMAGE_WIDTH / SCREENSHOT_DPR),
  height: Math.round(IMAGE_HEIGHT / SCREENSHOT_DPR),
};
const ADMIN = {
  username: process.env.EAP_ADMIN_USER ?? 'eap-admin',
  password: process.env.EAP_ADMIN_PASSWORD ?? 'EapAdmin@2026',
};
const OPS = {
  username: process.env.EAP_OPS_USER ?? 'eap-ops',
  password: process.env.EAP_OPS_PASSWORD ?? 'EapOps@2026',
};

const LIB_DIR = resolve(ROOT, '.cache/chromium-libs');
if (existsSync(LIB_DIR) && !process.env.LD_LIBRARY_PATH?.includes(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
}
const FONT_CONFIG = resolve(ROOT, '.cache/fonts/fonts.conf');
if (existsSync(FONT_CONFIG)) process.env.FONTCONFIG_FILE = FONT_CONFIG;
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

mkdirSync(OUT_DIR, { recursive: true });

function useLightTheme(page) {
  return page.addInitScript(() => {
    try {
      localStorage.setItem('eap.theme', 'light');
      document.documentElement.classList.remove('dark');
      document.documentElement.style.colorScheme = 'light';
    } catch {
      // 浏览器初始空页面没有可用的 localStorage。
    }
  });
}

async function dismissToasts(page) {
  const buttons = await page.getByRole('button', { name: '关闭提示', exact: true }).all();
  for (const button of buttons) await button.click();
}

async function capture(page, filename, resetScroll = true) {
  await dismissToasts(page);
  if (resetScroll) {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const element of document.querySelectorAll('div.overflow-y-auto')) element.scrollTop = 0;
    });
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const session = await page.context().newCDPSession(page);
  try {
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: CSS_VIEWPORT.width,
        height: IMAGE_HEIGHT / (IMAGE_WIDTH / CSS_VIEWPORT.width),
        scale: IMAGE_WIDTH / CSS_VIEWPORT.width,
      },
    });
    writeFileSync(resolve(OUT_DIR, filename), Buffer.from(data, 'base64'));
  } finally {
    await session.detach();
  }
  console.log(`已保存 ${filename}`);
}

async function login(page, account, loginScreenshot = false) {
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 20000 });
  if (loginScreenshot) {
    await page.getByRole('button', { name: '使用企业账号登录', exact: true }).waitFor();
    // 仅处理截图中的身份源地址，页面本身仍显示实际配置。
    await page.locator('.login-note code').evaluateAll((elements) => {
      for (const element of elements) element.style.filter = 'blur(5px)';
    });
    await capture(page, '01-login.png');
  }
  await page.getByRole('button', { name: '使用企业账号登录', exact: true }).click();
  await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 20000 });
  await page.waitForSelector('#username', { timeout: 20000 });
  await page.fill('#username', account.username);
  await page.fill('#password', account.password);
  await Promise.all([
    page.waitForURL(/\/auth\/callback/, { timeout: 25000 }),
    page.click('#kc-login'),
  ]);
  await page.waitForSelector('.app-shell', { timeout: 25000 });
}

async function gotoTab(page, label, heading = label) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForSelector(`h1:has-text("${heading}")`, { timeout: 15000 });
}

const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
const context = await browser.newContext({
  viewport: CSS_VIEWPORT,
  deviceScaleFactor: SCREENSHOT_DPR,
  colorScheme: 'light',
});
const page = await context.newPage();
await useLightTheme(page);

let approvalId = null;
let approvalTitle = null;
let adminContext = null;
let adminPage = null;
const consoleErrors = [];
for (const current of [page]) {
  current.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  current.on('pageerror', (error) => consoleErrors.push(String(error)));
}

async function ensureAdminPage() {
  if (adminPage) return adminPage;
  adminContext = await browser.newContext({
    viewport: CSS_VIEWPORT,
    deviceScaleFactor: SCREENSHOT_DPR,
    colorScheme: 'light',
  });
  adminPage = await adminContext.newPage();
  await useLightTheme(adminPage);
  await login(adminPage, ADMIN);
  return adminPage;
}

async function cleanupApproval() {
  if (!approvalId) return;
  const result = await page.evaluate(async (id) => {
    const response = await fetch(`/v1/admin/approvals/${encodeURIComponent(id)}/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('eap.token')}`,
      },
      body: JSON.stringify({ decision: 'rejected' }),
    });
    return { status: response.status, body: await response.text() };
  }, approvalId);
  if (![200, 409].includes(result.status)) {
    throw new Error(`临时审批单清理失败：${JSON.stringify(result)}`);
  }
  console.log(`临时审批单已清理：${approvalId}`);
  approvalId = null;
}

try {
  await login(page, OPS, true);

  const history = await page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('eap.token')}` };
    const sessionResponse = await fetch('/api/sessions', { headers });
    const sessionBody = await sessionResponse.json();
    const sessions = sessionBody.data ?? [];
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/messages`, { headers });
      const body = await response.json();
      const messages = body.data ?? [];
      const assistant = messages.find((message) => message.role === 'assistant' && message.content?.trim());
      const user = messages.find((message) => message.role === 'user' && message.content?.trim());
      if (assistant && user) {
        return {
          id: session.id,
          title: session.title,
          answer: assistant.content.trim().slice(0, 32),
        };
      }
    }
    return null;
  });
  if (!history) throw new Error('没有可用于截图的持久化对话，请先完成一次真实 Agent 对话。');
  await page.locator(`[data-session-id="${history.id}"]`).click();
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('[data-slot="aui_assistant-message-content"]')]
      .some((element) => (element.textContent ?? '').trim().length > 20);
  }, undefined, { timeout: 15000 });
  await page.waitForFunction(() => {
    const select = document.querySelector('select[aria-label="选择对话模型"]');
    return select && !select.disabled && select.options.length > 1;
  });
  await page.waitForTimeout(500);
  await capture(page, '02-chat.png', false);

  const marker = Date.now().toString(36);
  approvalTitle = '2026 年差旅管理制度（修订稿）';
  const requester = await ensureAdminPage();
  const created = await requester.evaluate(async ({ title, id }) => {
    const response = await fetch('/v1/knowledge/docs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('eap.token')}`,
      },
      body: JSON.stringify({
        id,
        title,
        content: '更新国内差旅住宿与交通报销标准，明确审批权限、票据要求和特殊事项说明。',
        deptId: 'dept-general',
        sensitivity: 'internal',
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    return body.data;
  }, { title: approvalTitle, id: `readme-preview-${marker}` });
  approvalId = created.approvalId;

  await gotoTab(page, '审批中心');
  await page.waitForSelector(`article:visible:has-text("${approvalTitle}")`, { timeout: 15000 });
  await capture(page, '03-approvals.png');

  await gotoTab(page, '知识库');
  await page.waitForSelector('table tbody tr:visible', { timeout: 15000 });
  const annualLeave = page.locator('table tbody tr:visible', { hasText: '员工年假管理制度' });
  const documentRow = (await annualLeave.count()) > 0 ? annualLeave.first() : page.locator('table tbody tr:visible').first();
  await documentRow.locator('td:first-child button').click();
  await page.waitForSelector('h4:visible', { timeout: 15000 });
  await capture(page, '04-knowledge.png');

  await gotoTab(page, '工具目录');
  await page.waitForSelector('.health-card', { timeout: 15000 });
  await page.waitForSelector('.table tbody tr:visible', { timeout: 15000 });
  await capture(page, '05-tools.png');

  await gotoTab(page, '厂商接入与凭证');
  await page.waitForSelector('.provider-card:visible', { timeout: 15000 });
  const customProvider = page.locator('.provider-card:visible').filter({ has: page.getByText('自定义', { exact: true }) }).first();
  const expandedProvider = (await customProvider.count()) > 0 ? customProvider : page.locator('.provider-card:visible').first();
  await expandedProvider.locator('.model-head > button').click();
  await expandedProvider.locator('.model-body').waitFor();
  await capture(page, '06-providers.png');

  await gotoTab(page, '模型与路由');
  await page.waitForSelector('.model-card:not(.provider-card):visible', { timeout: 15000 });
  await page.locator('.model-card:not(.provider-card):visible .model-head > button').first().click();
  await page.waitForSelector('.model-card:not(.provider-card):visible .model-body', { timeout: 10000 });
  await capture(page, '07-models.png');

  await gotoTab(page, '预算看板');
  await page.waitForSelector('.stat-card:visible', { timeout: 15000 });
  await page.waitForSelector('.table tbody tr:visible', { timeout: 15000 });
  await capture(page, '08-budget.png');

  await gotoTab(page, '审计与 Trace', '审计与 Trace');
  await page.waitForSelector('.table-audit tbody tr', { timeout: 15000 });
  await page.locator('.table-audit tbody tr.row-clickable').first().click();
  await page.waitForSelector('.row-detail', { timeout: 10000 });
  await capture(page, '09-audit.png');

  await gotoTab(page, '用户与权限');
  await page.waitForSelector('table tbody tr:visible', { timeout: 15000 });
  await capture(page, '10-users.png');

  await cleanupApproval();
  if (consoleErrors.length > 0) {
    throw new Error(`截图过程中出现浏览器错误：${consoleErrors.slice(0, 3).join(' | ')}`);
  }
  console.log(`\n10 张页面截图已生成：${OUT_DIR}`);
} finally {
  try {
    await cleanupApproval();
  } finally {
    await adminContext?.close();
    await context.close();
    await browser.close();
  }
}
