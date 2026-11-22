// Bot settings > Routines (R2F-003, R2F-016, PD-R2-02): Delete and Run now confirm in the shared dialog with no
// timeout, the icons never move, failures show an error, and run history refreshes after Run now.
// All API calls are local fixtures; nothing runs or is deleted on a server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:5198';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const out = new URL('../.context/routines-ui/', import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  const bots = ['Quinn', 'Nia'].map((name, i) => ({ id: name.toLowerCase(), name, label: i ? 'Research' : 'Chief of Staff', kind: 'agent', isPrimary: !i, avatarShape: i ? 'heart' : 'blob', avatarColor: i ? 'orange' : 'blue', description: 'Your teammate', mode: 'personal', instructions: '', model: null, effort: 'medium', generation: 1, unread: 0, lastActivityAt: 0, createdAt: 0, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto' }));
  const routine = (id, name) => ({ id, botId: 'quinn', name, description: '', prompt: `Run ${name.toLowerCase()}`, schedule: 'Every weekday at 9 AM', timezone: 'UTC', enabled: true, nextRunAt: Date.now() + 3_600_000, createdAt: 0 });
  let routines = [routine('daily-hi', 'Daily hi'), routine('weekly-recap', 'Weekly recap')];
  let runs = [];
  const calls = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    localStorage.setItem('swarm.selectedBot', 'quinn');
    window.EventSource = class { static CLOSED = 2; constructor() { setTimeout(() => this.onopen?.(), 0); } close() {} };
  });
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
    if (url.origin !== origin) { errors.push(`external ${url.href}`); return route.abort(); }
    if (!p.startsWith('/api/')) return route.continue();
    if (p.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
    if (method !== 'GET') calls.push(`${method} ${p}`);
    if (method === 'POST' && p === '/api/routines/daily-hi/run') {
      runs = [{ id: 'run-1', botId: 'quinn', routineId: 'daily-hi', routineName: 'Daily hi', jobId: null, kind: 'manual', status: 'queued', error: null, createdAt: Date.now(), startedAt: null, finishedAt: null }];
      return route.fulfill({ json: { ok: true } });
    }
    if (method === 'DELETE' && p === '/api/routines/daily-hi') { routines = routines.filter(r => r.id !== 'daily-hi'); return route.fulfill({ json: { ok: true } }); }
    if (method === 'DELETE' && p === '/api/routines/weekly-recap') return route.fulfill({ status: 500, json: { error: 'Routine store unavailable.' } });
    if (method !== 'GET') { errors.push(`Unexpected mutation ${method} ${p}`); return route.abort(); }
    let body = {};
    if (p === '/api/auth/me') body = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' } };
    else if (p === '/api/bots') body = { bots, live: [] };
    else if (p.endsWith('/rows')) body = { generation: 1, rows: [] };
    else if (p === '/api/bots/quinn/routines') body = { routines };
    else if (p.endsWith('/routines')) body = { routines: [] };
    else if (p === '/api/bots/quinn/settings') body = { memories: [], skills: [], routines, tasks: [], memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 1000, lastCompaction: null } };
    else if (p === '/api/deliverables/bots/quinn/runs') body = { runs };
    else if (p.endsWith('/tasks')) body = { tasks: [] };
    else if (p.endsWith('/coworker-setups')) body = { setups: [] };
    else if (p === '/api/computer') body = { computer: { status: 'running', provider: 'local', screens: [] } };
    else if (p === '/api/models') body = { models: [], favourites: [], provider: 'openrouter', billing: 'api' };
    else if (p === '/api/voice/options') body = { voices: [], speeds: [1], languages: [] };
    return route.fulfill({ json: body });
  });
  // R2F-028: the Bot settings tab is linkable, so the page opens straight on Routines.
  await page.goto(`${origin}/#bot/quinn/settings/routines`);
  const settings = page.getByRole('main', { name: 'Quinn settings' });
  const dailyRun = settings.getByRole('button', { name: 'Run Daily hi now', exact: true });
  await dailyRun.waitFor();
  const history = settings.getByRole('region', { name: 'Routine run history' });
  await history.getByText('No recorded runs yet.', { exact: true }).waitFor();
  const dialog = page.locator('.confirm-dialog');

  // Run now asks first; Cancel runs nothing.
  await dailyRun.click();
  await dialog.getByRole('heading', { name: 'Run Daily hi now?', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(calls, [], 'Cancel never runs the routine');

  // Delete: the question waits as long as needed, the other icons stay put, and Delete works first time.
  const before = await dailyRun.boundingBox();
  await settings.getByRole('button', { name: 'Delete Daily hi', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Delete Daily hi?', exact: true }).waitFor();
  await dialog.getByText('Future runs stop. Past runs and reports stay.', { exact: true }).waitFor();
  assert.deepEqual(await dailyRun.boundingBox(), before, 'Run now does not move when the confirm opens');
  await page.screenshot({ path: new URL('delete-confirm.png', out).pathname });
  await page.waitForTimeout(6000);
  await dialog.getByRole('heading', { name: 'Delete Daily hi?', exact: true }).waitFor({ timeout: 100 });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await settings.getByText('Daily hi', { exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(calls, ['DELETE /api/routines/daily-hi']);
  assert.ok(!calls.some(call => call.endsWith('/run')), 'the run endpoint is never called by a delete');

  // A failed delete shows an error and keeps the routine.
  await settings.getByRole('button', { name: 'Delete Weekly recap', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.toast--error').filter({ hasText: 'Routine store unavailable.' }).waitFor();
  await settings.getByText('Weekly recap', { exact: true }).waitFor();
  assert.ok(!calls.some(call => call.endsWith('/run')), 'still no run');

  // R2F-016: after Run now the history shows the run without pressing Refresh.
  routines = [routine('daily-hi', 'Daily hi'), routine('weekly-recap', 'Weekly recap')];
  await page.reload();
  await dailyRun.waitFor();
  await history.getByText('No recorded runs yet.', { exact: true }).waitFor();
  await dailyRun.click();
  await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
  await history.getByText(/^Queued · .+ · Run now$/).waitFor({ timeout: 2000 });
  assert.equal(calls.filter(call => call === 'POST /api/routines/daily-hi/run').length, 1);

  // PD-R2-02: ask the Bot to add a routine in chat, with a starting prompt to finish.
  await settings.getByRole('button', { name: 'Ask Quinn to add a routine', exact: true }).click();
  const composer = page.locator('.composer__input');
  await composer.waitFor();
  assert.match(await composer.inputValue(), /^Please add a routine: /);
  assert.ok(!calls.some(call => call.startsWith('POST /api/bots/quinn/messages')), 'the prompt is not sent for the user');
  assert.deepEqual(errors, []);
  console.log('PASS routines: no-timeout delete confirm, fixed icons, Run now confirm, error toast, history refresh after Run now, ask in chat');
} finally { await browser.close(); }
