import { canonicalJson, hashValue, stepsHash } from './hash.js';
import type { FlowModel, FlowNode, FlowLaneId } from './model-types.js';
import type { FlowSummaryInput } from '../handoffs/contracts.js';
import { extractSteps } from './extract-steps.js';

export interface FlowInputs {
  bot: { id: string; name: string; avatar: string; instructions: string };
  skills: { id: string; name: string; body: string }[];
  routines: { id: string; name: string; schedule: string; enabled: boolean; createdAt: number; event?: boolean }[];
  apps: { id: string; name: string; attention?: boolean }[];
  mcp: { id: string; name: string; enabled: boolean; attention?: boolean }[];
  suggestions: { id: string; name: string; kind: 'app' | 'mcp' }[];
  knowledge: number;
  outputs: { files: number; reports: number; tasks: number; channels: string[]; purpose: string };
  links: { id: string; fromBotId: string; toBotId: string; name: string; mode: 'off' | 'suggest' | 'auto'; trigger?: string; template?: string; autoApproveLoops?: boolean }[];
  loops: { id: string; name: string }[];
  inbound: boolean;
  connectionsKnown: boolean;
}

const sorted = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const canonical = canonicalJson;
export const digest = hashValue;
export const stepHash = (input: FlowInputs) => stepsHash(input.bot.instructions, input.skills.map(s => ({ id: s.id, name: s.name, bodyHash: digest(s.body) })));
export const bucket = (n: number) => n < 2 ? n : n < 6 ? '2 to 5' : '6+';
const outputCount = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
export function flowInputsHash(input: FlowInputs): string {
  // Hash the displayed count copy so old bucketed cache entries refresh as well.
  return digest({ ...input, skills: sorted(input.skills), routines: sorted(input.routines), apps: sorted(input.apps), mcp: sorted(input.mcp), suggestions: sorted(input.suggestions), links: sorted(input.links), loops: sorted(input.loops), knowledge: bucket(input.knowledge), outputs: { ...input.outputs, files: outputCount(input.outputs.files, 'file'), reports: outputCount(input.outputs.reports, 'report'), tasks: outputCount(input.outputs.tasks, 'task'), channels: [...input.outputs.channels].sort() } });
}
export function flowText(text: string, limit = 40): string {
  const clean = text.replace(/[\u2013\u2014]/g, ', ').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const head = clean.slice(0, limit + 1);
  const space = head.lastIndexOf(' ');
  return head.slice(0, space > limit / 2 ? space : limit).trim();
}

export function scheduleLabel(schedule: string): string {
  if (schedule.startsWith('event:')) return `When ${schedule.slice(6).replace(/_/g, ' ').toLowerCase()}`;
  const [minute, hour, day, month, weekday, extra] = schedule.trim().split(/\s+/);
  if (extra || !weekday) return schedule;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*') {
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    if (weekday === '*') return `Daily ${time}`;
    if (weekday === '1-5') return `Weekdays ${time}`;
    if (/^[0-6]$/.test(weekday)) return `${['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'][+weekday]} ${time}`;
  }
  if (minute === '0' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'Every hour';
  return schedule;
}

