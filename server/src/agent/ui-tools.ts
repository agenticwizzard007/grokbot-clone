import { z } from 'zod';
import { DEFAULT_CONFIG, REGISTRY, type Dashboard, type PatchOp, type PreviewResult, type StoredPreview, type UiConfig, type UiConfigService, type UiPreviewCardBody, type Widget } from '../ui-config/index.js';
import type { ToolCtx, ToolDef } from './tools.js';

const plain = (max: number, min = 1) => z.string().min(min).max(max).regex(/^[^<>\u0000-\u001f\u007f\u2013\u2014]*$/u);
const id = z.string().min(1).max(100);
const dashboardId = z.string().regex(/^d_[a-z0-9]{8}$/);
const widgetId = z.string().regex(/^w_[a-z0-9]{8}$/);
const widgetType = z.enum(['stat', 'list', 'table', 'chart', 'meter', 'botStatus', 'taskBoard', 'routineSchedule', 'note', 'shortcuts']);
const source = z.object({ id, params: z.record(z.string(), z.unknown()).default({}) }).strict();
const widgetFields = {
  type: widgetType.optional(), title: plain(60, 0).optional(), source: source.optional(),
  options: z.record(z.string(), z.unknown()).optional(), span: z.number().int().min(1).max(12).optional(),
  rows: z.number().int().min(1).max(6).optional(), refreshSec: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(300)]).optional(),
};
const patchOp = z.union([
  z.object({ op: z.enum(['add', 'replace', 'test']), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal('remove'), path: z.string() }).strict(),
  z.object({ op: z.literal('move'), path: z.string(), from: z.string() }).strict(),
]);
export const UI_SCHEMAS = {
  get_ui_config: z.object({ scope: z.enum(['all', 'theme', 'layout', 'components', 'dashboards', 'dashboard']).optional(), dashboardId: dashboardId.optional() }).strict(),
  list_ui_options: z.object({ kind: z.enum(['tokens', 'fonts', 'components', 'nav', 'widgets', 'sources', 'shortcuts', 'presets', 'limits']) }).strict(),
  preview_ui_patch: z.object({ intent: plain(200), patch: z.array(patchOp).max(100), autofix: z.boolean().optional() }).strict(),
  apply_ui_patch: z.object({ previewId: id }).strict(),
  discard_ui_preview: z.object({ previewId: id }).strict(),
  undo_ui_change: z.object({ steps: z.number().int().min(1).max(10).optional() }).strict(),
  reset_ui: z.object({ scope: z.enum(['all', 'appearance', 'theme', 'layout', 'components', 'dashboards', 'dashboard']), dashboardId: dashboardId.optional() }).strict(),
  apply_preset: z.object({ presetId: id }).strict(),
  save_preset: z.object({ name: plain(40) }).strict(),
  set_accent: z.object({ color: z.string().regex(/^#[0-9a-f]{6}$/i) }).strict(),
  create_dashboard: z.object({ name: plain(40), icon: plain(40).optional(), template: z.enum(['blank', 'overview', 'tasks', 'usage', 'bot']).optional(), botId: id.optional(), pin: z.boolean().optional(), setAsHome: z.boolean().optional() }).strict(),
  add_widget: z.object({ dashboardId, ...widgetFields, type: widgetType, after: z.union([widgetId, z.literal('start')]).optional() }).strict(),
  update_widget: z.object({ dashboardId, widgetId, set: z.object(widgetFields).strict() }).strict(),
  remove_widget: z.object({ dashboardId, widgetId }).strict(),
  move_widget: z.object({ dashboardId, widgetId, after: z.union([widgetId, z.literal('start')]) }).strict(),
  delete_dashboard: z.object({ dashboardId }).strict(),
  rename_dashboard: z.object({ dashboardId, name: plain(40) }).strict(),
};
export type UiToolName = keyof typeof UI_SCHEMAS;
export const UI_TOOL_NAMES = new Set<string>(Object.keys(UI_SCHEMAS));

export interface UiToolDependencies {
  service: UiConfigService;
  allowed(ctx: ToolCtx): boolean;
  tainted(ctx: ToolCtx): boolean;
  card(ctx: ToolCtx, body: UiPreviewCardBody): void;
  syncCards?(ctx: ToolCtx): void;
  history?(userId: string): { summary: string | string[]; revision: number }[];
  presets?(userId: string): { id: string; doc: Partial<UiConfig> }[];
  savePreset?(userId: string, name: string): { presetId: string };
  accentPair(color: string): { light: string; dark: string };
  /** Durable failures supplement the per-context counter across approval resumes. */
  failures?(ctx: ToolCtx): number;
}
const failure = (code: string, message: string, path = '', hint?: string) => ({ ok: false as const, errors: [{ path, code, message, ...(hint ? { hint } : {}) }] });
class BuilderError extends Error { constructor(readonly path: string, message: string) { super(message); } }
const at = (doc: UiConfig, dashboard: string) => {
  const index = doc.dashboards.findIndex(d => d.id === dashboard);
  if (index < 0) throw new BuilderError('/dashboards', 'Dashboard not found. Read get_ui_config for current ids.');
  return { dashboard: doc.dashboards[index], index, path: `/dashboards/${index}` };
};
const widgetAt = (dashboard: Dashboard, widget: string) => {
  const index = dashboard.widgets.findIndex(w => w.id === widget);
  if (index < 0) throw new BuilderError('/dashboards', 'Widget not found. Read the dashboard for current ids.');
  return index;
};
const put = (path: string, value: unknown): PatchOp => ({ op: 'add', path, value });
const replace = (path: string, value: unknown): PatchOp => ({ op: 'replace', path, value });

/** Return only customized values, while retaining complete dashboard identities. */
export function withoutDefaults(value: unknown, defaults: unknown): unknown {
  if (JSON.stringify(value) === JSON.stringify(defaults)) return undefined;
  if (value && defaults && typeof value === 'object' && typeof defaults === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, val]) => {
      const diff = withoutDefaults(val, (defaults as Record<string, unknown>)[key]);
      return diff === undefined ? [] : [[key, diff]];
    }));
  }
  return value;
}

