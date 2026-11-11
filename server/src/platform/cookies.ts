import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Directory } from './directory.js';
export async function issuePlatformSession(c:Context,directory:Directory,tenant:string,revoke:(tenant:string,hash?:string)=>void){
  const previous=getCookie(c,'swarm_session'),old=await directory.session(previous);
  const raw=await directory.createSession(tenant,previous,c.req.header('user-agent')??'Unknown device');
  if(old)revoke(old.tenant_id,old.hash);
  setCookie(c,'swarm_session',raw,{secure:true,httpOnly:true,sameSite:'Lax',path:'/',maxAge:604800});
}
