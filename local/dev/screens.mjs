// Screenshots of pages of the dev web copy, as the admin, at a desktop and a phone width.
//   local/dev/screens.sh /lists/companies/12 /settings/calls          -> local/dev/screens/*.png
//   SCREEN_TAB="Контакты" local/dev/screens.sh /lists/companies/12   -> clicks that tab first
// Logs in through the API (password from local/dev/api.env), puts the token where the client keeps it.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(process.env.CRM_DEV_ENV || join(here, 'api.env'), 'utf8')
    .split('\n').map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, '')]),
);
const api = `http://127.0.0.1:${env.APP_LISTEN_PORT || 3100}/api/v1`;
const web = process.env.SCREEN_WEB || 'http://172.0.30.4:4150';
const json = process.env.SCREEN_JSON === '1';  // machine-readable result for local/checks/ui_check.py
const out = process.env.SCREEN_OUT || join(here, 'screens');
mkdirSync(out, { recursive: true });
const chrome = process.env.SCREEN_CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;

const res = await fetch(`${api}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.ADMIN_EMAIL || 'admin@gmail.com', password: env.ADMIN_PASSWORD }),
});
if (!res.ok) { console.error(`login failed: ${res.status}`); process.exit(1); }
const { access_token: token } = await res.json();

const sizes = [
  { name: 'pc', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844, isMobile: true },
];
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ['/'];
const browser = await chromium.launch({ executablePath: chrome });
const files = [];
const report = [];
try {
  for (const size of sizes) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.isMobile, colorScheme: 'dark' });
    await ctx.addInitScript((t) => localStorage.setItem('token', t), token);
    const page = await ctx.newPage();
    const errors = [];
    const consoleErrors = [];
    const failed = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/v1/')) failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^.*\/api\/v1/, '')}`); });
    for (const path of pages) {
      await page.goto(web + path, { waitUntil: 'networkidle', timeout: 90_000 }).catch(() => undefined);
      if (process.env.SCREEN_TAB) {
        const tab = page.locator('.nui-tabs-inner a', { hasText: process.env.SCREEN_TAB }).first();
        await tab.waitFor({ timeout: 15000 }).catch(() => undefined);
        await page.waitForTimeout(1000);
        await tab.click({ timeout: 5000 }).catch((e) => console.error(`tab "${process.env.SCREEN_TAB}" not clicked: ${e.message.split('\n')[0]}`));
      }
      await page.waitForTimeout(1500);
      const file = join(out, `${path.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'home'}${process.env.SCREEN_TAB ? '_' + process.env.SCREEN_TAB.replace(/\s+/g, '_') : ''}-${size.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      // a page wider than the screen is the usual sign of a broken layout
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const finalPath = new URL(page.url()).pathname;
      files.push(file);
      report.push({ path, size: size.name, file, url: finalPath, overflow, pageErrors: errors.splice(0), consoleErrors: consoleErrors.splice(0), api5xx: failed.splice(0) });
      if (!json) {
        const last = report[report.length - 1];
        console.log(`${file}${overflow > 1 ? `  (wider than the screen by ${overflow}px)` : ''}${last.pageErrors.length ? `  (page errors: ${last.pageErrors.join(' | ').slice(0, 200)})` : ''}`);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (json) console.log('@@' + JSON.stringify(report));
