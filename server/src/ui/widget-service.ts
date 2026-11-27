import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { agentWidgetOptionsSchema, agentWidgetResultSchema, type AgentWidgetOptions, type AgentWidgetResult, type AgentWidgetSnapshot, type UiConfigService, type UiWidgetEvent } from '../ui-config/index.js';
import { uiAgentWidgetsEnabled } from './flags.js';

export class WidgetError extends Error {
  constructor(readonly code: 'not_found' | 'disabled' | 'rate_limited' | 'cost_cap' | 'invalid_value' | 'confirmation_required', message: string, readonly status: 404 | 422 | 429 = 422) { super(message); }
}
export interface WidgetRunInput { userId: string; botId: string; options: AgentWidgetOptions; signal: AbortSignal; checkBudget(): void; usage(tokens: number, cost: number): void }
export interface WidgetDependencies {
  run(input: WidgetRunInput): Promise<AgentWidgetResult>;
  accountAllowed(userId: string): boolean;
  accountCost(userId: string, since: number): number;
  validateResult?(userId: string, result: AgentWidgetResult): void;
  emit?(userId: string, event: UiWidgetEvent): void;
  clock?: () => number;
  timeoutMs?: number;
}
export class WidgetService {
  private active = new Map<string, Promise<void>>();
  readonly clock: () => number;
  constructor(readonly db: Database.Database, readonly config: UiConfigService, private deps: WidgetDependencies) { this.clock = deps.clock ?? Date.now; }
  enabled(userId: string) { return this.config.enabled(userId) && uiAgentWidgetsEnabled(this.db, userId); }
  touch(userId: string) { this.db.prepare('INSERT INTO ui_widget_activity(user_id,active_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET active_at=excluded.active_at').run(userId, this.clock()); }
  widget(userId: string, dashboardId: string, widgetId: string) {
    if (!this.enabled(userId)) throw new WidgetError('disabled', 'Agent widgets are disabled.', 404);
    const widget = this.config.get(userId).doc.dashboards.find(d => d.id === dashboardId)?.widgets.find(w => w.id === widgetId && w.type === 'agent');
    if (!widget) throw new WidgetError('not_found', 'Widget not found.', 404);
    return widget;
  }
  result(userId: string, dashboardId: string, widgetId: string): AgentWidgetSnapshot {
    this.widget(userId, dashboardId, widgetId);
    const r = this.db.prepare('SELECT * FROM ui_widget_results WHERE user_id=? AND dashboard_id=? AND widget_id=?').get(userId, dashboardId, widgetId) as any;
    return { dashboardId, widgetId, state: r?.state ?? 'empty', doc: r?.doc ? JSON.parse(r.doc) : null, runAt: r?.run_at ?? null, durationMs: r?.duration_ms ?? null, tokens: r?.tokens ?? 0, estimatedCostUsd: r?.estimated_cost_usd ?? 0, ...(r?.error ? { error: r.error } : {}) };
  }
  checkBudget(userId: string) {
    const pref = this.db.prepare('SELECT ui_widget_cost_cap_usd FROM account_preferences WHERE user_id=?').get(userId) as any;
    const cap = pref?.ui_widget_cost_cap_usd ?? 1;
    if (!this.deps.accountAllowed(userId) || !Number.isFinite(cap) || cap <= 0 || this.deps.accountCost(userId, this.clock() - 86400_000) >= cap)
      throw new WidgetError('cost_cap', 'Your account usage limit has been reached.', 429);
  }
  run(userId: string, dashboardId: string, widgetId: string): AgentWidgetSnapshot {
    const widget = this.widget(userId, dashboardId, widgetId), options = agentWidgetOptionsSchema.parse(widget.options);
    const bot = options.botId ? this.db.prepare('SELECT id FROM bots WHERE user_id=? AND id=?').get(userId, options.botId)
      : this.db.prepare("SELECT id FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND hidden=0 ORDER BY created_at,id LIMIT 1").get(userId);
    if (!bot) throw new WidgetError('not_found', 'Choose one of your Bots.', 404);
    const started = this.clock(), runId = randomUUID(), timeout = this.deps.timeoutMs ?? 30_000;
    this.db.transaction(() => {
      this.checkBudget(userId);
      this.db.prepare('UPDATE ui_widget_runs SET finished_at=? WHERE user_id=? AND finished_at IS NULL AND started_at<=?').run(started, userId, started - timeout);
      const quotas = this.db.prepare('SELECT SUM(started_at>?) hourly,COUNT(*) daily,SUM(finished_at IS NULL) running FROM ui_widget_runs WHERE user_id=? AND started_at>?').get(started - 3600_000, userId, started - 86400_000) as any;
      if (this.active.has(userId) || quotas.running || quotas.hourly >= 20 || quotas.daily >= 100) throw new WidgetError('rate_limited', 'Agent widget run limit reached. Try again later.', 429);
      this.db.prepare('DELETE FROM ui_widget_runs WHERE user_id=? AND started_at<=? AND finished_at IS NOT NULL').run(userId, started - 86400_000);
      this.db.prepare('INSERT INTO ui_widget_runs(id,user_id,dashboard_id,widget_id,started_at) VALUES(?,?,?,?,?)').run(runId, userId, dashboardId, widgetId, started);
      this.db.prepare("INSERT INTO ui_widget_results(user_id,dashboard_id,widget_id,state) VALUES(?,?,?,'running') ON CONFLICT(user_id,dashboard_id,widget_id) DO UPDATE SET state='running',error=NULL").run(userId, dashboardId, widgetId);
    }).immediate();
    const initial = this.result(userId, dashboardId, widgetId);
    this.deps.emit?.(userId, { type: 'ui_widget', dashboardId, widgetId, state: 'running' });
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>, tokens = 0, cost = 0;
    const usage = (n: number, c: number) => { if (!controller.signal.aborted) { tokens += Math.max(0, n); cost += Math.max(0, c); } };
    const task = (async () => {
      let doc: AgentWidgetResult | null = null, error: string | null = null;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => this.deps.run({ userId, botId: (bot as any).id, options, signal: controller.signal, checkBudget: () => this.checkBudget(userId), usage })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeout); }),
        ]);
        doc = agentWidgetResultSchema.parse(result); this.deps.validateResult?.(userId, doc);
      } catch { error = 'Could not read the answer. Try again.'; }
      finally { clearTimeout(timer!); controller.abort(); }
      const state = error ? 'error' : 'ready', duration = Math.max(0, this.clock() - started);
      this.db.transaction(() => {
        this.db.prepare('UPDATE ui_widget_runs SET finished_at=?,tokens=?,estimated_cost_usd=? WHERE user_id=? AND id=?').run(this.clock(), tokens, cost, userId, runId);
        // Deleted widgets cannot be resurrected by late model results.
        try { this.widget(userId, dashboardId, widgetId); } catch { this.db.prepare('DELETE FROM ui_widget_results WHERE user_id=? AND dashboard_id=? AND widget_id=?').run(userId, dashboardId, widgetId); return; }
        this.db.prepare('INSERT INTO ui_widget_history(user_id,dashboard_id,widget_id,doc,state,run_at,duration_ms,tokens,estimated_cost_usd) SELECT user_id,dashboard_id,widget_id,doc,CASE WHEN doc IS NULL THEN ? ELSE ? END,run_at,duration_ms,tokens,estimated_cost_usd FROM ui_widget_results WHERE user_id=? AND dashboard_id=? AND widget_id=? AND run_at IS NOT NULL').run('error','ready',userId,dashboardId,widgetId);
        this.db.prepare('DELETE FROM ui_widget_history WHERE user_id=? AND dashboard_id=? AND widget_id=? AND id NOT IN (SELECT id FROM ui_widget_history WHERE user_id=? AND dashboard_id=? AND widget_id=? ORDER BY id DESC LIMIT 5)').run(userId,dashboardId,widgetId,userId,dashboardId,widgetId);
        this.db.prepare('UPDATE ui_widget_results SET doc=?,state=?,run_at=?,duration_ms=?,tokens=?,estimated_cost_usd=?,error=? WHERE user_id=? AND dashboard_id=? AND widget_id=?').run(doc ? JSON.stringify(doc) : null,state,started,duration,tokens,cost,error,userId,dashboardId,widgetId);
      })();
      this.deps.emit?.(userId, { type: 'ui_widget', dashboardId, widgetId, state });
    })().finally(() => { this.active.delete(userId); });
    this.active.set(userId, task); return initial;
  }
  async idle(userId: string) { await this.active.get(userId); }
}
