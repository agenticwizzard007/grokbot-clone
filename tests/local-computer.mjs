// End-to-end test for local computers: Bots using a Chrome browser on "your PC" via the companion.
//
// Prerequisites (see .env.example):
//   COMPUTER_PROVIDER=local, DEV_LOGIN=1, and DIRECT_BASE_URL pointing at tests/mock-provider.mjs
//   node tests/mock-provider.mjs &            # scripted stand-in for the model
//   npm run dev -w server & npm run dev -w web &
// Then: node tests/local-computer.mjs [apiBase=http://localhost:8787] [uiBase=http://localhost:5173]
// (Set COMPANION_NO_SANDBOX=1 where Chrome's sandbox is unavailable, e.g. in containers.)
//
// It serves a small test website on 127.0.0.1:8791, pairs a fresh companion (with
// --allow-private-network so it can reach that site), and checks real effects on the site.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.argv[2] ?? 'http://localhost:8787';
const UI = process.argv[3] ?? 'http://localhost:5173';
const SITE = 'http://127.0.0.1:8791';
const OUT = path.resolve(new URL('.', import.meta.url).pathname, 'out', 'local-computer');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- test website ----------

const events = [];
const page = (title, body, script = '') => `<!doctype html><html><head><title>${title}</title><style>
body{margin:0;font:16px sans-serif} .a{position:absolute;left:100px;width:300px;height:40px;display:block;box-sizing:border-box}
</style></head><body>${body}<script>const log=(q)=>fetch('/log?'+q);${script}</script></body></html>`;
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  const html = (s) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(s); };
  if (u.pathname === '/log') { events.push(Object.fromEntries(u.searchParams)); res.end('ok'); return; }
  if (u.pathname === '/form') return html(page('Form', `
    <form action="/submitted" method="get"><input id="q" name="q" class="a" style="top:100px" autocomplete="off"></form>
    <a href="/tab2" target="_blank" class="a" style="top:200px;background:#cde">Open tab</a>
    <button class="a" style="top:300px" onclick="alert('hi'); log('alert=ok')">Alert</button>
    <a href="/download" class="a" style="top:400px;background:#edc">Download</a>
    <input type="file" class="a" style="top:500px" onchange="log('file=changed')">`, "log('form=loaded')"));
  if (u.pathname === '/submitted') { events.push({ submitted: u.searchParams.get('q') }); return html(page('Submitted', `<h1>Thanks: ${(u.searchParams.get('q') ?? '').replace(/[<>&]/g, '')}</h1>`)); }
  if (u.pathname === '/tab2') return html(page('Tab 2', `<button class="a" style="top:200px" onclick="log('tab2=click')">Tab 2 button</button>`, "log('tab2=loaded')"));
  if (u.pathname === '/long') return html(page('Long', '<div style="height:6000px;background:linear-gradient(#fff,#99f)">Long page</div>', "let t;addEventListener('scroll',()=>{clearTimeout(t);t=setTimeout(()=>log('scroll='+Math.round(scrollY)),150)})"));
  if (u.pathname === '/page1' || u.pathname === '/page2') return html(page(u.pathname.slice(1), `<h1>${u.pathname}</h1>`, `addEventListener('pageshow',()=>log('show=${u.pathname.slice(1)}'))`));
  if (u.pathname === '/download') { events.push({ download: 'requested' }); res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="swarm-test-download.txt"' }); res.end('should not be saved'); return; }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => site.listen(8791, '127.0.0.1', r));
const waitEvent = async (pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await sleep(150); }
  throw new Error(`site never saw the expected event (got ${JSON.stringify(events.slice(-5))})`);
};

// ---------- API helpers ----------

