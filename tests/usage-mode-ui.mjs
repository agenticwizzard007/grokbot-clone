// Actual composer with controlled account responses. No provider login or credits used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const value = server.address().port; server.close(() => resolve(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'pipe' });
let logs = '', browser;
vite.stdout.on('data', d => logs += d); vite.stderr.on('data', d => logs += d);
await mkdir('.context/usage-bubble', { recursive: true });
try {
  for (let i = 0; i < 100; i++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 844 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let mode = 'claude', unavailable = false, failed = false, delay = 0, longPlan = false;
    const catalog = () => {
      const plan = mode !== 'openrouter', id = plan ? `${mode}/default` : 'anthropic/claude-example';
      const model = { id, name: 'Claude', short: 'Claude', author: 'anthropic', efforts: ['low', 'high'], defaultEffort: 'high', vision: true, reasoning: true, context: 0, billing: plan ? 'plan' : 'api' };
      return { provider: plan ? `${mode}-cli` : mode, billing: plan ? 'plan' : 'api', models: [model], favourites: [id], defaultModel: id, canFast: !plan,
        plan: plan ? longPlan ? 'an exceptionally long provider reported subscription name' : mode === 'claude' ? 'max' : 'plus' : null,
        usage: plan ? { available: !unavailable, checkedAt: Date.now(), windows: unavailable ? [] : [{ label: 'Weekly usage', usedPercent: 39.2, resetsAt: 1800000000000 }] } : null };
    };
    await page.route('**/api/**', async route => {
      if (new URL(route.request().url()).pathname === '/api/models') {
        if (delay) await new Promise(r => setTimeout(r, delay));
        return route.fulfill(failed ? { status: 503, json: { error: 'Provider unavailable' } } : { json: catalog() });
      }
      return route.fulfill({ json: {} });
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {Composer} from '/src/components/Composer.tsx';
import {useModels} from '/src/lib/models.ts';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/chat.css';import '/src/styles/composer-models.css';import '/src/styles/mobile.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
const bot={id:'usage-test',name:'Quinn',model:'claude/default',effort:'high',fast:false};
useStore.setState({user:{id:'alice'},mobile:innerWidth<760,mobilePane:'chat',bots:[bot]});
window.refreshUsage=()=>useModels.getState().load(true);
window.changeAccount=()=>useStore.setState({user:{id:'bob'}});
window.settingsSection=()=>useConfigUI.getState().appSettings;
const e=React.createElement;
ReactDOM.createRoot(document.getElementById('root')).render(e('div',{style:{maxWidth:'760px',height:'100dvh',margin:'0 auto',display:'flex',flexDirection:'column',justifyContent:'flex-end'}},
 e('div',{style:{padding:'24px',fontFamily:'var(--font-stack)',fontSize:'15px',lineHeight:'24px'}},e('strong',null,'Quinn'),e('p',null,'The research is ready. What would you like to explore next?')),
 e(Composer,{bot,running:false})));
` }));
    await page.goto(origin);
    const bubble = page.getByRole('button', { name: 'Usage mode: Subscription, Claude Max. View details', exact: true });
    await bubble.waitFor();
    assert.ok((await bubble.boundingBox()).height >= 44, 'touch target');
    assert.equal(await page.locator('.composer-area .model-pill .model-billing').isVisible(), false, 'one prominent mode indicator');
    await page.screenshot({ path: `.context/usage-bubble/composer-${width}-${theme}.png`, animations: 'disabled' });
    await bubble.click();
    const dialog = page.getByRole('dialog', { name: 'Your Claude Max plan' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('progressbar', { name: 'Weekly usage' }).getAttribute('value'), '39.2');
    assert.match(await dialog.innerText(), /39.2% used/);
    await page.screenshot({ path: `.context/usage-bubble/details-${width}-${theme}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'Close usage details' }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.getByRole('button', { name: 'Manage connection' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'Close usage details' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await bubble.evaluate(el => el === document.activeElement), true, 'focus restored');

    unavailable = true; await bubble.click();
    await page.getByText('Usage isn’t available from your provider right now. Check your provider account for current limits.').waitFor();
    assert.equal(await page.getByRole('progressbar').count(), 0, 'unknown usage is never zero');
    await page.keyboard.press('Escape');
    mode = 'openrouter'; await page.evaluate(() => window.refreshUsage());
    const api = page.getByRole('button', { name: 'Usage mode: API credits, OpenRouter. View details' });
    await api.waitFor(); await api.click();
    await page.getByRole('heading', { name: 'OpenRouter', exact: true }).waitFor();
    assert.equal(await page.getByRole('progressbar').count(), 0);
    assert.equal(await page.getByText('Your Claude Max plan', { exact: true }).count(), 0);
    await page.screenshot({ path: `.context/usage-bubble/api-${width}-${theme}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'Manage connection' }).click();
    assert.equal(await page.evaluate(() => window.settingsSection()), 'keys');

    failed = true; await page.evaluate(() => window.refreshUsage());
    const warning = page.getByRole('button', { name: 'Usage mode: Check connection. View details' });
    await warning.waitFor(); await warning.click();
    await page.getByRole('heading', { name: 'Check your connection' }).waitFor();
    assert.equal(await page.getByRole('progressbar').count(), 0);
    await page.keyboard.press('Escape');
    failed = false; mode = 'claude'; delay = 400;
    await page.evaluate(() => { void window.refreshUsage(); });
    await page.getByRole('button', { name: 'Usage mode: Checking usage…. View details' }).waitFor();
    await bubble.waitFor(); delay = 0;
    longPlan = true; await page.evaluate(() => window.refreshUsage());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'long plan label fits');
    longPlan = false; await page.evaluate(() => window.refreshUsage());
    await bubble.click(); await dialog.waitFor();
    mode = 'codex'; await page.evaluate(() => window.changeAccount());
    await page.getByRole('button', { name: 'Usage mode: Subscription, ChatGPT Plus. View details' }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'account switch closes previous account details');
    assert.equal(await page.getByText('Claude Max', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.close(); console.log(`PASS ${width}px ${theme}: billing source, actual quota, unknown/error/loading states, account switch, focus, touch and overflow`);
  }
} catch (error) { console.error(logs.slice(-2000)); throw error; }
finally { await browser?.close(); vite.kill(); if (vite.exitCode === null) await new Promise(resolve => vite.once('exit', resolve)); }
