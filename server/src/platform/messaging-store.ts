import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Directory, hashToken, opaqueToken } from './directory.js';
import type { TenantEnvelopes } from './envelopes.js';
import type { Parsed } from '../messaging/inkbox/events.js';
import { signupPolicy } from './signup.js';

export type PhoneChannel = 'imessage' | 'whatsapp' | 'sms';
export class MessagingNotFound extends Error {}
export class MessagingDestinationChanged extends Error {}
export interface MessagingDeliveryTarget { phone: string; conversation: string | null; revision: string }
export class MessagingAdmissionError extends Error {
  constructor(message: string, readonly needInvite = false) { super(message); }
}
interface Route { tenant_id: string; channel: PhoneChannel; phone: string; conversation_id: string | null; revision: string }
type RuntimeAuthorization = (client?: PoolClient) => Promise<unknown>;

/** Platform identity/routing metadata only. Message content is encrypted before persistence. */
export class MessagingOwnership {
  constructor(readonly directory: Directory, private envelopes: TenantEnvelopes) {}
  private async lock(client: PoolClient, tenant: string) {
    if (!(await client.query("SELECT id FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted','failed') FOR UPDATE", [tenant])).rowCount) throw new MessagingNotFound();
  }
  async route(tenant: string, channel: string, client: Pick<PoolClient,'query'> = this.directory.pool): Promise<Route | undefined> {
    return (await client.query(`SELECT r.* FROM messaging_routes r JOIN tenants t ON t.id=r.tenant_id
      WHERE r.tenant_id=$1 AND r.channel=$2 AND r.state='active' AND t.state NOT IN ('deleting','deleted','failed')`, [tenant,channel])).rows[0];
  }
  async link(tenant: string, phone: string, channel: PhoneChannel, conversation?: string, requiredSession?:string) {
    await this.directory.transaction(async client => {
      await this.lock(client,tenant);
      if(requiredSession&&!(await client.query(`SELECT 1 FROM sessions WHERE hash=$1 AND tenant_id=$2 AND expires_at>now()
        AND last_seen_at>now()-interval '24 hours' AND authenticated_at>now()-interval '10 minutes' FOR UPDATE`,[requiredSession,tenant])).rowCount)throw new MessagingNotFound();
      if (!(await client.query("SELECT 1 FROM identities WHERE provider='phone' AND subject=$1 AND tenant_id=$2",[phone,tenant])).rowCount) throw new MessagingNotFound();
      const route=(await client.query(`INSERT INTO messaging_routes(tenant_id,channel,phone,conversation_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id,channel) DO UPDATE SET state='active',phone=excluded.phone,conversation_id=excluded.conversation_id,revision=messaging_routes.revision+1 RETURNING *`,[tenant,channel,phone,conversation??null])).rows[0];
      const id=`phone-link-${opaqueToken()}`;
      const ciphertext=await this.envelopes.encrypt(tenant,`event:${id}`,{type:'messaging-link',phone,channel,conversationId:conversation,revision:String(route.revision)});
      await client.query('INSERT INTO wake_events(tenant_id,id,ciphertext) VALUES($1,$2,$3)',[tenant,id,Buffer.from(ciphertext)]);
    });
  }
  async disconnect(tenant: string, channel: PhoneChannel, authorize?: RuntimeAuthorization) {
    await this.directory.transaction(async client => {
      await this.lock(client,tenant);
      await authorize?.(client);
      // Keep a tombstone so reconnect never reuses an authorization revision.
      await client.query("UPDATE messaging_routes SET state='revoked',revision=revision+1 WHERE tenant_id=$1 AND channel=$2",[tenant,channel]);
      await client.query('DELETE FROM messaging_tokens WHERE tenant_id=$1 AND channel=$2',[tenant,channel]);
    });
  }
  async validate(tenant: string, channel: string, revision: unknown, receipt?: string) {
    const route=await this.route(tenant,channel);
    if (!route || typeof revision!=='string' || String(route.revision)!==revision) throw new MessagingNotFound();
    if (receipt && !(await this.directory.pool.query('SELECT 1 FROM messaging_receipts WHERE tenant_id=$1 AND id=$2 AND channel=$3 AND revision=$4',[tenant,receipt,channel,revision])).rowCount) throw new MessagingNotFound();
    return route;
  }
  async validateDeliveryTarget(tenant: string, channel: PhoneChannel, expected: MessagingDeliveryTarget) {
    const route = await this.route(tenant, channel);
    if (!route || route.phone !== expected.phone || route.conversation_id !== expected.conversation || String(route.revision) !== expected.revision) throw new MessagingDestinationChanged('Approved destination changed.');
    return route;
  }
  async dispatchState(tenant: string, id: string): Promise<string | undefined> {
    return (await this.directory.pool.query('SELECT state FROM messaging_dispatches WHERE tenant_id=$1 AND id=$2', [tenant, id])).rows[0]?.state;
  }
  async accept(tenant: string, event: Parsed) {
    return this.directory.transaction(async client => {
      await this.lock(client,tenant);
      const route=await this.route(tenant,event.channel,client);
      if(!route || route.phone!==event.phone) return false;
      const inserted=await client.query('INSERT INTO messaging_receipts(tenant_id,id,channel,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[tenant,event.messageId,event.channel,route.revision]);
      if(!inserted.rowCount)return false;
      await client.query('UPDATE messaging_routes SET conversation_id=$3 WHERE tenant_id=$1 AND channel=$2',[tenant,event.channel,event.conversationId??null]);
      const id=`inkbox-${hashToken(`${event.channel}:${event.messageId}`)}`;
      const ciphertext=await this.envelopes.encrypt(tenant,`event:${id}`,{type:'messaging-inbound',event,revision:String(route.revision)});
      await client.query('INSERT INTO wake_events(tenant_id,id,ciphertext) VALUES($1,$2,$3)',[tenant,id,Buffer.from(ciphertext)]);
      await client.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'wake') ON CONFLICT(tenant_id,operation) DO UPDATE SET state='queued',retry_at=now() WHERE lifecycle_jobs.state='completed'",[opaqueToken(),tenant]);
      return true;
    });
  }
  async begin(tenant: string, channel: PhoneChannel, id: string, quote?: string, authorize?: RuntimeAuthorization, expected?: MessagingDeliveryTarget) {
    return this.directory.transaction(async client => {
      await this.lock(client,tenant);
      await authorize?.(client);
      if (expected && (await client.query('SELECT 1 FROM messaging_dispatches WHERE tenant_id=$1 AND id=$2', [tenant, id])).rowCount) return null;
      const route=await this.route(tenant,channel,client);
      if(!route)throw new MessagingNotFound();
      if (expected && (route.phone !== expected.phone || route.conversation_id !== expected.conversation || String(route.revision) !== expected.revision)) throw new MessagingDestinationChanged('Approved destination changed.');
      if(quote && !(await client.query('SELECT 1 FROM messaging_receipts WHERE tenant_id=$1 AND id=$2 AND channel=$3 AND revision=$4',[tenant,quote,channel,route.revision])).rowCount)throw new MessagingNotFound();
      const inserted=await client.query("INSERT INTO messaging_dispatches(tenant_id,id,channel,revision,state) VALUES($1,$2,$3,$4,'dispatching') ON CONFLICT DO NOTHING RETURNING id",[tenant,id,channel,route.revision]);
      return inserted.rowCount ? route : null;
    });
  }
  async finish(tenant: string, id: string, state: 'completed' | 'uncertain' | 'not_sent', receipt?: string | null) {
    await this.directory.transaction(async client=>{
      const r=(await client.query('UPDATE messaging_dispatches SET state=$3 WHERE tenant_id=$1 AND id=$2 RETURNING channel,revision',[tenant,id,state])).rows[0];
      if(receipt&&r)await client.query('INSERT INTO messaging_receipts(tenant_id,id,channel,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenant,receipt,r.channel,r.revision]);
    });
  }
  async loginToken(tenant: string, channel: PhoneChannel, authorize?: RuntimeAuthorization) {
    const token=opaqueToken();
    await this.directory.transaction(async client=>{
      await this.lock(client,tenant);
      await authorize?.(client);
      const r=await this.route(tenant,channel,client);if(!r)throw new MessagingNotFound();
      await client.query("DELETE FROM messaging_tokens WHERE tenant_id=$1 AND purpose='login'",[tenant]);
      await client.query("INSERT INTO messaging_tokens(hash,tenant_id,purpose,channel,revision,expires_at) VALUES($1,$2,'login',$3,$4,now()+interval '10 minutes')",[hashToken(token),tenant,channel,r.revision]);
    });
    return token;
  }
  async consumeLogin(token: string, previous:string|undefined, device:string) {
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    return this.directory.transaction(async client=>{
      const r=(await client.query(`SELECT k.tenant_id FROM messaging_tokens k JOIN messaging_routes r ON r.tenant_id=k.tenant_id AND r.channel=k.channel JOIN tenants t ON t.id=k.tenant_id
        WHERE k.hash=$1 AND k.purpose='login' AND k.expires_at>now() AND r.tenant_id=k.tenant_id AND r.channel=k.channel
        AND r.revision=k.revision AND r.state='active' AND t.id=k.tenant_id AND t.state NOT IN ('deleting','deleted','failed') FOR UPDATE OF k,r,t`,[hashToken(token)])).rows[0];
      if(!r)return null;
      await client.query('DELETE FROM messaging_tokens WHERE hash=$1',[hashToken(token)]);
      if(previous)await client.query('DELETE FROM sessions WHERE hash=$1',[hashToken(previous)]);
      const raw=opaqueToken();
      await client.query('INSERT INTO sessions(hash,tenant_id,device) VALUES($1,$2,$3)',[hashToken(raw),r.tenant_id,device.slice(0,200)]);
      return {tenant:r.tenant_id as string,raw};
    });
  }
  async memberInvite(tenant: string, authorize?: RuntimeAuthorization) {
    return this.directory.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
      await this.lock(client,tenant);
      await authorize?.(client);
      const allowance=(await signupPolicy(client)).memberInvites;
      if(!Number.isSafeInteger(allowance)||allowance<1||allowance>1000)throw new MessagingAdmissionError('Invites are unavailable.');
      await authorize?.(client);
      await client.query("INSERT INTO messaging_invites(code,tenant_id,max_uses) VALUES($1,$2,$3) ON CONFLICT(tenant_id) WHERE kind='member' DO UPDATE SET max_uses=excluded.max_uses",[randomBytes(8).toString('hex').toUpperCase(),tenant,allowance]);
      const r=(await client.query("SELECT * FROM messaging_invites WHERE tenant_id=$1 AND kind='member' AND revoked=false AND (expires_at IS NULL OR expires_at>clock_timestamp())",[tenant])).rows[0];
      if(!r||r.uses>=r.max_uses)throw new MessagingAdmissionError('You have no remaining invites.');
      await authorize?.(client);
      return {url:new URL(`/join/${r.code}`,process.env.PLATFORM_URL!).href,remaining:r.max_uses-r.uses};
    });
  }
  async invite(code: string, client: Pick<PoolClient,'query'> = this.directory.pool) {
    const policy=await signupPolicy(client);
    return (await client.query(`SELECT i.*,t.display_name FROM messaging_invites i JOIN tenants t ON t.id=i.tenant_id
      WHERE i.code=$1 AND i.revoked=false AND i.uses<i.max_uses AND (i.kind='admin' OR i.uses<$2)
      AND (i.expires_at IS NULL OR i.expires_at>clock_timestamp()) AND t.state NOT IN ('deleting','deleted','failed')`,[code.toUpperCase(),policy.memberInvites])).rows[0];
  }
  /** Must run in the same transaction as identity creation and code consumption. */
  async admitPhone(client: PoolClient, phone: string, inviteCode?: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
    if ((await client.query("SELECT 1 FROM identities WHERE provider='phone' AND subject=$1",[phone])).rowCount)return;
    const {mode,signupsPerDay:dailyLimit,memberInvites}=await signupPolicy(client);
    if(mode==='closed')throw new MessagingAdmissionError('New phone accounts are currently closed.');
    if(!Number.isSafeInteger(dailyLimit)||dailyLimit<0||dailyLimit>100000)throw new MessagingAdmissionError('Phone signup is unavailable.');
    const used=Number((await client.query("SELECT count(*) n FROM identities i JOIN tenants t ON t.id=i.tenant_id WHERE i.provider='phone' AND t.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")).rows[0].n);
    if(dailyLimit>0&&used>=dailyLimit)throw new MessagingAdmissionError('Phone signup capacity reached for today.');
    const claim=(await client.query('SELECT invite_code FROM messaging_claims WHERE phone=$1 AND expires_at>now()',[phone])).rows[0];
    const code=inviteCode||claim?.invite_code;
    const approved=(await client.query("SELECT 1 FROM signup_waitlist WHERE phone=$1 AND state='approved' AND verified_at>clock_timestamp()-interval '30 days'",[phone])).rowCount;
    if(code){
      const used=await client.query(`UPDATE messaging_invites i SET uses=uses+1 FROM tenants t WHERE i.code=$1 AND i.revoked=false AND i.uses<i.max_uses
        AND (i.kind='admin' OR i.uses<$2) AND (i.expires_at IS NULL OR i.expires_at>clock_timestamp()) AND t.id=i.tenant_id AND t.state NOT IN ('deleting','deleted','failed') RETURNING i.code`,[code.toUpperCase(),memberInvites]);
      if(!used.rowCount)throw new MessagingAdmissionError('This invitation is no longer valid.',true);
      await client.query('DELETE FROM messaging_claims WHERE phone=$1',[phone]);
    }else if(mode!=='open'&&!approved)throw new MessagingAdmissionError('Use an invitation or sign in with another provider first.',true);
    await client.query('DELETE FROM signup_waitlist WHERE phone=$1',[phone]);
  }
}
