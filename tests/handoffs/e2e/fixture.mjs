import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { visualEvidence } from './visual-quality.mjs';

// Extends layout-fixture.mjs's isolated environment and shared layout.seed.mts
// with a provider URL and a second seed. No credentials inherited from the host.
export async function fixture(evidence, { extraSeed } = {}) {
  fs.mkdirSync(evidence, { recursive: true });
  const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-h-'));
  const children = [], logs = [];
  const freePort = async () => { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
  const apiPort = await freePort(), uiPort = await freePort(), providerPort = await freePort(), proxyPort = await freePort();
  const base = `http://127.0.0.1:${uiPort}`, seedFile = path.join(temp, 'fixture.json');
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1',
    DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
    SESSION_SECRET: 'layout-test', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', WHATSAPP_DISABLED: '1',
    PHONE_QA_FIXTURE_FILE: seedFile, PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
    COMPOSIO_API_KEY: 'placeholder', DIRECT_API_KEY: 'placeholder', DIRECT_BASE_URL: `http://127.0.0.1:${proxyPort}/v1`, LLM_PROVIDER: 'direct' };
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `const local = fetch; globalThis.fetch = (input, init) => { const u = new URL(input instanceof Request ? input.url : input); if (['127.0.0.1','localhost'].includes(u.hostname)) return local(input, init); if (u.hostname === 'backend.composio.dev') {
      const connection = {id:'fixture-github',toolkit:{slug:'github'},status:'ACTIVE',user_id:'layout-owner',auth_config:{id:'fixture-auth',auth_scheme:'OAUTH2'}};
      if (u.pathname.endsWith('/connected_accounts')) return Promise.resolve(Response.json({items:[connection],next_cursor:null}));
      if (u.pathname.includes('/connected_accounts/')) return Promise.resolve(Response.json(connection));
      if (u.pathname.endsWith('/toolkits')) return Promise.resolve(Response.json({items:[{slug:'github',name:'GitHub',meta:{description:'Source repositories',categories:[]},no_auth:false}],next_cursor:null}));
      if (u.pathname.includes('/tool_router/session')) return Promise.resolve(Response.json({session_id:'fixture-session',tools:[],items:[]}));
    }
    return Promise.resolve(Response.json({data:[],items:[],tools:[]})); };`);
  const start = (args, cwd = root, extra = {}) => { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', d => logs.push(String(d))); return child; };
  const ready = async (url, child) => { for (let n = 0; n < 400; n++) { assert.equal(child.exitCode, null, logs.join('')); if (await fetch(url).then(r => r.ok).catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Startup timeout: ${logs.join('')}`); };
  const close = async () => { for (const c of children) if (c.exitCode === null) c.kill(); await Promise.all(children.filter(c => c.exitCode === null).map(c => once(c, 'exit'))); fs.writeFileSync(path.join(evidence, 'server.log'), logs.join('')); fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    for (const script of ['tests/fixtures/layout.seed.mts', 'tests/handoffs/e2e/seed.mts', ...(extraSeed ? [extraSeed] : [])]) {
      const seed = start(['--import', preload, '--import', 'tsx', script]); assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    }
    await ready(`http://127.0.0.1:${providerPort}/_requests`, start(['tests/mock-provider.mjs', String(providerPort)]));
    await ready(`http://127.0.0.1:${proxyPort}/_handoff_requests`, start(['tests/handoffs/mock-proxy.mjs', String(proxyPort), String(providerPort)]));
    await ready(`http://127.0.0.1:${apiPort}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
    const config = path.join(evidence, 'vite.config.mts');
    fs.writeFileSync(config, `import config from ${JSON.stringify(path.join(root, 'web/vite.config.ts'))}; export default {...config, cacheDir:${JSON.stringify(path.join(temp, 'cache'))}};`);
    await ready(base, start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--config', config, '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` }));
    return { base, data: JSON.parse(fs.readFileSync(seedFile, 'utf8')), token: 'layout-test-token', close,
      requests: () => fetch(`http://127.0.0.1:${proxyPort}/_handoff_requests`).then(r => r.json()) };
  } catch (error) { await close(); throw error; }
}

export async function browserSession(server, width, { theme = 'light' } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme: theme });
  await context.addCookies([{ name: 'swarm_session', value: server.token, url: server.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(server.base).origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(theme => { window.handoffTheme = theme; localStorage.setItem('swarm.theme', theme); window.handoffEvents = []; window.addEventListener('swarm:event', event => window.handoffEvents.push({ at: performance.now(), ...event.detail })); }, theme);
  return { browser, context, page, errors, close: () => browser.close() };
}

export async function api(page, route, method = 'GET', body) {
  const result = await page.request.fetch(new URL('/api' + route, page.url()).href, { method, ...(body ? { data: body } : {}) });
  const json = await result.json(); assert.ok(result.ok(), `${method} ${route}: ${result.status()} ${JSON.stringify(json)}`); return json;
}
export async function poll(fn, predicate, message, timeout = 60000) {
  const start = Date.now(); let value;
  do { value = await fn(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() - start < timeout);
  throw new Error(`${message}: ${JSON.stringify(value).slice(0, 2000)}`);
}
export async function screenshot(page, evidence, name, width) {
  await page.waitForFunction(() => document.documentElement.dataset.theme === window.handoffTheme);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
  const file = path.join(evidence, `${name}-${width}-${theme}.png`);
  // The application scrolls inside its shell. Expand only the screenshot height.
  const surface = page.locator('.ho-route, .flow-page').first();
  if (await surface.count()) await page.setViewportSize({ width, height: Math.min(5000, Math.max(1000, await surface.evaluate(el => el.scrollHeight) + 180)) });
  if (!name.includes('failure')) { const quality = await visualEvidence(page, { finished: name === 'handoff-receipt' }); fs.writeFileSync(file.replace(/\.png$/, '.quality.json'), JSON.stringify(quality, null, 2)); }
  await page.screenshot({ path: file, fullPage: true });
  await page.setViewportSize({ width, height: 1000 }); return file;
}
