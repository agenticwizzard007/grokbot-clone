import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { serverFixture } from './server-fixture.mjs';

export async function appearanceFixture() {
  // Exercise production chunks on the same origin as the isolated seeded API.
  const logs = [];
  const build = spawn(process.execPath, [path.resolve('web/node_modules/vite/bin/vite.js'), 'build'], { cwd: path.resolve('web'), env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [build.stdout, build.stderr]) stream.on('data', value => logs.push(String(value)));
  assert.equal((await once(build, 'exit'))[0], 0, logs.join(''));
  const server = await serverFixture();
  server.db.prepare('UPDATE users SET name=? WHERE id=?').run('Test User', server.fixture.userId);
  return server;
}
export async function appearanceContext(browser, fixture, width, theme) {
  const context = await browser.newContext({ baseURL: fixture.base, viewport: { width, height: width <= 760 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: fixture.base }]);
  await context.addInitScript(({ id }) => { if (location.origin !== 'null') { localStorage.setItem(`swarm.ui.migrated:${id}`, '1'); localStorage.setItem('swarm.sidebarCollapsed', '0'); } }, { id: fixture.fixture.userId });
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  return context;
}
export async function saved(page) { const response = await page.request.get('/api/ui/config'); assert.equal(response.status(), 200); return response.json(); }
export async function waitForSaved(page, predicate, label) {
  for (let i = 0; i < 150; i++) { const current = await saved(page); if (predicate(current)) { await page.waitForTimeout(80); return current; } await page.waitForTimeout(50); }
  throw new Error(`Timed out: ${label}`);
}
export async function reset(page) {
  const current = await saved(page);
  const response = await page.request.post('/api/ui/reset', { data: { scope: 'all' }, headers: { 'If-Match': `"${current.revision}"` } });
  assert.equal(response.status(), 200, await response.text());
}
