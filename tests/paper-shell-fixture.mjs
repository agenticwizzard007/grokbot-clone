import { fixturePage } from './qa-r3-work-fixture.mjs';
import { smallComputerUsage } from './fixtures/usage-small-computer.mjs';

export async function shellFixture(browser, width = 1280, theme = 'light') {
  const f = await fixturePage(browser, { width, height: width <= 760 ? 844 : 900 }, { colorScheme: theme });
  await f.page.addInitScript(theme => {
    if (location.origin === 'null') return; // Cold navigation starts at about:blank.
    localStorage.setItem('swarm.theme', theme);
    localStorage.setItem('swarm.sidebarCollapsed', '0');
  }, theme);
  for (const bot of f.fixture.bots) {
    bot.onboarding = { status: 'active', revision: 1 };
    bot.model = 'claude/sonnet-4-5';
  }
  f.fixture.bots.push({ ...f.fixture.bots[1], id: 'project-room', name: 'Project room', kind: 'room', memberIds: ['coordinator', 'research-bot'] });
  f.fixture.respond = ({ path }) => {
    if (path === '/api/models') return { json: { provider: 'claude-cli', billing: 'plan', plan: 'max', usage: { available: true, checkedAt: Date.now(), windows: [{ label: 'Weekly', usedPercent: 42, resetsAt: null }] }, defaultModel: 'claude/sonnet-4-5', models: [{ id: 'claude/sonnet-4-5', name: 'Sonnet 4.5', short: 'Sonnet 4.5', author: 'anthropic', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }], favourites: ['claude/sonnet-4-5'] } };
    if (path === '/api/cli') return { json: { runtime: 'server', selected: null, connected: false, providers: { codex: { installed: true, authenticated: false }, claude: { installed: true, authenticated: false } } } };
    if (path === '/api/providers/openrouter') return { json: { connected: false, linked: false, selected: false, active: false, hint: null } };
    if (path === '/api/settings/keys') { const key = { set: false, source: null }; return { json: { canEdit: false, isolated: false, provider: { value: 'direct', chosen: 'direct' }, model: { value: 'fixture' }, openrouterModel: { value: 'fixture' }, openrouter: key, direct: key, composio: key, voice: key } }; }
    if (path === '/api/messaging') return { json: { account: {}, links: [], line: null, prefs: { voiceReplies: 'off' }, speech: {}, invites: { allowance: 0 } } };
    if (path === '/api/usage') return { json: smallComputerUsage };
    if (path === '/api/apps') return { json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } };
    if (path === '/api/rooms/project-room/members') return { json: { members: f.fixture.bots.filter(bot => ['coordinator', 'research-bot'].includes(bot.id)) } };
    if (/^\/api\/learning\/bots\/[^/]+\/history$/.test(path)) return { json: { entries: [], through: 0, latestVersion: 0, nextBefore: null, coverage: '' } };
    if (/^\/api\/bots\/[^/]+\/setup$/.test(path)) return { status: 404, json: { error: 'No saved configuration.' } };
    if (/^\/api\/bots\/[^/]+\/files$/.test(path)) return { json: { status: 'ok', path: '', files: [] } };
    if (path === '/api/computer/details') return { json: { computer: { status: 'absent', screens: [] }, screens: [], hibernation: { idleMinutes: 15 } } };
    if (path.endsWith('/suggested-apps')) return { json: { filterVersion: 'purpose-2', hasContext: false, suggestions: [] } };
    return null;
  };
  return f;
}
