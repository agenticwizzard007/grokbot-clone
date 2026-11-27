import { Hono,type Context } from 'hono';
import { z } from 'zod';
import { requireUser,type AuthVars } from './lib/auth.js';
import { apiBodyLimit } from './security/body-limits.js';
import { HandoffError } from './handoffs/errors.js';
import { requireEnabled,ServiceError,settings,events } from './handoffs/db.js';
import { getOutput,outputByJob,listOutputs,readPart,fromMessage } from './handoffs/outputs.js';
import { createHandoff,handoffInputSchema,handoffDetail,listHandoffs,controlHandoff,messageRefSchema } from './handoffs/handoff-service.js';
import { listLinks,replaceLinks,linkInputSchema,updateSettings,settingsSchema } from './handoffs/link-service.js';
import { createLoop,createLoopSchema,listLoops,getLoop,loopDetail,controlLoop } from './handoffs/loop-service.js';
import { watchHandoffs } from './handoffs/reconcile.js';
const empty=z.object({}).strict();
const querySchema=z.object({botId:z.string().min(1).optional(),after:z.string().optional(),limit:z.coerce.number().int().min(1).max(50).optional(),status:z.string().optional(),direction:z.enum(['sent','received','all']).optional()}).strict();
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const parsed=schema.safeParse(value);if(!parsed.success)throw new ServiceError('invalid_input','Check the request fields.');return parsed.data;}
async function body<T>(c:Context<AuthVars>,schema:z.ZodType<T>):Promise<T> {try{return parse(schema,await c.req.json());}catch(e){if(e instanceof ServiceError)throw e;throw new ServiceError('invalid_input','Send valid JSON.');}}
const user=(c:Context<AuthVars>)=>c.get('user').id;
export const handoffsApi=new Hono<AuthVars>();
// Mount at /api. Limit middleware to these routes so other APIs keep their behavior.
for(const path of ['/outputs','/outputs/*','/handoffs','/handoffs/*','/handoff-links','/handoff-settings','/loops','/loops/*']){
 handoffsApi.use(path,requireUser,apiBodyLimit,async(c,next)=>{requireEnabled(user(c));watchHandoffs(user(c));c.header('Cache-Control','private, no-store');await next();});
}
handoffsApi.onError((error,c)=>{
 if(error instanceof HandoffError)return c.json({error:error.message,code:error.code},error.status as 400|404|409|410|422|429|503);
 console.error('[handoff] request failed');return c.json({error:'Could not complete the request.',code:'internal_error'},500);
});
handoffsApi.get('/outputs',c=>c.json(listOutputs(user(c),parse(querySchema,c.req.query()))));
handoffsApi.get('/outputs/by-job/:jobId',c=>c.json(outputByJob(user(c),c.req.param('jobId'))));
handoffsApi.get('/outputs/:id',c=>c.json(getOutput(user(c),c.req.param('id'))));
handoffsApi.get('/outputs/:id/parts/:partId',c=>{const q=parse(z.object({offset:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(8000).default(8000),original:z.enum(['true','false']).optional()}).strict(),c.req.query());return c.json(readPart(user(c),c.req.param('id'),c.req.param('partId'),q.offset,q.limit,q.original==='true'));});
handoffsApi.post('/outputs/from-message',async c=>c.json(fromMessage(user(c),await body(c,messageRefSchema))));
handoffsApi.post('/handoffs',async c=>{const result=createHandoff(user(c),await body(c,handoffInputSchema));return c.json(result.handoff,result.replayed?200:201);});
handoffsApi.get('/handoffs',c=>c.json(listHandoffs(user(c),parse(querySchema,c.req.query()))));
handoffsApi.get('/handoffs/:id',c=>c.json(handoffDetail(user(c),c.req.param('id'))));
for(const action of ['approve','decline','cancel'] as const)handoffsApi.post(`/handoffs/:id/${action}`,async c=>{await body(c,empty);return c.json(controlHandoff(user(c),c.req.param('id'),action));});
handoffsApi.get('/handoff-links',c=>{const q=parse(z.object({botId:z.string().min(1)}).strict(),c.req.query());return c.json({links:listLinks(user(c),q.botId)});});
handoffsApi.put('/handoff-links',async c=>{const q=parse(z.object({botId:z.string().min(1)}).strict(),c.req.query());const b=await body(c,z.object({links:z.array(linkInputSchema).max(5)}).strict());return c.json({links:replaceLinks(user(c),q.botId,b.links)});});
handoffsApi.get('/handoff-settings',c=>c.json(settings(user(c))));
handoffsApi.put('/handoff-settings',async c=>c.json(updateSettings(user(c),await body(c,settingsSchema))));
handoffsApi.post('/loops',async c=>{const result=createLoop(user(c),await body(c,createLoopSchema));return c.json(result.loop,result.replayed?200:201);});
handoffsApi.get('/loops',c=>c.json(listLoops(user(c),parse(querySchema,c.req.query()))));
handoffsApi.get('/loops/:id',c=>c.json(loopDetail(user(c),c.req.param('id'))));
handoffsApi.get('/loops/:id/events',c=>{const q=parse(z.object({after:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(200).default(200)}).strict(),c.req.query());const id=c.req.param('id');getLoop(user(c),id);const items=events(user(c),{loopId:id},q.after,q.limit);return c.json({events:items,next:items.at(-1)?.seq??q.after});});
for(const action of ['start','pause','resume','stop','approve','decline','extend','done'] as const)handoffsApi.post(`/loops/:id/${action}`,async c=>{await body(c,empty);return c.json(controlLoop(user(c),c.req.param('id'),action));});