/** Pure, offline projection. Times and versions come from the cache, never the clock. */
export function buildFlowModel(input: FlowInputs, meta: { version: number; generatedAt: number; summary?: FlowSummaryInput; summaryHash?: string } = { version: 1, generatedAt: 0 }): FlowModel {
  const bot = encodeURIComponent(input.bot.id), base = `#bot/${bot}`;
  const lanes: FlowModel['lanes'] = (['triggers','inputs','steps','outputs','handoffs'] as const).map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), nodes: [], more: 0 }));
  const add = (lane: FlowLaneId, kind: FlowNode['kind'], id: string, label: string, hash: string, extra: Partial<FlowNode> = {}) => lanes.find(l => l.id === lane)!.nodes.push({ id: `${lane}:${kind}:${id}`, kind, label: flowText(label), target: { hash }, state: 'ok', ...extra, ...(extra.detail ? { detail: flowText(extra.detail, 60) } : {}) });
  const focus = (hash: string, key: string) => ({ target: { hash, focus: key } });
  const routines = [...input.routines].sort((a,b) => Number(b.enabled) - Number(a.enabled) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const r of routines) add('triggers', r.event ? 'event' : 'routine', r.id, r.name, `${base}/settings/routines`, { detail: scheduleLabel(r.schedule), ...focus(`${base}/settings/routines`, `routine:${r.id}`), ...(!r.enabled ? { state: 'disabled', badge: 'Paused' } : {}) });
  add('triggers', 'message', 'chat', 'You message me', base);
  for (const link of sorted(input.links).filter(l => l.toBotId === input.bot.id && l.mode !== 'off')) add('triggers', 'inbound_handoff', link.id, `From ${link.name}`, `${base}/details/flow?link=${encodeURIComponent(link.id)}`, focus(`${base}/details/flow?link=${encodeURIComponent(link.id)}`, `link-source:${link.fromBotId}`));
  if (input.inbound && !input.links.some(l => l.toBotId === input.bot.id && l.mode !== 'off')) add('triggers', 'inbound_handoff', 'incoming', 'Another agent hands off to me', `${base}/details/flow?link=new`);
  for (const app of sorted(input.apps)) add('inputs', 'app', app.id, app.name, '#settings/apps', { logo: { kind: 'toolkit', id: app.id }, ...focus('#settings/apps', `app:${app.id}`), ...(app.attention ? { state: 'attention', badge: 'Reconnect' } : {}) });
  for (const m of sorted(input.mcp)) add('inputs', 'mcp', m.id, m.name, '#settings/mcp', { logo: { kind: 'icon', id: 'server' }, ...focus('#settings/mcp', `mcp:${m.id}`), ...(!m.enabled ? { state: 'disabled', badge: 'Paused' } : m.attention ? { state: 'attention', badge: 'Reconnect' } : {}) });
  if (input.knowledge) add('inputs', 'knowledge', 'knowledge', 'Knowledge', `${base}/settings/memories`, { detail: `${bucket(input.knowledge)} memories` });
  for (const suggestion of sorted(input.suggestions).filter(s => !(s.kind === 'app' ? input.apps : input.mcp).some(a => a.id === s.id))) add('inputs', suggestion.kind === 'app' ? 'suggested_app' : 'suggested_mcp', suggestion.id, suggestion.name, suggestion.kind === 'app' ? '#apps/connect' : '#settings/mcp', { state: 'suggested', badge: 'Suggested', detail: 'Connect', logo: { kind: suggestion.kind === 'app' ? 'toolkit' : 'icon', id: suggestion.id }, ...focus(suggestion.kind === 'app' ? '#apps/connect' : '#settings/mcp', `${suggestion.kind}:${suggestion.id}`) });
  const current = !!meta.summary?.steps.length && meta.summaryHash === stepHash(input);
  const steps = current ? meta.summary!.steps : extractSteps(input.bot.instructions, sorted(input.skills));
  steps.slice(0, 6).forEach((step, i) => {
    const skill = 'skillId' in step && typeof step.skillId === 'string' ? step.skillId : undefined;
    add('steps', skill ? 'skill' : 'step', skill ?? String(i + 1), step.label, skill ? `${base}/settings/skills` : `${base}/details/setup/responsibilities`, { ...('detail' in step && step.detail ? { detail: step.detail } : {}), ...(!current ? { badge: 'Auto' } : {}), ...(skill ? focus(`${base}/settings/skills`, `skill:${skill}`) : {}) });
  });
  if (input.outputs.reports) add('outputs', 'report', 'reports', 'Reports', `${base}/details/files/reports`, { detail: outputCount(input.outputs.reports, 'report') });
  if (input.outputs.files) add('outputs', 'files', 'files', 'Files', `${base}/details/files`, { detail: outputCount(input.outputs.files, 'file') });
  if (input.outputs.purpose) add('outputs', 'report', 'purpose', input.outputs.purpose, `${base}/details/files/reports`);
  for (const channel of [...new Set(input.outputs.channels)].sort()) add('outputs', 'message_out', channel, channel === 'chat' ? 'Chat messages' : channel, '#settings/messaging');
  if (input.outputs.tasks) add('outputs', 'task', 'tasks', 'Tasks', `${base}/details/tasks`, { detail: outputCount(input.outputs.tasks, 'task') });
  for (const link of sorted(input.links)) add('handoffs', link.fromBotId === input.bot.id ? 'handoff_to' : 'handoff_from', link.id, link.name, `${base}/details/flow?link=${encodeURIComponent(link.id)}`, { ...focus(`${base}/details/flow?link=${encodeURIComponent(link.id)}`, `link-source:${link.fromBotId}`), badge: link.mode === 'auto' ? 'Auto' : link.mode === 'off' ? 'Off' : 'Suggest', state: link.mode === 'off' ? 'disabled' : 'ok', detail: link.fromBotId === input.bot.id ? 'Sends work' : 'Receives work', logo: { kind: 'bot', id: link.fromBotId === input.bot.id ? link.toBotId : link.fromBotId } });
  for (const loop of sorted(input.loops)) add('handoffs', 'loop', loop.id, loop.name, `#loop/${encodeURIComponent(loop.id)}`);
  for (const lane of lanes) { lane.more = Math.max(0, lane.nodes.length - 5); lane.nodes = lane.nodes.slice(0, 5); }
  const repeats = input.routines.some(r => r.enabled && !r.event) || input.loops.length > 0;
  return { v: 1, botId: input.bot.id, version: meta.version, inputsHash: flowInputsHash(input), generatedAt: meta.generatedAt, source: current ? 'agent+auto' : 'auto', lanes, loopBack: { kind: repeats ? 'repeats' : 'waits', label: repeats ? 'Repeats' : 'Waits for the next trigger' }, warnings: [...(!input.bot.instructions.trim() ? ['No instructions yet'] : []), ...(!input.connectionsKnown ? ['Open Connected apps to refresh app status'] : [])] };
}
