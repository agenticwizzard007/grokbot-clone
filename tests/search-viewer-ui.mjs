// I03: local fake data only, with no connected computer or provider traffic.
// Standalone runs use Vite dev; the integrated runner supplies its built preview.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

let server, browser;
let serverLog = '';
if (!process.env.UI_ORIGIN) {
  const port = await new Promise(resolve => {
    const socket = http.createServer().listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
  process.env.UI_ORIGIN = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
}
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const evidence = new URL('../.context/i03-search-viewer/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });

async function frontmost(locator) {
  await locator.waitFor({ state: 'visible' });
  assert.ok(await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return !element.closest('[inert]')
      && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }), 'control must receive pointer hits and have no inert ancestor');
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server && server.exitCode !== null) throw new Error(serverLog);
    if (await fetch(origin).then(response => response.ok, () => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Local UI did not start: ${serverLog}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    fixture.respond = ({ path }) => {
      if (path === '/api/auth/me') return { json: { user: { id: 'fixture-owner', name: 'Account', email: 'account@example.test', timezone: 'UTC' } } };
      if (path === '/api/computer') return { json: { computer: { provider: 'local', status: 'absent', screens: [], error: null } } };
      if (path === '/api/conversation-search') return { json: { results: [] } };
      if (path === '/api/apps') return { json: { apps: [], connected: [], categories: [], total: 0 } };
      return null;
    };
    // Fail closed if a regression attempts to connect a computer or any other socket.
    await page.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (server && url.host === new URL(origin).host && url.pathname === '/') {
        socket.connectToServer(); // Local Vite development reloads only.
        return;
      }
      errors.push(`Unexpected WebSocket: ${socket.url()}`);
      socket.close();
    });
    const search = page.getByRole('dialog', { name: 'Search', exact: true });
    const input = search.getByRole('textbox', { name: 'Search', exact: true });
    const viewer = page.locator('.viewer');
    const openViewer = async () => {
      await page.locator('.chat__pill').click();
      await page.getByRole('menuitem', { name: 'Open computer', exact: true }).click();
      await viewer.getByText('Your computer isn’t connected.', { exact: true }).waitFor();
      await frontmost(viewer.getByRole('button', { name: 'Close computer', exact: true }));
    };
    const searchReady = async () => {
      await search.waitFor();
      assert.equal(await viewer.count(), 0, 'opening Search must remove the opaque viewer');
      await frontmost(input);
      await page.waitForFunction(() => document.activeElement === document.querySelector('.search-modal input'));
    };
    const closed = async () => {
      await search.waitFor({ state: 'detached' });
      assert.equal(await viewer.count(), 0, 'dismissing Search must not resurrect the viewer');
      assert.equal(await page.locator('#root').evaluate(element => element.inert), false, 'closing Search restores the app');
      await frontmost(page.locator('.chat__pill'));
    };
    try {
      await page.goto(origin);
      await page.locator('.sidebar').getByRole('button', { name: 'Coordinator', exact: true }).click();
      for (const shortcut of ['Control+k', 'Meta+k']) {
        await openViewer();
        // Leave focus on a viewer control to exercise removal of the previous focus target.
        await viewer.getByRole('button', { name: 'Close computer', exact: true }).focus();
        await page.keyboard.press(shortcut);
        await searchReady();
        await page.keyboard.type('Research');
        assert.equal(await input.inputValue(), 'Research');
        const result = search.getByRole('option', { name: /Research Bot/ });
        await frontmost(result);
        if (shortcut === 'Control+k') {
          await search.getByText('Searching messages...', { exact: true }).waitFor({ state: 'hidden' });
          await page.screenshot({ path: new URL(`search-${width}.png`, evidence).pathname });
          await result.click();
        } else {
          await page.keyboard.press('Enter');
        }
        await closed();
        assert.equal(await page.locator('.chat__pill-name').innerText(), 'Research Bot');

        await openViewer();
        await page.keyboard.press(shortcut);
        await searchReady();
        await page.keyboard.press(shortcut);
        await closed();

        await openViewer();
        await page.keyboard.press(shortcut);
        await searchReady();
        await page.keyboard.press('Escape');
        await closed();
      }

      // The sidebar is covered by the fullscreen viewer. Invoke its real click handler
      // directly to cover this entry path without pretending it is pointer-accessible.
      await openViewer();
      await page.locator('.sidebar__search').evaluate(button => button.click());
      await searchReady();
      await input.fill('Coordinator');
      await search.getByRole('option', { name: /Coordinator/ }).click();
      await closed();
      assert.equal(await page.locator('.chat__pill-name').innerText(), 'Coordinator');

      // Viewer controls remain usable after Search, and normal sidebar entry still works.
      await openViewer();
      await viewer.getByRole('button', { name: 'Close computer', exact: true }).click();
      await viewer.waitFor({ state: 'detached' });
      if (width < 760) await page.getByRole('button', { name: 'All Bots', exact: true }).click();
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await searchReady();
      await page.keyboard.press('Escape');
      await search.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#root').evaluate(element => element.inert), false);

      // Another shared Modal must still receive input and restore the background.
      await page.getByRole('button', { name: 'Connect apps', exact: true }).click();
      const apps = page.getByRole('dialog', { name: 'Connect Apps', exact: true });
      const appSearch = apps.getByRole('searchbox', { name: 'Search apps', exact: true });
      await frontmost(appSearch);
      await appSearch.fill('fixture');
      assert.equal(await appSearch.inputValue(), 'fixture');
      await apps.getByRole('button', { name: 'Close', exact: true }).click();
      await apps.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#root').evaluate(element => element.inert), false);
      assert.deepEqual(errors, [], 'no browser errors, external requests, or computer connections');
      assert.deepEqual(writes, [], 'no API mutations');
      console.log(`PASS I03 at ${width}: Ctrl+K, Cmd+K, sidebar entry, result selection, dismissal, viewer recovery, and shared modal`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}.png`, evidence).pathname });
      throw error;
    } finally { await page.close(); }
  }
} finally { await browser?.close(); server?.kill(); }
