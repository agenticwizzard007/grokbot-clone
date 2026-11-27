import assert from 'node:assert/strict';
import path from 'node:path';
import { runIntegrationDemo } from './integration-routes-ui.mjs';

await runIntegrationDemo({ settingsFlow: async ({ page, width, server, check, alignment, openSidebar, screenshots, evidence }) => {
  const settingsNav = page.getByRole('navigation', { name: 'Settings sections', exact: true });
  const back = page.getByRole('button', { name: 'Back', exact: true });
  const policy = page.getByLabel('Agent handoffs', { exact: true });
  const enabled = page.getByRole('switch', { name: 'Enable handoffs and loops', exact: true });
  const read = async route => { const response = await page.request.get(server.base + '/api' + route); assert.equal(response.status(), 200); return response.json(); };
  const save = async (route, action) => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api' + route && r.request().method() === 'PUT');
    await action(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.querySelector('.ho-settings')?.getAttribute('aria-busy') === 'false');
  };
  const pickSettings = async label => {
    if (width === 390 && !await settingsNav.isVisible()) await back.click();
    await settingsNav.getByRole('button', { name: label, exact: true }).click();
  };
  await openSidebar();
  await page.locator('.sidebar').getByRole('button', { name: 'Account & settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await settingsNav.getByRole('button', { name: 'Agents', exact: true }).click();
  await policy.waitFor();
  assert.equal(new URL(page.url()).hash, '#settings/agents');
  await alignment(); check('Settings menu opens Agents with shared navigation and one phone Back');

  for (const value of ['links_only', 'off', 'team']) {
    await save('/handoff-settings', () => policy.selectOption(value));
    assert.equal((await read('/handoff-settings')).settings.agentHandoffs, value);
  }
  check('Team, Links only and Off persist through the real settings API');
  await save('/handoff-settings', () => enabled.click());
  assert.equal((await read('/handoff-settings')).settings.enabled, false);
  await page.reload(); await enabled.waitFor();
  assert.equal(await enabled.getAttribute('aria-checked'), 'false');
  assert.equal(await page.getByRole('button', { name: 'Open Loops', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Add a standing link', exact: true }).count(), 0);
  await save('/handoff-settings', () => enabled.click());
  assert.equal((await read('/handoff-settings')).settings.enabled, true);
  check('Disabled handoffs can be re-enabled after a fresh load');

  await page.getByLabel('Links from', { exact: true }).selectOption(server.fixture.bot.id);
  const mode = page.getByLabel('Handoff mode for Research', { exact: true });
  await mode.waitFor();
  const linksPath = '/handoff-links?botId=' + encodeURIComponent(server.fixture.bot.id);
  const before = (await read(linksPath)).links[0];
  for (const value of ['off', 'auto', 'suggest']) {
    await save('/handoff-links', () => mode.selectOption(value));
    const after = (await read(linksPath)).links[0];
    assert.equal(after.mode, value); assert.equal(after.id, before.id);
    assert.equal(after.template, before.template); assert.equal(after.trigger, before.trigger);
  }
  const auto = page.getByLabel('Auto approve loops started by agents with Research', { exact: true });
  assert.equal(await auto.isChecked(), false);
  await save('/handoff-links', () => auto.click());
  assert.equal(await auto.isChecked(), true);
  assert.equal((await read(linksPath)).links[0].autoApproveLoops, true);
  await page.reload(); await page.getByLabel('Links from', { exact: true }).selectOption(server.fixture.bot.id);
  await auto.waitFor(); assert.equal(await auto.isChecked(), true);
  await save('/handoff-links', () => auto.click());
  assert.equal(await auto.isChecked(), false);
  check('Standing links persist Off, Automatic, Suggest and exact-pair loop auto-approval');

  // A failed save keeps the prior policy and offers an honest inline error.
  await page.route('**/api/handoff-settings', async route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: 'Fixture settings unavailable. Try again.' } }) : route.continue());
  await policy.selectOption('links_only');
  await page.getByRole('alert').filter({ hasText: 'Fixture settings unavailable' }).waitFor();
  assert.equal(await policy.inputValue(), 'team');
  await page.unroute('**/api/handoff-settings');
  await save('/handoff-settings', () => policy.selectOption('links_only'));
  await save('/handoff-settings', () => policy.selectOption('team'));
  check('Failed settings save stays inline and can be retried without changing the saved policy');

  for (const text of ['Starts at 4. Choose 1 to 10 passes.', 'Starts at 30 minutes. Choose 5 to 240 minutes.', 'Starts at 10 minutes. Choose 1 to 30 minutes.', 'Up to 3 running loops and 20 new loops per day.']) {
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
  }
  await alignment();
  const screenshot = path.join(evidence, `settings-agents-${width}.png`);
  await page.setViewportSize({ width, height: Math.min(4000, await page.locator('.app-settings__page').evaluate(el => el.scrollHeight) + 160) });
  await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
  await page.setViewportSize({ width, height: 1000 });
  check('Loop defaults and hard bounds use readable Paper rows');

  await page.getByRole('button', { name: 'Open Loops', exact: true }).click();
  await page.getByRole('button', { name: 'New loop', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New loop', exact: true });
  const passes = sheet.getByLabel('Up to passes', { exact: true });
  assert.equal(await passes.inputValue(), '4'); assert.equal(await passes.getAttribute('min'), '1'); assert.equal(await passes.getAttribute('max'), '10');
  await sheet.locator('summary').filter({ hasText: 'Advanced' }).click();
  for (const [label, value, min, max] of [['Minutes', '30', '5', '240'], ['Step timeout in minutes', '10', '1', '30']]) {
    const field = sheet.getByLabel(label, { exact: true });
    assert.equal(await field.inputValue(), value); assert.equal(await field.getAttribute('min'), min); assert.equal(await field.getAttribute('max'), max);
  }
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goBack(); await policy.waitFor(); await alignment();
  check('Agents opens the real loop builder with matching defaults and bounds, then returns');

  await page.getByRole('button', { name: 'Add a standing link', exact: true }).click();
  const linkSheet = page.getByRole('dialog', { name: 'Handoff links', exact: true });
  await linkSheet.waitFor(); await page.keyboard.press('Escape'); await linkSheet.waitFor({ state: 'hidden' });
  await page.goBack(); await policy.waitFor();
  check('Standing-link entry opens the real Flow editor and returns to Agents');

  await pickSettings('Layout');
  await page.getByRole('region', { name: 'Dashboards', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New dashboard', exact: true }).count(), 1);
  await pickSettings('Agents'); await policy.waitFor(); await alignment();
  await page.reload(); await policy.waitFor(); await alignment();
  assert.equal(new URL(page.url()).hash, '#settings/agents');
  check('Layout dashboard manager and Agents share phone and desktop navigation; cold Agents works');
} });
