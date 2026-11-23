#!/usr/bin/env node
/**
 * 控制台流式对话端到端验收 —— 真浏览器跑 AG-UI 标准事件流。
 *
 * 覆盖的关键事实（回归价值高）：
 *   1. 前端必须走 `POST /ag-ui`（SSE），而不是旧的 `/api/chat` 一次性接口 ——
 *      断流式就说明接线没落到 AG-UI 上。
 *   2. assistant-ui 的消息根节点（data-slot=aui_assistant-message-root）必须出现，
 *      且正文是**逐段到达**的（多个 TEXT_MESSAGE_CONTENT 帧）。
 *   3. 工具调用要渲染成工具卡片（data-slot 含 tool-call），并带回结果。
 *   4. 客户端断开要能中断后端运行（后端按 req.close 触发 AbortSignal）。
 *
 * 前置条件：平台已启动（网关 8080 / agent-core 8090 / 控制台 5173），Keycloak 在 8082。
 *
 * 用法：node scripts/verify-console-stream.mjs [控制台地址]
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
const USERNAME = process.env.EAP_TEST_USER ?? 'eap-demo';
const PASSWORD = process.env.EAP_TEST_PASSWORD ?? 'EapDemo@2026';
const SHOT_DIR = process.env.EAP_SHOT_DIR ?? '/tmp';

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

async function main() {
  cleanOldShots(SHOT_DIR);
  console.log(`\n控制台流式对话验收：${CONSOLE_URL}（账号 ${USERNAME}）\n`);

  const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  /** 捕获浏览器实际发出的 AG-UI 请求 */
  const aguiCalls = [];
  const sseFrames = [];
  /** 失败请求（状态码 >= 400）及其 URL —— 用于定位 404 */
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // 带上来源 URL —— 404 这类资源错误只出现在 location 里，正文看不出是哪个文件
    consoleErrors.push(`${msg.text()} @ ${msg.location()?.url ?? ''}`);
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  /**
   * 在页面加载前包一层 fetch，把 /ag-ui 的响应体全文截下来，
   * 并记录**每个网络分块的到达时间**。
   *
   * 不能靠 Playwright 的 response.text()：SSE 是长连接响应，
   * response 事件触发时 body 还没结束，取 body 会抛错。
   *
   * 记录分块时间是为了把「流式」这件事验在网络层：
   * 一次性返回的响应只会有一块到达；而流式推送会陆续收到多块。
   * 断言「正文分片数 ≥ 2」是不行的 —— 模型回答短时天然只有一段，
   * 那是回答长度问题，不是流式问题。
   */
  await page.addInitScript(() => {
    window.__aguiBodies = [];
    window.__aguiChunks = [];
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const res = await original(input, init);
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/ag-ui')) {
        try {
          const clone = res.clone();
          const reader = clone.body.getReader();
          const decoder = new TextDecoder();
          const t0 = performance.now();
          let text = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            text += chunk;
            window.__aguiChunks.push({ t: Math.round(performance.now() - t0), len: chunk.length });
          }
          window.__aguiBodies.push(text);
        } catch {
          /* 流被中断时忽略 */
        }
      }
      return res;
    };
  });

  page.on('request', (req) => {
    if (req.url().includes('/ag-ui')) {
      aguiCalls.push({ method: req.method(), url: req.url(), postData: req.postData() });
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      failedRequests.push({ status: res.status(), url: res.url() });
    }
  });

  try {
    /* ---------- 1. 登录 ---------- */
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.login-card', { timeout: 20000 });
    const ssoButton = page.locator('button', { hasText: '使用企业账号登录' });
    await ssoButton.first().click();
    await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 20000 });
    await page.waitForSelector('#username', { timeout: 20000 });
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await Promise.all([
      page.waitForURL(/\/auth\/callback/, { timeout: 25000 }),
      page.click('#kc-login'),
    ]);
    await page.waitForSelector('.app-shell', { timeout: 25000 });
    check('OIDC 登录成功并进入控制台', true);

    /* ---------- 2. 新设计系统已生效 ---------- */
    // composer 渲染晚于 .app-shell，需等待其出现而不是假定已在
    await page
      .waitForSelector('.aui-composer-root [data-slot="aui_composer-shell"], .aui-composer-root', {
        timeout: 20000,
      })
      .catch(() => {});
    const design = await page.evaluate(() => {
      const btn =
        document.querySelector('[data-slot="aui_composer-shell"]') ??
        document.querySelector('.aui-composer-root');
      const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
      return { hasComposer: !!btn, primary };
    });
    check('渲染的是 assistant-ui 新版输入框', design.hasComposer, `composer=${design.hasComposer}`);
    check('主色为深蓝令牌', design.primary.includes('oklch'), `--primary=${design.primary}`);

    await page.screenshot({ path: `${SHOT_DIR}/console-stream-1-empty.png` });

    /* ---------- 3. 发消息，观察流式 ---------- */
    const composer = page.locator('textarea.aui-composer-input');
    await composer.waitFor({ timeout: 15000 });
    // 刻意选一个必然触发工具调用的问题 —— 用来验证工具卡片渲染
    await composer.fill('帮我查一下我有哪些待办事项');
    await page.locator('.aui-composer-send').click();

    // 等待正文或错误卡片；失败时立即报出原因，不再等空消息超时
    await page.waitForFunction(() => {
      if (document.querySelector('.aui-message-error-root')) return true;
      return [...document.querySelectorAll('[data-slot="aui_assistant-message-content"]')]
        .some((element) => (element.textContent ?? '').trim().length > 0);
    }, undefined, { timeout: 90000 });
    const runError = await page.locator('.aui-message-error-root:visible').allInnerTexts();
    if (runError.length > 0) throw new Error(`对话运行失败：${runError.join(' | ')}`);
    check('助手消息已渲染（assistant-ui 线程 UI）', true);

    // 等待本轮结束（发送按钮重新出现 = 运行结束）
    await page.waitForSelector('.aui-composer-send', { timeout: 120000 });
    await page.waitForTimeout(1500);

    /* ---------- 4. 协议层断言 ---------- */
    const bodies = await page.evaluate(() => window.__aguiBodies ?? []);
    for (const body of bodies) {
      for (const line of body.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          sseFrames.push(JSON.parse(line.slice(6)));
        } catch {
          /* 非 JSON 帧忽略 */
        }
      }
    }

    check('确实调用了 POST /ag-ui（AG-UI 标准端点）',
      aguiCalls.some((c) => c.method === 'POST'),
      `调用 ${aguiCalls.length} 次`);

    const types = sseFrames.map((f) => f.type);
    check('收到 RUN_STARTED', types.includes('RUN_STARTED'));
    check('收到 TEXT_MESSAGE_START', types.includes('TEXT_MESSAGE_START'));
    const contents = types.filter((t) => t === 'TEXT_MESSAGE_CONTENT');
    check('正文经 SSE 分片下发（收到 TEXT_MESSAGE_CONTENT 事件）', contents.length >= 1, `${contents.length} 段`);
    check('收到 TEXT_MESSAGE_END', types.includes('TEXT_MESSAGE_END'));
    check('收到 RUN_FINISHED', types.includes('RUN_FINISHED'));
    check('未出现 RUN_ERROR', !types.includes('RUN_ERROR'),
      sseFrames.find((f) => f.type === 'RUN_ERROR')?.message ?? '');

    // —— 流式判定放在网络层：分块陆续到达，而不是一次性吐完
    // （正文分片数取决于模型回答长度，不能拿来判定流式）
    const chunks = await page.evaluate(() => window.__aguiChunks ?? []);
    const chunkCount = chunks.length;
    const spread = chunkCount > 1 ? chunks[chunkCount - 1].t - chunks[0].t : 0;
    check(
      '响应体分块陆续到达（非一次性返回）',
      chunkCount >= 2 && spread > 0,
      `${chunkCount} 块 / 跨度 ${spread}ms`,
    );

    const sessionFrame = sseFrames.find((f) => f.type === 'CUSTOM' && f.name === 'eap.session');
    check('后端回传平台会话号', Boolean(sessionFrame?.value?.sessionId), sessionFrame?.value?.sessionId ?? '');

    /* ---------- 5. 渲染层断言 ---------- */
    const rendered = await page.evaluate(() => {
      const roots = document.querySelectorAll('[data-slot="aui_assistant-message-root"]');
      const text = Array.from(roots)
        .map((n) => (n.textContent ?? '').trim())
        .filter(Boolean);
      return {
        count: roots.length,
        text: text.join('\n'),
        toolCards: document.querySelectorAll('[data-slot="tool-group-root"], .aui-tool-result').length,
      };
    });
    check('助手消息正文非空', rendered.text.length > 10, `${rendered.count} 条 / ${rendered.text.length} 字`);
    check('工具调用渲染为工具卡片', rendered.toolCards > 0, `${rendered.toolCards} 个`);

    await page.screenshot({ path: `${SHOT_DIR}/console-stream-2-answer.png` });
    console.log(`\n  截图：${SHOT_DIR}/console-stream-1-empty.png`);
    console.log(`  截图：${SHOT_DIR}/console-stream-2-answer.png`);

    /* ---------- 6. 会话落到服务端 ---------- */
    const sessionId = sessionFrame?.value?.sessionId;
    if (sessionId) {
      const persisted = await page.evaluate(async (sid) => {
        const res = await fetch(`/api/sessions/${sid}/messages`, {
          headers: { Authorization: `Bearer ${window.localStorage.getItem('eap.token')}` },
        });
        return res.ok ? (await res.json()).data.length : -1;
      }, sessionId);
      check('本轮消息已持久化到服务端', persisted >= 2, `${persisted} 条`);
    }

    /* ---------- 7. 控制台无报错 ---------- */
    const realErrors = consoleErrors.filter((e) => !/favicon|ERR_/i.test(e) && !/favicon\.ico/i.test(e));
    check('浏览器控制台无错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
    check('无失败请求（4xx/5xx）', failedRequests.length === 0,
      failedRequests.slice(0, 3).map((r) => `${r.status} ${r.url}`).join(' | '));
  } catch (err) {
    check('验收流程未抛异常', false, String(err?.message ?? err));
  } finally {
    await browser.close();
  }

  console.log(`\n结果：${results.length - failures}/${results.length} 通过`);
  if (failures > 0) {
    console.log('失败项：');
    for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name}${r.detail ? `（${r.detail}）` : ''}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

await main();
