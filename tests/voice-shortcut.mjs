// Real browser audio, fake microphone and realtime server; no live calls or account changes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '';
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const origin = `http://127.0.0.1:${port}`;
let browser;
try {
  for (let n = 0; n < 100; n++) {
    if (await fetch(origin).then(r => r.ok, () => false)) break;
    if (vite.exitCode !== null) throw new Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const baseBot = { label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'black', mode: 'personal', pinned: true, effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: '', lastActivityAt: 1, createdAt: 1 };
  const bots = [{ ...baseBot, id: 'other', name: 'Other agent', isPrimary: false }, { ...baseBot, id: 'main', name: 'Main agent', isPrimary: true }];

  async function fixture({ native = true, signedIn = true, main = true, delayBots = false, denyMic = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: native ? 'Mozilla/5.0 SwarmNative/1.0 (iOS)' : undefined });
    const errors = [], sessions = [], ended = [], frames = [];
    let releaseBots;
    let loggedIn = signedIn;
    const rosterReady = delayBots ? new Promise(resolve => { releaseBots = resolve; }) : Promise.resolve();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(denyMic => {
      localStorage.setItem('swarm.selectedBot', 'other');
      if (denyMic) navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
    }, denyMic);
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (path === '/api/auth/me') body = { user: loggedIn ? { id: 'review-user', name: 'Review', email: 'review@example.test' } : null, devLogin: true, googleLogin: false, appleLogin: false };
      else if (path === '/api/auth/dev') { loggedIn = true; body = { ok: true }; }
      else if (path === '/api/bots') { await rosterReady; body = { bots: main ? bots : [bots[0]], live: [] }; }
      else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'cloudvm' } };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' });
      else if (path === '/api/voice/session') {
        sessions.push(route.request().postDataJSON());
        body = { callId: `call-${sessions.length}`, clientSecret: 'test-only', websocketUrl: 'wss://voice.example.test/realtime', sampleRate: 24000, session: {}, tools: [] };
      } else if (path === '/api/voice/end') { ended.push(route.request().postDataJSON()); body = { ok: true }; }
      await route.fulfill({ json: body });
    });
    await page.routeWebSocket('wss://voice.example.test/realtime', ws => {
      ws.onMessage(raw => {
        const event = JSON.parse(String(raw));
        if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
        if (event.type === 'input_audio_buffer.append') frames.push(event.audio.length);
      });
    });
    const request = (id = randomUUID()) => page.evaluate(id => window.swarmStartMainVoice(id), id);
    await page.goto(`${origin}/#settings/account`);
    if (native) await page.waitForFunction(() => typeof window.swarmStartMainVoice === 'function');
    return { page, request, errors, sessions, ended, frames, releaseBots };
  }

  const f = await fixture({ delayBots: true });
  const id = randomUUID();
  assert.equal(await f.request(id), 'loading', 'cold launch waits for the bot roster');
  assert.equal(f.sessions.length, 0);
  f.releaseBots();
  await f.page.getByRole('heading', { name: 'Account', level: 1 }).waitFor();
  await f.page.waitForFunction(() => document.querySelector('.chat__pill-name')?.textContent?.includes('Other agent'));
  assert.equal(await f.request(id), 'started');
  await f.page.locator('.vcall.is-live').waitFor();
  assert.equal(f.sessions[0].botId, 'main', 'always calls the primary agent, not the selected/first bot');
  assert.equal(await f.page.locator('.app-settings').count(), 0, 'voice opens the chat through settings');
  assert.equal(await f.page.locator('.chat__pill-name').textContent(), 'Main agent');
  await f.page.waitForFunction(() => document.querySelector('.vcall.is-live') !== null);
  for (let n = 0; n < 50 && !f.frames.length; n++) await f.page.waitForTimeout(100);
  assert.ok(f.frames.length, 'shortcut captures and sends microphone frames without a web click');
  assert.equal(await f.request(id), 'started');
  await f.page.getByRole('button', { name: 'Mute', exact: true }).click();
  assert.equal(await f.request(), 'started');
  await f.page.getByRole('button', { name: 'Mute', exact: true }).waitFor();
  assert.equal(f.sessions.length, 1, 'repeated presses reuse and unmute the main call');
  await f.page.getByRole('button', { name: 'End call', exact: true }).click();
  assert.equal(await f.request(id), 'started');
  assert.equal(await f.page.locator('.vcall').count(), 0, 'a delivered request never restarts an ended call');
  assert.equal(await f.request(), 'started');
  await f.page.locator('.vcall.is-live').waitFor();
  assert.equal(f.sessions.length, 2, 'a fresh press starts a new voice session');
  await f.page.getByRole('button', { name: 'End call', exact: true }).click();
  assert.deepEqual(f.errors, []);
  await f.page.close();
  console.log('PASS cold/warm launch, main-agent routing, audio capture, settings dismissal, repeated presses');

  const signedOut = await fixture({ signedIn: false });
  await signedOut.page.getByRole('button', { name: 'Continue with phone' }).waitFor();
  const pending = randomUUID();
  assert.equal(await signedOut.request(pending), 'signin');
  assert.equal(signedOut.sessions.length, 0);
  await signedOut.page.getByRole('textbox', { name: 'Email', exact: true }).fill('review@example.test');
  await signedOut.page.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await signedOut.page.waitForFunction(() => document.querySelector('.chat__pill-name')?.textContent?.includes('Other agent'));
  assert.equal(await signedOut.request(pending), 'started', 'pending request continues only after sign-in');
  await signedOut.page.locator('.vcall.is-live').waitFor();
  await signedOut.page.getByRole('button', { name: 'End call', exact: true }).click();
  await signedOut.page.close();
  console.log('PASS signed-out shortcut waits for authentication');

  const missing = await fixture({ main: false });
  await missing.page.waitForFunction(() => document.querySelector('.chat__pill-name')?.textContent?.includes('Other agent'));
  assert.equal(await missing.request(), 'missing-agent');
  assert.equal(missing.sessions.length, 0);
  await missing.page.close();

  const denied = await fixture({ denyMic: true });
  await denied.page.waitForFunction(() => document.querySelector('.chat__pill-name')?.textContent?.includes('Other agent'));
  assert.equal(await denied.request(), 'started');
  await denied.page.locator('.vcall.is-error').waitFor();
  assert.match(await denied.page.locator('.vcall__status').textContent(), /Microphone access was blocked/);
  assert.equal(denied.sessions.length, 0, 'permission denial cannot open a provider session');
  await denied.page.close();

  const web = await fixture({ native: false });
  await web.page.waitForFunction(() => document.querySelector('.chat__pill-name')?.textContent?.includes('Other agent'));
  assert.equal(await web.page.evaluate(() => typeof window.swarmStartMainVoice), 'undefined');
  await web.page.close();
  console.log('PASS missing main agent, microphone denial, and native-only entry point');
} finally { await browser?.close(); vite.kill(); }
