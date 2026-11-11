// Run: npm run build -w web && node tests/voice-apps-ui.mjs
// Built app + real browser audio, with fake mic, realtime provider and HTTP APIs. No live accounts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

await fs.access(new URL('../web/dist/index.html', import.meta.url));
const shots = new URL('../.context/voice-apps-ui/', import.meta.url);
await fs.mkdir(shots, { recursive: true });
const port = await new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '';
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const origin = `http://127.0.0.1:${port}`;
const waitFor = async predicate => {
  for (let n = 0; n < 100; n++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for mocked browser state');
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const connection = { botId: 'research', seq: 21, toolkit: 'gmail', toolkitName: 'Gmail' };
const approval = { botId: 'research', seq: 22, body: {
  type: 'card', card: 'approval', approvalId: 'approval-send-mail', title: 'Send the agenda email?', detail: 'To Sam: the agenda for tomorrow.',
  tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', toolkitName: 'Gmail', args: {}, status: 'pending',
} };
let browser;
try {
  await waitFor(async () => {
    if (vite.exitCode !== null) throw new Error(logs);
    return fetch(origin).then(r => r.ok, () => false);
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

  async function fixture(native = false) {
    const page = await browser.newPage({ viewport: native ? { width: 390, height: 844 } : { width: 1280, height: 900 }, userAgent: native ? 'Mozilla/5.0 SwarmNative/1.0 (iOS)' : undefined });
    page.setDefaultTimeout(10000);
    const errors = [], requests = [], frames = [];
    let socket, sessions = 0;
    let snapshot = { cursor: 0, updates: [], tasks: [], connectionRequests: [], approvals: [] };
    let connectResponse = { redirectUrl: 'https://auth.example.test/gmail' };
    let connectStatus = 200, connectGate;
    let toolResult = { output: 'Connect Gmail to continue.', connectionRequest: { ...connection, url: 'https://untrusted.example/ignore-me', redirectUrl: 'https://untrusted.example/ignore-me' } };
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('swarm.selectedBot', 'main');
      localStorage.setItem('swarm.detailsOpen', '0');
      window.__popups = [];
      window.open = (url, target) => {
        const record = { url, target, navigated: null, closed: false, userGesture: navigator.userActivation.isActive };
        window.__popups.push(record);
        return { location: { set href(value) { record.navigated = value; } }, close() { record.closed = true; } };
      };
    });
    const bot = { id: 'main', name: 'Main agent', isPrimary: true, label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue', mode: 'personal', pinned: true, effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: '', lastActivityAt: 1, createdAt: 1 };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const payload = route.request().postDataJSON();
      requests.push({ path, body: payload });
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'test-user', name: 'Alex', email: 'alex@example.test' }, devLogin: true };
      else if (path === '/api/bots') body = { bots: [bot, { ...bot, id: 'research', name: 'Research agent', isPrimary: false }], live: [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'cloudvm' } };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' });
      else if (path === '/api/voice/session') body = { callId: `call-${++sessions}`, clientSecret: 'ephemeral', clientSecretProtocol: 'xai-client-secret', websocketUrl: 'wss://voice.example.test/realtime', sampleRate: 24000, session: {}, tools: [] };
      else if (path === '/api/voice/updates') body = snapshot;
      else if (path === '/api/voice/tool') body = toolResult;
      else if (path === '/api/apps/gmail/connect') {
        const gate = connectGate, result = connectResponse, status = connectStatus;
        if (gate) await gate.promise;
        return route.fulfill({ status, json: result });
      } else if (path.startsWith('/api/approvals/') || path === '/api/voice/end') body = { ok: true };
      await route.fulfill({ json: body });
    });
    await page.routeWebSocket('wss://voice.example.test/realtime', ws => {
      socket = ws;
      ws.onMessage(raw => {
        const event = JSON.parse(String(raw));
        if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
        if (event.type === 'response.create') {
          ws.send(JSON.stringify({ type: 'response.created', response: { id: 'voice-reply' } }));
          ws.send(JSON.stringify({ type: 'response.done', response: { output: [] } }));
        }
        if (event.type === 'input_audio_buffer.append') frames.push(event.audio.length);
      });
    });
    await page.goto(origin);
    async function start() {
      if (native) {
        await page.waitForFunction(() => typeof window.swarmStartMainVoice === 'function');
        const id = randomUUID();
        await waitFor(async () => await page.evaluate(id => window.swarmStartMainVoice(id), id) === 'started');
      } else await page.getByRole('button', { name: 'Start voice chat with Main agent', exact: true }).click();
      await page.locator('.vcall.is-live').waitFor();
    }
    await start();
    return {
      page, errors, requests, frames, start,
      popups: () => page.evaluate(() => window.__popups),
      snapshot: value => { snapshot = { ...snapshot, ...value }; },
      connect: (response, status = 200, gate) => { connectResponse = response; connectStatus = status; connectGate = gate; },
      tool: async (result = toolResult) => {
        toolResult = result;
        socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: `provider-${requests.length}`, name: 'SWARM_APPS_CONNECT', arguments: JSON.stringify({ toolkit: 'gmail' }) }));
        socket.send(JSON.stringify({ type: 'response.done', response: { output: [] } }));
      },
    };
  }

  const web = await fixture();
  web.snapshot({ connectionRequests: [connection], approvals: [approval] });
  await web.tool();
  await web.page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
  await web.page.getByRole('button', { name: 'Allow', exact: true }).waitFor();
  assert.deepEqual(await web.popups(), [], 'tool payload URL never opens automatically');
  await waitFor(() => web.frames.length > 0);
  await web.page.screenshot({ path: new URL('desktop.png', shots).pathname });

  web.connect({ error: 'Please try again' }, 503);
  await web.page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await web.page.getByRole('alert').filter({ hasText: 'Please try again' }).waitFor();
  assert.equal((await web.popups())[0].closed, true, 'failed connection closes the reserved popup and allows retry');
  assert.equal((await web.popups())[0].userGesture, true);

  const gate = deferred();
  web.connect({ redirectUrl: 'https://auth.example.test/gmail' }, 200, gate);
  await web.page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  assert.equal((await web.popups()).at(-1).url, 'about:blank', 'popup reserved before async connection resolves');
  gate.resolve();
  await waitFor(async () => (await web.popups()).at(-1).navigated === 'https://auth.example.test/gmail');
  const connectRequest = web.requests.find(r => r.path === '/api/apps/gmail/connect');
  assert.deepEqual(connectRequest.body, { botId: 'research', seq: 21 }, 'OAuth is bound to the requesting agent and card');
  assert.ok((await web.popups()).every(p => p.navigated === null || p.navigated.startsWith('https://auth.example.test/')));
  await web.page.getByText('Waiting for sign-in…', { exact: true }).waitFor();
  await web.page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://untrusted.example', data: { type: 'swarm-connected', toolkit: 'gmail', approvalId: 'approval-send-mail', status: 'allowed' } })));
  assert.equal(await web.page.getByRole('button', { name: 'Connect Gmail', exact: true }).count(), 1, 'postmessage never resolves a connection');
  assert.equal(await web.page.getByRole('button', { name: 'Allow', exact: true }).count(), 1, 'postmessage never resolves an approval');

  await web.page.getByRole('button', { name: 'Allow', exact: true }).click();
  await waitFor(() => web.requests.some(r => r.path === '/api/approvals/approval-send-mail'));
  assert.deepEqual(web.requests.find(r => r.path === '/api/approvals/approval-send-mail').body, { decision: 'allow' });
  assert.equal(await web.page.locator('.vcall .approval-card').count(), 1, 'decision response alone does not resolve server state');
  web.snapshot({ connectionRequests: [], approvals: [] });
  await web.page.locator('.vcall__requests').waitFor({ state: 'detached' });

  // A late successful OAuth response must not open a redirect after hang-up or affect a new call.
  web.snapshot({ connectionRequests: [connection] });
  await web.page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
  const late = deferred();
  web.connect({ redirectUrl: 'https://auth.example.test/late' }, 200, late);
  await web.page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  const popupCount = (await web.popups()).length;
  await web.page.getByRole('button', { name: 'End call', exact: true }).click();
  web.snapshot({ connectionRequests: [], approvals: [] });
  await web.start();
  late.resolve();
  await waitFor(async () => (await web.popups()).at(-1).closed);
  assert.equal((await web.popups()).at(-1).navigated, null);
  assert.equal((await web.popups()).length, popupCount);
  assert.equal(await web.page.locator('.vcall__requests').count(), 0);
  await web.page.getByRole('button', { name: 'End call', exact: true }).click();
  assert.deepEqual(web.errors, []);
  await web.page.close();
  console.log('PASS desktop: user-gesture OAuth, errors/retry, trusted redirect, approvals, authoritative empty lists, spoofed messages and stale responses');

  const native = await fixture(true);
  native.snapshot({ connectionRequests: [connection], approvals: [approval] });
  await native.page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
  await native.page.getByRole('button', { name: 'Allow', exact: true }).waitFor();
  const nativeGate = deferred();
  native.connect({ redirectUrl: 'https://auth.example.test/native' }, 200, nativeGate);
  await native.page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  assert.deepEqual(await native.popups(), [], 'native flow does not create an empty popup');
  nativeGate.resolve();
  await waitFor(async () => (await native.popups()).length > 0);
  assert.equal((await native.popups())[0].url, 'https://auth.example.test/native');
  assert.equal((await native.popups())[0].target, '_blank');
  const bounds = await native.page.locator('.vcall__requests button').evaluateAll(buttons => buttons.map(b => ({ left: b.getBoundingClientRect().left, right: b.getBoundingClientRect().right })));
  assert.ok(bounds.every(b => b.left >= 0 && b.right <= 390), 'connection and all approval actions fit the phone width');
  assert.equal(await native.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await native.page.screenshot({ path: new URL('mobile-native.png', shots).pathname });
  await native.page.getByRole('button', { name: "Don't allow", exact: true }).click();
  await waitFor(() => native.requests.some(r => r.path === '/api/approvals/approval-send-mail'));
  assert.deepEqual(native.requests.find(r => r.path === '/api/approvals/approval-send-mail').body, { decision: 'deny' });
  await native.page.getByRole('button', { name: 'End call', exact: true }).click();
  assert.equal(await native.page.locator('.vcall__requests').count(), 0);
  assert.deepEqual(native.errors, []);
  await native.page.close();
  console.log('PASS native/mobile: final URL hand-off, usable connection/approval controls, denial and teardown');
} finally {
  await browser?.close();
  vite.kill();
}
