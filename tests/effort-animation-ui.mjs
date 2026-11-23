// Real composer and production CSS cascade, with local fixture data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const models = [
  { id: 'anthropic/claude-opus-5.5', short: 'Opus 5.5', author: 'anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'openai/gpt-5.5', short: 'GPT-5.5', author: 'openai', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'google/gemini-4-argon', short: 'Gemini 4 Argon', author: 'google', efforts: ['low', 'medium', 'high'] },
].map(model => ({ ...model, name: model.short, defaultEffort: 'medium', billing: 'api', reasoning: true, vision: true, context: 0 }));
const catalog = { provider: 'openrouter', billing: 'api', models, favourites: models.map(model => model.id), defaultModel: models[0].id, canFast: false };
const bot = { id: 'effort-animation-fixture', name: 'Test bot', label: '', description: '', instructions: '', mode: 'personal', model: models[0].id, effort: 'max', fast: false };
// Load shared entry styles before authenticated work styles, including Paper overrides.
const styleSources = await Promise.all(['main.tsx', 'AuthenticatedShell.tsx'].map(file => readFile(`web/src/${file}`, 'utf8')));
const styles = styleSources.flatMap(source => [...source.matchAll(/import '([^']+\.css)';/g)])
  .map(([, path]) => `import '/src/${path.slice(2)}';`).join('\n');
const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'pipe' });
let logs = '', browser;
vite.stdout.on('data', data => logs += data); vite.stderr.on('data', data => logs += data);
await mkdir('.context/effort-animation', { recursive: true });

async function assertMotion(locator, property) {
  const label = locator.toString();
  const motion = await locator.evaluate(async el => {
    const animations = el.getAnimations();
    const before = animations.map(animation => animation.currentTime);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return animations.map((animation, i) => ({
      state: animation.playState, advanced: animation.currentTime > before[i],
      duration: animation.effect.getTiming().duration, iterations: animation.effect.getTiming().iterations === Infinity,
      frames: animation.effect.getKeyframes().length,
    }));
  });
  assert.ok(motion.length > 0, `${label} needs a real animation`);
  for (const animation of motion) {
    assert.equal(animation.state, 'running', label);
    assert.equal(animation.advanced, true, `${label} must advance over real frames`);
    assert.ok(animation.duration >= 1000 && animation.duration <= 10000, `${label} must have a visible duration`);
    assert.equal(animation.iterations, true, `${label} must keep moving`);
    assert.ok(animation.frames >= 2, `${label} needs keyframes`);
  }
  // Freeze the other surfaces so their pixels cannot hide a static ring or glow.
  await locator.page().evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation instanceof CSSAnimation && animation.effect.getTiming().iterations === Infinity) animation.pause();
    }
  });
  const frame = async time => {
    const value = await locator.evaluate(async (el, { time, property }) => {
      for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime = time; }
      await new Promise(resolve => requestAnimationFrame(resolve));
      return getComputedStyle(el).getPropertyValue(property);
    }, { time, property });
    return { value, pixels: await locator.screenshot() };
  };
  const start = await frame(0), later = await frame(1200);
  assert.notEqual(start.value, later.value, `${label}: ${property} must change`);
  assert.notDeepEqual(start.pixels, later.pixels, `${label} must visibly repaint`);
  await locator.page().evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation instanceof CSSAnimation && animation.effect.getTiming().iterations === Infinity) animation.play();
    }
  });
}

async function assertStatic(locator) {
  assert.ok(await locator.count() > 0, `${locator} must exist`);
  for (const element of await locator.all()) {
    // Ordinary focus/hover border transitions are separate from effort keyframes.
    const state = await element.evaluate(el => ({ name: getComputedStyle(el).animationName, count: el.getAnimations().filter(animation => animation instanceof CSSAnimation).length }));
    assert.deepEqual(state, { name: 'none', count: 0 }, `${element} must not animate`);
  }
}

