// End-to-end test for full-desktop computers: Bots using the real desktop of the machine the
// server runs on (COMPUTER_PROVIDER=desktop, companion started with --desktop).
//
// Prerequisites: Linux with an X display (e.g. `Xvfb :99 -screen 0 1440x900x24`), xdotool,
// ImageMagick (import), and Google Chrome. Start the mock model and a server on that display:
//   node tests/mock-provider.mjs &
//   DISPLAY=:99 BROWSER=<script that opens Chrome full screen> COMPUTER_PROVIDER=desktop \
//     DIRECT_API_KEY=mock DIRECT_BASE_URL=http://localhost:8790/v1 DEV_LOGIN=1 node server/dist/index.js
// Then: DB_PATH=<the server's database> node tests/desktop-computer.mjs [apiBase=http://localhost:8787]
//
// BROWSER is what xdg-open uses as the default browser. The clicks below assume the page fills a
// 1440x900 screen (Chrome --kiosk), so screenshots are 1280x800 and page px = screenshot px * 1.125.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.argv[2] ?? 'http://localhost:8787';
const UI = API;
const SITE = 'http://127.0.0.1:8792';
const OUT = path.resolve(new URL('.', import.meta.url).pathname, 'out', 'desktop-computer');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Page px -> screenshot px (1440x900 screen, 1280x800 screenshots). */
const S = (v) => Math.round(v / 1.125);

// ---------- test website ----------

const events = [];
const page = (title, body, script = '') => `<!doctype html><html><head><title>${title}</title><style>
body{margin:0;font:16px sans-serif} .a{position:absolute;left:100px;width:300px;height:40px;display:block;box-sizing:border-box}
</style></head><body>${body}<script>const log=(q)=>fetch('/log?'+q);${script}</script></body></html>`;
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  const html = (s) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(s); };
  if (u.pathname === '/log') { events.push(Object.fromEntries(u.searchParams)); res.end('ok'); return; }
  if (u.pathname === '/form') return html(page('Form', `<form action="/submitted" method="get"><input id="q" name="q" class="a" style="top:100px" autocomplete="off"></form>`, "log('form=loaded')"));
  if (u.pathname === '/submitted') { events.push({ submitted: u.searchParams.get('q') }); return html(page('Submitted', `<h1>Thanks: ${(u.searchParams.get('q') ?? '').replace(/[<>&]/g, '')}</h1>`)); }
  if (u.pathname === '/long') return html(page('Long', '<div style="height:6000px;background:linear-gradient(#fff,#99f)">Long page</div>', "let t;addEventListener('scroll',()=>{clearTimeout(t);t=setTimeout(()=>log('scroll='+Math.round(scrollY)),150)})"));
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => site.listen(8792, '127.0.0.1', r));
const waitEvent = async (pred, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await sleep(150); }
  throw new Error(`site never saw the expected event (got ${JSON.stringify(events.slice(-5))})`);
};

// ---------- API helpers ----------

const health = await (await fetch(`${API}/api/health`)).json();
if (health.computers !== 'local' || !health.desktop) throw new Error(`server must run with COMPUTER_PROVIDER=desktop (health: ${JSON.stringify(health)})`);
const login = await fetch(`${API}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_EMAIL ?? 'desktop-e2e@example.com', name: 'Desktop E2E' }) });
const cookie = (login.headers.get('set-cookie') ?? '').match(/swarm_session=([^;]+)/)?.[1];
if (!cookie) throw new Error('dev login failed');
const api = async (p, init = {}) => {
  const r = await fetch(`${API}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: `swarm_session=${cookie}`, ...(init.headers ?? {}) } });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer() };
};
const bots = (await api('/api/bots')).body.bots;
const botId = bots.find((b) => b.isPrimary).id;
const botName = bots.find((b) => b.isPrimary).name;
await api(`/api/bots/${botId}/fresh`, { method: 'POST' });

/** Send a chat message (a mock-model script) and wait for the Bot's final reply. */
async function chat(text, ms = 90000, id = botId) {
  const { body } = await api(`/api/bots/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
  const after = body.row.seq;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const rows = (await api(`/api/bots/${id}/rows`)).body.rows.filter((r) => r.seq > after);
    const done = rows.find((r) => (r.kind === 'message' && r.body.role === 'assistant' && !r.body.streaming) || r.kind === 'notice');
    if (done) return { reply: done.body.text, tools: rows.filter((r) => r.kind === 'tool-call').map((r) => r.body), ms: Date.now() - t0 };
    await sleep(300);
  }
  throw new Error(`no reply to: ${text.slice(0, 80)}`);
}
const script = (...steps) => `mock: ${steps.join(' | ')}`;
const call = (name, args = {}) => `${name} ${JSON.stringify(args)}`;
const noErrors = (r) => { const bad = r.tools.filter((t) => t.status !== 'done'); if (bad.length) throw new Error(`tool failed: ${bad.map((t) => `${t.name}: ${t.summary}`).join('; ')}`); };
const connected = async (want, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (((await api('/api/computer')).body.computer.status === 'running') === want) return;
    await sleep(250);
  }
  throw new Error(`computer never became ${want ? 'connected' : 'disconnected'}`);
};

// ---------- steps ----------

const results = [];
let browser = null;
let ui = null;
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name} (${Date.now() - t0}ms)`); }
  catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e).split('\n')[0] });
    console.log(`FAIL ${name}: ${String(e?.message ?? e).split('\n')[0]}`);
    if (ui) await ui.screenshot({ path: path.join(OUT, `FAIL-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
  }
};

await step('"Use this computer" starts the companion in full-desktop mode', async () => {
  const r = await api('/api/computer/this-computer', { method: 'POST' });
  if (!r.body.ok) throw new Error(JSON.stringify(r.body));
  await connected(true);
  const { computer } = (await api('/api/computer')).body;
  if (computer.provider !== 'local' || !computer.desktop || !computer.device?.platform) throw new Error(JSON.stringify(computer));
});

await step('open_browser opens the page in the default browser', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/form` }), 'say {last}'));
  noErrors(r);
  await waitEvent((e) => e.form === 'loaded');
});

