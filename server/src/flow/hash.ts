import { createHash } from 'node:crypto';

/** Object keys are unordered; array order is meaningful unless normalized by the caller. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function canonical(v: unknown): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'object' || !v) throw new TypeError('Expected a JSON value');
    if (seen.has(v)) throw new TypeError('Circular JSON value');
    seen.add(v);
    let result: unknown;
    if (Array.isArray(v)) result = v.map(canonical);
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError('Expected a JSON object');
      result = Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
    }
    seen.delete(v);
    return result;
  }
  return JSON.stringify(canonical(value));
}
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const hashValue = (value: unknown): string => sha256(canonicalJson(value));
export interface FlowHashInputs {
  instructions: string; skills: { id?: string; name: string; bodyHash: string }[];
  routines: { id: string; schedule: string; enabled: boolean }[];
  appIds: string[]; mcpIds: string[]; suggestionIds: string[];
  links: { id: string; fromBotId: string; toBotId: string; mode: string; trigger: string; template: string; autoApproveLoops?: boolean }[];
  bot: { name: string; avatar: unknown }; outputCounts: Record<string, number>; activeLoopIds: string[];
}
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => {
  const x = canonicalJson(a), y = canonicalJson(b); return x < y ? -1 : x > y ? 1 : 0;
});
export function inputsHash(input: FlowHashInputs): string {
  return hashValue({
    instructions: input.instructions, skills: sorted(input.skills.map(s => ({ id: s.id, name: s.name, bodyHash: s.bodyHash }))),
    routines: sorted(input.routines.map(r => ({ id: r.id, schedule: r.schedule, enabled: r.enabled }))),
    appIds: sorted(input.appIds), mcpIds: sorted(input.mcpIds), suggestionIds: sorted(input.suggestionIds),
    links: sorted(input.links.map(l => ({ id: l.id, fromBotId: l.fromBotId, toBotId: l.toBotId, mode: l.mode, trigger: l.trigger, template: l.template, autoApproveLoops: l.autoApproveLoops }))),
    bot: { name: input.bot.name, avatar: input.bot.avatar },
    outputCounts: Object.fromEntries(Object.entries(input.outputCounts).map(([key, n]) => [key, n <= 0 ? '0' : n === 1 ? '1' : n <= 5 ? '2-5' : '6+'])),
    activeLoopIds: sorted(input.activeLoopIds),
  });
}
export function stepsHash(instructions: string, skills: FlowHashInputs['skills']): string {
  return hashValue({ instructions, skills: sorted(skills.map(s => ({ id: s.id, name: s.name, bodyHash: s.bodyHash }))) });
}