function widgetDefaults(type: Widget['type']): Omit<Widget, 'id'> {
  const base = { type, span: 12, rows: 3, options: {} };
  switch (type) {
    case 'stat': return { ...base, span: 4, rows: 1, source: { id: 'tasks.counts', params: {} }, options: { field: 'working', format: 'number' } };
    case 'list': return { ...base, source: { id: 'tasks.list', params: {} }, options: { limit: 5 } };
    case 'table': return { ...base, source: { id: 'tasks.list', params: {} }, options: { columns: ['title', 'state'], limit: 5 } };
    case 'chart': return { ...base, source: { id: 'usage.series', params: { range: '7d', metric: 'cost' } }, options: { kind: 'bar' } };
    case 'meter': return { ...base, rows: 1, source: { id: 'usage.windows', params: {} }, options: { window: 0 } };
    case 'botStatus': return { ...base, source: { id: 'bots.status', params: {} }, options: { limit: 6 } };
    case 'taskBoard': return { ...base, source: { id: 'tasks.list', params: {} } };
    case 'routineSchedule': return { ...base, source: { id: 'routines.upcoming', params: {} }, options: { days: 7 } };
    case 'note': return { ...base, options: { text: '' } };
    case 'shortcuts': return { ...base, rows: 1, options: { items: [{ label: 'Tasks', target: 'tasks' }] } };
  }
}
export function dashboardTemplate(template: string, botId?: string): Widget[] {
  const w = (type: Widget['type'], title: string, set: Partial<Widget> = {}): Widget => ({ id: '', ...widgetDefaults(type), title, ...set });
  let widgets: Widget[];
  switch (template) {
    case 'overview': widgets = [
      w('stat', 'Needs you', { source: { id: 'needsYou.list', params: {} }, options: { field: 'count', format: 'number' } }),
      w('stat', 'Spent this week', { source: { id: 'usage.summary', params: { range: '7d' } }, options: { field: 'costUsd', format: 'usd' } }),
      w('stat', 'Working now'), w('list', 'Open tasks', { span: 6, source: { id: 'tasks.list', params: { state: 'needs_input', limit: 10 } } }), w('chart', 'Cost by day', { span: 6 }),
    ]; break;
    case 'tasks': widgets = [w('taskBoard', 'Tasks'), w('list', 'Needs you', { source: { id: 'needsYou.list', params: {} } })]; break;
    case 'usage': widgets = [w('stat', 'Spent this week', { span: 12, source: { id: 'usage.summary', params: { range: '7d' } }, options: { field: 'costUsd', format: 'usd' } }), w('chart', 'Cost by day')]; break;
    case 'bot':
      if (!botId) throw new BuilderError('/botId', 'Choose a Bot for the bot template.');
      widgets = [w('stat', 'Working now', { span: 12, source: { id: 'tasks.counts', params: { botId } } }), w('list', 'Tasks', { source: { id: 'tasks.list', params: { botId } } })]; break;
    default: widgets = [];
  }
  return widgets.map((widget, i) => ({ ...widget, id: `$new${i + 2}` }));
}

