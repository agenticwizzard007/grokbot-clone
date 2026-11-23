// Built app, real browser microphone, and local HTTP/realtime fixtures. No live accounts.
// Run: npm run build -w web && node tests/voice-entry-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const shots = new URL('../.context/live-voice-evidence/', import.meta.url);
await fs.mkdir(shots, { recursive: true });
const port = await new Promise(resolve => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '', browser, lastPage;
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const origin = `http://127.0.0.1:${port}`;
const waitFor = async predicate => {
  for (let n = 0; n < 100; n++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for voice-entry fixture');
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

try {
  await waitFor(() => {
    if (vite.exitCode !== null) throw new Error(logs);
    return fetch(origin).then(r => r.ok, () => false);
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

  async function fixture({ width = 1280, running = false, plan = false, sessionGate, rows = [], selectedBot = 'main' } = {}) {
    const page = lastPage = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 } });
    page.setDefaultTimeout(10000);
    const errors = [], requests = [], frames = [], sockets = [];
    let sessionCount = 0, sttGate, messageGate;
    const modelId = plan ? 'codex/gpt-6.1-sol' : 'anthropic/claude-opus-5.5';
    const base = { name: 'Quinn', isPrimary: true, label: 'Chief of Staff', description: '', instructions: '',
      avatarShape: 'blob', avatarColor: 'blue', mode: 'personal', pinned: true, effort: plan ? 'xhigh' : 'ultracode',
      model: modelId, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: '', lastActivityAt: 1, createdAt: 1 };
    const bots = [{ ...base, id: 'main' }, { ...base, id: 'research', name: 'Research agent', label: '', isPrimary: false }];
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.stack ?? e.message); });
    await page.addInitScript(selectedBot => {
      localStorage.setItem('swarm.selectedBot', selectedBot);
      localStorage.setItem('swarm.detailsOpen', '0');
      window.__streams = [];
      window.__denyMic = false;
      const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (window.__denyMic) throw new DOMException('Permission denied', 'NotAllowedError');
        const stream = await open(constraints);
        window.__streams.push(stream);
        return stream;
      };
    }, selectedBot);
    await page.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      const bodyIn = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : null;
      requests.push({ path, method: req.method(), body: bodyIn });
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'test-owner', name: 'Alex', email: 'alex@example.test' }, devLogin: true };
      else if (path === '/api/bots') body = { bots, live: running ? [{ botId: 'main', isRunning: true, activity: { kind: 'working' }, startedAt: Date.now() }] : [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path.endsWith('/suggested-apps')) body = { suggestions: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'cloudvm' } };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/voice/options') body = { voices: [{ id: 'ara', name: 'Ara' }], speeds: [1], languages: [{ code: 'auto', name: 'Auto-detect' }] };
      else if (path === '/api/models') body = {
        provider: plan ? 'codex-cli' : 'openrouter', billing: plan ? 'plan' : 'api', defaultModel: modelId, plan: plan ? 'pro' : null, canFast: !plan, favourites: [modelId],
        models: [{ id: modelId, name: plan ? 'GPT-6.1 Sol' : 'Opus 5.5', short: plan ? 'GPT-6.1 Sol' : 'Opus 5.5', billing: plan ? 'plan' : 'api', author: plan ? 'openai' : 'anthropic', efforts: null, defaultEffort: 'medium', reasoning: true, vision: true, context: 200000 }],
      };
      else if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' });
      else if (path === '/api/voice/session') {
        const callId = `call-${++sessionCount}`;
        if (sessionGate) await sessionGate.promise;
        body = { callId, clientSecret: 'test-only', clientSecretProtocol: 'xai-client-secret', websocketUrl: 'wss://voice.example.test/realtime', sampleRate: 24000, session: {}, tools: [] };
      } else if (path === '/api/voice/updates') body = { cursor: 0, updates: [], tasks: [], connectionRequests: [], approvals: [] };
      else if (path === '/api/voice/stt') { if (sttGate) await sttGate.promise; body = { text: 'replaced' }; }
      else if (path.endsWith('/messages')) { if (messageGate) await messageGate.promise; body = { row: {} }; }
      else if (path === '/api/voice/end' || path.endsWith('/interrupt')) body = { ok: true };
      await route.fulfill({ json: body });
    });
    await page.routeWebSocket('wss://voice.example.test/realtime', ws => {
      sockets.push(ws);
      ws.onMessage(raw => {
        const event = JSON.parse(String(raw));
        if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
        if (event.type === 'input_audio_buffer.append') frames.push(event.audio.length);
      });
    });
    await page.goto(origin);
    if (width < 600) await page.getByRole('button', { name: selectedBot === 'main' ? /Quinn · Chief of Staff/ : 'Research agent' }).click();
    await page.getByRole('textbox', { name: selectedBot === 'main' ? 'Message Quinn' : 'Message Research agent', exact: true }).waitFor();
    const count = path => requests.filter(r => r.path === path).length;
    const noChatAction = () => assert.equal(requests.filter(r => /\/(messages|fresh|interrupt)$/.test(r.path)).length, 0, 'voice start/end never submits, clears or interrupts chat');
    const start = () => page.getByRole('button', { name: 'Start live voice with Quinn', exact: true });
    const dictate = async () => {
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: /Dictate a message/ }).click();
      await page.getByRole('button', { name: 'Use transcript · stop dictation', exact: true }).waitFor();
    };
    const close = async () => { assert.deepEqual(errors, []); await page.close(); };
    return { page, start, count, requests, frames, sockets, noChatAction, dictate, close, holdStt: gate => { sttGate = gate; }, holdSend: gate => { messageGate = gate; } };
  }

  for (const width of [1280, 390]) {
    const from = { kind: 'bot', id: 'main', name: 'Quinn · voice task' };
    const rows = [
      { type: 'message', role: 'user', text: 'Research three sources from the voice call.', audience: 'user', from },
      { type: 'message', role: 'assistant', text: 'The three sources are ready.', audience: 'user' },
      { type: 'message', role: 'user', text: 'Hidden internal coordination.', audience: 'internal', from },
      { type: 'message', role: 'user', text: 'Hidden legacy peer message.', from },
    ].map((body, i) => ({ botId: 'research', generation: 1, seq: i + 1, updatedSeq: i + 1, kind: 'message', audience: body.audience, body, createdAt: Date.now() + i }));
    const visible = await fixture({ width, rows, selectedBot: 'research' });
    const transcript = visible.page.locator('.transcript');
    await transcript.getByText('Research three sources from the voice call.', { exact: true }).waitFor();
    await transcript.getByText('From Quinn · voice task', { exact: true }).waitFor();
    await transcript.getByText('The three sources are ready.', { exact: true }).waitFor();
    assert.equal(await transcript.getByText('Hidden internal coordination.', { exact: true }).count(), 0);
    assert.equal(await transcript.getByText('Hidden legacy peer message.', { exact: true }).count(), 0);
    await visible.page.screenshot({ path: new URL(`voice-task-visible-${width}.png`, shots).pathname });
    visible.noChatAction(); await visible.close();
  }
  console.log('PASS desktop/mobile delegated voice request and sender visible; internal and legacy peer messages hidden');

  const draft = await fixture();
  const area = draft.page.getByRole('textbox', { name: 'Message Quinn', exact: true });
  await area.fill('Keep this unfinished draft');
  await area.evaluate(el => el.setSelectionRange(5, 9));
  await draft.page.screenshot({ path: new URL('desktop-entry.png', shots).pathname });
  await draft.page.locator('.composer-area').screenshot({ path: new URL('desktop-entry-controls.png', shots).pathname });
  await draft.start().focus();
  await draft.page.keyboard.press('Enter');
  await draft.page.locator('.vcall.is-live').waitFor();
  await waitFor(() => draft.frames.length > 0);
  assert.equal(await area.inputValue(), 'Keep this unfinished draft');
  assert.deepEqual(await area.evaluate(el => [el.selectionStart, el.selectionEnd]), [5, 9]);
  assert.equal(draft.count('/api/voice/session'), 1);
  assert.equal(draft.requests.find(r => r.path === '/api/voice/session').body.botId, 'main');
  assert.equal(draft.count('/api/voice/stt'), 0, 'main microphone starts realtime, never dictation');
  await draft.page.screenshot({ path: new URL('desktop-live-draft.png', shots).pathname });
  await draft.page.getByRole('button', { name: 'End call with Quinn', exact: true }).click();
  draft.noChatAction();
  // Live voice remains available while Send itself is awaiting its response.
  const sendGate = deferred(); draft.holdSend(sendGate);
  await draft.page.getByRole('button', { name: 'Send', exact: true }).click();
  await waitFor(() => draft.count('/api/bots/main/messages') === 1);
  await draft.start().click();
  await draft.page.locator('.vcall.is-live').waitFor();
  assert.equal(draft.count('/api/bots/main/messages'), 1);
  assert.equal(await area.inputValue(), 'Keep this unfinished draft');
  sendGate.resolve();
  await draft.page.getByRole('button', { name: 'End call', exact: true }).click();
  await draft.close();
  console.log('PASS typed draft/selection retained, keyboard call/audio, no dictation or chat dispatch, voice available during send');

  const busy = await fixture({ running: true });
  await busy.start().click();
  await busy.page.locator('.vcall.is-live').waitFor();
  await busy.page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await busy.page.getByRole('button', { name: 'End call', exact: true }).click();
  busy.noChatAction();
  await busy.page.getByRole('button', { name: 'Stop', exact: true }).click();
  await waitFor(() => busy.count('/api/bots/main/interrupt') === 1);
  await busy.close();
  console.log('PASS call starts/ends while chat works; only explicit Stop interrupts chat');

  const switcher = await fixture();
  await switcher.page.getByRole('textbox', { name: 'Message Quinn', exact: true }).fill('   ');
  await switcher.start().click();
  await switcher.page.locator('.vcall.is-live').waitFor();
  assert.equal(await switcher.page.getByRole('textbox', { name: 'Message Quinn', exact: true }).inputValue(), '   ');
  await switcher.page.locator('.bot-row').filter({ hasText: 'Research agent' }).click();
  assert.equal(switcher.count('/api/voice/session'), 1, 'opening another chat preserves current call');
  await switcher.page.getByRole('button', { name: 'More actions', exact: true }).click();
  assert.equal(await switcher.page.getByRole('menuitem', { name: /Dictate a message/ }).count(), 0, 'dictation never competes with another agent call');
  await switcher.page.keyboard.press('Escape');
  await switcher.page.getByRole('button', { name: 'Switch call to Research agent', exact: true }).click();
  await waitFor(() => switcher.count('/api/voice/session') === 2 && switcher.count('/api/voice/end') === 1);
  await switcher.page.getByRole('region', { name: 'Voice call with Research agent' }).waitFor();
  assert.equal(switcher.requests.filter(r => r.path === '/api/voice/session')[1].body.botId, 'research');
  await switcher.page.getByRole('button', { name: 'End call', exact: true }).click();
  await waitFor(() => switcher.count('/api/voice/end') === 2);
  await switcher.page.waitForFunction(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
  switcher.noChatAction(); await switcher.close();
  console.log('PASS other-agent call preserved until explicit switch, one end per call, all microphone tracks stopped');

  const gate = deferred();
  const connecting = await fixture({ sessionGate: gate });
  await connecting.start().click();
  await waitFor(() => connecting.count('/api/voice/session') === 1);
  await connecting.page.getByRole('button', { name: 'End call with Quinn', exact: true }).click();
  gate.resolve();
  await waitFor(() => connecting.count('/api/voice/end') === 1);
  assert.equal(connecting.sockets.length, 0, 'late session never opens realtime after cancellation');
  assert.equal(connecting.count('/api/voice/session'), 1);
  await connecting.page.waitForFunction(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
  connecting.noChatAction(); await connecting.close();
  const denied = await fixture();
  await denied.page.evaluate(() => { window.__denyMic = true; });
  await denied.start().click();
  await denied.page.locator('.vcall.is-error').waitFor();
  assert.match(await denied.page.locator('.vcall__status').innerText(), /microphone access/i);
  assert.equal(denied.count('/api/voice/session'), 0);
  assert.equal(denied.count('/api/voice/stt'), 0);
  await denied.page.evaluate(() => { window.__denyMic = false; });
  await denied.start().click();
  await denied.page.locator('.vcall.is-live').waitFor();
  await denied.page.getByRole('button', { name: 'End call', exact: true }).click();
  denied.noChatAction(); await denied.close();
  console.log('PASS connecting cancellation releases late sessions; denied microphone keeps text and explicit retry available');

  const textOnly = await fixture();
  const input = textOnly.page.getByRole('textbox', { name: 'Message Quinn', exact: true });
  await input.fill('Before old after');
  await input.evaluate(el => el.setSelectionRange(7, 10));
  const sttGate = deferred(); textOnly.holdStt(sttGate);
  await textOnly.dictate();
  assert.equal(await textOnly.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Cancel dictation');
  await textOnly.page.waitForTimeout(400); // Record beyond the minimum supported utterance duration.
  await textOnly.page.getByRole('button', { name: 'Use transcript · stop dictation', exact: true }).focus();
  await textOnly.page.keyboard.press('Enter');
  await waitFor(() => textOnly.count('/api/voice/stt') === 1);
  assert.equal(await textOnly.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Cancel dictation', 'focus survives removal of Use transcript while STT is pending');
  sttGate.resolve();
  await waitFor(async () => await input.inputValue() === 'Before replaced after');
  assert.equal(textOnly.count('/api/voice/session'), 0);
  assert.equal(await textOnly.page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
  await textOnly.dictate();
  await textOnly.page.keyboard.press('Escape');
  await textOnly.page.locator('.composer__dictation').waitFor({ state: 'detached' });
  assert.equal(await textOnly.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'More actions');
  assert.equal(textOnly.count('/api/voice/stt'), 1, 'cancel never submits recording');
  await textOnly.dictate();
  await textOnly.start().click();
  await textOnly.page.locator('.vcall.is-live').waitFor();
  await textOnly.page.locator('.composer__dictation').waitFor({ state: 'detached' });
  assert.equal(await input.inputValue(), 'Before replaced after');
  assert.equal(textOnly.count('/api/voice/stt'), 1, 'switching to live voice cancels dictation');
  await textOnly.page.getByRole('button', { name: 'End call', exact: true }).click();
  textOnly.noChatAction(); await textOnly.close();
  console.log('PASS explicit dictation only inserts text at saved selection; pending/complete/cancel focus and live-call mode switch');

  for (const width of [1280, 390]) {
    const sidebar = await fixture({ width });
    const draft = sidebar.page.getByRole('textbox', { name: 'Message Quinn', exact: true });
    await draft.fill('Keep my draft while reviewing voice settings');
    await sidebar.dictate();
    await sidebar.page.getByRole('button', { name: 'Show details', exact: true }).click();
    const details = sidebar.page.getByRole('complementary', { name: 'Conversation details' });
    await details.waitFor();
    if (width > 1100) {
      await sidebar.page.getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    } else {
      await waitFor(() => sidebar.page.evaluate(() => window.__streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))));
      assert.equal(sidebar.count('/api/voice/stt'), 0, 'hiding the composer cancels dictation without submitting audio');
    }
    await details.getByRole('button', { name: 'Start voice chat', exact: true }).click();
    await sidebar.page.locator('.vcall.is-live').waitFor();
    assert.equal(await details.isVisible(), width > 1100, 'compact details return to visible live-call controls');
    assert.equal(await draft.inputValue(), 'Keep my draft while reviewing voice settings');
    await sidebar.page.getByRole('button', { name: 'End call', exact: true }).click();
    sidebar.noChatAction(); await sidebar.close();
  }
  console.log('PASS sidebar voice entry exposes call controls and compact details cancel hidden dictation');

  for (const width of [320, 390]) for (const plan of [false, true]) {
    const mobile = await fixture({ width, plan });
    const box = mobile.page.getByRole('textbox', { name: 'Message Quinn', exact: true });
    await box.fill('Keep this mobile draft');
    await mobile.page.screenshot({ path: new URL(`mobile-${width}-${plan ? 'plan' : 'api'}-entry.png`, shots).pathname });
    await mobile.start().focus();
    await mobile.page.keyboard.press('Space');
    await mobile.page.locator('.vcall.is-live').waitFor();
    assert.equal(await box.inputValue(), 'Keep this mobile draft');
    const layout = await mobile.page.locator('.composer__bar').evaluate(el => {
      const bar = el.getBoundingClientRect();
      const controls = [...el.querySelectorAll('button')].map(b => b.getBoundingClientRect());
      return { bar: { left: bar.left, right: bar.right }, fits: controls.every(b => b.left >= bar.left - 1 && b.right <= bar.right + 1), width: innerWidth };
    });
    assert.ok(layout.fits && layout.bar.left >= 0 && layout.bar.right <= layout.width, JSON.stringify(layout));
    await mobile.page.screenshot({ path: new URL(`mobile-${width}-${plan ? 'plan' : 'api'}-live.png`, shots).pathname });
    await mobile.page.getByRole('button', { name: 'End call', exact: true }).click();
    await mobile.dictate();
    assert.equal(await mobile.page.evaluate(() => document.activeElement?.tagName), 'BUTTON', 'dictation does not focus the phone keyboard');
    await mobile.page.getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    mobile.noChatAction(); await mobile.close();
  }
  console.log('PASS 320/390px API/subscription layouts, Space activation, preserved mobile drafts and keyboard-safe dictation focus');
} catch (e) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: new URL('FAIL-entry.png', shots).pathname }).catch(() => {});
  throw e;
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
