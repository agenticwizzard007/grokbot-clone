// Local fixture audit for U16, U17, U19, U20 and U22 to U27.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.UI_ORIGIN ?? 'http://127.0.0.1:5193';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const evidence = new URL('../.context/customer-phone-polish/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const bot = { id: 'polish-bot', name: 'Review Bot', label: '', description: 'Summarize supplied notes. '.repeat(15) + '\nInternal second line.', instructions: 'Review notes.\nKeep the sources.', avatarShape: 'square', avatarColor: 'blue', mode: 'personal', isPrimary: true, kind: 'agent', effort: 'medium', model: null, generation: 1, unread: 0, lastActivityAt: 1, createdAt: 1, voice: '', voiceSpeed: 1, voiceLanguage: 'auto', onboarding: { status: 'active', revision: 32 } };
const resources = ['toolkit slack, revision 1, was EXPIRED', 'Gmail account is ACTIVE at revision 1'];
const learning = { enabled: true, automaticReview: true, memoryReview: true, skillReview: true, skillApproval: true, memoryTurnInterval: 10, skillIterationInterval: 10, maxIterations: 16, maxInputTokens: 32000, auxiliaryModel: null, auxiliaryProvider: null, curatorEnabled: true, curatorIntervalHours: 168, curatorMinIdleHours: 2, curatorStaleDays: 14, curatorArchiveDays: 30, curatorConsolidate: false };
const entry = { version: 49, kind: 'setup', sourceId: 'setup', sourceRevision: '32', action: 'updated', actor: 'owner', reason: null, runId: null, occurredAt: Date.now() - 7200000, recordedAt: Date.now(), origin: 'recorded' };
const setup = { botId: bot.id, manifest: { format: 'swarm-bot-setup', version: 1, bot, brief: { purpose: 'Review supplied notes.', responsibilities: ['Summarize notes.'], success_criteria: ['A concise summary.'], action_boundaries: 'Ask before sending.', out_of_scope: [], context_summary: 'Supplied notes.', shared_resources: resources, handoff_notes: [], communication_style: 'Concise.', working_principles: [], workflows: [], open_questions: [] } }, computer: { status: 'ready', error: null }, onboarding: { ...bot.onboarding, confirmedAt: 1, missing: [] }, files: { 'RESOURCES.md': '# Resources\n\n' + resources.map(r => '- ' + r).join('\n'), 'bot-setup.json': JSON.stringify({ revision: 32, resources }) } };
const description = 'Read, organize and draft email messages in Gmail. Find conversations and manage labels while keeping your account connected.';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
let currentPage;
try {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width === 390, isMobile: width === 390, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(({ theme, id }) => {
      localStorage.setItem('swarm.theme', theme);
      localStorage.setItem('swarm.selectedBot', id);
      window.EventSource = class { static CLOSED = 2; constructor() { queueMicrotask(() => this.onopen?.({})); } close() {} };
    }, { theme, id: bot.id });
    const errors = [], writes = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== base) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      const send = json => route.fulfill({ json });
      if (path.endsWith('/suggested-apps')) return send({ suggestions: [] });
      if (request.method() !== 'GET') { writes.push(`${request.method()} ${path}`); return route.fulfill({ status: 400, json: { error: 'Unexpected fixture write.' } }); }
      if (path === '/api/auth/me') return send({ user: { id: 'polish-account', email: 'polish@example.test', name: 'Account', timezone: 'UTC' } });
      if (path === '/api/bots') return send({ bots: [bot, { ...bot, id: 'second-bot', name: 'Writer Bot', isPrimary: false, description: '', label: '' }], live: [] });
      if (path.endsWith('/rows')) return send({ generation: 1, rows: [] });
      if (path.endsWith('/routines')) return send({ routines: [] });
      if (path.endsWith('/tasks')) return send({ tasks: [] });
      if (path === '/api/learning/settings') return send({ settings: learning, account: learning, overrides: {}, revision: 0, accountRevision: 0, botId: bot.id });
      if (path.endsWith('/analytics')) return send({ range: '7d', timezone: 'UTC', days: [], totals: { messages: 0, minutesSaved: 0 }, breakdown: [], rates: { pageRead: 1, search: 1, message: 1, code: 1 } });
      if (path.endsWith('/files')) return send({ status: 'ok', path: '', files: [] });
      if (path.endsWith('/memories/pending')) return send({ changes: [] });
      if (path.endsWith('/settings/keys')) { const key = { set: false, source: null }; return send({ canEdit: true, isolated: false, provider: { value: 'direct', chosen: 'direct' }, model: { value: 'fixture' }, openrouterModel: { value: 'fixture' }, openrouter: key, direct: key, composio: key, voice: key }); }
      if (path.endsWith('/settings')) return send({ skills: [], memories: [], routines: [], tasks: [], memory: { historyChars: 0, compactAtChars: 1000, lastCompaction: null } });
      if (path.endsWith('/coworker-setups')) return send({ setups: [] });
      if (path.endsWith('/setup')) return send(setup);
      if (path.endsWith('/history/49')) return send({ ...entry, before: {}, after: { revision: 32 }, changes: [{ field: 'revision', before: 31, after: 32 }], evidence: [], review: null });
      if (path.endsWith('/history')) return send({ entries: [entry], through: 49, latestVersion: 49, nextBefore: null, coverage: 'Saved revision coverage.' });
      if (path === '/api/computer') return send({ computer: { status: 'running', provider: 'local', screens: [] } });
      if (path === '/api/voice/options') return send({ voices: [{ id: '', name: 'Default' }], speeds: [1], languages: [{ code: 'auto', name: 'Auto-detect' }] });
      if (path === '/api/models') return send({ models: [], favourites: [], provider: 'direct', billing: 'api' });
      if (path === '/api/needs-you') return send({ items: [] });
      if (path === '/api/cli') return send({ selected: null, connected: false, providers: {} });
      if (path === '/api/providers/openrouter') return send({ active: false });
      if (path === '/api/apps') return send({ apps: [{ slug: 'gmail', name: 'Gmail', description, connected: true, accounts: [] }], connected: ['gmail'], connectedApps: [{ slug: 'gmail', name: 'Gmail', description, accounts: [] }], categories: [] });
      if (path === '/api/apps/connections') return send({ connections: [{ id: 'fixture-gmail', toolkit: 'gmail', status: 'ACTIVE', isDefault: false, isDisabled: false }] });
      return route.fulfill({ status: 404, json: { error: 'No fixture for this read.' } });
    });
    const page = currentPage = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    const shot = name => page.screenshot({ path: new URL(`${width}-${theme}-${name}.png`, evidence).pathname, fullPage: true });
    const checkOverflow = async () => {
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.setup-paper, .app-settings__main, .app-settings__page'), document.scrollingElement].filter(el => el.getClientRects().length).filter(el => el.scrollWidth > el.clientWidth + 1).map(el => ({ class: el.className, width: el.clientWidth, scroll: el.scrollWidth })));
      assert.deepEqual(overflow, [], 'no horizontal overflow');
    };
    const targets = async locator => {
      for (const el of await locator.all()) {
        const box = await el.boundingBox();
        if (box) assert.ok(box.width >= 44 && box.height >= 44, `${await el.getAttribute('aria-label')} target ${JSON.stringify(box)}`);
      }
    };
    const noJargon = async locator => assert.doesNotMatch(await locator.innerText(), /\b[Rr]evision\b|\bACTIVE\b|\bEXPIRED\b|\btoolkit\b/);
    const tap = async locator => width === 390 ? locator.tap() : locator.click();
    await page.goto(base);
    await page.locator('.app').waitFor();
    if (width === 390) await page.locator('.pinned__tile').first().click();
    await page.getByRole('button', { name: `Open ${bot.name} details`, exact: true }).click();
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    const detailTab = name => details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name, exact: true });
    await details.getByRole('button', { name: 'Preview', exact: true }).waitFor();
    await targets(details.locator('.setup-paper__bar button'));
    for (const button of await details.locator('.voice-settings button').all()) {
      const lines = await button.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); return [...new Set([...r.getClientRects()].map(b => b.top))].length; });
      assert.equal(lines, 1, 'voice button text fits one line');
    }
    assert.ok(await details.getByRole('button', { name: 'Computer settings', exact: true }).evaluate(el => el.classList.contains('cfg-btn')));
    await details.locator('.voice-settings').scrollIntoViewIfNeeded();
    await checkOverflow(); await shot('activity');
    await detailTab('Files').click();
    await details.getByText('No files yet. Files this Bot saves will appear here.', { exact: true }).waitFor();
    assert.equal(await details.getByRole('button', { name: 'Close details', exact: true }).count(), 1);
    await checkOverflow(); await shot('files');
    await detailTab('Setup').click();
    await details.getByRole('tab', { name: 'Responsibilities', exact: true }).waitFor();
    await noJargon(details);
    await tap(details.getByRole('tab', { name: 'History', exact: true }));
    await details.getByText(/^Setup updated ·/).click();
    await details.locator('.agent-history__entry .agent-history__change').waitFor({ state: 'attached' });
    await noJargon(details);
    await tap(details.getByRole('tab', { name: 'Files', exact: true }));
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
    for (const name of ['RESOURCES.md', 'bot-setup.json']) {
      await details.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).click();
      await noJargon(details);
    }
    await details.locator('.agent-config__file > details > summary').click();
    assert.match(await details.locator('.agent-config__file pre').innerText(), /revision/);
    await details.locator('.agent-config__file > details > summary').click();
    await checkOverflow(); await shot('setup');
    await details.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.locator('.chat__pill').click();
    await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).click();
    const settings = page.locator('.bot-settings-page');
    await targets(settings.locator('.setup-paper__bar button'));
    for (const label of ['General', 'Skills', 'Memories', 'Routines', 'Learning', 'Analytics', 'General']) {
      const button = settings.getByRole('navigation', { name: 'Bot settings sections' }).getByRole('button', { name: label, exact: true });
      await tap(button);
      const fit = await button.evaluate(el => {
        const nav = el.closest('nav').getBoundingClientRect(), r = document.createRange(); r.selectNodeContents(el);
        return [...r.getClientRects()].every(box => box.left >= nav.left && box.right <= nav.right && box.left >= 0 && box.right <= innerWidth);
      });
      assert.ok(fit, `${label} active label is fully visible`);
      if (label === 'Learning') { await settings.getByText('Using account defaults', { exact: true }).waitFor(); await noJargon(settings); }
      assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
      await checkOverflow();
    }
    await shot('bot-settings');
    await page.goto(base + '/#new-bot/group');
    await page.locator('.group-create__member').first().waitFor();
    await targets(page.locator('.setup-paper__bar button'));
    const rows = await page.locator('.group-create__member').evaluateAll(rows => rows.map(row => { const sub = row.querySelector('small'), check = row.querySelector('input'); return { height: row.getBoundingClientRect().height, subHeight: sub.getBoundingClientRect().height, line: parseFloat(getComputedStyle(sub).lineHeight), text: sub.textContent, checkbox: check.getBoundingClientRect().width }; }));
    assert.ok(rows.every(row => row.height >= 44 && row.subHeight <= row.line + 1 && row.checkbox >= 28 && !row.text.includes('\n')), JSON.stringify(rows));
    assert.ok(await page.locator('.group-create__field').evaluate(el => el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom >= 16));
    await tap(page.locator('.group-create__member strong').last());
    assert.equal(await page.locator('.group-create__member input').last().isChecked(), true);
    await checkOverflow(); await shot('group');
    await page.goto(base + '/#settings');
    await page.locator('.app-settings').waitFor();
    if (width === 390) assert.equal(await page.locator('.settings-nav__item.is-active, .settings-nav__item[aria-current]').count(), 0);
    else assert.ok(await page.locator('.settings-nav__item.is-active').count() > 0);
    await targets(page.locator('.access-settings__bar button'));
    await shot('settings-index');
    await page.goto(base + '/#settings/keys');
    await page.getByText('Server defaults', { exact: true }).waitFor();
    await targets(page.locator('.cfg-key__foot a'));
    const indents = await page.locator('.cfg-key .cfg-row__text').evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().left));
    assert.ok(indents.length >= 5 && Math.max(...indents) - Math.min(...indents) <= 1, JSON.stringify(indents));
    const headings = await page.locator('.app-settings .cfg-section__label').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).paddingLeft));
    assert.ok(headings.every(p => p === '0px'));
    await checkOverflow(); await shot('keys');
    await page.goto(base + '/#settings/apps');
    const desc = page.locator('.access-apps-settings__description');
    await desc.waitFor();
    assert.equal(await desc.innerText(), description);
    assert.ok(await desc.evaluate(el => el.scrollHeight <= el.clientHeight && getComputedStyle(el).whiteSpace === 'normal'));
    const def = page.getByRole('button', { name: 'Use by default', exact: true }), disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
    const a = await def.boundingBox(), b = await disconnect.boundingBox();
    assert.ok(b.y >= a.y + a.height + 15 || b.x >= a.x + a.width + 15);
    await disconnect.click();
    await page.getByRole('button', { name: 'Confirm disconnect', exact: true }).waitFor();
    assert.deepEqual(writes, [], 'first disconnect tap does not send a request');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await checkOverflow(); await shot('apps');
    assert.deepEqual(errors, []);
    results.push({ width, theme, passed: true });
    await context.close();
    console.log(`PASS customer phone polish: ${width}px ${theme}`);
  }
  await fs.writeFile(new URL('results.json', evidence), JSON.stringify(results, null, 2));
} catch (error) {
  await currentPage?.screenshot({ path: new URL('failure.png', evidence).pathname, fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); }
