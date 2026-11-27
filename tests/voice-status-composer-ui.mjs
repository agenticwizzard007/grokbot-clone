// Local components, real CLI status HTTP route, slow fake CLI processes and browser audio.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-status-'));
const evidence = path.join(root, '.context/r15-ss-voice'); await fs.mkdir(evidence, { recursive: true });
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
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    const account = await context.request.post(`${origin}/api/fixture/account`); assert.equal(account.status(), 200);
    const { user: accountUser } = await account.json();
    // A saved login with a hung probe is an error; a never-set-up profile is neutral.
    const profile = path.join(env.CLI_PROFILES_DIR, createHash('sha256').update(accountUser.id).digest('hex'), '.claude');
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, '.credentials.json'), '{}');
    const user = { ...accountUser, email: 'local@example.test', name: 'Local QA' };
    const page = lastPage = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
    const bot = { id: `bot-${width}`, name: 'Fixture Bot', voice: 'default', voiceSpeed: 1, voiceLanguage: 'en', kind: 'agent', avatarColor: 'blue', avatarShape: 'bird-flock', model: 'openai/gpt-5.5', effort: 'high' };
    const model = { id: bot.model, name: 'GPT-5.5', short: 'GPT-5.5', author: 'openai', efforts: ['high'], defaultEffort: 'high', billing: 'api', vision: true, reasoning: true };
    let holdModels = true, heldModels = [], voiceMode = 'timeout', updatePolls = 0;
    let holdSession = false, heldSession, sessionRequests = 0, endRequests = 0, socketCount = 0;
    const session = { callId: 'local-call', clientSecret: 'local', websocketUrl: `ws://127.0.0.1:${uiPort}/fixture-voice`, sampleRate: 24000, session: {} };
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/api/auth/me') return route.fulfill({ json: { user } });
      if (p === '/api/access/credentials') return route.fulfill({ json: { keys: [] } });
      if (p.startsWith('/api/cli')) return route.continue();
      if (p === '/api/models') {
        if (holdModels) return heldModels.push(route);
        return route.fulfill({ json: { provider: 'platform', billing: 'api', models: [model], defaultModel: model.id, favourites: [model.id] } });
      }
      if (p === '/api/voice/options') return route.fulfill({ json: { voices: [{ id: 'default', name: 'Default' }], speeds: [1], languages: [{ code: 'en', name: 'English' }] } });
      if (p === '/api/voice/session') { sessionRequests++; if (holdSession) { heldSession = route; return; } return route.fulfill({ json: session }); }
      if (p === '/api/voice/end') { endRequests++; return route.fulfill({ json: { ok: true } }); }
      if (p === '/api/voice/updates') { updatePolls++; return route.fulfill({ json: { cursor: 0, tasks: [], updates: [] } }); }
      if (p === '/api/settings/keys') return route.fulfill({ json: { isolated: true } });
      if (p === '/api/providers/openrouter') return route.fulfill({ json: { connected: false, active: false } });
      return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/fixture-voice', ws => { socketCount++; ws.onMessage(raw => {
      if (voiceMode === 'success' && JSON.parse(String(raw)).type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
    }); });
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
import {VoiceSettings} from '/src/components/VoiceSettings.tsx';
import {useVoice} from '/src/voice/call.ts';
import {AppSettings} from '/src/components/config/AppSettings.tsx';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import {useModels} from '/src/lib/models.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/chat.css';import '/src/styles/composer-models.css';import '/src/styles/voice.css';import '/src/styles/mobile.css';import '/src/styles/paper-core.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
window.voiceState=()=>useVoice.getState();
useStore.setState({user:${JSON.stringify(user)}, bots:[${JSON.stringify(bot)}], selectedBotId:${JSON.stringify(bot.id)}, mobile:innerWidth<760,mobilePane:'chat'});
window.group=()=>useStore.setState({bots:[{...useStore.getState().bots[0],kind:'room',name:'Launch team'}]});
window.settings=()=>useConfigUI.getState().openAppSettings('subscriptions','claude');
window.closeSettings=()=>useConfigUI.getState().closeAppSettings();
window.refreshModels=()=>useModels.getState().load(true);
// Match DetailsPanel's compact voice form so the fixture's fixed composer cannot cover it.
function Harness(){const [showCall,setShowCall]=React.useState(true);const [showVoice,setShowVoice]=React.useState(false);window.showVoiceSettings=()=>setShowVoice(true);window.unmountCall=()=>setShowCall(false);const bot=useStore(s=>s.bots[0]);const settings=useConfigUI(s=>s.appSettings);return React.createElement('div',{className:'app'},settings&&React.createElement(AppSettings),showVoice&&React.createElement('div',{style:{padding:16,maxWidth:500,margin:'auto'}},React.createElement(VoiceSettings,{bot,compact:true})),React.createElement('div',{style:{position:'fixed',bottom:24,left:16,right:16,maxWidth:752,margin:'auto'}},showCall&&React.createElement(VoiceCallBar),React.createElement(Composer,{bot,running:false})));}
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
        await page.screenshot({ path: path.join(evidence, `menu-${width}-${theme}-${group ? 'group' : 'normal'}-${draft ? 'draft' : 'empty'}.png`) });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.composer__input').inputValue(), draft);
      }
    }
    // Hung probes of saved state stay Checking during the bounded check, then offer Retry.
    const startAt = performance.now(); await page.evaluate(() => window.settings());
    const plans = page.getByRole('region', { name: 'Plan connection', exact: true });
    await plans.getByText('Status unavailable', { exact: true }).first().waitFor({ timeout: 20000 });
    assert.equal(await plans.getByText('Status unavailable', { exact: true }).count(), 1);
    const statusMs = performance.now() - startAt; assert.ok(statusMs < 18000, `${width}: status resolved in ${statusMs}ms`);
    assert.equal(await plans.getByRole('status').getByText('Checking', { exact: true }).count(), 0);
    await page.getByRole('tab', {name:'Codex',exact:true}).click();
    await plans.getByText('Status unavailable', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, `status-${width}-${theme}.png`) });
    await page.evaluate(() => window.closeSettings());
    const cachedAt = performance.now(); await page.evaluate(() => window.settings());
    await plans.getByText('Status unavailable', { exact: true }).first().waitFor({ timeout: 20000 });
    assert.ok(performance.now() - cachedAt < 500, 'cached client status is immediate');
    await page.evaluate(() => window.closeSettings());
    holdModels = false;
    for (const route of heldModels) await route.fulfill({ json: { provider: 'platform', billing: 'api', models: [model], defaultModel: model.id, favourites: [model.id] } });
    heldModels = [];
    await page.locator('.model-pill__name').filter({ hasText: 'GPT-5.5' }).waitFor();
    await page.reload();
    // The resolved label is persisted, even when the next catalog is held.
    holdModels = true; await page.evaluate(() => { void window.refreshModels(); });
    await page.locator('.model-pill__name').filter({ hasText: 'GPT-5.5' }).waitFor();
    assert.equal(await page.locator('.model-pill__name').evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
    assert.ok((await page.evaluate(() => window.chipLabels)).every(label => !label.includes('Loading models')));
    const mic = page.locator('.composer__voice');
    // Two synchronous clicks exercise the handler before React can repaint it.
    assert.equal(await mic.evaluate(button => { button.click(); button.click(); return window.voiceState().status; }), 'connecting');
    const call = page.getByRole('region', { name: 'Voice call with Fixture Bot' });
    await call.getByText('Waiting for microphone permission', { exact: true }).waitFor({ timeout: 1000 });
    const assertConnecting = async () => {
      assert.equal(await mic.isDisabled(), true);
      assert.equal(await mic.getAttribute('aria-label'), 'Connecting');
      assert.equal(await mic.getAttribute('aria-busy'), 'true');
      assert.equal(await call.getByRole('button', { name: 'End call', exact: true }).count(), 0);
      assert.equal(await call.getByRole('button', { name: 'Mute', exact: true }).count(), 0);
      await call.getByRole('button', { name: 'Cancel call setup', exact: true }).waitFor();
      const box = await mic.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2 });
      assert.equal(await page.evaluate(() => window.voiceState().status), 'connecting');
    };
    await assertConnecting();
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Connecting', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceState().status), 'connecting');
    assert.equal(await page.evaluate(() => window.micRequests), 1);
    assert.equal(sessionRequests, 0);
    await page.screenshot({ path: path.join(evidence, `permission-${width}-${theme}.png`) });
    await page.waitForTimeout(10500);
    assert.equal(await call.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
    await page.evaluate(() => { window.permissionPending = false; window.grantMic(); });
    await call.getByText('Connecting…', { exact: true }).waitFor();
    await assertConnecting();
    assert.equal(sessionRequests, 1); assert.equal(endRequests, 0);
    await page.screenshot({ path: path.join(evidence, `connecting-${width}-${theme}.png`) });
    await call.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    const deadlineMs = await page.evaluate(() => performance.now() - window.micGrantedAt);
    assert.ok(deadlineMs >= 9900 && deadlineMs < 11000, `setup deadline ${deadlineMs}ms`);
    assert.match(await call.innerText(), /timed out.*voice connection/);
    assert.equal(await mic.isEnabled(), true);
    await page.screenshot({ path: path.join(evidence, `error-${width}-${theme}.png`) });
    voiceMode = 'success'; await call.getByRole('button', { name: 'Retry', exact: true }).click();
    await call.locator('.vcall__time').waitFor();
    assert.equal(await page.evaluate(() => window.micRequests), 1);
    assert.equal(await mic.getAttribute('aria-label'), 'End call with Fixture Bot');
    await call.getByRole('button', { name: 'Mute', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceState().muted), true);
    await call.getByRole('button', { name: 'Unmute', exact: true }).click();
    await page.screenshot({ path: path.join(evidence, `live-${width}-${theme}.png`) });
    await call.getByRole('button', { name: 'End call', exact: true }).click();
    assert.equal(await page.evaluate(() => window.streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
    const endedPolls = updatePolls;
    await page.waitForTimeout(1800);
    assert.equal(updatePolls, endedPolls, 'updates stop after End call');
    // Voice Settings uses the same guard, including while the token request is slow.
    await page.evaluate(() => window.showVoiceSettings());
    const settingsCall = page.locator('.voice-settings__call');
    holdSession = true;
    const beforeSessions = sessionRequests, beforeEnds = endRequests, beforeSockets = socketCount;
    assert.equal(await settingsCall.evaluate(button => { button.click(); button.click(); return window.voiceState().status; }), 'connecting');
    await until(() => Boolean(heldSession));
    await assertConnecting();
    assert.equal(await settingsCall.isDisabled(), true);
    assert.equal(await settingsCall.innerText(), 'Connecting…');
    await settingsCall.evaluate(button => button.click());
    await page.waitForTimeout(500);
    assert.equal(sessionRequests, beforeSessions + 1); assert.equal(endRequests, beforeEnds); assert.equal(socketCount, beforeSockets);
    await page.screenshot({ path: path.join(evidence, `settings-slow-token-${width}-${theme}.png`) });
    holdSession = false; await heldSession.fulfill({ json: session }); heldSession = undefined;
    await call.locator('.vcall__time').waitFor();
    assert.equal(await settingsCall.innerText(), 'End voice chat');
    assert.equal(socketCount, beforeSockets + 1);
    await settingsCall.click();
    assert.equal(await page.evaluate(() => window.voiceState().status), 'idle');
    // The More actions start remains available while a draft is present.
    await page.locator('.composer__input').fill('Keep this draft while we talk');
    voiceMode = 'timeout';
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Talk live', exact: true }).click();
    await call.getByText('Connecting…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Connecting', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceState().status), 'connecting');
    await call.getByRole('button', { name: 'Cancel call setup', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceState().status), 'idle');
    assert.equal(await page.locator('.composer__input').inputValue(), 'Keep this draft while we talk');
    voiceMode = 'success';
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Talk live', exact: true }).click();
    await call.locator('.vcall__time').waitFor();
    await until(() => updatePolls > endedPolls);
    await page.evaluate(() => window.unmountCall());
    const unmountedPolls = updatePolls;
    await page.waitForTimeout(1800);
    assert.equal(updatePolls, unmountedPolls, 'updates stop after call UI unmount');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px ${theme}: 4 menus, keyboard/draft preservation, CLI status ${Math.round(statusMs)}ms, cached status, remembered chip, permission wait, deadline ${Math.round(deadlineMs)}ms, one mic request across Retry, immediate feedback and duplicate-click protection in Composer/menu/Voice Settings, slow token, live mute/End, explicit setup Cancel`);
    await context.close();
  }
} catch (e) { console.error(logs.join('').slice(-5000)); if (lastPage && !lastPage.isClosed()) { console.error((await lastPage.locator('body').innerText()).slice(-3000)); await lastPage.screenshot({path:path.join(evidence,'failure.png')}); } throw e; }
finally { await browser?.close(); for (const child of children.reverse()) { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } } await fs.rm(tmp, { recursive: true, force: true }); }
