import type Database from 'better-sqlite3';
import { widgetActionSchema, type AgentWidgetResult, type WidgetAction, type UiConfigService } from '../ui-config/index.js';
import { WidgetError, type WidgetService } from './widget-service.js';

export const WIDGET_OPEN_ROUTES = ['#bots', '#tasks', '#files', '#search', '#dashboards', '#usage', '#settings', '#settings/appearance', '#settings/apps', '#apps/connect', '#loops'] as const;
export interface ActionDependencies {
  needsYou(userId: string): { id: string; type: string }[];
  approve(userId: string, approvalId: string): unknown;
}
export class WidgetActions {
  constructor(private db: Database.Database, private config: UiConfigService, private deps: ActionDependencies) {}
  validate(userId: string, raw: unknown): WidgetAction {
    const parsed = widgetActionSchema.safeParse(raw);
    if (!parsed.success) throw new WidgetError('invalid_value', 'Invalid widget action.');
    const action = parsed.data;
    const ownBot = (id: string) => !!this.db.prepare('SELECT 1 FROM bots WHERE user_id=? AND id=?').get(userId, id);
    if (action.type === 'open') {
      const bot = /^#bot\/([a-zA-Z0-9_-]+)$/.exec(action.route);
      const dash = /^#dash\/(d_[a-z0-9]{8})$/.exec(action.route);
      if (!(WIDGET_OPEN_ROUTES as readonly string[]).includes(action.route) && !(bot && ownBot(bot[1])) && !(dash && this.config.get(userId).doc.dashboards.some(d => d.id === dash[1]))) throw new WidgetError('not_found', 'Destination not found.', 404);
    } else if (action.type === 'send') {
      if (!ownBot(action.botId)) throw new WidgetError('not_found', 'Bot not found.', 404);
    } else if (!this.deps.needsYou(userId).some(item => item.id === action.itemId && item.type === 'approval')) {
      throw new WidgetError('not_found', 'Approval not found.', 404);
    }
    return action;
  }
  validateResult(userId: string, result: AgentWidgetResult) {
    if (result.kind === 'list') for (const row of result.rows) if (row.action) this.validate(userId, row.action);
  }
  perform(widgets: WidgetService, userId: string, dashboardId: string, widgetId: string, raw: unknown, confirm = false) {
    const result = widgets.result(userId, dashboardId, widgetId), action = this.validate(userId, raw);
    const present = result.doc?.kind === 'list' && result.doc.rows.some(row => row.action && JSON.stringify(row.action) === JSON.stringify(action));
    if (!present) throw new WidgetError('not_found', 'Action not found. Refresh the widget.', 404);
    if (action.type === 'approve' && confirm !== true) throw new WidgetError('confirmation_required', 'Confirm this approval first.');
    return this.db.transaction(() => {
      // The only mutation path uses exactly the existing approval flow.
      const status = action.type === 'approve' ? this.deps.approve(userId, action.itemId.slice('approval:'.length)) : undefined;
      this.db.prepare('INSERT INTO ui_widget_actions(user_id,dashboard_id,widget_id,action_type,item_id,created_at) VALUES(?,?,?,?,?,?)').run(userId,dashboardId,widgetId,action.type,action.type === 'approve' ? action.itemId : null,widgets.clock());
      return { ok: true as const, action, ...(status === undefined ? {} : { status }) };
    })();
  }
}
