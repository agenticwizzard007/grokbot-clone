import { z } from 'zod';
import { plainText, containsWidgetSecret } from './registry-widgets.js';
import { botIdSchema } from './registry-sources.js';
import { jsonSize } from './errors.js';

export const widgetActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), route: plainText(200, 1) }).strict(),
  z.object({ type: z.literal('send'), botId: botIdSchema, text: plainText(400, 1) }).strict(),
  z.object({ type: z.literal('approve'), itemId: plainText(160, 1) }).strict(),
]);
export type WidgetAction = z.infer<typeof widgetActionSchema>;
export const agentWidgetResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: plainText(1200, 1) }).strict(),
  z.object({ kind: z.literal('stat'), value: plainText(80, 1), label: plainText(120, 1), delta: plainText(80).optional() }).strict(),
  z.object({ kind: z.literal('list'), rows: z.array(z.object({ title: plainText(120, 1), subtitle: plainText(240).optional(), status: plainText(60).optional(), action: widgetActionSchema.optional() }).strict()).max(10) }).strict(),
]).refine(doc => (jsonSize(doc) ?? Infinity) <= 8192, 'The answer exceeds 8 KB.').refine(doc => !containsWidgetSecret(JSON.stringify(doc)), 'Leave out secrets.');
export type AgentWidgetResult = z.infer<typeof agentWidgetResultSchema>;
export type AgentWidgetState = 'empty' | 'running' | 'ready' | 'error';
export interface AgentWidgetSnapshot {
  dashboardId: string;
  widgetId: string;
  state: AgentWidgetState;
  doc: AgentWidgetResult | null;
  runAt: number | null;
  durationMs: number | null;
  tokens: number;
  estimatedCostUsd: number;
  error?: string;
}
export interface UiWidgetEvent { type: 'ui_widget'; dashboardId: string; widgetId: string; state: AgentWidgetState }
export const UI_WIDGET_EVENT = 'ui_widget' as const;
export const UI_WIDGET_ROUTES = {
  run: '/api/ui/widgets/:dashboardId/:widgetId/run', // POST -> 202, AgentWidgetSnapshot
  result: '/api/ui/widgets/:dashboardId/:widgetId/result', // GET -> AgentWidgetSnapshot
  action: '/api/ui/widgets/:dashboardId/:widgetId/action', // POST { action: WidgetAction, confirm?: boolean }
} as const;
export const DASHBOARD_TEMPLATES = ['blank', 'overview', 'tasks', 'usage', 'bot', 'needs_you', 'handoffs', 'pipeline'] as const;
