import { Hono } from 'hono';
import { z } from 'zod';
import { db } from './db.js';
import { sha256 } from './lib/ids.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { DeliverableError, getRoutineRun, listArtifacts, listDeliveries, listRoutineRuns,
  readArtifact, getArtifact, getDelivery, getDeliveryTarget, requestDelivery, retryDelivery, sendDelivery, prepareDeliveryAction, deliveryDestinationSchema, deliveryByKey, deliveryCommand, recordDeliveryCommand, reconcileDelivery, targetIdentity } from './deliverables/index.js';

/** Mounted by the app at /api/deliverables. All downloads and mutations require the owning user. */
export const deliverablesApi = new Hono<AuthVars>();
deliverablesApi.use('*', requireUser);
deliverablesApi.onError((e, c) => {
  if (e instanceof DeliverableError) return c.json({ error: e.message }, e.status);
  if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json({ error: 'Invalid deliverable request.' }, 400);
  console.warn('[deliverables] operation failed', e.name);
  return c.json({ error: 'Deliverable operation failed.' }, 500);
});

deliverablesApi.get('/bots/:botId', (c) => {
  const userId = c.get('user').id;
  const artifacts = listArtifacts(userId, c.req.param('botId')).map((a) => ({ ...a, deliveries: listDeliveries(userId, a.id) }));
  return c.json({ artifacts });
});
deliverablesApi.get('/bots/:botId/runs', (c) => c.json({ runs: listRoutineRuns(c.get('user').id, c.req.param('botId'), c.req.query('routineId')) }));
deliverablesApi.get('/runs/:runId', (c) => {
  const userId = c.get('user').id, run = getRoutineRun(userId, c.req.param('runId'));
  return c.json({ run, artifacts: listArtifacts(userId, run.botId, run.id) });
});
deliverablesApi.get('/artifacts/:artifactId/download', (c) => {
  const { artifact, content } = readArtifact(c.get('user').id, c.req.param('artifactId'));
  const asciiName = artifact.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return c.body(content, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(artifact.filename).replace(/['()*]/g, (s) => `%${s.charCodeAt(0).toString(16)}`)}`,
    'Content-Length': String(content.length),
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
});
const channelSchema=z.enum(['library','imessage','sms','whatsapp']);
function requestKey(value:string|undefined,required=true) {
 if(!value && !required)return undefined;
 if(!value||value.length>200||/[^\x21-\x7e]/.test(value))throw new DeliverableError('A stable Idempotency-Key is required.');
 return value;
}
const fingerprint=(kind:string,id:string,body:unknown)=>sha256(JSON.stringify([kind,id,body]));
deliverablesApi.get('/deliveries/:deliveryId',c=>c.json({delivery:getDelivery(c.get('user').id,c.req.param('deliveryId'))}));
deliverablesApi.post('/artifacts/:artifactId/delivery-preview',async c=>{
 const {channel}=z.object({channel:channelSchema}).strict().parse(await c.req.json());
 const userId=c.get('user').id,artifact=getArtifact(userId,c.req.param('artifactId'));
 const prepared=await prepareDeliveryAction(userId,artifact.botId,'deliver_artifact',{artifact_id:artifact.id,channel});
 return c.json({destination:prepared.destination});
});
deliverablesApi.post('/deliveries/:deliveryId/retry-preview',async c=>{
 const userId=c.get('user').id,d=getDelivery(userId,c.req.param('deliveryId')),a=getArtifact(userId,d.artifactId);
 const prepared=await prepareDeliveryAction(userId,a.botId,'retry_delivery',{delivery_id:d.id});
 return c.json({destination:prepared.destination});
});
deliverablesApi.post('/artifacts/:artifactId/deliveries', async c => {
 const body=z.object({channel:channelSchema,destination:deliveryDestinationSchema.optional()}).strict().parse(await c.req.json());
 const userId=c.get('user').id,artifactId=c.req.param('artifactId'),key=requestKey(c.req.header('Idempotency-Key'),body.channel!=='library'||!!body.destination);
 const binding=fingerprint('deliver',artifactId,body);
 if(key){const prior=deliveryCommand(userId,key,binding);if(prior)return c.json({delivery:prior});}
 const a=getArtifact(userId,artifactId);
 // A prior accepted request wins over changed current connection metadata after response loss.
 const prior=key?deliveryByKey(userId,key):null;
 if(prior){
   if(prior.artifactId!==artifactId||prior.channel!==body.channel||body.destination&&targetIdentity(body.destination.target)!==targetIdentity(getDeliveryTarget(userId,prior.id)))throw new DeliverableError('Idempotency key already belongs to another delivery.',409);
   recordDeliveryCommand(userId,key!,binding,prior.id);return c.json({delivery:prior});
 }
 if(body.channel!=='library'&&!body.destination)throw new DeliverableError('Preview and confirm the report destination before sending.',409);
 const prepared=await prepareDeliveryAction(userId,a.botId,'deliver_artifact',{artifact_id:artifactId,...body});
 const delivery=await requestDelivery({userId,artifactId,channel:body.channel,idempotencyKey:key,approvedTarget:deliveryDestinationSchema.parse(prepared.destination).target});
 if(key)db.transaction(()=>{if(!deliveryCommand(userId,key,binding))recordDeliveryCommand(userId,key,binding,delivery.id);})();
 return c.json({delivery:await sendDelivery(userId,delivery.id)});
});
deliverablesApi.post('/deliveries/:deliveryId/retry', async c => {
 const body=z.object({destination:deliveryDestinationSchema,expectedAttemptId:z.string().min(1)}).strict().parse(await c.req.json());
 const key=requestKey(c.req.header('Idempotency-Key'))!,userId=c.get('user').id,id=c.req.param('deliveryId'),binding=fingerprint('retry',id,body);
 const prior=deliveryCommand(userId,key,binding);if(prior)return c.json({delivery:prior});
 const d=getDelivery(userId,id),a=getArtifact(userId,d.artifactId);
 await prepareDeliveryAction(userId,a.botId,'retry_delivery',{delivery_id:id,destination:body.destination});
 db.transaction(()=>{
  if(deliveryCommand(userId,key,binding))return;
  if(getDelivery(userId,id).attempts.at(-1)?.id!==body.expectedAttemptId)throw new DeliverableError('Latest delivery attempt changed.',409);
  retryDelivery(userId,id);recordDeliveryCommand(userId,key,binding,id);
 })();
 return c.json({delivery:await sendDelivery(userId,id)});
});
deliverablesApi.post('/deliveries/:deliveryId/reconcile', async c=>{
 const body=z.object({outcome:z.enum(['delivered','not_sent']),evidence:z.string().trim().min(1).max(4000),expectedAttemptId:z.string().min(1)}).strict().parse(await c.req.json());
 const key=requestKey(c.req.header('Idempotency-Key'))!,userId=c.get('user').id,id=c.req.param('deliveryId'),binding=fingerprint('reconcile',id,body);
 const delivery=db.transaction(()=>{
  const prior=deliveryCommand(userId,key,binding);if(prior)return prior;
  const result=reconcileDelivery(userId,id,body);recordDeliveryCommand(userId,key,binding,id);return result;
 })();
 return c.json({delivery});
});
