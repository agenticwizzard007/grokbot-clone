// Loaded only for explicit --execute. Uses the existing subscription adapter,
// with structured output and zero tools; never imports the general API client.
import fs from 'node:fs/promises';
import { Unavailable, assertSubscription, httpPreflight } from './qualify-quinn-understanding.mjs';
export async function createLiveUnderstandingAdapter(config: any, deadline?: number) {
  if (process.env.SWARM_ROLE !== 'tenant' || process.env.SWARM_TENANT_ID !== config.account.userId || !process.env.DB_PATH) throw new Unavailable('explicit-staging-tenant-environment-required');
  let actualPath: string, configuredPath: string;
  try { actualPath = await fs.realpath(process.env.DB_PATH); configuredPath = await fs.realpath(config.target.dbPath); }
  catch { throw new Unavailable('staging-database-unavailable'); }
  if (actualPath !== configuredPath) throw new Unavailable('staging-database-path-mismatch');
  const remoteCheck = await httpPreflight(config, fetch, deadline);
  // The tenant's manifest, volume identity and runner socket retain their normal
  // application validation. No credential is copied and no selection is changed.
  const { db } = await import('../server/src/db.js');
  const { selectedCli, cliRuntime } = await import('../server/src/cli/store.js');
  const { refreshCli, cliStatus } = await import('../server/src/cli/bridge.js');
  const { cliResponsesClient } = await import('../server/src/cli/responses.js');
  const account = config.account;
  const localCheck = () => {
    if (selectedCli(account.userId) !== account.provider || cliRuntime(account.userId) !== account.runtime) throw new Unavailable('local-selected-subscription-mismatch-no-fallback');
    const bot = db.prepare("SELECT b.id FROM bots b JOIN bot_setups s ON s.bot_id=b.id WHERE b.id=? AND b.user_id=? AND b.is_primary=1 AND COALESCE(b.hidden,0)=0 AND COALESCE(b.kind,'agent')!='room' AND s.onboarding_status='active'").get(account.botId, account.userId);
    if (!bot) throw new Unavailable('active-owned-staging-primary-required');
  };
  localCheck();
  return {
    async preflight() {
      localCheck();
      try { await refreshCli(account.userId); } catch { throw new Unavailable('subscription-credentials-or-runner-unavailable-no-fallback'); }
      assertSubscription(cliStatus(account.userId), account);
    },
    async checkRoute() { localCheck(); await remoteCheck(); assertSubscription(cliStatus(account.userId), account); },
    async generate(request: any, signal: AbortSignal) {
      localCheck();
      if (request.model !== account.model || request.tools.length !== 0 || request.tool_choice !== 'none' || !request.text?.format?.schema) throw new Unavailable('tool-free-structured-request-required');
      // Structured output disables nativeToolHandler/native MCP in the existing
      // adapter. Companion CLIs disable shell, app, search, plugins and hooks.
      const client = cliResponsesClient(account.userId, account.provider, config.budget.requestTimeoutSeconds * 1000);
      const response = await client.responses.create(request, { signal });
      const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 ? n : undefined;
      return { text: response.output_text, provider: response.provider, model: response.model, billing: response.billing, runtime: cliRuntime(account.userId),
        toolCalls: response.output?.filter((item: any) => item.type === 'function_call') ?? [],
        usageStatus: response.usage_status ?? 'unavailable', usage: response.usage ? { inputTokens: count(response.usage.input_tokens), outputTokens: count(response.usage.output_tokens) } : null };
    },
  };
}
