import { z } from 'zod';
import { DEFAULT_CONFIG, type UiConfig } from './schema.js';
import { NAV_IDS } from './registry-nav.js';
import { plainText } from './registry-widgets.js';
import { patchSchema, previewPatch } from './patch.js';
import { equal } from './summarize.js';
import { jsonSize, schemaErrors } from './errors.js';
import type { PatchOp, Violation } from './service.js';
import { ADAPT_KEYWORDS, FOCUS_IDS, LENS_IDS, type LensId } from './adapt-keywords.js';
import { ADAPT_LENSES } from './adapt-lenses.js';

/** Reject identifiers and credentials rather than silently storing a redacted guess. */
export function containsPrivateData(text: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:sk|pk|ghp|gho|xoxb|xoxp)[-_][a-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|\b(?:password|secret|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+|-----BEGIN|\b\d{3}-\d{2}-\d{4}\b|(?:\+\d[\d ().-]{7,}\d)|\b(?:\d[ -]?){13,19}\b|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(text);
}
const text = (max: number) => plainText(max, 1).refine(s => s.trim().length > 0, 'Enter a short label.').refine(s => !containsPrivateData(s), 'Leave out secrets and personal identifiers.');
export const requirementsFieldsSchema = z.object({
  role: text(60), goals: z.array(text(120)).max(6),
  workflows: z.array(z.object({ name: text(80), cadence: z.enum(['daily', 'weekly', 'monthly', 'ad_hoc']) }).strict()).max(8),
  focus: z.array(z.enum(FOCUS_IDS)).max(8).refine(v => new Set(v).size === v.length, 'Choose each focus once.'),
  lens: z.enum(LENS_IDS).optional(),
}).strict();
export const requirementsProfileSchema = requirementsFieldsSchema.extend({
  version: z.literal(1), updatedAt: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  updatedBy: z.enum(['agent', 'user', 'reset']), managedPaths: z.array(z.string().max(200).regex(/^\/(layout|dashboards)\//)).max(100),
}).strict().superRefine((profile, ctx) => {
  const bytes = jsonSize(profile);
  if (bytes === null || bytes > 8192) ctx.addIssue({ code: 'custom', message: 'Requirements must fit in 8 KB.' });
});
export type RequirementsProfile = z.infer<typeof requirementsProfileSchema>;
export type RequirementsFields = z.infer<typeof requirementsFieldsSchema>;
export interface AdaptationState { doc: UiConfig; managedPaths: string[]; dashboardId: string; }
export const EMPTY_REQUIREMENTS: RequirementsFields = { role: 'General', goals: [], workflows: [], focus: [] };
const fail = (message: string, path = '', code: Violation['code'] = 'invalid_value') => ({ ok: false as const, errors: [{ code, path, message }] });

/** Restricted RFC 6902 on editable fields. Metadata can only be assigned by the service. */
export function patchRequirements(current: RequirementsFields | null, raw: unknown): { ok: true; fields: RequirementsFields; diff: string[] } | { ok: false; errors: Violation[] } {
  if ((jsonSize(raw) ?? Infinity) > 8192) return fail('Requirements patch must fit in 8 KB.', '', 'limit_exceeded');
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.error) };
  const before = structuredClone(current ?? EMPTY_REQUIREMENTS), doc = structuredClone(before) as unknown as Record<string, unknown>;
  const keys = (path: string) => {
    if (!/^\/(?:role|goals|workflows|focus|lens)(?:\/(?:0|[1-9]\d*|-)(?:\/(?:name|cadence))?)?$/.test(path)) throw new Error('Only role, goals, workflows, focus and lens can be edited.');
    return path.slice(1).split('/');
  };
  function node(path: string) {
    const parts = keys(path), key = parts.pop()!; let parent: any = doc;
    for (const part of parts) { if (!parent || !Object.hasOwn(parent, part)) throw new Error('The requirements path does not exist.'); parent = parent[part]; }
    if (!parent || typeof parent !== 'object') throw new Error('The requirements path does not exist.');
    if (Array.isArray(parent) && (key !== '-' && (!/^\d+$/.test(key) || Number(key) > parent.length))) throw new Error('The array index does not exist.');
    return { parent, key: key === '-' && Array.isArray(parent) ? String(parent.length) : key };
  }
  function write(op: 'add' | 'replace' | 'remove', path: string, value?: unknown) {
    const { parent, key } = node(path);
    if (op !== 'add' && !Object.hasOwn(parent, key)) throw new Error('The requirements path does not exist.');
    if (Array.isArray(parent) && op === 'add') parent.splice(Number(key), 0, structuredClone(value));
    else if (Array.isArray(parent) && op === 'remove') parent.splice(Number(key), 1);
    else if (op === 'remove') delete parent[key]; else parent[key] = structuredClone(value);
  }
  try {
    for (const op of parsed.data) {
      if (op.op === 'test') { const { parent, key } = node(op.path); if (!Object.hasOwn(parent, key) || !equal(parent[key], op.value)) return fail('Requirements changed. Reload and try again.', op.path, 'stale_revision'); }
      else if (op.op === 'move') {
        if (op.path.startsWith(`${op.from}/`)) return fail('Cannot move a field inside itself.', op.path, 'invalid_patch');
        const { parent, key } = node(op.from); if (!Object.hasOwn(parent, key)) throw new Error('The requirements path does not exist.');
        const value = structuredClone(parent[key]); write('remove', op.from); write('add', op.path, value);
      } else write(op.op, op.path, 'value' in op ? op.value : undefined);
    }
  } catch (error) { return fail((error as Error).message, '', 'invalid_patch'); }
  const fields = requirementsFieldsSchema.safeParse(doc);
  if (!fields.success) return { ok: false, errors: schemaErrors(fields.error) };
  const names = { role: 'Role', goals: 'Goals', workflows: 'Workflows', focus: 'Focus', lens: 'Lens' } as const;
  const diff = (Object.keys(names) as (keyof typeof names)[]).filter(key => !equal(before[key], fields.data[key])).map(key => `${names[key]} updated`);
  return { ok: true, fields: fields.data, diff };
}

export function selectLens(profile: RequirementsFields): { lens: LensId; rationale: string[]; question?: string; scores: Record<LensId, number> } {
  const words = ` ${[profile.role, ...profile.goals, ...profile.workflows.map(w => w.name)].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const scores = Object.fromEntries(LENS_IDS.map(id => [id, ADAPT_KEYWORDS[id].focus.filter(f => profile.focus.includes(f)).length * 3 + ADAPT_KEYWORDS[id].words.filter(w => words.includes(` ${w} `)).length])) as Record<LensId, number>;
  const ranked = [...LENS_IDS].filter(id => id !== 'general').sort((a, b) => scores[b] - scores[a]);
  const uncertain = scores[ranked[0]] < 3 || scores[ranked[0]] === scores[ranked[1]];
  const lens = profile.lens ?? (uncertain ? 'general' : ranked[0]);
  const matches = ADAPT_KEYWORDS[lens].words.filter(w => words.includes(` ${w} `));
  return { lens, scores, rationale: [matches.length ? `${ADAPT_LENSES[lens].label} because you said ${matches.slice(0, 3).join(', ')}.` : ADAPT_LENSES[lens].rationale],
    ...(!profile.lens && uncertain ? { question: 'Which kind of work should your home focus on?' } : {}) };
}
const read = (doc: UiConfig, path: string): unknown => path.slice(1).split('/').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined, doc);

/** No clocks, randomness, I/O, mutation or model text in the generated configuration. */
export function adaptFromRequirements(profile: RequirementsProfile | null, config: UiConfig, previous?: AdaptationState) {
  if (profile) { const parsed = requirementsProfileSchema.safeParse(profile); if (!parsed.success) return { ok: false as const, errors: schemaErrors(parsed.error) }; }
  const selection = selectLens(profile ?? EMPTY_REQUIREMENTS), lens = ADAPT_LENSES[selection.lens];
  const patch: PatchOp[] = [], managedPaths: string[] = [], kept: { path: string; label: string; message: string }[] = [];
  let dashboardId = previous?.dashboardId ?? 'd_adapthom';
  if (!previous) { let n = 0; while (config.dashboards.some(d => d.id === dashboardId)) dashboardId = `d_ad${(++n).toString(36).padStart(6, '0')}`; }
  const index = config.dashboards.findIndex(d => d.id === dashboardId);
  const keep = (path: string, label: string) => kept.push({ path, label, message: `${label}: kept as you set it` });
  const propose = (path: string, value: unknown, label: string, baselinePath = path) => {
    const current = read(config, path);
    const allowed = previous ? previous.managedPaths.includes(baselinePath) && equal(current, read(previous.doc, baselinePath)) : equal(current, read(DEFAULT_CONFIG, path));
    if (!allowed) { keep(path, label); return; }
    managedPaths.push(path);
    if (!equal(current, value)) patch.push({ op: current === undefined ? 'add' : 'replace', path, value });
  };
  if (profile) {
    const dashboard = { ...structuredClone(lens.home), id: dashboardId };
    const used = new Set(config.dashboards.filter(d => d.id !== dashboardId).flatMap(d => d.widgets.map(w => w.id)));
    dashboard.widgets.forEach((w, i) => { let n = i; while (used.has(w.id)) w.id = `w_ad${(++n).toString(36).padStart(6, '0')}`; used.add(w.id); });
    const oldIndex = previous?.doc.dashboards.findIndex(d => d.id === dashboardId) ?? -1;
    if (index >= 0) propose(`/dashboards/${index}`, dashboard, 'Home dashboard', `/dashboards/${oldIndex}`);
    else if (previous) keep('/dashboards', 'Home dashboard');
    else if (config.dashboards.length >= 12) keep('/dashboards', 'Dashboard limit');
    else { patch.push({ op: 'add', path: '/dashboards/-', value: dashboard }); managedPaths.push(`/dashboards/${config.dashboards.length}`); }
    if (index >= 0 || managedPaths.some(p => p.startsWith('/dashboards/'))) propose('/layout/home', { kind: 'dashboard', dashboardId }, 'Home');
    const promoted = lens.promoted.filter((id): id is typeof NAV_IDS[number] => (NAV_IDS as readonly string[]).includes(id));
    const order = [...new Set([...promoted, ...DEFAULT_CONFIG.layout.sidebar.order])];
    propose('/layout/sidebar/order', order, 'Sidebar order');
    // Only promote registered phone targets. Settings remains required in every recipe.
    const tabIds = new Set(['bots', 'tasks', 'search', 'settings', 'routines', 'usage', 'files']);
    const tabs: string[] = [...new Set(promoted.map(id => id === 'allBots' ? 'bots' : id).filter(id => tabIds.has(id)))];
    if (index >= 0 || managedPaths.some(p => p.startsWith('/dashboards/'))) tabs.splice(1, 0, `dashboard:${dashboardId}`);
    for (const tab of ['bots', 'tasks', 'search']) if (tabs.length < 3 && !tabs.includes(tab)) tabs.push(tab);
    propose('/layout/phoneTabs', [...tabs.slice(0, 3), 'more', 'settings'], 'Phone tabs');
  }
  const validated = previewPatch(config, patch, { ctx: {} });
  if (!validated.ok) return validated;
  return { ok: true as const, patch, result: validated.result, ...selection, suggestions: { bots: lens.bots, templates: lens.templates, shortcuts: lens.shortcuts },
    managedPaths, kept, state: { doc: validated.result, managedPaths, dashboardId } satisfies AdaptationState };
}
