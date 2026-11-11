import { z } from 'zod';
import { catalog, connectionsDetail, toolkitInfo } from '../composio.js';
import { db } from '../db.js';
import { assertTenant, isTenant } from '../deployment.js';
import { env } from '../env.js';
import { appendRow, getBotRow, updateRow } from '../store.js';
import type { ActivityKind, CardBody } from '../types.js';
import type { ToolCtx, ToolResult } from './tools.js';

export interface AppConnectionRequest { botId: string; seq: number; toolkit: string; toolkitName: string }
export interface AppConnectionResult extends ToolResult { connectionRequest?: AppConnectionRequest }
interface AppConnectionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: (args: unknown, ctx: ToolCtx) => Promise<AppConnectionResult>;
}

const listSchema = z.object({}).strict();
const searchSchema = z.object({
  query: z.string().trim().max(300).default('').describe('Match a supported service by its name, slug, description or category. Empty lists all services.'),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
const requestSchema = z.object({
  toolkit: z.string().trim().toLowerCase().min(1).max(100).regex(/^[a-z0-9_]+$/)
    .describe('A verified service slug from search_apps, for example github or googlecalendar.'),
  reason: z.string().trim().min(1).max(2000).describe('Why the user needs to authorize this app for the requested work.'),
}).strict();

const result = (data: unknown, extra: Omit<AppConnectionResult, 'output'> = {}): AppConnectionResult => ({ output: JSON.stringify(data), ...extra });
const unavailable = () => result({ ok: false, available: false, status: 'unavailable',
  error: 'Connected apps are unavailable right now. This does not mean that no apps are connected. Retry later or check app connection settings.' }, { summary: 'App connections unavailable' });

function ownBot(ctx: ToolCtx, generation?: number) {
  assertTenant(ctx.userId);
  const bot = getBotRow(ctx.botId);
  if (!bot || bot.user_id !== ctx.userId || bot.kind === 'room' || generation !== undefined && bot.generation !== generation) {
    throw new Error('Agent not found or its conversation changed.');
  }
  return bot;
}

type Connection = Awaited<ReturnType<typeof connectionsDetail>>[number];
function publicConnection(connection: Connection) {
  // The standalone adapter explicitly executes revision 1. Tenant revisions are
  // provider/gateway facts; never substitute a guessed tenant revision.
  return { id: connection.id, toolkit: connection.toolkit, status: connection.status,
    revision: connection.revision ?? (isTenant ? null : 1), isDefault: connection.isDefault ?? false };
}

function define<S extends z.ZodType>(name: string, description: string, schema: S,
  action: (args: z.output<S>, ctx: ToolCtx, generation: number) => Promise<AppConnectionResult>): AppConnectionTool {
  const { $schema, ...parameters } = z.toJSONSchema(schema, { io: 'input' });
  return { name, description, parameters, activity: 'connecting_service', label: 'Using a connected app',
    impl: async (args, ctx) => {
      let generation: number;
      try { generation = ownBot(ctx).generation; }
      catch { return result({ ok: false, status: 'not_found', error: 'Agent not found.' }); }
      const parsed = schema.safeParse(args);
      if (!parsed.success) return result({ ok: false, status: 'invalid_request', error: `Invalid arguments for ${name}. Follow the tool schema.` });
      if (!env.composioEnabled) return unavailable();
      try { return await action(parsed.data, ctx, generation); }
      catch { return unavailable(); } // SDK errors may contain credentials, URLs and provider payloads.
    },
  };
}

const listTool = define('list_app_connections',
  'List all of this user’s private app accounts, including account IDs, connection revisions and current statuses. Unavailable provider data is distinct from no connections. Never returns credentials.',
  listSchema, async (_args, ctx, generation) => {
    const connections = (await connectionsDetail(ctx.userId)).map(publicConnection);
    ownBot(ctx, generation);
    return result({ ok: true, available: true, status: connections.length ? 'available' : 'none', connections });
  });

const searchTool = define('search_apps',
  'Search the complete supported service catalog by query. Results are bounded and paginated with offset/limit and nextOffset; this discovers services, not executable app tools or authorization.',
  searchSchema, async (args, ctx, generation) => {
    // catalog() exhausts provider/gateway cursor pages before filtering and slicing.
    const all = await catalog();
    ownBot(ctx, generation);
    const query = args.query.toLowerCase();
    const matches = all.filter(app => !query || [app.slug, app.name, app.description ?? '', ...app.categories].join(' ').toLowerCase().includes(query));
    const apps = matches.slice(args.offset, args.offset + args.limit).map(app => ({
      slug: app.slug, name: app.name, description: app.description ?? '', logo: app.logo,
      categories: app.categories, managedAuth: app.managedAuth, noAuth: app.noAuth,
    }));
    return result({ ok: true, available: true, status: 'available', query: args.query, offset: args.offset, limit: args.limit,
      total: matches.length, nextOffset: args.offset + apps.length < matches.length ? args.offset + apps.length : null, apps });
  });

const requestTool = define('request_app_connection',
  'Ask the user to authorize a supported app through Swarm’s connect card. Checks active private accounts first and reuses a pending card in this chat. Returns a connectionRequest for the client; never generates an OAuth URL or grants app permissions.',
  requestSchema, async (args, ctx, generation) => {
    const info = await toolkitInfo(args.toolkit);
    ownBot(ctx, generation);
    if (!info) return result({ ok: false, status: 'unknown_toolkit', error: 'Unknown app. Use search_apps to find a supported toolkit slug.' });
    const active = (await connectionsDetail(ctx.userId)).filter(connection => connection.toolkit === info.slug && connection.status === 'ACTIVE').map(publicConnection);
    ownBot(ctx, generation);
    if (active.length) return result({ ok: true, status: 'connected',
      ...(active.length === 1 ? { connection: active[0] } : { connections: active }),
      ...(active.length > 1 ? { note: 'Multiple private accounts are active. Select the exact account ID for app tool discovery and execution.' } : {}) },
    { summary: `${info.name} connected` });
    const pending = db.prepare("SELECT seq,body FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND json_extract(body,'$.card')='connect' AND json_extract(body,'$.toolkit')=? AND json_extract(body,'$.status')='pending' ORDER BY seq DESC LIMIT 1")
      .get(ctx.botId, generation, info.slug) as { seq: number; body: string } | undefined;
    let seq: number;
    if (pending) {
      seq = pending.seq;
      const body = JSON.parse(pending.body) as Extract<CardBody, { card: 'connect' }>;
      // Keep an existing assignment's lineage. A legacy unbound card can adopt
      // the current durable job without replacing its identity or starting OAuth.
      if (ctx.jobId && !body.jobId) updateRow(ctx.botId, seq, { ...body, jobId: ctx.jobId });
    } else {
      seq = appendRow(ctx.botId, 'card', { type: 'card', card: 'connect', jobId: ctx.jobId,
        toolkit: info.slug, toolkitName: info.name, logo: info.logo, reason: args.reason, status: 'pending' }).seq;
    }
    const connectionRequest: AppConnectionRequest = { botId: ctx.botId, seq, toolkit: info.slug, toolkitName: info.name };
    return result({ ok: true, status: 'pending', connectionRequest,
      note: `Waiting for the user to authorize ${info.name} through the connect card. Authorization is not complete until the provider confirms an active account.` },
    { connectionRequest, summary: `Waiting to connect ${info.name}`, endTurn: true });
  });

/** Shared native definitions for the text tool registry and realtime voice adapter. */
export const APP_CONNECTION_TOOLS: AppConnectionTool[] = [listTool, searchTool, requestTool];

/** Creates/reuses a card only; the frontend starts api.connect with its native callback. */
export async function requestAppConnection(args: unknown, ctx: ToolCtx): Promise<AppConnectionResult> {
  return requestTool.impl(args, ctx);
}
