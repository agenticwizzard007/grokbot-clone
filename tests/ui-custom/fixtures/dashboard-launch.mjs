import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export function flyUiEnvironment(root = process.cwd()) {
  const env = {}; let section = '';
  for (const line of fs.readFileSync(path.join(root, 'fly.toml'), 'utf8').split('\n')) {
    if (/^\s*\[/.test(line)) section = line.trim();
    const assignment = /^\s*(UI_CUSTOMIZATION|UI_ADAPT)\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (section === '[env]' && assignment) env[assignment[1]] = assignment[2];
  }
  return env;
}

/** A blank database and real auth/dev cookie issuance, with no seeded users or preferences. */
export async function dashboardLaunchServer({ root = process.cwd() } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-launch-'));
  const port = async () => { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
  const apiPort = await port(), uiPort = await port(), modelPort = await port();
  const base = `http://127.0.0.1:${uiPort}`, api = `http://127.0.0.1:${apiPort}`, model = `http://127.0.0.1:${modelPort}`;
  const scripts = new Map(), logs = [], children = [];
  const proxy = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      if (request.url === '/v1/responses' && raw) {
        const body = JSON.parse(raw), user = [...(body.input ?? [])].reverse().find(item => item.role === 'user');
        if (user && typeof user.content === 'string' && scripts.has(user.content)) user.content = scripts.get(user.content);
        else if (user && Array.isArray(user.content)) for (const item of user.content) if (scripts.has(item.text)) item.text = scripts.get(item.text);
        raw = JSON.stringify(body);
      }
      const upstream = await fetch(`${model}${request.url}`, { method: request.method, headers: { 'content-type': 'application/json', authorization: 'Bearer local-placeholder' }, ...(raw ? { body: raw } : {}) });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      for await (const part of upstream.body) response.write(part); response.end();
    } catch { response.writeHead(502); response.end('Local provider unavailable'); }
  }).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', ...flyUiEnvironment(root),
    DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
    SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'dashboard-launch-local', COMPUTER_PROVIDER: 'local',
    DEV_LOGIN: '1', INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
    LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'local-placeholder', DIRECT_BASE_URL: `http://127.0.0.1:${proxy.address().port}/v1`, DIRECT_MODEL: 'gpt-4.1' };
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `const local=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(input instanceof Request?input.url:input);if(['localhost','127.0.0.1'].includes(u.hostname))return local(input,init);return Promise.resolve(Response.json({data:[],items:[]}));};`);
  const start = (args, cwd = root, extra = {}) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); return child;
  };
  const ready = async (url, child) => {
    for (let i = 0; i < 300; i++) { assert.equal(child.exitCode, null, logs.join('')); if (await fetch(url).then(r => r.ok).catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(logs.join(''));
  };
  const close = async () => { for (const child of children) if (child.exitCode === null) child.kill(); await Promise.all(children.filter(c => c.exitCode === null).map(c => once(c, 'exit'))); proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    await ready(`${model}/_requests`, start(['tests/mock-provider.mjs', String(modelPort)]));
    await ready(`${api}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
    await ready(base, start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: api }));
    let account = 0;
    return { base, api, dbPath: env.DB_PATH, scripts, logs, close,
      async context(browser, width = 390, theme = 'light', height = width <= 760 ? 844 : 720) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
        await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
        const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `dashboard-${++account}@example.test`, name: 'Test User' } });
        assert.equal(login.status(), 200, await login.text());
        assert.ok((await context.cookies()).some(cookie => cookie.name === 'swarm_session'), 'Real auth response installs the session cookie');
        const me = await (await context.request.get(`${base}/api/auth/me`)).json();
        assert.ok(me.user?.id);
        return { context, user: me.user, request: async (method, route, body, revision) => {
          const response = await context.request.fetch(`${base}/api${route}`, { method, headers: { origin: base, ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }) }, ...(body === undefined ? {} : { data: body }) });
          return { status: response.status(), body: await response.json() };
        } };
      },
    };
  } catch (error) { await close(); throw error; }
}
