import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dashboardFixture, inspectAlignment } from './dashboard-fixture.mjs';
import { readableWords } from '../paper-label-geometry.mjs';

export async function runAboutYouUi(output = 'shots/polish/after') {
  const directory = path.resolve(output); fs.mkdirSync(directory, { recursive: true });
  const server = await dashboardFixture();
  server.db.prepare(`INSERT INTO account_preferences(user_id,updated_at,ui_custom_enabled,ui_adapt) VALUES(?,?,1,1)
    ON CONFLICT(user_id) DO UPDATE SET ui_custom_enabled=1,ui_adapt=1`).run(server.fixture.userId, Date.now());
  const checks = [], screenshots = [];
  const pass = name => { checks.push(name); console.log(`PASS About you: ${name}`); };
  try {
    for (const width of [320, 390, 500, 1280]) for (const theme of [390, 1280].includes(width) ? ['light', 'dark'] : ['light']) {
      server.db.prepare('DELETE FROM ui_requirements WHERE user_id=?').run(server.fixture.userId);
      server.db.prepare("DELETE FROM ui_config_history WHERE user_id=? AND kind='requirements'").run(server.fixture.userId);
      const page = await server.page(width); await page.emulateMedia({ colorScheme: theme });
      const read = async route => { const response = await page.request.get(`${server.base}/api/ui/${route}`); assert.equal(response.status(), 200); return response.json(); };
      await page.goto(`${server.base}/#settings/appearance`);
      const section = page.getByRole('region', { name: 'About you', exact: true });
      await section.getByText('Share your role and goals.', { exact: true }).waitFor();
      const capture = async name => {
        await section.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready);
        assert.equal(await section.getByRole('button').count(), 1, 'One profile action');
        assert.equal(await section.locator('input,textarea,select').count(), 0, 'The profile is compact and read-only');
        assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.doesNotMatch(await page.locator('body').innerText(), /mock|fixture|private|QA-|undefined|null|\[object/i);
        await readableWords(section);
        const style = await section.locator('.requirements-card').evaluate(card => {
          const css = getComputedStyle(card), button = card.querySelector('button');
          return { padding: css.padding, radius: css.borderTopLeftRadius, font: css.fontSize,
            buttonHeight: button.getBoundingClientRect().height, buttonFont: getComputedStyle(button).fontSize, buttonGap: getComputedStyle(button).gap,
            subtitleFont: card.querySelector('.layout-row__subtitle') ? getComputedStyle(card.querySelector('.layout-row__subtitle')).fontSize : null };
        });
        assert.equal(style.padding, '16px'); assert.equal(style.radius, '12px'); assert.equal(style.font, '14px');
        assert.ok(style.buttonHeight >= 44); assert.equal(style.buttonFont, '14px'); assert.equal(style.buttonGap, '8px');
        if (style.subtitleFont) assert.equal(style.subtitleFont, '13px');
        if (width <= 760) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
        const filename = path.join(directory, `${name}-${width}-${theme}.png`);
        await page.screenshot({ path: filename, fullPage: true }); screenshots.push(filename);
        pass(`${name} ${width} ${theme}`);
      };
      await capture('about-you-empty');
      const profile = await read('requirements'), config = await read('config');
      const response = await page.request.put(`${server.base}/api/ui/requirements`, { headers: { 'If-Match': `"${profile.revision}"` }, data: { patch: [
        { op: 'add', path: '/role', value: 'Operations lead' },
        { op: 'add', path: '/goals', value: ['Daily summary', 'Plan the launch'] },
      ] } });
      assert.equal(response.status(), 200, await response.text());
      await page.reload(); await section.getByText('Operations lead', { exact: true }).waitFor();
      await capture('about-you');
      await page.goto(`${server.base}/#settings/appearance/use`);
      await section.getByText('Operations lead', { exact: true }).waitFor();
      await capture('about-you-page');
      const saved = await read('requirements');
      const writes = [];
      page.on('request', request => { if (!['GET','HEAD'].includes(request.method()) && /\/api\/(ui\/|bots\/[^/]+\/messages)/.test(request.url())) writes.push(request.url()); });
      await section.getByRole('button', { name: 'Tell your agent', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.waitForURL(/#bot\//);
      const composer = page.locator('.composer__input'); await composer.waitFor();
      await page.waitForFunction(() => document.querySelector('.composer__input')?.value === 'Help me describe my role and goals for my dashboards: ');
      assert.equal(await composer.inputValue(), 'Help me describe my role and goals for my dashboards: ');
      assert.deepEqual((await read('config')).doc, config.doc, 'Opening the draft never changes layout');
      assert.equal((await read('requirements')).revision, saved.revision, 'Opening the draft never changes the profile');
      assert.deepEqual(writes, [], 'The action opens a draft without sending it');
      pass(`keyboard draft only ${width} ${theme}`);
      await page.context().close();
    }
  } finally {
    await server.close();
    fs.writeFileSync(path.join(directory, 'about-you-results.json'), JSON.stringify({ passed: checks.length, checks, screenshots }, null, 2));
  }
  console.log(`ABOUT YOU: ${checks.length} passed, 0 failed. ${directory}/about-you-results.json`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runAboutYouUi();
