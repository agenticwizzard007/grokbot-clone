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
const evidence = '.context/usage-mode-parity';
await mkdir(evidence, { recursive: true });
try {
  for (let i = 0; i < 100; i++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 844 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let mode = 'claude', unavailable = false, failed = false, hold, longPlan = false, stale = false, unknown = false;
    let modelRequests = 0;
    const catalog = () => {
      const plan = mode !== 'openrouter', id = plan ? `${mode}/default` : 'anthropic/claude-example';
      const label = mode === 'claude' ? 'Claude' : mode === 'codex' ? 'Codex' : 'API model';
      const model = { id, name: label, short: label, author: mode === 'codex' ? 'openai' : 'anthropic', efforts: ['low', 'high'], defaultEffort: 'high', vision: true, reasoning: true, context: 0, billing: plan ? 'plan' : 'api' };
      if (unknown) return { provider: null, billing: null, models: [], favourites: [], canFast: false };
      return { provider: plan ? `${mode}-cli` : mode, billing: plan ? 'plan' : 'api', models: [model], favourites: [id], defaultModel: id, canFast: !plan,
        plan: plan ? longPlan ? 'an exceptionally long provider reported subscription name' : mode === 'claude' ? 'max' : 'plus' : null,
        usage: plan ? { available: !unavailable, checkedAt: Date.now() - (stale ? 60_000 : 0), windows: unavailable ? [] : [{ label: 'Weekly usage', usedPercent: 39.2, resetsAt: 1800000000000 }] } : null };
    };
    await page.route('**/api/**', async route => {
      if (new URL(route.request().url()).pathname === '/api/models') {
        modelRequests++;
        const response = failed ? { status: 503, json: { error: 'Provider unavailable' } } : { json: catalog() };
        if (hold) await hold;
        return route.fulfill(response);
      }
      return route.fulfill({ json: {} });
    });
    await page.route(url => url.origin === origin && url.pathname === '/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {Composer} from '/src/components/Composer.tsx';
import {useModels} from '/src/lib/models.ts';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/chat.css';import '/src/styles/composer-models.css';import '/src/styles/mobile.css';import '/src/styles/paper-core.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
const bot={id:'usage-test',name:'Quinn',model:'claude/default',effort:'high',fast:false};
useStore.setState({user:{id:'alice'},mobile:innerWidth<760,mobilePane:'chat',selectedBotId:bot.id,bots:[bot]});
window.refreshUsage=()=>useModels.getState().load(true);
window.changeAccount=()=>useStore.setState({user:{id:'bob'}});
window.settingsSection=()=>useConfigUI.getState().appSettings;
const e=React.createElement;
ReactDOM.createRoot(document.getElementById('root')).render(e('div',{className:'app',style:{maxWidth:'760px',height:'100dvh',margin:'0 auto',display:'flex',flexDirection:'column',justifyContent:'flex-end'}},
 e('div',{style:{padding:'24px',fontFamily:'var(--font-stack)',fontSize:'15px',lineHeight:'24px'}},e('strong',null,'Quinn'),e('p',null,'The research is ready. What would you like to explore next?')),
 e(Composer,{bot,running:false})));
` }));
    await page.goto(origin);
    const composer = page.locator('.composer-area');
    const pill = composer.locator('.model-pill');
    const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
    const details = page.getByRole('dialog', { name: 'Connection details', exact: true });
    const panel = details.locator('.usage-mode__panel');
    const back = details.getByRole('button', { name: 'Back to models', exact: true });
    const manage = details.getByRole('button', { name: 'Manage connection', exact: true });
    const heading = name => details.getByRole('heading', { name, exact: true });
    const entry = name => picker.getByRole('button', { name, exact: true });
    const focus = locator => locator.and(page.locator(':focus')).waitFor();
    const badge = name => pill.locator('.model-billing').getByText(name, { exact: true });
    const modelName = name => pill.locator('.model-pill__name').getByText(name, { exact: true });
    const shot = name => page.screenshot({ path: `${evidence}/${name}-${width}-${theme}.png`, animations: 'disabled' });
    const openDetails = async name => {
      await pill.click();
      await entry(name).click();
      await panel.waitFor();
      assert.equal(await picker.count(), 0, 'details replaces the picker');
      assert.equal(await page.getByRole('dialog').count(), 1);
    };
    const closeDetails = async name => {
      await page.keyboard.press('Escape');
      await focus(entry(name));
      await page.keyboard.press('Escape');
      await focus(pill);
      assert.equal(await page.getByRole('dialog').count(), 0);
    };
    const noHorizontalOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

    await modelName('Claude').waitFor();
    await badge('Plan').waitFor();
    await pill.locator('.model-pill__effort').getByText('High', { exact: true }).waitFor();
    assert.equal(await composer.locator('.model-pill').count(), 1);
    assert.equal(await page.locator('.usage-mode__trigger').count(), 0, 'only the combined control launches details');
    assert.ok((await pill.boundingBox()).height >= 44, 'touch target under Paper core CSS');
    assert.ok(await noHorizontalOverflow());
    await shot('composer');
    await openDetails('Plan & usage');
    await heading('Your Claude Max plan').waitFor();
    assert.equal(await details.getByRole('progressbar', { name: 'Weekly usage' }).getAttribute('value'), '39.2');
    assert.match(await panel.innerText(), /39.2% used/);
    assert.match(await panel.innerText(), /Resets/);
    assert.equal(await page.locator('.mm-plan-usage').count(), 0);
    await shot('details');
    await back.focus();
    await page.keyboard.press('Shift+Tab');
    await focus(manage);
    await page.keyboard.press('Tab');
    await focus(back);
    await page.keyboard.press('Escape');
    await focus(entry('Plan & usage'));
    await picker.getByRole('searchbox', { name: 'Search models' }).focus();
    await page.keyboard.press('Shift+Tab');
    await picker.locator(':focus').waitFor();
    assert.notEqual(await picker.locator(':focus').getAttribute('type'), 'search', 'reverse Tab reaches the last control');
    await page.keyboard.press('Tab');
    await focus(picker.getByRole('searchbox', { name: 'Search models' }));
    await page.keyboard.press('Escape');
    await focus(pill);

    unavailable = true;
    await openDetails('Plan & usage');
    await details.getByText('Usage isn’t available from your provider right now. Check your provider account for current limits.', { exact: true }).waitFor();
    assert.equal(await details.getByRole('progressbar').count(), 0, 'unknown usage is never zero');
    await closeDetails('Plan & usage');
    unavailable = false; stale = true;
    await openDetails('Plan & usage');
    await details.getByText(/Usage needs a refresh/).waitFor();
    assert.equal(await details.getByRole('progressbar').count(), 0, 'stale quota has no current meter');
    stale = false;
    const requestsBeforeRefresh = modelRequests;
    await details.getByRole('button', { name: 'Refresh', exact: true }).click();
    await details.getByRole('progressbar', { name: 'Weekly usage' }).waitFor();
    assert.equal(modelRequests, requestsBeforeRefresh + 1, 'explicit refresh fetches the catalog once');
    await manage.click();
    assert.equal(await page.evaluate(() => window.settingsSection()), 'subscriptions');
    assert.equal(await page.getByRole('dialog').count(), 0);

    mode = 'openrouter'; await page.evaluate(() => window.refreshUsage());
    await badge('API').waitFor(); await modelName('API model').waitFor();
    await openDetails('API details');
    await heading('OpenRouter').waitFor();
    assert.equal(await details.getByRole('progressbar').count(), 0);
    assert.equal(await page.getByText('Your Claude Max plan', { exact: true }).count(), 0);
    await shot('api');
    await manage.click();
    assert.equal(await page.evaluate(() => window.settingsSection()), 'keys');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await openDetails('API details');
    await details.getByRole('button', { name: 'View usage', exact: true }).click();
    assert.equal(await page.evaluate(() => window.settingsSection()), 'usage');
    assert.equal(await page.getByRole('dialog').count(), 0);

    failed = true; await page.evaluate(() => window.refreshUsage());
    await modelName('Models unavailable').waitFor();
    assert.equal(await pill.locator('.model-billing, .model-pill__effort').count(), 0);
    await openDetails('Connection details');
    await heading('Check your connection').waitFor();
    assert.equal(await details.getByRole('progressbar').count(), 0);
    await closeDetails('Connection details');
    failed = false; unknown = true;
    await page.evaluate(() => window.refreshUsage());
    await modelName('Provider default').waitFor();
    await openDetails('Connection details');
    await heading('Choose how your Bots run').waitFor();
    assert.equal(await pill.locator('.model-billing, .model-pill__effort').count(), 0);
    assert.equal(await details.getByRole('progressbar').count(), 0);
    await closeDetails('Connection details');

    unknown = false; mode = 'claude';
    let release;
    hold = new Promise(resolve => { release = resolve; });
    await page.evaluate(() => { void window.refreshUsage(); });
    assert.notEqual(await pill.locator('.model-pill__name').innerText(), 'Loading models…');
    await openDetails('Connection details');
    await heading('Checking your connection…').waitFor();
    assert.equal(await pill.locator('.model-billing, .model-pill__effort').count(), 0);
    assert.equal(await details.getByRole('progressbar').count(), 0);
    hold = undefined; release();
    await heading('Your Claude Max plan').waitFor();
    await closeDetails('Plan & usage');

    longPlan = true; await page.evaluate(() => window.refreshUsage());
    await openDetails('Plan & usage');
    await details.getByRole('heading', { name: /exceptionally long provider reported subscription name/i }).waitFor();
    assert.ok(await noHorizontalOverflow(), 'long plan label fits the page');
    assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'long plan label fits the details panel');
    await closeDetails('Plan & usage');
    longPlan = false;
    await openDetails('Plan & usage');
    await heading('Your Claude Max plan').waitFor();
    hold = new Promise(resolve => { release = resolve; });
    mode = 'codex'; await page.evaluate(() => window.changeAccount());
    await details.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('dialog').count(), 0, 'account switch closes the previous account’s menu');
    assert.equal(await pill.locator('.model-billing, .model-pill__effort').count(), 0, 'old route and effort are cleared before the new account loads');
    hold = undefined; release();
    await modelName('Codex').waitFor();
    await badge('Plan').waitFor();
    await openDetails('Plan & usage');
    await heading('Your Codex plan').waitFor();
    assert.equal(await page.getByText('Your Claude Max plan', { exact: true }).count(), 0);
    assert.ok(await noHorizontalOverflow());
    assert.deepEqual(errors, []);
    await page.close(); console.log(`PASS ${width}px ${theme}: combined control, fresh/stale/unknown usage, loading/error, API/Plan routing, account switch, focus, touch and overflow`);
  }
} catch (error) { console.error(logs.slice(-2000)); throw error; }
finally { await browser?.close(); vite.kill(); if (vite.exitCode === null) await new Promise(resolve => vite.once('exit', resolve)); }
