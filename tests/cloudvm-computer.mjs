// End-to-end test for cloud VMs (COMPUTER_PROVIDER=cloudvm): every user gets exactly one VM,
// created automatically at sign-up, with one screen per Bot. Uses the fake VM driver (local
// process groups running the companion in --multi mode), so it needs Linux with Xvfb, xdotool,
// ImageMagick and Chrome, plus an existing Unix user for the Bots' shells (FAKE_VM_RUN_AS).
//
//   node tests/mock-provider.mjs &
//   COMPUTER_PROVIDER=cloudvm VM_DRIVER=fake FAKE_VM_RUN_AS=agent FAKE_VM_NO_SANDBOX=1 FAKE_VM_DIR=/tmp/vms \
//     VM_RECONCILE_MIN=0.1 DIRECT_API_KEY=mock DIRECT_BASE_URL=http://localhost:8790/v1 DEV_LOGIN=1 \
//     DB_PATH=/tmp/cloudvm.db node server/dist/index.js
//   DB_PATH=/tmp/cloudvm.db FAKE_VM_DIR=/tmp/vms node tests/cloudvm-computer.mjs [apiBase=http://localhost:8787]
//
// Don't set SWARM_NO_SCHEDULER=1 on that server: it also stops the provisioning worker, so
// sign-ups never get their VM and most steps fail.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const API = process.argv[2] ?? 'http://localhost:8787';
const SITE_PORT = Number(process.env.TEST_SITE_PORT ?? 8793);
const SITE = `http://127.0.0.1:${SITE_PORT}`;
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
let captchaSolved = false;
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  if (u.pathname === '/submitted') events.push(u.searchParams.get('q'));
  // CAPTCHA pages: a visible reCAPTCHA-style widget (cleared when the "person" solves it), one that's never
  // solved, and an invisible badge that must not interrupt anything.
  if (u.pathname.startsWith('/recaptcha/api2/anchor')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<div style="font:14px sans-serif">☐ I\'m not a robot</div>'); }
  if (u.pathname === '/solve-captcha') { captchaSolved = true; res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/captcha-state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ solved: captchaSolved })); }
  if (u.pathname === '/captcha' || u.pathname === '/captcha-unsolved') {
    const poll = u.pathname === '/captcha' ? "setInterval(async()=>{const s=await (await fetch('/captcha-state')).json(); if(s.solved){document.getElementById('cap')?.remove(); document.getElementById('msg').textContent='Verified: welcome in';}},400)" : '';
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><title>Checkout</title><h1>Checkout</h1><p id="msg">Please verify you are not a robot.</p><iframe id="cap" title="reCAPTCHA" src="/recaptcha/api2/anchor?k=test" width="304" height="78"></iframe><script>${poll}</script>`);
  }
  if (u.pathname === '/invisible-captcha') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>Shop</title><h1>Shop</h1><p>Welcome to the shop.</p><iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=test&size=invisible" width="256" height="60" style="position:fixed;bottom:0;right:0"></iframe>');
  }
  if (u.pathname === '/form') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>Form</title><body style="font:20px sans-serif"><h1>Search</h1><form action="/submitted"><label>Query <input name="q" type="text"></label> <button>Go</button></form></body>');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${u.pathname}</title><body style="font:24px sans-serif"><h1>${u.pathname} ${u.search.replace(/[<>&]/g, '')}</h1></body>`);
});
await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));
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
  const cookie = (r.headers.get('set-cookie') ?? '').match(/swarm_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error('sign-up failed');
  const api = async (p, init = {}) => {
    const res = await fetch(`${API}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: `swarm_session=${cookie}`, ...(init.headers ?? {}) } });
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
    // The Bot's answer: not a CAPTCHA handoff notice (🧩), which it posts while it waits for the person.
    const done = rows.find((r) => (r.kind === 'message' && r.body.role === 'assistant' && !r.body.streaming && !/^🧩/.test(r.body.text ?? '')) || r.kind === 'notice');
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

const setUp = (u) => waitFor('VM set up', () => sql.prepare("SELECT 1 FROM provision_jobs WHERE user_id=? AND kind='create' AND status='done'").get(u.userId), 90000);

await step('sign-up creates the user\'s VM automatically, sets up its Bot\'s screen, then puts it to sleep', async () => {
  const t0 = Date.now();
  A = await signUp(`vm-a-${stamp}@example.com`);
  await setUp(A);
  console.log(`     set up ${Math.round((Date.now() - t0) / 100) / 10}s after sign-up`);
  await waitFor('asleep after setup', async () => (await computer(A)).status === 'suspended', 20000);
});

await step('a second user gets their own, separate VM', async () => {
  B = await signUp(`vm-b-${stamp}@example.com`);
  await setUp(B);
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
  const drive = (botId, q) => chat(A, botId, script(call('open_browser', { url: `${SITE}/start-${q}` }), call('computer_key', { keys: 'ctrl+l' }), call('computer_type', { text: `127.0.0.1:${SITE_PORT}/submitted?q=${q}\n` }), 'say done'));
  const [r1, r2] = await Promise.all([drive(A.primary.id, 'quinn'), drive(second, 'desk2')]);
  noErrors(r1); noErrors(r2);
  await waitFor('both submissions', () => events.includes('quinn') && events.includes('desk2'), 20000);
  const shot1 = await A.api(`/api/bots/${A.primary.id}/screenshot`);
  const shot2 = await A.api(`/api/bots/${second}/screenshot`);
  fs.writeFileSync(path.join(OUT, 'screen-quinn.jpg'), Buffer.from(shot1.body));
  fs.writeFileSync(path.join(OUT, 'screen-desk2.jpg'), Buffer.from(shot2.body));
  if (Buffer.compare(Buffer.from(shot1.body), Buffer.from(shot2.body)) === 0) throw new Error('the two Bots see the same screen');
});

await step('Playwright browser tools: navigate, read the page, type into an element by its ref, submit', async () => {
  // navigate returns the page itself (no separate browser_snapshot round trip)
  const r1 = await chat(A, second, script(call('browser_navigate', { url: `${SITE}/form` }), 'say {last}'));
  noErrors(r1);
  const ref = r1.reply.match(/textbox[^\n]*\[ref=([\w]+)\]/)?.[1];
  if (!ref) throw new Error(`no textbox ref in the navigate result: ${r1.reply}`);
  const r2 = await chat(A, second, script(call('browser_type', { element: 'search box', target: ref, text: 'typed by playwright', submit: true }), 'say {last}'));
  noErrors(r2);
  await waitFor('Playwright submission', () => events.includes('typed by playwright'), 20000);
  if (!/submitted/i.test(r2.reply)) throw new Error(`page after submit: ${r2.reply}`);
  const shot = await chat(A, second, script(call('browser_take_screenshot', {}), 'say done'));
  noErrors(shot);
});

const rowsOf = async (u, botId) => (await u.api(`/api/bots/${botId}/rows`)).body.rows;

await step('an invisible CAPTCHA badge doesn\'t interrupt the Bot', async () => {
  const before = (await rowsOf(A, second)).length;
  const r = await chat(A, second, script(call('browser_navigate', { url: `${SITE}/invisible-captcha` }), 'say {last}'));
  noErrors(r);
  if (!/Welcome to the shop/.test(r.reply)) throw new Error(r.reply);
  if ((await rowsOf(A, second)).slice(before).some((x) => x.kind === 'message' && /🧩/.test(x.body.text ?? ''))) throw new Error('handed off an invisible badge');
});

await step('a CAPTCHA is detected, handed to the user with a link to the Bot\'s screen, and the Bot continues once it\'s solved', async () => {
  captchaSolved = false;
  const t0 = Date.now();
  const pending = chat(A, second, script(call('browser_navigate', { url: `${SITE}/captcha` }), 'say {last}'));
  const ask = await waitFor('the handoff message', async () => (await rowsOf(A, second)).find((x) => x.kind === 'message' && /🧩/.test(x.body.text ?? '') && x.body.text.includes(`/?screen=${second}`)), 40000);
  console.log(`     handoff after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${ask.body.text.split('\n')[0].slice(0, 110)}`);
  const live = (await A.api('/api/bots')).body.live?.find?.((l) => l.botId === second);
  if (live && !live.awaiting) throw new Error('Bot not shown as waiting for the user');
  await fetch(`${SITE}/solve-captcha`); // the person solves it on the Bot's screen
  const r = await pending;
  noErrors(r);
  if (!/the user solved it/.test(r.reply)) throw new Error(r.reply);
  console.log(`     continued ${((Date.now() - t0) / 1000).toFixed(1)}s after the task started`);
});

await step('an unsolved CAPTCHA: the Bot is told to stop and explain (never to get around it)', async () => {
  const r = await chat(A, second, script(call('browser_navigate', { url: `${SITE}/captcha-unsolved` }), 'say {last}'), 120000);
  noErrors(r);
  if (!/still waiting for a person/.test(r.reply) || !/Don't try to solve or get around it/.test(r.reply)) throw new Error(r.reply);
});

await step('each Bot\'s shell runs as the Bots\' user, in its own folder', async () => {
  const r = await chat(A, second, script(call('shell', { command: 'whoami; pwd; echo $DISPLAY' }), 'say {last}'));
  noErrors(r);
  if (!r.reply.includes('agent') || !r.reply.includes(`bots/${second}`)) throw new Error(r.reply);
});

await step('another user can\'t watch this user\'s Bot screens', async () => {
  const code = await new Promise((resolve) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/bots/${A.primary.id}/screen`, { headers: { cookie: `swarm_session=${B.cookie}` } });
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
  await ctx.addCookies([{ name: 'swarm_session', value: A.cookie, domain: new URL(API).hostname, path: '/' }]);
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

await step('the "solve it on my screen" link opens the Bot\'s screen in Take control', async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'swarm_session', value: A.cookie, domain: new URL(API).hostname, path: '/' }]);
  const ui = await ctx.newPage();
  await ui.goto(`${API}/?screen=${second}`);
  await ui.getByRole('button', { name: "I'm done" }).waitFor({ timeout: 30000 }); // in control mode
  await ui.locator('.viewer__screen.is-control canvas').first().waitFor({ timeout: 30000 });
  if (new URL(ui.url()).search) throw new Error('link parameter left in the address bar');
  await ui.screenshot({ path: path.join(OUT, 'captcha-link-control.png') });
  await browser.close();
});

