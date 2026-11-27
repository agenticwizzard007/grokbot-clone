import type { FlowInputs } from '../../server/src/flow/build.js';
export const empty = (id = 'flow-empty'): FlowInputs => ({ bot: { id, name: 'Empty agent', avatar: 'bird-solo:blue', instructions: '' }, skills: [], routines: [], apps: [], mcp: [], suggestions: [], knowledge: 0, outputs: { files: 0, reports: 0, tasks: 0, channels: ['chat'], purpose: '' }, links: [], loops: [], inbound: false, connectionsKnown: true });
const rich = empty('flow-rich');
Object.assign(rich, {
  bot: { ...rich.bot, name: 'Research agent', instructions: '# Process\n1. Collect release notes\n2. Compare recent changes\n3. Draft a weekly report' },
  routines: [{ id: 'weekly', name: 'Weekly review', schedule: 'Mondays 09:00', enabled: true, createdAt: 1 }, { id: 'event', name: 'New issue', schedule: 'When an issue opens', enabled: true, createdAt: 2, event: true }, { id: 'paused', name: 'Daily check', schedule: 'Weekdays 08:00', enabled: false, createdAt: 3 }],
  apps: [{ id: 'github', name: 'GitHub' }], mcp: [{ id: 'docs', name: 'Reference library', enabled: true }], knowledge: 4,
  suggestions: [{ id: 'googledrive', name: 'Google Drive', kind: 'app' }, { id: 'catalog', name: 'Document catalog', kind: 'mcp' }],
  skills: [{ id: 'verify', name: 'Fact verification', body: 'Verify every source.' }],
  outputs: { files: 3, reports: 1, tasks: 2, channels: ['chat', 'iMessage'], purpose: '' },
  links: [{ id: 'send', fromBotId: 'flow-rich', toBotId: 'flow-checker', name: 'Review agent', mode: 'suggest' }, { id: 'receive', fromBotId: 'flow-checker', toBotId: 'flow-rich', name: 'Review agent', mode: 'suggest' }], loops: [{ id: 'lp_fixture', name: 'Release review loop' }],
});
const suggestions = empty('flow-suggestions'); suggestions.bot.name = 'Suggestions agent'; suggestions.suggestions = [{ id: 'github', name: 'GitHub', kind: 'app' }, { id: 'googlecalendar', name: 'Google Calendar', kind: 'app' }];
const odd = empty('flow-odd'); odd.bot.instructions = 'こんにちは。準備ができたら報告してください。';
const long = empty('flow-long'); long.bot.instructions = '# Steps\n1. Review the exceptionally detailed collection of placeholder release notes before drafting\n2. Summarize the research findings with sources\n3. Send the finished report'; long.apps = [{ id: 'long', name: 'An unusually long integration label for wrapping' }];
const many = empty('flow-many'); many.bot.instructions = '# Process\n' + Array.from({ length: 6 }, (_, i) => `${i + 1}. Review section ${i + 1}`).join('\n'); many.routines = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, name: `Routine ${i}`, schedule: 'Weekdays 08:00', enabled: true, createdAt: i })); many.apps = Array.from({ length: 40 }, (_, i) => ({ id: `app${i}`, name: `Connected app ${i}` }));
export const fixtures = { rich, empty: empty(), suggestions, odd, long, many };
