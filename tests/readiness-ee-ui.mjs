// Production UI with local API fixtures only. No live sign-in or user data.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { smallComputerUsage } from './fixtures/usage-small-computer.mjs';

const evidence = '.context/readiness-ee'; await mkdir(evidence, { recursive: true });
const root = path.resolve('web'), outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true }, plugins: [{ name: 'fixture-account', enforce: 'pre', transform(code, id) {
  if (id.endsWith('/store.ts')) return `${code}\nwindow.__store = useStore;`;
} }] });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin, gate } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const suggestion = { slug: 'slack', name: 'Slack', managedAuth: true, noAuth: false, categories: [], reason: 'Review channel updates.' };
const snapshotKey = 'swarm.suggestions';
let activePage, activeErrors;
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors } = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme });
    activePage = page; activeErrors = errors; page.setDefaultTimeout(12000);
    await page.addInitScript(theme => {
      localStorage.setItem('swarm.theme', theme);
      window.suggestionFrames = [];
      const observe = () => {
        const region = document.querySelector('.suggested-integrations');
        if (region) window.suggestionFrames.push({ at: performance.now(), text: region.textContent });
      };
      new MutationObserver(observe).observe(document, { childList: true, subtree: true });
    }, theme);
    let suggestionsGate = gate(), suggestionRequests = 0;
    fixture.respond = async ({ path }) => {
      if (path.endsWith('/suggested-apps')) { suggestionRequests++; await suggestionsGate.wait; return { json: { filterVersion: 'purpose-2', hasContext: true, suggestions: [suggestion] } }; }
      if (path === '/api/apps') return { json: { apps: [], categories: [], total: 0 } };
      if (path === '/api/usage') return { json: smallComputerUsage };
      if (path === '/api/computer/details') return { json: { computer: { status: 'absent', screens: [] }, screens: [], hibernation: { idleMinutes: 15 } } };
      return null;
    };
    const hash = async value => page.waitForFunction(value => location.hash === value, value);
    const link = async value => { await page.evaluate(value => { location.hash = value; }, value); await hash(value); };
    let visit = 0;
    const fresh = async value => { await page.goto(`${origin}/?visit=${++visit}${value}`); await page.locator('.app').waitFor(); };
    const headerBack = label => page.locator('.access-settings__bar, .bot-settings-page > .setup-paper__bar').getByRole('button', { name: label, exact: true });
    const noBack = async () => assert.equal(await page.getByRole('button', { name: /^Back(?: to|$)/ }).count(), 0);

    for (const section of ['usage', 'computer']) {
      await fresh(`#settings/${section}`);
      await headerBack('Back to Settings').waitFor();
      if (width === 1280) {
        await page.locator('.settings-nav__back').getByText('Back to Settings', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        const railBack = page.locator('#sidebar-back-slot').getByRole('button', { name: 'Back to Settings', exact: true });
        await railBack.waitFor(); assert.equal(await railBack.getAttribute('title'), 'Back to Settings');
        await page.screenshot({ path: `${evidence}/${width}-${theme}-${section}-rail.png` });
        await page.getByRole('button', { name: 'Expand sidebar to browse settings', exact: true }).click();
      }
      await page.screenshot({ path: `${evidence}/${width}-${theme}-${section}.png` });
      await headerBack('Back to Settings').click(); await hash('#settings'); await noBack();
      await page.goBack(); await hash(`#settings/${section}`);
      await page.goForward(); await hash('#settings');
    }
    await fresh('#bot/research-bot/settings/memories');
    await headerBack('Back to Research Bot chat').waitFor();
    const memories = new URL(page.url()).hash, chat = memories.replace('/settings/memories', '');
    await page.screenshot({ path: `${evidence}/${width}-${theme}-memories.png` });
    await headerBack('Back to Research Bot chat').click(); await hash(chat);
    await page.goBack(); await hash(memories); await headerBack('Back to Research Bot chat').waitFor();
    await page.goForward(); await hash(chat);
    // Unrelated Team entry must not become a Bot settings parent.
    await link('#team'); await page.locator('.tasks-view').waitFor(); await noBack();
    await link(memories); await headerBack('Back to Research Bot chat').click(); await hash(chat);
    for (const expected of [memories, '#team', chat]) { await page.goBack(); await hash(expected); }
    for (const expected of ['#team', memories, chat]) { await page.goForward(); await hash(expected); }
    // Immediate parent is popped, keeping the child available through Forward.
    await link(memories); await headerBack('Back to Research Bot chat').click(); await hash(chat);
    await page.goForward(); await hash(memories);
    // Routine history is an in-page child with an existing structural return.
    await link('#reports'); await page.getByRole('button', { name: 'Routines', exact: true }).click();
    await page.getByRole('button', { name: 'Run history', exact: true }).click();
    await page.getByRole('button', { name: 'Back to routines', exact: true }).click();
    await page.getByRole('button', { name: 'Run history', exact: true }).waitFor();
    // Settings immediate parent also keeps Forward, regardless of viewport.
    await link('#settings'); await noBack(); await link('#settings/usage');
    await headerBack('Back to Settings').click(); await hash('#settings');
    await page.goForward(); await hash('#settings/usage');
    console.log(`PASS ${width} ${theme}: structural deep links, Team to Memories, collapsed rail, routine history, Back/Forward.`);

    // A never-cached Bot has no loading note until 500 ms after mounting.
    await fresh(`${chat}/settings/general`);
    const general = page.getByRole('region', { name: 'Suggested integrations' });
    await general.waitFor();
    assert.equal(await general.getByText('Finding relevant apps…').count(), 0);
    await general.getByText('Finding relevant apps…').waitFor();
    const frames = await page.evaluate(() => window.suggestionFrames);
    assert.ok(frames.find(frame => frame.text.includes('Finding relevant apps')).at - frames[0].at >= 490);
    suggestionsGate.release(); await general.getByText('Slack', { exact: true }).waitFor();
    await page.waitForFunction(key => !!localStorage.getItem(key), snapshotKey);
    const saved = await page.evaluate(key => localStorage.getItem(key), snapshotKey);
    assert.doesNotMatch(saved, /Review channel updates|instructions|description/);
    // Reload without any session storage or in-memory result; refresh is held.
    suggestionsGate = gate(); const requestsBefore = suggestionRequests;
    await page.evaluate(() => sessionStorage.clear());
    await page.reload(); await general.getByText('Slack', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => window.suggestionFrames[0].text.includes('Slack')), 'cached card is present on the first render');
    await page.waitForTimeout(650);
    assert.ok(suggestionRequests > requestsBefore);
    assert.doesNotMatch(await general.innerText(), /Finding relevant/);
    await page.screenshot({ path: `${evidence}/${width}-${theme}-cold-suggestions.png` });
    suggestionsGate.release(); await page.waitForTimeout(50);
    // A new tab shares local storage, with no session storage snapshot.
    const storageState = await page.context().storageState();
    const cold = await fixturePage(browser, { width, height: 900 }, { storageState, colorScheme: theme });
    let coldGate = gate();
    cold.fixture.respond = async ({ path }) => path.endsWith('/suggested-apps') ? (await coldGate.wait, { json: { filterVersion: 'purpose-2', suggestions: [suggestion] } }) : null;
    await cold.page.goto(`${origin}/${chat}/settings/general`);
    const coldGeneral = cold.page.getByRole('region', { name: 'Suggested integrations' });
    await coldGeneral.getByText('Slack', { exact: true }).waitFor();
    await cold.page.waitForTimeout(650); assert.doesNotMatch(await coldGeneral.innerText(), /Finding relevant/);
    coldGate.release(); assert.deepEqual(cold.errors, []); await cold.page.close();
    // Stored version/account mismatches are discarded before first render.
    for (const patch of [{ version: 0 }, { filterVersion: 'old' }, { account: 'another-account' }]) {
      suggestionsGate = gate();
      await page.evaluate(({ key, saved, patch }) => localStorage.setItem(key, JSON.stringify({ ...JSON.parse(saved), ...patch })), { key: snapshotKey, saved, patch });
      await page.reload(); await general.waitFor();
      assert.equal(await general.getByText('Slack', { exact: true }).count(), 0);
      await general.getByText('Finding relevant apps…').waitFor();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), snapshotKey), null);
      suggestionsGate.release(); await general.getByText('Slack', { exact: true }).waitFor();
    }
    // The account lifecycle erases persisted suggestions before any Settings panel loads.
    await fresh('#bots');
    assert.ok(await page.evaluate(key => !!localStorage.getItem(key), snapshotKey));
    await page.evaluate(() => window.__store.setState({ user: { id: 'another-account', name: 'Another account', email: 'another@example.test' } }));
    assert.equal(await page.evaluate(key => localStorage.getItem(key), snapshotKey), null);
    await page.evaluate(() => window.__store.setState({ user: { id: 'fixture-owner', name: 'Account', email: 'account@example.test' } }));
    await page.evaluate(({ key, saved }) => localStorage.setItem(key, saved), { key: snapshotKey, saved });
    await page.evaluate(() => window.__store.setState({ user: null }));
    assert.equal(await page.evaluate(key => localStorage.getItem(key), snapshotKey), null);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []); await page.close();
    console.log(`PASS ${width} ${theme}: cold first frame, new tab, quiet refresh, version/account rejection, sign-out, delayed empty-cache note.`);
  }
} catch (error) { if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: `${evidence}/failure.png` }); console.log(await activePage.locator('body').innerText(), activeErrors); } throw error; } finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