await step('screenshot is the desktop, scaled to 1280x800', async () => {
  await sleep(1500); // first Chrome start
  const r = await chat(script(call('computer_screenshot'), 'say {last}'));
  noErrors(r);
  if (!/1280x800/.test(r.reply)) throw new Error(r.reply);
});

await step('click + type + Enter reach the page (coordinates scaled)', async () => {
  const r = await chat(script(call('computer_click', { x: S(250), y: S(120) }), call('computer_type', { text: 'hello desktop\n' }), 'say ok'));
  noErrors(r);
  await waitEvent((e) => e.submitted === 'hello desktop');
});

await step('keys: ctrl+a, BackSpace, Return', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/form` }), call('computer_click', { x: S(250), y: S(120) }), call('computer_type', { text: 'abc' }), call('computer_key', { keys: 'ctrl+a' }), call('computer_key', { keys: 'BackSpace' }), call('computer_type', { text: 'xyz' }), call('computer_key', { keys: 'Return' }), 'say ok'));
  noErrors(r);
  await waitEvent((e) => e.submitted === 'xyz');
});

await step('scroll moves the page', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/long` }), call('computer_scroll', { x: 640, y: 400, direction: 'down', amount: 5 }), 'say ok'));
  noErrors(r);
  const e = await waitEvent((e) => e.scroll && Number(e.scroll) > 0);
  if (Number(e.scroll) < 100) throw new Error(`scrolled only ${e.scroll}px`);
});

await step('shell runs commands as the user', async () => {
  const r = await chat(script(call('shell', { command: 'echo $((6*7)); whoami' }), 'say {last}'));
  noErrors(r);
  if (!r.reply.includes('42') || !r.reply.includes(os.userInfo().username)) throw new Error(r.reply);
  const t = await chat(script(call('shell', { command: 'sleep 10', timeout_seconds: 1 }), 'say {last}'));
  if (!/124/.test(t.reply)) throw new Error(`timeout not enforced: ${t.reply}`);
});

await step('non-web URLs are refused by open_browser', async () => {
  const r = await chat(script(call('open_browser', { url: 'file:///etc/passwd' }), 'say {last}'));
  if (!/Only http\(s\) pages/.test(r.reply)) throw new Error(r.reply);
});

await step('save_file lands in the Library', async () => {
  const r = await chat(script(call('save_file', { filename: 'desktop-notes.md', content: '# Notes\nfrom the desktop test' }), 'say {last}'));
  noErrors(r);
  const list = (await api(`/api/bots/${botId}/files`)).body;
  if (!list.files?.some((f) => f.name === 'desktop-notes.md')) throw new Error(JSON.stringify(list));
});

await step('thumbnail endpoint serves the desktop', async () => {
  const r = await api(`/api/bots/${botId}/screenshot`);
  if (r.status !== 200 || Buffer.from(r.body).length < 2000) throw new Error(`status ${r.status}`);
  fs.writeFileSync(path.join(OUT, 'thumbnail.jpg'), Buffer.from(r.body));
});

await step('reset keeps the user\'s windows open', async () => {
  const r = await api(`/api/bots/${botId}/screen/reset`, { method: 'POST' });
  if (!r.body.ok || !/nothing was closed/.test(r.body.note ?? '')) throw new Error(JSON.stringify(r.body));
  const s = await chat(script(call('computer_screenshot'), 'say {last}'));
  noErrors(s);
});

// ---------- one Bot at a time ----------

await step('a second Bot waits while another is using the desktop', async () => {
  const created = await api('/api/bots', { method: 'POST', body: JSON.stringify({ name: 'Desk Two', label: 'Desktop lock test' }) });
  const other = created.body.bot?.id;
  if (!other) throw new Error(JSON.stringify(created.body));
  // Skip the setup interview: mark the new Bot active directly in the server's database.
  if (!process.env.DB_PATH) throw new Error('set DB_PATH (the server\'s database) to run this step');
  const { default: Database } = await import('better-sqlite3');
  const sql = new Database(process.env.DB_PATH);
  sql.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(other);
  sql.close();
  await api(`/api/bots/${other}/fresh`, { method: 'POST' });
  // Bot one takes the desktop, then keeps its turn busy in the shell for 8s.
  const first = chat(script(call('computer_screenshot'), call('shell', { command: 'sleep 8' }), 'say first done'));
  await sleep(2500);
  const t0 = Date.now();
  const second = await chat(script(call('computer_screenshot'), 'say second done'), 90000, other);
  const f = await first;
  noErrors(second);
  noErrors(f);
  if (Date.now() - t0 < 4000) throw new Error(`second Bot did not wait (${Date.now() - t0}ms)`);
});