/** Remove every dashboard reference in the same validated patch. */
export function deleteDashboardPatch(doc: UiConfig, dashboardId: string): PatchOp[] {
  const found = at(doc, dashboardId);
  const ops: PatchOp[] = [];
  if (doc.layout.home.kind === 'dashboard' && doc.layout.home.dashboardId === dashboardId) ops.push(replace('/layout/home', { kind: 'default' }));
  if (doc.layout.pinned.some(p => p.type === 'dashboard' && p.id === dashboardId)) ops.push(replace('/layout/pinned', doc.layout.pinned.filter(p => p.type !== 'dashboard' || p.id !== dashboardId)));
  if (doc.layout.phoneTabs.includes(`dashboard:${dashboardId}`)) {
    const tabs = doc.layout.phoneTabs.filter(t => t !== `dashboard:${dashboardId}`);
    for (const tab of ['bots', 'tasks', 'search']) if (tabs.length < 3 && !tabs.includes(tab)) tabs.splice(tabs.indexOf('settings'), 0, tab);
    ops.push(replace('/layout/phoneTabs', tabs));
  }
  doc.dashboards.forEach((dashboard, di) => dashboard.widgets.forEach((widget, wi) => {
    if (dashboard.id === dashboardId || widget.type !== 'shortcuts' || !Array.isArray(widget.options.items)) return;
    const items = widget.options.items as { label: string; target: string }[];
    if (items.some(item => item.target === `dashboard:${dashboardId}`)) ops.push(replace(`/dashboards/${di}/widgets/${wi}/options/items`, items.filter(item => item.target !== `dashboard:${dashboardId}`)));
  }));
  ops.push({ op: 'remove', path: found.path });
  return ops;
}

