// Local fixtures only. BEFORE=1 records the unmodified baseline without icon assertions.
import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { fixturePage, origin } from './qa-r3-work-fixture.mjs';

const phase = process.env.BEFORE ? 'before' : 'after';
const artifacts = 'tests/artifacts/settings-simplify';
await mkdir(artifacts, { recursive: true });
await mkdir('.context/settings-simplify', { recursive: true });
const sections = ['general', 'account', 'messaging', 'usage', 'learning', 'computer', 'permissions', 'apps', 'mcp', 'subscriptions', 'keys'];
const labels = ['General', 'Account', 'Messaging', 'Usage', 'Learning', 'Computer', 'Permissions', 'Models and access', 'API keys', 'Connected apps', 'MCP servers'];
const user = { id: 'fixture-owner', name: 'Alex Morgan', email: 'alex@example.test', timezone: 'UTC' };
const computer = { status: 'running', provider: 'cloudvm', screens: [], orgoId: null, error: null };
const key = { set: true, source: 'env', hint: '…test' };
const learning = { enabled: true, automaticReview: true, memoryReview: true, skillReview: true, skillApproval: true, memoryTurnInterval: 10, skillIterationInterval: 10, maxIterations: 16, maxInputTokens: 32000, auxiliaryModel: null, auxiliaryProvider: null, curatorEnabled: true, curatorIntervalHours: 168, curatorMinIdleHours: 2, curatorStaleDays: 14, curatorArchiveDays: 30, curatorConsolidate: false };
const slack = { slug: 'slack', name: 'Slack', description: 'Messages and channels for your team.', connected: true };
const report = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of [390, 1280, 1440]) {
    const { page, fixture, errors } = await fixturePage(browser, { width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(() => localStorage.setItem('swarm.theme', 'light'));
    fixture.respond = ({ path, url }) => {
      const data = {
        '/api/auth/me': { user, googleLogin: true, appleLogin: true },
        '/api/auth/sessions': { sessions: [{ id: 'fixture-session', current: true, device: 'Chrome on Linux', created_at: 1795392000000, last_seen_at: 1795392000000 }] },
        '/api/apps': { apps: [slack], connected: ['slack'], connectedApps: [slack], categories: [], total: 1 },
        '/api/apps/connections': { connections: [{ id: 'fixture-slack', toolkit: 'slack', toolkitName: 'Slack', label: 'Team workspace', status: 'ACTIVE', isDefault: true }] },
        '/api/computer': { computer },
        '/api/computer/details': { computer, screens: [{ botId: 'coordinator', screenId: 'default', lastUsedAt: 1795392000000 }], hibernation: { idleMinutes: 10 }, pairing: { paired: false }, localComputer: { enabled: false }, thisComputer: { available: false, active: false } },
        '/api/preferences': { askBeforeComputer: false },
        '/api/policies': { policies: [{ tool: 'slack.send_message', mode: 'always_allow' }] },
        '/api/learning/settings': { settings: learning, account: learning, overrides: null, revision: 1, accountRevision: 1 },
        '/api/mcp/servers': { canManage: true, servers: [{ id: 'fixture-mcp', name: 'Team tools', transport: 'http', url: 'https://fixture.invalid/mcp', enabled: true, botIds: null, requireApproval: true, oauth: false, tools: [], folders: [], headerNames: [], envNames: [] }] },
        '/api/cli': { runtime: 'server', serverLoginAvailable: true, connected: true, selected: null, providers: { claude: { installed: true, authenticated: false }, codex: { installed: true, authenticated: false } } },
        '/api/providers/openrouter': { connected: true, linked: false, active: false, selected: false, hint: '…test', source: 'manual', model: 'fixture/model', defaultModel: 'fixture/model' },
        '/api/providers/private-keys': { keys: [] },
        '/api/settings/keys': { canEdit: true, provider: { value: 'openrouter', effective: 'openrouter' }, openrouter: key, direct: key, composio: key, voice: key, model: { value: 'fixture/model' }, openrouterModel: { value: 'fixture/model' } },
        '/api/settings/models': { models: [], favourites: [] },
        '/api/messaging': { account: { phone: '+14155550142', email: user.email }, links: [{ channel: 'sms', channelName: 'SMS', status: 'connected', phone: '+14155550142' }], line: { number: '+14155550148', smsLink: 'sms:+14155550148', connectCommand: 'connect fixture' }, invites: { allowance: 2 }, prefs: { forward: 'engaged', activeBot: null, voiceReplies: 'off', ttsVoice: null }, speech: { speech: null, transcription: null, voices: [] } },
      };
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
      if (path.startsWith('/api/platform/')) return { json: { admin: false, settings: null } };
      if (path === '/api/usage') return { json: { range: { key: url.searchParams.get('range'), from: 1794787200000, to: 1795392000000 }, scope: 'me', canSeeAll: false, canSeeProvider: false, provider: 'openrouter', timezone: 'UTC', billing: { sources: [], note: 'No requests this period.' }, totals: { costUsd: 0, estimatedUsd: 0, unpricedRequests: 0, unpricedVoice: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, toolCalls: 0, voiceMinutes: 0, knownTokenRequests: 0 }, days: [], byBot: [], byModel: [], byKind: [], limits: { dailyMessages: null } } };
      return path in data ? { json: data[path] } : null;
    };
    const shot = async section => {
      await page.locator('.app-settings__main').evaluate(el => { el.scrollTop = 0; });
      await page.evaluate(() => document.fonts.ready);
      const name = `${phase}-${width}-${section}.png`;
      await page.screenshot({ path: `.context/settings-simplify/${name}`, animations: 'disabled' });
      await copyFile(`.context/settings-simplify/${name}`, `${artifacts}/${name}`);
    };
    const fullSection = async section => {
      const content = page.locator('.app-settings__page');
      const lateText = { general: 'Keyboard shortcuts', account: 'Current session', messaging: 'Share Swarm', usage: 'Plan limits', learning: 'Save learning settings', computer: 'Linux and Mac computers', permissions: 'Computer settings', apps: 'Your connected accounts', mcp: 'Team tools', subscriptions: 'Manage device access', keys: 'Composio · Connected apps · Connected' };
      const last = content.getByText(lateText[section], { exact: true });
      await last.waitFor({ timeout: 3000 });
      await last.scrollIntoViewIfNeeded();
      if (section === 'general') {
        await content.getByRole('switch', { name: 'Show details panel', exact: true }).waitFor();
        await content.getByRole('button', { name: 'View', exact: true }).click();
        assert.ok(await content.locator('.settings-shortcuts .cfg-row').count() >= 5);
      }
      return content.locator('.cfg-row__title').allTextContents();
    };
    const check = async section => {
      const geometry = await page.locator('.app-settings__main').evaluate(el => ({ height: el.clientHeight, width: el.clientWidth, overflow: el.scrollWidth > el.clientWidth }));
      assert.ok(geometry.height > 500 && geometry.width > 250 && !geometry.overflow, `${width}/${section}: ${JSON.stringify(geometry)}`);
      if (phase === 'before') return;
      const nav = page.locator('.settings-nav__item:visible, .settings-strip__item:visible');
      for (const item of await nav.all()) assert.equal(await item.locator('svg.settings-nav__icon[aria-hidden="true"][stroke-width="1.75"]').count(), 1, await item.innerText());
      const rows = page.locator('.app-settings :is(.cfg-row, .settings-field, .cfg-key__form:has(> .cfg-row__text), .learning-grid > label, .learning-fields .native-check, .learning-disclosure > summary, .learning-disclosure--row, .usage-filters > label):visible');
      for (const row of await rows.all()) assert.equal(await row.locator(':scope > svg.settings-row__icon[aria-hidden="true"][stroke-width="1.75"], :scope > .cfg-key__icon-space[aria-hidden="true"]').count(), 1, `${width}/${section}: ${await row.innerText()}`);
      report.push({ width, section, nav: await nav.count(), rows: await rows.count() });
    };
    await page.goto(origin);
    if (width === 390) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Account & settings', exact: true }).click();
    await page.getByRole('menuitem', { name: /Settings/ }).click();
    await page.locator('.app-settings').waitFor();
    await page.locator(width === 390 ? '.shell-header__title' : '.app-settings__page h1').waitFor();
    await shot('home');
    await check('home');
    for (const section of phase === 'before' ? ['general', 'account', 'apps'] : sections) {
      await page.goto(`${origin}/?section=${section}#settings/${section}`);
      await page.locator('.app-settings__page').waitFor();
      await page.locator('.app-settings__page h1').first().waitFor({ state: 'attached' });
      // Let the section's fixture requests and React updates settle.
      await page.waitForTimeout(180);
      if (phase === 'after') {
        const beforeReload = await fullSection(section);
        if (width === 390 || width === 1280) {
          await page.reload();
          assert.deepEqual(await fullSection(section), beforeReload, `${width}/${section}: cold load and reload must paint the complete page`);
        }
      }
      if (['general', 'account', 'apps'].includes(section)) await shot(section);
      await check(section);
      if (phase === 'after' && section === 'learning') {
        for (const summary of await page.locator('.learning-disclosure > summary').all()) await summary.click();
        await check('learning-expanded');
      }
      if (phase === 'after' && section === 'messaging') {
        await page.getByRole('button', { name: 'Manage preferences', exact: true }).click();
        await check('messaging-preferences');
      }
      if (phase === 'after' && section === 'subscriptions') {
        await page.locator('.subscription-settings__advanced > summary').click();
        await check('subscriptions-bridge');
      }
      if (phase === 'after' && section === 'mcp') {
        await page.getByRole('button', { name: 'Add MCP server', exact: true }).click();
        await page.getByText('Authentication & headers', { exact: true }).click();
        await check('mcp-editor');
        await page.getByLabel('Name', { exact: true }).fill('Unsaved tools');
        await page.setViewportSize({ width: width === 390 ? 1280 : 390, height: 844 });
        assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved tools', 'Resizing must preserve the page and its unsaved draft');
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved tools');
      }
    }
    if (phase === 'after') {
      await page.goto(`${origin}/#settings/general`);
      if (width > 760) {
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        await page.locator('.sidebar.is-collapsed').waitFor();
        assert.equal(await page.locator('.settings-nav__item').count(), 11);
        await check('collapsed-sidebar');
        await page.getByRole('button', { name: 'Expand sidebar' }).click();
      } else await page.getByRole('button', { name: 'Back', exact: true }).click();
      const nav = page.getByRole('navigation', { name: 'Settings sections', exact: true });
      assert.deepEqual(await nav.locator('.settings-nav__item').allTextContents(), labels);
      assert.deepEqual(await nav.locator('.settings-nav__label').allTextContents(), ['Workspace', 'Connections']);
      await nav.getByRole('searchbox').fill('memory');
      await nav.getByRole('button', { name: 'Learning', exact: true }).click();
      await page.locator('.learning-flags').waitFor();
      if (width === 390) await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.locator('.app-settings').waitFor({ state: 'detached' });
      await page.keyboard.press('Control+,');
      await page.locator(width === 390 ? '.shell-header__title' : '.app-settings__page h1').waitFor();
      await check('keyboard-open');
      if (width === 1280) {
        await page.locator('.shell-back').click();
        // The trigger must toggle the menu closed without the outside handler reopening it.
        const trigger = page.getByRole('button', { name: 'Account & settings', exact: true });
        await trigger.click();
        await trigger.click();
        await page.getByRole('menu').waitFor({ state: 'detached', timeout: 2000 });
        for (let attempt = 0; attempt < 10; attempt++) {
          await trigger.click({ timeout: 2000 });
          await page.getByRole('menuitem', { name: /^Settings/ }).click({ timeout: 2000 });
          await page.getByRole('menu').waitFor({ state: 'detached', timeout: 2000 });
          await fullSection('general');
          assert.equal(await page.locator('.settings-nav__item').count(), 11);
          await page.locator('.shell-back').click({ timeout: 2000 });
          await page.locator('.app-settings').waitFor({ state: 'detached', timeout: 2000 });
        }
      }
    }
    assert.deepEqual(errors, []);
    await page.context().close();
  }
  if (phase === 'after') await writeFile(`${artifacts}/after-counts.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS ${phase}: Settings at 390, 1280, 1440; ${report.length} icon/layout checks; ${phase === 'after' ? '44 cold-load/reload cases; 10 immediate menu reopen cycles;' : 'baseline capture only;'} 12 screenshots`);
} finally { await browser.close(); }
