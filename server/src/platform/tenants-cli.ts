/** Trusted operator entrypoint. DATABASE_URL is supplied out of band.
 * This queues existing lifecycle work; it never calls a cloud provider. */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Directory, opaqueToken } from './directory.js';
import { admissionCounts, signupLock } from './onboarding.js';
import { signupPolicy, type SignupPolicy } from './signup.js';

const tenantColumns = 'id,display_name,state,generation,created_at';
const jobColumns = 'id,operation,state,step,attempts,error_code,retry_at,created_at';
function natural(raw: string | undefined, fallback: number, max: number, min = 1) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error('Invalid numeric option.');
  return Number(raw);
}
function inviteURL(code: string) {
  const origin = new URL(process.env.PLATFORM_URL ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('PLATFORM_URL must be an HTTPS origin.');
  origin.searchParams.set('invite', code);
  return origin.href;
}
export async function tenantsCommand(args: string[], directory: Directory) {
  const [group, command, ...rest] = args, options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!/^--[a-z-]+$/.test(flag) || !rest[i + 1] || rest[i + 1].startsWith('--') || Object.hasOwn(options, flag.slice(2))) throw new Error('Invalid command options.');
    options[flag.slice(2)] = rest[i + 1];
  }
  const only = (allowed: string[]) => { if (Object.keys(options).some(k => !allowed.includes(k))) throw new Error('Unknown command option.'); };
  const id = () => { if (!/^usr_[A-Za-z0-9_-]{8,100}$/.test(options.id ?? '')) throw new Error('A valid tenant --id is required.'); return options.id; };
  if (group === 'tenants') {
    if (command === 'list') {
      only(['after']);
      if (options.after && !/^usr_[A-Za-z0-9_-]{8,100}$/.test(options.after)) throw new Error('Invalid cursor.');
      const rows = (await directory.pool.query(`SELECT ${tenantColumns} FROM tenants WHERE id>$1 ORDER BY id LIMIT 101`, [options.after ?? ''])).rows;
      return { tenants: rows.slice(0, 100), next: rows.length > 100 ? rows[99].id : null, capacity: await admissionCounts(directory.pool) };
    }
    if (command === 'status') {
      only(['id']); const tenant = (await directory.pool.query(`SELECT ${tenantColumns} FROM tenants WHERE id=$1`, [id()])).rows[0];
      if (!tenant) throw new Error('Tenant not found.');
      return { tenant, jobs: (await directory.pool.query(`SELECT ${jobColumns} FROM lifecycle_jobs WHERE tenant_id=$1 ORDER BY created_at`, [id()])).rows };
    }
    if (command === 'delete') {
      only(['id', 'confirm']);
      if (options.confirm !== id()) throw new Error('Deletion requires --confirm matching --id.');
      const tenant = (await directory.pool.query('SELECT state FROM tenants WHERE id=$1', [id()])).rows[0];
      if (!tenant) throw new Error('Tenant not found.');
      if (!['deleting','deleted'].includes(tenant.state)) await directory.revokeTenant(id());
      return { tenant: id(), state: tenant.state === 'deleted' ? 'deleted' : 'deleting', queued: tenant.state !== 'deleted' };
    }
    if (command === 'suspend' || command === 'wake') {
      only(['id']); const tenant = id();
      return directory.transaction(async client => {
        const row = (await client.query('SELECT state FROM tenants WHERE id=$1 FOR UPDATE', [tenant])).rows[0];
        if (!row || !['active', 'suspended'].includes(row.state)) throw new Error('Tenant must be active or suspended.');
        if ((await client.query("SELECT 1 FROM environment_operations WHERE tenant_id=$1 AND phase NOT IN ('completed','cancelled') UNION ALL SELECT 1 FROM migration_runs WHERE tenant_id=$1 AND phase!='active'", [tenant])).rowCount) throw new Error('Tenant maintenance is in progress.');
        if ((await client.query("SELECT 1 FROM lifecycle_jobs WHERE tenant_id=$1 AND state IN ('queued','running','failed') AND operation!=$2", [tenant, command])).rowCount) throw new Error('Another lifecycle operation is pending.');
        const job = (await client.query(`INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,$3)
          ON CONFLICT(tenant_id,operation) DO UPDATE SET state='queued',step='start',retry_at=clock_timestamp(),error_code=NULL
          WHERE lifecycle_jobs.state IN ('completed','cancelled') RETURNING ${jobColumns}`, [opaqueToken(), tenant, command])).rows[0]
          ?? (await client.query(`SELECT ${jobColumns} FROM lifecycle_jobs WHERE tenant_id=$1 AND operation=$2`, [tenant, command])).rows[0];
        return { tenant, job, queued: true };
      });
    }
  }
  if (group === 'invites') {
    if (command === 'create') {
      only(['uses', 'days', 'note']);
      const uses = natural(options.uses, 1, 100000), days = natural(options.days, 7, 365);
      if (options.note && options.note.length > 200) throw new Error('Note must be at most 200 characters.');
      const code = randomBytes(16).toString('hex').toUpperCase(), url = inviteURL(code);
      const invite = (await directory.pool.query("INSERT INTO web_invites(code,max_uses,expires_at,note) VALUES($1,$2,clock_timestamp()+$3*interval '1 day',$4) RETURNING *", [code, uses, days, options.note ?? null])).rows[0];
      return { invite, url };
    }
    if (command === 'list') {
      only(['after']);
      if (options.after && !/^[A-F0-9]{32}$/.test(options.after)) throw new Error('Invalid cursor.');
      const rows = (await directory.pool.query('SELECT code,max_uses,uses,revoked,expires_at,note,created_at FROM web_invites WHERE code>$1 ORDER BY code LIMIT 101', [options.after ?? ''])).rows;
      return { invites: rows.slice(0, 100), next: rows.length > 100 ? rows[99].code : null };
    }
    if (command === 'revoke') {
      only(['code']); if (!/^[A-F0-9]{32}$/.test(options.code ?? '')) throw new Error('A valid --code is required.');
      return directory.transaction(async client => {
        await client.query(signupLock);
        if (!(await client.query('UPDATE web_invites SET revoked=true WHERE code=$1 RETURNING code', [options.code])).rowCount) throw new Error('Invite not found.');
        return { code: options.code, revoked: true };
      });
    }
  }
  if (group === 'waitlist') {
    if (command === 'list') {
      only(['after']);
      if (options.after && !/^[A-Za-z0-9_-]{43}$/.test(options.after)) throw new Error('Invalid cursor.');
      const rows = (await directory.pool.query("SELECT id,contact,kind,created_at,approved_at FROM web_waitlist WHERE id>$1 AND created_at>clock_timestamp()-interval '30 days' ORDER BY id LIMIT 101", [options.after ?? ''])).rows;
      return { waitlist: rows.slice(0, 100), next: rows.length > 100 ? rows[99].id : null };
    }
    if (command === 'approve') {
      only(['id']); if (!/^[A-Za-z0-9_-]{43}$/.test(options.id ?? '')) throw new Error('A valid waitlist --id is required.');
      return directory.transaction(async client => {
        await client.query(signupLock);
        const row = (await client.query("SELECT invite_code FROM web_waitlist WHERE id=$1 AND created_at>clock_timestamp()-interval '30 days' FOR UPDATE", [options.id])).rows[0];
        if (!row) throw new Error('Waitlist entry not found.');
        const code = row.invite_code ?? randomBytes(16).toString('hex').toUpperCase(), url = inviteURL(code);
        if (!row.invite_code) {
          await client.query("INSERT INTO web_invites(code,max_uses,expires_at,note) VALUES($1,1,clock_timestamp()+interval '7 days','Waitlist approval')", [code]);
          await client.query('UPDATE web_waitlist SET invite_code=$2,approved_at=clock_timestamp() WHERE id=$1', [options.id, code]);
        }
        return { id: options.id, code, url, sent: false };
      });
    }
  }
  if (group === 'policy') {
    if (command === 'show') { only([]); return { policy: await signupPolicy(directory.pool), capacity: await admissionCounts(directory.pool) }; }
    if (command === 'set') {
      only(['mode', 'signups-per-day', 'member-invites', 'revision']);
      if (!/^\d{1,18}$/.test(options.revision ?? '')) throw new Error('Use policy show, then pass --revision.');
      if (options.mode !== undefined && !['open', 'invite', 'closed'].includes(options.mode)) throw new Error('Invalid signup mode.');
      return directory.transaction(async client => {
        await client.query(signupLock); const current = await signupPolicy(client);
        if (current.revision !== options.revision) throw new Error('Policy changed. Read it again.');
        const config: SignupPolicy = { mode: options.mode as SignupPolicy['mode'] ?? current.mode, signupsPerDay: natural(options['signups-per-day'], current.signupsPerDay, 100000, 0), memberInvites: natural(options['member-invites'], current.memberInvites, 1000, 0) };
        await client.query(`INSERT INTO signup_policy(singleton,config,updated_by) VALUES(true,$1,NULL)
          ON CONFLICT(singleton) DO UPDATE SET config=excluded.config,revision=signup_policy.revision+1,updated_by=NULL,updated_at=clock_timestamp()`, [config]);
        return signupPolicy(client);
      });
    }
  }
  throw new Error('Use tenants list/status/suspend/wake/delete, invites create/list/revoke, waitlist list/approve or policy show/set.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let directory: Directory | undefined;
  try { directory = new Directory(); console.log(JSON.stringify(await tenantsCommand(process.argv.slice(2), directory), null, 2)); }
  catch { console.error(JSON.stringify({ error: 'Command refused. Check command options, current policy revision and tenant status.' })); process.exitCode = 1; }
  finally { await directory?.pool.end(); }
}