const health = await (await fetch(`${API}/api/health`)).json();
if (health.computers !== 'local') throw new Error(`server must run with COMPUTER_PROVIDER=local (health: ${JSON.stringify(health)})`);
const login = await fetch(`${API}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_EMAIL ?? 'local-e2e@example.com', name: 'Local E2E' }) });
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
async function chat(text, ms = 60000) {
  const { body } = await api(`/api/bots/${botId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
  const after = body.row.seq;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const rows = (await api(`/api/bots/${botId}/rows`)).body.rows.filter((r) => r.seq > after);
    const done = rows.find((r) => (r.kind === 'message' && r.body.role === 'assistant' && !r.body.streaming) || r.kind === 'notice');
    if (done) return { reply: done.body.text, tools: rows.filter((r) => r.kind === 'tool-call').map((r) => r.body) };
    await sleep(300);
  }
  throw new Error(`no reply to: ${text.slice(0, 80)}`);
}
const script = (...steps) => `mock: ${steps.join(' | ')}`;
const call = (name, args = {}) => `${name} ${JSON.stringify(args)}`;
const noErrors = (r) => { const bad = r.tools.filter((t) => t.status !== 'done'); if (bad.length) throw new Error(`tool failed: ${bad.map((t) => `${t.name}: ${t.summary}`).join('; ')}`); };

// ---------- companion ----------

let companion = null;
const companionLog = [];
async function startCompanion(extra = []) {
  const { body } = await api('/api/computer/pair', { method: 'POST' });
  if (!body.token) throw new Error('pairing failed: ' + JSON.stringify(body));
  const file = path.join(os.tmpdir(), 'swarm-companion-e2e.mjs');
  fs.writeFileSync(file, Buffer.from((await (await fetch(`${API}/api/companion/script`)).arrayBuffer())));
  companion = spawn(process.execPath, [file, '--server', API, '--token', body.token, '--data-dir', path.join(os.tmpdir(), 'swarm-companion-e2e'), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  companion.stdout.on('data', (d) => companionLog.push(...String(d).trim().split('\n')));
  companion.stderr.on('data', (d) => companionLog.push(...String(d).trim().split('\n')));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await api('/api/computer')).body.computer.status === 'running') return;
    await sleep(250);
  }
  throw new Error('companion never connected: ' + companionLog.join(' / '));
}
const stopCompanion = async () => { if (companion && companion.exitCode === null) { companion.kill('SIGINT'); await new Promise((r) => companion.once('exit', r)); } };

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

await step('pair + connect a PC (companion)', async () => {
  await startCompanion(['--allow-private-network', ...(process.env.COMPANION_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])]);
  const { computer } = (await api('/api/computer')).body;
  if (computer.provider !== 'local' || !computer.device?.platform) throw new Error(JSON.stringify(computer));
});

await step('bot opens a page, clicks, types, presses Enter (form submits)', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/form` }), call('computer_click', { x: 250, y: 120 }), call('computer_type', { text: 'hello swarm\n' }), 'say done {last}'));
  noErrors(r);
  await waitEvent((e) => e.submitted === 'hello swarm');
});

await step('screenshot returns a 1280x800 image', async () => {
  const r = await chat(script(call('computer_screenshot'), 'say {last}'));
  noErrors(r);
  if (!/1280x800/.test(r.reply)) throw new Error(r.reply);
});

await step('keys: ctrl+a, BackSpace, Return', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/form` }), call('computer_click', { x: 250, y: 120 }), call('computer_type', { text: 'abc' }), call('computer_key', { keys: 'ctrl+a' }), call('computer_key', { keys: 'BackSpace' }), call('computer_type', { text: 'xyz' }), call('computer_key', { keys: 'Return' }), 'say ok'));
  noErrors(r);
  await waitEvent((e) => e.submitted === 'xyz');
});

await step('link opening a new tab is followed', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/form` }), call('computer_click', { x: 200, y: 220 }), call('computer_click', { x: 200, y: 220 }), 'say ok'));
  noErrors(r);
  await waitEvent((e) => e.tab2 === 'loaded');
  await waitEvent((e) => e.tab2 === 'click');
});

await step('ctrl+w closes the tab, back to the first one', async () => {
  const r = await chat(script(call('computer_key', { keys: 'ctrl+w' }), call('computer_click', { x: 250, y: 120 }), call('computer_type', { text: 'after close\n' }), 'say ok'));
  noErrors(r);
  await waitEvent((e) => e.submitted === 'after close');
});

await step('alert() dialogs do not block the page', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/form` }), call('computer_click', { x: 200, y: 320 }), call('computer_screenshot'), 'say ok'));
  noErrors(r);
  await waitEvent((e) => e.alert === 'ok');
});

