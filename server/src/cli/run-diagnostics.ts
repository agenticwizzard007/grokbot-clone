import { db } from '../db.js';
import { assertTenant } from '../deployment.js';
import { safeToolName, type CliDiagnosticEvent } from './diagnostics.js';

const errorCodes = new Set(['cli_tool_host_disabled', 'cli_tool_host_unavailable', 'cli_login_disabled', 'mcp_auth', 'mcp_startup', 'cli_approval_rejected', 'tool_unavailable', 'timeout', 'cli_auth', 'mcp_configuration', 'app_reconnect', 'app_connection', 'policy_denied', 'cancelled', 'invalid_arguments', 'tool_or_runner_error', 'mcp_transport']);
type Result = 'running' | 'completed' | 'pending_approval' | 'rejected_by_cli' | 'denied' | 'error' | 'cancelled' | 'no_tool_call';

/** Bounded, content-free latest and tool records per provider, deleted with the account. */
export function recordCliRun(userId: string) {
  assertTenant(userId);
  let result: Result = 'running', lastTool: string | null = null, errorCode: string | null = null;
  return (event: CliDiagnosticEvent) => {
    try {
      db.transaction(() => {
        if (event.event === 'start') {
          db.prepare(`INSERT INTO cli_last_runs(user_id,generation_id,started_at,provider,runtime,tools_offered,result)
            SELECT id,?,?,?,?,?,? FROM users WHERE id=?
            ON CONFLICT(user_id) DO UPDATE SET generation_id=excluded.generation_id,started_at=excluded.started_at,
            provider=excluded.provider,runtime=excluded.runtime,tools_offered=excluded.tools_offered,last_tool=NULL,result=excluded.result,error_code=NULL`)
            .run(event.generationId, Date.now(), event.provider === 'claude' ? 'claude' : 'codex', event.runtime === 'server' ? 'server' : 'bridge', event.manifestCount, result, userId);
          for (const slot of event.manifestCount > 0 ? ['latest', 'tools'] : ['latest']) {
            db.prepare(`INSERT INTO cli_provider_runs(user_id,provider,slot,generation_id,started_at,runtime,tools_offered,result)
              SELECT id,?,?,?,?,?,?,? FROM users WHERE id=?
              ON CONFLICT(user_id,provider,slot) DO UPDATE SET generation_id=excluded.generation_id,started_at=excluded.started_at,
              runtime=excluded.runtime,tools_offered=excluded.tools_offered,last_tool=NULL,result=excluded.result,error_code=NULL`)
              .run(event.provider === 'claude' ? 'claude' : 'codex', slot, event.generationId, Date.now(), event.runtime === 'server' ? 'server' : 'bridge', event.manifestCount, result, userId);
          }
          return;
        }
        if (event.tool) lastTool = safeToolName(event.tool);
        if (event.errorClass) errorCode = errorCodes.has(event.errorClass) ? event.errorClass : 'tool_or_runner_error';
        if (event.admission === 'pending_approval') result = 'pending_approval';
        else if (event.admission === 'cli_rejected') result = 'rejected_by_cli';
        else if (event.admission === 'returned') { result = 'completed'; errorCode = null; }
        else if (event.admission === 'connection_required') { result = 'error'; errorCode = 'app_reconnect'; }
        else if (event.event === 'failure' || ['refused', 'rejected'].includes(event.admission ?? '')) {
          result = errorCode === 'policy_denied' ? 'denied' : errorCode === 'cancelled' ? 'cancelled'
            : errorCode?.startsWith('cli_tool_host_') || errorCode === 'cli_approval_rejected' ? 'rejected_by_cli' : 'error';
        } else if (event.event === 'finish' && result === 'running') result = event.stopped ? 'cancelled' : lastTool ? 'completed' : 'no_tool_call';
        // An older concurrent run must not overwrite a newer run or resurrect a deleted account.
        db.prepare('UPDATE cli_last_runs SET last_tool=?,result=?,error_code=? WHERE user_id=? AND generation_id=?')
          .run(lastTool, result, errorCode, userId, event.generationId);
        db.prepare('UPDATE cli_provider_runs SET last_tool=?,result=?,error_code=? WHERE user_id=? AND generation_id=?')
          .run(lastTool, result, errorCode, userId, event.generationId);
      })();
    } catch { console.warn('[cli-generation] account diagnostic storage unavailable'); }
  };
}

export function lastCliRun(userId: string) {
  assertTenant(userId);
  return db.prepare(`SELECT started_at AS startedAt,provider,runtime,tools_offered AS toolsOffered,
    last_tool AS lastTool,result,error_code AS errorCode FROM cli_last_runs WHERE user_id=?`).get(userId) ?? null;
}

export function cliRunsByProvider(userId: string) {
  assertTenant(userId);
  const read = db.prepare(`SELECT started_at AS startedAt,provider,runtime,tools_offered AS toolsOffered,
    last_tool AS lastTool,result,error_code AS errorCode FROM cli_provider_runs WHERE user_id=? AND provider=? AND slot=?`);
  return Object.fromEntries(['codex', 'claude'].map(provider => [provider, {
    latest: read.get(userId, provider, 'latest') ?? null,
    lastToolRun: read.get(userId, provider, 'tools') ?? null,
  }]));
}
