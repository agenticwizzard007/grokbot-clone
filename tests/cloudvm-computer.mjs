// End-to-end test for cloud VMs (COMPUTER_PROVIDER=cloudvm): every user gets exactly one VM,
// created automatically at sign-up, with one screen per Bot. Uses the fake VM driver (local
// process groups running the companion in --multi mode), so it needs Linux with Xvfb, xdotool,
// ImageMagick and Chrome, plus an existing Unix user for the Bots' shells (FAKE_VM_RUN_AS).
//
//   node tests/mock-xai.mjs &
//   COMPUTER_PROVIDER=cloudvm VM_DRIVER=fake FAKE_VM_RUN_AS=agent FAKE_VM_NO_SANDBOX=1 FAKE_VM_DIR=/tmp/vms \
//     VM_RECONCILE_MIN=0.1 XAI_API_KEY=mock XAI_BASE_URL=http://localhost:8790/v1 DEV_LOGIN=1 \
//     DB_PATH=/tmp/cloudvm.db node server/dist/index.js
//   DB_PATH=/tmp/cloudvm.db FAKE_VM_DIR=/tmp/vms node tests/cloudvm-computer.mjs [apiBase=http://localhost:8787]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const API = process.argv[2] ?? 'http://localhost:8787';
const SITE = 'http://127.0.0.1:8793';
const OUT = path.resolve(new URL('.', import.meta.url).pathname, 'out', 'cloudvm-computer');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DB_PATH = process.env.DB_PATH;
const VM_DIR = process.env.FAKE_VM_DIR;
if (!DB_PATH || !VM_DIR) throw new Error('Set DB_PATH and FAKE_VM_DIR to the server\'s values.');
const sql = new Database(DB_PATH);
sql.pragma('foreign_keys = ON');

// ---------- test website ----------

const events = [];
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  if (u.pathname === '/submitted') events.push(u.searchParams.get('q'));
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${u.pathname}</title><body style="font:24px sans-serif"><h1>${u.pathname} ${u.search.replace(/[<>&]/g, '')}</h1></body>`);
});
await new Promise((r) => site.listen(8793, '127.0.0.1', r));
const waitFor = async (what, pred, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await pred(); if (v) return v; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
};

// ---------- accounts ----------

const health = await (await fetch(`${API}/api/health`)).json();
if (health.computers !== 'cloudvm') throw new Error(`server must run with COMPUTER_PROVIDER=cloudvm (health: ${JSON.stringify(health)})`);

async function signUp(email) {
  const r = await fetch(`${API}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email.split('@')[0] }) });
  const cookie = (r.headers.get('set-cookie') ?? '').match(/grokbot_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error('sign-up failed');
  const api = async (p, init = {}) => {
    const res = await fetch(`${API}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: `grokbot_session=${cookie}`, ...(init.headers ?? {}) } });
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
  const bots = (await api('/api/bots')).body.bots;
  const me = (await api('/api/me').catch(() => null))?.body;
  return { email, cookie, api, bots, primary: bots.find((b) => b.isPrimary), userId: me?.user?.id ?? sql.prepare('SELECT id FROM users WHERE email=?').get(email).id };
}

async function chat(u, botId, text, ms = 120000) {
  const { body } = await u.api(`/api/bots/${botId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
  const after = body.row.seq;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const rows = (await u.api(`/api/bots/${botId}/rows`)).body.rows.filter((r) => r.seq > after);
    const done = rows.find((r) => (r.kind === 'message' && r.body.role === 'assistant' && !r.body.streaming) || r.kind === 'notice');
    if (done) return { reply: done.body.text, tools: rows.filter((r) => r.kind === 'tool-call').map((r) => r.body), ms: Date.now() - t0 };
    await sleep(300);
  }
  throw new Error(`no reply to: ${text.slice(0, 80)}`);
}
const script = (...steps) => `mock: ${steps.join(' | ')}`;
const call = (name, args = {}) => `${name} ${JSON.stringify(args)}`;
const noErrors = (r) => { const bad = r.tools.filter((t) => t.status !== 'done'); if (bad.length) throw new Error(`tool failed: ${bad.map((t) => `${t.name}: ${t.summary}`).join('; ')}`); };
const computer = async (u) => (await u.api('/api/computer')).body.computer;
const vmRows = () => sql.prepare('SELECT * FROM vms').all();

// ---------- steps ----------

const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name} (${Date.now() - t0}ms)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL ${name}: ${String(e?.message ?? e).split('\n')[0]}`); }
};

const stamp = Date.now().toString(36);
let A, B, second;

await step('sign-up creates the user\'s VM automatically, with a screen for its Bot', async () => {
  const t0 = Date.now();
  A = await signUp(`vm-a-${stamp}@example.com`);
  await waitFor('VM running with a screen', async () => { const c = await computer(A); return c.status === 'running' && c.screens.some((s) => s.botId === A.primary.id); }, 90000);
  console.log(`     ready ${Math.round((Date.now() - t0) / 100) / 10}s after sign-up`);
  const jobs = sql.prepare("SELECT kind, status FROM provision_jobs WHERE user_id=?").all(A.userId);
  if (!jobs.some((j) => j.kind === 'create' && j.status === 'done')) throw new Error(JSON.stringify(jobs));
});

await step('a second user gets their own, separate VM', async () => {
  B = await signUp(`vm-b-${stamp}@example.com`);
  await waitFor('B running', async () => (await computer(B)).status === 'running', 90000);
  const mine = vmRows().filter((v) => v.user_id === A.userId || v.user_id === B.userId);
  if (mine.length !== 2 || new Set(mine.map((v) => v.ext_id)).size !== 2) throw new Error(JSON.stringify(mine));
});

await step('one VM per user: retries and wake-ups never create another', async () => {
  await Promise.all([A.api('/api/computer/ensure', { method: 'POST' }), A.api('/api/computer/ensure', { method: 'POST' }), A.api('/api/computer/ensure', { method: 'POST' })]);
  await sleep(1500);
  const rows = vmRows().filter((v) => v.user_id === A.userId);
  if (rows.length !== 1) throw new Error(`user A has ${rows.length} VMs`);
  const dirs = fs.readdirSync(VM_DIR).filter((d) => JSON.parse(fs.readFileSync(path.join(VM_DIR, d, 'vm.json'), 'utf8')).userId === A.userId);
  if (dirs.length !== 1) throw new Error(`provider has ${dirs.length} VMs for user A`);
});

await step('a new Bot gets its own screen on the same VM', async () => {
  const created = await A.api('/api/bots', { method: 'POST', body: JSON.stringify({ name: 'Desk Two', label: 'Second screen test' }) });
  second = created.body.bot.id;
  sql.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(second); // skip the setup interview
  await A.api(`/api/bots/${second}/fresh`, { method: 'POST' });
  const r = await chat(A, second, script(call('computer_screenshot'), 'say {last}'));
  noErrors(r);
  const c = await computer(A);
  const ids = c.screens.map((s) => s.botId);
  if (!ids.includes(A.primary.id) || !ids.includes(second)) throw new Error(JSON.stringify(c.screens));
  if (vmRows().filter((v) => v.user_id === A.userId).length !== 1) throw new Error('second VM created');
});

await step('both Bots work at the same time, each in its own Chrome', async () => {
  const drive = (botId, q) => chat(A, botId, script(call('open_browser', { url: `${SITE}/start-${q}` }), call('computer_key', { keys: 'ctrl+l' }), call('computer_type', { text: `127.0.0.1:8793/submitted?q=${q}\n` }), 'say done'));
  const [r1, r2] = await Promise.all([drive(A.primary.id, 'quinn'), drive(second, 'desk2')]);
  noErrors(r1); noErrors(r2);
  await waitFor('both submissions', () => events.includes('quinn') && events.includes('desk2'), 20000);
  const shot1 = await A.api(`/api/bots/${A.primary.id}/screenshot`);
  const shot2 = await A.api(`/api/bots/${second}/screenshot`);
  fs.writeFileSync(path.join(OUT, 'screen-quinn.jpg'), Buffer.from(shot1.body));
  fs.writeFileSync(path.join(OUT, 'screen-desk2.jpg'), Buffer.from(shot2.body));
  if (Buffer.compare(Buffer.from(shot1.body), Buffer.from(shot2.body)) === 0) throw new Error('the two Bots see the same screen');
});

await step('each Bot\'s shell runs as the Bots\' user, in its own folder', async () => {
  const r = await chat(A, second, script(call('shell', { command: 'whoami; pwd; echo $DISPLAY' }), 'say {last}'));
  noErrors(r);
  if (!r.reply.includes('agent') || !r.reply.includes(`bots/${second}`)) throw new Error(r.reply);
});

await step('another user can\'t watch this user\'s Bot screens', async () => {
  const code = await new Promise((resolve) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/bots/${A.primary.id}/screen`, { headers: { cookie: `grokbot_session=${B.cookie}` } });
    ws.onopen = () => { ws.close(); resolve('open'); };
    ws.onerror = () => resolve('refused');
  });
  if (code !== 'refused') throw new Error('B opened A\'s screen');
});

