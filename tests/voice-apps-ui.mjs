// Real local chat persistence, SSE, approvals and voice controller. Fake providers only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-chat-ui-'));
const evidence = path.join(root, '.context/voice-chat-ui'); await fs.mkdir(evidence, { recursive: true });
async function port() { const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'https://model.fixture/v1', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const s of [child.stdout, child.stderr]) s.on('data', b => logs.push(String(b))); return child; }
async function until(fn) { for (let n = 0; n < 250; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/voice-chat-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, permissions: ['microphone'], reducedMotion: 'reduce' });
    const login = await context.request.post(`${origin}/api/auth/dev`, { data: { email: `fixture-${width}@example.test`, name: 'Fixture account' } }); assert.equal(login.status(), 200);
    const roster = await (await context.request.get(`${origin}/api/bots`)).json();
    for (const existing of roster.bots) if (existing.isPrimary) await context.request.patch(`${origin}/api/bots/${existing.id}`, { data: { name: 'Main bot' } });
    const response = await context.request.post(`${origin}/api/bots`, { data: { name: 'Voice fixture' } }); assert.equal(response.status(), 200);
    const { bot } = await response.json();
    assert.equal((await context.request.post(`${origin}/api/bots/${bot.id}/setup/skip`)).status(), 200);
    page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [], notes = []; let socket, session, polls = 0;
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(id => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.detailsOpen', '0'); }, bot.id);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin ? route.continue() : route.abort();
    });
    page.on('response', r => { if (new URL(r.url()).pathname === '/api/voice/updates') polls++; });
    await page.route('**/api/voice/session', async route => {
      const r = await route.fetch(); session = await r.json();
      await route.fulfill({ response: r, json: { ...session, websocketUrl: `ws://127.0.0.1:${uiPort}/fixture-voice` } });
    });
    await page.routeWebSocket('**/fixture-voice', ws => {
      socket = ws;
      ws.onMessage(raw => {
        const event = JSON.parse(String(raw));
        if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
        if (event.type === 'response.create') {
          ws.send(JSON.stringify({ type: 'response.created', response: { id: 'fixture-response' } }));
          ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Review the email in chat.', item_id: 'caption' }));
          ws.send(JSON.stringify({ type: 'response.done', response: { output: [] } }));
        }
        if (event.type === 'conversation.item.create') notes.push(JSON.stringify(event));
      });
    });
    await page.goto(origin);
    if (width === 390) await page.locator('.bot-row').filter({ hasText: bot.name }).click();
    await page.getByRole('button', { name: `Start live voice with ${bot.name}`, exact: true }).click();
    const voice = page.locator('.vcall'); await page.locator('.vcall.is-live').waitFor();
    socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'fixture-email', name: 'send_task', arguments: JSON.stringify({ request: 'Prepare an email draft for review.' }) }));
    socket.send(JSON.stringify({ type: 'response.done', response: { output: [] } }));
    const approval = page.locator('.approval-card'); await approval.waitFor();
    assert.equal(await approval.count(), 1);
    assert.equal(await voice.locator('.card, .vcall__requests, .vcall__connection, .vcall__task').count(), 0);
    assert.deepEqual(await voice.locator('button').allTextContents(), ['Mute', 'End', 'Review the email in chat.Show transcript']);
    assert.equal(await voice.locator('.vcall__caption').count(), 1);
    const preview = approval.getByRole('group', { name: 'Email preview', exact: true });
    await preview.waitFor();
    const text = await preview.innerText();
    for (const value of ['Review team <review@example.test>', 'copy@example.test', 'private@example.test', 'Release review ✓', 'Signature will be added', 'Reply to: Release planning']) assert.ok(text.includes(value), value);
    for (const value of ['recipient_email', 'thread_id', 'Europe/Paris', 'include_signature']) assert.ok(!(await approval.innerText()).includes(value), value);
    assert.equal(await approval.locator('details').getAttribute('open'), null);
    const body = approval.locator('.tool-preview__text');
    assert.ok((await body.textContent()).includes('\n\nPlease review'));
    await approval.getByRole('button', { name: 'Show full', exact: true }).click();
    assert.ok((await body.innerText()).endsWith('Final paragraph.'));
    assert.equal(await body.evaluate(e => e.scrollHeight <= e.clientHeight + 1), true);
    await approval.getByRole('button', { name: 'Show less', exact: true }).click();
    // Reconnect uses normal persisted rows and must not append a second copy.
    await page.evaluate(() => window.dispatchEvent(new Event('swarm:resume')));
    await until(() => polls >= 3);
    assert.equal(await approval.count(), 1);
    assert.equal(await voice.locator('.card').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await approval.evaluate(e => e.scrollWidth <= e.clientWidth), true);
    await approval.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(evidence, `pending-${width}.png`), fullPage: true });
    await approval.screenshot({ path: path.join(evidence, `email-${width}.png`) });
    await approval.getByRole('button', { name: "Don't allow", exact: true }).click();
    await approval.getByText('Not allowed', { exact: true }).waitFor();
    await until(() => notes.some(note => note.includes('declined in chat')));
    assert.equal(await voice.locator('.card').count(), 0);
    await page.reload();
    if (width === 390 && await page.locator('.bot-row').filter({ hasText: bot.name }).isVisible()) await page.locator('.bot-row').filter({ hasText: bot.name }).click();
    await approval.getByText('Not allowed', { exact: true }).waitFor();
    assert.equal(await approval.count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, `resolved-${width}.png`), fullPage: true });
    // Readable previews also cover existing draft proposals and non-email actions.
    await page.evaluate(async botId => {
      const { useStore } = await import('/src/store.ts');
      const base = { type: 'card', card: 'approval', approvalId: 'render-only', title: 'Review action', status: 'denied', detail: '{"legacy":"raw"}' };
      const bodies = [
        { ...base, tool: 'OUTLOOK_CREATE_DRAFT', args: { toRecipients: [{ emailAddress: { name: 'Review team', address: 'review@example.test' } }], subject: 'HTML review', body: { contentType: 'HTML', content: '<p>First &amp; safe</p><p>Second<br>line</p><img src=x onerror="window.__injected=true"><script>window.__injected=true</script>' } } },
        { ...base, tool: 'SLACK_SEND_MESSAGE', args: { channel: '#release', text: '*Ready*\nReview <https://example.test|the notes>' } },
        { ...base, tool: 'GOOGLECALENDAR_CREATE_EVENT', args: { summary: 'Planning', start: { dateTime: '2026-12-01T09:30:00+01:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-12-01T10:30:00+01:00', timeZone: 'Europe/Paris' }, attendees: ['first@example.test', 'second@example.test'], location: 'Room 2', description: 'Full agenda\nSecond line' } },
        { ...base, tool: 'CUSTOM_ACTION', args: { project_title: 'Release', description: 'Full generic description', timezone: 'hidden', nested: { raw: 'value' } } },
        { type: 'card', card: 'draft', channel: 'email', to: 'review@example.test', subject: 'Draft proposal', text: 'First paragraph\n\n' + 'Complete draft text. '.repeat(90) + 'FINAL DRAFT', approvalId: '', status: 'pending' },
      ];
      useStore.getState().upsertRows(botId, 1, bodies.map((body, i) => ({ botId, generation: 1, seq: 500+i, updatedSeq: 500+i, kind: 'card', audience: 'user', createdAt: Date.now(), body })));
    }, bot.id);
    const outlook = page.locator('.approval-card').filter({ hasText: 'HTML review' });
    await outlook.waitFor();
    assert.equal(await outlook.locator('.tool-preview__text').innerText(), 'First & safe\n\nSecond\nline');
    assert.equal(await outlook.locator('img, script, iframe').count(), 0);
    assert.equal(await page.evaluate(() => !!window.__injected), false);
    assert.equal(await page.locator('.tool-preview.is-slack strong').innerText(), 'Ready');
    assert.ok((await page.locator('.tool-preview.is-calendar').innerText()).includes('Europe/Paris'));
    assert.ok((await page.locator('.tool-preview.is-generic').innerText()).includes('Project title'));
    const draft = page.locator('.draft-card');
    await draft.getByRole('button', { name: 'Show full', exact: true }).click();
    assert.ok((await draft.locator('.draft-card__text').innerText()).endsWith('FINAL DRAFT'));
    await draft.getByRole('button', { name: 'Show less', exact: true }).click();
    await outlook.locator('summary').click();
    assert.ok((await outlook.locator('pre').innerText()).includes('contentType'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await outlook.locator('summary').click();
    await outlook.screenshot({ path: path.join(evidence, `outlook-${width}.png`) });
    await draft.screenshot({ path: path.join(evidence, `draft-${width}.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}: Outlook HTML, Slack formatting, Calendar, generic action and draft proposal, safe Details, full bodies, no overflow`);
    console.log(`PASS ${width}: call-only panel, readable exact email, SSE delivery, reconnect dedupe, chat denial, reload persistence, no overflow`);
    await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-6000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-3000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }
