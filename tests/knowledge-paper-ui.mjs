import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5192';
const evidence = process.env.KNOWLEDGE_EVIDENCE_DIR || '.context/knowledge-paper-ui';
await fs.mkdir(evidence, { recursive: true });
const gate = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { release, wait }; };
const now = Date.now();
const quinn = { id: 'quinn', name: 'Quinn', label: 'Chief of Staff', isPrimary: true, kind: 'agent', instructions: 'Verify sources before drafting.', description: '', avatarColor: 'blue', avatarShape: 'blob', mode: 'personal', effort: 'medium', model: null, generation: 3, unread: 0, pinned: false, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto' };
const imported = { ...quinn, id: 'atlas', name: 'Atlas', label: 'Research partner', isPrimary: false, generation: 1 };
const manifest = {
  format: 'swarm.bot-setup', version: 2, bot: { name: 'Quinn', label: imported.label, instructions: quinn.instructions, description: 'Research launch readiness', avatarShape: 'blob', avatarColor: 'blue', mode: 'teammate', effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto' }, source: { messages: [] },
  brief: { purpose: 'Turn evidence into launch recommendations.', responsibilities: ['Verify original sources'], out_of_scope: ['Purchasing'], success_criteria: ['Cite primary records'], context_summary: 'Launch readiness', shared_resources: [], handoff_notes: [], communication_style: 'Direct', working_principles: ['Call out gaps'], action_boundaries: 'Read only', workflows: [], open_questions: [] },
};
const memory = { id: 'm1', botId: 'arbitrary', text: 'Active owned launch preference', status: 'active', revision: 1, evidence: [], createdAt: now, target: 'user' };
const source = { botId: imported.id, generation: 2, seq: 16, sourceKey: 'atlas:2:16', contentHash: 'hash16', role: 'user', archived: true, text: 'Launch evidence page one', createdAt: now };
const settings = { enabled: true, automaticReview: true, memoryReview: true, skillReview: true, skillApproval: true, curatorEnabled: true, curatorIntervalHours: 24, curatorMinIdleHours: 1, curatorStaleDays: 30, curatorArchiveDays: 60 };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const { width, theme } of [{ width: 1440, theme: 'light' }, { width: 390, theme: 'dark' }, { width: 320, theme: 'dark' }]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const writes = [], reads = [], errors = [];
    let roster = [quinn], setupStatus = 'interviewing', importCalls = 0, curationCalls = 0, firstPageError = true, analyticsRequests = 0;
    const curation = gate(), staleSearch = gate(), staleArrived = gate(), delayedImport = gate(), importArrived = gate();
    const setup = botId => ({ manifest: { ...manifest, bot: { ...manifest.bot, name: botId === imported.id ? imported.name : quinn.name } }, computer: { status: 'ready', error: null }, onboarding: { revision: setupStatus === 'interviewing' ? 4 : 5, status: setupStatus, confirmedAt: null, missing: [] }, files: { 'AGENTS.md': '# Verify original sources', 'bot-setup.json': JSON.stringify(manifest) } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => {
      localStorage.setItem('swarm.theme', theme);
      localStorage.setItem('swarm.selectedBot', 'quinn');
      window.EventSource = class { static CLOSED = 2; constructor() { setTimeout(() => this.onopen?.(), 0); } close() {} };
    }, theme);
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), endpoint = url.pathname, query = url.searchParams;
      const error = (message, status = 503) => route.fulfill({ status, json: { error: message } });
      if (endpoint.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
      if (request.method() !== 'GET') {
        writes.push({ endpoint, method: request.method(), body: request.postDataJSON() });
        if (endpoint === '/api/bots/import') {
          if (++importCalls === 1) return error('Import unavailable. Try again.');
          if (width <= 760) { importArrived.release(); await delayedImport.wait; }
          roster = [...roster, imported]; return route.fulfill({ json: { bot: imported, computer: { status: 'ready', error: null } } });
        }
        if (endpoint === '/api/bots/atlas/setup/activate') { setupStatus = 'active'; return route.fulfill({ json: setup(imported.id) }); }
        if (endpoint === '/api/learning/bots/atlas/curate') {
          if (++curationCalls === 1) { await curation.wait; return error('Maintenance temporarily unavailable.'); }
          return route.fulfill({ json: curationCalls === 2 ? { archived: [], stale: [], deferred: true } : { archived: ['archived-id'], stale: ['stale-id', 'second-stale'], deferred: false } });
        }
        return error('Unexpected mutation');
      }
      reads.push(`${endpoint}${url.search}`);
      let body = {};
      if (endpoint === '/api/auth/me') body = { user: { id: 'owner', name: 'Alex', email: 'alex@example.test' }, devLogin: false };
      else if (endpoint === '/api/bots') body = { bots: roster, live: [] };
      else if (endpoint.endsWith('/rows')) body = { generation: roster.find(bot => bot.id === endpoint.split('/')[3])?.generation, rows: [] };
      else if (endpoint.endsWith('/routines')) body = { routines: [] };
      else if (endpoint.endsWith('/tasks')) body = { tasks: [] };
      else if (endpoint.endsWith('/coworker-setups')) body = { setups: [] };
      else if (endpoint === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (endpoint === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (endpoint === '/api/models') body = { models: [], favourites: [] };
      else if (endpoint === '/api/voice/options') body = { voices: [], speeds: [], languages: [], configured: false };
      else if (endpoint === '/api/settings') body = { settings: {}, computer: { provider: 'local' } };
      else if (endpoint === '/api/auth/sessions') body = { sessions: [] };
      else if (endpoint === '/api/apps') body = { apps: [], connected: [], categories: [], total: 0 };
      else if (endpoint.endsWith('/setup')) body = setup(endpoint.split('/')[3]);
      else if (endpoint.endsWith('/instructions')) body = { instructions: 'Assembled from revision five', stage: 'active', revision: 5, capturedAt: now };
      else if (endpoint.endsWith('/setup/bot-setup.json')) return route.fulfill({ body: JSON.stringify(manifest), contentType: 'application/json' });
      else if (endpoint.endsWith('/files')) body = { status: 'ok', path: '', files: [] };
      else if (endpoint.startsWith('/api/deliverables/')) body = { artifacts: [] };
      else if (endpoint.endsWith('/settings') && endpoint.includes('/bots/')) body = { routines: [], tasks: [], skills: [], memories: [{ ...memory, botId: imported.id }, { ...memory, text: 'OTHER BOT MEMORY', id: 'other' }, { ...memory, botId: imported.id, text: 'SUPERSEDED MEMORY', id: 'old', status: 'superseded' }], memory: { historyChars: 0, compactAtChars: 10000, lastCompaction: null } };
      else if (endpoint.endsWith('/skill-proposals')) body = { proposals: [] };
      else if (endpoint === '/api/learning/settings') body = { settings, revision: 1, overrides: {} };
      else if (endpoint.endsWith('/analytics')) {
        if (query.get('range') === '30d' && ++analyticsRequests === 1) return error('Analytics unavailable.');
        body = { range: query.get('range'), days: [{ day: '2026-11-20', messages: 3, minutesSaved: 12 }, { day: '2026-11-21', messages: 5, minutesSaved: 25 }], totals: { messages: 8, minutesSaved: 37 }, rates: { pageRead: 5, webSearch: 1, command: 1, computerStep: 0.5, wordsPerMinute: 35 }, breakdown: [] };
      } else if (endpoint.endsWith('/conversation-search')) {
        if (query.get('q') === 'superseded') { staleArrived.release(); await staleSearch.wait; return route.fulfill({ json: { messages: [{ ...source, text: 'STALE SEARCH RESULT' }], nextOffset: null } }).catch(() => {}); }
        if (query.get('offset') === '10' && firstPageError) { firstPageError = false; return error('Older sources unavailable.'); }
        body = query.get('offset') === '10'
          ? { messages: [{ ...source, seq: 4, sourceKey: 'atlas:2:4', text: 'Launch evidence page two' }], nextOffset: null }
          : { messages: [source, { ...source, sourceKey: 'quinn:2:16', botId: quinn.id, text: 'OTHER BOT SOURCE' }, { ...source, sourceKey: 'atlas:3:16', generation: 3, text: 'WRONG GENERATION' }, { ...source, sourceKey: 'atlas:2:17', role: 'assistant', text: 'WRONG ROLE' }], nextOffset: 10 };
      } else if (endpoint.endsWith('/messages/2/16')) body = { messages: [{ ...source, text: 'Verified excerpt' }, { ...source, botId: quinn.id, text: 'OTHER BOT EXCERPT' }] };
      return route.fulfill({ json: body });
    });
    const shot = async (name, pane) => {
      assert.ok(await pane.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${name} must fit ${width}px`);
      await page.screenshot({ path: path.join(evidence, `${name}-${width}-${theme}.png`), animations: 'disabled' });
    };
    const btn = (target, name) => target.getByRole('button', { name, exact: typeof name === 'string' });
    await page.goto(origin);
    await btn(page, 'New Bot').click();
    const create = page.getByRole('main', { name: 'Create a Bot', exact: true });
    await create.waitFor();
    await shot('create', create);
    await page.keyboard.press('Escape'); await create.waitFor({ state: 'hidden' });
    await btn(page, 'New Bot').click();
    await btn(create, 'Import saved setup').click();
    const upload = page.getByRole('main', { name: 'Import a saved setup', exact: true });
    const select = upload.getByLabel('Setup file');
    await select.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('INVALID') });
    await upload.getByText(/not valid JSON/).waitFor();
    assert.ok(await btn(upload, 'Import setup').isDisabled());
    await select.setInputFiles({ name: 'bot-setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) });
    await upload.getByText('Selected: bot-setup.json').waitFor();
    assert.ok(await btn(upload, 'Import setup').isDisabled(), 'duplicate name cannot submit');
    assert.equal(writes.length, 0);
    await upload.getByRole('textbox', { name: 'Bot name' }).fill(imported.name);
    await btn(upload, 'Import setup').click(); await upload.getByText('Import unavailable. Try again.').waitFor();
    await shot('import-retry', upload);
    await btn(upload, 'Import setup').click();
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    const detailsNav = details.getByRole('navigation', { name: 'Conversation details sections' });
    const tabs = details.getByRole('tablist', { name: 'Agent configuration sections' });
    const settingsPane = page.getByRole('main', { name: 'Atlas settings' });
    const account = page.getByRole(width > 760 ? 'region' : 'dialog', { name: 'Settings', exact: true });
    if (width <= 760) {
      await importArrived.wait;
      await page.keyboard.press('Control+,');
      await btn(account.getByRole('navigation', { name: 'Settings sections' }), 'Account').click();
      await account.getByRole('heading', { name: 'Your account', exact: true }).waitFor();
      await btn(account, 'Delete account…').click();
      const confirmation = account.getByRole('heading', { name: 'Delete your Swarm account?', exact: true });
      await confirmation.waitFor();
      delayedImport.release();
      await page.getByText('Atlas is in your Bots.', { exact: true }).waitFor({ state: 'attached' });
      assert.equal(await confirmation.isVisible(), true, 'import must not close the newer Account confirmation');
      assert.equal(await page.locator('.main-pane').getAttribute('hidden'), '');
      assert.ok(!reads.some(endpoint => endpoint.startsWith('/api/bots/atlas/')), 'import must not select its bot before the explicit recovery action');
      await btn(account, 'Close settings').click();
      const openImport = btn(upload, 'Open imported setup');
      await openImport.waitFor();
      assert.equal(await upload.locator('form').count(), 0, 'a known successful import must not offer another POST');
      await shot('import-recovered', upload);
      await openImport.click();
    }
    await details.getByText('Setup interview · Revision 4').waitFor();
    assert.equal(await btn(details, 'Review and activate').count(), 0, 'an imported interview cannot be activated before the backend marks it ready');
    setupStatus = 'review';
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('swarm:event', { detail: { type: 'setup', botId: 'atlas' } })));
    await btn(details, 'Review and activate').click();
    assert.equal(await btn(details, 'Activate agent · revision 5').isEnabled(), true);
    assert.equal(writes.length, 2, 'import must not activate automatically');
    await shot('setup-review', details);
    await btn(details, 'Activate agent · revision 5').click();
    await details.getByText('Activated configuration revision 5.').waitFor();
    const harness = tabs.getByRole('tab', { name: 'Harness' });
    await harness.click();
    await details.getByText('Preview assembled instructions').click();
    await details.getByText('Assembled from revision five').waitFor();
    await shot('harness', details);
    await btn(details, 'Skills').click();
    await settingsPane.getByRole('heading', { name: 'Atlas · Skills', exact: true }).waitFor();
    assert.equal(await details.isVisible(), false);
    await page.keyboard.press('Control+,'); await account.waitFor();
    assert.equal(await settingsPane.isVisible(), false);
    assert.equal(await page.locator('.main-pane').getAttribute('hidden'), '');
    await btn(account, width > 760 ? 'Back to chat' : 'Close settings').click();
    await settingsPane.waitFor(); await page.keyboard.press('Escape'); await details.waitFor();
    assert.equal(await harness.getAttribute('aria-selected'), 'true', 'return restores caller tab');
    await tabs.getByRole('tab', { name: 'Files' }).click();
    await btn(details, /^bot-setup\.json/).click();
    await details.getByRole('region', { name: 'bot-setup.json contents' }).waitFor();
    const download = page.waitForEvent('download'); await btn(details, 'Download').click();
    assert.equal((await download).suggestedFilename(), 'bot-setup.json');
    await btn(detailsNav, 'Files').click();
    const computer = details.getByRole('region', { name: 'Computer files' });
    await computer.getByText(/No computer files/).waitFor();
    await btn(details, 'Saved reports').click();
    await details.getByRole('region', { name: 'Saved reports' }).waitFor();
    assert.equal(await computer.isVisible(), false);
    await btn(details, 'Back to files').click(); await computer.waitFor();

    await btn(detailsNav, 'Activity').click();
    assert.equal(await btn(details, 'Hide voice settings').count(), 0);
    await btn(details, 'Bot settings').click();
    await btn(settingsPane, 'Learning').click();
    await settingsPane.locator('summary').filter({ hasText: /Skill maintenance/ }).click();
    const maintenance = settingsPane.getByRole('region', { name: 'Protected skill maintenance' });
    await btn(maintenance, 'Run maintenance now').click();
    await btn(maintenance, 'Checking eligibility…').waitFor();
    assert.ok(await btn(maintenance, 'Checking eligibility…').isDisabled());
    curation.release(); await maintenance.getByText('Maintenance temporarily unavailable.').waitFor();
    await btn(maintenance, 'Retry maintenance').click(); await maintenance.getByText(/^Maintenance deferred/).waitFor();
    await btn(maintenance, 'Run maintenance now').click(); await maintenance.getByText('Maintenance completed. Archived: 1. Reported stale: 2.').waitFor();
    await shot('maintenance', settingsPane);

    await btn(settingsPane, 'Memories').click();
    await settingsPane.getByText(memory.text).waitFor();
    assert.equal(await settingsPane.getByText(/OTHER BOT MEMORY|SUPERSEDED MEMORY/).count(), 0);
    await shot('memories', settingsPane);
    await btn(settingsPane, 'Search sources').click();
    const search = settingsPane.getByRole('region', { name: 'Conversation source search' });
    const query = search.getByLabel('Search conversation sources');
    await search.getByLabel('Message role').selectOption('user'); await search.getByLabel('Conversation generation').fill('2');
    await query.fill('superseded'); await btn(search, 'Search').click(); await staleArrived.wait;
    await query.fill('launch evidence'); await btn(search, 'Search').click();
    await search.getByText(source.text, { exact: true }).waitFor(); staleSearch.release();
    await query.fill('unsubmitted draft'); await btn(search, 'Load older sources').click();
    await search.getByText('Older sources unavailable.').waitFor();
    await search.getByText(source.text, { exact: true }).waitFor();
    await btn(search, 'Retry older sources').click(); await search.getByText('Launch evidence page two').waitFor();
    await btn(search, 'Open conversation source 2:16').click(); await search.getByText('Verified excerpt').waitFor();
    assert.equal(await search.getByText(/STALE SEARCH RESULT|OTHER BOT SOURCE|WRONG GENERATION|WRONG ROLE|OTHER BOT EXCERPT/).count(), 0);
    await shot('sources', settingsPane);
    await page.keyboard.press('Escape'); await search.waitFor({ state: 'hidden' });
    await btn(settingsPane, 'Analytics').click();
    await settingsPane.getByRole('region', { name: 'Messages', exact: true }).waitFor();
    await settingsPane.getByRole('radio', { name: '30 days' }).click(); await settingsPane.getByText('Analytics unavailable.').waitFor();
    await btn(settingsPane, 'Retry analytics').click();
    await settingsPane.getByText('Inspect a day', { exact: true }).click();
    await settingsPane.getByLabel('Day (UTC)', { exact: true }).selectOption('2026-11-20');
    await settingsPane.getByText('3 messages · 12 min estimated time saved', { exact: true }).waitFor();
    await shot('analytics', settingsPane);
    assert.deepEqual(writes, [
      ...[0, 1].map(() => ({ endpoint: '/api/bots/import', method: 'POST', body: { manifest, name: 'Atlas', expectedUserId: 'owner' } })),
      { endpoint: '/api/bots/atlas/setup/activate', method: 'POST', body: { revision: 5 } },
      ...[0, 1, 2].map(() => ({ endpoint: '/api/learning/bots/atlas/curate', method: 'POST', body: {} })),
    ]);
    const searches = reads.filter(value => value.includes('/conversation-search?')).map(value => Object.fromEntries(new URL(value, origin).searchParams));
    assert.deepEqual(searches, [{ q: 'superseded', offset: '0' }, { q: 'launch evidence', offset: '0' }, { q: 'launch evidence', offset: '10' }, { q: 'launch evidence', offset: '10' }].map(filter => ({ ...filter, generation: '2', role: 'user', limit: '10' })));
    assert.ok(reads.filter(value => value.includes('/conversation-search?')).every(value => value.startsWith('/api/bots/atlas/')));
    assert.ok(reads.includes('/api/bots/atlas/messages/2/16?contentHash=hash16'));
    const analytics = reads.filter(value => value.includes('/analytics?'));
    const expectedAnalytics = ['7d', '30d', '30d'].map(range => `/api/bots/atlas/analytics?range=${range}`);
    assert.deepEqual(analytics, analytics.length === 4 ? [expectedAnalytics[0], ...expectedAnalytics] : expectedAnalytics, 'StrictMode may replay the initial read; the selected range and retry stay scoped');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS knowledge Paper UI ${width}px ${theme} — imports, activation, returns, files, protected curation, filtered sources and analytics`);
  }
} finally { await browser.close(); }
