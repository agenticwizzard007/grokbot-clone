// Run: node tests/mcp-folder-overflow-ui.mjs
// Local Vite UI with fake API data. The MCP editor stays an unsaved draft.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('../web', import.meta.url), stdio: 'pipe',
});
let logs = '', browser;
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const screenshots = new URL('../.context/mcp-folder-overflow/', import.meta.url);
const folder = 'release_archive_'.repeat(8);
const failures = [];

try {
  await mkdir(screenshots, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    if (vite.exitCode !== null || attempt === 100) throw new Error(`Vite did not start: ${logs}`);
    if (await fetch(origin).then(response => response.ok, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], unexpected = [], writes = [], browsed = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      localStorage.setItem('swarm.selectedBot', 'mcp-fixture');
      localStorage.setItem('swarm.detailsOpen', '0');
      window.EventSource = class {
        readyState = 1;
        close() { this.readyState = 2; }
      };
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const bot = {
      id: 'mcp-fixture', name: 'Fixture Bot', isPrimary: true, kind: 'agent', label: '', description: '', instructions: '',
      avatarShape: 'blob', avatarColor: 'blue', mode: 'personal', pinned: true, effort: 'medium', model: null,
      voice: '', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: '', lastActivityAt: 1, createdAt: 1,
    };
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (request.method() !== 'GET') {
        writes.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { error: 'Draft fixture forbids writes and connections.' } });
      }
      let body;
      if (path === '/api/auth/me') body = { user: { id: 'mcp-fixture-account', name: 'Fixture account', email: 'mcp@example.test' }, devLogin: true };
      else if (path === '/api/mcp/servers') body = { servers: [], canManage: true, stdioAvailable: true };
      else if (path === '/api/mcp/servers/folders') {
        const current = url.searchParams.get('path');
        browsed.push(current);
        assert.ok(current === '' || current === folder, 'Only the fake folder is browsed.');
        body = { folders: current ? [] : [{ path: folder, name: folder }], next: null };
      }
      else if (path === '/api/bots') body = { bots: [bot], live: [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (path === '/api/needs-you') body = { items: [] };
      else if (path === '/api/models') body = { models: [], defaultModel: null };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'cloudvm' } };
      else if (path === '/api/apps/suggestions') body = { suggestions: [] };
      else {
        unexpected.push(path);
        return route.fulfill({ status: 404, json: { error: 'Unexpected fixture read.' } });
      }
      return route.fulfill({ json: body });
    });

    // Check rendered text as well as element boxes so clipping cannot hide an overflow.
    async function fits(locator, label) {
      const result = await locator.evaluate(element => {
        const box = element.getBoundingClientRect();
        const pane = element.closest('.app-settings__main').getBoundingClientRect();
        const row = element.closest('.mcp-actions, .cfg-row').getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          boxFits: box.left >= Math.max(0, pane.left, row.left) - 1 && box.right <= Math.min(innerWidth, pane.right, row.right) + 1,
          textFits: [...range.getClientRects()].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1),
          contentFits: element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1,
        };
      });
      for (const [check, passed] of Object.entries(result)) if (!passed) failures.push(`${width}: ${label}: ${check}`);
    }
    async function reachable(button, label) {
      await button.scrollIntoViewIfNeeded();
      await fits(button, label);
      const box = await button.boundingBox();
      assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1 && box.y >= -1 && box.y + box.height <= 901, `${width}: ${label} is inside the viewport`);
      await button.focus();
      assert.equal(await button.evaluate(element => document.activeElement === element), true, `${width}: ${label} can receive keyboard focus`);
      await button.click({ trial: true });
    }

    await page.goto(`${origin}/#settings/mcp`);
    await page.getByRole('button', { name: 'Add MCP server', exact: true }).click();
    const editor = page.getByRole('form', { name: 'Add MCP server', exact: true });
    await editor.getByLabel('Connection', { exact: true }).selectOption('stdio');
    const picker = editor.locator('.cfg-row').filter({ has: page.getByText('Shared folders', { exact: true }) });
    const choice = picker.getByRole('button', { name: folder, exact: true });
    await choice.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await fits(choice, 'folder choice');
    await choice.click();
    await picker.getByText('No folders here.', { exact: true }).waitFor();
    const current = picker.locator('.mcp-actions').filter({ has: page.getByRole('button', { name: 'Up', exact: true }) });
    await fits(current.locator('span'), 'current path');
    // Keep collecting path failures at all four widths before asserting the result.
    if (!failures.some(failure => failure.startsWith(`${width}:`))) {
      await reachable(current.getByRole('button', { name: 'Up', exact: true }), 'Up');
      await reachable(current.getByRole('button', { name: 'Share this folder', exact: true }), 'Share this folder');
    }
    await current.getByRole('button', { name: 'Share this folder', exact: true }).click();
    const selected = picker.locator('.mcp-actions').filter({ has: page.getByRole('button', { name: 'Remove folder', exact: true }) });
    await selected.waitFor();
    assert.equal(await selected.locator('code').innerText(), '/workspace/folders/1');
    assert.ok((await selected.locator('span').innerText()).startsWith(folder));
    await fits(selected.locator('span'), 'selected path');
    await fits(current.locator('span'), 'current path after sharing');
    assert.equal(await current.getByRole('button', { name: 'Share this folder', exact: true }).isDisabled(), true);
    if (!failures.some(failure => failure.startsWith(`${width}:`))) {
      await reachable(selected.getByRole('button', { name: 'Remove folder', exact: true }), 'Remove folder');
      await reachable(current.getByRole('button', { name: 'Up', exact: true }), 'Up after sharing');
      await reachable(editor.getByRole('button', { name: 'Cancel', exact: true }), 'Cancel');
      await reachable(editor.getByRole('button', { name: 'Save & test connection', exact: true }), 'Save action without activating');
    }
    const paneFits = await page.locator('.app-settings__main').evaluate(element => element.scrollWidth <= element.clientWidth + 1);
    if (!paneFits) failures.push(`${width}: settings pane has horizontal overflow`);
    await picker.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: new URL(`draft-${width}.png`, screenshots).pathname, animations: 'disabled' });
    await selected.getByRole('button', { name: 'Remove folder', exact: true }).click();
    await picker.getByText('No folders shared.', { exact: true }).waitFor();
    await current.getByRole('button', { name: 'Up', exact: true }).click();
    await choice.waitFor();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Add MCP server', exact: true }).waitFor();
    assert.ok(browsed.includes('') && browsed.includes(folder), 'The fake root and long folder were browsed.');
    assert.deepEqual(writes, [], 'The draft never saves, connects, tests, or changes a server.');
    assert.deepEqual(unexpected, [], 'Every API read uses an explicit local fixture.');
    assert.deepEqual(errors, [], 'The draft has no browser errors.');
    await context.close();
    console.log(`MCP folder draft checked at ${width}px`);
  }
  assert.deepEqual(failures, [], 'Folder paths and actions must fit inside their rows and pane.');
  console.log('MCP folder overflow passed at 1280, 1024, 768, and 390px with no server writes.');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
