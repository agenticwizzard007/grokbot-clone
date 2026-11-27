// Production components, isolated browser fixtures and local Paper references.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { composerGeometry, settleComposer } from './composer-layout-helpers.mjs';
import { readableWords } from './paper-label-geometry.mjs';
import { boxFullyVisible } from './ui-box-assertions.mjs';

const baseline = process.env.PAPER_BASELINE === '1';
const root = path.resolve(baseline ? '.context/main-baseline/web' : 'web');
const evidence = baseline ? '.context/paper-baseline' : 'docs/design/paper/build/pb-a';
await mkdir(evidence, { recursive: true });
await mkdir('.context/paper-reference', { recursive: true });
const vite = await preview({ root, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [], words = [];
const model = (id, short, billing = 'plan') => ({ id, short, name: short, author: 'anthropic', billing, vision: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' });
let lastPage;
try {
  for (const width of baseline ? [390, 1280] : [320, 390, 500, 768, 1280]) for (const theme of baseline ? ['light'] : ['light', 'dark']) {
    const height = width <= 480 ? 844 : 900;
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height }); lastPage = page;
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    const bot = fixture.bots[0]; bot.onboarding = { status: 'active', revision: 1 }; bot.model = 'claude/sonnet';
    const models = [model(bot.model, 'Sonnet 4.5'), model('claude/opus', 'Opus 4.1')];
    fixture.respond = ({ path, method, request }) => {
      if (path === '/api/models') return { json: { provider: 'claude-cli', billing: 'plan', plan: 'max', defaultModel: bot.model, models, favourites: models.map(m => m.id) } };
      if (path === '/api/cli') return { json: { selected: 'claude', connected: true, providers: { claude: { installed: true, authenticated: true, subscription: true }, codex: { installed: true, authenticated: false, subscription: false } } } };
      if (path === `/api/bots/${bot.id}` && method === 'PATCH') { Object.assign(bot, request.postDataJSON()); return { json: { bot } }; }
      return null;
    };
    await page.goto(`${origin}/#bot/${bot.id}`);
    const input = page.locator('.composer__input'), pill = page.locator('.model-pill');
    await pill.locator('svg[data-provider="claude"]').waitFor();
    await page.locator('.model-pill[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await settleComposer(page);
    const count = async scope => (await scope.innerText()).match(/[\p{L}\p{N}]+(?:[.'-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    const composerWords = await count(page.locator('.composer-area'));
    const closedMainWords = await count(page.locator('.chat'));
    if (!baseline) {
      assert.equal(await page.locator('.composer__note').innerText(), 'External actions ask first.');
      assert.ok(composerWords <= (width <= 480 ? 6 : 8), 'composer meets the Paper copy budget');
    }
    if (!baseline) {
      const geometry = await composerGeometry(page);
      assert.equal(geometry.composer.height, width <= 480 ? 84 : 52);
      assert.equal(geometry.controls[1].row, width <= 480 ? '2' : '1');
      assert.ok((width <= 480 ? ['Sonnet'] : ['Sonnet', 'Sonnet 4.5']).includes(await pill.locator('.model-pill__name').innerText()));
      await readableWords(page.locator('.composer-area'));
      await boxFullyVisible(pill.locator('.provider-icon'), { width: 16, height: 16 });
      assert.equal(await pill.locator('.provider-icon').evaluate(el => getComputedStyle(el).color), 'rgb(217, 119, 87)');
      for (const [slug, text, lines] of [['composer-empty', '', 1], ['composer-typing', 'What are', 1], ['composer-three-lines', 'First line\nSecond line\nThird line', 3], ['composer-six-lines', 'One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight', 6]]) {
        await input.fill(text); const g = await composerGeometry(page);
        assert.equal(g.composer.height, (width <= 480 ? 84 : 52) + 24 * (lines - 1));
        if (lines === 6) { assert.equal(g.clientHeight, 144); assert.equal(g.overflow, 'auto'); }
        if ([320, 390, 1280].includes(width)) await page.screenshot({ path: `${evidence}/${slug}-${width}-${theme}.png` });
      }
      await input.fill(''); await settleComposer(page);
    }
    await pill.click();
    const picker = page.locator('.model-menu'); await picker.waitFor();
    await picker.locator('.mm-row').first().waitFor();
    words.push({ width, theme, composer: composerWords, picker: await count(picker), closedMain: closedMainWords, openMain: await count(page.locator('.chat')), pickerText: await picker.innerText() });
    if (!baseline) assert.ok(await count(picker) <= (width <= 480 ? 23 : 20), 'picker meets the Paper copy budget');
    if (!baseline) {
      assert.deepEqual(await picker.locator('.mm-group h3').allTextContents(), ['Your plans', 'API billing']);
      assert.deepEqual(await picker.locator('.mm-effort__label').allTextContents(), ['Low', 'Medium', 'High']);
      assert.equal(await picker.locator('[role="radio"][aria-checked="true"]').innerText(), 'Medium');
      await readableWords(picker);
      for (const mark of await picker.locator('svg.provider-icon').all()) await boxFullyVisible(mark, { width: 16, height: 16 });
      assert.equal(await picker.evaluate(el => el.classList.contains('is-sheet')), width <= 480);
      if (width > 480) assert.equal((await picker.boundingBox()).width, 340);
      else {
        assert.equal(await picker.getByRole('heading', { name: 'Model and effort' }).isVisible(), true);
        assert.equal(await picker.locator('.mm-grabber').isVisible(), true);
        assert.ok(Math.abs((await picker.boundingBox()).y + (await picker.boundingBox()).height - height) < 1);
      }
      if ([320, 390, 1280].includes(width)) await page.screenshot({ path: `${evidence}/picker-open-${width}-${theme}.png` });
      await picker.getByRole('button', { name: 'Usage', exact: true }).click();
      await picker.getByRole('heading', { name: 'Claude Max plan', exact: true }).waitFor();
      await readableWords(picker);
      assert.ok(await count(picker) <= 20, 'usage detail stays concise');
      await picker.getByRole('button', { name: 'Back to models', exact: true }).click();
      await picker.getByRole('button', { name: 'Manage plans', exact: true }).click();
      await picker.getByRole('status').filter({ hasText: 'In use' }).waitFor();
      await readableWords(picker);
      assert.ok(await count(picker) <= 15, 'plan detail stays concise');
      await picker.getByRole('button', { name: 'Back to models', exact: true }).click();
      await picker.getByRole('radio', { name: 'High', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.mm-effort[aria-checked="true"]')?.textContent === 'High');
      assert.equal(writes.at(-1)?.body.effort, 'high');
      // More supported levels still wrap as whole segments.
      models[0].efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      models.push(model('claude/default-recommended', 'Default (recommended)'));
      await picker.getByRole('button', { name: 'Close model picker' }).click();
      await picker.waitFor({ state: 'hidden' });
      assert.equal(await pill.evaluate(el => document.activeElement === el), true);
      await pill.click(); await picker.getByText('Default (recommended)', { exact: true }).waitFor();
      await readableWords(picker);
      await page.keyboard.press('Escape'); await picker.waitFor({ state: 'hidden' });
      assert.equal(await pill.evaluate(el => document.activeElement === el), true);
      if (width <= 480) {
        const url = page.url();
        await pill.click(); await picker.waitFor();
        await page.goBack(); await picker.waitFor({ state: 'hidden' });
        assert.equal(page.url(), url);
        assert.equal(await pill.evaluate(el => document.activeElement === el), true);
        await pill.click(); await picker.waitFor();
        await picker.getByRole('button', { name: 'Manage API keys' }).click();
        await page.waitForURL('**/#settings/keys');
      }
      results.push({ width, theme });
    }
    assert.deepEqual(errors, []);
    await page.context().close();
    console.log(`PASS Paper foundation ${width} ${theme}`);
  }
  await writeFile(`${evidence}/word-counts.json`, JSON.stringify(words, null, 2) + '\n');
  if (!baseline) {
    // Keep original artboard screenshots local. Their surrounding shell belongs
    // to other streams; the committed screenshots show the implemented surfaces.
    const reference = await browser.newPage();
    for (const slug of ['tokens', 'chat-rest', 'chat-typing', 'chat-multiline', 'chat-picker']) for (const size of ['m', 'd']) for (const theme of ['l', 'd']) {
      await reference.setViewportSize({ width: size === 'm' ? 390 : 1280, height: size === 'm' ? 844 : 900 });
      await reference.goto(`file:///tmp/paper-html/${slug}-${size}-${theme}.html`);
      await reference.locator('#artboard').screenshot({ path: `.context/paper-reference/${slug}-${size}-${theme}.png` });
    }
    const comparison = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    const { page: actual, fixture } = await fixturePage(browser);
    const bot = fixture.bots[0]; bot.onboarding = { status: 'active', revision: 1 }; bot.model = 'claude/sonnet';
    fixture.respond = ({ path }) => path === '/api/models' ? { json: { provider: 'claude-cli', billing: 'plan', plan: 'max', defaultModel: bot.model, models: [model(bot.model, 'Sonnet 4.5')], favourites: [bot.model] } } : null;
    for (const width of [320, 390, 1280]) for (const theme of ['light', 'dark']) {
      await actual.setViewportSize({ width, height: 900 });
      await actual.goto(origin);
      await actual.evaluate(theme => localStorage.setItem('swarm.theme', theme), theme);
      await actual.reload();
      await actual.goto(`${origin}/#bot/${bot.id}`);
      await actual.locator('.model-pill[aria-busy="false"]').waitFor();
      await actual.evaluate(() => document.fonts.ready); await settleComposer(actual);
      const actualComposer = actual.locator('.composer');
      const actualStyle = await actualComposer.evaluate(el => { const s = getComputedStyle(el); return { background: s.backgroundColor, border: s.borderTopColor, radius: s.borderRadius }; });
      const refSize = width <= 480 ? 'm' : 'd';
      await reference.goto(`file:///tmp/paper-html/chat-rest-${refSize}-${theme === 'light' ? 'l' : 'd'}.html`);
      const referenceComposer = reference.locator(`[layer-name="${width <= 480 ? 'Composer (phone)' : 'Composer'}"]`);
      const refStyle = await referenceComposer.evaluate(el => { const s = getComputedStyle(el); return { background: s.backgroundColor, border: s.borderTopColor, radius: s.borderRadius }; });
      assert.deepEqual(actualStyle, refStyle, 'composer colors and radius match the exact Paper reference');
      const actualShot = await actualComposer.screenshot(), refShot = await referenceComposer.screenshot();
      await comparison.setContent(`<html><body style="margin:0;padding:24px;background:#e4e6e9;font:16px system-ui"><h1 style="font-size:20px">Composer: ${width}px ${theme}</h1><div style="display:flex;align-items:flex-start;gap:24px"><section><h2 style="font-size:16px">Paper reference</h2><img src="data:image/png;base64,${refShot.toString('base64')}"></section><section><h2 style="font-size:16px">Built app</h2><img src="data:image/png;base64,${actualShot.toString('base64')}"></section></div><p>52px desktop and 84px phone follow the binding height rule.</p></body></html>`);
      await comparison.locator('body').screenshot({ path: `${evidence}/comparison-${width}-${theme}.png` });
    }
    await actual.context().close(); await comparison.close();
    await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2) + '\n');
  }
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: '.context/paper-foundation-failure.png' });
  throw error;
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
