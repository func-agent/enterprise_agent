#!/usr/bin/env node
/**
 * 控制台登录端到端验收 —— 真实浏览器跑完整 OIDC 授权码 + PKCE 流程。
 *
 * 覆盖的关键事实（都是实测踩出来的坑，回归价值高）：
 *   1. Keycloak 26 给 AUTH_SESSION_ID 固定打 `Secure; SameSite=None`，
 *      明文 HTTP 的回环地址下浏览器是否回传该 cookie —— 只有真浏览器能证明。
 *   2. realm 文件导入路径会丢内置 client scope，导致 access_token 缺 sub /
 *      preferred_username / realm_access（身份塌缩成同一个 user_id）。
 *   3. 授权码交换必须在浏览器侧完成（公开客户端 + PKCE，网关不持密钥）。
 *
 * 前置条件：
 *   · 平台已启动（网关 8080 / 控制台 5173），Keycloak 重型栈在 8082
 *   · realm 里存在测试账号（默认 eap-demo / EapDemo@2026）
 *   · 浏览器：npx playwright install chromium
 *
 * 用法：node scripts/verify-console-login.mjs
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Chromium 在精简系统上可能缺少数个 GTK/ATK 共享库。
 * 本仓库把它们放在 .cache/chromium-libs（从 RAGFlow 容器借出），
 * 有则挂上 LD_LIBRARY_PATH，避免要求 sudo 安装系统依赖。
 */
const LIB_DIR = resolve(ROOT, '.cache/chromium-libs');
if (existsSync(LIB_DIR) && !process.env.LD_LIBRARY_PATH?.includes(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
}

/**
 * 必须清掉 DISPLAY。
 * 本机残留了一个失效的 X server（DISPLAY=localhost:13.0），
 * Chromium 会去连它，导致合成器不出帧 —— CDP 截图与 requestAnimationFrame
 * 全部卡死（页面本身没问题）。Headless 本就不需要 X。
 */
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

const CONSOLE_URL = process.env.EAP_CONSOLE_URL ?? 'http://127.0.0.1:5173';
const USERNAME = process.env.EAP_TEST_USER ?? 'eap-demo';
const PASSWORD = process.env.EAP_TEST_PASSWORD ?? 'EapDemo@2026';

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '✅' : '❌';
  console.log(`  ${mark} ${name}${detail ? ` —— ${detail}` : ''}`);
}

