// Browser part of local/checks/live_check.py: a page that is already open shows a change
// made elsewhere (through the API) without reload. Prints one JSON line per case.
//   node local/dev/tools/live-browser.mjs <dealId> <prefix>
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(process.env.CRM_DEV_ENV || join(here, 'api.env'), 'utf8')
    .split('\n').map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, '')]),
);
const api = `http://127.0.0.1:${env.APP_LISTEN_PORT || 3100}/api/v1`;
const web = process.env.SCREEN_WEB || 'http://172.0.30.4:4150';
const chrome = process.env.SCREEN_CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;
const [dealId, prefix] = process.argv.slice(2);

const call = async (method, path, body, token) => {
  const r = await fetch(api + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const { body: { access_token: token } } = await call('POST', '/auth/login', { email: env.ADMIN_EMAIL || 'admin@gmail.com', password: env.ADMIN_PASSWORD });
const me = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
const typeId = (await call('GET', '/task-types', null, token)).body?.[0]?.id ?? (await call('GET', '/task-types', null, token)).body?.data?.[0]?.id;

const browser = await chromium.launch({ executablePath: chrome });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((t) => localStorage.setItem('token', t), token);
const out = (o) => console.log(JSON.stringify(o));

async function seen(path, change, text, ms = 10000) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(web + path, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500); // socket connected
    // a comment is shown in a (read-only) textarea: its value is not page text
    const count = async () => (await page.getByText(text, { exact: false }).count())
      + await page.locator('textarea').evaluateAll((els, t) => els.filter((e) => e.value.includes(t)).length, text);
    const before = await count();
    const res = await change();
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < ms) {
      if ((await count()) > before) { ok = true; break; }
      await page.waitForTimeout(250);
    }
    return { path, ok, ms: Date.now() - t0, status: res?.status, errors };
  } finally {
    await page.close();
  }
}

try {
  const comment = `${prefix} live comment`;
  out({ case: 'deal page shows a new comment', ...(await seen(`/deals/${dealId}`, () => call('POST', `/deals/${dealId}/comments`, { comment }, token), comment)) });
  const label = `${prefix} live task`;
  const now = new Date();
  const end = new Date(now.getTime() + 3600e3);
  out({ case: 'tasks page shows a new task', ...(await seen('/tasks', () => call('POST', '/tasks', {
    label, type_id: typeId, allDay: false, assign_to: { target: 'agent', id: me }, link_to: { target: 'deal', id: Number(dealId) },
    start_time: now.toISOString(), end_time: end.toISOString(),
  }, token), label)) });
  const card = `${prefix} live kanban`;
  out({ case: 'deals board shows a new deal', ...(await seen('/deals', () => call('POST', '/deals', { label: card, budget: 0, agent_id: me, ctr_agent_ids: [], fillers: [], products: [] }, token), card)) });
} finally {
  await browser.close();
}
