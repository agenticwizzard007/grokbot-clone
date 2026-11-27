import { z } from 'zod';
import type { UiConfig } from './schema.js';
import { plainText } from './registry-widgets.js';
import { patchSchema } from './patch.js';
import { equal } from './summarize.js';
import { jsonSize, schemaErrors } from './errors.js';
import type { PatchOp, Violation } from './service.js';
import { FOCUS_IDS, LENS_IDS } from './adapt-keywords.js';
import { dashboardWidgets } from './adapt-lenses.js';

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
export const EMPTY_REQUIREMENTS: RequirementsFields = { role: 'General', goals: [], workflows: [], focus: [] };
const fail = (message: string, path = '', code: Violation['code'] = 'invalid_value') => ({ ok: false as const, errors: [{ code, path, message }] });

/** Restricted RFC 6902 on editable fields. Metadata can only be assigned by the service. */
export function patchRequirements(current: RequirementsFields | null, raw: unknown): { ok: true; fields: RequirementsFields; diff: string[] } | { ok: false; errors: Violation[] } {
  if ((jsonSize(raw) ?? Infinity) > 8192) return fail('Requirements patch must fit in 8 KB.', '', 'limit_exceeded');
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.error) };
  const before = structuredClone(current ?? EMPTY_REQUIREMENTS), doc = structuredClone(before) as unknown as Record<string, unknown>;
  const keys = (path: string) => {
    if (!/^\/(?:role|goals|workflows|focus)(?:\/(?:0|[1-9]\d*|-)(?:\/(?:name|cadence))?)?$/.test(path)) throw new Error('Only role, goals, workflows and focus can be edited.');
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

/** A profile can only propose one new dashboard. All ids are assigned by previewPatch. */
export function suggestDashboardFromRequirements(profile: RequirementsProfile) {
  const parsed = requirementsProfileSchema.safeParse(profile);
  if (!parsed.success) return { ok: false as const, errors: schemaErrors(parsed.error) };
  const fields = parsed.data;
  const name = (fields.role === 'General' ? fields.goals[0] || fields.role : fields.role).trim().slice(0, 40);
  const dashboard = { id: '$new1', name, icon: 'layout-dashboard' as const, description: '', widgets: dashboardWidgets(fields) };
  const patch: PatchOp[] = [{ op: 'add', path: '/dashboards/-', value: dashboard }];
  return { ok: true as const, patch, title: `Add dashboard: ${name}`, widgets: dashboard.widgets.map(widget => widget.title!) };
}

/** Compatibility for callers from UC-I: this function can no longer write layout. */
export function adaptFromRequirements(profile: RequirementsProfile | null, _config?: UiConfig) {
  return profile ? suggestDashboardFromRequirements(profile) : fail('Save your profile first.');
}