/** Builders contain no persistence. Both builders and raw patches use service.preview. */
export function buildUiPatch(name: UiToolName, args: any, doc: UiConfig, deps: Pick<UiToolDependencies, 'accentPair'>, presets: { id: string; doc: Partial<UiConfig> }[] = []): { patch: PatchOp[]; intent: string; autofix?: boolean } {
  switch (name) {
    case 'preview_ui_patch': return { patch: args.patch, intent: args.intent, autofix: args.autofix };
    case 'set_accent': {
      const colors = deps.accentPair(args.color);
      return { patch: [put('/theme/colors/light/primary', colors.light), put('/theme/colors/dark/primary', colors.dark)], intent: 'Change the accent color' };
    }
    case 'create_dashboard': {
      const dashboard = { id: '$new1', name: args.name, icon: args.icon ?? 'layout-dashboard', widgets: dashboardTemplate(args.template ?? 'blank', args.botId) };
      const patch: PatchOp[] = [put('/dashboards/-', dashboard)];
      if (args.pin) patch.push(put('/layout/pinned/-', { type: 'dashboard', id: '$new1' }));
      if (args.setAsHome) patch.push(replace('/layout/home', { kind: 'dashboard', dashboardId: '$new1' }));
      return { patch, intent: `Add dashboard ${args.name}` };
    }
    case 'rename_dashboard': return { patch: [replace(`${at(doc, args.dashboardId).path}/name`, args.name)], intent: `Rename dashboard to ${args.name}` };
    case 'delete_dashboard': return { patch: deleteDashboardPatch(doc, args.dashboardId), intent: 'Remove 1 dashboard' };
    case 'add_widget': {
      const { dashboard, path } = at(doc, args.dashboardId);
      const { dashboardId: _id, after, ...fields } = args;
      const index = after === 'start' ? 0 : after ? widgetAt(dashboard, after) + 1 : '-';
      return { patch: [put(`${path}/widgets/${index}`, { id: '$new1', ...widgetDefaults(args.type), ...fields })], intent: 'Add a dashboard widget' };
    }
    case 'update_widget': {
      const { dashboard, path } = at(doc, args.dashboardId), i = widgetAt(dashboard, args.widgetId);
      return { patch: Object.entries(args.set).map(([key, value]) => put(`${path}/widgets/${i}/${key}`, value)), intent: 'Update a dashboard widget' };
    }
    case 'remove_widget': {
      const { dashboard, path } = at(doc, args.dashboardId);
      return { patch: [{ op: 'remove', path: `${path}/widgets/${widgetAt(dashboard, args.widgetId)}` }], intent: 'Remove a dashboard widget' };
    }
    case 'move_widget': {
      const { dashboard, path } = at(doc, args.dashboardId), from = widgetAt(dashboard, args.widgetId);
      if (args.after === args.widgetId) return { patch: [], intent: 'Keep the widget in place' };
      const target = args.after === 'start' ? 0 : widgetAt(dashboard, args.after) + 1;
      const to = target > from ? target - 1 : target;
      return { patch: [{ op: 'move', from: `${path}/widgets/${from}`, path: `${path}/widgets/${to}` }], intent: 'Move a dashboard widget' };
    }
    case 'apply_preset': {
      const preset = presets.find(p => p.id === args.presetId);
      if (!preset) throw new BuilderError('/presetId', 'Preset not found. Use list_ui_options with kind presets.');
      const patch: PatchOp[] = [replace('/preset', preset.id)];
      const visit = (value: unknown, path: string) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) Object.entries(value).forEach(([key, val]) => visit(val, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
        else patch.push(put(path, value));
      };
      for (const key of ['theme', 'layout', 'components', 'keybindings'] as const) if (preset.doc[key]) visit(preset.doc[key], `/${key}`);
      return { patch, intent: 'Apply an appearance preset' };
    }
    case 'reset_ui': {
      if (args.scope === 'dashboard') {
        if (!args.dashboardId) throw new BuilderError('/dashboardId', 'Choose the dashboard to reset.');
        return { patch: deleteDashboardPatch(doc, args.dashboardId), intent: 'Reset dashboard. Removes 1 dashboard' };
      }
      if (args.scope === 'dashboards') {
        // Remove backwards so each reference cleanup uses the current array indices.
        const copy = structuredClone(doc), patch: PatchOp[] = [];
        for (const dashboard of [...copy.dashboards].reverse()) {
          patch.push(...deleteDashboardPatch(copy, dashboard.id));
          copy.dashboards.pop();
        }
        return { patch, intent: `Reset dashboards. Removes ${doc.dashboards.length} dashboards` };
      }
      const keys = args.scope === 'all' ? ['preset', 'theme', 'layout', 'components', 'keybindings', 'device', 'dashboards'] : args.scope === 'appearance' ? ['preset', 'theme', 'layout', 'components', 'keybindings', 'device'] : [args.scope];
      return { patch: keys.map(key => put(`/${key}`, structuredClone(DEFAULT_CONFIG[key as keyof UiConfig]))), intent: `Reset ${args.scope}. Removes ${args.scope === 'all' ? doc.dashboards.length : 0} dashboards` };
    }
    default: throw new Error(`No patch builder for ${name}`);
  }
}

