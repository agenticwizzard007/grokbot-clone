// Actual composer/activity components with controlled provider catalogs. No live inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const apiModels = [
  { id: 'openai/gpt-5.5', short: 'GPT-5.5', author: 'openai', efforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  { id: 'anthropic/claude-opus-5.5', short: 'Opus 5.5', author: 'anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null },
  { id: 'google/gemini-4-argon', short: 'Gemini 4 Argon', author: 'google', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'google/gemini-4-hydrogen', short: 'Gemini 4 Hydrogen', author: 'google', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: null },
  { id: 'x-ai/grok-4.7', short: 'Grok 4.7', author: 'x-ai', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
];

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'pipe' });
let logs = '', browser;
vite.stdout.on('data', data => logs += data); vite.stderr.on('data', data => logs += data);
await mkdir('.context/cli-effort', { recursive: true });
try {
  for (let i = 0; i < 100; i++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 960, 390, 320]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 900 } });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let source = 'codex', defaultKnown = true, defaultAvailable = true, failSave = false;
    let bot = { label: '', description: '', instructions: '', mode: 'personal', id: 'effort-test', name: 'Test bot', model: 'api/old', effort: 'ultracode', fast: true, avatarShape: 'circle', avatarColor: 'blue' };
    const patches = [];
    const catalog = () => {
      const plan = source !== 'openrouter';
      const prefix = plan ? source : 'api';
      const models = [
        { id: `${prefix}/primary`, name: source === 'claude' ? 'Opus 5.5' : 'GPT-6.1 Sol', efforts: source === 'claude' ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high', 'xhigh'], defaultEffort: defaultKnown ? 'medium' : null, reasoning: true },
        { id: `${prefix}/limited`, name: 'Limited effort model', efforts: ['low', 'high'], defaultEffort: 'low', reasoning: true },
        { id: `${prefix}/plain`, name: 'No effort model', efforts: [], defaultEffort: null, reasoning: false },
      ].map(m => ({ ...m, short: m.name, billing: plan ? 'plan' : 'api', author: source === 'claude' ? 'anthropic' : 'openai', vision: true, context: 0 }));
      if (!plan) models.push(...apiModels.map(m => ({ ...m, name: m.short, billing: 'api', reasoning: true, vision: true, context: 0 })));
      return { provider: plan ? `${source}-cli` : 'openrouter', billing: plan ? 'plan' : 'api', models, favourites: models.map(m => m.id), defaultModel: defaultAvailable ? models[0].id : null, canFast: !plan, plan: plan ? 'pro' : null,
        usage: plan ? { available: true, checkedAt: Date.now(), windows: [{ label: 'Weekly', usedPercent: 15, resetsAt: null }] } : null };
    };
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/models') return route.fulfill({ json: catalog() });
      if (pathname === '/api/bots/effort-test/settings') return route.fulfill({ json: { skills: [], memories: [], routines: [], tasks: [] } });
      if (pathname.endsWith('/routines')) return route.fulfill({ json: { routines: [] } });
      if (pathname === '/api/cli') return route.fulfill({ json: { selected: source === 'openrouter' ? null : source, connected: true,
        providers: { codex: { installed: true, authenticated: true, subscription: true }, claude: { installed: true, authenticated: true, subscription: true } } } });
      if (pathname === '/api/bots/effort-test') {
        const patch = route.request().postDataJSON(); patches.push(patch);
        if (failSave) { failSave = false; return route.fulfill({ status: 500, json: { error: 'Save failed' } }); }
        bot = { ...bot, ...patch }; return route.fulfill({ json: { bot } });
      }
      return route.fulfill({ json: {} });
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {Composer} from '/src/components/Composer.tsx';
import {ActivityLine} from '/src/components/ActivityLine.tsx';
import {BotSettingsModal} from '/src/components/config/BotSettingsModal.tsx';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/config.css';
import {useStore} from '/src/store.ts';
import {useModels} from '/src/lib/models.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/chat.css';import '/src/styles/composer-models.css';import '/src/styles/mobile.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
useStore.setState({user:{id:'alice'},mobile:innerWidth<760,mobilePane:'chat',selectedBotId:${JSON.stringify(bot.id)},bots:[${JSON.stringify(bot)}]});
window.openSettings=()=>useConfigUI.getState().openBotSettings('effort-test','general');
window.closeSettings=()=>useConfigUI.getState().discardBotSettings();
window.refreshCatalog=()=>useModels.getState().load(true);
window.setBot=bot=>useStore.setState({bots:[bot]});
const live={isRunning:true,startedAt:Date.now(),activity:{kind:'thinking',since:Date.now()}};
function Harness(){const bot=useStore(s=>s.bots[0]);return React.createElement('div',{style:{maxWidth:${JSON.stringify(width === 960 ? '340px' : '760px')},height:'100dvh',margin:${JSON.stringify(width === 960 ? '0 16px 0 auto' : '0 auto')},display:'flex',flexDirection:'column',justifyContent:'flex-end'}},
 React.createElement('div',{style:{padding:'24px'}},React.createElement('h2',null,'Test bot'),React.createElement('p',null,'I’m reviewing the results.'),React.createElement(ActivityLine,{bot,live,rows:[]})),
 React.createElement(Composer,{bot,running:true}),React.createElement(BotSettingsModal));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.setBot === 'function' && typeof window.refreshCatalog === 'function');
    const setBot = async patch => { bot = { ...bot, ...patch }; await page.evaluate(value => window.setBot(value), bot); };
    const open = async () => { await page.locator('.model-pill').click(); await page.locator('.mm-row__main').first().waitFor(); };
    const options = () => page.getByRole('listbox', { name: 'Effort', exact: true }).getByRole('option');
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const choose = async name => {
      const saved = page.waitForResponse(r => r.url().endsWith('/api/bots/effort-test'));
      await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click(); await saved; await settle();
      await page.waitForFunction(() => !document.querySelector('.model-menu'));
    };
    const checkEffort = async (effort, duration) => {
      await page.waitForFunction(value => document.querySelector('.composer-shell')?.dataset.effort === value, effort);
      assert.equal(await page.locator('.activity-line').getAttribute('data-effort'), effort);
      assert.equal(await page.locator('.composer').evaluate(el => getComputedStyle(el).animationDuration), duration);
    };
    for (const provider of ['codex', 'claude']) {
      source = provider; await setBot({ model: 'api/old', effort: 'ultracode', fast: true }); await page.evaluate(() => window.refreshCatalog());
      await page.locator('.model-pill__effort').getByText('Medium', { exact: true }).waitFor();
      await checkEffort('medium', '12s');
      await open();
      assert.equal(await page.getByRole('button', { name: 'Effort for No effort model', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Effort', exact: true }).click();
      assert.equal(await options().count(), 4);
      assert.doesNotMatch((await options().allTextContents()).join(' '), /Ultracode/);
      assert.match(await page.locator('.mm-effort[aria-selected="true"]').innerText(), /^Medium/);
      await page.keyboard.press('Home');
      assert.equal(await options().first().evaluate(el => el === document.activeElement), true);
      const inlineEffort = await page.locator('.mm-flyout').count() === 0;
      await page.keyboard.press('Escape');
      if (inlineEffort) {
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Effort');
      } else {
        await page.locator('.model-menu').waitFor({ state: 'detached' });
        assert.equal(await page.locator('.model-pill').evaluate(el => el === document.activeElement), true);
        await open();
      }
      await page.getByRole('button', { name: 'Effort', exact: true }).click();
      await choose('Low'); await checkEffort('low', '18s');
      assert.deepEqual(patches.at(-1), { model: `${provider}/primary`, effort: 'low', fast: false });
      await open(); await page.getByRole('button', { name: 'Effort for Limited effort model', exact: true }).click();
      assert.deepEqual((await options().allTextContents()).map(s => s.startsWith('High') ? 'high' : s.startsWith('Low') ? 'low' : s), ['high', 'low']);
      await choose('High'); await checkEffort('high', '6s');
      assert.deepEqual(patches.at(-1), { model: `${provider}/limited`, effort: 'high', fast: false });
      assert.equal(await page.locator('.composer.is-ultracode').count(), 1);
      assert.equal(await page.locator('.model-pill.is-ultracode').count(), 1);
      // A failed save restores both the selected value and its animation.
      await open(); await page.getByRole('button', { name: 'Effort', exact: true }).click(); failSave = true;
      const failed = page.waitForResponse(r => r.url().endsWith('/api/bots/effort-test') && r.status() === 500);
      await choose('Low'); await failed; await checkEffort('high', '6s');
      // Defaults from null, old API selection, the other CLI, and explicit aliases all remain configurable.
      for (const model of [null, 'api/old', `${provider === 'codex' ? 'claude' : 'codex'}/old`, `${provider}/default`]) {
        await setBot({ model, effort: 'high' });
        await checkEffort(model === `${provider}/default` ? 'high' : 'medium', model === `${provider}/default` ? '9s' : '12s');
      }
      await setBot({ model: null, effort: 'high' });
      await page.getByRole('textbox', { name: 'Message Test bot', exact: true }).focus();
      const count = patches.length;
      const cycled = page.waitForResponse(r => r.url().endsWith('/api/bots/effort-test'));
      await page.keyboard.press('Control+Shift+Slash'); await cycled; await settle();
      await page.waitForFunction(() => document.querySelector('.model-pill__effort')?.textContent === 'High');
      assert.equal(patches.length, count + 1);
      assert.deepEqual(patches.at(-1), { model: `${provider}/primary`, effort: 'high', fast: false });
      // Missing provider defaults must not invent a level or keep a stale animation.
      defaultKnown = false; await setBot({ model: null }); await page.evaluate(() => window.refreshCatalog());
      await page.locator('.model-pill__effort').getByText('Default', { exact: true }).waitFor();
      assert.equal(await page.locator('.composer__glow').count(), 0);
      defaultKnown = true; defaultAvailable = false; await page.evaluate(() => window.refreshCatalog());
      await open(); assert.equal(await page.getByRole('button', { name: 'Effort', exact: true }).count(), 0);
      await page.getByRole('button', { name: `Effort for ${provider === 'claude' ? 'Opus 5.5' : 'GPT-6.1 Sol'}`, exact: true }).click();
      await choose('High'); await checkEffort('high', '9s');
      defaultAvailable = true;
      await open(); await page.getByRole('searchbox', { name: 'Search models', exact: true }).fill('Limited');
      await page.getByRole('button', { name: 'Effort for Limited effort model', exact: true }).click();
      assert.equal(await options().count(), 2); await choose('Low'); await checkEffort('low', '18s');
      assert.equal(patches.at(-1).model, `${provider}/limited`, 'Search-result effort selects its model too');
      // Unavailable explicit models never silently become the default.
      await setBot({ model: `${provider}/removed` }); await page.evaluate(() => window.refreshCatalog());
      await open(); assert.equal(await page.getByRole('button', { name: 'Effort', exact: true }).count(), 0);
      await page.keyboard.press('Escape');
      // Take the original Paper flyout/sheet with this provider's highest actual effort.
      await setBot({ model: `${provider}/primary`, effort: provider === 'claude' ? 'max' : 'xhigh' });
      await checkEffort(provider === 'claude' ? 'max' : 'xhigh', '6s');
      assert.equal(await page.locator('.model-pill.is-ultracode').count(), 1);
      await open();
      assert.equal(await page.locator('.mm-item__value.is-ultracode').count(), 1);
      await page.getByRole('button', { name: 'Effort', exact: true }).click();
      assert.equal(await page.locator('.mm-effort.is-ultracode[aria-selected="true"]').count(), 1);
      assert.match(await options().filter({ hasText: /^Medium/ }).innerText(), /Default/);
      await page.mouse.move(8, 8);
      await page.locator('.mm-wrap').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (width < 760) assert.ok((await options().first().boundingBox()).height >= 44);
      await page.screenshot({ path: `.context/cli-effort/${provider}-${width}-${theme}.png` });
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    }
    // Reduced motion keeps the selected state but removes continuous motion and the selection flare.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setBot({ model: 'claude/primary', effort: 'high' });
    for (const selector of ['.composer', '.composer__glow', '.activity-line__mark', '.activity-line .shimmer']) {
      assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).animationName), 'none', selector);
    }
    // A saved API ultracode alias uses the real top level, without a duplicate option.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    source = 'openrouter'; await setBot({ model: 'api/primary', effort: 'ultracode' }); await page.evaluate(() => window.refreshCatalog());
    await checkEffort('xhigh', '6s');
    await page.locator('.model-pill__effort').getByText('Xhigh', { exact: true }).waitFor();
    await open(); await page.getByRole('button', { name: 'Effort', exact: true }).click();
    assert.deepEqual(await page.locator('.mm-effort__label').allTextContents(), ['Xhigh', 'High', 'Medium', 'Low']);
    assert.equal(await page.locator('.mm-effort.is-ultracode').count(), 1);
    assert.match(await page.locator('.mm-effort.is-ultracode').innerText(), /^Xhigh/);
    await choose('Xhigh'); await checkEffort('xhigh', '6s');
    assert.deepEqual(patches.at(-1), { model: 'api/primary', effort: 'xhigh' });
    for (const model of apiModels) {
      await setBot({ model: model.id, effort: 'ultracode' });
      await checkEffort(model.efforts.at(-1), '6s');
      await open();
      assert.equal(await page.locator('.mm-item__value.is-ultracode').count(), 1);
      await page.getByRole('button', { name: 'Effort', exact: true }).click();
      const labels = [...model.efforts].reverse().map(e => e[0].toUpperCase() + e.slice(1));
      assert.deepEqual(await page.locator('.mm-effort__label').allTextContents(), labels);
      assert.equal(await page.locator('.mm-effort.is-ultracode[aria-selected="true"]').count(), 1);
      const defaultLevel = model.defaultEffort ?? (model.author === 'anthropic' ? 'medium' : 'high');
      const defaultLabel = defaultLevel[0].toUpperCase() + defaultLevel.slice(1);
      assert.match(await options().filter({ hasText: new RegExp(`^${defaultLabel}`) }).innerText(), /Default/);
      await page.locator('.mm-wrap').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
      if (model.id === 'google/gemini-4-argon') await page.screenshot({ path: `.context/cli-effort/argon-${width}-${theme}.png` });
      await choose(labels[0]);
      assert.equal(patches.at(-1).effort, model.efforts.at(-1));
      assert.equal(await page.locator('.model-pill.is-ultracode').count(), 1);
      // Settings uses the same real names, default marker and selected value.
      const settingsCatalog = page.waitForResponse(r => new URL(r.url()).pathname === '/api/models');
      await page.evaluate(() => window.openSettings());
      await settingsCatalog;
      const settingsEfforts = page.getByRole('radiogroup', { name: 'Thinking effort', exact: true });
      const selectedLabel = labels[0] + (labels[0] === defaultLabel ? ' (default)' : '');
      await settingsEfforts.getByRole('radio', { name: selectedLabel, exact: true, checked: true }).waitFor();
      assert.deepEqual(await settingsEfforts.getByRole('radio').allTextContents(), labels.map(label => label === defaultLabel ? `${label} (default)` : label));
      assert.equal(await settingsEfforts.getByRole('radio', { checked: true }).innerText(), selectedLabel);
      await page.evaluate(() => window.closeSettings());
    }
    // Switching models persists a supported real level in API billing too.
    await setBot({ model: 'anthropic/claude-opus-5.5', effort: 'max' });
    await open();
    const switched = page.waitForResponse(r => r.url().endsWith('/api/bots/effort-test'));
    await page.locator('.mm-row__main').filter({ hasText: 'Gemini 4 Argon' }).click(); await switched;
    assert.deepEqual(patches.at(-1), { model: 'google/gemini-4-argon', effort: 'high' });
    await checkEffort('high', '6s');

    // Choosing effort for an implicit CLI default must materialize its model in the saved PATCH.
    for (const provider of ['codex', 'claude']) for (const oldModel of [null, 'api/old']) {
      source = provider; await setBot({ model: oldModel, effort: 'ultracode' }); await page.evaluate(() => window.refreshCatalog());
      await page.evaluate(() => window.openSettings());
      const settingsEfforts = page.getByRole('radiogroup', { name: 'Thinking effort', exact: true });
      await settingsEfforts.getByRole('radio', { name: 'Medium (default)', exact: true, checked: true }).waitFor();
      await settingsEfforts.getByRole('radio', { name: 'Low', exact: true }).click();
      await settingsEfforts.getByRole('radio', { name: 'Low', exact: true, checked: true }).waitFor();
      const saved = page.waitForResponse(r => r.url().endsWith('/api/bots/effort-test'));
      await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await saved;
      assert.deepEqual(patches.at(-1), { effort: 'low', model: `${provider}/primary` });
      await page.getByText('Saved', { exact: true }).waitFor();
      await page.evaluate(() => window.closeSettings());
      await checkEffort('low', '18s');
    }
    source = 'openrouter'; await page.evaluate(() => window.refreshCatalog());
    await setBot({ model: 'api/plain' });
    assert.equal(await page.locator('.composer__glow').count(), 0);
    assert.equal(await page.locator('.model-pill__effort').count(), 0);
    assert.deepEqual(errors, []);
    await page.close(); console.log(`PASS ${width}px ${theme}: both CLI defaults, per-model selection/PATCH, keyboard, failed-save rollback, missing metadata, effort motion, reduced motion, API compatibility`);
  }
} catch (error) { console.error(logs.slice(-2000)); throw error; }
finally { await browser?.close(); vite.kill(); await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve)); }
