import { db, now } from '../db.js';
import { BROWSER_TOOLS } from '../computers/browser-tools.js';
import { captchaOutcome, handOffCaptcha, screenLink } from './captcha.js';
import { BrowserRecovery, browserText } from './browser-recovery.js';
import { waitForBrowserAccess } from './browser-access.js';
import { checkRoutineCreate } from '../routine-limits.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { computers } from '../computers/index.js';
import type { BotScreen } from '../computers/types.js';
import { appendRow, getBotRow, listRoutines, toRoutine, describeCron, setLive } from '../store.js';
import { APPS_OFF, executeComposio, innerToolSlugs, isReadOnlySlug, toolkitInfo } from '../composio.js';
import { env } from '../env.js';
import { scheduleRoutine, unscheduleRoutine } from '../routines.js';
import { createEventRoutine, deleteEventTrigger, describeEvent, listTriggerTypes } from '../triggers.js';
import { getCheckins, setCheckins } from '../proactive.js';
import { updateProfile } from '../accounts.js';
import { createSubagent, deleteSubagent, listSubagents } from './subagents.js';
import { createRoom, postToRoom } from './rooms.js';
import type { ActivityKind } from '../types.js';
import { Cron } from 'croner';
import { creationSchema, isConfiguring, saveSetupDraft, setupDraftSchema } from '../bot-setup.js';
import { createTeammate, replicateTeammate, retryTeammate } from './teammates.js';
import { z } from 'zod';
import { findMcpTool } from '../mcp/store.js';
import { platformState } from './platform-state.js';
import { APP_CONNECTION_TOOLS } from './app-connections.js';
import { appToolLabel } from '../tool-activity.js';

export interface ToolCtx {
  userId: string;
  botId: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number) => void;
  depth: number;
  jobId?: string;
  /** Native callers can pin a discovered read to read-only provider metadata. */
  readOnlyApps?: boolean;
  recovery?: BrowserRecovery;
}

export interface ToolResult {
  /** Responses API function_call_output.output: string or content array (text + images). */
  output: string | any[];
  summary?: string;
  /** End the turn after this tool (e.g. a question was asked). */
  endTurn?: boolean;
  /** Drop subsequent calls planned before this unexpected result and let the model inspect it. */
  replan?: boolean;
}

type Impl = (args: any, ctx: ToolCtx) => Promise<ToolResult>;

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: Impl;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const configuredSettle = Number(process.env.COMPUTER_SETTLE_MS ?? 150);
const settleMs = Number.isFinite(configuredSettle) ? Math.max(0, Math.min(2000, configuredSettle)) : 150;

async function shot(ctx: ToolCtx, caption: string, actedScreen?: BotScreen): Promise<ToolResult> {
  // Reuse the screen lease after an action. A read-only screenshot needs no delay.
  const screen = actedScreen ?? await computers.screen(ctx.userId, ctx.botId);
  if (actedScreen && settleMs) await new Promise((r) => setTimeout(r, settleMs));
  const s = await screen.screenshot();
  return {
    output: [
      { type: 'input_text', text: `${caption} Screen is ${s.width}x${s.height}px.` },
      { type: 'input_image', image_url: `data:${s.mime};base64,${s.image}`, detail: 'high' },
    ],
    summary: caption,
  };
}

const onScreen = async (ctx: ToolCtx) => computers.screen(ctx.userId, ctx.botId);

