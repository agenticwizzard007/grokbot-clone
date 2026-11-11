import type { PoolClient } from 'pg';
import type { Directory } from './directory.js';

export type Revocation = { tenant: string; session?: string; scope?: 'desktop' | 'native-local' | 'cli' };

/** Dedicated PostgreSQL LISTEN connection. Losing notification continuity closes
 * relays; reconnect permits new authoritatively checked requests, never replay. */
export class SessionNotifications {
  private client?: PoolClient;
  private retry?: ReturnType<typeof setTimeout>;
  private disconnect?: () => void;
  private stopped = false;
  constructor(private directory: Directory, private change: (event: Revocation) => void, private ready: (value: boolean) => void) {}
  async start() {
    if (this.stopped) return;
    this.ready(false);
    const client = await this.directory.pool.connect();
    if (this.stopped) { client.release(); return; }
    this.client = client;
    let lost = false;
    const disconnect = () => {
      if (lost) return; lost = true;
      if (this.client === client) { this.client = undefined; this.disconnect = undefined; }
      this.ready(false);
      client.release(true);
      this.schedule();
    };
    this.disconnect = disconnect;
    client.on('error', disconnect); client.on('end', disconnect);
    try {
      const schema = (await client.query('SELECT current_schema() AS name')).rows[0].name;
      client.on('notification', message => {
        if (lost || this.stopped || message.channel !== 'swarm_revocations') return;
        try {
          const event = JSON.parse(message.payload ?? '');
          if (event.schema !== schema) return;
          if (typeof event.tenant !== 'string' || event.tenant.length > 256 || event.session !== undefined && !/^[a-f0-9]{64}$/.test(event.session)
            || event.scope !== undefined && !['desktop','native-local','cli'].includes(event.scope)
            || event.session !== undefined && event.scope !== undefined) throw new Error('Invalid revocation notification.');
          this.change({ tenant:event.tenant, ...(event.session ? {session:event.session} : {}), ...(event.scope ? {scope:event.scope} : {}) });
        } catch { disconnect(); }
      });
      await client.query('LISTEN swarm_revocations');
      const guards = await client.query(`SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc f ON f.oid=g.tgfoid
        WHERE n.nspname=current_schema() AND g.tgenabled IN ('O','A') AND NOT g.tgisinternal
        AND (c.relname,g.tgname,f.proname) IN (('sessions','swarm_session_revocation','swarm_session_revocation'),
          ('companion_routes','swarm_companion_revocation','swarm_companion_revocation'),
          ('tenants','swarm_tenant_revocation','swarm_tenant_revocation'),('host_policies','swarm_host_revocation','swarm_host_revocation'))`);
      if (guards.rowCount !== 4) throw new Error('Directory revocation migrations are required.');
      if (lost || this.stopped) throw new Error('Revocation subscription interrupted.');
      this.ready(true);
    } catch (error) { disconnect(); throw error; }
  }
  private schedule() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.start().catch(() => this.schedule()); }, 1000).unref();
  }
  stop() {
    this.stopped = true; clearTimeout(this.retry); this.retry = undefined;
    if (this.disconnect) this.disconnect(); else this.ready(false);
  }
}
