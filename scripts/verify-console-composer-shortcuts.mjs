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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

function eventStream(input) {
  const events = [
    { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
    { type: 'CUSTOM', name: 'eap.session', value: { sessionId: input.threadId, threadId: input.threadId, runId: input.runId } },
    { type: 'TEXT_MESSAGE_START', messageId: `${input.runId}-msg`, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: `${input.runId}-msg`, delta: '快捷键验证' },
    { type: 'TEXT_MESSAGE_END', messageId: `${input.runId}-msg` },
    { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId, result: { sessionId: input.threadId, content: '快捷键验证', iterations: 1, toolCalls: [], traceId: 'composer-shortcuts-test' } },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

try {
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

  const requests = [];
  await page.route('**/ag-ui', async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: eventStream(input),
    });
  });

  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('第一行');
  await input.press('Enter');
  assert.equal(await input.inputValue(), '第一行\n');
  assert.equal(requests.length, 0);
  console.log('通过：Enter 只插入换行，不发送消息');

  await input.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('[data-slot="aui_assistant-message-content"]')?.textContent?.includes('快捷键验证'));
  assert.equal(requests.length, 1);
  assert(JSON.stringify(requests[0].messages).includes('第一行'));
  console.log('通过：Ctrl + Enter 发送消息');

  assert(await page.getByText('Enter 换行 · Ctrl + Enter 发送', { exact: true }).isVisible());
  console.log('通过：界面提示与实际快捷键一致；AG-UI 为拦截响应，未调用真实模型');
} finally {
  await context.close();
  await browser.close();
}
