import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = resolve(ROOT, '.cache/chromium-libs');
if (existsSync(LIB_DIR) && !process.env.LD_LIBRARY_PATH?.includes(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
}
const BROWSER_ENV = { ...process.env };
delete BROWSER_ENV.DISPLAY;

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUTDIR = process.argv[3] ?? '/tmp/shots';

const TABS = ['对话', '审批中心', '工具目录', '模型与路由', '预算看板', '审计与 Trace'];

const browser = await chromium.launch({ headless: true, channel: 'chromium', env: BROWSER_ENV });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.login-card', { timeout: 15000 });
await page.screenshot({ path: `${OUTDIR}/00-login.png` });

// 走统一登录
await page.locator('button', { hasText: '使用企业账号登录' }).first().click();
await page.waitForURL(/protocol\/openid-connect\/auth/, { timeout: 20000 });
await page.waitForSelector('#username', { timeout: 15000 });
await page.fill('#username', 'eap-admin');
await page.fill('#password', 'EapAdmin@2026');
await Promise.all([
  page.waitForURL(/\/auth\/callback/, { timeout: 20000 }),
  page.click('#kc-login'),
]);
await page.waitForSelector('.app-shell', { timeout: 20000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUTDIR}/01-after-login.png` });

for (let i = 0; i < TABS.length; i++) {
  const tab = TABS[i];
  // 新设计系统下导航在侧边栏，是图标 + 文字的按钮，不再用 .tab 类名或顶栏选择器定位
  const loc = page.getByRole('button', { name: tab, exact: true });
  if (await loc.count()) {
    await loc.click().catch(() => {});
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUTDIR}/${String(i + 2).padStart(2, '0')}-${tab}.png` });
    console.log(`已截图: ${tab}`);
  } else {
    console.log(`未找到页签: ${tab}`);
  }
}

await browser.close();
console.log('完成 ->', OUTDIR);