await step('suspend, then the next task resumes the VM on its own', async () => {
  const s = await A.api('/api/computer/suspend', { method: 'POST' });
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
  await waitFor('suspended', async () => (await computer(A)).status === 'suspended', 30000);
  const t0 = Date.now();
  const r = await chat(A, A.primary.id, script(call('computer_screenshot'), 'say {last}'));
  noErrors(r);
  console.log(`     resumed and answered in ${Math.round((Date.now() - t0) / 100) / 10}s`);
  if ((await computer(A)).status !== 'running') throw new Error('not running after resume');
});

await step('viewer shows a Bot\'s screen (noVNC)', async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'grokbot_session', value: A.cookie, domain: new URL(API).hostname, path: '/' }]);
  const ui = await ctx.newPage();
  await ui.goto(API);
  await ui.getByText("Bot's computer").first().click({ timeout: 20000 });
  await ui.waitForFunction(() => {
    const c = document.querySelector('.viewer__screen canvas');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 0; i < d.length; i += 4000) if (d[i + 3] && d[i] + d[i + 1] + d[i + 2] > 60) painted++;
    return painted > 50;
  }, null, { timeout: 30000 });
  await ui.screenshot({ path: path.join(OUT, 'viewer.png') });
  await browser.close();
});

await step('deleting an account deletes its VM (cleanup loop)', async () => {
  const vm = vmRows().find((v) => v.user_id === B.userId);
  sql.prepare('DELETE FROM users WHERE id=?').run(B.userId); // what account deletion does; the VM row is detached
  await waitFor('B\'s VM destroyed', () => !vmRows().some((v) => v.vm_id === vm.vm_id) && !fs.existsSync(path.join(VM_DIR, vm.ext_id)), 90000);
});

site.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screens in ${OUT}`);
process.exit(failed.length ? 1 : 0);
