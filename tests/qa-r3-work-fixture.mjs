// Local browser fixtures only. Root supplies the preview through UI_ORIGIN.
import assert from 'node:assert/strict';

export const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:5198';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
export const gate = () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return { release, wait };
};
const now = Date.now();
export const fixtureBots = () => ['Coordinator', 'Research Bot'].map((name, index) => ({
  id: index ? 'research-bot' : 'coordinator', name, label: '', kind: 'agent', isPrimary: !index,
  avatarShape: 'blob', avatarColor: 'blue', description: '', instructions: '', mode: 'personal',
  model: null, effort: 'medium', generation: 1, unread: 0, lastPreview: '', pinned: false,
  createdAt: now, lastActivityAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto',
}));

export async function fixturePage(browser, viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce', timezoneId: 'UTC' });
  page.setDefaultTimeout(8000);
  const fixture = { bots: fixtureBots(), routines: [], reports: [], sources: [], respond: null };
  const errors = [], writes = [], reads = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('swarm.selectedBot', 'coordinator');
    window.EventSource = class {
      static CLOSED = 2;
      constructor() {
        window.__emitFixture = event => this.onmessage?.({ data: JSON.stringify(event) });
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    };
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { errors.push(`Unexpected external request: ${url.href}`); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET') reads.push(`${path}${url.search}`);
    else writes.push({ path, method, body: request.postData() ? request.postDataJSON() : null });
    const response = await fixture.respond?.({ path, method, request, url });
    if (response) return route.fulfill(response);
    if (method !== 'GET') { errors.push(`Unexpected mutation: ${method} ${path}`); return route.abort(); }
    let body = {};
    if (path === '/api/auth/me') body = { user: { id: 'fixture-owner', name: 'Account', email: 'account@example.test' } };
    else if (path === '/api/bots') body = { bots: fixture.bots, live: [] };
    else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
    else if (path.endsWith('/coworker-setups')) body = { setups: [] };
    else if (path.endsWith('/tasks')) body = { tasks: [] };
    else if (path === '/api/needs-you') body = { items: [] };
    else if (path.endsWith('/routines')) body = { routines: fixture.routines.filter(item => item.botId === path.split('/')[3]) };
    else if (/^\/api\/bots\/[^/]+\/settings$/.test(path)) body = { memories: [], skills: [], routines: fixture.routines.filter(item => item.botId === path.split('/')[3]), tasks: [], memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 1000, lastCompaction: null } };
    else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
    else if (path === '/api/models') body = { models: [], favourites: [], provider: 'openrouter', billing: 'api' };
    else if (path === '/api/voice/options') body = { voices: [], speeds: [1], languages: [], configured: false };
    else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
    else if (path === '/api/workflows') body = { goals: [], workflows: [] };
    else if (path === '/api/team/state') body = { state: {
      userId: 'fixture-owner', generatedAt: now, eventCursor: 0, primaryBotId: 'coordinator', sourceVersions: {},
      agents: fixture.bots.map(bot => ({ botId: bot.id, name: bot.name, isPrimary: bot.isPrimary, parentBotId: null, setupStatus: 'active', status: 'idle', observation: 'observed', activeJobIds: [], pendingDecision: false })),
      jobs: [], workflows: [], goals: [], artifacts: [], deliveries: [], requests: {}, coverage: {}, humanSources: { pending: 0 },
      health: { runtime: 'healthy', lastTickAt: now, lastError: null, pendingWakes: 0 },
    } };
    else if (/^\/api\/deliverables\/bots\/[^/]+\/runs$/.test(path)) body = { runs: [] };
    else if (/^\/api\/deliverables\/bots\/[^/]+$/.test(path)) body = { artifacts: [] };
    else if (path === '/api/checkins') body = { enabled: false, times: ['09:00'], timezone: 'Asia/Dubai', timezoneSource: 'explicit', quietHours: [] };
    else if (path === '/api/checkins/reports') body = { reports: fixture.reports, nextCursor: 0, hasMore: false };
    else if (/^\/api\/checkins\/reports\/[^/]+\/sources$/.test(path)) body = { sources: fixture.sources, nextCursor: fixture.sources.length, hasMore: false };
    else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'local' } };
    else if (path === '/api/auth/sessions') body = { sessions: [] };
    return route.fulfill({ json: body });
  });
  return { page, fixture, errors, writes, reads };
}
