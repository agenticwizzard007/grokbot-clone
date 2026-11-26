// Real components, local fixtures only. No live account or provider requests.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
const vite = await createServer({ root: `${process.cwd()}/web`, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
await mkdir('.context/readiness-mm', { recursive: true });
const user = { id: 'fixture', email: 'fixture@example.test', name: 'Fixture account', role: 'user' };
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) for (const tier of ['max', 'pro', 'team', 'codex']) {
    const provider = tier === 'codex' ? 'codex' : 'claude';
    const label = provider === 'codex' ? 'Codex plan' : `Claude ${tier[0].toUpperCase() + tier.slice(1)} plan`;
    const catalog = { provider: `${provider}-cli`, billing: 'plan', plan: tier === 'codex' ? null : tier, models: [], favourites: [], canFast: false, defaultModel: `${provider}/default` };
    const run = { startedAt: Date.now(), provider, runtime: 'server', toolsOffered: 19, trigger: null, lastTool: 'SWARM_APPS_EXECUTE', result: 'pending_approval', errorCode: null };
    const status = { runtime: 'server', serverLoginAvailable: true, selected: provider, connected: true, device: 'Swarm server',
      providers: { codex: { installed: true, authenticated: true, subscription: true }, claude: { installed: true, authenticated: true, subscription: true } },
      lastRun: run, runsByProvider: { [provider]: { latest: run, lastToolRun: run } } };
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.route('**/api/**', route => {
      if (route.request().method() !== 'GET') writes.push(route.request().method());
      const p = new URL(route.request().url()).pathname;
      return route.fulfill({ json: p === '/api/cli' ? status : p === '/api/auth/me' ? { user } : p === '/api/models' ? catalog : {} });
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {ComposerModelMenu} from '/src/components/ComposerModelMenu.tsx';
import {SidebarUsage} from '/src/components/SidebarUsage.tsx';
import {AppSettings} from '/src/components/config/AppSettings.tsx';
import {useStore} from '/src/store.ts';
import {useModels} from '/src/lib/models.ts';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/shell.css';import '/src/styles/chat.css';import '/src/styles/composer-models.css';import '/src/styles/mobile.css';import '/src/styles/paper-core.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
const bot={id:'fixture-bot',name:'Fixture Bot',model:${JSON.stringify(`${provider}/default`)},effort:'high',fast:false};
useStore.setState({user:${JSON.stringify(user)},mobile:innerWidth<760,selectedBotId:bot.id,bots:[bot]});
useModels.setState({...${JSON.stringify(catalog)},status:'ready',byId:new Map()});
window.openSettings=()=>useConfigUI.getState().openAppSettings('subscriptions',${JSON.stringify(provider)});
const e=React.createElement;
ReactDOM.createRoot(document.getElementById('root')).render(e(React.Fragment,null,e('main',{style:{padding:20,maxWidth:600,margin:'0 auto',height:'100dvh',display:'flex',flexDirection:'column'}},e('h1',null,'Plan and usage'),e('div',{style:{maxWidth:240}},e(SidebarUsage,{collapsed:false})),e('div',{style:{marginTop:'auto'}},e(ComposerModelMenu,{bot}))),e(AppSettings)));
` }));
    try {
      await page.goto(origin);
      await page.locator('.sidebar-usage strong').getByText(label, { exact: true }).waitFor();
      assert.match(await page.locator('.model-pill').getAttribute('title'), new RegExp(label));
      await page.locator('.model-pill').click();
      const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
      if (provider === 'claude') await picker.getByText(`Uses your ${label} through Claude Code.`, { exact: true }).waitFor();
      await picker.getByRole('button', { name: 'Plan & usage', exact: true }).click();
      const heading = page.getByRole('heading', { name: `Your ${label}`, exact: true });
      await heading.waitFor();
      assert.ok(await heading.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'Plan heading fits the viewport');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `.context/readiness-mm/${tier}-${width}-${theme}-usage.png` });
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await page.evaluate(() => window.openSettings());
      const details = page.locator('.subscription-settings__context');
      await details.locator('summary').click();
      await details.getByText('Approval requested', { exact: true }).first().waitFor();
      assert.match(await details.innerText(), /Last tool run[\s\S]*SWARM_APPS_EXECUTE[\s\S]*Approval requested/);
      if (provider === 'claude') {
        await page.getByText(`Reported plan: ${label}`, { exact: true }).waitFor();
        assert.ok((await page.locator('body').innerText()).includes(`Signed in · ${label}`));
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await details.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.context/readiness-mm/${tier}-${width}-${theme}-settings.png` });
      // Render the same server results after Don't allow and after an internal action.
      status.runsByProvider[provider].latest = { ...run, trigger: 'approval_decision', lastTool: null, result: 'no_tool_call' };
      await page.reload(); await page.evaluate(() => window.openSettings()); await details.locator('summary').click();
      await details.getByText('Reply after your decision', { exact: true }).waitFor();
      assert.match(await details.innerText(), /Reply after your decision[\s\S]*No tool call[\s\S]*Last tool run[\s\S]*Approval requested/);
      const completed = { ...run, lastTool: 'create_task', result: 'completed' };
      status.runsByProvider[provider] = { latest: completed, lastToolRun: completed };
      await page.reload(); await page.evaluate(() => window.openSettings()); await details.locator('summary').click();
      await details.getByText('Completed', { exact: true }).first().waitFor();
      assert.match(await details.innerText(), /Last tool run[\s\S]*create_task[\s\S]*Completed/);
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      console.log(`PASS R12 ${tier} ${width} ${theme}: plan labels, pending, decision reply, completed internal run, no overflow`);
    } catch (error) {
      await page.screenshot({ path: '.context/readiness-mm/failure.png' });
      console.error((await page.locator('body').innerText()).slice(-6000));
      throw error;
    } finally { await page.close(); }
  }
} finally { await browser.close(); await vite.close(); }
