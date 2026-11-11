import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Directory, hashToken } from './directory.js';

export interface SignupPolicy { mode: 'open' | 'invite' | 'closed'; signupsPerDay: number; memberInvites: number }
export class SignupError extends Error { constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409) { super(message); } }
type Query = Pick<PoolClient, 'query'>;
const integer = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
export async function signupPolicy(client: Query): Promise<SignupPolicy & { revision: string }> {
  const row = (await client.query('SELECT config,revision FROM signup_policy WHERE singleton')).rows[0];
  let config = row?.config;
  if (!config) {
    const { env } = await import('../env.js');
    config = { mode: env.messagingSignupMode, signupsPerDay: Number(env.messagingSignupsPerDay || 50), memberInvites: Number(env.messagingMemberInvites || 5) };
  }
  if (!['invite', 'open', 'closed'].includes(config.mode) || !integer(config.signupsPerDay, 100000) || !integer(config.memberInvites, 1000)) throw new Error('Invalid platform signup policy.');
  return { mode: config.mode, signupsPerDay: config.signupsPerDay, memberInvites: config.memberInvites, revision: String(row?.revision ?? 0) };
}

/** Metadata-only administration. No tenant database, prompts or provider credentials. */
export class SignupAdministration {
  constructor(readonly directory: Directory) {}
  async authorized<T>(raw: string | undefined, recent: boolean, action: (client: PoolClient, actor: string, check: () => Promise<void>) => Promise<T>): Promise<T> {
    if (!raw || raw.length > 256) throw new SignupError('Sign in to continue.', 401);
    const hash = hashToken(raw);
    return this.directory.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
      const session = (await client.query('SELECT tenant_id FROM sessions WHERE hash=$1', [hash])).rows[0];
      if (!session) throw new SignupError('Sign in to continue.', 401);
      // Lock in tenant/session/role order; read validity again after every wait.
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR SHARE', [session.tenant_id]);
      await client.query('SELECT hash FROM sessions WHERE hash=$1 FOR UPDATE', [hash]);
      await client.query("SELECT role FROM account_roles WHERE tenant_id=$1 AND role='admin' FOR SHARE", [session.tenant_id]);
      const check = async () => {
        const valid = (await client.query(`SELECT 1 FROM sessions s JOIN tenants t ON t.id=s.tenant_id WHERE s.hash=$1 AND s.tenant_id=$2
          AND t.state NOT IN ('deleting','deleted','failed') AND s.expires_at>clock_timestamp()
          AND s.created_at>clock_timestamp()-interval '7 days' AND s.last_seen_at>clock_timestamp()-interval '24 hours'
          AND (NOT $3::boolean OR s.authenticated_at>clock_timestamp()-interval '10 minutes')`, [hash, session.tenant_id, recent])).rowCount;
        if (!valid) throw new SignupError(recent ? 'Sign in again to change signup settings.' : 'Sign in to continue.', 401);
        if (!(await client.query("SELECT 1 FROM account_roles WHERE tenant_id=$1 AND role='admin'", [session.tenant_id])).rowCount) throw new SignupError('Administrator access required.', 403);
      };
      await check();
      await client.query('UPDATE sessions SET last_seen_at=clock_timestamp() WHERE hash=$1', [hash]);
      return action(client, session.tenant_id as string, check);
    });
  }
  async settings(raw?: string) { return this.authorized(raw, false, c => signupPolicy(c)); }
  async update(raw: string | undefined, body: unknown) {
    const b = body as any;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['mode','signupsPerDay','memberInvites','revision'].includes(k)) || !/^\d{1,18}$/.test(b.revision ?? '') || typeof b.revision !== 'string') throw new SignupError('Invalid signup settings.', 400);
    if (b.mode !== undefined && !['open','invite','closed'].includes(b.mode) || b.signupsPerDay !== undefined && !integer(b.signupsPerDay,100000) || b.memberInvites !== undefined && !integer(b.memberInvites,1000)) throw new SignupError('Invalid signup settings.', 400);
    return this.authorized(raw, true, async (c, actor, check) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
      const current = await signupPolicy(c); await check();
      if (current.revision !== b.revision) throw new SignupError('Signup settings changed. Reload before saving.', 409);
      const config: SignupPolicy = { mode: b.mode ?? current.mode, signupsPerDay: b.signupsPerDay ?? current.signupsPerDay, memberInvites: b.memberInvites ?? current.memberInvites };
      await c.query(`INSERT INTO signup_policy(singleton,config,updated_by) VALUES(true,$1,$2)
        ON CONFLICT(singleton) DO UPDATE SET config=excluded.config,revision=signup_policy.revision+1,updated_by=excluded.updated_by,updated_at=clock_timestamp()`, [config,actor]);
      return signupPolicy(c);
    });
  }
  async invites(raw: string | undefined, cursor = '') {
    if (!/^[A-F0-9]{0,16}$/.test(cursor)) throw new SignupError('Invalid page.', 400);
    return this.authorized(raw, false, async c => {
      const rows = (await c.query('SELECT i.*,t.display_name FROM messaging_invites i JOIN tenants t ON t.id=i.tenant_id WHERE i.code>$1 ORDER BY i.code LIMIT 101', [cursor])).rows;
      return { invites: rows.slice(0,100).map(inviteView), next: rows.length > 100 ? rows[99].code as string : null };
    });
  }
  async createInvite(raw: string | undefined, body: unknown) {
    const b = body as any;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['maxUses','expiresInDays','note'].includes(k))) throw new SignupError('Invalid invite.', 400);
    const uses = b.maxUses ?? 1, days = b.expiresInDays === null ? null : b.expiresInDays ?? 7;
    if (!integer(uses,100000) || uses < 1 || days !== null && (!integer(days,365) || days < 1) || b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 200)) throw new SignupError('Invalid invite limits.', 400);
    return this.authorized(raw, true, async (c, actor, check) => {
      await check();
      const row = (await c.query("INSERT INTO messaging_invites(code,tenant_id,max_uses,kind,expires_at,note) VALUES($1,$2,$3,'admin',CASE WHEN $4::int IS NULL THEN NULL ELSE clock_timestamp()+$4*interval '1 day' END,$5) RETURNING *", [randomBytes(8).toString('hex').toUpperCase(),actor,uses,days,b.note?.trim() || null])).rows[0];
      return { invite: inviteView(row) };
    });
  }
  async revokeInvite(raw: string | undefined, code: string) {
    if (!/^[A-F0-9]{16}$/.test(code)) throw new SignupError('Invitation not found.', 404);
    return this.authorized(raw, true, async (c, _actor, check) => {
      await c.query('SELECT code FROM messaging_invites WHERE code=$1 FOR UPDATE', [code]); await check();
      if (!(await c.query('UPDATE messaging_invites SET revoked=true WHERE code=$1 RETURNING code', [code])).rowCount) throw new SignupError('Invitation not found.',404);
      await c.query('DELETE FROM messaging_claims WHERE invite_code=$1', [code]); return { ok: true };
    });
  }
  async waitlist(raw: string | undefined, cursor = '') {
    if (!/^\d{0,15}$/.test(cursor)) throw new SignupError('Invalid page.',400);
    return this.authorized(raw, false, async c => {
      const rows = (await c.query('SELECT * FROM signup_waitlist WHERE phone>$1 ORDER BY phone LIMIT 101',[cursor])).rows;
      return { waitlist: rows.slice(0,100).map(r => ({ phone:r.phone, channel:r.channel, name:null, firstMessage:null, status:r.state, revision:String(r.revision), createdAt:new Date(r.created_at).getTime(), decidedAt:r.decided_at ? new Date(r.decided_at).getTime() : null })), next: rows.length>100 ? rows[99].phone as string : null };
    });
  }
  async decide(raw: string | undefined, phone: string, revision: unknown, state: 'approved' | 'declined') {
    if (!/^\d{8,15}$/.test(phone) || typeof revision !== 'string' || !/^[1-9]\d{0,17}$/.test(revision)) throw new SignupError('Invalid waitlist decision.',400);
    return this.authorized(raw,true,async(c,actor,check)=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
      await check();
      if (!(await c.query('UPDATE signup_waitlist SET state=$3,revision=revision+1,decided_at=clock_timestamp(),decided_by=$4 WHERE phone=$1 AND revision=$2 RETURNING phone',[phone,revision,state,actor])).rowCount) throw new SignupError('Waitlist entry changed. Reload before deciding.',409);
      return { ok:true };
    });
  }
}
function inviteView(row: any) {
  return { code:row.code, createdBy:row.tenant_id, createdByName:row.display_name ?? null, maxUses:row.max_uses, uses:row.uses, expiresAt:row.expires_at ? new Date(row.expires_at).getTime() : null, note:row.note, revoked:row.revoked, createdAt:new Date(row.created_at).getTime(), kind:row.kind, url:new URL(`/join/${row.code}`,process.env.PLATFORM_URL!).href };
}