function botByName(userId: string, name: string) {
  return db.prepare('SELECT * FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, name.trim()) as any;
}

export const TOOLS: ToolDef[] = [
  ...APP_CONNECTION_TOOLS,
  {
    name: 'get_platform_state',
    description: 'Read authoritative Swarm configuration: this agent’s text model and provider, separate voice model, subscription CLI connection, recorded usage and optionally the model catalog. Use this for questions about this app; never browse Swarm or ask for a browser login to inspect its own configuration. Unknown subscription tiers or remaining provider allowance must not be guessed.',
    parameters: obj({ range: { type: 'string', enum: ['today', '7d', '30d', 'month'] }, include_models: { type: 'boolean' } }),
    activity: 'working', label: 'Reading app configuration',
    impl: async (a, ctx) => {
      const args = z.object({ range: z.enum(['today', '7d', '30d', 'month']).optional(), include_models: z.boolean().optional() }).parse(a);
      return { output: JSON.stringify(await platformState(ctx.userId, ctx.botId, { range: args.range, includeModels: args.include_models })) };
    },
  },
  {
    name: 'save_agent_setup',
    description: 'Save your own agent specification during the setup interview. Incorporate the user’s answers into the brief, working style, workflows and boundaries. Save after each substantive answer. Use stage review only when the specification is complete and open_questions is empty. The user activates it in Configuration; you cannot activate yourself.',
    parameters: (() => { const { $schema, ...schema } = z.toJSONSchema(setupDraftSchema); return schema; })(),
    activity: 'working', label: 'Updating agent configuration',
    impl: async (a, ctx) => {
      const result = saveSetupDraft(ctx.botId, ctx.userId, a);
      return { output: JSON.stringify({ ok: true, onboarding: result.onboarding, note: a.stage === 'review' ? 'The specification is ready for the user to review and activate in Configuration.' : 'Draft saved. Ask the next focused question about unresolved details.' }), summary: a.stage === 'review' ? 'Configuration ready for review' : 'Configuration updated' };
    },
  },
  {
    name: 'computer_screenshot',
    description: "Take a screenshot of your own computer screen (a Linux desktop that only you use). Use this before acting on the screen.",
    parameters: obj({}),
    activity: 'on_its_computer',
    label: 'Looking at the screen',
    impl: async (_a, ctx) => shot(ctx, 'Current screen.'),
  },
  {
    name: 'computer_click',
    description: 'Click at pixel coordinates on your screen. Returns a fresh screenshot.',
    parameters: obj({ x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' } }, ['x', 'y']),
    activity: 'on_its_computer',
    label: 'Clicking on screen',
    impl: async (a, ctx) => {
      const screen = await onScreen(ctx);
      await screen.click({ x: a.x, y: a.y, button: a.button ?? 'left', double: !!a.double });
      return shot(ctx, `Clicked (${a.x}, ${a.y}).`, screen);
    },
  },
  {
    name: 'computer_type',
    description: 'Type text into the focused element on your screen. Returns a fresh screenshot.',
    parameters: obj({ text: { type: 'string' } }, ['text']),
    activity: 'on_its_computer',
    label: 'Typing',
    impl: async (a, ctx) => {
      const text = String(a.text);
      const screen = await onScreen(ctx);
      await screen.type(text);
      return shot(ctx, `Typed ${text.length} characters.`, screen);
    },
  },
  {
    name: 'computer_key',
    description: 'Press a key or key combination using X11 keysym names joined by "+", e.g. "Return", "ctrl+l", "ctrl+shift+t", "BackSpace", "Escape", "Page_Down".',
    parameters: obj({ keys: { type: 'string' } }, ['keys']),
    activity: 'on_its_computer',
    label: 'Pressing keys',
    impl: async (a, ctx) => {
      const keys = String(a.keys).split('+').map((k) => (k.length === 1 ? k.toLowerCase() : k)).join('+');
      const screen = await onScreen(ctx);
      const note = await screen.key(keys);
      return shot(ctx, note ? `Pressed ${keys}. ${note}` : `Pressed ${keys}.`, screen);
    },
  },
  {
    name: 'computer_scroll',
    description: 'Scroll the mouse wheel at a position on your screen.',
    parameters: obj({ x: { type: 'integer' }, y: { type: 'integer' }, direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'integer' } }, ['x', 'y', 'direction']),
    activity: 'on_its_computer',
    label: 'Scrolling',
    impl: async (a, ctx) => {
      const screen = await onScreen(ctx);
      await screen.scroll({ x: a.x, y: a.y, direction: a.direction, amount: a.amount ?? 3 });
      return shot(ctx, `Scrolled ${a.direction}.`, screen);
    },
  },
  {
    name: 'computer_drag',
    description: 'Drag with the left mouse button from one point to another on your screen.',
    parameters: obj({ start_x: { type: 'integer' }, start_y: { type: 'integer' }, end_x: { type: 'integer' }, end_y: { type: 'integer' } }, ['start_x', 'start_y', 'end_x', 'end_y']),
    activity: 'on_its_computer',
    label: 'Dragging',
    impl: async (a, ctx) => {
      const screen = await onScreen(ctx);
      await screen.drag(a);
      return shot(ctx, 'Dragged.', screen);
    },
  },
  {
    name: 'open_browser',
    description: 'Open a URL in a Chrome window on your screen (your own logged-in browser profile persists between uses). Returns a screenshot.',
    parameters: obj({ url: { type: 'string' } }, ['url']),
    activity: 'browsing_web',
    label: 'Browsing a site',
    impl: async (a, ctx) => {
      const screen = await onScreen(ctx);
      await screen.openUrl(String(a.url));
      return shot(ctx, `Opened ${a.url}.`, screen);
    },
  },
  {
    name: 'save_file',
    description: "Save a deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it. Saved under /root/swarm/files/<your id>/ on your computer.",
    parameters: obj({ filename: { type: 'string', description: 'e.g. briefing-2026-11-09.md' }, content: { type: 'string' } }, ['filename', 'content']),
    activity: 'drafting_file',
    label: 'Saving notes',
    impl: async (a, ctx) => {
      let name = String(a.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      if (!name || /^\.+$/.test(name)) name = 'file.txt';
      const path = await computers.files.save(ctx.userId, ctx.botId, name, String(a.content));
      return { output: JSON.stringify({ ok: true, path }), summary: `Saved ${name}` };
    },
  },
  {
    name: 'shell',
    description: 'Run a bash command on your own Linux computer (as root). Use for files, scripts, CLIs and quick data work. Output is truncated to 20k characters.',
    parameters: obj({ command: { type: 'string' }, timeout_seconds: { type: 'integer' } }, ['command']),
    activity: 'running_commands',
    label: 'Running commands',
    impl: async (a, ctx) => {
      const screen = computers.capabilities.shell ? await onScreen(ctx) : null;
      if (!screen?.shell) return { output: 'There is no shell on this computer. Use the browser tools instead.', summary: 'No shell' };
      const r = await screen.shell(String(a.command), Math.min(Math.max(a.timeout_seconds ?? 120, 1), 290));
      const out = (r.output ?? '').slice(-20000);
      return { output: JSON.stringify({ exit_code: r.exit_code, output: out }), summary: `exit ${r.exit_code}` };
    },
  },
  {
    name: 'remember',
    description: 'Save a durable memory about the user, their preferences, or your job, so you remember it in future conversations.',
    parameters: obj({ text: { type: 'string' } }, ['text']),
    activity: 'remembering',
    label: 'Saving notes',
    impl: async (a, ctx) => {
      db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES (?,?,?,?)').run(newId('mem'), ctx.botId, String(a.text), now());
      return { output: 'Saved to memory.', summary: 'Saved a memory' };
    },
  },
  {
    name: 'recall',
    description: 'Search your saved memories.',
    parameters: obj({ query: { type: 'string' } }, ['query']),
    activity: 'remembering',
    label: 'Searching memory',
    impl: async (a, ctx) => {
      const words = String(a.query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const all = db.prepare('SELECT text, created_at FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(ctx.botId) as any[];
      const hits = all.filter((m) => !words.length || words.some((w) => m.text.toLowerCase().includes(w))).slice(0, 20);
      return { output: JSON.stringify(hits.map((h) => h.text)) };
    },
  },
  {
    name: 'create_routine',
    description: 'Create a recurring routine you will run on a schedule. `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 8:00. `prompt` is the instruction you will follow each time it runs.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string', description: 'IANA timezone, e.g. America/New_York' } }, ['name', 'prompt', 'schedule']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      try { new Cron(a.schedule, { paused: true, timezone: a.timezone || 'UTC' }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      const limit = checkRoutineCreate(ctx.botId, a.schedule, { timezone: a.timezone });
      if (limit) return { output: limit, summary: 'Routine not created' };
      const id = newId('rt');
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, ctx.botId, a.name, a.prompt, a.schedule, a.timezone || 'UTC', now());
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id));
      scheduleRoutine(r);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeCron(a.schedule)}`, ref: id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }), summary: `Created routine ${a.name}` };
    },
  },
  {
    name: 'list_event_triggers',
    description: 'List the event triggers a connected app offers (e.g. new email, new Slack message, new GitHub PR), with each trigger\'s config fields. Use before create_event_routine.',
    parameters: obj({ toolkit: { type: 'string', description: 'Composio toolkit slug, e.g. gmail, slack, github, googlecalendar' } }, ['toolkit']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a) => ({ output: JSON.stringify(await listTriggerTypes(String(a.toolkit).toLowerCase())) }),
  },
  {
    name: 'create_event_routine',
    description: 'Create a routine that runs whenever an event happens in a connected app (instead of on a schedule). `trigger_slug` comes from list_event_triggers; `config_json` is a JSON object string with that trigger\'s config fields (use "{}" if none). `prompt` is what you will do each time, given the event payload.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, trigger_slug: { type: 'string' }, config_json: { type: 'string' } }, ['name', 'prompt', 'trigger_slug']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      let config: Record<string, unknown> = {};
      try { config = a.config_json ? JSON.parse(a.config_json) : {}; } catch { return { output: 'config_json must be a JSON object string.' }; }
      const limit = checkRoutineCreate(ctx.botId, null);
      if (limit) return { output: limit, summary: 'Routine not created' };
      try {
        const r = await createEventRoutine(ctx.userId, ctx.botId, { name: a.name, prompt: a.prompt, trigger_slug: a.trigger_slug, config });
        appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeEvent(`event:${String(a.trigger_slug).toUpperCase()}`)}`, ref: r.id });
        hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
        return { output: JSON.stringify({ ok: true, routine_id: r.id }), summary: `Created event routine ${a.name}` };
      } catch (e: any) {
        return { output: `Could not create the trigger: ${e?.message ?? e}. If the app isn't connected, call request_app_connection first.` };
      }
    },
  },
  {
    name: 'stay_silent',
    description: 'End this turn without sending the user anything. Use during check-ins, routines or bot-to-bot exchanges when there is nothing worth telling the user.',
    parameters: obj({ reason: { type: 'string' } }),
    activity: 'working',
    label: 'Finishing up',
    impl: async () => ({ output: 'OK, staying silent. End your turn now without writing a reply.', endTurn: true, summary: 'Stayed silent' }),
  },
  {
    name: 'set_checkins',
    description: "Turn proactive check-ins on or off and set when they happen (only the primary Bot does check-ins). times are local 24h 'HH:MM' strings; timezone is IANA (e.g. America/Los_Angeles). Ask the user for their timezone if you don't know it.",
    parameters: obj({ enabled: { type: 'boolean' }, times: { type: 'array', items: { type: 'string' } }, timezone: { type: 'string' } }, ['enabled']),
    activity: 'working',
    label: 'Updating check-ins',
    impl: async (a, ctx) => {
      try {
        const r = setCheckins(ctx.userId, { enabled: !!a.enabled, times: a.times, timezone: a.timezone });
        return { output: JSON.stringify({ ok: true, ...r }), summary: r.enabled ? `Check-ins at ${r.times.join(', ')} ${r.timezone}` : 'Check-ins off' };
      } catch (e: any) {
        return { output: `Could not update check-ins: ${e?.message ?? e}` };
      }
    },
  },
  {
    name: 'list_routines',
    description: 'List your routines.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking routines',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listRoutines(ctx.botId)) }),
  },
  {
    name: 'update_routine',
    description: 'Change or pause one of your routines.',
    parameters: obj({ routine_id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string' }, enabled: { type: 'boolean' } }, ['routine_id']),
    activity: 'working',
    label: 'Updating a routine',
    impl: async (a, ctx) => {
      const cur = db.prepare('SELECT * FROM routines WHERE id=? AND bot_id=?').get(a.routine_id, ctx.botId) as any;
      if (!cur) return { output: 'No such routine.' };
      const next = { ...cur, name: a.name ?? cur.name, prompt: a.prompt ?? cur.prompt, schedule: a.schedule ?? cur.schedule, timezone: a.timezone ?? cur.timezone, enabled: a.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0 };
      try { new Cron(next.schedule, { paused: true, timezone: next.timezone }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      db.prepare('UPDATE routines SET name=?,prompt=?,schedule=?,timezone=?,enabled=? WHERE id=?').run(next.name, next.prompt, next.schedule, next.timezone, next.enabled, cur.id);
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(cur.id));
      r.enabled ? scheduleRoutine(r) : unscheduleRoutine(r.id);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-updated', text: `Routine updated: ${r.name} · ${r.enabled ? r.description : 'Paused'}`, ref: r.id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }) };
    },
  },
  {
    name: 'delete_routine',
    description: 'Delete one of your routines.',
    parameters: obj({ routine_id: { type: 'string' } }, ['routine_id']),
    activity: 'working',
    label: 'Removing a routine',
    impl: async (a, ctx) => {
      unscheduleRoutine(a.routine_id);
      await deleteEventTrigger(a.routine_id);
      db.prepare('DELETE FROM routines WHERE id=? AND bot_id=?').run(a.routine_id, ctx.botId);
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: 'Deleted.' };
    },
  },
  {
    name: 'create_task',
    description: 'Track a piece of work the user asked for as a task (use one per request when asked for several things at once).',
    parameters: obj({ title: { type: 'string' } }, ['title']),
    activity: 'working',
    label: 'Making a task',
    impl: async (a, ctx) => {
      const id = newId('task');
      db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES (?,?,?,'working',?,?)").run(id, ctx.botId, a.title, now(), now());
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: JSON.stringify({ task_id: id }) };
    },
  },
  {
    name: 'update_task',
    description: 'Update a task: state is working, needs_input, or done.',
    parameters: obj({ task_id: { type: 'string' }, state: { type: 'string', enum: ['working', 'needs_input', 'done'] }, note: { type: 'string' } }, ['task_id', 'state']),
    activity: 'working',
    label: 'Updating a task',
    impl: async (a, ctx) => {
      db.prepare('UPDATE tasks SET state=?, note=COALESCE(?, note), updated_at=? WHERE id=? AND bot_id=?').run(a.state, a.note ?? null, now(), a.task_id, ctx.botId);
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: 'Updated.' };
    },
  },
  {
    name: 'send_to_bot',
    description: "Send a message to another Bot on the user's team (by name) to delegate work or ask a question. Their reply will arrive later as a new message to you.",
    parameters: obj({ bot_name: { type: 'string' }, message: { type: 'string' } }, ['bot_name', 'message']),
    activity: 'messaging_named',
    label: 'Messaging a Bot',
    impl: async (a, ctx) => {
      const target = botByName(ctx.userId, a.bot_name);
      if (!target) return { output: `No bot named "${a.bot_name}". Team: ${(db.prepare('SELECT name FROM bots WHERE user_id=?').all(ctx.userId) as any[]).map((b) => b.name).join(', ')}` };
      if (target.id === ctx.botId) return { output: 'That is you.' };
      if (target.kind === 'room') return { output: `"${target.name}" is a group chat; use post_to_group instead.` };
      if (ctx.depth >= 3) return { output: 'Too many hops between bots; answer the user directly instead.' };
      ctx.enqueueBotMessage(ctx.botId, target.id, String(a.message), ctx.depth + 1);
      return { output: `Sent to ${target.name}. Their reply will come back to you as a message.`, summary: `Messaged ${target.name}` };
    },
  },
  {
    name: 'create_bot',
    description: 'Create a permanent teammate directly from the master chat. Build a focused, self-contained brief from the user’s specifications and corrections. Saves identity, AGENTS.md, context, resources, handoffs and a portable setup, then prepares its separate browser/screen. Only the current primary Bot can create teammates. Use this for durable Bots; spawn_subagent is temporary.',
    parameters: (() => { const { $schema, ...schema } = z.toJSONSchema(creationSchema); return schema; })(),
    activity: 'working',
    label: 'Creating a teammate',
    impl: createTeammate,
  },
  {
    name: 'replicate_bot',
    description: 'Create another permanent teammate from an existing Bot’s complete saved role and configuration, with a new name and fresh browser profile. Does not copy browser logins, running tasks, schedules or chat history. Primary Bot only.',
    parameters: obj({ bot_name: { type: 'string' }, new_name: { type: 'string' } }, ['bot_name', 'new_name']),
    activity: 'working', label: 'Replicating a teammate', impl: replicateTeammate,
  },
  {
    name: 'retry_bot_setup',
    description: 'Finish or retry a saved teammate’s computer setup after a connection or provisioning failure. Reuses the same Bot; never creates a duplicate. Primary Bot only.',
    parameters: obj({ bot_name: { type: 'string' } }, ['bot_name']),
    activity: 'working', label: 'Preparing a teammate’s computer', impl: retryTeammate,
  },
  {
    name: 'spawn_subagent',
    description: 'Start a subagent: a helper copy of you with its own context and its own computer screen, to work on one goal in parallel (e.g. research one company each). It reports back to you as a message when done. API billing allows up to 4 helpers; subscription connections have no fixed helper-count limit.',
    parameters: obj({ goal: { type: 'string', description: 'Self-contained task with everything the subagent needs to know' }, label: { type: 'string', description: 'Short name, e.g. "Acme research"' } }, ['goal']),
    activity: 'messaging_named',
    label: 'Starting a helper',
    impl: async (a, ctx) => {
      if (ctx.depth >= 2) return { output: 'Subagents cannot start more subagents. Do the work yourself.' };
      try {
        const sub = createSubagent(ctx.botId, String(a.goal), a.label);
        ctx.enqueueBotMessage(ctx.botId, sub.id, String(a.goal), ctx.depth + 1);
        return { output: JSON.stringify({ ok: true, subagent_id: sub.id, name: sub.name, note: 'It will report back to you as a message. Continue with other work or end your turn.' }), summary: `Started ${sub.name}` };
      } catch (e: any) {
        return { output: String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'list_subagents',
    description: 'List your subagents with their status and latest message.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking on helpers',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listSubagents(ctx.botId)) }),
  },
  {
    name: 'message_subagent',
    description: 'Send a follow-up instruction to one of your subagents.',
    parameters: obj({ subagent_id: { type: 'string' }, message: { type: 'string' } }, ['subagent_id', 'message']),
    activity: 'messaging_named',
    label: 'Checking with a helper',
    impl: async (a, ctx) => {
      const sub = db.prepare('SELECT id FROM bots WHERE id=? AND parent_bot_id=?').get(a.subagent_id, ctx.botId) as any;
      if (!sub) return { output: 'No such subagent.' };
      ctx.enqueueBotMessage(ctx.botId, sub.id, String(a.message), ctx.depth + 1);
      return { output: 'Sent.' };
    },
  },
  {
    name: 'stop_subagent',
    description: 'Stop and remove one of your subagents (do this once you have its result).',
    parameters: obj({ subagent_id: { type: 'string' } }, ['subagent_id']),
    activity: 'working',
    label: 'Wrapping up a helper',
    impl: async (a, ctx) => {
      const { interrupt } = await import('./loop.js');
      interrupt(String(a.subagent_id));
      return { output: deleteSubagent(ctx.botId, String(a.subagent_id)) ? 'Stopped and removed.' : 'No such subagent.' };
    },
  },
  {
    name: 'create_group',
    description: "Create a group chat between the user and several Bots on the team (by name). It appears in the user's sidebar; when the user posts there, the relevant Bots answer.",
    parameters: obj({ name: { type: 'string' }, bot_names: { type: 'array', items: { type: 'string' } } }, ['name', 'bot_names']),
    activity: 'working',
    label: 'Setting up a group',
    impl: async (a, ctx) => {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of (a.bot_names ?? []) as string[]) {
        const b = botByName(ctx.userId, n);
        if (b && b.kind !== 'room') ids.push(b.id); else missing.push(n);
      }
      if (ids.length < 2) return { output: `A group needs at least 2 Bots. Not found: ${missing.join(', ') || 'none'}.` };
      const id = createRoom(ctx.userId, String(a.name), [...new Set(ids)]);
      appendRow(id, 'event', { type: 'event', event: 'bot-message', text: `Group created with ${(a.bot_names as string[]).filter((n) => !missing.includes(n)).join(', ')}` });
      return { output: JSON.stringify({ ok: true, group_id: id, missing }), summary: `Created group ${a.name}` };
    },
  },
  {
    name: 'post_to_group',
    description: 'Post a message into a group chat you are a member of.',
    parameters: obj({ group_name: { type: 'string' }, text: { type: 'string' } }, ['group_name', 'text']),
    activity: 'messaging_named',
    label: 'Posting to the group',
    impl: async (a, ctx) => {
      const out = postToRoom(ctx.botId, String(a.group_name), String(a.text));
      return { output: out, summary: `Posted to ${a.group_name}`, endTurn: out === 'Posted to the group.' };
    },
  },
  {
    name: 'update_profile',
    description: "Save the user's name and/or IANA time zone (e.g. \"America/New_York\") to their account, and mark onboarding complete when the first-chat setup is done. Primary Bot only.",
    parameters: obj({ name: { type: 'string' }, timezone: { type: 'string' }, onboarding_complete: { type: 'boolean' } }),
    activity: 'remembering',
    label: 'Updating your profile',
    impl: async (a, ctx) => {
      const tz = typeof a.timezone === 'string' && a.timezone.trim() ? a.timezone.trim() : undefined;
      if (tz) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return { output: `"${tz}" is not a valid IANA time zone. Use a name like "Europe/London".` }; }
        const cur = getCheckins(ctx.userId);
        setCheckins(ctx.userId, { ...cur, timezone: tz });
      }
      updateProfile(ctx.userId, { name: typeof a.name === 'string' ? a.name : undefined, timezone: tz, onboarded: a.onboarding_complete === true });
      return { output: 'Saved.', summary: a.onboarding_complete ? 'Onboarding done' : 'Profile updated' };
    },
  },
  {
    name: 'wait_for_browser_access',
    description: 'When a browser task requires the user to sign in or complete MFA, ask once with a live-screen link and watch for the access screen to clear. First try available connected apps or authorized existing sessions. Preserve progress in checkpoint; never include passwords or codes. Does not enter credentials. If the wait expires, ends the turn; the user can reply to resume.',
    parameters: obj({
      reason: { type: 'string', description: 'The specific action only the user can perform, without secrets.' },
      checkpoint: { type: 'string', description: 'Task, completed work, and exact next step after access returns. No secrets.' },
      resume_when: { type: 'string', description: 'Optional exact visible text expected only after access returns, such as an account dashboard heading. Required for an unrecognized login screen.' },
    }, ['reason', 'checkpoint']),
    activity: 'waiting_for_you',
    label: 'Waiting for browser access',
    impl: async (a, ctx) => {
      const reason = String(a.reason ?? '').trim().slice(0, 500);
      const checkpoint = String(a.checkpoint ?? '').trim().slice(0, 2000);
      if (!reason || !checkpoint) return { output: 'Provide the specific user action and a checkpoint of completed work and the next step.', replan: true };
      const screen = await onScreen(ctx);
      const link = screenLink(ctx.botId);
      if (!screen.browser) return { output: `Automatic access monitoring is unavailable on this computer. Use ask_user with the checkpoint and this screen link: ${link}. After their reply, inspect a fresh screenshot.`, replan: true };
      const { turnSignal } = await import('./loop.js');
      const configured = Number(process.env.BROWSER_ACCESS_WAIT_MIN ?? 10);
      const timeoutMs = (Number.isFinite(configured) && configured > 0 ? Math.min(configured, 30) : 10) * 60_000;
      try {
        const result = await waitForBrowserAccess({
          read: () => screen.browser!('browser_snapshot', {}), signal: turnSignal(ctx.botId), timeoutMs,
          resumeWhen: typeof a.resume_when === 'string' ? a.resume_when.slice(0, 300) : undefined,
          onWaiting: () => {
            appendRow(ctx.botId, 'message', { type: 'message', role: 'assistant', text: `${reason}\nOpen my screen and use Take control: ${link}\nI'll check for access to return for up to ${Math.ceil(timeoutMs / 60_000)} minutes.\n\nProgress saved: ${checkpoint}` });
            setLive(ctx.botId, { awaiting: { reason, since: Date.now() } });
          },
        });
        if (result.status === 'aborted') return { output: 'Access wait stopped. Preserve the checkpoint; do not continue acting.', endTurn: true };
        if (result.status === 'unrecognized') return { output: `No recognizable access blocker was found. Inspect the current page; continue if access already works. If human help is still necessary, use ask_user with the checkpoint and ${link}, or provide resume_when for an unfamiliar login.\n${result.page ? browserText(result.page) : ''}`, replan: true };
        if (result.status === 'timeout') {
          appendRow(ctx.botId, 'message', { type: 'message', role: 'assistant', text: `I couldn't confirm browser access before the wait expired. Complete the step on my screen (${link}), then reply here to continue.\n\nProgress saved: ${checkpoint}` });
          return { output: `Access wait expired. Stop here. Resume from this checkpoint after the user replies: ${checkpoint}`, endTurn: true };
        }
        return { output: `The access screen is no longer visible in two consecutive observations. Verify the intended account and actual access on this fresh page, then continue from the checkpoint without repeating completed writes.\nCheckpoint: ${checkpoint}\n${browserText(result.page!)}`, replan: true, summary: 'Access screen cleared' };
      } finally { setLive(ctx.botId, { awaiting: null }); }
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a multiple-choice question when you need a decision before continuing. Ends your turn; their answer arrives as their next message.',
    parameters: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question', 'options']),
    activity: 'waiting_for_you',
    label: 'Waiting on you',
    impl: async (a, ctx) => {
      appendRow(ctx.botId, 'card', { type: 'card', card: 'question', jobId: ctx.jobId, question: a.question, options: (a.options ?? []).slice(0, 6), status: 'pending' });
      return { output: 'Question shown to the user. Stop here and wait for their answer.', endTurn: true };
    },
  },

];