const DESCRIPTIONS: Record<UiToolName, string> = {
  get_ui_config: 'Read your saved appearance, revision and last five history summaries. Unchanged defaults are omitted. Scope the read when possible; use dashboardId with scope dashboard.',
  list_ui_options: 'List registered appearance options by kind. Use these ids instead of guessing. Sources describe configuration only; no widget data is returned.',
  preview_ui_patch: 'Validate a minimal JSON Patch and show an appearance preview with Apply and Discard. New dashboard and widget ids may use $new1 placeholders. One new preview supersedes older previews. Repair errors at most three times.',
  apply_ui_patch: 'Apply a pending preview only in auto mode and before reading any outside content this turn. Otherwise returns awaiting_user; tell the user to press Apply on the card. A user saying apply cannot bypass ask mode.',
  discard_ui_preview: 'Discard your pending appearance preview without changing saved configuration.',
  undo_ui_change: 'Undo one to ten saved appearance changes. Restores an earlier configuration as a new revision.',
  reset_ui: 'Preview a reset. Ask whether to keep dashboards before a broad reset: appearance keeps them, all removes them. The preview states how many dashboards are removed.',
  apply_preset: 'Preview a registered or saved appearance preset. Read available ids with list_ui_options first.',
  save_preset: 'Save the current appearance as a named personal preset, without dashboards. Does not change the current appearance.',
  set_accent: 'Preview an accent color using a six-digit hex value. Chooses a shade for each mode so light and dark both remain readable.',
  create_dashboard: 'Preview a new dashboard from blank, overview, tasks, usage or bot. The bot template requires botId. Optionally pin it or use it as home. For compound custom dashboards use one preview_ui_patch.',
  add_widget: 'Preview adding a registered widget to a saved dashboard. Defaults are valid for each type. after is a widget id or start; omit it to append.',
  update_widget: 'Preview changing only the supplied widget fields. Read the dashboard first to obtain ids and current fields.',
  remove_widget: 'Preview removing one widget from a saved dashboard.',
  move_widget: 'Preview moving a widget after another widget, or to start. Uses current saved dashboard ids.',
  delete_dashboard: 'Preview deleting a dashboard and clearing its home, pinned, tab and shortcut references together.',
  rename_dashboard: 'Preview renaming a dashboard. Keeps its immutable id and references.',
};

