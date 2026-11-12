import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AuthVars } from './lib/auth.js';
import { teamState } from './coordination/state.js';
import { listInternalRequests } from './coordination/requests.js';
import { listNativeEvents } from './native/events.js';
import { setCoordinationEnabled } from './coordination/supervision.js';

export const coordinationApi=new Hono<AuthVars>();
coordinationApi.use('*',requireUser);
coordinationApi.onError((err,c)=>{if(err instanceof z.ZodError)return c.json({error:'Invalid coordination request.'},400);console.error('[coordination-api]',err);return c.json({error:err.message},400);});
const page=z.object({after:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.coerce.number().int().min(1).max(100).default(50)});
coordinationApi.get('/state',c=>c.json({state:teamState(c.get('user').id)}));
coordinationApi.get('/requests',c=>{const a=page.parse(c.req.query());return c.json(listInternalRequests(c.get('user').id,a.after,a.limit,c.req.query('botId')));});
coordinationApi.get('/events',c=>{const a=page.parse(c.req.query());const events=listNativeEvents(c.get('user').id,a.after,a.limit+1);return c.json({events:events.slice(0,a.limit),nextCursor:events.slice(0,a.limit).at(-1)?.seq??a.after,hasMore:events.length>a.limit});});
coordinationApi.patch('/settings',async c=>{const a=z.object({enabled:z.boolean()}).strict().parse(await c.req.json());setCoordinationEnabled(c.get('user').id,a.enabled);return c.json({enabled:a.enabled});});
