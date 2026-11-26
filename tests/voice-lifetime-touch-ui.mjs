import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lifetime-ui-'));
const evidence = path.join(root, '.context/lifetime-touch'); await fs.mkdir(evidence, { recursive: true });
async function port() { const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const cli = path.join(tmp, 'slow-cli');
await fs.writeFile(cli, `#!${process.execPath}\nsetTimeout(()=>{console.log(process.argv.includes('--json') ? JSON.stringify({loggedIn:false}) : 'Not logged in');process.exit(1)},4000);`, { mode: 0o700 });
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'),
  SWARM_CLI_CODEX_PATH: cli, SWARM_CLI_CLAUDE_PATH: cli, XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://voice.fixture',
  SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const s of [child.stdout, child.stderr]) s.on('data', b => logs.push(String(b))); return child; }
async function until(fn) { for (let n = 0; n < 200; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
const boot = () => start(['--import', 'tsx', 'tests/fixtures/voice-lifetime-server.mts']);
try {
  let server = boot();
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, permissions: ['microphone', 'clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
    const login = await context.request.post(`${origin}/api/auth/dev`, { data: { email: `local-${width}@example.test`, name: 'Local QA' } }); assert.equal(login.status(), 200);
    const { user } = await (await context.request.get(`${origin}/api/auth/me`)).json();
    const { bot } = await (await context.request.post(`${origin}/api/bots`, { data: { name: 'Quinn' } })).json();
    page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [], polls = [], ids = new Set(); let sessionId;
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', async r => {
      if (new URL(r.url()).pathname === '/api/voice/updates') { polls.push(r.status()); ids.add(r.request().postDataJSON().callId); }
    });
    await page.route('**/api/voice/session', async route => {
      const response = await route.fetch(), session = await response.json(); sessionId = session.callId;
      await route.fulfill({ response, json: { ...session, websocketUrl: `ws://127.0.0.1:${uiPort}/fixture-voice` } });
    });
    await page.routeWebSocket('**/fixture-voice', ws => ws.onMessage(raw => {
      if (JSON.parse(String(raw)).type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.updated', session: { id: 'provider-session-id' } }));
        ws.send(JSON.stringify({ type: 'response.done', response: { id: 'provider-response-id', output: [] } }));
      }
    }));
    await page.route('**/api/models', route => route.fulfill({ json: { models: [], favourites: [] } }));
    await page.route('**/api/team/**', route => route.fulfill({ json: { exchanges: [], nextBefore: null } }));
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js'; import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {Transcript} from '/src/components/Transcript.tsx'; import {VoiceCallBar} from '/src/components/VoiceCallBar.tsx';
import {SubscriptionSettings} from '/src/components/config/SubscriptionSettings.tsx'; import {ToastPortal} from '/src/lib/toast.ts';
import {useStore} from '/src/store.ts'; import {startCall,useVoice} from '/src/voice/call.ts';
import {startEvents} from '/src/lib/events.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/chat.css';import '/src/styles/mobile.css';import '/src/styles/paper-core.css';import '/src/styles/voice.css';import '/src/styles/config.css';import '/src/styles/access-settings.css';
const bot=${JSON.stringify(bot)}, user=${JSON.stringify(user)};
useStore.setState({user,bots:[bot],selectedBotId:bot.id,mobile:innerWidth<760}); window.voice=useVoice;
startEvents();
const rows=[{botId:bot.id,generation:1,seq:1,createdAt:Date.now(),kind:'message',body:{type:'message',role:'assistant',text:'Copy this message with [a link](https://example.test).'}},{botId:bot.id,generation:1,seq:2,createdAt:Date.now(),kind:'message',body:{type:'message',role:'user',text:'My selectable reply'}}];
function Harness(){const [settings,setSettings]=React.useState(false);return React.createElement('div',{className:'app',style:{display:'flex',flexDirection:'column',height:'100dvh',overflow:'auto'}},React.createElement(ToastPortal),React.createElement('button',{onClick:()=>startCall(bot.id)},'Start local call'),React.createElement('button',{onClick:()=>setSettings(!settings)},'Toggle status'),React.createElement(VoiceCallBar),settings?React.createElement(SubscriptionSettings,{requestedProvider:'claude'}):React.createElement(Transcript,{bot,generation:1,rows,loaded:true}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
    await page.goto(origin);
    // The transcript renders plain text before its lazy Markdown module lands.
    // Exercise keyboard focus on the settled message rather than its first paint.
    await page.getByRole('link', { name: 'a link' }).waitFor();
    const copy = page.getByRole('button', { name: 'Copy message', exact: true }).first(); await copy.waitFor();
    if (width === 390) { assert.equal(await copy.evaluate(el => getComputedStyle(el).opacity), '1'); await copy.tap(); }
    else { await copy.focus(); assert.equal(await copy.evaluate(el => getComputedStyle(el).opacity), '1'); await page.keyboard.press('Enter'); }
    await page.getByRole('status').filter({ hasText: /^Copied$/ }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Copy this message with [a link](https://example.test).');
    assert.equal(await page.getByRole('link', { name: 'a link' }).getAttribute('href'), 'https://example.test');
    await page.locator('.bubble__plain').evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    assert.equal(await page.evaluate(() => String(getSelection())), 'My selectable reply');
    await copy.scrollIntoViewIfNeeded();
    const box = await copy.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900);
    await page.screenshot({ path: path.join(evidence, `copy-${width}.png`) });
    await page.getByRole('button', { name: 'Start local call' }).click();
    await until(() => page.evaluate(() => window.voice.getState().status === 'live'));
    await until(() => polls.length >= 3); assert.ok(polls.every(status => status === 200)); assert.ok(sessionId); assert.deepEqual([...ids], [sessionId]);
    // Reproduce the lifetime mismatch: provider socket stays connected while app process restarts.
    server.kill('SIGKILL'); await once(server, 'exit'); server = boot();
    await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
    const before = polls.length; await until(() => polls.length >= before + 3);
    assert.ok(polls.slice(before).every(status => status === 200), `healthy call polling after restart: ${polls}`);
    assert.ok(!polls.includes(404), `no lost registry ID across restart: ${polls}`);
    assert.equal(await page.evaluate(() => window.voice.getState().status), 'live');
    assert.deepEqual([...ids], [sessionId]);
    await page.getByRole('button', { name: 'End call', exact: true }).click();
    await page.getByRole('button', { name: 'Toggle status' }).click();
    const plan = page.getByRole('region', { name: 'Plan connection', exact: true });
    await plan.getByRole('status').getByText('Checking', { exact: true }).waitFor();
    await plan.getByText('Not connected', { exact: true }).waitFor();
    assert.equal(await page.getByText(/CLI request timed out|Login required/).count(), 0);
    assert.equal(await plan.getByRole('button', { name: 'Connect plan' }).isEnabled(), true);
    await page.getByRole('tab', { name: 'Codex', exact: true }).click();
    await plan.getByText('Not connected', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, `status-${width}.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}: touch/keyboard copy and toast, text selection and links, ${polls.length} polls with server ID and zero 404s across restart, slow signed-out Claude and Codex`);
    await context.close();
  }
} catch (e) { console.error(logs.join('').slice(-4000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-2000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw e; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }
