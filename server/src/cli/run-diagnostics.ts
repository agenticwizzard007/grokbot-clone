import { db } from '../db.js';
import { assertTenant } from '../deployment.js';
import { attribution } from '../usage-context.js';
import { safeToolName, type CliDiagnosticEvent } from './diagnostics.js';

const errorCodes = new Set(['cli_tool_host_disabled', 'cli_tool_host_unavailable', 'cli_login_disabled', 'mcp_auth', 'mcp_startup', 'cli_approval_rejected', 'tool_unavailable', 'timeout', 'cli_auth', 'mcp_configuration', 'app_reconnect', 'app_connection', 'policy_denied', 'cancelled', 'invalid_arguments', 'tool_or_runner_error', 'mcp_transport', 'app_timeout', 'app_auth', 'app_access', 'app_rate_limit', 'app_provider', 'app_selection', 'app_arguments', 'app_tool_selection', 'app_operation']);
type Result = 'running' | 'completed' | 'pending_approval' | 'rejected_by_cli' | 'denied' | 'error' | 'cancelled' | 'no_tool_call';
const runColumns = `started_at AS startedAt,provider,runtime,tools_offered AS toolsOffered,
  last_tool AS lastTool,result,error_code AS errorCode,trigger`;
const pendingApprovals = `SELECT r.approval_id FROM cli_approval_runs r JOIN approvals a ON a.id=r.approval_id
  WHERE r.user_id=? AND a.status='pending'`;

function pruneApprovalRuns(userId: string) {
  db.prepare(`DELETE FROM cli_approval_runs WHERE user_id=? AND NOT EXISTS (
    SELECT 1 FROM approvals a WHERE a.id=cli_approval_runs.approval_id AND a.status IN ('pending','allowed','always','denied')
  )`).run(userId);
  // Keep every unresolved card, but only the most recent decision per provider.
  for (const provider of ['codex', 'claude']) {
    db.prepare(`DELETE FROM cli_approval_runs WHERE approval_id IN (
      SELECT r.approval_id FROM cli_approval_runs r JOIN approvals a ON a.id=r.approval_id
      WHERE r.user_id=? AND r.provider=? AND a.status IN ('allowed','always','denied')
      ORDER BY COALESCE(a.resolved_at,r.started_at) DESC,r.started_at DESC,r.approval_id DESC LIMIT -1 OFFSET 1
    )`).run(userId, provider);
  }
}

function pendingRuns(userId: string) {
  // Decisions release Last CLI run; Last tool run keeps the decided action.
  pruneApprovalRuns(userId);
  return db.prepare(`SELECT ${runColumns} FROM cli_approval_runs WHERE approval_id IN (${pendingApprovals}) ORDER BY started_at DESC`).all(userId) as Array<{ provider: string }>;
}

/** Bounded, content-free latest and tool records per provider, deleted with the account. */
export function recordCliRun(userId: string) {
  assertTenant(userId);
  const scope = attribution();
  let result: Result = 'running', lastTool: string | null = null, errorCode: string | null = null;
  let startedAt = 0, trigger: string | null = null;
  let userTurnCreatedAt: number | null = null;
  let finished = false;
  return (event: CliDiagnosticEvent) => {
    // A transport callback may arrive after its generation has settled. It must
    // not reopen a completed/failed record. A persisted approval still matters.
    if (finished && event.admission !== 'pending_approval') return;
    try {
      db.transaction(() => {
        const provider = event.provider === 'claude' ? 'claude' : 'codex';
        const runtime = event.runtime === 'server' ? 'server' : 'bridge';
        if (event.event === 'start') {
          pruneApprovalRuns(userId);
          // Order starts even when concurrent generations start in the same millisecond.
          const previous = db.prepare('SELECT started_at FROM cli_last_runs WHERE user_id=?').get(userId) as { started_at: number } | undefined;
          startedAt = Math.max(Date.now(), (previous?.started_at ?? 0) + 1);
          const job = scope.jobId ? db.prepare('SELECT trigger,created_at FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?')
            .get(scope.jobId, userId, scope.botId) as { trigger: string; created_at: number } | undefined : undefined;
          const source = job && JSON.parse(job.trigger);
          trigger = source?.type === 'resume' ? 'approval_decision' : null;
          userTurnCreatedAt = source?.type === 'user' && source.audience !== 'internal' ? job!.created_at : null;
          db.prepare(`INSERT INTO cli_last_runs(user_id,generation_id,started_at,provider,runtime,tools_offered,result,trigger)
            SELECT id,?,?,?,?,?,?,? FROM users WHERE id=?
            ON CONFLICT(user_id) DO UPDATE SET generation_id=excluded.generation_id,started_at=excluded.started_at,
            provider=excluded.provider,runtime=excluded.runtime,tools_offered=excluded.tools_offered,last_tool=NULL,result=excluded.result,error_code=NULL,trigger=excluded.trigger`)
            .run(event.generationId, startedAt, provider, runtime, event.manifestCount, result, trigger, userId);
          db.prepare(`INSERT INTO cli_provider_runs(user_id,provider,slot,generation_id,started_at,runtime,tools_offered,result,trigger)
            SELECT id,?,'latest',?,?,?,?,?,? FROM users WHERE id=?
            ON CONFLICT(user_id,provider,slot) DO UPDATE SET generation_id=excluded.generation_id,started_at=excluded.started_at,
            runtime=excluded.runtime,tools_offered=excluded.tools_offered,last_tool=NULL,result=excluded.result,error_code=NULL,trigger=excluded.trigger`)
            .run(provider, event.generationId, startedAt, runtime, event.manifestCount, result, trigger, userId);
          return;
        }
        // CLI-side rejections name attempted tools, but those calls never reached Swarm.
        if (result !== 'pending_approval' && event.tool && (event.admission === 'admitted' || event.event === 'tool_result')) lastTool = safeToolName(event.resolvedTool ?? event.tool);
        // Once a Swarm action awaits a decision, a wrapper return or CLI finish
        // cannot complete it. The decision reply is a separate generation.
        if (result !== 'pending_approval') {
          if (event.errorClass) errorCode = errorCodes.has(event.errorClass) ? event.errorClass : 'tool_or_runner_error';
          if (event.admission === 'pending_approval') { result = 'pending_approval'; errorCode = null; }
          else if (event.admission === 'cli_rejected') result = 'rejected_by_cli';
          else if (event.admission === 'returned') { result = 'completed'; errorCode = null; }
          else if (event.admission === 'connection_required') { result = 'error'; errorCode = 'app_reconnect'; }
          else if (event.event === 'failure' || ['refused', 'rejected'].includes(event.admission ?? '')) {
            result = errorCode === 'policy_denied' ? 'denied' : errorCode === 'cancelled' ? 'cancelled'
              : errorCode?.startsWith('cli_tool_host_') || errorCode === 'cli_approval_rejected' ? 'rejected_by_cli' : 'error';
          } else if (event.event === 'finish' && result === 'running') result = event.stopped ? 'cancelled' : lastTool ? 'completed' : 'no_tool_call';
        }
        finished ||= event.event === 'finish' || event.event === 'failure';
        const visibleResult = finished || result === 'pending_approval' ? result : 'running';
        if (event.admission === 'pending_approval' && event.approvalId) {
          // Only server-issued approvals owned by this account and Bot can pin a
          // run. Keep each unresolved card so concurrent approvals remain visible.
          db.prepare(`INSERT INTO cli_approval_runs(approval_id,user_id,provider,generation_id,started_at,runtime,tools_offered,last_tool,result,error_code,trigger)
            SELECT a.id,b.user_id,?,?,?,?,?,?,?,NULL,? FROM approvals a JOIN bots b ON b.id=a.bot_id
            WHERE a.id=? AND b.user_id=? AND b.id=? AND a.status='pending'
            ON CONFLICT(approval_id) DO NOTHING`)
            .run(provider, event.generationId, startedAt, runtime, event.manifestCount, lastTool, result, trigger, event.approvalId, userId, scope.botId);
        }
        // An older concurrent run must not overwrite a newer run or resurrect a deleted account.
        db.prepare('UPDATE cli_last_runs SET last_tool=?,result=?,error_code=? WHERE user_id=? AND generation_id=?')
          .run(lastTool, visibleResult, errorCode, userId, event.generationId);
        db.prepare("UPDATE cli_provider_runs SET last_tool=?,result=?,error_code=? WHERE user_id=? AND slot='latest' AND generation_id=?")
          .run(lastTool, visibleResult, errorCode, userId, event.generationId);
        // Preserve the previous tool record while a new run is still running, even if it offers tools.
        if (trigger !== 'approval_decision' && (finished || result === 'pending_approval') && (lastTool || result === 'pending_approval')) {
          // A reply to a decision, a background check, or a user turn that was
          // already running at decision time cannot replace the decided action.
          if (userTurnCreatedAt !== null) db.prepare(`DELETE FROM cli_approval_runs WHERE user_id=? AND provider=?
            AND approval_id IN (SELECT id FROM approvals WHERE status IN ('allowed','always','denied') AND resolved_at<=?)`)
            .run(userId, provider, userTurnCreatedAt);
          db.prepare(`INSERT INTO cli_provider_runs(user_id,provider,slot,generation_id,started_at,runtime,tools_offered,last_tool,result,error_code,trigger)
            SELECT id,?,'tools',?,?,?,?,?,?,?,? FROM users WHERE id=?
            ON CONFLICT(user_id,provider,slot) DO UPDATE SET generation_id=excluded.generation_id,started_at=excluded.started_at,
            runtime=excluded.runtime,tools_offered=excluded.tools_offered,last_tool=excluded.last_tool,result=excluded.result,error_code=excluded.error_code,trigger=excluded.trigger
            WHERE excluded.started_at >= cli_provider_runs.started_at
              AND (excluded.result='pending_approval' OR NOT EXISTS (${pendingApprovals} AND r.provider=?))`)
            .run(provider, event.generationId, startedAt, runtime, event.manifestCount, lastTool, result, errorCode, trigger, userId, userId, provider);
        }
      })();
    } catch { console.warn('[cli-generation] account diagnostic storage unavailable'); }
  };
}