await step('a long-idle VM is archived (VM deleted, disk kept) and restored on the next task, files intact', async () => {
  const w = await chat(A, A.primary.id, script(call('shell', { command: 'echo kept-across-archive > note.txt && cat note.txt' }), 'say {last}'));
  noErrors(w);
  const disk = vmRows().find((v) => v.user_id === A.userId).volume_id;
  await A.api('/api/computer/suspend', { method: 'POST' });
  // The server under test archives after VM_ARCHIVE_AFTER_HOURS (set tiny for this test).
  await waitFor('archived', () => { const v = vmRows().find((r) => r.user_id === A.userId); return v.status === 'archived' && !v.ext_id; }, 90000);
  const vm = JSON.parse(fs.readFileSync(path.join(VM_DIR, disk, 'vm.json'), 'utf8'));
  if (!vm.archived || vm.pid) throw new Error('the VM process is still running');
  const t0 = Date.now();
  const r = await chat(A, A.primary.id, script(call('shell', { command: 'cat note.txt' }), 'say {last}'));
  noErrors(r);
  console.log(`     restored and answered in ${Math.round((Date.now() - t0) / 100) / 10}s`);
  if (!r.reply.includes('kept-across-archive')) throw new Error(r.reply);
  const after = vmRows().find((v) => v.user_id === A.userId);
  if (after.volume_id !== disk || after.status !== 'running') throw new Error(JSON.stringify(after));
});

await step('deleting an account deletes its VM and disk (cleanup loop)', async () => {
  const vm = vmRows().find((v) => v.user_id === B.userId);
  sql.prepare('DELETE FROM users WHERE id=?').run(B.userId); // what account deletion does; the VM row is detached
  await waitFor('B\'s VM destroyed', () => !vmRows().some((v) => v.vm_id === vm.vm_id) && !fs.existsSync(path.join(VM_DIR, vm.volume_id ?? vm.ext_id)), 90000);
});

site.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screens in ${OUT}`);
process.exit(failed.length ? 1 : 0);