try {
  for (let i = 0; i < 100; i++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [390, 768, 1280, 1440]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/models' ? catalog : {} }));
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import { Composer } from '/src/components/Composer.tsx';
import { useStore } from '/src/store.ts';
${styles}
document.documentElement.dataset.theme = ${JSON.stringify(theme)};
useStore.setState({user:{id:'effort-fixture'},mobile:innerWidth<760,mobilePane:'chat',selectedBotId:${JSON.stringify(bot.id)},bots:[${JSON.stringify(bot)}]});
window.selectEffort = (model, effort) => useStore.setState({bots:[{...${JSON.stringify(bot)},model,effort}]});
function Harness() {
  const bot = useStore(state => state.bots[0]);
  return React.createElement('div', {className:'app',style:{height:'100dvh',padding:'24px 16px',display:'flex',flexDirection:'column',justifyContent:'flex-end'}}, React.createElement(Composer,{bot,running:false}));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
    await page.goto(origin);
    await page.locator('.model-pill.is-ultracode').waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const model of models) {
      const top = model.efforts.at(-1);
      await page.evaluate(({ id, top }) => window.selectEffort(id, top), { id: model.id, top });
      await page.waitForFunction(top => document.querySelector('.composer-shell.is-top-effort')?.dataset.effort === top && !document.querySelector('.composer-shell.is-flaring'), top);
      assert.equal(await page.locator('.model-pill.is-ultracode').count(), 1);
      assert.equal(await page.locator('.composer.is-ultracode').count(), 1);
      assert.equal(await page.locator('.composer').evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)', 'The production border must reveal the rotating gradient');
      await assertMotion(page.locator('.model-pill__effort'), 'background-position');
      await assertMotion(page.locator('.composer'), '--uc-angle');
      await assertMotion(page.locator('.composer__glow'), 'opacity');
      await page.locator('.model-pill').click();
      await page.locator('.mm-item__value.is-ultracode').waitFor();
      await assertMotion(page.locator('.mm-item__value.is-ultracode'), 'background-position');
      await assertMotion(page.locator('.mm-row__effort .uc-text'), 'background-position');
      await page.getByRole('button', { name: 'Effort', exact: true }).click();
      const selected = page.locator('.mm-effort.is-ultracode[aria-selected="true"] .mm-effort__label');
      await selected.waitFor();
      await assertMotion(selected, 'background-position');
      await assertStatic(page.locator('.mm-effort:not(.is-ultracode) .mm-effort__label'));
      await page.screenshot({ path: `.context/effort-animation/${top}-${width}-${theme}.png` });

      // Switching the OS preference immediately removes both continuous and flare animations.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      for (const selector of ['.composer', '.composer__glow', '.model-pill__effort', '.mm-effort__label']) await assertStatic(page.locator(selector));
      if (width > 760) for (const selector of ['.mm-item__value.is-ultracode', '.mm-row__effort .uc-text']) await assertStatic(page.locator(selector));
      assert.equal(await page.locator('.model-pill.is-ultracode').count(), 1, 'Reduced motion retains the top-level treatment');
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      // A selection change under reduced motion must not start the one-shot glow flare.
      await page.evaluate(id => window.selectEffort(id, 'low'), model.id);
      await page.waitForFunction(() => document.querySelector('.composer-shell')?.dataset.effort === 'low');
      await page.evaluate(({ id, top }) => window.selectEffort(id, top), { id: model.id, top });
      await page.waitForFunction(top => document.querySelector('.composer-shell')?.dataset.effort === top, top);
      await assertStatic(page.locator('.composer__glow'));
      await page.emulateMedia({ reducedMotion: 'no-preference' });

      // Lower selected levels have no motion, including immediately after a top-level selection.
      await page.evaluate(id => window.selectEffort(id, 'low'), model.id);
      await page.waitForFunction(() => document.querySelector('.composer-shell')?.dataset.effort === 'low');
      assert.equal(await page.locator('.is-top-effort, .model-pill.is-ultracode, .composer.is-ultracode').count(), 0);
      for (const selector of ['.composer', '.composer__glow', '.model-pill__effort']) await assertStatic(page.locator(selector));
      await page.locator('.model-pill').click();
      await page.locator('.mm-item__value:not(.is-ultracode)').waitFor();
      await assertStatic(page.locator('.mm-item__value:not(.is-ultracode)'));
      await page.getByRole('button', { name: 'Effort', exact: true }).click();
      await assertStatic(page.locator('.mm-effort[aria-selected="true"] .mm-effort__label'));
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      // The same high/xhigh IDs must stay static on models with a higher level.
      for (const lower of model.efforts.slice(0, -1).filter(effort => effort !== 'low')) {
        await page.evaluate(({ id, effort }) => window.selectEffort(id, effort), { id: model.id, effort: lower });
        await page.waitForFunction(effort => document.querySelector('.composer-shell')?.dataset.effort === effort, lower);
        for (const selector of ['.composer', '.model-pill__effort']) await assertStatic(page.locator(selector));
        if (lower === 'none') assert.equal(await page.locator('.composer__glow').count(), 0);
        else await assertStatic(page.locator('.composer__glow'));
      }
      console.log(`PASS ${width}px ${theme} ${model.id}: stored ${top}, painted motion, reduced motion, static lower levels`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} catch (error) { console.error(logs.slice(-2000)); throw error; }
finally { await browser?.close(); vite.kill(); await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve)); }