// Playwright browser tools (cloud VMs): every web action runs on the Bot's own Chrome through Playwright MCP.
// Registered always; offered to Bots only when the computer provider has them (functionSchemas).
{
  for (const b of BROWSER_TOOLS) {
    TOOLS.push({
      name: b.name,
      description: b.description,
      parameters: b.parameters,
      activity: 'browsing_web',
      label: 'Using the browser',
      impl: async (a, ctx) => {
        const screen = await onScreen(ctx);
        if (!screen.browser) return { output: 'Browser tools are not available on this computer.', summary: 'No browser' };
        const recovery = ctx.recovery ?? new BrowserRecovery();
        if (recovery.blocked(b.name, a ?? {})) {
          // The person/page may have made progress since the last observation. Recheck before skipping.
          const fresh = await screen.browser('browser_snapshot', {});
          recovery.observe('browser_snapshot', {}, fresh);
          if (recovery.blocked(b.name, a ?? {})) return { output: `Skipped an action that already produced the same observed state twice. Inspect this page and change approach; use wait_for_browser_access if only the user can restore access, or ask_user for an unresolved decision.\n${browserText(fresh)}`, summary: 'Repeated ineffective action skipped', replan: true };
        }
        let r;
        try { r = await screen.browser(b.name, a ?? {}); }
        catch (error) {
          recovery.observe(b.name, a ?? {}, { isError: true, content: [{ type: 'text', text: String(error) }] });
          throw error;
        }
        const recoveryResult = recovery.observe(b.name, a ?? {}, r);
        let handedOff = false;
        let captchaStopped = false;
        // A CAPTCHA or human check: never solved by the Bot. Hand the page to the user, wait, then continue.
        if (r.captcha && screen.captcha) {
          handedOff = true;
          const { turnSignal } = await import('./loop.js');
          const outcome = await handOffCaptcha(ctx.botId, screen, r.captcha, turnSignal(ctx.botId));
          captchaStopped = !outcome.solved;
          if (captchaStopped && !turnSignal(ctx.botId)?.aborted) appendRow(ctx.botId, 'message', { type: 'message', role: 'assistant', text: `The human check is still blocking this step. Complete it on my screen (${screenLink(ctx.botId)}), then reply here to continue.` });
          const page = outcome.solved ? await screen.browser('browser_snapshot', {}).catch(() => null) : null;
          const pageText = page ? page.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n') : '';
          r = { content: [{ type: 'text', text: captchaOutcome(r.captcha, outcome, pageText) }], isError: false };
        }
        let text = r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
        if (text.length > 40000) text = text.slice(0, 40000) + '\n…(truncated; use browser_find or a smaller snapshot depth)';
        if (recoveryResult.note && !handedOff) text += `\n\n[Browser recovery]\n${recoveryResult.note}`;
        const images = r.content.filter((c) => c.type === 'image') as { data: string; mimeType: string }[];
        const output = images.length
          ? [{ type: 'input_text', text: text || 'Screenshot:' }, ...images.map((i) => ({ type: 'input_image', image_url: `data:${i.mimeType};base64,${i.data}`, detail: 'high' }))]
          : text || '(no output)';
        const what = b.name === 'browser_navigate' ? `Opened ${String(a?.url ?? '')}` : b.name.replace(/^browser_/, '').replace(/_/g, ' ');
        return { output, summary: r.isError ? `${what} failed` : what, replan: handedOff || recoveryResult.replan, endTurn: captchaStopped };
      },
    });
  }
}

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