export function createUiTools(deps: UiToolDependencies): ToolDef[] {
  const failures = new WeakMap<ToolCtx, number>();
  return Object.entries(UI_SCHEMAS).map(([toolName, schema]) => {
    const name = toolName as UiToolName;
    const { $schema: _schema, ...parameters } = z.toJSONSchema(schema, { io: 'input' });
    return { name, description: DESCRIPTIONS[name], parameters, activity: 'working', label: name.replace(/_/g, ' '), impl: async (raw: unknown, ctx: ToolCtx) => {
      let result: any;
      const fail = (error: unknown) => {
        failures.set(ctx, (failures.get(ctx) ?? 0) + 1);
        return error;
      };
      if (!deps.allowed(ctx)) result = failure('unavailable_context', 'Appearance tools are available only in direct user chats with personal Bots.');
      else if (!deps.service.enabled(ctx.userId)) result = failure('disabled', 'Appearance customization is disabled.');
      else {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) result = fail({ ok: false, errors: parsed.error.issues.map(issue => ({ path: `/${issue.path.join('/')}`, code: 'invalid_value', message: issue.message })) });
        else {
          const args: any = parsed.data, user = ctx.userId, actor = `agent:${ctx.botId}`;
          try {
            deps.syncCards?.(ctx);
            const saved = deps.service.get(user);
            switch (name) {
              case 'get_ui_config': {
                const scope = args.scope ?? 'all';
                const doc = scope === 'dashboard' ? at(saved.doc, args.dashboardId).dashboard : scope === 'all' ? withoutDefaults(saved.doc, DEFAULT_CONFIG) ?? {} : withoutDefaults(saved.doc[scope as keyof UiConfig], DEFAULT_CONFIG[scope as keyof UiConfig]) ?? (scope === 'dashboards' ? [] : {});
                result = { revision: saved.revision, doc, presetId: saved.doc.preset, history: (deps.history?.(user) ?? []).slice(0, 5).map(({ revision, summary }) => ({ revision, summary })) }; break;
              }
              case 'list_ui_options': result = { kind: args.kind, options: REGISTRY[args.kind as keyof typeof REGISTRY] }; break;
              case 'apply_ui_patch': {
                const preview = deps.service.getPreview(user, args.previewId);
                if (!preview) result = failure('not_found', 'Preview not found.');
                else if (preview.status === 'expired' || preview.expiresAt <= Date.now()) result = failure('preview_expired', 'Preview expired. Create a fresh preview.');
                else if (preview.status !== 'pending') result = failure('stale_preview', 'Preview is no longer pending.');
                else if (preview.baseRevision !== saved.revision) result = failure('stale_preview', 'Saved appearance changed. Read it again and create a fresh preview.');
                else if (deps.service.agentApplyMode(user) !== 'auto' || deps.tainted(ctx)) result = { status: 'awaiting_user' };
                else {
                  const applied = deps.service.applyPreview(user, args.previewId, actor);
                  result = applied.ok ? { status: 'applied', revision: applied.revision } : applied;
                }
                deps.syncCards?.(ctx); break;
              }
              case 'discard_ui_preview':
                if (!deps.service.getPreview(user, args.previewId)) result = failure('not_found', 'Preview not found.');
                else { deps.service.discardPreview(user, args.previewId); deps.syncCards?.(ctx); result = { ok: true }; }
                break;
              case 'undo_ui_change': {
                // Outside content cannot silently restore a saved phishing layout either.
                if (deps.tainted(ctx)) { result = { status: 'awaiting_user', message: 'Use Undo in Appearance history.' }; break; }
                const undo = deps.service.undo(user, args.steps ?? 1, actor);
                result = undo.ok ? { revision: undo.revision, summary: undo.summary } : undo; break;
              }
              case 'save_preset': result = deps.savePreset ? deps.savePreset(user, args.name) : failure('unavailable', 'Saving presets is unavailable.'); break;
              default: {
                if (Math.max(failures.get(ctx) ?? 0, deps.failures?.(ctx) ?? 0) >= 4) { result = failure('repair_limit', 'Three repairs were unsuccessful. Stop and ask the user how to proceed.'); break; }
                const built = buildUiPatch(name, args, saved.doc, deps, deps.presets?.(user));
                const preview: PreviewResult = deps.service.preview(user, built.patch, { intent: built.intent, actor, autofix: built.autofix });
                if (!preview.ok) { result = fail(preview); break; }
                deps.syncCards?.(ctx);
                deps.card(ctx, { card: 'ui_preview', previewId: preview.previewId, title: built.intent, lines: preview.summary.slice(0, 6), moreCount: Math.max(0, preview.summary.length - 6), warnings: preview.warnings.map(w => w.message), status: 'pending' });
                result = { previewId: preview.previewId, summary: preview.summary.slice(0, 6), moreCount: Math.max(0, preview.summary.length - 6), warnings: preview.warnings, applied: false, baseRevision: preview.baseRevision };
              }
            }
          } catch (error) {
            result = fail(error instanceof BuilderError ? failure('not_found', error.message, error.path) : failure('invalid_value', 'The appearance change could not be completed. Read the current config and try a smaller patch.'));
          }
        }
      }
      return { output: JSON.stringify(result), isError: result?.ok === false, ...(result?.errors?.[0]?.code === 'repair_limit' ? { endTurn: true } : {}) };
    } } satisfies ToolDef;
  });
}
