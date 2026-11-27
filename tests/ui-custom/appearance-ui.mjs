import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { appearanceFixture, appearanceContext, saved, waitForSaved, reset } from './appearance-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';

const out = '.context/ui-custom/layout'; fs.mkdirSync(out, { recursive: true });
const fixture = await appearanceFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let passed = 0;
const pass = name => { passed++; console.log(`PASS UC-G ${name}`); };
try {
  for (const width of (process.env.UC_G_WIDTHS || '320,390,500,768,1280').split(',').map(Number)) for (const theme of ['light', 'dark']) {
    const context = await appearanceContext(browser, fixture, width, theme);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await page.goto('/#settings/appearance'); const screen = page.locator('.appearance-settings'); await screen.waitFor();
    await page.waitForFunction(() => !document.querySelector('.appearance-fields')?.disabled);
    await reset(page); await page.reload(); await screen.waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), [], `${width} ${theme}`);
    await page.screenshot({ path: `${out}/${width}-${theme}.png` }); await readableWords(screen); pass(`geometry and complete labels ${width} ${theme}`);
    const controls = await screen.locator('button:enabled, input:not([type=file]):enabled, select:enabled').all();
    for (const control of controls) {
      await control.focus(); assert.equal(await control.evaluate(el => document.activeElement === el), true);
      assert.ok(await control.getAttribute('aria-label') || (await control.innerText()).trim() || await control.evaluate(el => el.labels?.length), 'Every control has a name');
    }
    pass(`every enabled control is focusable ${width} ${theme}`);
    if ([390, 1280].includes(width) && theme === 'light') {
      const group = screen.getByRole('radiogroup', { name: 'Width', exact: true });
      await group.getByRole('radio', { name: 'Default', exact: true }).focus(); await page.keyboard.press('ArrowRight');
      await waitForSaved(page, c => c.doc.layout.sidebar.width === 'wide', 'keyboard sidebar width');
      assert.equal(await group.getByRole('radio', { name: 'Wide', exact: true }).evaluate(el => document.activeElement === el), true, 'focus survives saving');
      await page.keyboard.press('ArrowLeft'); await waitForSaved(page, c => c.doc.layout.sidebar.width === 'default', 'restore sidebar width');
      await screen.getByRole('button', { name: 'Change Focus composer shortcut', exact: true }).click(); await page.keyboard.press('Alt+j');
      await waitForSaved(page, c => c.doc.keybindings.focusComposer === 'Alt+J', 'shortcut capture');
      await screen.getByRole('button', { name: 'Clear Focus composer shortcut', exact: true }).click(); await waitForSaved(page, c => c.doc.keybindings.focusComposer === null, 'clear shortcut');
      const visibility = screen.getByRole('switch', { name: 'Safety note', exact: true }); await visibility.focus(); await page.keyboard.press('Space');
      await waitForSaved(page, c => c.doc.components['chat.safetyNote'] === 'hide', 'visibility');
      await visibility.focus(); await page.keyboard.press('Space');
      await waitForSaved(page, c => c.doc.components['chat.safetyNote'] === 'show', 'restore visibility from the same control');
      await screen.getByLabel('Start on', { exact: true }).selectOption('tasks'); await waitForSaved(page, c => c.doc.layout.home.kind === 'tasks', 'home');
      await screen.getByLabel('Tab 4', { exact: true }).isDisabled().then(value => assert.equal(value, true));
      const agent = screen.getByRole('switch', { name: "Apply my agent's changes right away", exact: true });
      await agent.click();
      for (let i = 0; i < 50 && await agent.getAttribute('aria-checked') !== 'true'; i++) await page.waitForTimeout(50);
      assert.equal((await (await page.request.get('/api/account/preferences')).json()).uiAgentApply, 'auto');
      await agent.click();
      pass(`keyboard writes and account preference ${width}`);
      await page.goto('/#settings'); await page.getByRole('button', { name: 'Layout', exact: true }).click(); await screen.waitFor();
      await page.goBack(); assert.equal(new URL(page.url()).hash, '#settings');
      await page.goForward(); await screen.waitFor();
      await page.locator('.shell-back:visible').click(); assert.notEqual(new URL(page.url()).hash, '#settings/appearance');
      pass(`one Back and browser history ${width}`);
    }
    await context.close();
  }
  // Seed only the private local transcript, using real preview lifecycle endpoints.
  const context = await appearanceContext(browser, fixture, 390, 'light');
  const page = await context.newPage(); page.setDefaultTimeout(15000); await page.goto('/#bots'); await reset(page);
  const title = 'Weekly dashboard update '.repeat(7).trim();
  const current = await saved(page);
  const response = await page.request.post('/api/ui/patches/preview', { headers: { 'If-Match': `"${current.revision}"` }, data: { intent: title, patch: [{ op: 'add', path: '/layout/home', value: { kind: 'tasks' } }] } });
  assert.equal(response.status(), 200, await response.text()); const preview = await response.json();
  const bot = fixture.db.prepare('SELECT generation, next_seq, rev FROM bots WHERE id=?').get(fixture.fixture.bot.id);
  const body = { type: 'card', card: 'ui_preview', previewId: preview.previewId, title, lines: Array.from({ length: 6 }, (_, i) => `Layout change ${i + 1}`), moreCount: 3, warnings: [], status: 'pending' };
  fixture.db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)').run(fixture.fixture.bot.id, bot.generation, bot.next_seq, bot.rev + 1, 'card', JSON.stringify(body), Date.now());
  fixture.db.prepare('UPDATE bots SET next_seq=next_seq+1,rev=rev+1 WHERE id=?').run(fixture.fixture.bot.id);
  await page.goto(`/#bot/${fixture.fixture.bot.id}`);
  const card = page.locator('.ui-preview-card'); await card.waitFor(); await readableWords(card);
  assert.equal(await card.getByRole('button', { name: 'Apply', exact: true }).count(), 1);
  await card.getByRole('button', { name: 'Apply', exact: true }).focus(); await page.keyboard.press('Tab');
  assert.equal(await card.getByRole('button', { name: 'Discard', exact: true }).evaluate(el => document.activeElement === el), true);
  await page.keyboard.press('Enter'); await card.getByText('Discarded', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Apply', exact: true }).count(), 0);
  await page.screenshot({ path: `${out}/chat-discarded-long-title.png` }); pass('chat card wraps, orders focus, announces Discarded');
  for (const state of ['expired', 'superseded']) {
    fixture.db.prepare('UPDATE ui_previews SET status=? WHERE user_id=? AND id=?').run(state, fixture.fixture.userId, preview.previewId);
    await page.reload(); await card.getByText(state[0].toUpperCase() + state.slice(1), { exact: true }).waitFor();
    assert.equal(await card.getByRole('button').count(), 0); pass(`chat ${state} card has no mutation actions`);
  }
  await context.close();
} finally { await browser.close(); await fixture.close(); }
fs.writeFileSync(`${out}/report.json`, JSON.stringify({ passed, failed: 0 }));
console.log(`${passed} passed, 0 failed. Evidence: ${out}`);
