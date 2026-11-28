import type { PoolClient } from 'pg';
import { signupPolicy } from './signup.js';

export type AdmissionState = 'invite_needed' | 'invite_invalid' | 'at_capacity' | 'closed';
export class AdmissionError extends Error {
  readonly needInvite: boolean;
  constructor(readonly code: AdmissionState) {
    super(code === 'invite_invalid' ? 'This invitation is no longer valid. It has expired or been used up.' : 'Swarm is invite only right now.');
    this.needInvite = code === 'invite_needed' || code === 'invite_invalid';
  }
}
export const signupLock = "SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))";
export function tenantLimit() {
  const raw = process.env.PLATFORM_TENANT_LIMIT ?? '100';
  if (!/^\d{1,7}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new Error('Invalid PLATFORM_TENANT_LIMIT.');
  return Number(raw);
}
// Carry bounded, untrusted input until verified identity admission. Existing accounts
// must still sign in even when the URL contains a stale or malformed invitation.
export function inviteInput(value: unknown): string | undefined {
  return value == null || value === '' ? undefined : typeof value === 'string' && value.length <= 64 ? value : 'invalid';
}
export function inviteCode(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{16,64}$/.test(value)) throw new AdmissionError('invite_invalid');
  return value.toUpperCase();
}
type Query = Pick<PoolClient, 'query'>;
export async function admissionCounts(client: Query) {
  const r = (await client.query(`SELECT count(*) FILTER (WHERE state NOT IN ('deleting','deleted','failed')) AS current,
    count(*) FILTER (WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS today FROM tenants`)).rows[0];
  return { current: Number(r.current), today: Number(r.today), limit: tenantLimit() };
}
export async function validWebInvite(client: Query, code: string) {
  return (await client.query(`SELECT code FROM web_invites WHERE code=$1 AND NOT revoked AND uses<max_uses AND expires_at>clock_timestamp()`, [code])).rowCount !== 0;
}
/** Only called for a genuinely new tenant, under the shared admission lock.
 * Identity, invite use and the create job all commit or roll back together. */
export async function admitNewTenant(client: PoolClient, provider: string, subject: string, supplied?: string) {
  await client.query(signupLock);
  const policy = await signupPolicy(client), counts = await admissionCounts(client);
  if (policy.mode === 'closed') throw new AdmissionError('closed');
  if (counts.current >= counts.limit || policy.signupsPerDay > 0 && counts.today >= policy.signupsPerDay) throw new AdmissionError('at_capacity');
  const phone = provider === 'phone';
  const claim = phone ? (await client.query('SELECT invite_code FROM messaging_claims WHERE phone=$1 AND expires_at>clock_timestamp()', [subject])).rows[0] : null;
  const code = inviteCode(supplied || claim?.invite_code);
  const approved = phone && (await client.query("SELECT 1 FROM signup_waitlist WHERE phone=$1 AND state='approved' AND verified_at>clock_timestamp()-interval '30 days'", [subject])).rowCount;
  if (code) {
    const web = await client.query(`UPDATE web_invites SET uses=uses+1 WHERE code=$1 AND NOT revoked AND uses<max_uses AND expires_at>clock_timestamp() RETURNING code`, [code]);
    if (!web.rowCount) {
      const messaging = phone && await client.query(`UPDATE messaging_invites i SET uses=uses+1 FROM tenants t WHERE i.code=$1 AND NOT i.revoked AND i.uses<i.max_uses
        AND (i.kind='admin' OR i.uses<$2) AND (i.expires_at IS NULL OR i.expires_at>clock_timestamp()) AND t.id=i.tenant_id AND t.state NOT IN ('deleting','deleted','failed') RETURNING i.code`, [code, policy.memberInvites]);
      if (!messaging || !messaging.rowCount) throw new AdmissionError('invite_invalid');
    }
  } else if (policy.mode !== 'open' && !approved) throw new AdmissionError('invite_needed');
  if (phone) {
    await client.query('DELETE FROM messaging_claims WHERE phone=$1', [subject]);
    await client.query('DELETE FROM signup_waitlist WHERE phone=$1', [subject]);
  }
}
