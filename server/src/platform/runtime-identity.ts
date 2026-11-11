import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import type { Directory } from './directory.js';
import { hashToken, opaqueToken } from './directory.js';
import type { PoolClient } from 'pg';
export interface VerifiedRuntime { tenant: string; generation: string; machine: string }
export class RuntimeIdentity {
  constructor(private directory: Directory, private privateKey: string, private publicKey: string) {}
  async sign(claims: Record<string, unknown>, audience: string, lifetime = '60s') {
    return new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA' }).setIssuer('swarm-platform').setAudience(audience)
      .setIssuedAt().setExpirationTime(lifetime).setJti(opaqueToken()).sign(await importPKCS8(this.privateKey, 'EdDSA'));
  }
  async exchange(raw: string, tenant: string, machine: string, nextRefresh?: string) {
    if (nextRefresh !== undefined && (!/^[A-Za-z0-9_-]{43}$/.test(nextRefresh) || nextRefresh === raw)) throw new Error('Invalid refresh replacement.');
    const refresh = nextRefresh ?? opaqueToken();
    const identity = await this.directory.transaction(async client => {
      const { rows } = await client.query(`DELETE FROM runtime_credentials r USING tenants t WHERE r.hash=$1 AND r.tenant_id=$2 AND r.machine_id=$3
        AND t.id=r.tenant_id AND t.generation=r.generation AND t.machine_id=r.machine_id
        AND t.state IN ('active','provisioning') AND r.revoked_at IS NULL AND r.expires_at>now() RETURNING r.*`, [hashToken(raw), tenant, machine]);
      if (!rows[0]) {
        // The host persisted its successor before the exchange. A lost response
        // can be recovered only with both secrets, while that successor is live.
        const retry = nextRefresh && (await client.query(`SELECT r.* FROM runtime_credentials r JOIN tenants t ON t.id=r.tenant_id
          WHERE r.hash=$1 AND r.parent_hash=$2 AND r.tenant_id=$3 AND r.machine_id=$4
          AND r.generation=t.generation AND r.machine_id=t.machine_id AND r.revoked_at IS NULL
          AND r.expires_at>now() AND t.state IN ('active','provisioning')`, [hashToken(nextRefresh),hashToken(raw),tenant,machine])).rows[0];
        if (retry) return retry;
        throw new Error('Invalid runtime identity.');
      }
      const r = rows[0];
      await client.query(`INSERT INTO runtime_credentials(hash,tenant_id,machine_id,generation,kind,expires_at,parent_hash)
        VALUES($1,$2,$3,$4,'refresh',now()+interval '30 days',$5)`, [hashToken(refresh), tenant, machine, r.generation, nextRefresh ? hashToken(raw) : null]);
      return r;
    });
    const claims={sub:tenant,machine,generation:String(identity.generation)};
    return { refresh, token: await this.sign(claims, 'swarm-runtime', '5m'), hostToken:await this.sign(claims,'swarm-host','5m'), expiresIn: 300 };
  }
  async verify(token: string, audience: 'swarm-runtime' | 'swarm-host' = 'swarm-runtime', client?: PoolClient): Promise<VerifiedRuntime> {
    const { payload } = await jwtVerify(token, await importSPKI(this.publicKey, 'EdDSA'), {
      issuer: 'swarm-platform', audience, algorithms: ['EdDSA'], maxTokenAge: '5m', requiredClaims: ['sub', 'iat', 'exp', 'jti'],
    });
    // Lock first, then read authorization in a fresh statement snapshot. Reading
    // host policy in the same SELECT that waits on this lock can see a stale run
    // permit after a concurrent lifecycle worker has changed it to hold.
    if (client) await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [payload.sub]);
    const { rows } = await (client ?? this.directory.pool).query(`SELECT id,generation,machine_id FROM tenants WHERE id=$1 AND generation=$2
      AND machine_id=$3 AND state IN ('active','provisioning')
      AND $5::double precision>extract(epoch FROM clock_timestamp()) AND $6::double precision>=extract(epoch FROM clock_timestamp())-300
      AND ($4='swarm-host' OR EXISTS(SELECT 1 FROM host_policies p WHERE p.tenant_id=tenants.id AND p.generation=tenants.generation AND p.machine_id=tenants.machine_id AND p.desired='run'))`, [payload.sub, payload.generation, payload.machine,audience,payload.exp,payload.iat]);
    if (!rows.length) throw new Error('Runtime revoked.');
    return { tenant: rows[0].id as string, generation: String(rows[0].generation), machine: rows[0].machine_id as string };
  }
  async authorized<T>(token: string, effect: (owner: VerifiedRuntime, client: PoolClient) => Promise<T>) {
    return this.directory.transaction(async client => effect(await this.verify(token, 'swarm-runtime', client), client));
  }
}
