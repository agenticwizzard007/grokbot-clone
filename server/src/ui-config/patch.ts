import { z } from 'zod';
import { uiConfigSchema, uiConfigShape, LIMITS, type UiConfig } from './schema.js';
import { WIDGET_OPTIONS } from './registry-widgets.js';
import { SOURCE_PARAMS } from './registry-sources.js';
import { checkAccessibility } from './contrast.js';
import { schemaErrors, jsonSize, pointer, violation } from './errors.js';
import { equal, summarize } from './summarize.js';
import type { PatchContext, PatchOp, PatchResult, Violation } from './service.js';
export const patchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal('replace'), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal('test'), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal('remove'), path: z.string() }).strict(),
  z.object({ op: z.literal('move'), path: z.string(), from: z.string() }).strict(),
]);
export const patchSchema = z.array(patchOpSchema).max(LIMITS.patchOps);
export function generateId(kind: 'dashboard' | 'widget'): string {
  let suffix = '';
  while (suffix.length < 8) { const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12)); for (const byte of bytes) if (byte < 252 && suffix.length < 8) suffix += (byte % 36).toString(36); }
  return `${kind === 'dashboard' ? 'd' : 'w'}_${suffix}`;
}
function parts(path: string): string[] | null {
  if (path === '') return [];
  if (!path.startsWith('/') || /~(?:[^01]|$)/.test(path)) return null;
  const result = path.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  return result.some(s => ['__proto__', 'prototype', 'constructor'].includes(s)) ? null : result;
}
function read(root: unknown, keys: string[]): { exists: boolean; value?: unknown } {
  let value = root;
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key) || Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) return { exists: false };
    value = (value as Record<string, unknown>)[key];
  }
  return { exists: true, value };
}
/** Resolve against schemas, including the selected widget's options and source params. */
function knownPath(keys: string[], doc: UiConfig): boolean {
  function walk(schema: z.ZodType, rest: string[], prefix: string[]): boolean {
    const s = schema as z.ZodType & { unwrap?: () => z.ZodType; shape?: Record<string, z.ZodType>; element?: z.ZodType; keyType?: z.ZodType; valueType?: z.ZodType; options?: z.ZodType[] };
    if (!rest.length) return true;
    if (s.unwrap && !s.element) return walk(s.unwrap(), rest, prefix);
    if (s.shape) {
      const [key, ...tail] = rest;
      let child = s.shape[key];
      const widget = prefix.length === 4 && prefix[0] === 'dashboards' && prefix[2] === 'widgets' ? read(doc, prefix).value as UiConfig['dashboards'][number]['widgets'][number] | undefined : undefined;
      if (widget && key === 'options') child = WIDGET_OPTIONS[widget.type];
      if (prefix.length === 5 && prefix[4] === 'source' && key === 'params') {
        const source = read(doc, prefix).value as { id: keyof typeof SOURCE_PARAMS } | undefined;
        if (source && SOURCE_PARAMS[source.id]) child = SOURCE_PARAMS[source.id];
      }
      return !!child && walk(child, tail, [...prefix, key]);
    }
    if (s.element) return /^(?:0|[1-9]\d*|-)$/.test(rest[0]) && walk(s.element, rest.slice(1), [...prefix, rest[0]]);
    if (s.keyType && s.valueType) return s.keyType.safeParse(rest[0]).success && walk(s.valueType, rest.slice(1), [...prefix, rest[0]]);
    if (s.options) return s.options.some(o => walk(o, rest, prefix));
    return false;
  }
  return walk(uiConfigShape, keys, []);
}
function pathHint(path: string): string {
  const top = path.split('/')[1], roots = ['theme', 'layout', 'components', 'keybindings', 'dashboards', 'device', 'preset'];
  if (top === 'theme') return 'Use /theme/mode, /theme/colors/light/primary, /theme/font/scale, or a registered token.';
  if (top === 'components') return 'Use a component id from REGISTRY.components, such as /components/sidebar.usage.';
  if (top === 'layout') return 'Use /layout/sidebar, /layout/home, /layout/phoneTabs, /layout/chat, or /layout/pinned.';
  return `Use a registered path: ${roots.map(x => '/' + x).join(', ')}.`;
}
export function previewPatch(current: UiConfig, ops: PatchOp[], opts: { autofix?: boolean; ctx: PatchContext }): PatchResult {
  const fail = (errors: Violation[]): PatchResult => ({ ok: false, errors });
  try {
    const bytes = jsonSize(ops, LIMITS.depth);
    if (bytes === null) return fail([violation('', 'invalid_patch', 'Use JSON patch values within the depth limit.')]);
    if (bytes > LIMITS.patchBytes || Array.isArray(ops) && ops.length > LIMITS.patchOps) return fail([violation('', 'limit_exceeded', 'A patch allows 100 operations and 64 KB.')]);
    const shape = patchSchema.safeParse(ops);
    if (!shape.success || shape.data.some(op => ['add', 'replace', 'test'].includes(op.op) && !Object.hasOwn(op, 'value'))) return fail([violation('', 'invalid_patch', 'Use add, replace, remove, move, or test with the required fields.')]);
    if (jsonSize(current) === null) return fail([violation('', 'invalid_value', 'The current document is not JSON.')]);
    const existing = uiConfigSchema.safeParse(current);
    if (!existing.success) return fail(schemaErrors(existing.error));
    let doc = structuredClone(existing.data);
    const idMap: Record<string, string> = {}, warnings: Violation[] = [], usedIds = new Set(doc.dashboards.flatMap(d => [d.id, ...d.widgets.map(w => w.id)]));
    let badId = false;
    function allocate(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(allocate); return; }
      if (!value || typeof value !== 'object') return;
      const obj = value as Record<string, unknown>;
      if (typeof obj.id === 'string' && /^\$new\d+$/.test(obj.id)) {
        const kind = Array.isArray(obj.widgets) ? 'dashboard' : typeof obj.type === 'string' && 'options' in obj ? 'widget' : null;
        if (kind) {
          if (idMap[obj.id]) { badId = true; return; }
          const id = (opts.ctx?.generateId ?? generateId)(kind);
          if (!(kind === 'dashboard' ? /^d_[a-z0-9]{8}$/ : /^w_[a-z0-9]{8}$/).test(id) || usedIds.has(id)) { badId = true; return; }
          idMap[obj.id] = id; usedIds.add(id);
        }
      }
      Object.values(obj).forEach(allocate);
    }
    shape.data.forEach(op => { if ('value' in op && op.op !== 'test') allocate(op.value); });
    if (badId) return fail([violation('', 'invalid_patch', 'New ids must be unique and server generated.')]);
    function substitute(v: unknown): unknown {
      if (typeof v === 'string') return v.replace(/\$new\d+\b/g, token => { if (!idMap[token]) badId = true; return idMap[token] ?? token; });
      if (Array.isArray(v)) return v.map(substitute);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x)]));
      return v;
    }
    const operations = substitute(shape.data) as PatchOp[];
    if (badId) return fail([violation('', 'invalid_patch', 'A temporary id must identify a new dashboard or widget in this patch.')]);
    const mutate = (keys: string[], op: 'add' | 'replace' | 'remove', value?: unknown): boolean => {
      if (!keys.length) { if (op === 'remove') return false; doc = structuredClone(value) as UiConfig; return true; }
      const parent = read(doc, keys.slice(0, -1));
      if (!parent.exists || !parent.value || typeof parent.value !== 'object') return false;
      const target = parent.value as Record<string, unknown>, key = keys.at(-1)!;
      if (Array.isArray(target)) {
        const index = key === '-' && op === 'add' ? target.length : /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
        if (index < 0 || index > target.length || op !== 'add' && index === target.length) return false;
        if (op === 'add') target.splice(index, 0, structuredClone(value)); else if (op === 'remove') target.splice(index, 1); else target[index] = structuredClone(value);
      } else {
        if (op !== 'add' && !Object.hasOwn(target, key)) return false;
        if (op === 'remove') delete target[key]; else target[key] = structuredClone(value);
      }
      return true;
    };
    for (const op of operations) {
      const keys = parts(op.path);
      if (!keys || !knownPath(keys, doc)) return fail([violation(op.path, 'unknown_path', 'This path is not customizable.', pathHint(op.path))]);
      if (op.op === 'test') { const value = read(doc, keys); if (!value.exists || !equal(value.value, op.value)) return fail([violation(op.path, 'invalid_patch', 'The test operation did not match.')]); continue; }
      if ((keys.at(-1) === 'id' && keys[0] === 'dashboards') || keys[0] === 'version' || keys[0] === '$schema') return fail([violation(op.path, 'invalid_value', 'This identifier is immutable.')]);
      if (op.op === 'move') {
        const from = parts(op.from);
        if (!from || !knownPath(from, doc)) return fail([violation(op.from, 'unknown_path', 'Unknown move source.', pathHint(op.from))]);
        if (from.at(-1) === 'id' && from[0] === 'dashboards') return fail([violation(op.from, 'invalid_value', 'This identifier is immutable.')]);
        if (keys.length > from.length && from.every((k, i) => keys[i] === k)) return fail([violation(op.path, 'invalid_patch', 'Cannot move a node into itself.')]);
        const source = read(doc, from);
        if (!source.exists) return fail([violation(op.from, 'unknown_path', 'Move source does not exist.', pathHint(op.from))]);
        if (equal(from, keys)) continue;
        if (!mutate(from, 'remove') || !mutate(keys, 'add', source.value)) return fail([violation(op.path, 'unknown_path', 'Move target does not exist.', pathHint(op.path))]);
      } else {
        const old = read(doc, keys).value as { id?: string } | undefined;
        if ('value' in op && old && typeof old === 'object' && old.id && keys[0] === 'dashboards' && [2, 4].includes(keys.length) && op.value && typeof op.value === 'object' && (op.value as { id?: string }).id !== old.id && op.op === 'replace') return fail([violation(op.path, 'invalid_value', 'Dashboard and widget ids are immutable.')]);
        if (!mutate(keys, op.op, 'value' in op ? op.value : undefined)) return fail([violation(op.path, 'unknown_path', 'The path does not exist.', pathHint(op.path))]);
      }
    }
    if ((jsonSize(doc) ?? Infinity) > LIMITS.documentBytes) return fail([violation('', 'limit_exceeded', 'The document exceeds its size or depth limit.')]);
    const parsed = uiConfigSchema.safeParse(doc);
    if (!parsed.success) return fail(schemaErrors(parsed.error));
    doc = parsed.data;
    if (opts.ctx?.botIds) {
      const botIds = new Set(opts.ctx.botIds);
      doc.layout.pinned = doc.layout.pinned.filter(p => { if (p.type !== 'bot' || botIds.has(p.id)) return true; warnings.push(violation('/layout/pinned', 'not_found', 'Removed a pin for an unavailable Bot.')); return false; });
      for (const [di, d] of doc.dashboards.entries()) for (const [wi, w] of d.widgets.entries()) {
        const refs: unknown[] = [w.source?.params.botId, w.options.botId];
        if (w.type === 'shortcuts' && Array.isArray(w.options.items)) for (const item of w.options.items) if (typeof item?.target === 'string' && /^(?:ask|bot):/.test(item.target)) refs.push(item.target.split(':')[1]);
        if (refs.some(id => typeof id === 'string' && !botIds.has(id))) return fail([violation(pointer(['dashboards', di, 'widgets', wi]), 'not_found', 'Bot does not exist.')]);
      }
    }
    let accessibility = checkAccessibility(doc);
    if (opts.autofix) for (let round = 0; round < 8 && accessibility.length; round++) {
      let changed = false;
      for (const error of accessibility) {
        if (!error.suggested) continue;
        const keys = parts(error.path)!;
        if (read(doc, keys).value === error.suggested) continue;
        mutate(keys, 'add', error.suggested); changed = true;
        warnings.push({ ...error, message: `Adjusted color to ${error.suggested} for contrast.` });
      }
      if (!changed) break;
      accessibility = checkAccessibility(doc);
    }
    if (accessibility.length) return fail(accessibility);
    const final = uiConfigSchema.safeParse(doc);
    if (!final.success) return fail(schemaErrors(final.error));
    if (jsonSize(doc)! > LIMITS.warningBytes) warnings.push(violation('', 'limit_exceeded', 'The document is larger than 128 KB.'));
    return { ok: true, result: final.data, summary: [...summarize(existing.data, final.data), ...warnings.filter(w => w.code === 'accessibility').map(w => w.message)], warnings, idMap };
  } catch { return fail([violation('', 'invalid_patch', 'The patch could not be processed. Check its JSON values and paths.')]); }
}
