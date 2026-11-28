import { Pool, type PoolClient } from 'pg';
import { bindTenantLog } from './tenant-logs.js';
import { admitNewTenant } from './onboarding.js';
import { randomBytes, createHash } from 'node:crypto';
export const hashToken = (v: string) => createHash('sha256').update(v).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');
export class Directory {
  readonly pool: Pool;
  constructor(url = process.env.DATABASE_URL) {
    if (!url) throw new Error('Platform PostgreSQL is required.');
    this.pool = new Pool({ connectionString: url, max: 20, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
      statement_timeout: 10_000, application_name: 'swarm-directory' });
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async migrate() {
    await this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('swarm-directory-schema'))");
      await client.query(`
        CREATE TABLE IF NOT EXISTS tenants (
          id text PRIMARY KEY, display_name text NOT NULL, verified_email text,
          state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','provisioning','active','suspended','deleting','deleted','failed')),
          generation bigint NOT NULL DEFAULT 1, fly_app text UNIQUE, network_id text UNIQUE, machine_id text,
          volume_id text UNIQUE, region text, image_digest text, encrypted_data_key bytea,
          composio_user_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS identities (
          provider text NOT NULL, subject text NOT NULL, tenant_id text NOT NULL REFERENCES tenants(id),
          PRIMARY KEY(provider,subject), UNIQUE(provider,tenant_id));
        CREATE TABLE IF NOT EXISTS legacy_identity_claims (
          provider text NOT NULL, subject text NOT NULL, tenant_id text NOT NULL REFERENCES tenants(id),
          snapshot_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(provider,subject), UNIQUE(provider,tenant_id));
        CREATE TABLE IF NOT EXISTS sessions (
          hash text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), device text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(), authenticated_at timestamptz NOT NULL DEFAULT now(),
          last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days');
        CREATE INDEX IF NOT EXISTS sessions_tenant ON sessions(tenant_id);
        CREATE TABLE IF NOT EXISTS tenant_sessions (
          hash text PRIMARY KEY, session_hash text NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
          generation bigint NOT NULL, UNIQUE(session_hash,generation));
        CREATE TABLE IF NOT EXISTS account_roles (tenant_id text NOT NULL REFERENCES tenants(id), role text NOT NULL CHECK(role='admin'), PRIMARY KEY(tenant_id,role));
        CREATE TABLE IF NOT EXISTS auth_attempts (
          hash text PRIMARY KEY, provider text NOT NULL, browser_hash text NOT NULL, payload jsonb NOT NULL,
          link_session text REFERENCES sessions(hash) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime_credentials (
          hash text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), machine_id text NOT NULL,
          generation bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('bootstrap','refresh')),
          expires_at timestamptz NOT NULL, revoked_at timestamptz);
        ALTER TABLE runtime_credentials ADD COLUMN IF NOT EXISTS parent_hash text;
        CREATE TABLE IF NOT EXISTS host_policies (
          tenant_id text PRIMARY KEY REFERENCES tenants(id), generation bigint NOT NULL, machine_id text NOT NULL,
          desired text NOT NULL CHECK(desired IN ('hold','run')), revision bigint NOT NULL DEFAULT 1,
          acknowledged_revision bigint, observed text CHECK(observed IN ('held','running')),
          reported_at timestamptz, error_code text);
        ALTER TABLE host_policies ADD COLUMN IF NOT EXISTS usage_not_before timestamptz NOT NULL DEFAULT clock_timestamp();
        CREATE TABLE IF NOT EXISTS companion_routes (
          hash text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), scope text NOT NULL,
          generation bigint NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
          UNIQUE(tenant_id,scope));
        CREATE TABLE IF NOT EXISTS lifecycle_jobs (
          id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), operation text NOT NULL,
          state text NOT NULL DEFAULT 'queued', step text NOT NULL DEFAULT 'start', attempts integer NOT NULL DEFAULT 0,
          lease_owner text, fence bigint NOT NULL DEFAULT 0, lease_until timestamptz, retry_at timestamptz NOT NULL DEFAULT now(),
          error_code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,operation));
        CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_one_running_per_tenant ON lifecycle_jobs(tenant_id) WHERE state='running';
        CREATE TABLE IF NOT EXISTS infrastructure_actions (
          tenant_id text NOT NULL REFERENCES tenants(id),generation bigint NOT NULL,kind text NOT NULL,
          state text NOT NULL CHECK(state IN ('dispatching','observed')),resource_id text,
          created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,generation,kind));
        CREATE TABLE IF NOT EXISTS connected_accounts (
          id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), toolkit text NOT NULL,
          revision bigint NOT NULL DEFAULT 1, state text NOT NULL CHECK(state IN ('pending','active','revoked','deleted')), is_default boolean NOT NULL DEFAULT false);
        CREATE UNIQUE INDEX IF NOT EXISTS connection_default ON connected_accounts(tenant_id,toolkit) WHERE is_default;
        CREATE TABLE IF NOT EXISTS connection_attempts (
          hash text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), session_hash text NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
          toolkit text NOT NULL, connection_id text, expires_at timestamptz NOT NULL, consumed_at timestamptz);
        ALTER TABLE connection_attempts ADD COLUMN IF NOT EXISTS native boolean NOT NULL DEFAULT false;
        CREATE TABLE IF NOT EXISTS dispatches (
          tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, connection_id text NOT NULL REFERENCES connected_accounts(id),
          revision bigint NOT NULL, tool text NOT NULL, arguments_hash text NOT NULL,
          state text NOT NULL CHECK(state IN ('dispatching','completed','uncertain','rejected')), created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(tenant_id,id));
        CREATE TABLE IF NOT EXISTS provider_triggers (
          id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), connection_id text NOT NULL REFERENCES connected_accounts(id),
          revision bigint NOT NULL, state text NOT NULL DEFAULT 'active');
        CREATE TABLE IF NOT EXISTS wake_events (
          tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, ciphertext bytea NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id));
        CREATE TABLE IF NOT EXISTS release_gates (name text NOT NULL, evidence_uri text NOT NULL, image_digest text NOT NULL, approved_at timestamptz NOT NULL);
        ALTER TABLE release_gates DROP CONSTRAINT IF EXISTS release_gates_pkey;
        ALTER TABLE release_gates ADD PRIMARY KEY(name,image_digest);
        ALTER TABLE release_gates ADD COLUMN IF NOT EXISTS evidence_sha256 text;
        ALTER TABLE release_gates ADD COLUMN IF NOT EXISTS reviewer text;
        CREATE TABLE IF NOT EXISTS phone_attempts (
          hash text PRIMARY KEY, phone text NOT NULL, ciphertext text NOT NULL, code_hash text NOT NULL,
          link_session text REFERENCES sessions(hash) ON DELETE CASCADE, attempts integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes');
        CREATE INDEX IF NOT EXISTS phone_attempts_owner ON phone_attempts(phone,created_at);
        CREATE TABLE IF NOT EXISTS messaging_routes (
          tenant_id text NOT NULL REFERENCES tenants(id), channel text NOT NULL, phone text NOT NULL,
          conversation_id text, revision bigint NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,channel), UNIQUE(channel,phone));
        ALTER TABLE messaging_routes ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active';
        CREATE TABLE IF NOT EXISTS messaging_dispatches (
          tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, channel text NOT NULL, revision bigint NOT NULL,
          state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id));
        CREATE TABLE IF NOT EXISTS messaging_receipts (
          tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, channel text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id));
        ALTER TABLE messaging_receipts ADD COLUMN IF NOT EXISTS revision bigint;
        CREATE TABLE IF NOT EXISTS messaging_invites (
          code text PRIMARY KEY, tenant_id text NOT NULL UNIQUE REFERENCES tenants(id),
          max_uses integer NOT NULL, uses integer NOT NULL DEFAULT 0, revoked boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now());
        ALTER TABLE messaging_invites ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'member';
        ALTER TABLE messaging_invites ADD COLUMN IF NOT EXISTS expires_at timestamptz;
        ALTER TABLE messaging_invites ADD COLUMN IF NOT EXISTS note text;
        ALTER TABLE messaging_invites DROP CONSTRAINT IF EXISTS messaging_invites_tenant_id_key;
        CREATE UNIQUE INDEX IF NOT EXISTS messaging_member_invite ON messaging_invites(tenant_id) WHERE kind='member';
        CREATE TABLE IF NOT EXISTS signup_policy (
          singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), config jsonb NOT NULL,
          revision bigint NOT NULL DEFAULT 1, updated_by text NOT NULL REFERENCES tenants(id), updated_at timestamptz NOT NULL DEFAULT now());
        ALTER TABLE signup_policy ALTER COLUMN updated_by DROP NOT NULL;
        CREATE TABLE IF NOT EXISTS web_invites (
          code text PRIMARY KEY, max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 100000),
          uses integer NOT NULL DEFAULT 0 CHECK(uses>=0 AND uses<=max_uses), revoked boolean NOT NULL DEFAULT false,
          expires_at timestamptz NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE TABLE IF NOT EXISTS web_waitlist (
          id text PRIMARY KEY, contact text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('email','phone')),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          invite_code text REFERENCES web_invites(code), approved_at timestamptz);
        ALTER TABLE phone_attempts ADD COLUMN IF NOT EXISTS invite_code text;
        CREATE TABLE IF NOT EXISTS signup_waitlist (
          phone text PRIMARY KEY, channel text NOT NULL CHECK(channel IN ('imessage','sms','whatsapp')),
          state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','declined')),
          revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
          verified_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, decided_by text REFERENCES tenants(id));
        CREATE TABLE IF NOT EXISTS messaging_claims (
          phone text PRIMARY KEY, invite_code text NOT NULL REFERENCES messaging_invites(code), expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS messaging_tokens (
          hash text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), purpose text NOT NULL,
          channel text, revision bigint, session_hash text REFERENCES sessions(hash) ON DELETE CASCADE,
          expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS platform_rate_windows (
          key text NOT NULL, window_id bigint NOT NULL, hits integer NOT NULL DEFAULT 0, PRIMARY KEY(key,window_id));
        CREATE TABLE IF NOT EXISTS backups (
          tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, generation bigint NOT NULL,
          scope text NOT NULL CHECK(scope IN ('database','environment')), state text NOT NULL DEFAULT 'uploading',
          expected_parts integer NOT NULL, expected_bytes bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz, expires_at timestamptz NOT NULL, error_code text,
          PRIMARY KEY(tenant_id,id));
        CREATE TABLE IF NOT EXISTS backup_parts (
          tenant_id text NOT NULL, backup_id text NOT NULL, name text NOT NULL, bytes bigint NOT NULL, sha256 text NOT NULL,
          PRIMARY KEY(tenant_id,backup_id,name), FOREIGN KEY(tenant_id,backup_id) REFERENCES backups(tenant_id,id) ON DELETE CASCADE);
        ALTER TABLE backup_parts ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready';
        ALTER TABLE backup_parts ADD COLUMN IF NOT EXISTS lease_until timestamptz;
        ALTER TABLE backup_parts ADD COLUMN IF NOT EXISTS upload_owner text;
        CREATE TABLE IF NOT EXISTS backup_status (
          tenant_id text PRIMARY KEY REFERENCES tenants(id), generation bigint NOT NULL,
          last_database_at timestamptz, last_environment_at timestamptz, pending_id text, error_code text,
          reported_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS host_installations (
          tenant_id text PRIMARY KEY REFERENCES tenants(id), id text NOT NULL UNIQUE,
          machine_id text NOT NULL, volume_id text NOT NULL, generation bigint NOT NULL,
          full_backup text NOT NULL, database_backup text,
          state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','installed')),
          receipt_hash text, created_at timestamptz NOT NULL DEFAULT now(), installed_at timestamptz);
        CREATE TABLE IF NOT EXISTS environment_operations (
          id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES tenants(id),kind text NOT NULL CHECK(kind IN ('restore','update')),
          phase text NOT NULL DEFAULT 'stopping',source_generation bigint NOT NULL,target_generation bigint NOT NULL,
          source_machine text NOT NULL,source_volume text NOT NULL,source_image text NOT NULL,
          image_digest text NOT NULL,region text NOT NULL,full_backup text,database_backup text,
          target_machine text,target_volume text,source_removed boolean NOT NULL DEFAULT false,
          lease_owner text,lease_until timestamptz,fence bigint NOT NULL DEFAULT 0,attempts integer NOT NULL DEFAULT 0,
          retry_at timestamptz NOT NULL DEFAULT now(),error_code text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
        CREATE UNIQUE INDEX IF NOT EXISTS environment_one_operation ON environment_operations(tenant_id) WHERE phase NOT IN ('completed','cancelled');
        ALTER TABLE environment_operations ADD COLUMN IF NOT EXISTS run_authorized_at timestamptz;
        ALTER TABLE environment_operations ADD COLUMN IF NOT EXISTS rollback_operation text;
        ALTER TABLE environment_operations ADD COLUMN IF NOT EXISTS source_guest jsonb;
        ALTER TABLE environment_operations ADD COLUMN IF NOT EXISTS source_volume_gb integer;
        ALTER TABLE environment_operations ADD COLUMN IF NOT EXISTS capacity_change jsonb;
        UPDATE environment_operations SET capacity_change=capacity_change-'samples' WHERE capacity_change ? 'samples';
        CREATE TABLE IF NOT EXISTS tenant_capacity_policies (
          tenant_id text PRIMARY KEY REFERENCES tenants(id),policy jsonb NOT NULL,
          revision bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS host_usage_samples (
          tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,generation bigint NOT NULL,machine_id text NOT NULL,volume_id text NOT NULL,
          host_revision bigint NOT NULL,stream uuid NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),at bigint NOT NULL,
          interval_ms integer NOT NULL CHECK(interval_ms BETWEEN 15000 AND 60000),
          cpu double precision NOT NULL CHECK(cpu BETWEEN 0 AND 1),memory double precision NOT NULL CHECK(memory BETWEEN 0 AND 1),
          used_bytes bigint NOT NULL CHECK(used_bytes BETWEEN 0 AND 10737418240000),received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY(tenant_id,at));
        ALTER TABLE host_usage_samples ADD COLUMN IF NOT EXISTS filesystems jsonb;
        CREATE TABLE IF NOT EXISTS tenant_meter (
          tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, day date NOT NULL,
          metric text NOT NULL, quantity numeric NOT NULL CHECK(quantity>=0 AND quantity<1e15), unit text NOT NULL,
          cost_usd numeric CHECK(cost_usd>=0 AND cost_usd<1e15), source text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,day,metric,source),
          CHECK((source='provisioner' AND ((metric='machine_running_seconds' AND unit='seconds') OR (metric='storage_gb_days' AND unit='GB-days')))
            OR (source='tenant' AND ((metric='model_spend_usd' AND unit='USD') OR (metric IN ('computer_minutes','voice_minutes') AND unit='minutes')))));
        CREATE INDEX IF NOT EXISTS tenant_meter_retention ON tenant_meter(day);
        CREATE TABLE IF NOT EXISTS tenant_allowances (
          tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
          monthly_usd numeric NOT NULL CHECK(monthly_usd>0 AND monthly_usd<=1000000000),
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE TABLE IF NOT EXISTS tenant_meter_status (
          tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
          report_at bigint, reported_at timestamptz, last_tunnel_at timestamptz,
          last_poll_at timestamptz, observed_at timestamptz, poll_failed boolean NOT NULL DEFAULT false);
        CREATE TABLE IF NOT EXISTS tenant_meter_resources (
          tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          kind text NOT NULL CHECK(kind IN ('machine','volume')), resource_id text NOT NULL,
          generation bigint NOT NULL, at bigint NOT NULL, quantity numeric NOT NULL CHECK(quantity>=0 AND quantity<=10000),
          state text NOT NULL, PRIMARY KEY(tenant_id,kind,resource_id));
        CREATE TABLE IF NOT EXISTS retired_volumes (
          tenant_id text NOT NULL REFERENCES tenants(id),volume_id text NOT NULL,operation_id text NOT NULL REFERENCES environment_operations(id),
          delete_after timestamptz NOT NULL,state text NOT NULL DEFAULT 'pending',error_code text,PRIMARY KEY(tenant_id,volume_id));
        CREATE TABLE IF NOT EXISTS migration_runs (
          tenant_id text PRIMARY KEY REFERENCES tenants(id), id text NOT NULL UNIQUE,
          phase text NOT NULL DEFAULT 'prepared', writer text NOT NULL DEFAULT 'legacy',
          package_hash text NOT NULL, source_checkpoint text NOT NULL, source_fence text,
          target_checkpoint text, target_generation bigint, target_machine text, target_volume text,
          lease_owner text, lease_until timestamptz, fence bigint NOT NULL DEFAULT 0,
          error_code text, updated_at timestamptz NOT NULL DEFAULT now());
        ALTER TABLE migration_runs ALTER COLUMN package_hash DROP NOT NULL;
        ALTER TABLE migration_runs ALTER COLUMN source_checkpoint DROP NOT NULL;
        ALTER TABLE migration_runs ADD COLUMN IF NOT EXISTS source_retired_at timestamptz;
        ALTER TABLE migration_runs ADD COLUMN IF NOT EXISTS source_retirement_digest text;
        CREATE TABLE IF NOT EXISTS migration_destinations (
          tenant_id text PRIMARY KEY REFERENCES tenants(id),migration_id text NOT NULL UNIQUE REFERENCES migration_runs(id),
          plan_digest text NOT NULL,source_checkpoint text NOT NULL,source_fence text NOT NULL,generation bigint NOT NULL,
          image_digest text NOT NULL,region text NOT NULL,fly_app text NOT NULL,network_id text NOT NULL,volume_id text,
          state text NOT NULL DEFAULT 'allocating' CHECK(state IN ('allocating','reserved')),
          created_at timestamptz NOT NULL DEFAULT now(),reserved_at timestamptz);
        CREATE TABLE IF NOT EXISTS migration_transfers (
          tenant_id text PRIMARY KEY REFERENCES tenants(id),migration_id text NOT NULL UNIQUE REFERENCES migration_runs(id),
          source_checkpoint text NOT NULL,source_fence text NOT NULL,package_hash text NOT NULL,backup_id text NOT NULL,
          generation bigint NOT NULL,volume_id text NOT NULL,expected_parts integer NOT NULL,expected_bytes bigint NOT NULL,
          state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','complete','revoked')),
          created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
        CREATE TABLE IF NOT EXISTS host_checkpoints (
          tenant_id text PRIMARY KEY REFERENCES tenants(id),id text NOT NULL UNIQUE,migration_id text NOT NULL REFERENCES migration_runs(id),
          machine_id text NOT NULL,volume_id text NOT NULL,generation bigint NOT NULL,policy_revision bigint NOT NULL,
          state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uploading','complete','cancelled')),
          backup_id text,receipt_hash text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
        ALTER TABLE backups ADD COLUMN IF NOT EXISTS checkpoint_id text REFERENCES host_checkpoints(id);
        CREATE TABLE IF NOT EXISTS migration_targets (
          tenant_id text PRIMARY KEY REFERENCES tenants(id),migration_id text NOT NULL UNIQUE REFERENCES migration_runs(id),
          generation bigint NOT NULL,machine_id text,volume_id text NOT NULL,installation_id text NOT NULL,
          image_digest text NOT NULL,run_authorized_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
        CREATE OR REPLACE FUNCTION swarm_session_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_notify('swarm_revocations',json_build_object('schema',TG_TABLE_SCHEMA,'tenant',OLD.tenant_id,'session',OLD.hash)::text);
          RETURN NULL;
        END $$;
        DROP TRIGGER IF EXISTS swarm_session_revocation ON sessions;
        CREATE TRIGGER swarm_session_revocation AFTER DELETE OR UPDATE OF hash,tenant_id,expires_at,authenticated_at,created_at ON sessions
          FOR EACH ROW EXECUTE FUNCTION swarm_session_revocation();
        CREATE OR REPLACE FUNCTION swarm_companion_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_notify('swarm_revocations',json_build_object('schema',TG_TABLE_SCHEMA,'tenant',OLD.tenant_id,'scope',OLD.scope)::text);
          RETURN NULL;
        END $$;
        DROP TRIGGER IF EXISTS swarm_companion_revocation ON companion_routes;
        CREATE TRIGGER swarm_companion_revocation AFTER DELETE OR UPDATE ON companion_routes
          FOR EACH ROW EXECUTE FUNCTION swarm_companion_revocation();
        CREATE OR REPLACE FUNCTION swarm_tenant_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state IS DISTINCT FROM OLD.state OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.machine_id IS DISTINCT FROM OLD.machine_id THEN
            PERFORM pg_notify('swarm_revocations',json_build_object('schema',TG_TABLE_SCHEMA,'tenant',OLD.id)::text);
          END IF;
          RETURN NULL;
        END $$;
        DROP TRIGGER IF EXISTS swarm_tenant_revocation ON tenants;
        CREATE TRIGGER swarm_tenant_revocation AFTER UPDATE OF state,generation,machine_id ON tenants
          FOR EACH ROW EXECUTE FUNCTION swarm_tenant_revocation();
        CREATE OR REPLACE FUNCTION swarm_host_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP='DELETE' OR NEW.desired IS DISTINCT FROM OLD.desired OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.machine_id IS DISTINCT FROM OLD.machine_id OR NEW.revision IS DISTINCT FROM OLD.revision THEN
            PERFORM pg_notify('swarm_revocations',json_build_object('schema',TG_TABLE_SCHEMA,'tenant',OLD.tenant_id)::text);
          END IF;
          RETURN NULL;
        END $$;
        DROP TRIGGER IF EXISTS swarm_host_revocation ON host_policies;
        CREATE TRIGGER swarm_host_revocation AFTER DELETE OR UPDATE OF desired,generation,machine_id,revision ON host_policies
          FOR EACH ROW EXECUTE FUNCTION swarm_host_revocation();
      `);
    });
  }
  async session(raw?: string) {
    if (!raw || raw.length > 256) return null;
    const { rows } = await this.pool.query(`UPDATE sessions s SET last_seen_at=now() FROM tenants t
      WHERE s.hash=$1 AND t.id=s.tenant_id AND t.state NOT IN ('deleting','deleted')
      AND s.expires_at>now() AND s.last_seen_at>now()-interval '24 hours'
      RETURNING s.*,t.generation,t.state,t.display_name,t.verified_email`, [hashToken(raw)]);
    if (rows[0]) bindTenantLog(rows[0].tenant_id);
    return rows[0] ?? null;
  }
  async identity(provider: string, subject: string, profile: { name: string; email?: string }, linkSession?: string, inviteCode?: string) {
    return this.transaction(client => this.identityInTransaction(client, provider, subject, profile, linkSession, inviteCode));
  }
  /** For verified identity workflows that must consume their authorization in the same transaction. */
  async identityInTransaction(client: PoolClient, provider: string, subject: string, profile: { name: string; email?: string }, linkSession?: string, inviteCode?: string) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${provider}:${subject}`]);
      const existing = (await client.query('SELECT tenant_id FROM identities WHERE provider=$1 AND subject=$2', [provider, subject])).rows[0];
      const link = linkSession ? (await client.query(`SELECT tenant_id FROM sessions WHERE hash=$1 AND expires_at>now()
        AND last_seen_at>now()-interval '24 hours' AND authenticated_at>now()-interval '10 minutes' FOR UPDATE`, [linkSession])).rows[0] : null;
      if (linkSession && !link) throw new Error('reauth_required');
      if (existing && link && existing.tenant_id !== link.tenant_id) throw new Error('identity_already_linked');
      if (existing) {
        const owner = await client.query("SELECT 1 FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted') FOR UPDATE", [existing.tenant_id]);
        if (!owner.rowCount) throw new Error('account_revoked');
        return existing.tenant_id as string;
      }
      // Staged migration identities are activated only by the same verified
      // provider callback used for ordinary sign-in. Email never selects them.
      const legacy=(await client.query('SELECT tenant_id FROM legacy_identity_claims WHERE provider=$1 AND subject=$2 FOR UPDATE',[provider,subject])).rows[0];
      if(legacy&&link&&legacy.tenant_id!==link.tenant_id)throw new Error('identity_already_linked');
      const tenant = link?.tenant_id ?? legacy?.tenant_id ?? `usr_${randomBytes(16).toString('base64url')}`;
      if (link && !(await client.query("SELECT 1 FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted') FOR UPDATE", [tenant])).rowCount) throw new Error('account_revoked');
      if(legacy&&!(await client.query("SELECT 1 FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted','failed') FOR UPDATE",[tenant])).rowCount)throw new Error('account_revoked');
      if (!link&&!legacy) {
        await admitNewTenant(client, provider, subject, inviteCode);
        // Equal emails are deliberately not an identity join. Linking is explicit and session-bound.
        await client.query('INSERT INTO tenants(id,display_name,verified_email,composio_user_id,created_at) VALUES($1,$2,$3,$4,clock_timestamp())', [tenant, profile.name, profile.email ?? null, tenant]);
        await client.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'create')", [opaqueToken(), tenant]);
      }
      await client.query('INSERT INTO identities(provider,subject,tenant_id) VALUES($1,$2,$3)', [provider, subject, tenant]);
      if(legacy)await client.query('DELETE FROM legacy_identity_claims WHERE provider=$1 AND subject=$2',[provider,subject]);
      return tenant as string;
  }
  async createSession(tenant: string, previous: string | undefined, device: string, requiredSession?:string) {
    const raw = opaqueToken();
    await this.transaction(async client => {
      if (!(await client.query("SELECT 1 FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted') FOR UPDATE", [tenant])).rowCount) throw new Error('account_revoked');
      if(requiredSession&&!(await client.query(`SELECT 1 FROM sessions WHERE hash=$1 AND tenant_id=$2 AND expires_at>now()
        AND last_seen_at>now()-interval '24 hours' AND authenticated_at>now()-interval '10 minutes' FOR UPDATE`,[requiredSession,tenant])).rowCount)throw new Error('reauth_required');
      if (previous) await client.query('DELETE FROM sessions WHERE hash=$1', [hashToken(previous)]);
      await client.query('INSERT INTO sessions(hash,tenant_id,device) VALUES($1,$2,$3)', [hashToken(raw), tenant, device.slice(0, 200)]);
    });
    bindTenantLog(tenant);
    return raw;
  }
  async revokeTenant(tenant: string, authorization?: {sessionHash:string} | {phone:{channel:string;revision:string;tokenHash:string}}) {
    await this.transaction(async client => {
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
      if(authorization&&'sessionHash' in authorization){
        if(!(await client.query(`SELECT 1 FROM sessions WHERE hash=$1 AND tenant_id=$2 AND expires_at>now()
          AND last_seen_at>now()-interval '24 hours' AND authenticated_at>now()-interval '10 minutes' FOR UPDATE`,[authorization.sessionHash,tenant])).rowCount)throw new Error('reauth_required');
      }else if(authorization&&'phone' in authorization){
        const proof=authorization.phone;
        const current=await client.query(`DELETE FROM messaging_tokens k USING messaging_routes r WHERE k.hash=$1 AND k.tenant_id=$2
          AND k.channel=$3 AND k.revision=$4 AND k.purpose='delete' AND k.expires_at>now() AND r.tenant_id=k.tenant_id
          AND r.channel=k.channel AND r.revision=k.revision AND r.state='active' RETURNING k.hash`,[proof.tokenHash,tenant,proof.channel,proof.revision]);
        if(!current.rowCount)throw new Error('reauth_required');
      }
      await client.query("UPDATE tenants SET state='deleting',generation=generation+1 WHERE id=$1 AND state!='deleted'", [tenant]);
      await client.query('DELETE FROM sessions WHERE tenant_id=$1', [tenant]);
      await client.query('UPDATE runtime_credentials SET revoked_at=now() WHERE tenant_id=$1', [tenant]);
      await client.query('DELETE FROM companion_routes WHERE tenant_id=$1', [tenant]);
      await client.query('DELETE FROM host_usage_samples WHERE tenant_id=$1', [tenant]);
      for (const table of ['tenant_meter','tenant_allowances','tenant_meter_resources','tenant_meter_status']) {
        await client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
      }
      await client.query("UPDATE environment_operations SET capacity_change=capacity_change-'samples' WHERE tenant_id=$1 AND capacity_change ? 'samples'",[tenant]);
      await client.query("UPDATE messaging_routes SET state='revoked',revision=revision+1 WHERE tenant_id=$1", [tenant]);
      await client.query('DELETE FROM messaging_tokens WHERE tenant_id=$1', [tenant]);
      await client.query("UPDATE lifecycle_jobs SET state='cancelled',fence=fence+1,lease_until=NULL WHERE tenant_id=$1 AND operation!='delete' AND state!='completed'", [tenant]);
      await client.query("UPDATE environment_operations SET phase='cancelled',fence=fence+1,lease_until=NULL WHERE tenant_id=$1 AND phase!='completed'",[tenant]);
      await client.query("UPDATE connected_accounts SET state='revoked',revision=revision+1,is_default=false WHERE tenant_id=$1", [tenant]);
      await client.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'delete') ON CONFLICT(tenant_id,operation) DO NOTHING", [opaqueToken(), tenant]);
    });
  }
}
