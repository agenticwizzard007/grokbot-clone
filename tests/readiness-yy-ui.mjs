// Production assets, local fixtures, no live account or provider calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';

const evidence = '.context/readiness-yy';
await mkdir(evidence, { recursive: true });
const root = path.resolve('web'), outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true } });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, reads } = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme });
    await page.addInitScript(theme => {
      localStorage.removeItem('swarm.selectedBot');
      localStorage.setItem('swarm.theme', theme);
    }, theme);
    fixture.respond = async ({ path: url }) => {
      if (/^\/api\/deliverables\/bots\/[^/]+$/.test(url)) {
        const botId = url.split('/').at(-1);
        return { json: { artifacts: [{ id: `file-${botId}`, botId, filename: `${botId}-notes.txt`, title: `${botId}-notes.txt`, mime: 'text/plain', size: 20, createdAt: Date.now(), deliveries: [] }] } };
      }
      if (url === '/api/apps') return { json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } };
      if (url === '/api/settings/keys') { const key = { set: false, source: null }; return { json: { canEdit: false, isolated: false, provider: { value: 'direct', chosen: 'direct' }, model: { value: 'fixture' }, openrouterModel: { value: 'fixture' }, openrouter: key, direct: key, composio: key, voice: key } }; }
      if (url === '/api/cli') return { json: { runtime: 'server', selected: null, connected: false, providers: {} } };
      if (url.endsWith('/suggested-apps')) return { json: { filterVersion: 'purpose-2', hasContext: false, suggestions: [] } };
      return null;
    };
    const hash = value => page.evaluate(value => { location.hash = value; }, value);
    const check = async (name, fn) => {
      try { await fn(); results.push({ name: `${name} ${width} ${theme}`, pass: true }); console.log(`PASS ${name} ${width} ${theme}`); }
      catch (error) { results.push({ name: `${name} ${width} ${theme}`, pass: false }); console.error(`FAIL ${name} ${width} ${theme}: ${error}`); await page.screenshot({ path: `${evidence}/failure-${name}-${width}-${theme}.png` }); }
    };
    await page.goto(`${origin}/#reports`);
    await check('files-without-context', async () => {
      await page.locator('.work-reports-owner select').waitFor();
      assert.equal(await page.locator('.work-reports-owner select').inputValue(), '');
      assert.equal(reads.some(url => /^\/api\/deliverables\/bots\//.test(url)), false);
    });
    for (const route of ['#bot/research-bot', '#bot/research-bot/details/activity']) {
      await hash(route); await page.locator('.chat__header').waitFor();
      await check(route.includes('details') ? 'files-from-details' : 'files-from-chat', async () => {
        // On phones, return to the Bot list to reach the work navigation.
        if (width === 390) await hash('#bots');
        await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
        await page.locator('.work-tabs').getByRole('button', { name: 'Files', exact: true }).click();
        assert.equal(await page.locator('.work-reports-owner select').inputValue(), 'research-bot');
        await page.getByText('research-bot-notes.txt', { exact: true }).first().waitFor();
        assert.equal(await page.getByText('coordinator-notes.txt', { exact: true }).count(), 0);
        await hash('#bots'); await page.locator('.sidebar').waitFor(); await hash('#reports');
        await page.getByText('research-bot-notes.txt', { exact: true }).first().waitFor();
        assert.equal(await page.locator('.work-reports-owner select').inputValue(), 'research-bot');
        assert.equal(await page.locator('#tasks-heading').innerText(), 'Files', 'An inferred Bot does not rename the Files title');
        await page.reload();
        await page.getByText('research-bot-notes.txt', { exact: true }).first().waitFor();
        assert.equal(await page.locator('.work-reports-owner select').inputValue(), 'research-bot');
        await page.screenshot({ path: `${evidence}/files-${width}-${theme}.png` });
      });
    }
    await check('files-explicit-choice', async () => {
      await hash('#reports');
      await page.locator('.work-reports-owner select').selectOption('coordinator');
      await page.getByText('coordinator-notes.txt', { exact: true }).first().waitFor();
      await hash('#bots'); await hash('#reports');
      await page.getByText('coordinator-notes.txt', { exact: true }).first().waitFor();
      assert.equal(await page.locator('.work-reports-owner select').inputValue(), 'coordinator');
      // A later Bot visit takes precedence over the older Files choice.
      await hash('#bot/research-bot'); await page.locator('.chat__header').waitFor(); await hash('#reports');
      await page.getByText('research-bot-notes.txt', { exact: true }).first().waitFor();
      assert.equal(await page.locator('.work-reports-owner select').inputValue(), 'research-bot');
    });
    for (const base of ['#reports', '#bot/research-bot']) {
      for (const [route, label] of [['#search', 'Search'], ['#apps/connect', 'Connect Apps']]) {
        await hash(base);
        await check(`${label === 'Search' ? 'search' : 'apps'}-from-${base === '#reports' ? 'files' : 'chat'}`, async () => {
          await hash(route);
          await page.getByRole('dialog', { name: label, exact: true }).waitFor();
          assert.equal(new URL(page.url()).hash, route);
          await page.screenshot({ path: `${evidence}/${label === 'Search' ? 'search' : 'apps'}-${width}-${theme}.png` });
          await page.keyboard.press('Escape');
          await page.getByRole('dialog', { name: label, exact: true }).waitFor({ state: 'detached' });
          assert.notEqual(new URL(page.url()).hash, route);
        });
      }
    }
    for (const route of ['#settings/api-keys', '#settings/keys', '#settings/unknown-section', '#typo-route']) {
      await hash('#reports');
      await check(route.split('/').at(-1).replace('#', ''), async () => {
        await hash(route);
        if (route.includes('keys')) {
          await page.waitForFunction(() => location.hash === '#settings/keys');
          await page.locator('.access-settings__bar-title').filter({ hasText: 'API keys' }).waitFor();
        } else if (route.startsWith('#settings/')) {
          await page.waitForFunction(() => ['#settings', '#settings/general'].includes(location.hash));
          await page.locator('.settings-nav').waitFor();
        } else {
          await page.waitForFunction(() => location.hash !== '#typo-route');
          assert.equal(new URL(page.url()).hash, '#reports');
          await page.locator('.work-reports-owner select').waitFor();
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `${evidence}/${route.split('/').at(-1).replace('#', '')}-${width}-${theme}.png` });
      });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally { await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2)); await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
console.log(`${results.filter(result => result.pass).length} passed, ${results.filter(result => !result.pass).length} failed`);
assert.equal(results.filter(result => !result.pass).length, 0, JSON.stringify(results.filter(result => !result.pass)));
