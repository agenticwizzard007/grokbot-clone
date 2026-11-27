import { agentWidgetOptionsSchema } from '../ui-config/index.js';
import type { WidgetService } from './widget-service.js';

/** One tick for the process, with an injectable clock via WidgetService. */
export class WidgetScheduler {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private widgets: WidgetService) {}
  tick(): number {
    const { db, clock, config } = this.widgets, now = clock(); let started = 0;
    if (!db.open) return 0;
    const users = db.prepare('SELECT user_id FROM ui_widget_activity WHERE active_at>=?').all(now - 7 * 86400_000) as { user_id: string }[];
    for (const { user_id: userId } of users) {
      if (!this.widgets.enabled(userId)) continue;
      const due: { dashboardId: string; widgetId: string; last: number }[] = [];
      for (const d of config.get(userId).doc.dashboards) for (const w of d.widgets) {
        if (w.type !== 'agent') continue;
        const opts = agentWidgetOptionsSchema.parse(w.options);
        if (opts.schedule === 'manual') continue;
        const last = db.prepare('SELECT MAX(started_at) last FROM ui_widget_runs WHERE user_id=? AND dashboard_id=? AND widget_id=?').get(userId,d.id,w.id) as { last: number | null };
        const result = this.widgets.result(userId,d.id,w.id);
        const at = Math.max(last.last ?? 0, result.runAt ?? 0);
        if (!at || now - at >= (opts.schedule === 'hourly' ? 3600_000 : 86400_000)) due.push({ dashboardId: d.id, widgetId: w.id, last: at });
      }
      // Oldest first prevents the first widget starving the rest after an outage.
      due.sort((a,b) => a.last - b.last);
      for (const w of due) {
        try { this.widgets.run(userId,w.dashboardId,w.widgetId); started++; break; } catch { /* Quota, flag and ownership changes are retried on the next tick. */ }
      }
    }
    return started;
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { try { this.tick(); } catch { /* Retry transient storage failures at the next tick. */ } }, 60_000); this.timer.unref(); } }
  stop() { clearInterval(this.timer); this.timer = undefined; }
}