// ---------- UI: live viewer, take control, settings ----------

const chromeExe = process.env.CHROME_PATH ?? (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
browser = await chromium.launch(chromeExe ? { executablePath: chromeExe, args: ['--no-sandbox'] } : { channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'swarm_session', value: cookie, domain: new URL(UI).hostname, path: '/' }]);
ui = await ctx.newPage();
const consoleErrors = [];
ui.on('pageerror', (e) => consoleErrors.push(e.message));

await step('viewer shows the desktop live (noVNC)', async () => {
  await chat(script(call('open_browser', { url: `${SITE}/form` }), 'say ok'));
  await ui.goto(UI);
  await ui.getByPlaceholder(new RegExp(`Message ${botName}`)).first().waitFor({ timeout: 15000 });
  await ui.getByText('Connected').first().waitFor({ timeout: 10000 });
  await ui.getByText("Bot's computer").first().click();
  const canvas = ui.locator('.viewer__screen canvas').first();
  await canvas.waitFor({ timeout: 20000 });
  await ui.waitForFunction(() => {
    const c = document.querySelector('.viewer__screen canvas');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // The test page is mostly white: look for painted (opaque, not black) pixels.
    let painted = 0;
    for (let i = 0; i < d.length; i += 4000) if (d[i + 3] && d[i] + d[i + 1] + d[i + 2] > 60) painted++;
    return painted > 50;
  }, null, { timeout: 20000 });
  await ui.screenshot({ path: path.join(OUT, 'viewer-watch.png') });
});

await step('take control: click + type in the viewer reaches the page', async () => {
  await ui.getByRole('button', { name: 'Take control' }).click();
  await ui.getByRole('button', { name: "I'm done" }).waitFor({ timeout: 15000 });
  const canvas = ui.locator('.viewer__screen.is-control canvas').first();
  await canvas.waitFor({ timeout: 20000 });
  await sleep(1500);
  const box = await canvas.boundingBox();
  await ui.mouse.click(box.x + (S(250) / 1280) * box.width, box.y + (S(120) / 800) * box.height);
  await sleep(600);
  await ui.keyboard.type('typed by me', { delay: 40 });
  await ui.keyboard.press('Enter');
  await waitEvent((e) => e.submitted === 'typed by me', 20000);
  await sleep(1200);
  await ui.screenshot({ path: path.join(OUT, 'viewer-control.png') });
  await ui.getByRole('button', { name: "I'm done" }).click();
  await ui.getByLabel('Close computer').click();
});

await step('settings: Computer describes the full desktop', async () => {
  await ui.keyboard.press('Control+,');
  await ui.locator('.cfg-nav__item', { hasText: 'Computer' }).click();
  await ui.getByText(/Your PC · Connected/).waitFor({ timeout: 10000 });
  await ui.getByText('Bots using the desktop').waitFor();
  await ui.getByText(/full desktop and apps/).waitFor();
  await ui.screenshot({ path: path.join(OUT, 'settings-desktop.png') });
});

await step('a browser-only companion is refused by a desktop server', async () => {
  const { body } = await api('/api/computer/pair', { method: 'POST' });
  const file = path.join(os.tmpdir(), 'swarm-companion-desktop-e2e.mjs');
  fs.writeFileSync(file, Buffer.from((await (await fetch(`${API}/api/companion/script`)).arrayBuffer())));
  if (!/node swarm-companion\.mjs .* --desktop$/.test(body.command)) throw new Error(`connect command lacks --desktop: ${body.command}`);
  const p = spawn(process.execPath, [file, '--server', API, '--token', body.token, '--no-sandbox', '--data-dir', path.join(os.tmpdir(), 'swarm-companion-desktop-e2e')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => { const t = setTimeout(() => { p.kill(); r('timeout'); }, 15000); p.on('exit', (c) => { clearTimeout(t); r(c); }); });
  if (code !== 1 || !/--desktop/.test(out)) throw new Error(`exit ${code}: ${out.slice(-300)}`);
  const { computer } = (await api('/api/computer')).body;
  if (computer.status !== 'running') throw new Error('the desktop companion was disconnected');
});

await step('Stop disconnects the computer', async () => {
  const r = await api('/api/computer/this-computer', { method: 'DELETE' });
  if (!r.body.ok) throw new Error(JSON.stringify(r.body));
  await connected(false);
  const t = await chat(script(call('computer_screenshot'), 'say {last}'));
  if (!/isn't connected/.test(t.reply)) throw new Error(t.reply);
});

await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Page errors: ${consoleErrors.length}. Screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