/** Called only after validating the provider signature; no message body/name is persisted. */
export async function noteVerifiedWaiter(directory: Directory, phone: string, channel: string) {
  if (!/^\d{8,15}$/.test(phone) || !['imessage','sms','whatsapp'].includes(channel)) throw new Error('Invalid verified contact.');
  await directory.transaction(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
    await c.query("DELETE FROM signup_waitlist WHERE verified_at<now()-interval '30 days'");
    if ((await c.query("SELECT 1 FROM identities WHERE provider='phone' AND subject=$1",[phone])).rowCount) return;
    if (!(await c.query('SELECT 1 FROM signup_waitlist WHERE phone=$1',[phone])).rowCount && Number((await c.query('SELECT count(*) n FROM signup_waitlist')).rows[0].n)>=10000) return;
    await c.query('INSERT INTO signup_waitlist(phone,channel) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET verified_at=clock_timestamp()', [phone,channel]);
  });
}

export async function pruneSignupMetadata(directory: Directory) {
  await directory.transaction(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
    await c.query("DELETE FROM signup_waitlist WHERE verified_at<clock_timestamp()-interval '30 days'");
    await c.query('DELETE FROM messaging_claims WHERE expires_at<=clock_timestamp()');
    await c.query('DELETE FROM phone_attempts WHERE hash IN (SELECT hash FROM phone_attempts WHERE expires_at<=clock_timestamp() FOR UPDATE SKIP LOCKED)');
  });
}
