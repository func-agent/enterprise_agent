import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// RAGFlow Web 界面截图脚本
// 用途：验证 deploy/compose/ragflow/nginx/ 补齐的 nginx 配置确实把
//       RAGFlow 前端跑起来了（此前 8095 返回的是 nginx 默认欢迎页）。
//
// 用法：node scripts/shot-ragflow.mjs [baseUrl] [outDir]
//   baseUrl 默认 http://127.0.0.1:8095
//   outDir  默认 /tmp/shots-ragflow

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = resolve(ROOT, '.cache/chromium-libs');
if (existsSync(LIB_DIR) && !process.env.LD_LIBRARY_PATH?.includes(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
}
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

const BASE = process.argv[2] ?? 'http://127.0.0.1:8095';
const OUTDIR = process.argv[3] ?? '/tmp/shots-ragflow';

const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 记录失败请求：任何 4xx/5xx 都视为异常，最后统一汇报
const failed = [];
page.on('response', (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUTDIR}/01-login.png` });

// 断言：标题是 RAGFlow 而不是 nginx 默认页
const title = await page.title();
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));

// 登录（账号来自验收脚本注册的临时用户）
const user = process.env.RAGFLOW_USER ?? '';
const pass = process.env.RAGFLOW_PASS ?? '';
if (user && pass) {
  await page.fill('input[name="username"], input[type="text"]', user);
  await page.fill('input[name="password"], input[type="password"]', pass);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUTDIR}/02-after-login.png` });
}

console.log(`标题: ${title}`);
console.log(`首屏文本前 200 字: ${bodyText.replace(/\s+/g, ' ').slice(0, 200)}`);
console.log(`失败请求(${failed.length}):`);
for (const f of failed.slice(0, 10)) console.log('  ' + f);

await browser.close();
