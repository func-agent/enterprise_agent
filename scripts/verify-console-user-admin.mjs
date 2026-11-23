#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_URL = process.env.EAP_CONSOLE_URL ?? 'http://127.0.0.1:5173';
const KEYCLOAK_URL = process.env.KEYCLOAK_BASE_URL ?? 'http://127.0.0.1:8082';
const LIB_DIR = resolve(ROOT, '.cache/chromium-libs');
if (existsSync(LIB_DIR) && !process.env.LD_LIBRARY_PATH?.includes(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
}
const FONT_CONFIG = resolve(ROOT, '.cache/fonts/fonts.conf');
if (existsSync(FONT_CONFIG)) process.env.FONTCONFIG_FILE = FONT_CONFIG;
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

async function login() {
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 20000 });
  await page.getByRole('button', { name: '使用企业账号登录', exact: true }).click();
  await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 20000 });
  await page.fill('#username', process.env.EAP_ADMIN_USER ?? 'eap-ops');
  await page.fill('#password', process.env.EAP_ADMIN_PASSWORD ?? 'EapOps@2026');
  await Promise.all([
    page.waitForURL(/\/auth\/callback/, { timeout: 25000 }),
    page.click('#kc-login'),
  ]);
  await page.waitForSelector('.app-shell', { timeout: 25000 });
}

async function removeIfPresent(id) {
  if (!id) return;
  const result = await page.evaluate(async (userId) => {
    const response = await fetch(`/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${localStorage.getItem('eap.token')}` },
    });
    return response.status;
  }, id);
  if (![200, 404].includes(result)) throw new Error(`临时用户清理失败 HTTP ${result}`);
}

const username = `ui-test-${Date.now().toString(36)}`;
let createdId = null;
try {
  await login();
  await page.getByRole('button', { name: '用户与权限', exact: true }).click();
  await page.getByRole('heading', { name: '用户与权限', exact: true }).waitFor();
  await page.getByRole('button', { name: '新增用户', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^用户名/).fill(username);
  await dialog.getByLabel('邮箱', { exact: true }).fill(`${username}@example.com`);
  await dialog.getByLabel('姓氏', { exact: true }).fill('测');
  await dialog.getByLabel('名字', { exact: true }).fill('试');
  await dialog.getByLabel('平台角色', { exact: true }).selectOption('employee');
  await dialog.getByLabel('数据密级', { exact: true }).selectOption('internal');
  await dialog.getByLabel('部门 ID', { exact: true }).fill('dept-general');
  await dialog.getByRole('button', { name: '创建用户', exact: true }).click();
  await page.getByLabel('一次性新密码', { exact: true }).waitFor();
  const firstPassword = await page.getByLabel('一次性新密码', { exact: true }).inputValue();
  assert(firstPassword.length >= 24);
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('textbox', { name: '搜索用户', exact: true }).fill(username);
  let row = page.locator('table tbody tr').filter({ hasText: username });
  await row.waitFor();
  createdId = await row.getAttribute('data-user-id');
  assert(createdId);
  console.log('通过：管理员可创建用户，随机密码只展示一次');

  await row.getByRole('button', { name: '编辑', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('平台角色', { exact: true }).selectOption('manager');
  await dialog.getByLabel('部门 ID', { exact: true }).fill('dept-finance');
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.waitForFunction((name) => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    return rows.some((item) => item.textContent?.includes(name) && item.textContent?.includes('dept-finance') && item.textContent?.includes('主管'));
  }, username);
  console.log('通过：角色、部门与属性修改同步到 Keycloak');

  row = page.locator('table tbody tr').filter({ hasText: username });
  await row.getByRole('button', { name: '重置密码', exact: true }).click();
  await page.getByRole('button', { name: '确认重置', exact: true }).click();
  await page.getByLabel('一次性新密码', { exact: true }).waitFor();
  const secondPassword = await page.getByLabel('一次性新密码', { exact: true }).inputValue();
  assert.notEqual(secondPassword, firstPassword);
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  const tokenResponse = await fetch(`${KEYCLOAK_URL}/realms/enterprise/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password', client_id: 'eap-webui', username, password: secondPassword,
    }).toString(),
  });
  assert.equal(tokenResponse.status, 200, '重置后的密码应能真实登录 Keycloak');
  const token = await tokenResponse.json();
  const claims = JSON.parse(Buffer.from(token.access_token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.role, 'manager');
  assert.equal(claims.dept_id, 'dept-finance');
  assert.equal(claims.tenant_id, 't-default');
  console.log('通过：新密码可真实登录，角色、部门与租户正确写入令牌');

  row = page.locator('table tbody tr').filter({ hasText: username });
  await row.getByRole('button', { name: '停用', exact: true }).click();
  await page.waitForFunction((name) => {
    const row = [...document.querySelectorAll('table tbody tr')].find((item) => item.textContent?.includes(name));
    return row?.textContent?.includes('已停用');
  }, username);
  await row.getByRole('button', { name: '启用', exact: true }).click();
  await page.waitForFunction((name) => {
    const row = [...document.querySelectorAll('table tbody tr')].find((item) => item.textContent?.includes(name));
    return row?.textContent?.includes('已启用');
  }, username);
  console.log('通过：用户停用与启用生效');

  await row.getByRole('button', { name: `删除用户 ${username}`, exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction((name) => {
    return ![...document.querySelectorAll('table tbody tr')].some((item) => item.textContent?.includes(name));
  }, username);
  createdId = null;
  assert.deepEqual(errors, []);
  console.log('通过：临时用户已删除，浏览器无运行错误');
  console.log('用户与权限端到端验收全部通过，现有演示账号未修改。');
} finally {
  if (createdId) await removeIfPresent(createdId);
  await context.close();
  await browser.close();
}
