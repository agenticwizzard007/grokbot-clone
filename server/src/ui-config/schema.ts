import { z } from 'zod';
import { SEED_IDS, DERIVED_IDS } from './registry-tokens.js';
import { FONT_IDS } from './registry-fonts.js';
import { COMPONENT_IDS, COMPONENTS } from './registry-components.js';
import { NAV_IDS } from './registry-nav.js';
import { SHORTCUT_IDS, SHORTCUTS, normalizeShortcut, isReservedShortcut } from './registry-shortcuts.js';
import { SOURCE_IDS, SOURCE_PARAMS, SOURCES, botIdSchema } from './registry-sources.js';
import { WIDGET_TYPES, WIDGET_OPTIONS, WIDGETS, DASHBOARD_ICONS, plainText } from './registry-widgets.js';
import { jsonSize } from './errors.js';

export const LIMITS = { documentBytes: 256 * 1024, warningBytes: 128 * 1024, dashboards: 12, widgets: 24, agentWidgets: 12, dashboardName: 40, widgetTitle: 60, note: 2000, pinned: 8, keybindings: 24, patchOps: 100, patchBytes: 64 * 1024, depth: 12, presets: 20, history: 50, historyDays: 90, previewTtlMs: 15 * 60 * 1000 } as const;
export const hexColorSchema = z.string().regex(/^#[\da-f]{6}$/i).transform(s => s.toUpperCase());
export const dashboardIdSchema = z.string().regex(/^d_[a-z0-9]{8}$/);
export const widgetIdSchema = z.string().regex(/^w_[a-z0-9]{8}$/);
export const densitySchema = z.enum(['compact', 'default', 'comfortable']);
export const scaleSchema = z.enum(['default', 'large', 'xlarge']);
const seedMap = z.partialRecord(z.enum(SEED_IDS), hexColorSchema);
const overrideMap = z.partialRecord(z.enum(DERIVED_IDS), hexColorSchema);
export const themeSchema = z.object({
  mode: z.enum(['light', 'dark', 'system']), colors: z.object({ light: seedMap, dark: seedMap }).strict(),
  overrides: z.object({ light: overrideMap, dark: overrideMap }).strict(),
  font: z.object({ ui: z.enum(FONT_IDS), heading: z.enum(['instrument', 'same', ...FONT_IDS]), scale: scaleSchema }).strict(),
  density: densitySchema, radius: z.enum(['sharp', 'default', 'round']), motion: z.enum(['system', 'reduced']), contrast: z.enum(['normal', 'high']),
}).strict();
const homeSchema = z.union([z.object({ kind: z.enum(['default', 'bots', 'tasks']) }).strict(), z.object({ kind: z.literal('dashboard'), dashboardId: dashboardIdSchema }).strict()]);
const phoneTab = z.union([z.enum(['bots', 'tasks', 'search', 'settings', 'routines', 'usage', 'files', 'more']), z.string().regex(/^dashboard:d_[a-z0-9]{8}$/)]);
export const layoutSchema = z.object({
  sidebar: z.object({ collapsed: z.boolean().nullable(), width: z.enum(['narrow', 'default', 'wide']), order: z.array(z.enum(NAV_IDS)).max(NAV_IDS.length), hidden: z.array(z.enum([...NAV_IDS, 'all'])).max(NAV_IDS.length) }).strict(),
  home: homeSchema, phoneTabs: z.array(phoneTab).min(3).max(5), chat: z.object({ width: z.enum(['default', 'wide']) }).strict(),
  pinned: z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('dashboard'), id: dashboardIdSchema }).strict(), z.object({ type: z.literal('bot'), id: botIdSchema }).strict()])).max(LIMITS.pinned),
}).strict();
export const widgetSchema = z.object({
  id: widgetIdSchema, type: z.enum(WIDGET_TYPES), title: plainText(60).optional(), span: z.number().int().min(1).max(12), rows: z.number().int().min(1).max(6),
  source: z.object({ id: z.enum(SOURCE_IDS), params: z.record(z.string(), z.unknown()) }).strict().optional(),
  options: z.record(z.string(), z.unknown()), refreshSec: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(300)]).optional(),
}).strict().superRefine((widget, ctx) => {
  const options = WIDGET_OPTIONS[widget.type].safeParse(widget.options);
  if (!options.success) for (const issue of options.error.issues) ctx.addIssue({ ...issue, path: ['options', ...issue.path] });
  const allowed = WIDGETS.find(w => w.id === widget.type)!.sources;
  if (!widget.source) { if (allowed.length) ctx.addIssue({ code: 'custom', path: ['source'], message: 'Choose a registered source for this widget.' }); return; }
  if (!allowed.includes(widget.source.id)) ctx.addIssue({ code: 'custom', path: ['source', 'id'], message: 'This source is not available for this widget.' });
  const params = SOURCE_PARAMS[widget.source.id].safeParse(widget.source.params);
  if (!params.success) for (const issue of params.error.issues) ctx.addIssue({ ...issue, path: ['source', 'params', ...issue.path] });
  const fields = SOURCES.find(s => s.id === widget.source!.id)!.fields;
  if (options.success) for (const key of ['field', 'fields', 'columns']) {
    const value = widget.options[key];
    const selected = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    if (selected.some(f => !fields.includes(f)) || new Set(selected).size !== selected.length) ctx.addIssue({ code: 'custom', path: ['options', key], message: 'Choose unique fields from this source.' });
    if (widget.type === 'stat' && ['needsYou.list', 'bots.status'].includes(widget.source.id) && value !== 'count' && key === 'field') ctx.addIssue({ code: 'custom', path: ['options', key], message: 'Use count for this list source.' });
  }
});
export const dashboardSchema = z.object({ id: dashboardIdSchema, name: plainText(40, 1), icon: z.enum(DASHBOARD_ICONS), description: plainText(200).optional(), widgets: z.array(widgetSchema).max(LIMITS.widgets) }).strict().refine(d => d.widgets.filter(w => w.type === 'agent').length <= LIMITS.agentWidgets, { path: ['widgets'], message: 'Use at most 12 agent widgets per dashboard.', params: { code: 'limit_exceeded' } });
export const uiConfigShape = z.object({
  $schema: z.literal('/api/ui/schema').optional(), version: z.literal(1), preset: z.string().regex(/^(?:swarm|midnight|paper|forest|contrast|focus|calm|colorblind|p_[a-z0-9]{8})$/),
  theme: themeSchema, layout: layoutSchema, components: z.partialRecord(z.enum(COMPONENT_IDS), z.enum(['show', 'hide', 'collapsed'])),
  keybindings: z.partialRecord(z.enum(SHORTCUT_IDS), z.string().max(40).nullable()), dashboards: z.array(dashboardSchema).max(LIMITS.dashboards),
  device: z.object({ phone: z.object({ density: densitySchema.optional(), scale: scaleSchema.optional() }).strict().optional() }).strict().optional(), policy: z.object({}).strict(),
}).strict();
export const uiConfigSchema = uiConfigShape.superRefine((doc, ctx) => {
  const issue = (path: (string | number)[], message: string, code = 'invalid_value') => ctx.addIssue({ code: 'custom', path, message, params: { code } });
  const unique = (values: string[], path: (string | number)[]) => { if (new Set(values).size !== values.length) issue(path, 'Items must be unique.'); };
  const bytes = jsonSize(doc);
  if (bytes === null) issue([], 'Use JSON values within the depth limit.');
  else if (bytes > LIMITS.documentBytes) issue([], 'The document exceeds 256 KB.', 'limit_exceeded');
  if (!doc.layout.sidebar.order.includes('settings')) issue(['layout', 'sidebar', 'order'], 'Settings must stay in the sidebar.', 'required_item');
  if (doc.layout.sidebar.hidden.includes('all')) issue(['layout', 'sidebar', 'hidden'], 'All sections cannot be hidden.', 'required_item');
  if (doc.layout.sidebar.hidden.includes('settings')) issue(['layout', 'sidebar', 'hidden'], 'Settings cannot be hidden.', 'required_item');
  if (!doc.layout.phoneTabs.includes('settings')) issue(['layout', 'phoneTabs'], 'Settings must stay in phone tabs.', 'required_item');
  if (doc.layout.phoneTabs.filter(x => x.startsWith('dashboard:')).length > 1) issue(['layout', 'phoneTabs'], 'Only one dashboard can be a phone tab.');
  unique(doc.layout.sidebar.order, ['layout', 'sidebar', 'order']); unique(doc.layout.sidebar.hidden, ['layout', 'sidebar', 'hidden']); unique(doc.layout.phoneTabs, ['layout', 'phoneTabs']);
  unique(doc.layout.pinned.map(p => `${p.type}:${p.id}`), ['layout', 'pinned']); unique(doc.dashboards.map(d => d.id), ['dashboards']);
  unique(doc.dashboards.flatMap(d => d.widgets.map(w => w.id)), ['dashboards']);
  const ids = new Set(doc.dashboards.map(d => d.id));
  const reference = (id: string, path: (string | number)[]) => { if (!ids.has(id)) issue(path, 'Dashboard does not exist.', 'not_found'); };
  if (doc.layout.home.kind === 'dashboard') reference(doc.layout.home.dashboardId, ['layout', 'home', 'dashboardId']);
  doc.layout.pinned.forEach((p, i) => { if (p.type === 'dashboard') reference(p.id, ['layout', 'pinned', i, 'id']); });
  doc.layout.phoneTabs.forEach((tab, i) => { if (tab.startsWith('dashboard:')) reference(tab.slice(10), ['layout', 'phoneTabs', i]); });
  doc.dashboards.forEach((d, di) => d.widgets.forEach((w, wi) => {
    if (w.type === 'shortcuts' && Array.isArray(w.options.items)) w.options.items.forEach((item, i) => { if (typeof item?.target === 'string' && item.target.startsWith('dashboard:')) reference(item.target.slice(10), ['dashboards', di, 'widgets', wi, 'options', 'items', i, 'target']); });
  }));
  for (const [id, value] of Object.entries(doc.components)) if (!COMPONENTS.find(c => c.id === id)!.allowed.includes(value)) issue(['components', id], 'This component cannot be collapsed.');
  if (Object.keys(doc.keybindings).length > LIMITS.keybindings) issue(['keybindings'], 'Too many keyboard shortcuts.', 'limit_exceeded');
  const seen = new Set<string>();
  for (const shortcut of SHORTCUTS) {
    const raw = Object.hasOwn(doc.keybindings, shortcut.id) ? doc.keybindings[shortcut.id] : shortcut.default;
    if (raw == null) { if (shortcut.required) issue(['keybindings', shortcut.id], 'Settings must have a shortcut.', 'required_item'); continue; }
    const binding = normalizeShortcut(raw);
    if (!binding || isReservedShortcut(binding)) issue(['keybindings', shortcut.id], 'Use Mod or Alt and a non-reserved key.');
    else { if (seen.has(binding)) issue(['keybindings', shortcut.id], 'This shortcut is already in use.'); seen.add(binding); }
  }
});
export type UiConfig = z.infer<typeof uiConfigSchema>;
export type Widget = z.infer<typeof widgetSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
export const DEFAULT_CONFIG: UiConfig = { version: 1, preset: 'swarm', theme: { mode: 'system', colors: { light: {}, dark: {} }, overrides: { light: {}, dark: {} }, font: { ui: 'inter', heading: 'instrument', scale: 'default' }, density: 'default', radius: 'default', motion: 'system', contrast: 'normal' }, layout: { sidebar: { collapsed: null, width: 'default', order: ['allBots', 'tasks', 'files', 'dashboards', 'yourBots', 'createBot', 'usage', 'settings'], hidden: [] }, home: { kind: 'default' }, phoneTabs: ['bots', 'tasks', 'search', 'settings'], chat: { width: 'default' }, pinned: [] }, components: {}, keybindings: {}, dashboards: [], device: { phone: {} }, policy: {} };
