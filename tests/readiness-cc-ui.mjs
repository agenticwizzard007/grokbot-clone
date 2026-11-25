// Real production UI, fixture APIs only. No live account or provider access.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
const evidence = '.context/readiness-cc'; await mkdir(evidence, { recursive: true });
const root = path.resolve('web'), outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true }, plugins: [{ name: 'fixture-model-state', enforce: 'pre', transform(code, id) {
  if (id.endsWith('/lib/models.ts')) return `${code}\nwindow.__models = useModels;`;
} }] });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin, gate } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors } = await fixturePage(browser, { width, height: 900 });
    page.setDefaultTimeout(15000);
    const model = { provider: 'codex-cli', billing: 'plan', plan: 'ChatGPT plan', models: [], favourites: [], usage: { available: false, windows: [] } };
    await page.addInitScript(({ theme, model }) => {
      localStorage.setItem('swarm.theme', theme);
      sessionStorage.setItem('swarm.usage-summary:fixture-owner', JSON.stringify({ account: 'fixture-owner', at: Date.now(), value: model }));
    }, { theme, model });
    let modelsGate = gate(), suggestionsGate = gate(), modelRequests = 0, suggestionRequests = 0, pendingUpdates = 4;
    const suggestion = { slug: 'slack', name: 'Slack', categories: [], noAuth: false, reason: 'Review channel updates.' };
    fixture.respond = async ({ path }) => {
      if (path === '/api/models') { modelRequests++; await modelsGate.wait; return { json: model }; }
      if (path.endsWith('/suggested-apps')) { suggestionRequests++; await suggestionsGate.wait; return { json: { filterVersion: 'purpose-2', hasContext: true, suggestions: [suggestion] } }; }
      if (path === '/api/apps') return { json: { apps: [], categories: [], total: 0 } };
      if (path === '/api/team/state') return { json: { state: { userId: 'fixture-owner', generatedAt: Date.now(), agents: [], jobs: [], workflows: [], goals: [], artifacts: [], deliveries: [], requests: {}, coverage: {}, humanSources: { pending: pendingUpdates }, health: { runtime: 'healthy', lastTickAt: Date.now(), pendingWakes: 0 } } } };
      return null;
    };
    const link = async hash => { await page.evaluate(hash => { location.hash = hash; }, hash); await page.waitForFunction(hash => location.hash === hash, hash); };
    const noBack = async () => { assert.equal(await page.getByRole('button', { name: /^Back(?: to|$)/ }).count(), 0, `${width} ${theme}: top-level screen has no Back control`); };
    await page.goto(`${origin}/#bots`); await page.locator('.sidebar-usage').waitFor();
    const usage = page.locator('.sidebar-usage');
    assert.match(await usage.innerText(), /ChatGPT plan/);
    assert.doesNotMatch(await usage.innerText(), /Previously loaded|Refreshing/);
    await page.locator('.sidebar').waitFor(); await noBack();
    await page.waitForTimeout(2100);
    await usage.getByText(/Previously loaded.*Refreshing/).waitFor();
    modelsGate.release(); await page.waitForFunction(() => !document.querySelector('.sidebar-usage').textContent.includes('Refreshing'));
    // Fast warm refresh stays silent and failure still offers Retry.
    modelsGate = gate();
    await page.evaluate(() => { void window.__models.getState().load(true); });
    await page.waitForTimeout(100); assert.doesNotMatch(await usage.innerText(), /Previously loaded|Refreshing/);
    modelsGate.release(); await page.waitForTimeout(100);
    await page.evaluate(() => window.__models.setState({ status: 'error', error: 'Fixture unavailable', stale: true }));
    await usage.getByText(/Previously loaded.*Retry/).waitFor();
    const before = modelRequests; await usage.click();
    await page.waitForFunction(() => window.__models.getState().status === 'ready'); assert.ok(modelRequests > before);

    // Required walk with browser Back and Forward after each entry is created.
    await link('#settings'); await page.locator('.access-settings__bar').waitFor(); await noBack();
    await link('#bots'); await page.locator('.sidebar').waitFor(); await noBack();
    await page.locator('.pinned__tile').click(); await page.locator('.composer__input').waitFor();
    const chatHash = new URL(page.url()).hash;
    await page.locator('.chat__pill').click(); await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).click();
    const settingsHash = `${chatHash}/settings/general`;
    await page.waitForFunction(hash => location.hash === hash, settingsHash);
    const general = page.getByRole('region', { name: 'Suggested integrations' }); await general.waitFor();
    assert.equal(await general.getByText('Finding relevant apps…').count(), 0, 'cold cache has a 500 ms grace period');
    await general.getByText('Finding relevant apps…').waitFor();
    suggestionsGate.release(); await general.getByText('Slack', { exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Back to Coordinator chat', exact: true }).count());
    await page.screenshot({ path: `${evidence}/${width}-${theme}-bot-settings.png` });
    for (const hash of [chatHash, '#bots', '#settings', '#bots']) {
      await page.goBack(); await page.waitForFunction(hash => location.hash === hash, hash);
      if (hash === '#bots') await page.locator('.sidebar').waitFor();
      if (!hash.startsWith('#bot/')) await noBack();
    }
    for (const hash of ['#settings', '#bots', chatHash, settingsHash]) {
      await page.goForward(); await page.waitForFunction(hash => location.hash === hash, hash);
      if (!hash.startsWith('#bot/')) await noBack();
    }
    // Cache shows immediately while a new network request is held, including reload.
    suggestionsGate = gate();
    const requestsBefore = suggestionRequests;
    await page.reload(); await general.waitFor(); await general.getByText('Slack', { exact: true }).waitFor();
    assert.doesNotMatch(await general.innerText(), /Finding relevant|Updating saved/);
    await page.waitForTimeout(600); assert.ok(suggestionRequests > requestsBefore);
    assert.doesNotMatch(await general.innerText(), /Finding relevant|Updating saved/);
    suggestionsGate.release();
    await link('#tasks'); await page.locator('.tasks-view').waitFor(); await noBack();
    for (const tab of ['Team', 'Goals', 'Reports']) {
      await page.getByRole('navigation', { name: 'Work sections' }).getByRole('button', { name: tab, exact: true }).click();
      await page.waitForFunction(tab => location.hash === `#${tab.toLowerCase()}`, tab); await noBack();
      if (tab === 'Team') await page.getByText('4 user updates waiting for coordinator review.', { exact: true }).waitFor();
    }
    pendingUpdates = 1; await link('#team');
    await page.getByText('1 user update waiting for coordinator review.', { exact: true }).waitFor();
    await page.screenshot({ path: `${evidence}/${width}-${theme}-team.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    assert.deepEqual(errors, []); await page.close();
    console.log(`PASS ${width} ${theme}: top-level navigation and Back/Forward; cold and warm suggestions; delayed usage refresh and Retry; singular and plural Team copy.`);
  }
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
