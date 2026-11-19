import { Hono } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getCheckins, setCheckins, requestSynopsisNow } from './proactive.js';
import { getSynopsis, listSynopses, reportSourcePage, retrySynopsis } from './coordination/reports.js';
import { z } from 'zod';

const settings = z.object({ enabled:z.boolean().optional(), times:z.array(z.string()).max(6).optional(), timezone:z.string().optional(),
  quietHours:z.array(z.object({start:z.string(),end:z.string()}).strict()).max(6).optional() }).strict();
const page = (c:{req:{query:(key:string)=>string|undefined}}) => {
  const cursor=Number(c.req.query('after')??0),limit=Number(c.req.query('limit')??20);
  if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination.');
  return {cursor,limit};
};

/** /api/checkins: proactive check-in settings for the primary bot. */
export const checkinsApi = new Hono<AuthVars>();
checkinsApi.use('*', requireUser);

checkinsApi.get('/', (c) => c.json(getCheckins(c.get('user').id)));

checkinsApi.put('/', async (c) => {
  try {
    const body = settings.parse(await c.req.json());
    return c.json(setCheckins(c.get('user').id, body));
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 400);
  }
});

/** A retried request reuses the same manual report (the local day by default). */
checkinsApi.post('/now', (c) => {
  try {
    const reportId=requestSynopsisNow(c.get('user').id,c.req.header('Idempotency-Key'));
    return c.json({ ok: true, reportId },202);
  } catch(e) { return c.json({error:(e as Error).message},409); }
});

checkinsApi.get('/reports', c => {
  try {const p=page(c);return c.json(listSynopses(c.get('user').id,p.cursor,p.limit));}
  catch(e){return c.json({error:(e as Error).message},400);}
});
checkinsApi.get('/reports/:id', c => {
  try{return c.json({report:getSynopsis(c.get('user').id,c.req.param('id'))});}
  catch{return c.json({error:'Report not found.'},404);}
});
checkinsApi.get('/reports/:id/sources', c => {
  try{const p=page(c);return c.json(reportSourcePage(c.get('user').id,c.req.param('id'),p.cursor,p.limit));}
  catch(e){return c.json({error:(e as Error).message},400);}
});
checkinsApi.post('/reports/:id/retry', async c => {
  try{return c.json({report:await retrySynopsis(c.get('user').id,c.req.param('id'))});}
  catch(e){return c.json({error:(e as Error).message},409);}
});
