import { db } from './db.js';

/**
 * A Bot's analytics: messages per day and an estimate of the time it saved its user.
 *
 * Time saved is the time a person would have spent doing the same steps by hand. It's counted from
 * what the Bot actually did (its finished tool calls, its replies and its web searches), at fixed,
 * deliberately conservative rates, so the figure is explainable rather than precise.
 */

export type AnalyticsRange = '7d' | '30d' | '90d';
export const ANALYTICS_RANGES: AnalyticsRange[] = ['7d', '30d', '90d'];

export const RATES = {
  pageRead: 3, // minutes per web page it opened and read
  webSearch: 2, // per web search
  appAction: 2, // per action in a connected app (email, calendar, MCP tool…)
  command: 1, // per shell command
  computerStep: 0.5, // per click, keystroke, scroll or drag on its computer
  organise: 1, // per task, routine or message to another Bot
  wordsPerMinute: 40, // writing replies and files by hand
} as const;

type Category = 'research' | 'writing' | 'apps' | 'computer' | 'organising';
const LABELS: Record<Category, string> = {
  research: 'Research on the web',
  writing: 'Writing replies and drafts',
  apps: 'Actions in your apps',
  computer: 'Work on its computer',
  organising: 'Tasks, routines and teammates',
};

const ORGANISE = new Set(['send_to_bot', 'create_task', 'update_task', 'create_routine', 'update_routine', 'create_event_routine', 'delete_routine', 'post_to_group', 'message_subagent', 'spawn_subagent']);
/** Built-in tools that aren't work a person would otherwise do (bookkeeping, questions, setup). */
const NOT_WORK = new Set(['remember', 'recall', 'stay_silent', 'ask_user', 'set_checkins', 'list_routines', 'list_event_triggers', 'list_subagents', 'stop_subagent',
  'save_agent_setup', 'request_app_connection', 'update_profile', 'create_bot', 'replicate_bot', 'retry_bot_setup', 'create_group', 'computer_screenshot']);

const words = (t: unknown) => (typeof t === 'string' ? t.split(/\s+/).filter(Boolean).length : 0);

/** Minutes a person would spend on one finished tool call, and what kind of work it was. */
export function toolMinutes(name: string, args: any): { cat: Category; min: number } | null {
  if (NOT_WORK.has(name)) return null;
  if (name === 'open_browser') return { cat: 'research', min: RATES.pageRead };
  if (name.startsWith('computer_')) return { cat: 'computer', min: RATES.computerStep };
  if (name === 'shell') return { cat: 'computer', min: RATES.command };
  if (name === 'save_file') return { cat: 'writing', min: Math.max(2, words(args?.content) / RATES.wordsPerMinute) };
  if (ORGANISE.has(name)) return { cat: 'organising', min: RATES.organise };
  return { cat: 'apps', min: RATES.appAction }; // connected apps and MCP tools
}

const DAY = 86_400_000;
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export function botAnalytics(botId: string, range: AnalyticsRange, nowMs = Date.now()) {
  const n = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const from = today - (n - 1) * DAY;
  const days = Array.from({ length: n }, (_, i) => ({ day: utcDay(from + i * DAY), messages: 0, minutesSaved: 0 }));
  const byDay = new Map(days.map((d) => [d.day, d]));
  const byCat: Record<Category, number> = { research: 0, writing: 0, apps: 0, computer: 0, organising: 0 };
  const add = (t: number, cat: Category, min: number) => {
    const d = byDay.get(utcDay(t));
    if (!d) return;
    d.minutesSaved += min;
    byCat[cat] += min;
  };

  const rows = db.prepare("SELECT kind, body, created_at FROM rows WHERE bot_id=? AND created_at>=? AND kind IN ('message','tool-call')").all(botId, from) as { kind: string; body: string; created_at: number }[];
  for (const r of rows) {
    let b: any;
    try { b = JSON.parse(r.body); } catch { continue; }
    if (r.kind === 'message') {
      if (b.streaming) continue;
      const d = byDay.get(utcDay(r.created_at));
      if (d) d.messages++;
      if (b.role === 'assistant') add(r.created_at, 'writing', words(b.text) / RATES.wordsPerMinute);
    } else if (b.status === 'done') {
      const m = toolMinutes(String(b.name ?? ''), b.args);
      if (m) add(r.created_at, m.cat, m.min);
    }
  }
  // Web searches run on the provider's side (no transcript row); the usage monitor counts them.
  const searches = db.prepare('SELECT created_at, tool_calls FROM usage_events WHERE bot_id=? AND created_at>=? AND tool_calls>0').all(botId, from) as { created_at: number; tool_calls: number }[];
  for (const s of searches) add(s.created_at, 'research', s.tool_calls * RATES.webSearch);

  for (const d of days) d.minutesSaved = Math.round(d.minutesSaved * 10) / 10;
  const breakdown = (Object.keys(byCat) as Category[])
    .map((k) => ({ key: k, label: LABELS[k], minutes: Math.round(byCat[k] * 10) / 10 }))
    .filter((x) => x.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
  return {
    range,
    days,
    totals: { messages: days.reduce((s, d) => s + d.messages, 0), minutesSaved: Math.round(days.reduce((s, d) => s + d.minutesSaved, 0) * 10) / 10 },
    breakdown,
    rates: RATES,
  };
}