export function allowedDuringSetup(botId: string, toolName: string) {
  return !isConfiguring(botId) || ['ask_user', 'save_agent_setup', 'get_platform_state', 'list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE'].includes(toolName);
}

export function functionSchemas(botId?: string) {
  const bot = botId ? getBotRow(botId) : null;
  const canCreate = !!bot?.is_primary && !bot.hidden && bot.kind !== 'room';
  return TOOLS.filter((t) => (!botId || allowedDuringSetup(botId, t.name)) && (t.name !== 'save_agent_setup' || !!botId && isConfiguring(botId)))
    .filter((t) => (!['create_bot', 'replicate_bot', 'retry_bot_setup', 'update_profile'].includes(t.name) || canCreate)).filter((t) => t.name !== 'shell' || computers.capabilities.shell).filter((t) => !t.name.startsWith('browser_') || computers.capabilities.browser).map((t) => ({
    type: 'function',
    name: t.name,
    description: computers.toolDescriptions?.[t.name] ?? t.description,
    parameters: t.parameters,
  }));
}

// ---------- approvals policy ----------

export type Decision = 'allow' | 'ask' | 'block';

export function policyFor(userId: string, toolName: string, args: any, botId?: string): { decision: Decision; key: string; toolkit?: string; title: string } {
  if (toolName.startsWith('mcp_')) {
    const match = botId ? findMcpTool(userId, toolName, botId) : undefined;
    const key = `${toolName}:bot:${botId ?? ''}`;
    const policy = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, key) as { mode: string } | undefined;
    return { decision: !match || policy?.mode === 'blocked' ? 'block' : policy?.mode === 'always_allow' || !match.server.config.requireApproval ? 'allow' : 'ask', key, title: match ? `MCP: use ${match.tool.name} on ${match.server.config.name}` : 'MCP: use an unavailable tool' };
  }
  if (toolMap.has(toolName)) return { decision: 'allow', key: toolName, title: toolName };
  const slugs = innerToolSlugs(toolName, args);
  if (!slugs.length) return { decision: 'allow', key: toolName, title: toolName };
  let decision: Decision = 'allow';
  let key = slugs[0];
  for (const slug of slugs) {
    const p = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, slug) as any;
    const mode = p?.mode ?? (isReadOnlySlug(slug) ? 'always_allow' : 'needs_approval');
    if (mode === 'blocked') return { decision: 'block', key: slug, title: humanizeSlug(slug) };
    if (mode === 'needs_approval') { decision = 'ask'; key = slug; }
  }
  return { decision, key, toolkit: key.split('_')[0].toLowerCase(), title: humanizeSlug(key) };
}