await step('scroll moves the page', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/long` }), call('computer_scroll', { x: 640, y: 400, direction: 'down', amount: 5 }), 'say ok'));
  noErrors(r);
  const e = await waitEvent((e) => e.scroll && Number(e.scroll) > 0);
  if (Number(e.scroll) < 300) throw new Error(`scrolled only ${e.scroll}px`);
});

await step('alt+Left goes back', async () => {
  const r = await chat(script(call('open_browser', { url: `${SITE}/page1` }), call('open_browser', { url: `${SITE}/page2` }), call('computer_key', { keys: 'alt+Left' }), 'say ok'));
  noErrors(r);
  const t0 = Date.now();
  while (events.filter((e) => e.show === 'page1').length < 2 && Date.now() - t0 < 10000) await sleep(150);
  if (events.filter((e) => e.show === 'page1').length < 2) throw new Error('page1 was not shown again');
});

await step('guard rails: file:// blocked, downloads denied, no shell tool', async () => {
  const r = await chat(script(call('open_browser', { url: 'file:///etc/passwd' }), 'say {last}'));
  if (!/Only http\(s\) pages/.test(r.reply)) throw new Error(`file:// was not blocked: ${r.reply}`);
  const before = fs.existsSync(path.join(os.homedir(), 'Downloads', 'swarm-test-download.txt'));
  const d = await chat(script(call('open_browser', { url: `${SITE}/form` }), call('computer_click', { x: 200, y: 420 }), 'say ok'));
  noErrors(d);
  await sleep(1500);
  if (!before && fs.existsSync(path.join(os.homedir(), 'Downloads', 'swarm-test-download.txt'))) throw new Error('a download was saved');
  const s = await chat(script(call('shell', { command: 'id' }), 'say {last}'));
  if (!/no shell/i.test(s.reply)) throw new Error(`shell was not refused: ${s.reply}`);
});

await step('save_file lands in the Library and downloads', async () => {
  const r = await chat(script(call('save_file', { filename: 'notes.md', content: '# Notes\nfrom the local computer test' }), 'say {last}'));
  noErrors(r);
  const list = (await api(`/api/bots/${botId}/files`)).body;
  if (!list.files?.some((f) => f.name === 'notes.md')) throw new Error(JSON.stringify(list));
  const { body } = await api(`/api/bots/${botId}/files/download`, { method: 'POST', body: JSON.stringify({ path: 'notes.md' }) });
  const raw = await api(body.url);
  if (!Buffer.from(raw.body).toString().includes('from the local computer test')) throw new Error('download content mismatch');
  const bad = await api(`/api/bots/${botId}/files/raw?path=${encodeURIComponent('../../etc/passwd')}`);
  if (bad.status !== 400) throw new Error(`path traversal not rejected (${bad.status})`);
});

await step('thumbnail endpoint serves the browser', async () => {
  const r = await api(`/api/bots/${botId}/screenshot`);
  if (r.status !== 200 || Buffer.from(r.body).length < 2000) throw new Error(`status ${r.status}`);
  fs.writeFileSync(path.join(OUT, 'thumbnail.jpg'), Buffer.from(r.body));
});

// ---------- UI: live viewer, take control, settings ----------

// Use installed Chrome: CHROME_PATH, /usr/bin/google-chrome on Linux, or Playwright's 'chrome' channel (macOS/Windows).
const chromeExe = process.env.CHROME_PATH ?? (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
browser = await chromium.launch(chromeExe ? { executablePath: chromeExe, args: ['--no-sandbox'] } : { channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'swarm_session', value: cookie, domain: new URL(UI).hostname, path: '/' }]);
ui = await ctx.newPage();
const consoleErrors = [];
ui.on('pageerror', (e) => consoleErrors.push(e.message));