export function lastCliRun(userId: string) {
  assertTenant(userId);
  return pendingRuns(userId)[0] ?? db.prepare(`SELECT ${runColumns} FROM cli_last_runs WHERE user_id=?`).get(userId) ?? null;
}

export function cliRunsByProvider(userId: string) {
  assertTenant(userId);
  const pending = pendingRuns(userId);
  const read = db.prepare(`SELECT ${runColumns} FROM cli_provider_runs WHERE user_id=? AND provider=? AND slot=?`);
  return Object.fromEntries(['codex', 'claude'].map(provider => {
    const approval = pending.find(run => run.provider === provider);
    return [provider, {
      latest: approval ?? read.get(userId, provider, 'latest') ?? null,
      lastToolRun: approval ?? decidedToolRun(userId, provider) ?? read.get(userId, provider, 'tools') ?? null,
    }];
  }));
}

function decidedToolRun(userId: string, provider: string) {
  const run = db.prepare(`SELECT ${runColumns},(SELECT status FROM approvals WHERE id=approval_id) AS decision
    FROM cli_approval_runs WHERE user_id=? AND provider=?
    AND approval_id IN (SELECT id FROM approvals WHERE status IN ('allowed','always','denied'))`).get(userId, provider) as
    { decision: string; result: string } | undefined;
  if (!run) return null;
  const { decision, ...record } = run;
  return { ...record, result: decision === 'denied' ? 'denied' : 'allowed', errorCode: null };
}
