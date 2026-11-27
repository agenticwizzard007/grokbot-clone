import { llmClient, llmProvider, modelFor } from '../lib/llm.js';
import { withUsage, recordModelUsage } from '../usage.js';
import { hub } from '../lib/hub.js';
import { withRun } from '../agent/run-scope.js';
import type { ServerEvent } from '../types.js';
import type { SqliteUiConfigService } from './service.js';
import { DataExecutor } from './sources/executor.js';
import { WidgetService } from './widget-service.js';
import { runAgentWidget } from './widget-runner.js';
import { WidgetActions } from './widget-actions.js';
import { WidgetScheduler } from './widget-scheduler.js';
import { createWidgetApi } from './widget-routes.js';
import { needsYou } from '../routes-attention.js';

export function widgetRuntime(config: SqliteUiConfigService) {
  const db = config.store.db, data = new DataExecutor();
  const actions = new WidgetActions(db, config, { needsYou, approve: (userId, id) => {
    // Installed lazily below, after the main agent module finishes initializing.
    if (!approval) throw new Error('Approval service is starting.');
    return approval(userId,id,'allow');
  } });
  let approval: typeof import('../agent/loop.js').resolveApproval | undefined;
  let dailyUsage: typeof import('../messaging/signup.js').dailyUsage | undefined;
  void import('../agent/loop.js').then(m => { approval = m.resolveApproval; });
  void import('../messaging/signup.js').then(m => { dailyUsage = m.dailyUsage; });
  const widgets = new WidgetService(db, config, {
    accountAllowed: userId => !!dailyUsage && !dailyUsage(userId).over,
    accountCost: (userId, since) => (db.prepare('SELECT COALESCE(SUM(cost_usd),0) cost FROM usage_events WHERE user_id=? AND created_at>=?').get(userId,since) as any).cost,
    validateResult: (userId, result) => actions.validateResult(userId,result),
    // ServerEvent is owned outside this workstream. Runtime event is a typed contract.
    emit: (userId, event) => withRun(undefined, () => hub.emit(userId, event as unknown as ServerEvent)),
    run: ctx => withRun(undefined, () => withUsage({ userId: ctx.userId, botId: ctx.botId, kind: 'other' }, async () => {
      // Native subscription CLIs expose their own filesystem tools. Until they
      // support a strict headless allowlist, fail closed rather than grant them.
      if (llmProvider().endsWith('-cli')) throw new Error('Read-only widget runs require an API model.');
      const bot = db.prepare('SELECT model FROM bots WHERE user_id=? AND id=?').get(ctx.userId,ctx.botId) as any;
      const model = modelFor(bot.model);
      return runAgentWidget({ ...ctx,
        model: async (input, tools, signal) => await llmClient(30_000).responses.create({ model, input, tools, max_output_tokens: 2048, store: false }, { signal }) as any,
        read: (source, params) => data.execute(ctx.userId, { key: source, source, params }, true),
        record: async response => {
          await recordModelUsage({ userId: ctx.userId, botId: ctx.botId, model, response });
          const row = db.prepare('SELECT input_tokens+output_tokens tokens,cost_usd cost FROM usage_events WHERE user_id=? AND request_id=? ORDER BY id DESC LIMIT 1').get(ctx.userId,response.id ?? '') as any;
          ctx.usage(row?.tokens ?? 0, row?.cost ?? 0);
        },
      });
    })),
  });
  return { widgets, actions, scheduler: new WidgetScheduler(widgets), api: createWidgetApi(widgets,actions), close: () => data.close() };
}
