import { createHmac } from 'node:crypto';
import { hashToken, type Directory } from './directory.js';

export interface RelayOwner { tenant: string; generation: string; machine: string; session: string }

/** Only platform replicas receive this key. A tenant cookie is never a platform
 * bearer token, and remains stable across replicas for one runtime generation. */
export class TenantSessions {
  constructor(private directory: Directory, private key: string) {
    if (typeof key !== 'string' || Buffer.byteLength(key) < 32) throw new Error('Platform session derivation requires a shared secret of at least 32 bytes.');
  }
  token(tenant: string, generation: string, session: string) {
    return createHmac('sha256', this.key).update(JSON.stringify(['swarm-tenant-session-v1', tenant, generation, session])).digest('base64url');
  }
  hash(tenant: string, generation: string, session: string) {
    return hashToken(this.token(tenant, generation, session));
  }
  async bind(owner: RelayOwner) {
    return this.directory.transaction(async client => {
      // Follow lifecycle lock order; evaluate time/policy in a fresh statement
      // after waiting, so holds, deletion and expiry cannot be missed.
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [owner.tenant]);
      await client.query('SELECT hash FROM sessions WHERE hash=$1 AND tenant_id=$2 FOR UPDATE', [owner.session, owner.tenant]);
      const session = (await client.query(`SELECT s.* FROM sessions s JOIN tenants t ON t.id=s.tenant_id
        JOIN host_policies p ON p.tenant_id=t.id
        WHERE s.hash=$1 AND t.id=$2 AND t.generation=$3 AND t.machine_id=$4 AND t.state='active'
        AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '7 days'
        AND s.last_seen_at>clock_timestamp()-interval '24 hours'
        AND p.generation=t.generation AND p.machine_id=t.machine_id AND p.desired='run' AND p.observed='running'
        AND p.acknowledged_revision=p.revision AND p.error_code IS NULL AND p.reported_at>clock_timestamp()-interval '4 minutes'`,
      [owner.session, owner.tenant, owner.generation, owner.machine])).rows[0];
      if (!session) throw new Error('Session or environment authorization expired.');
      const cookie = this.token(owner.tenant, owner.generation, owner.session), hash = hashToken(cookie);
      await client.query(`INSERT INTO tenant_sessions(hash,session_hash,generation) VALUES($1,$2,$3)
        ON CONFLICT(session_hash,generation) DO UPDATE SET hash=excluded.hash`, [hash, owner.session, owner.generation]);
      return { cookie, hash, authenticatedAt: new Date(session.authenticated_at).getTime(),
        expiresAt: Math.min(new Date(session.expires_at).getTime(), new Date(session.created_at).getTime() + 7 * 86400_000) };
    });
  }
}

/** A runtime may resolve only its own current generation's delegated session.
 * This hash is never accepted by browser/platform session authentication. */
export async function resolveTenantSession(directory: Directory, owner: { tenant: string; generation: string }, hash: unknown) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return null;
  return (await directory.pool.query(`SELECT s.hash FROM tenant_sessions d JOIN sessions s ON s.hash=d.session_hash
    JOIN tenants t ON t.id=s.tenant_id WHERE d.hash=$1 AND t.id=$2 AND d.generation=$3 AND d.generation=t.generation
    AND t.state='active' AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '7 days'
    AND s.last_seen_at>clock_timestamp()-interval '24 hours'`, [hash, owner.tenant, owner.generation])).rows[0] ?? null;
}

/** Bounded housekeeping. Skip sessions held by sign-in/dispatch transactions;
 * deletion cascades mapping cleanup and broadcasts revocation after commit. */
export async function pruneSessionMetadata(directory: Directory) {
  return directory.transaction(async client => {
    const sessions = await client.query(`DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions
      WHERE expires_at<=clock_timestamp() OR created_at<=clock_timestamp()-interval '7 days'
        OR last_seen_at<=clock_timestamp()-interval '24 hours' ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)`);
    const delegated = await client.query(`DELETE FROM tenant_sessions WHERE hash IN (
      SELECT d.hash FROM tenant_sessions d JOIN sessions s ON s.hash=d.session_hash JOIN tenants t ON t.id=s.tenant_id
      WHERE d.generation<>t.generation ORDER BY d.hash LIMIT 500 FOR UPDATE OF d SKIP LOCKED)`);
    return {sessions:sessions.rowCount,delegated:delegated.rowCount};
  });
}
