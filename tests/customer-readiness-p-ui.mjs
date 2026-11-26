// Local full-app fixtures plus the production relevance filter. No live auth or data.
// Run: node --import tsx tests/customer-readiness-p-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import { availableSuggestions } from '../server/src/app-suggestions.ts';
import { SUGGESTION_FILTER_VERSION } from '../server/src/suggestion-policy.ts';
import { slackSummary, relevanceCatalog, noisyChoices } from './fixtures/slack-summary.mjs';

const port = await new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'ignore' });
const now = Date.now();
const bot = { id: 'summary-bot', name: 'Summary Bot', description: slackSummary.description, instructions: slackSummary.instructions + '\nGmail account is ACTIVE. Slack account was EXPIRED.', label: '', mode: 'personal', pinned: true, isPrimary: true, effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: '', lastActivityAt: now, createdAt: now, voice: '', voiceSpeed: 1, voiceLanguage: 'auto', kind: 'agent', onboarding: { status: 'active', revision: 1 }, avatarColor: 'blue', avatarShape: 'blob' };
// Keep suggestion context exact. Raw generated connection text belongs in Harness/Setup.
const setupBot = { ...bot };
bot.instructions = slackSummary.instructions;
const resources = ['toolkit slack, revision 1, was EXPIRED', 'Gmail account is ACTIVE'];
const setup = { botId: bot.id, manifest: { format: 'swarm-bot-setup', version: 1, bot: setupBot, brief: { purpose: 'Slack account is ACTIVE. Summarize messages.', responsibilities: ['Gmail account is INITIATED.'], success_criteria: ['Calendar account is FAILED.'], action_boundaries: 'Slack account was EXPIRED.', out_of_scope: ['Email account is REVOKED.'], context_summary: 'Gmail account is ACTIVE.', shared_resources: resources, handoff_notes: ['Email account is PENDING.'], communication_style: 'Gmail account is ACTIVE.', working_principles: ['Slack account is EXPIRED.'], workflows: [{ name: 'Slack ACTIVE', trigger: 'Gmail account is INITIATED.', steps: ['Calendar account is FAILED.'], output: 'Email account is DISCONNECTED.' }], open_questions: [] } }, computer: { status: 'ready', error: null }, onboarding: { ...bot.onboarding, confirmedAt: now, missing: [] }, files: { 'AGENTS.md': '# Setup\n\nGmail account is ACTIVE.\nSlack account is EXPIRED.', 'RESOURCES.md': '# Resources\n\n' + resources.join('\n\n'), 'bot-setup.json': JSON.stringify({ revision: 1, resources }) } };
const rawEnums = /\b(ACTIVE|EXPIRED|INITIATED|INITIALIZING|FAILED|REVOKED|PENDING|DISCONNECTED|INACTIVE|ERROR)\b/;
let browser;
try {
  await mkdir('.context/readiness-p', { recursive: true });
  let ready = false;
  for (let i = 0; i < 200; i++) { if (await fetch(origin).then(r => r.ok, () => false)) { ready = true; break; } await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready, 'local Vite started');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, isMobile: width === 390, hasTouch: width === 390, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [], writes = [], suggestions = [];
    let connected = false, savedSetup = false, savedReport = false, oldResponse = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ id, theme }) => {
      localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.theme', theme);
      window.EventSource = class { static CLOSED = 2; constructor() { window.fixtureEvent = event => this.onmessage?.({ data: JSON.stringify(event) }); setTimeout(() => this.onopen?.(), 0); } close() {} };
    }, { id: bot.id, theme });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      const send = (json, status = 200) => route.fulfill({ status, json });
      if (path.endsWith('/suggested-apps')) {
        const draft = request.postDataJSON(); suggestions.push(draft);
        assert.deepEqual(draft, { description: slackSummary.description, instructions: slackSummary.instructions });
        if (oldResponse) return send({ ...noisyChoices, filterVersion: 'purpose-1' });
        return send({ filterVersion: SUGGESTION_FILTER_VERSION, hasContext: true, suggestions: availableSuggestions(noisyChoices, relevanceCatalog, new Set(connected ? ['slack'] : []), { ...slackSummary, ...draft }) });
      }
      if (request.method() !== 'GET') { writes.push(path); return send({ error: 'Unexpected write' }, 400); }
      if (path === '/api/auth/me') return send({ user: { id: 'fixture-account', name: 'Test account', email: 'fixture@example.test', timezone: 'UTC' } });
      if (path === '/api/bots') return send({ bots: [bot], live: [] });
      if (path.endsWith('/rows')) return send({ generation: 1, rows: [] });
      if (path.endsWith('/routines')) return send({ routines: [] });
      if (path.endsWith('/tasks')) return send({ tasks: [] });
      if (path.endsWith('/coworker-setups')) return send({ setups: [] });
      if (path === '/api/team/exchanges') return send({ exchanges: [], nextBefore: null });
      if (path === '/api/needs-you') return send({ items: [] });
      if (path === '/api/computer') return send({ computer: { provider: 'local', status: 'absent', screens: [], error: null } });
      if (path === '/api/models' || path === '/api/settings/models') return send({ provider: 'direct', billing: 'api', models: [], favourites: [] });
      if (path === '/api/settings') return send({ settings: {}, computer: { provider: 'local' } });
      if (path === '/api/voice/options') return send({ voices: [], languages: [], speeds: [], configured: false });
      if (path === '/api/apps') return send({ apps: [], connected: [], connectedApps: [], categories: [], total: 0 });
      if (path === '/api/apps/connections') return send({ connections: [] });
      if (path === '/api/cli') return send({ connected: false, providers: {} });
      if (path === `/api/deliverables/bots/${bot.id}`) return send({ artifacts: savedReport ? [{ id: 'local-report', botId: bot.id }] : [] });
      if (path.endsWith('/files')) return send({ status: 'ok', path: '', files: savedSetup ? [{ name: 'Setup', isDir: true, size: 0, modifiedAt: now }] : [] });
      if (path.endsWith('/setup')) return savedSetup ? send(setup) : send({ error: 'No saved setup' }, 404);
      if (path.endsWith('/instructions')) return send({ revision: 1, stage: 'active', capturedAt: now, instructions: 'Gmail account is ACTIVE.\nSlack account was EXPIRED.\nEmail account is INITIATED.\nCalendar account is FAILED.' });
      if (path.endsWith('/settings')) return send({ skills: [], memories: [], routines: [], tasks: [], memory: {} });
      return send({});
    });
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    const detailTab = name => details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name, exact: true });
    const openDetails = async () => { await page.goto(`${origin}/#bot/${bot.id}`); await page.locator('.chat__bot-details').click(); await detailTab('Activity').click(); };
    const fits = async label => {
      assert.deepEqual(await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.setup-paper, .agent-config__content:not([hidden]), .bot-settings-page')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.className)), [], `${label}: no horizontal overflow`);
    };
    const shot = label => page.screenshot({ path: `.context/readiness-p/${width}-${theme}-${label}.png`, fullPage: true });
    const expectSlack = async region => {
      await region.getByText('Slack', { exact: true }).waitFor();
      assert.deepEqual(await region.locator('.suggested-integration strong').allTextContents(), ['Slack']);
      assert.doesNotMatch(await region.innerText(), /BlueFox|Google Chat|Benchmark/);
      await fits('suggestions');
    };
    await openDetails();
    await expectSlack(details.getByRole('region', { name: 'Suggested integrations' })); await shot('activity');
    await details.getByRole('button', { name: 'Bot settings', exact: true }).click();
    const settingsSuggestions = page.locator('.bot-settings-page').getByRole('region', { name: 'Suggested integrations' });
    await expectSlack(settingsSuggestions); await shot('general');
    connected = true; await page.evaluate(() => window.fixtureEvent({ type: 'connections' }));
    await settingsSuggestions.getByText('No matching additional apps for this Bot right now.', { exact: true }).waitFor();
    await openDetails();
    const activitySuggestions = details.getByRole('region', { name: 'Suggested integrations' });
    await activitySuggestions.getByText('No matching additional apps for this Bot right now.', { exact: true }).waitFor();
    // An old server response cannot reintroduce the previously saved irrelevant list.
    oldResponse = true; await page.evaluate(() => window.fixtureEvent({ type: 'connections' }));
    await activitySuggestions.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal(await activitySuggestions.locator('.suggested-integration').count(), 0);
    oldResponse = false; connected = false; await activitySuggestions.getByRole('button', { name: 'Retry', exact: true }).click();
    await expectSlack(activitySuggestions);

    const files = async () => { await detailTab('Activity').click(); await detailTab('Files').click(); };
    const reportEmpty = 'No files yet. Ask the Bot to save a file and it will appear here.';
    const setupEmpty = 'No saved setup yet. Open Setup to describe what this Bot should do.';
    await files();
    await details.getByText(reportEmpty, { exact: true }).waitFor(); await details.getByText(setupEmpty, { exact: true }).waitFor();
    await fits('empty Files'); await shot('files-empty');
    savedReport = true; await files();
    await details.getByText('Files saved by this Bot are ready to view.', { exact: true }).waitFor();
    await details.getByText(setupEmpty, { exact: true }).waitFor(); assert.equal(await details.getByText(reportEmpty, { exact: true }).count(), 0);
    savedReport = false; savedSetup = true; await files();
    await details.getByText(reportEmpty, { exact: true }).waitFor();
    await details.getByText('Slack needs to be reconnected', { exact: true }).waitFor();
    assert.equal(await details.getByText(setupEmpty, { exact: true }).count(), 0);
    assert.doesNotMatch(await details.innerText(), rawEnums); await fits('Files reconnect'); await shot('files-reconnect');
    await details.getByRole('button', { name: 'Connected apps', exact: true }).click();
    assert.equal(new URL(page.url()).hash, '#settings/apps');
    assert.deepEqual(writes, [], 'opening Connected apps never starts authorization');
    await openDetails(); await detailTab('Setup').click();
    await details.getByRole('tab', { name: 'Harness', exact: true }).waitFor();
    assert.doesNotMatch(await details.innerText(), rawEnums);
    await details.locator('.agent-config__workflow summary').click();
    assert.doesNotMatch(await details.innerText(), rawEnums); await fits('Setup'); await shot('setup');
    await details.getByRole('tab', { name: 'Harness', exact: true }).click();
    await details.getByText('Preview assembled instructions', { exact: true }).click();
    await details.getByLabel('Assembled system instructions').waitFor();
    assert.doesNotMatch(await details.innerText(), rawEnums);
    assert.match(await details.getByLabel('Assembled system instructions').innerText(), /Gmail connected/);
    await fits('Harness'); await shot('harness');
    await details.getByRole('tab', { name: 'Files', exact: true }).click();
    await details.getByRole('button', { name: /RESOURCES.md/ }).click();
    await details.getByRole('tabpanel', { name: 'Files', exact: true }).getByText('Slack needs to be reconnected', { exact: true }).waitFor();
    assert.doesNotMatch(await details.innerText(), rawEnums);
    await details.locator('.agent-config__file > details > summary').click();
    assert.doesNotMatch(await details.innerText(), rawEnums); await fits('Setup files'); await shot('setup-files');
    assert.match(setup.files['RESOURCES.md'], /EXPIRED/, 'rendering leaves the saved source unchanged');
    assert.ok(suggestions.length >= 2, 'both mounts request suggestions'); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS readiness P ${width} ${theme}: both suggestion mounts, connected exclusion, old response invalidation, Harness/Setup copy, Files reconnect, independent empty states, no overflow`);
  }
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) { await page.screenshot({ path: '.context/readiness-p/failure.png', fullPage: true }); console.log((await page.locator('body').innerText()).slice(-5000)); }
  throw error;
} finally { await browser?.close(); vite.kill(); }
