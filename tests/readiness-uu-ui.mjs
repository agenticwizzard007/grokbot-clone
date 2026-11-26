// Local UI fixtures only. Every request outside this Vite origin is blocked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import { zeroDayUsage } from './fixtures/usage-zero-days.mjs';
const socket = http.createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
process.env.UI_ORIGIN = `http://127.0.0.1:${port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'ignore' });
const evidence = '.context/readiness-uu'; await fs.mkdir(evidence, { recursive: true });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 300; i++) { if (await fetch(origin).then(r => r.ok, () => false)) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ready, 'local Vite started');
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 1000 }, { colorScheme: theme });
    await page.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); }, theme);
    await page.routeWebSocket('**/api/bots/*/screen?*', () => {});
    let saved = false, unavailableWorkers = false;
    let computer = { provider: 'local', status: 'absent', screens: [], error: null };
    fixture.respond = ({ path, method }) => {
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [], hasContext: false } };
      if (method !== 'GET') return;
      if (path === '/api/team/state' && unavailableWorkers) return { status: 503, json: { error: 'Fixture worker lookup failed' } };
      if (path === '/api/workflows') return { json: { goals: [], workflows: [{ id: 'fixture-workflow', botId: 'unavailable', title: 'Fixture workflow', status: 'draft', tasks: [] }] } };
      if (path === '/api/models' || path === '/api/settings/models') return { json: { models: [], favourites: [], provider: 'direct', billing: 'api' } };
      if (path === '/api/computer') return { json: { computer } };
      if (path === '/api/computer/details') return { json: { computer, screens: [], hibernation: { idleMinutes: 15, viewers: 0, dryRun: false }, pairing: null, thisComputer: null } };
      if (path === '/api/usage') return { json: { ...zeroDayUsage, billing: { sources: [{ source: 'api', provider: 'direct', requests: 1, unpricedRequests: 0, estimatedUsd: 0, costUsd: null }], note: 'Fixture usage.' } } };
      if (path.endsWith('/policies')) return { json: { policies: [] } };
      if (path.endsWith('/files')) return { json: { status: 'ok', path: '', files: [] } };
      if (path.endsWith('/setup')) return { status: 404, json: { error: 'No saved setup' } };
      if (path === '/api/apps') return { json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } };
      if (path === '/api/apps/connections') return { json: { connections: [] } };
      if (path === '/api/deliverables/bots/research-bot') return { json: { artifacts: saved ? [{ id: 'fixture-file', botId: 'research-bot', filename: 'fixture-notes.txt', size: 18, createdAt: Date.now(), deliveries: [], downloadUrl: '/api/fixture-download' }] : [] } };
      if (path === '/api/checkins') return { json: { enabled: false, times: ['09:00'], timezone: 'UTC', timezoneSource: 'explicit', quietHours: [{ start: '22:00', end: '07:00' }] } };
      if (path === '/api/mcp/servers') return { json: { canManage: true, servers: [{ id: 'fixture-mcp', name: 'Fixture server', transport: 'http', url: 'https://example.test/mcp', command: '', args: [], cwd: '', folders: [], botIds: [], tools: [], enabled: false, requireApproval: true, hasBearerToken: true, headerNames: [], envNames: [] }] } };
      if (path === '/api/mcp/servers/folders') return { json: { folders: [], next: null } };
      if (path.endsWith('/analytics')) return { json: { range: '7d', rates: { pageRead: 3, webSearch: 2, command: 1, computerStep: 0.5, wordsPerMinute: 40 }, timezone: 'UTC', days: [{ day: '2026-11-26', messages: 0, minutesSaved: 0 }], totals: { messages: 0, minutesSaved: 0 }, breakdown: [] } };
    };
    const open = async hash => { await page.goto(`${origin}/${hash}`); await page.reload(); };
    const shot = async name => {
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: no horizontal overflow`);
      await page.screenshot({ path: `${evidence}/${width}-${theme}-${name}.png`, fullPage: true });
    };
    await open('#bot/research-bot/reports');
    await page.getByRole('heading', { name: 'No files yet', exact: true }).waitFor();
    assert.match(await page.locator('#tasks-heading').innerText(), /Files$/);
    assert.match(await page.title(), /Files · Swarm$/);
    assert.doesNotMatch(await page.locator('.tasks-view').innerText(), /Library|Saved reports|\bagent\b|[—–]/i);
    await shot('files-empty');
    saved = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'fixture-notes.txt' }).waitFor();
    await page.getByRole('link', { name: 'Download file', exact: true }).waitFor();
    await shot('files');
    await open('#bot/research-bot/details/files');
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    await details.getByText('Files saved by this Bot are ready to view.', { exact: true }).waitFor();
    const nav = details.getByRole('navigation', { name: 'Conversation details sections' });
    assert.equal(await nav.getByRole('button', { name: 'Files', exact: true }).getAttribute('aria-current'), 'true');
    await details.getByRole('button', { name: 'View Files', exact: true }).click();
    await details.getByRole('region', { name: 'Files', exact: true }).getByRole('heading', { name: 'fixture-notes.txt' }).waitFor();
    await shot('details-files');
    saved = false; await page.reload();
    await details.getByRole('heading', { name: 'No files yet', exact: true }).waitFor(); await shot('details-empty');
    await details.getByRole('button', { name: 'Back to files', exact: true }).click();
    await details.getByText('No files yet. Ask the Bot to save a file and it will appear here.', { exact: true }).waitFor();
    await shot('details-summary-empty');
    await open('#settings/permissions');
    await page.getByText('These are individual tool approvals. Remove a choice to have your Bots ask again.', { exact: true }).waitFor();
    await shot('permissions');
    computer = { ...computer, provider: 'cloudvm', status: 'starting' };
    await open('#settings/computer');
    await page.getByText("Bots' computer · Starting the computer", { exact: true }).waitFor(); await shot('computer-starting');
    // Hold the local screen handshake so both viewer connection labels remain observable.
    for (const provider of ['local', 'cloudvm']) {
      computer = { ...computer, provider, status: 'running' };
      await open('#bot/research-bot/details/activity');
      await details.getByRole('button', { name: 'Open computer', exact: true }).click();
      const viewer = page.getByRole('dialog', { name: "Research Bot's computer", exact: true });
      await viewer.getByRole('status').getByText(provider === 'local' ? 'Connecting to your computer' : 'Starting the computer', { exact: true }).waitFor();
      assert.doesNotMatch(await viewer.innerText(), /\bagent\b/i);
      await shot(`computer-${provider}`);
      await viewer.getByRole('button', { name: 'Close computer', exact: true }).click();
    }
    await open('#reports');
    await page.getByRole('button', { name: 'Daily synopses', exact: true }).click();
    await page.getByText(/quiet hours 22:00 to 07:00/).waitFor();
    assert.doesNotMatch(await page.locator('.synopsis-panel').innerText(), /Library|Saved reports|[—–]/);
    await shot('synopses');
    await open('#settings/mcp');
    await page.getByRole('region', { name: 'Fixture server', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByText('Authentication & headers', { exact: true }).click();
    await page.getByPlaceholder('Saved - leave blank to keep', { exact: true }).waitFor(); await shot('mcp');
    await open('#bot/research-bot/settings/analytics');
    await page.getByText('Show as a table', { exact: true }).click();
    assert.equal(await page.locator('.an-table tbody td').last().innerText(), '-'); await shot('analytics');
    await open('#settings/usage');
    await page.locator('.usage-billing__value').getByText('-', { exact: true }).waitFor(); await shot('usage');
    unavailableWorkers = true; await open('#goals');
    await page.getByText(/Unavailable Bot/).waitFor();
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Activated Bots could not be loaded. Refresh to try again.' }).waitFor();
    const owner = page.getByRole('combobox', { name: /^Bot/ });
    assert.equal(await owner.locator('option').first().innerText(), 'Choose a Bot');
    await page.getByRole('textbox', { name: 'Workflow name', exact: true }).fill('   ');
    await page.getByRole('textbox', { name: 'Task 1 title', exact: true }).fill('Fixture task');
    await page.getByRole('textbox', { name: 'Task 1 instructions', exact: true }).fill('Summarize supplied notes.');
    await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
    await page.getByText('Choose an available Bot and enter a name.', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.workflows-panel').innerText(), /\bagents?\b/i); await shot('workflow-copy');
    fixture.bots = [];
    await open('#reports');
    await page.getByText('Choose an available Bot to see its saved work.', { exact: true }).waitFor(); await shot('files-no-bots');
    assert.deepEqual(errors, []);
    assert.deepEqual(writes.filter(write => !write.path.endsWith('/suggested-apps')), []);
    console.log(`PASS R16 UU ${width} ${theme}: Files, details, empty states, Permissions, computer connection, quiet hours, token placeholder, analytics, usage, workflow errors`);
    await page.close();
  }
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) { console.error((await page.locator('body').innerText()).slice(-5000)); await page.screenshot({ path: `${evidence}/failure.png` }); }
  throw error;
} finally {
  await browser?.close();
  if (vite.exitCode === null && vite.signalCode === null) { const exited = once(vite, 'exit'); vite.kill(); await exited; }
}
