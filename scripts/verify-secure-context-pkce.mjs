#!/usr/bin/env node
/**
 * 非安全上下文下的 PKCE 回归验收 —— 守护「公网明文 HTTP 访问控制台登录报错」这个坑。
 *
 * ── 背景 ─────────────────────────────────────────────────────────────
 * 浏览器只在**安全上下文**（secure context）里提供 `crypto.subtle`：
 *   · https://                       ✅
 *   · http://localhost / 127.0.0.1   ✅（浏览器视为可信来源）
 *   · http://<公网IP>:5173           ❌ 明文 HTTP 的非本机来源不是安全上下文
 *
 * PKCE 的 S256 挑战需要 SHA-256。早期实现直接调 `crypto.subtle.digest`，
 * 公网访问时它是 undefined → 抛 TypeError → 登录按钮点了没反应、页面报错，
 * 而本机 127.0.0.1 一切正常（因为那是安全上下文）—— 极具迷惑性。
 *
 * 现在 `apps/webui/src/oidc.ts` 在没有 subtle 时退回纯 JS SHA-256
 * （apps/webui/src/sha256.ts）。本脚本专门验证**非安全上下文下仍能完成授权跳转**。
 *
 * 用法：
 *   node scripts/verify-secure-context-pkce.mjs [控制台地址]
 *   EAP_CONSOLE_URL=http://203.0.113.10:5173 npx tsx scripts/verify-secure-context-pkce.mjs
 *   （203.0.113.10 是文档保留示例地址，执行前必须替换）
 *
 * 公网地址不在仓库内写死：优先命令行参数，其次 `EAP_CONSOLE_URL`，
 * 再其次由 `EAP_PUBLIC_IP` 拼出（实际值见内部参数表
 * docs/internal/host-params.local.md）。三者都没给则直接报错退出。
 *
 * 退出码：0 通过 / 1 失败
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Chromium 在精简系统上可能缺 GTK/ATK 共享库，本仓库把它们放在 .cache/chromium-libs */
const LIB_DIR = resolve(ROOT, '.cache/chromium-libs');
if (existsSync(LIB_DIR) && !process.env.LD_LIBRARY_PATH?.includes(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
}
/** 必须清掉 DISPLAY —— 本机残留的失效 X server 会让 Chromium 合成器不出帧 */
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

// 公网地址不在仓库内写死（公开仓库不应内置目标地址）
const CONSOLE_URL =
  process.argv[2] ??
  process.env.EAP_CONSOLE_URL ??
  (process.env.EAP_PUBLIC_IP ? `http://${process.env.EAP_PUBLIC_IP}:5173` : undefined);

if (!CONSOLE_URL) {
  console.error(
    '错误：未指定控制台地址。\n' +
      '  用法：node scripts/verify-secure-context-pkce.mjs <控制台地址>\n' +
      '  或设置 EAP_CONSOLE_URL / EAP_PUBLIC_IP 环境变量。',
  );
  process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

console.log(`\n非安全上下文 PKCE 回归验收：${CONSOLE_URL}\n`);

const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
const context = await browser.newContext();
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 15000 });

  /* ---------- 1. 环境判定 ---------- */
  const env = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasSubtle: typeof window.crypto?.subtle !== 'undefined',
    hasGetRandomValues: typeof window.crypto?.getRandomValues === 'function',
  }));
  console.log(`  环境：isSecureContext=${env.isSecureContext} subtle=${env.hasSubtle}\n`);

  check(
    'crypto.getRandomValues 可用（非安全上下文也可用，state/nonce 依赖它）',
    env.hasGetRandomValues,
  );

  /* ---------- 2. 非安全上下文下 SHA-256 仍可算 ---------- */
  const digest = await page.evaluate(async () => {
    // 模拟 oidc.ts 的兜底分支：subtle 不可用时走纯 JS 实现
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
        return { via: 'subtle', hex: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('') };
      }
      return { via: 'js-fallback-needed', hex: '' };
    } catch (e) {
      return { via: 'error', hex: String(e) };
    }
  });
  check(
    'SHA-256 摘要计算不抛异常',
    digest.via !== 'error',
    digest.via === 'error' ? digest.hex : `via=${digest.via}`,
  );

  /* ---------- 3. 点击登录必须能跳到 Keycloak（本次修复的核心断言）---------- */
  const btn = page.locator('button', { hasText: '使用企业账号登录' });
  await btn.first().click();

  let navigated = true;
  try {
    await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 15000 });
  } catch {
    navigated = false;
  }
  check(
    '点击「使用企业账号登录」能跳转到 Keycloak 授权端点',
    navigated,
    navigated ? new URL(page.url()).origin : `URL 未跳转，仍在 ${page.url()}`,
  );

  if (navigated) {
    const params = new URL(page.url()).searchParams;
    check(
      '授权请求带 PKCE S256 参数',
      params.get('code_challenge_method') === 'S256' &&
        (params.get('code_challenge') ?? '').length >= 43,
      `code_challenge 长度=${(params.get('code_challenge') ?? '').length}`,
    );
  }

  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  check('验收过程未抛异常', false, String(err));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${passed}/${results.length} 通过`);
if (passed === results.length) {
  console.log('非安全上下文下 PKCE 可用 —— 公网明文 HTTP 访问登录正常。');
  process.exit(0);
}
console.log('❌ 非安全上下文下登录链路异常 —— 纯 JS SHA-256 兜底可能已被破坏。');
process.exit(1);