await step('viewer shows the bot browser live (noVNC)', async () => {
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
    let nonBlank = 0;
    for (let i = 0; i < d.length; i += 4000) if (d[i + 3] && (d[i] < 250 || d[i + 1] < 250)) nonBlank++;
    return nonBlank > 5;
  }, null, { timeout: 20000 });
  await ui.screenshot({ path: path.join(OUT, 'viewer-watch.png') });
});

await step('watch mode ignores input', async () => {
  const n = events.filter((e) => e.submitted).length;
  const box = await ui.locator('.viewer__screen canvas').first().boundingBox();
  await ui.mouse.click(box.x + (250 / 1280) * box.width, box.y + (120 / 800) * box.height);
  await ui.keyboard.type('watch-only');
  await ui.keyboard.press('Enter');
  await sleep(1500);
  if (events.filter((e) => e.submitted).length !== n) throw new Error('input leaked through watch mode');
});

await step('take control: click + type in the viewer reaches the page', async () => {
  await ui.getByRole('button', { name: 'Take control' }).click();
  await ui.getByRole('button', { name: "I'm done" }).waitFor({ timeout: 15000 });
  const canvas = ui.locator('.viewer__screen.is-control canvas').first();
  await canvas.waitFor({ timeout: 20000 });
  await sleep(1200);
  const box = await canvas.boundingBox();
  await ui.mouse.click(box.x + (250 / 1280) * box.width, box.y + (120 / 800) * box.height);
  await sleep(300);
  await ui.keyboard.type('typed by me');
  await ui.keyboard.press('Enter');
  await waitEvent((e) => e.submitted === 'typed by me', 15000);
  await sleep(800);
  await ui.screenshot({ path: path.join(OUT, 'viewer-control.png') });
  await ui.getByRole('button', { name: "I'm done" }).click();
  await ui.getByRole('button', { name: 'Take control' }).waitFor({ timeout: 15000 });
  await ui.getByLabel('Close computer').click();
});

await step('settings: Computer shows the connected PC and its browser', async () => {
  await ui.keyboard.press('Control+,');
  await ui.locator('.cfg-nav__item', { hasText: 'Computer' }).click();
  await ui.getByText(/Your PC · Connected/).waitFor({ timeout: 10000 });
  await ui.getByText('Browsers in use').waitFor();
  await ui.screenshot({ path: path.join(OUT, 'settings-connected.png') });
});

await step('close a bot browser from settings', async () => {
  const r = await api(`/api/bots/${botId}/screen/reset`, { method: 'POST' });
  if (!r.body.ok) throw new Error(JSON.stringify(r.body));
  const { computer } = (await api('/api/computer')).body;
  if (computer.screens.length) throw new Error('browser still listed');
});

await step('PC disconnects: UI says so, tools explain how to reconnect', async () => {
  await stopCompanion();
  await ui.getByText(/Your PC · Not connected/).waitFor({ timeout: 10000 });
  await ui.locator('button.cfg-btn', { hasText: /New connect command|Connect your PC|Connect another PC/ }).click();
  await ui.getByLabel('Connect command').waitFor({ timeout: 10000 });
  const cmd = await ui.getByLabel('Connect command').innerText();
  if (!/swarm-companion\.mjs --server .* --token swc_/.test(cmd)) throw new Error(cmd);
  await ui.screenshot({ path: path.join(OUT, 'settings-connect-command.png') });
  const r = await chat(script(call('open_browser', { url: `${SITE}/form` }), 'say {last}'));
  if (!/isn't connected/.test(r.reply)) throw new Error(r.reply);
});

await step('revoked token is rejected', async () => {
  await api('/api/computer/pair', { method: 'DELETE' });
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/companion`);
  const code = await new Promise((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: 'swc_not-a-real-token' }));
    ws.onclose = (e) => resolve(e.code);
  });
  if (code !== 4401) throw new Error(`expected 4401, got ${code}`);
});

await stopCompanion();
await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Page errors: ${consoleErrors.length}. Screenshots in ${OUT}`);
if (failed.length) console.log('Companion log:\n' + companionLog.slice(-15).join('\n'));
process.exit(failed.length ? 1 : 0);
