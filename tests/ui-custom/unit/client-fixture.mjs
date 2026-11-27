import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import Database from 'better-sqlite3';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';

export async function clientFixture({ production = false } = {}) {
  const root = path.resolve('.'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-client-'));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const api = `http://127.0.0.1:${port}`, fixtureFile = path.join(temp, 'fixture.json');
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
    SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'ui-client-fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(port),
    APP_URL: api, SERVER_URL: api, WHATSAPP_DISABLED: '1', UI_CUSTOMIZATION: 'on', PHONE_QA_FIXTURE_FILE: fixtureFile };
  const preload = path.join(temp, 'offline.mjs'), entry = path.join(temp, 'entry.mts');
  fs.writeFileSync(preload, `const local=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:input);if(['127.0.0.1','localhost'].includes(url.hostname))return local(input,init);return Promise.resolve(Response.json({data:[],items:[]}));};`);
  fs.writeFileSync(entry, `import ${JSON.stringify(path.join(root, 'server/src/index.ts'))};\nimport {uiConfigService} from ${JSON.stringify(path.join(root, 'server/src/ui/index.ts'))};\nprocess.on('message',({id,userId,botId,patch,intent})=>process.send?.({id,result:uiConfigService.preview(userId,patch,{actor:'agent:'+botId,intent,autofix:true})}));`);
  const children = [], logs = [];
  const start = args => {
    const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); return child;
  };
  let vite, db;
  const close = async () => {
    await vite?.close(); db?.close();
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.filter(child => child.exitCode === null).map(child => once(child, 'exit')));
    fs.rmSync(temp, { recursive: true, force: true });
  };
  try {
    if (!production) { vite = await createServer({ root: path.join(root, 'web'), cacheDir: path.join(temp, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: api, changeOrigin: false, ws: true } } } }); await vite.listen(); }
    const base = production ? api : `http://127.0.0.1:${vite.httpServer.address().port}`;
    env.APP_URL = base; env.SERVER_URL = base;
    const seed = start(['tests/fixtures/layout.seed.mts']); assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    const child = start([entry]);
    for (let i = 0; ; i++) {
      assert.equal(child.exitCode, null, logs.join('')); assert.ok(i < 300, logs.join(''));
      if (await fetch(`${api}/api/health`).then(response => response.ok).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    db = new Database(env.DB_PATH);
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    db.prepare('UPDATE users SET name=?,email=? WHERE id=?').run('QA-Temp-Client', 'qa-temp-client@example.test', fixture.userId);
    let id = 0;
    return { base, api, fixture, db, close,
      async preview(patch, intent = 'Appearance preview') {
        const requestId = ++id;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Preview timed out')); }, 5000);
          const receive = message => { if (message.id === requestId) { clearTimeout(timer); child.off('message', receive); resolve(message.result); } };
          child.on('message', receive); child.send({ id: requestId, userId: fixture.userId, botId: fixture.bot.id, patch, intent });
        });
      },
    };
  } catch (error) { await close(); throw error; }
}
export async function signedInPage(browser, server, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(`${server.base}/#bots`); await page.locator('.shell-header').waitFor();
  await page.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready');
  return { context, page };
}
export async function patch(page, operations) {
  const result = await page.evaluate(async ops => (await import('/src/customization/store.ts')).patchUiConfig(ops), operations);
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
export const style = (page, name) => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
