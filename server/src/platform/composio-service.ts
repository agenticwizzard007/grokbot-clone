import { Composio } from '@composio/core';
import type { Directory } from './directory.js';
import { ConnectionGateway, trustedReadOnly, type ConnectionRegistry, type PrivateConnection, type ConnectionProvider } from './composio-policy.js';

const connection = (r: any): PrivateConnection => ({ id: r.id, tenant: r.tenant_id, toolkit: r.toolkit, revision: Number(r.revision), state: r.state, isDefault: r.is_default });
export class PgConnectionRegistry implements ConnectionRegistry {
  constructor(private directory: Directory) {}
  async identity(tenant: string) {
    const r = await this.directory.pool.query("SELECT composio_user_id FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted')", [tenant]);
    if (!r.rows[0]) throw new Error('Tenant revoked.'); return r.rows[0].composio_user_id as string;
  }
  async list(tenant: string) { return (await this.directory.pool.query("SELECT * FROM connected_accounts WHERE tenant_id=$1 AND state='active'", [tenant])).rows.map(connection); }
  async get(tenant: string, id: string) { const r = await this.directory.pool.query('SELECT * FROM connected_accounts WHERE tenant_id=$1 AND id=$2', [tenant, id]); return r.rows[0] && connection(r.rows[0]); }
  async revoke(tenant: string, id: string) {
    return !!(await this.directory.pool.query("UPDATE connected_accounts SET state='revoked',revision=revision+1,is_default=false WHERE tenant_id=$1 AND id=$2 RETURNING id", [tenant, id])).rowCount;
  }
  async begin(tenant: string, id: string, revision: number, dispatch: string, tool: string, hash: string) {
    return this.directory.transaction(async c => {
      const r = await c.query(`SELECT a.id FROM connected_accounts a JOIN tenants t ON t.id=a.tenant_id WHERE a.tenant_id=$1 AND a.id=$2
        AND a.revision=$3 AND a.state='active' AND t.state='active' FOR UPDATE OF a`, [tenant, id, revision]);
      if (!r.rowCount) return false;
      return !!(await c.query(`INSERT INTO dispatches(tenant_id,id,connection_id,revision,tool,arguments_hash,state)
        VALUES($1,$2,$3,$4,$5,$6,'dispatching') ON CONFLICT DO NOTHING RETURNING id`, [tenant, dispatch, id, revision, tool, hash])).rowCount;
    });
  }
  async finish(tenant: string, dispatch: string, state: 'completed' | 'uncertain') { await this.directory.pool.query('UPDATE dispatches SET state=$3 WHERE tenant_id=$1 AND id=$2', [tenant, dispatch, state]); }
}
export class ComposioProvider implements ConnectionProvider {
  readonly sdk: Composio;
  constructor(key: string) {
    if (!key || key.startsWith('ck_') || key.startsWith('uak_')) throw new Error('A platform Composio project key is required.');
    this.sdk = new Composio({ apiKey: key, dangerouslyAllowAutoUploadDownloadFiles: false });
  }
  async owned(identity: string, id: string) {
    let cursor: string | undefined; const seen = new Set<string>();
    do {
      const r = await this.sdk.connectedAccounts.list({ userIds: [identity], accountType: 'PRIVATE', cursor, limit: 100 });
      const item = r.items.find(i => i.id === id);
      if (item) return { toolkit: item.toolkit.slug, active: item.status === 'ACTIVE' };
      cursor = r.nextCursor ?? undefined;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('Invalid connection pagination.');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  async tool(slug: string) {
    const t = await this.sdk.tools.getRawComposioToolBySlug(slug);
    if (t.slug !== slug) throw new Error('Invalid tool selection.');
    return { toolkit: t.toolkit?.slug ?? '', version: t.version ?? '', readOnly: trustedReadOnly(t) };
  }
  execute(identity: string, id: string, slug: string, version: string, args: Record<string, unknown>) {
    return this.sdk.tools.execute(slug, { userId: identity, connectedAccountId: id, version, arguments: args }, { signal: AbortSignal.timeout(60_000) });
  }
  async disconnect(id: string) { await this.sdk.connectedAccounts.delete(id); }
  async refresh(id: string) { await this.sdk.connectedAccounts.refresh(id); return { ok: true }; }
}
export function createComposioService(directory: Directory) {
  const registry = new PgConnectionRegistry(directory), provider = new ComposioProvider(process.env.COMPOSIO_API_KEY ?? '');
  return { registry, provider, gateway: new ConnectionGateway(registry, provider) };
}