export function humanizeSlug(slug: string) {
  const parts = slug.split('_');
  const app = parts.shift() ?? '';
  return `${app.charAt(0) + app.slice(1).toLowerCase()}: ${parts.join(' ').toLowerCase()}`;
}

export async function runComposioTool(ctx: ToolCtx, name: string, args: any): Promise<ToolResult> {
  const r = await executeComposio(ctx.userId, name, args, { readOnly: isConfiguring(ctx.botId) || ctx.readOnlyApps === true });
  const ok = r.successful !== false && !r.error && (!r.resultType || ['completed', 'success'].includes(r.resultType));
  const payload = ok ? r.data : { error: 'The connected app reported a failed operation. Verify its outcome before retrying.', logId: r.logId };
  let out = JSON.stringify(payload ?? null);
  if (out.length > 60000) out = out.slice(0, 60000) + '…(truncated)';
  return { output: out, summary: ok ? 'done' : 'failed' };
}

export function activityFor(name: string, args?: unknown): { kind: ActivityKind; label: string } {
  const appLabel = appToolLabel(name, args);
  if (appLabel) return { kind: 'connecting_service', label: appLabel };
  if (name.startsWith('mcp_')) return { kind: 'connecting_service', label: 'Using a custom MCP tool' };
  const t = toolMap.get(name);
  if (t) return { kind: t.activity, label: t.label };
  if (name === 'COMPOSIO_SEARCH_TOOLS' || name === 'COMPOSIO_GET_TOOL_SCHEMAS') return { kind: 'connecting_service', label: 'Using a connected app' };
  return { kind: 'connecting_service', label: 'Using a connected app' };
}

export function getBotName(botId: string) {
  return getBotRow(botId)?.name ?? 'Bot';
}
