import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assertTenant, tenantId, isTenant } from '../deployment.js';
import { handleInbound, type ChannelAdapter } from '../messaging/bridge.js';
import { toPlainText } from '../messaging/format.js';
import { registerInboxHandler } from '../messaging/inbox.js';
import { upsertLink } from '../messaging/store.js';
import { publicFetch } from '../security/network.js';
import { DeliveryNotSentError } from '../deliverables/types.js';
export class MessagingError extends Error { constructor(readonly status:number){super(`Messaging operation refused (${status}).`);} }

export async function messagingRequest(operation:string,input:Record<string,unknown>={}){
  if(!isTenant||!process.env.PLATFORM_URL?.startsWith('https:')||!process.env.RUNTIME_TOKEN_FILE?.startsWith('/run/swarm/'))throw new MessagingError(503);
  const token=(await fs.readFile(process.env.RUNTIME_TOKEN_FILE!,'utf8')).trim();
  const response=await fetch(new URL('/internal/runtime/messaging',process.env.PLATFORM_URL!),{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,channel:'imessage',...input})}).catch(()=>{throw new MessagingError(503);});
  if(!response.ok){await response.body?.cancel();throw new MessagingError(response.status);}
  const reader=response.body?.getReader();if(!reader)throw new MessagingError(503);
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1024*1024)throw new MessagingError(503);chunks.push(r.value);}}finally{await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks).toString());
}
/** Injectable HTTP seam for protocol tests; production uses the runtime-audience authenticated request. */
export function controlledMessagingMethods(request: typeof messagingRequest = messagingRequest): Pick<ChannelAdapter, 'prepareControlledDelivery' | 'sendControlledDelivery'> { return {
  async prepareControlledDelivery(link) {
    assertTenant(link.userId);
    const result = await request('delivery-target', { channel: link.channel });
    const target = result?.target;
    if (!target || target.channel !== link.channel || target.transport !== 'platform' || typeof target.phone !== 'string' || !/^\d{8,15}$/.test(target.phone)
      || typeof target.revision !== 'string' || !/^\d{1,30}$/.test(target.revision) || !(target.chatRef === null || typeof target.chatRef === 'string' && target.chatRef.length <= 1000)) throw new MessagingError(503);
    return { channel: link.channel, transport: 'platform', phone: target.phone, chatRef: target.chatRef, revision: target.revision };
  },
  async sendControlledDelivery(link, input) {
    assertTenant(link.userId);
    if (input.target.channel !== link.channel || input.target.transport !== 'platform' || !input.target.phone || !input.target.revision) throw new DeliveryNotSentError('Invalid approved destination.');
    const result = await request('deliver', { channel: link.channel, id: input.dispatchId, text: input.text,
      expected: { phone: input.target.phone, conversation: input.target.chatRef ?? null, revision: input.target.revision } });
    if (result?.outcome === 'not_sent') throw new DeliveryNotSentError('Approved messaging destination is unavailable.');
    if (result?.outcome !== 'delivered' || typeof result.id !== 'string' || !result.id) throw new Error('Controlled send outcome is unknown.');
    return result.id;
  },
}; }
export const privateMessagingAdapter:ChannelAdapter={
  transport:'inkbox',ready:link=>link.userId===tenantId&&link.status==='connected',format:toPlainText,
  supportsPinnedDelivery: true,
  ...controlledMessagingMethods(),
  maxChars:link=>link.channel==='whatsapp'?4000:link.channel==='sms'?1200:1500,
  async send(link,message){assertTenant(link.userId);return (await messagingRequest('send',{id:randomUUID(),channel:link.channel,text:message.text,quote:message.quote})).id;},
  canSendAudio:link=>link.userId===tenantId&&link.channel==='imessage'&&link.status==='connected',
  async sendAudio(link,audio){assertTenant(link.userId);return (await messagingRequest('audio',{id:randomUUID(),channel:link.channel,audio:{data:audio.data.toString('base64'),mime:audio.mime,filename:audio.filename}})).id;},
  async typing(link){assertTenant(link.userId);await messagingRequest('typing',{channel:link.channel});},
};
export function initPrivateMessaging(){
  registerInboxHandler('platform',async payload=>{
    const e=payload.event;
    if(!e||!['imessage','sms','whatsapp'].includes(e.channel)||typeof e.phone!=='string'||!/^\d{8,15}$/.test(e.phone))throw new Error('Invalid private message.');
    // Recheck at the durable inbox consumer too: disconnect may happen after
    // the platform event was accepted but before this job reaches execution.
    try{await messagingRequest('validate',{channel:e.channel,revision:payload.revision,receipt:e.messageId});}
    catch(error){if(error instanceof MessagingError&&error.status===404)return;throw error;}
    upsertLink(tenantId,e.channel,'inkbox',{status:'connected',phone:e.phone,chatRef:e.conversationId??null,name:e.name??null,error:null,lastInboundAt:Date.now()});
    const download=async(media:{url:string;mime:string})=>{
      const response=await publicFetch(media.url,{signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('Message attachment unavailable.');
      return {data:Buffer.from(await response.arrayBuffer()),mime:media.mime||response.headers.get('content-type')||'application/octet-stream'};
    };
    const audio=e.media?.find((m:any)=>m.mime?.startsWith('audio/')),image=e.media?.find((m:any)=>m.mime?.startsWith('image/'));
    await handleInbound({userId:tenantId,channel:e.channel,waId:e.messageId,chatRef:e.conversationId,text:e.text,quotedId:e.replyTo,reaction:e.reaction,audio:audio?()=>download(audio):undefined,image:image?()=>download(image):undefined});
  });
}
