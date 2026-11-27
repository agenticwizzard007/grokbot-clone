// Production app, local fixtures only. Check geometry against the visible text.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { composerGeometry, assertComposerSlots, settleComposer } from './composer-layout-helpers.mjs';

const root = path.resolve(process.env.UI_WEB_ROOT || 'web');
const evidence = process.env.UI_EVIDENCE || '.context/composer-stable-layout';
await mkdir(evidence, { recursive: true });
const outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true }, plugins: [{
  name: 'local-layout-controls', enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('/voice/call.ts')) return code + '\nwindow.__voice = useVoice;';
    if (id.endsWith('/src/store.ts')) return code + '\nwindow.__store = useStore;';
  },
}] });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
let lastPage;
const samples = [
  { name: 'claude-max', provider: 'claude-cli', billing: 'plan', plan: 'max', mark: 'claude', id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { name: 'codex-plan', provider: 'codex-cli', billing: 'plan', mark: 'openai', id: 'codex/default', label: 'Codex' },
  { name: 'grok-api', provider: 'openrouter', billing: 'api', mark: 'xai', id: 'x-ai/grok-4.7', label: 'Grok 4.7' },
];
try {
  for (const width of [320, 390, 480, 500, 768, 1280]) for (const theme of ['light', 'dark']) for (const sample of samples) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    lastPage = page;
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    fixture.bots.push({ ...fixture.bots[1], id: 'fixture-room', name: 'Project room', kind: 'room', members: ['coordinator', 'research-bot'] });
    for (const bot of fixture.bots) {
      bot.onboarding = { status: 'active', revision: 1 };
      bot.model = sample.id;
    }
    fixture.respond = ({ path }) => {
      if (path === '/api/models') return { json: { ...sample, defaultModel: sample.id,
        models: sample.provider === 'codex-cli' ? [] : [{ id: sample.id, name: sample.label, short: sample.label, author: sample.mark, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', billing: sample.billing }], favourites: [] } };
      if (path === '/api/voice/end') return { json: { ok: true } };
      return null;
    };
    const bots = sample.name === 'claude-max' && [390, 1280].includes(width) ? fixture.bots : [fixture.bots[0]];
    for (const bot of bots) {
      const label = `${width}-${theme}-${sample.name}-${bot.id}`;
      await page.goto(`${origin}/#bot/${bot.id}`);
      const input = page.locator('.composer__input');
      await input.waitFor();
      await page.locator('.model-pill[aria-busy="false"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await input.focus();
      const empty = await composerGeometry(page);
      assert.equal(empty.composer.height, width <= 480 ? 84 : 52, 'approved one-line height');
      assert.ok(empty.input.width >= (width <= 480 ? width - 70 : 160), `${label}: readable field width ${empty.input.width}`);
      assert.equal(empty.controls[1].row, width <= 480 ? '2' : '1', 'chip placement follows the phone viewport breakpoint');
      const logo = page.locator(`.model-pill__provider svg[data-provider="${sample.mark}"]`);
      assert.equal(await logo.isVisible(), true, `${label}: provider logo is visible`);
      await page.waitForFunction(() => document.querySelector('.model-pill__provider svg')?.getBBox().width > 0);
      assert.equal(await logo.getAttribute('aria-hidden'), 'true', 'adjacent model text names the mark');
      assert.equal(empty.logo.width, 16); assert.equal(empty.logo.height, 16);
      const pill = await page.locator('.model-pill').boundingBox();
      assert.ok(empty.logo.x >= pill.x && empty.logo.x + 16 <= pill.x + pill.width && empty.logo.y >= pill.y && empty.logo.bottom <= pill.y + pill.height, 'whole logo fits inside the chip');
      for (const label of await page.locator('.model-pill__name, .model-pill__effort').all()) {
        assert.equal(await label.evaluate(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis'), true, 'complete chip label');
      }
      for (const control of [empty.controls[0], empty.controls[1], empty.action]) assert.ok(control.width >= 36 && control.height === 36, 'Paper 36px composer controls');
      let previous = empty, draft = '', longestLine = '', wrapped = false, capped;
      const states = {};
      const screenshot = state => page.screenshot({ path: `${evidence}/${label}-${state}.png` });
      // Native individual keys cover the reported phrase and the first wrap.
      const phrase = 'What are you working on here';
      const text = phrase + ' Please describe the next steps and the results.'.repeat(30);
      for (const key of text) {
        await input.pressSequentially(key);
        draft += key;
        const geometry = await composerGeometry(page);
        assertComposerSlots(geometry, empty, `${label} length=${draft.length}`);
        assert.equal(await input.inputValue(), draft);
        const desired = geometry.textHeight + geometry.padding;
        const expected = (width <= 480 ? 84 : 52) + Math.max(0, Math.min(6, Math.round(geometry.textHeight / 24)) - 1) * 24;
        assert.ok(Math.abs(geometry.composer.height - expected) <= 1, `${label}: grows only for visible lines at ${draft.length}: ${geometry.composer.height} vs ${expected}`);
        assert.ok(geometry.composer.height >= previous.composer.height && geometry.composer.height - previous.composer.height <= geometry.line + 1, `${label}: growth is at most one line per key`);
        if (geometry.textHeight <= geometry.line + 1) {
          longestLine = draft;
          assert.equal(geometry.composer.height, empty.composer.height, `${label}: one-line height is constant`);
          assert.equal(geometry.logo.y, empty.logo.y, `${label}: longer one-line typing does not move the logo`);
          geometry.controls.forEach((control, i) => assert.equal(control.y, empty.controls[i].y, `${label}: one-line control y`));
        } else if (!wrapped) {
          wrapped = true;
          states.wrapped = geometry;
          await screenshot('wrapped');
          // Save the longest actually single-line prefix, then resume typing.
          await input.fill(longestLine); await settleComposer(page); await screenshot('one-line-long');
          states.oneLineLong = { text: longestLine, geometry: await composerGeometry(page) };
          await input.fill(draft); await settleComposer(page);
        }
        if (draft === 'What are') { states.short = geometry; await screenshot('short'); }
        if (draft === phrase) states.reportedPhrase = geometry;
        if (geometry.scrollHeight > geometry.clientHeight + 1 && geometry.overflow === 'auto') {
          capped = geometry;
          states.maxHeight = geometry;
          await screenshot('max-height');
          break;
        }
        previous = geometry;
      }
      assert.ok(states.short && states.reportedPhrase && wrapped && capped, `${label}: all growth states covered`);
      await input.pressSequentially(' Keep the extra text inside the field.'.repeat(8));
      const overflow = await composerGeometry(page);
      assertComposerSlots(overflow, empty, `${label}: past max`);
      assert.equal(overflow.composer.height, capped.composer.height, 'composer stops growing');
      assert.ok(overflow.scrollHeight > capped.scrollHeight, 'additional lines scroll internally');
      assert.ok(await input.evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop > 0; }), 'field is scrollable');
      await input.fill('What are'); await settleComposer(page);
      await input.press('Shift+Enter');
      const newline = await composerGeometry(page);
      assertComposerSlots(newline, empty, `${label}: newline`);
      assert.equal(newline.composer.height, empty.composer.height + empty.line, 'newline adds one line');
      await input.press('Backspace');
      assert.equal((await composerGeometry(page)).composer.height, empty.composer.height, 'deleting newline restores the original height');

      // The same slots hold through connecting, in-call and the real End handler.
      for (const status of ['connecting', 'live']) {
        await input.fill('');
        await page.evaluate(({ status, botId }) => window.__voice.setState({ status, botId, callId: 'local-layout-call', startedAt: Date.now() }), { status, botId: bot.id });
        const voiceEmpty = await composerGeometry(page);
        assertComposerSlots(voiceEmpty, empty, `${label}: ${status} empty`);
        const voice = page.locator('.composer__voice');
        assert.equal(await voice.isDisabled(), status === 'connecting');
        assert.match(await voice.getAttribute('aria-label'), status === 'connecting' ? /Connecting/ : /End call/);
        for (const value of ['What are', phrase, 'First\nSecond', 'More words to wrap. '.repeat(100)]) {
          await input.fill(value);
          assertComposerSlots(await composerGeometry(page), empty, `${label}: ${status} draft`);
        }
        await screenshot(status);
      }
      await input.fill('');
      await page.locator('.composer__voice').click();
      assert.equal(await page.evaluate(() => window.__voice.getState().status), 'idle');
      assertComposerSlots(await composerGeometry(page), empty, `${label}: after End`);
      await input.fill('What are you working on here');
      assertComposerSlots(await composerGeometry(page), empty, `${label}: draft after End`);

      // Menus retain their handlers and usable targets with the smaller chip.
      await page.locator('.model-pill').click();
      await page.getByRole('dialog', { name: 'Model and effort' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Talk live', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await input.inputValue(), phrase);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      results.push({ width, theme, sample: sample.name, bot: bot.id, empty, states });
      console.log(`PASS stable composer ${label}: progressive typing, wrap, max, newline, delete, connecting, live, End, menus`);
    }
    // New-bot and search use fixed single-line inputs. Their chrome should stay
    // put even as the input scrolls horizontally through a long value.
    for (const [modal, selector, container] of [['create', 'input[placeholder="Give your Bot a name"]', '.setup-create'], ['search', '.search-modal__field input', '.search-modal__field']]) {
      await page.evaluate(modal => window.__store.getState().setModal(modal), modal);
      const field = page.locator(selector);
      await field.waitFor();
      const before = await page.locator(container).boundingBox();
      const fieldBefore = await field.boundingBox();
      await field.pressSequentially('What are you working on here and what happens next');
      await settleComposer(page);
      const after = await page.locator(container).boundingBox();
      assert.equal(after.width, before.width);
      assert.deepEqual(await field.boundingBox(), fieldBefore, `${modal}: input chrome remains fixed`);
      await page.evaluate(() => window.__store.getState().setModal(null));
    }
    // Width changes resize existing drafts without selecting a text-length mode.
    for (const [narrow, height] of [[320, 900], [360, 900], [480, 900], [760, 900], [768, 900], [1024, 900], [1280, 900], [390, 400], [1280, 400]]) {
      await page.setViewportSize({ width: narrow, height });
      await page.evaluate(() => window.__store.setState({ mobilePane: 'chat' }));
      const input = page.locator('.composer__input');
      await input.fill('What are');
      const short = await composerGeometry(page);
      await input.fill('Visible text wraps in its own field. '.repeat(50));
      assertComposerSlots(await composerGeometry(page), short, `${narrow}: resized draft`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.deepEqual(errors, []);
    assert.ok(writes.every(write => write.path === '/api/voice/end'), 'only local End calls were made');
    await page.context().close();
  }
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS ${results.length} composer layout cases with typing, voice, sibling inputs and viewport checks`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
