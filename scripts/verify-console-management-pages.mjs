#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_URL = process.env.EAP_CONSOLE_URL ?? 'http://127.0.0.1:5173';
const LIB_DIR = resolve(ROOT, '.cache/chromium-libs');
if (existsSync(LIB_DIR) && !process.env.LD_LIBRARY_PATH?.includes(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
}
const FONT_CONFIG = resolve(ROOT, '.cache/fonts/fonts.conf');
if (existsSync(FONT_CONFIG)) process.env.FONTCONFIG_FILE = FONT_CONFIG;
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
const contexts = [];

async function assertTitleActions(page) {
  const layout = await page.locator('.page-head:visible').evaluate((head) => {
    const title = head.querySelector('h1')?.getBoundingClientRect();
    const actions = head.querySelector('.page-actions')?.getBoundingClientRect();
    const container = head.getBoundingClientRect();
    return title && actions ? {
      titleTop: title.top,
      actionsTop: actions.top,
      headRight: container.right,
      actionsRight: actions.right,
    } : null;
  });
  assert(layout, '标题栏应包含标题和操作按钮');
  assert(Math.abs(layout.titleTop - layout.actionsTop) < 1, '操作按钮应与页面标题同行');
  assert(Math.abs(layout.headRight - layout.actionsRight) < 1, '操作按钮应靠右对齐');
}

async function assertDescriptionLayout(page) {
  const layouts = await page.locator('.page-head:visible p').evaluateAll((elements) =>
    elements.map((element) => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      overflowX: element.parentElement ? getComputedStyle(element.parentElement).overflowX : '',
    })),
  );
  assert(layouts.every((layout) => layout.whiteSpace === 'nowrap'), '页面两行说明均不应折行');
  assert(layouts.every((layout) => !['auto', 'scroll'].includes(layout.overflowX)), '页面说明不应使用滚动条');
}

async function login(page, username, password) {
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 20000 });
  await page.getByRole('button', { name: '使用企业账号登录', exact: true }).click();
  await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 20000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await Promise.all([
    page.waitForURL(/\/auth\/callback/, { timeout: 25000 }),
    page.click('#kc-login'),
  ]);
  await page.waitForSelector('.app-shell', { timeout: 25000 });
}

try {
  const adminContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  contexts.push(adminContext);
  const admin = await adminContext.newPage();
  const errors = [];
  admin.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  admin.on('pageerror', (error) => errors.push(String(error)));
  await login(
    admin,
    process.env.EAP_ADMIN_USER ?? 'eap-ops',
    process.env.EAP_ADMIN_PASSWORD ?? 'EapOps@2026',
  );

  await admin.getByRole('button', { name: '厂商接入与凭证', exact: true }).click();
  await admin.getByRole('heading', { name: '厂商接入与凭证', exact: true }).waitFor();
  await assertTitleActions(admin);
  await assertDescriptionLayout(admin);
  const firstProvider = admin.locator('.provider-card:visible').first();
  await firstProvider.waitFor();
  assert.equal(await admin.locator('.model-card:not(.provider-card):visible').count(), 0);
  assert.equal(await admin.getByText(/密钥按账号独立加密/).count(), 0);
  assert.equal(await admin.locator('.provider-card input[type="password"]:visible').count(), 0);
  await firstProvider.locator('.model-head > button').click();
  await firstProvider.locator('.model-body').waitFor();
  assert((await admin.locator('.provider-card input[type="password"]:visible').count()) > 0);

  const deleteButtons = admin.getByRole('button', { name: /^删除厂商 / });
  assert.equal(await deleteButtons.count(), await admin.locator('.provider-card:visible').count());
  const builtInProvider = admin.locator('.provider-card:visible').filter({ has: admin.getByText('内置', { exact: true }) }).first();
  assert.equal(await builtInProvider.getByRole('button', { name: /^删除厂商 / }).isDisabled(), true);
  const customProvider = admin.locator('.provider-card:visible').filter({ has: admin.getByText('自定义', { exact: true }) }).first();
  if (await customProvider.count()) {
    const remove = customProvider.getByRole('button', { name: /^删除厂商 / });
    assert.equal(await remove.isEnabled(), true);
    await remove.click();
    await admin.getByRole('dialog').waitFor();
    await admin.getByRole('button', { name: '取消', exact: true }).click();
  }
  await admin.getByRole('button', { name: '新增厂商', exact: true }).click();
  await admin.getByRole('dialog').waitFor();
  await admin.getByRole('button', { name: '取消', exact: true }).click();
  console.log('通过：厂商列表与模型列表风格一致，删除按钮及内置厂商限制正确');

  await admin.getByRole('button', { name: '配置模型路由', exact: true }).click();
  await admin.getByRole('heading', { name: '模型与路由', exact: true }).waitFor();
  await assertTitleActions(admin);
  await assertDescriptionLayout(admin);
  await admin.locator('.model-card:visible').first().waitFor();
  assert.equal(await admin.locator('.provider-card:visible').count(), 0);
  assert.equal(await admin.locator('.page input[type="password"]:visible').count(), 0);
  await admin.getByRole('button', { name: '新增模型', exact: true }).click();
  const providerSelect = admin.getByRole('combobox', { name: '目标 1 的 Provider' });
  await providerSelect.waitFor();
  assert((await providerSelect.locator('option').count()) > 1);
  await admin.getByRole('button', { name: '取消', exact: true }).click();
  console.log('通过：模型页不再混入凭证管理，编辑器仍可选择厂商');

  await admin.getByRole('button', { name: '管理厂商凭证', exact: true }).click();
  await admin.getByRole('heading', { name: '厂商接入与凭证', exact: true }).waitFor();
  await assertTitleActions(admin);
  await assertDescriptionLayout(admin);
  await admin.locator('.provider-card:visible').first().waitFor();
  console.log('通过：两个管理页面可双向跳转');

  for (const label of ['审批中心', '知识库', '工具目录', '用户与权限', '预算看板', '审计与 Trace']) {
    await admin.getByRole('button', { name: label, exact: true }).click();
    await admin.getByRole('heading', { name: label, exact: true }).waitFor();
    await assertTitleActions(admin);
    await assertDescriptionLayout(admin);
  }
  assert.deepEqual(errors, []);
  console.log('通过：审批、知识库、工具、用户与权限、预算和审计页标题栏样式一致，浏览器无运行错误');

  const userContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(userContext);
  const user = await userContext.newPage();
  await login(
    user,
    process.env.EAP_TEST_USER ?? 'eap-demo',
    process.env.EAP_TEST_PASSWORD ?? 'EapDemo@2026',
  );
  assert.equal(await user.getByRole('button', { name: '厂商接入与凭证', exact: true }).count(), 0);
  assert.equal(await user.getByRole('button', { name: '模型与路由', exact: true }).count(), 0);
  console.log('通过：普通用户不显示两个管理入口');
  console.log('管理页面浏览器验收全部通过；仅执行读取和弹窗操作，未修改配置或调用模型。');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
