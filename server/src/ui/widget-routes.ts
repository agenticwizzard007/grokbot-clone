import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../lib/auth.js';
import { widgetActionSchema } from '../ui-config/index.js';
import { WidgetError, type WidgetService } from './widget-service.js';
import type { WidgetActions } from './widget-actions.js';

/** Mounted behind the UI API's session, origin, flags and bounded JSON middleware. */
export function createWidgetApi(widgets: WidgetService, actions: WidgetActions) {
  const api = new Hono<AuthVars>();
  api.onError((error, c) => error instanceof WidgetError
    ? c.json({ code: error.code, message: error.message }, error.status)
    : c.json({ code: 'invalid_value', message: 'Could not complete the widget request.' }, 422));
  const ids = (c: any) => [c.get('user').id, c.req.param('dashboardId'), c.req.param('widgetId')] as const;
  api.post('/:dashboardId/:widgetId/run', async c => {
    z.object({}).strict().parse(await c.req.json());
    const args = ids(c); widgets.touch(args[0]);
    return c.json(widgets.run(...args), 202);
  });
  api.get('/:dashboardId/:widgetId/result', c => { const args = ids(c); widgets.touch(args[0]); return c.json(widgets.result(...args)); });
  api.post('/:dashboardId/:widgetId/action', async c => {
    const input = z.object({ action: widgetActionSchema, confirm: z.boolean().optional() }).strict().parse(await c.req.json());
    return c.json(actions.perform(widgets, ...ids(c), input.action, input.confirm));
  });
  return api;
}
