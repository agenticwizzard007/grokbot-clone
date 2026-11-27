import type { HandoffLink, HandoffSettings, RunOutput } from './contracts.js';
import { HandoffError } from './errors.js';
export const MAX_CHAIN = 5;
export interface ChainHop { outputId: string; botId: string }
/** All inputs must already be tenant scoped by the store. Walk every consumed branch. */
export function checkChain(source: RunOutput, targetBotId: string, outputs: readonly RunOutput[], inLoop = false): ChainHop[] {
  if (inLoop) return [];
  const byId = new Map(outputs.filter(o => o.userId === source.userId).map(o => [o.id, o])); byId.set(source.id, source);
  const hops: ChainHop[] = [], emitted = new Set<string>();
  const walk = (output: RunOutput, path: Set<string>, depth: number) => {
    if (path.has(output.id)) throw new HandoffError('cycle_detected', 'That would send the work back. Use a loop instead.');
    if (depth > MAX_CHAIN) throw new HandoffError('chain_too_long', 'This chain is too long. Use a loop instead.');
    if (output.botId === targetBotId) throw new HandoffError('cycle_detected', 'That would send the work back. Use a loop instead.');
    if (!emitted.has(output.id)) { hops.push({ outputId: output.id, botId: output.botId }); emitted.add(output.id); }
    const next = new Set(path).add(output.id);
    for (const id of [...output.provenance.consumed].sort()) {
      const parent = byId.get(id);
      if (!parent) throw new HandoffError('not_found', 'Output not found');
      walk(parent, next, depth + 1);
    }
  };
  walk(source, new Set(), 1); return hops;
}
export function assertAutoLinkAcyclic(links: readonly Pick<HandoffLink, 'fromBotId' | 'toBotId' | 'mode'>[]): void {
  const edges = new Map<string, string[]>();
  for (const link of links) if (link.mode === 'auto') edges.set(link.fromBotId, [...(edges.get(link.fromBotId) ?? []), link.toBotId]);
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new HandoffError('cycle_detected', 'Automatic links cannot form a cycle. Use a loop instead.');
    if (visited.has(id)) return;
    visiting.add(id); for (const next of edges.get(id) ?? []) visit(next); visiting.delete(id); visited.add(id);
  }
  for (const id of edges.keys()) visit(id);
}
export interface TargetBot { id: string; userId: string; kind?: string; hidden?: boolean; helperOfBotId?: string; isConfiguring?: boolean; active?: boolean }
export function assertHandoffAllowed(input: {
  userId: string; fromBotId: string; target?: TargetBot; settings: HandoffSettings;
  links: readonly Pick<HandoffLink, 'fromBotId' | 'toBotId' | 'mode'>[]; initiatedBy: 'user' | 'agent' | 'link' | 'loop';
  inLoop?: boolean; botHourlyCount?: number; userDailyCount?: number;
}): void {
  if (!input.settings.enabled) throw new HandoffError('disabled', 'Handoffs are disabled');
  if (input.inLoop && input.initiatedBy === 'agent') throw new HandoffError('loop_nested', 'This run is part of a loop. Return your result; the loop passes it on.');
  const target = input.target;
  if (!target || target.userId !== input.userId || target.kind === 'room' || target.active === false || target.isConfiguring
    || (target.hidden && target.helperOfBotId !== input.fromBotId) || (target.id === input.fromBotId && input.initiatedBy !== 'loop')) {
    throw new HandoffError('target_not_allowed', 'Choose an active agent on your team that has finished setup');
  }
  if (input.initiatedBy === 'agent') {
    const linked = input.links.some(l => l.fromBotId === input.fromBotId && l.toBotId === target.id && l.mode !== 'off');
    if (input.settings.agentHandoffs === 'off' || (input.settings.agentHandoffs === 'links_only' && !linked)) throw new HandoffError('policy_denied', 'This handoff is not allowed by your agent policy');
    if ((input.botHourlyCount ?? 0) >= 20 || (input.userDailyCount ?? 0) >= 100) throw new HandoffError('rate_limited', 'Handoff limit reached. Try again later.');
  }
}