async function main() {
  console.log(`\n控制台登录端到端验收：${CONSOLE_URL}（账号 ${USERNAME}）\n`);

  const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  try {
    /* ---------- 1. 打开控制台 ---------- */
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.login-card', { timeout: 15000 });
    check('控制台可打开且渲染登录页', true, await page.title());

    /* ---------- 2. 鉴权模式应为 oidc ---------- */
    const cfg = await page.evaluate(async () => {
      const res = await fetch('/v1/auth/config');
      return res.json();
    });
    check('鉴权模式为 oidc（生产模式）', cfg.mode === 'oidc', `mode=${cfg.mode}`);
    check('授权端点可达', typeof cfg.authorizationUrl === 'string' && cfg.authorizationUrl.length > 0, cfg.authorizationUrl);

    /* ---------- 3. 页面应给出统一登录入口 ---------- */
    const ssoButton = page.locator('button', { hasText: '使用企业账号登录' });
    check('登录页展示「使用企业账号登录」入口', (await ssoButton.count()) > 0);

    /* ---------- 4. 点击后跳转到 Keycloak ---------- */
    await ssoButton.first().click();
    await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 15000 });
    const authUrl = new URL(page.url());
    check(
      '跳转 Keycloak 授权端点且带 PKCE 参数',
      authUrl.searchParams.get('code_challenge_method') === 'S256' &&
        (authUrl.searchParams.get('code_challenge') ?? '').length >= 43,
      `challenge_method=${authUrl.searchParams.get('code_challenge_method')}`,
    );
    check(
      '授权请求未携带客户端密钥（公开客户端）',
      !authUrl.searchParams.has('client_secret'),
    );

    /* ---------- 5. 在 Keycloak 登录 ---------- */
    await page.waitForSelector('#username', { timeout: 15000 });
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await Promise.all([
      page.waitForURL(/\/auth\/callback/, { timeout: 20000 }),
      page.click('#kc-login'),
    ]);
    check('Keycloak 登录成功并回跳控制台回调地址', page.url().includes('/auth/callback'), page.url().slice(0, 90));

    /* ---------- 6. 回调后自动建立会话 ---------- */
    await page.waitForSelector('.app-shell', { timeout: 20000 });
    check('回调后控制台进入已登录态（无需再点登录）', true);

    // 新设计系统下登录身份在侧边栏底部的身份卡（<summary aria-label="查看当前登录身份">），
    // 顶栏已不存在，用 header 定位只会读到无关文本
    const identityText = (await page.locator('[aria-label="查看当前登录身份"]').first().innerText().catch(() => '')) + '';
    check('侧边栏展示登录用户', identityText.includes(USERNAME), identityText.replace(/\s+/g, ' ').slice(0, 80));

    /* ---------- 7. 令牌已写入本地存储 ---------- */
    const stored = await page.evaluate(() => ({
      token: window.localStorage.getItem('eap.token') ?? '',
      identity: window.localStorage.getItem('eap.identity') ?? '',
      expires: window.localStorage.getItem('eap.token.expires') ?? '',
    }));
    check('访问令牌已持久化', stored.token.split('.').length === 3, `len=${stored.token.length}`);

    const persisted = JSON.parse(stored.identity || '{}');
    check('身份已持久化且含用户名', persisted.username === USERNAME, JSON.stringify(persisted));

    const claims = JSON.parse(
      Buffer.from(stored.token.split('.')[1], 'base64url').toString('utf8'),
    );
    check('令牌含 sub（用户唯一标识）', typeof claims.sub === 'string' && claims.sub.length > 0, claims.sub);
    check('令牌含 preferred_username', claims.preferred_username === USERNAME, claims.preferred_username);
    check('令牌含平台身份 claim（tenant_id/role/dept_id/sensitivity）',
      Boolean(claims.tenant_id && claims.role && claims.dept_id && claims.sensitivity),
      `tenant=${claims.tenant_id} role=${claims.role} dept=${claims.dept_id} sens=${claims.sensitivity}`);
    check('令牌含 realm_access.roles', Boolean(claims.realm_access?.roles?.length),
      JSON.stringify(claims.realm_access?.roles));

    /* ---------- 8. 带令牌访问受保护接口 ---------- */
    const models = await page.evaluate(async () => {
      const res = await fetch('/v1/models', {
        headers: { Authorization: `Bearer ${window.localStorage.getItem('eap.token')}` },
      });
      return { status: res.status, body: await res.text() };
    });
    check('受保护接口可用真实令牌访问', models.status === 200, `HTTP ${models.status}`);

    /* ---------- 9. 刷新页面保持登录 ---------- */
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell', { timeout: 15000 });
    check('刷新后仍保持登录态', true);

    /* ---------- 10. 登出 ---------- */
    const identityToggle = page.locator('summary[aria-label="查看当前登录身份"]');
    if ((await identityToggle.count()) > 0) {
      await identityToggle.click();
      const logoutBtn = page.getByRole('button', { name: '退出登录', exact: true });
      await logoutBtn.waitFor({ state: 'visible' });
      // 必须等 Keycloak 的 logout 请求返回后再继续 ——
      // 否则会与「重新登录」抢跑，SSO 会话尚未结束，Keycloak 会静默发码。
      const logoutDone = page
        .waitForResponse((r) => r.url().includes('/openid-connect/logout'), { timeout: 15000 })
        .catch(() => null);
      await logoutBtn.click();
      const logoutResp = await logoutDone;
      check('Keycloak 登出端点返回 200（无 invalid_redirect_uri）', logoutResp?.status() === 200,
        logoutResp ? `HTTP ${logoutResp.status()}` : '未捕获到 logout 请求');
      await page.waitForSelector('.login-card', { timeout: 10000 });
      const cleared = await page.evaluate(() => window.localStorage.getItem('eap.token'));
      check('登出后本地令牌已清除', !cleared);
    } else {
      check('登出按钮存在', false, '未找到「退出」按钮');
    }

    /* ---------- 11. 登出后 Keycloak 侧 SSO 会话真的结束 ---------- */
    // 再发起一次登录：应重新出现 Keycloak 登录表单（而不是被 SSO cookie 静默放行）
    await page.locator('button', { hasText: '使用企业账号登录' }).first().click();
    await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 15000 });
    const needPassword = await page
      .waitForSelector('#password', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('登出后 SSO 会话已结束（需重新输入口令）', needPassword);

    const realErrors = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
    check('控制台无未捕获异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`结果：${results.length - failures}/${results.length} 通过`);
  if (failures > 0) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`);
    process.exit(1);
  }
  console.log('控制台 OIDC 统一登录全链路可用。\n');
}

main().catch((err) => {
  console.error('\n验收脚本异常：', err);
  process.exit(1);
});
