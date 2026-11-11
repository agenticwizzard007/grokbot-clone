import { onTrigger } from '../triggers.js';
import { gatewayRequest, GatewayError } from './gateway-client.js';
import fs from 'node:fs/promises';
import { db } from '../db.js';
import { prepareEventInbox, deliverRuntimeEvents } from './event-inbox.js';
import { tenantId } from '../deployment.js';
import { openPrivate } from '../security/secrets.js';
import { saveOpenRouterKey } from '../providers/openrouter.js';
import { saveAppleRefreshToken } from '../auth/apple-provider.js';
import { upsertLink } from '../messaging/store.js';
import { accept } from '../messaging/inbox.js';
import { messagingRequest, MessagingError } from './messaging.js';
prepareEventInbox(db);
export function initRuntimeEvents() {
  let busy=false;
  const timer=setInterval(()=>{if(busy)return;busy=true;void poll().finally(()=>{busy=false;}).catch(()=>{});},5000).unref();
  async function poll(){
    const token=(await fs.readFile(process.env.RUNTIME_TOKEN_FILE!,'utf8')).trim();
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const response=await fetch(new URL('/internal/runtime/events',process.env.PLATFORM_URL!),{headers,redirect:'error',signal:AbortSignal.timeout(15_000)});
    if(!response.ok)return;
    const reader=response.body?.getReader();if(!reader)return;
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>24*1024*1024)throw new Error('Event response limit exceeded.');chunks.push(value);}}finally{await reader.cancel();}
    const body=JSON.parse(Buffer.concat(chunks).toString());
    const ack=await deliverRuntimeEvents(db,body.events,{
      open:event=>openPrivate<any>(tenantId,`event:${event.id}`,event.ciphertext),
      async authorize(payload){
        if(payload.type==='provider-trigger')await gatewayRequest(tenantId,'trigger-check',{triggerId:payload.triggerId});
        if(payload.type==='messaging-link'||payload.type==='messaging-inbound')await messagingRequest('validate',{channel:payload.channel??payload.event?.channel,revision:payload.revision,...(payload.event?.messageId?{receipt:payload.event.messageId}:{})});
      },
      apply(payload,event){
        if(payload.type==='provider-key'&&payload.provider==='openrouter')saveOpenRouterKey(tenantId,payload.key,'oauth');
        else if(payload.type==='apple-revocation')saveAppleRefreshToken(tenantId,payload.clientId,payload.refreshToken);
        else if(payload.type==='provider-trigger')onTrigger(payload.data);
        else if(payload.type==='messaging-link'){
          if(!['imessage','sms','whatsapp'].includes(payload.channel)||!/^\d{8,15}$/.test(payload.phone))throw new Error('Invalid messaging identity.');
          db.prepare('UPDATE users SET phone=? WHERE id=?').run(payload.phone,tenantId);
          upsertLink(tenantId,payload.channel,'inkbox',{status:'connected',phone:payload.phone,chatRef:payload.conversationId??null,error:null});
        }else if(payload.type==='messaging-inbound')accept('platform',event.id,payload);
        else throw new Error('Unsupported event.');
      },
      retryable:error=>(error instanceof GatewayError||error instanceof MessagingError)&&error.status!==404,
    });
    if(ack.length){const acknowledged=await fetch(new URL('/internal/runtime/events/ack',process.env.PLATFORM_URL!),{method:'POST',headers,body:JSON.stringify({ids:ack}),redirect:'error',signal:AbortSignal.timeout(15_000)});await acknowledged.body?.cancel();}
  }
  return ()=>clearInterval(timer);
}
