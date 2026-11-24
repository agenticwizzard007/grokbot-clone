// Local components, real CLI status HTTP route, slow fake CLI processes and browser audio.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-status-'));
const evidence = path.join(root, '.context/voice-status'); await fs.mkdir(evidence, { recursive: true });
async function freePort() { const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const apiPort = await freePort(), uiPort = await freePort(), origin = `http://127.0.0.1:${uiPort}`;
const cli = path.join(tmp, 'slow-cli');
await fs.writeFile(cli, `#!${process.execPath}\nsetInterval(() => {}, 1000);`, { mode: 0o700 });
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(tmp, 'db.sqlite'),
  FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SWARM_CLI_CODEX_PATH: cli, SWARM_CLI_CLAUDE_PATH: cli,
  SESSION_SECRET: 'local-only', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, lastPage;
const start = (args, cwd = root, extra = {}) => { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); };
async function until(fn) { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not start'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/fast-status-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const account = await context.request.post(`${origin}/api/fixture/account`); assert.equal(account.status(), 200);
    const { user: accountUser } = await account.json();
    const user = { ...accountUser, email: 'local@example.test', name: 'Local QA' };
    const page = lastPage = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
    const bot = { id: `bot-${width}`, name: 'Quinn', kind: 'agent', avatarColor: 'blue', avatarShape: 'bird-flock', model: 'openai/gpt-5.5', effort: 'high' };
    const model = { id: bot.model, name: 'GPT-5.5', short: 'GPT-5.5', author: 'openai', efforts: ['high'], defaultEffort: 'high', billing: 'api', vision: true, reasoning: true };
    let holdModels = true, heldModels = [], voiceMode = 'timeout', updatePolls = 0;
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/api/auth/me') return route.fulfill({ json: { user } });
      if (p === '/api/access/credentials') return route.fulfill({ json: { keys: [] } });
      if (p.startsWith('/api/cli')) return route.continue();
      if (p === '/api/models') {
        if (holdModels) return heldModels.push(route);
        return route.fulfill({ json: { provider: 'openrouter', billing: 'api', models: [model], defaultModel: model.id, favourites: [model.id] } });
      }
      if (p === '/api/voice/session') return route.fulfill({ json: { callId: 'local-call', clientSecret: 'local', websocketUrl: `ws://127.0.0.1:${uiPort}/fixture-voice`, sampleRate: 24000, session: {} } });
      if (p === '/api/voice/updates') { updatePolls++; return route.fulfill({ json: { cursor: 0, tasks: [], updates: [] } }); }
      if (p === '/api/settings/keys') return route.fulfill({ json: { isolated: true } });
      if (p === '/api/providers/openrouter') return route.fulfill({ json: { connected: false, active: false } });
      return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/fixture-voice', ws => ws.onMessage(raw => {
      if (voiceMode === 'success' && JSON.parse(String(raw)).type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
    }));
    await page.addInitScript(() => {
      window.micRequests = 0; window.streams = []; window.permissionPending = true;
      const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.micRequests++;
        if (window.permissionPending) await new Promise(resolve => { window.grantMic = resolve; });
        const stream = await open(constraints); window.streams.push(stream); window.micGrantedAt = performance.now(); return stream;
      };
      window.chipLabels = [];
      new MutationObserver(() => { const label = document.querySelector('.model-pill__name')?.textContent; if (label) window.chipLabels.push(label); }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {Composer} from '/src/components/Composer.tsx';
import {VoiceCallBar} from '/src/components/VoiceCallBar.tsx';
import {AppSettings} from '/src/components/config/AppSettings.tsx';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import {useModels} from '/src/lib/models.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/chat.css';import '/src/styles/composer-models.css';import '/src/styles/voice.css';import '/src/styles/mobile.css';import '/src/styles/paper-core.css';
useStore.setState({user:${JSON.stringify(user)}, bots:[${JSON.stringify(bot)}], selectedBotId:${JSON.stringify(bot.id)}, mobile:innerWidth<760,mobilePane:'chat'});
window.group=()=>useStore.setState({bots:[{...useStore.getState().bots[0],kind:'room',name:'Launch team'}]});
window.settings=()=>useConfigUI.getState().openAppSettings('subscriptions','claude');
window.closeSettings=()=>useConfigUI.getState().closeAppSettings();
window.refreshModels=()=>useModels.getState().load(true);
function Harness(){const [showCall,setShowCall]=React.useState(true);window.unmountCall=()=>setShowCall(false);const bot=useStore(s=>s.bots[0]);const settings=useConfigUI(s=>s.appSettings);return React.createElement('div',{className:'app'},settings&&React.createElement(AppSettings),React.createElement('div',{style:{position:'fixed',bottom:24,left:16,right:16,maxWidth:752,margin:'auto'}},showCall&&React.createElement(VoiceCallBar),React.createElement(Composer,{bot,running:false})));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
    await page.goto(origin);
    await page.locator('.model-pill__name').filter({ hasText: 'GPT 5.5' }).waitFor();
    assert.equal(await page.getByText('Loading models…', { exact: true }).count(), 0);
    for (const group of [false, true]) {
      if (group) await page.evaluate(() => window.group());
      for (const draft of ['', 'Keep this draft while we talk']) {
        await page.locator('.composer__input').fill(draft);
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        const talk = page.getByRole('menuitem', { name: 'Talk live', exact: true }); await talk.waitFor();
        await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
        assert.equal(await talk.evaluate(el => el === document.activeElement), true);
        await page.screenshot({ path: path.join(evidence, `menu-${width}-${group ? 'group' : 'normal'}-${draft ? 'draft' : 'empty'}.png`) });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.composer__input').inputValue(), draft);
      }
    }
    // Real CLI probes sleep forever; only production status deadlines stop them.
    const startAt = performance.now(); await page.evaluate(() => window.settings());
    const plans = page.getByRole('region', { name: 'Plan connection', exact: true });
    await plans.getByText('Not connected', { exact: true }).first().waitFor();
    assert.equal(await plans.getByText('Not connected', { exact: true }).count(), 1);
    const statusMs = performance.now() - startAt; assert.ok(statusMs < 3400, `${width}: status resolved in ${statusMs}ms`);
    assert.equal(await plans.getByText('Checking status…', { exact: true }).count(), 0);
    await page.getByRole('tab', {name:'Codex',exact:true}).click();
    await plans.getByText('Not connected', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, `status-${width}.png`) });
    await page.evaluate(() => window.closeSettings());
    const cachedAt = performance.now(); await page.evaluate(() => window.settings());
    await plans.getByText('Not connected', { exact: true }).first().waitFor();
    assert.ok(performance.now() - cachedAt < 500, 'cached client status is immediate');
    await page.evaluate(() => window.closeSettings());
    holdModels = false;
    for (const route of heldModels) await route.fulfill({ json: { provider: 'openrouter', billing: 'api', models: [model], defaultModel: model.id, favourites: [model.id] } });
    heldModels = [];
    await page.locator('.model-pill__name').filter({ hasText: 'GPT-5.5' }).waitFor();
    await page.reload();
    // The resolved label is persisted, even when the next catalog is held.
    holdModels = true; await page.evaluate(() => { void window.refreshModels(); });
    await page.locator('.model-pill__name').filter({ hasText: 'GPT-5.5' }).waitFor();
    assert.equal(await page.locator('.model-pill__name').evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
    assert.ok((await page.evaluate(() => window.chipLabels)).every(label => !label.includes('Loading models')));
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Talk live', exact: true }).click();
    const call = page.getByRole('region', { name: 'Voice call with Quinn' });
    await call.getByText('Waiting for microphone permission', { exact: true }).waitFor();
    await page.waitForTimeout(10500);
    assert.equal(await call.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
    await page.evaluate(() => { window.permissionPending = false; window.grantMic(); });
    await call.getByText('Connecting…', { exact: true }).waitFor();
    await call.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    const deadlineMs = await page.evaluate(() => performance.now() - window.micGrantedAt);
    assert.ok(deadlineMs >= 9900 && deadlineMs < 11000, `setup deadline ${deadlineMs}ms`);
    assert.match(await call.innerText(), /timed out.*voice connection/);
    voiceMode = 'success'; await call.getByRole('button', { name: 'Retry', exact: true }).click();
    await call.locator('.vcall__time').waitFor();
    assert.equal(await page.evaluate(() => window.micRequests), 1);
    await call.getByRole('button', { name: 'End call', exact: true }).click();
    assert.equal(await page.evaluate(() => window.streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
    const endedPolls = updatePolls;
    await page.waitForTimeout(1800);
    assert.equal(updatePolls, endedPolls, 'updates stop after End call');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Talk live', exact: true }).click();
    await call.locator('.vcall__time').waitFor();
    await until(() => updatePolls > endedPolls);
    await page.evaluate(() => window.unmountCall());
    const unmountedPolls = updatePolls;
    await page.waitForTimeout(1800);
    assert.equal(updatePolls, unmountedPolls, 'updates stop after call UI unmount');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: 4 menus, keyboard/draft preservation, CLI status ${Math.round(statusMs)}ms, cached status, remembered chip, permission wait, deadline ${Math.round(deadlineMs)}ms, one mic request across Retry`);
    await context.close();
  }
} catch (e) { console.error(logs.join('').slice(-5000)); if (lastPage && !lastPage.isClosed()) { console.error((await lastPage.locator('body').innerText()).slice(-3000)); await lastPage.screenshot({path:path.join(evidence,'failure.png')}); } throw e; }
finally { await browser?.close(); for (const child of children.reverse()) { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } } await fs.rm(tmp, { recursive: true, force: true }); }
