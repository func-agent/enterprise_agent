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
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });

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

function eventStream(input) {
  const events = [
    { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
    { type: 'CUSTOM', name: 'eap.session', value: { sessionId: input.threadId, threadId: input.threadId, runId: input.runId } },
    { type: 'TEXT_MESSAGE_START', messageId: `${input.runId}-msg`, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: `${input.runId}-msg`, delta: '模型选择验证' },
    { type: 'TEXT_MESSAGE_END', messageId: `${input.runId}-msg` },
    {
      type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId,
      result: { sessionId: input.threadId, content: '模型选择验证', iterations: 1, toolCalls: [], traceId: 'model-selector-test' },
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const contexts = [];
try {
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(adminContext);
  const admin = await adminContext.newPage();
  await login(
    admin,
    process.env.EAP_ADMIN_USER ?? 'eap-ops',
    process.env.EAP_ADMIN_PASSWORD ?? 'EapOps@2026',
  );

  const selector = admin.getByRole('combobox', { name: '选择对话模型' });
  await selector.waitFor({ state: 'visible' });
  await admin.waitForFunction(() => document.querySelector('select[aria-label="选择对话模型"] option[value="fast-model"]'));
  const options = await selector.locator('option').allTextContents();
  assert(options.some((text) => text.includes('缺省（smart-model）')));
  assert(options.includes('fast-model'));
  assert(options.includes('reasoning-model'));
  assert(!options.includes('embedding-model'));
  assert.equal(await selector.inputValue(), '');
  console.log('通过：管理员看到系统缺省模型和对话模型，TEI 嵌入模型已排除');

  const storedSessionIds = await admin.evaluate(async () => {
    const response = await fetch('/api/sessions', {
      headers: { Authorization: `Bearer ${localStorage.getItem('eap.token')}` },
    });
    const payload = await response.json();
    return (payload.data ?? []).map((session) => session.id);
  });
  if (storedSessionIds.length > 0) {
    const selectedSessionId = storedSessionIds[0];
    await admin.locator(`[data-session-id="${selectedSessionId}"]`).click();
    await selector.selectOption('fast-model');
    await admin.getByRole('button', { name: '新建任务', exact: true }).click();
    assert.equal(await selector.inputValue(), '');
    await admin.locator(`[data-session-id="${selectedSessionId}"]`).click();
    assert.equal(await selector.inputValue(), 'fast-model');
    console.log('通过：模型选择按会话保留，新会话恢复服务端默认模型');
  } else {
    await selector.selectOption('fast-model');
    console.log('提示：当前没有历史会话，跳过会话切换验证');
  }

  const requests = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  await admin.route('**/ag-ui', async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    if (requests.length === 1) await firstBlocked;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: eventStream(input),
    });
  });

  const input = admin.getByRole('textbox', { name: '消息输入框' });
  await input.fill('验证显式模型');
  const firstRequest = admin.waitForRequest((request) => request.url().includes('/ag-ui'));
  await admin.getByRole('button', { name: '发送消息', exact: true }).click();
  await firstRequest;
  assert.equal(await selector.isDisabled(), true);
  releaseFirst();
  await admin.waitForFunction(() => {
    const select = document.querySelector('select[aria-label="选择对话模型"]');
    return select && !select.disabled;
  });
  assert.equal(requests[0].forwardedProps.model, 'fast-model');
  console.log('通过：请求携带 fast-model，生成期间选择器禁用');

  await selector.selectOption('');
  await input.fill('验证默认模型');
  await admin.getByRole('button', { name: '发送消息', exact: true }).click();
  await admin.waitForFunction(() => [...document.querySelectorAll('[data-slot="aui_assistant-message-content"]')]
    .filter((element) => element.textContent?.includes('模型选择验证')).length >= 2);
  assert.equal(requests.length, 2);
  assert.equal('model' in requests[1].forwardedProps, false);
  console.log('通过：恢复默认后请求不再携带 model');

  const userContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(userContext);
  const user = await userContext.newPage();
  await login(
    user,
    process.env.EAP_TEST_USER ?? 'eap-demo',
    process.env.EAP_TEST_PASSWORD ?? 'EapDemo@2026',
  );
  assert.equal(await user.getByRole('combobox', { name: '选择对话模型' }).count(), 0);
  console.log('通过：普通用户不显示模型选择器');
  console.log('模型选择器浏览器验收全部通过；AG-UI 为拦截响应，未调用真实模型。');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
