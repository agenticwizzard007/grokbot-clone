import { db } from '../db.js';
import { cliStatus, type CliProviders } from '../cli/bridge.js';
import { cliCatalog } from '../cli/catalog.js';
import type { CliProvider, CliRuntime } from '../cli/store.js';
import { llmProvider, modelFor, openrouterModels, withFast, type LlmProvider } from '../lib/llm.js';
import { voiceProvider } from '../lib/voice-provider.js';
import { usageReport, type UsageRange, type UsageReport } from '../usage.js';
import { withUsage } from '../usage-context.js';
import { connectionState, type ConnectionState } from './connection-state.js';

export interface PlatformStateOptions { range?: UsageRange; includeModels?: boolean; includeConnections?: boolean }
export interface PlatformModel {
  id: string;
  name: string | null;
  efforts: string[] | null;
  vision: boolean;
}
interface CatalogFacts {
  checkedAt: number;
  defaultModel: string | null;
  plan: string | null;
  usage: {
    available: boolean;
    checkedAt: number | null;
    windows: { label: string | null; usedPercent: number; resetsAt: number | null }[];
  };
}

/** Public facts only. Null means unobserved, never zero, unlimited, or an inferred plan. */
export interface PlatformSnapshot {
  llm: {
    provider: LlmProvider;
    configuredModel: string | null;
    model: string | null;
    fast: boolean;
    effort: string | null;
    latestObserved: { provider: LlmProvider; model: string; at: number } | null;
  };
  cli: {
    selected: CliProvider | null;
    runtime: CliRuntime;
    connected: boolean;
    auth: { installed: boolean; authenticated: boolean; subscription: boolean; hasError: boolean } | null;
    catalog: CatalogFacts | null;
  };
  voice: { provider: string; model: string | null };
  limits: { remainingAllowance: null; note: string };
}

export interface PlatformState extends PlatformSnapshot {
  usage: { scope: 'account'; range: UsageReport['range']; totals: UsageReport['totals'] };
  models?: { available: boolean; items: PlatformModel[] };
  connections?: ConnectionState;
}

// cli/catalog has no synchronous cache reader. Retain only our public observations,
// bound by account count, age, runtime and the exact recorded authentication status.
const observations = new Map<string, { runtime: CliRuntime; selected: CliProvider; providers: CliProviders; facts: CatalogFacts }>();
const CATALOG_TTL = 30_000;
const RECENT_EVENTS = 64;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PROVIDERS = new Set<LlmProvider>(['direct', 'openrouter', 'codex-cli', 'claude-cli']);

// Public labels and identifiers can still contain untrusted provider/config data.
// Reject URLs, email addresses, credential-like strings and control characters.
function publicText(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}~][\p{L}\p{N} ._()[\]/%:+~\-]{0,159}$/u.test(value) ||
      value.includes('://') || /\b(?:sk-|bearer\s|api[_ -]?key|token[:=])/i.test(value)) return null;
  return value;
}
function publicModel(value: unknown): string | null {
  const text = publicText(value);
  return text && /^[a-zA-Z0-9~][a-zA-Z0-9._:/[\]~\-]*$/.test(text) ? text : null;
}
function publicModels(models: { id: string; name: string; efforts: string[] | null; vision: boolean }[]): PlatformModel[] {
  return models.slice(0, 1000).flatMap(m => {
    const id = publicModel(m.id);
    return id ? [{ id, name: publicText(m.name), efforts: m.efforts === null ? null : m.efforts.filter(e => EFFORTS.has(e)), vision: m.vision }] : [];
  });
}

function ownedBot(userId: string, botId: string) {
  // Fail closed before calling any account-dependent helper, even with an inherited
  // usage context from a different user's delegated request.
  if (!userId || !botId) throw new Error('Platform state is unavailable for this account and Bot.');
  const bot = db.prepare('SELECT model, fast, effort FROM bots WHERE id=? AND user_id=?').get(botId, userId) as
    { model: string | null; fast: number; effort: string } | undefined;
  if (!bot) throw new Error('Platform state is unavailable for this account and Bot.');
  return bot;
}

function recordedCatalog(userId: string, status: ReturnType<typeof cliStatus>): CatalogFacts | null {
  const hit = observations.get(userId);
  const auth = status.selected ? status.providers[status.selected] : null;
  if (!hit || hit.runtime !== status.runtime || hit.selected !== status.selected || hit.providers !== status.providers ||
      !status.connected || !auth?.installed || !auth.authenticated || !auth.subscription || auth.error || Date.now() - hit.facts.checkedAt >= CATALOG_TTL) {
    observations.delete(userId);
    return null;
  }
  // Callers may mutate returned JSON; never give them our cached object.
  return structuredClone(hit.facts);
}

function snapshot(userId: string, botId: string): PlatformSnapshot {
  const bot = ownedBot(userId, botId);
  return withUsage({ userId, botId }, () => {
    const status = cliStatus(userId);
    const auth = status.selected && status.connected ? status.providers[status.selected] : null;
    // The existing account/time index bounds this read to 64 recent account events.
    // Old/absent chat observations remain unknown; do not substitute audio, another
    // Bot, an alias, or another account's most recent model.
    const recent = db.prepare(`SELECT provider, model, created_at FROM (
      SELECT bot_id, kind, provider, model, created_at FROM usage_events
      WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ?
    ) WHERE bot_id=? AND kind='chat' ORDER BY created_at DESC LIMIT 1`).get(userId, RECENT_EVENTS, botId) as
      { provider: LlmProvider; model: string; created_at: number } | undefined;
    const observedModel = publicModel(recent?.model);
    const voice = voiceProvider();
    return {
      llm: {
        provider: llmProvider(), configuredModel: publicModel(bot.model),
        model: publicModel(withFast(modelFor(bot.model), !!bot.fast)), fast: !!bot.fast,
        effort: EFFORTS.has(bot.effort) || bot.effort === 'ultracode' ? bot.effort : null,
        latestObserved: recent && observedModel && PROVIDERS.has(recent.provider)
          ? { provider: recent.provider, model: observedModel, at: recent.created_at } : null,
      },
      cli: {
        selected: status.selected, runtime: status.runtime, connected: status.connected,
        auth: auth ? { installed: auth.installed, authenticated: auth.authenticated, subscription: auth.subscription, hasError: !!auth.error } : null,
        catalog: recordedCatalog(userId, status),
      },
      // Never spread voiceProvider(): it also contains keys and endpoint URLs.
      voice: { provider: voice.provider, model: publicModel(voice.model) },
      limits: {
        remainingAllowance: null,
        note: 'Provider plan is unknown without a recorded catalog plan. Remaining allowance is unknown; reported quota windows are observations, not a token or money balance. Swarm usage is not provider-wide usage. Model aliases do not identify a plan.',
      },
    };
  });
}

/**
 * Read-only native account state for voice/text tools. Usage is always account-scoped
 * (default 30d), never server-wide. CLI catalog discovery can contact its runtime;
 * OpenRouter discovery runs only with includeModels. Failures never expose raw errors.
 * Direct-provider catalogs are unobserved here, so an explicit request reports unavailable.
 */
export async function platformState(userId: string, botId: string, options: PlatformStateOptions = {}): Promise<PlatformState> {
  ownedBot(userId, botId);
  const range = options.range ?? '30d';
  if (!['today', '7d', '30d', 'month'].includes(range)) throw new Error('Invalid platform usage range.');
  return withUsage({ userId, botId }, async () => {
    const connections = options.includeConnections ? connectionState(userId, botId) : undefined;
    const before = cliStatus(userId);
    let models: PlatformState['models'] = options.includeModels ? { available: false, items: [] } : undefined;
    const auth = before.selected ? before.providers[before.selected] : null;
    if (before.selected && before.connected && auth?.installed && auth.authenticated && auth.subscription && !auth.error) {
      try {
        const data = await cliCatalog(userId, before.selected, false, AbortSignal.timeout(8_000));
        ownedBot(userId, botId);
        const after = cliStatus(userId);
        if (after.runtime === before.runtime && after.selected === before.selected && after.providers === before.providers && after.connected) {
          const facts: CatalogFacts = {
            checkedAt: Date.now(), defaultModel: publicModel(data.defaultModel), plan: publicText(data.plan),
            usage: {
              available: data.usage.available, checkedAt: data.usage.checkedAt,
              windows: data.usage.available ? data.usage.windows.map(w => ({ label: publicText(w.label), usedPercent: w.usedPercent, resetsAt: w.resetsAt })) : [],
            },
          };
          if (observations.size >= 200) observations.delete(observations.keys().next().value!);
          observations.set(userId, { runtime: before.runtime, selected: before.selected, providers: before.providers, facts });
          if (options.includeModels) models = { available: true, items: publicModels(data.models) };
        }
      } catch {
        observations.delete(userId);
      }
    } else if (!before.selected && options.includeModels && llmProvider() === 'openrouter') {
      try { models = { available: true, items: publicModels(await openrouterModels()) }; } catch { /* Unknown, not an empty available catalog. */ }
    }
    const connectionSnapshot = await connections;
    const state = snapshot(userId, botId);
    // A selection/runtime change while discovery was pending invalidates its model list.
    if (models && (state.cli.selected !== before.selected || state.cli.runtime !== before.runtime)) models = { available: false, items: [] };
    const report = usageReport(userId, range);
    return { ...state, usage: { scope: 'account', range: report.range, totals: report.totals }, ...(models ? { models } : {}),
      ...(connectionSnapshot ? { connections: connectionSnapshot } : {}) };
  });
}

/** Synchronous, bounded local lookups only: no usage aggregation, discovery or network. */
export function platformContext(userId: string, botId: string): string {
  return `Native Swarm account state (authoritative configuration and recorded observations):
Use these native facts for questions about your own account, model, subscription, voice and usage, including delegated requests. Do not browse Swarm or ask the user to open Swarm to discover this configuration. Null means unknown. The configured CLI default is not proof of the last model used, and an observed model is not proof of a subscription plan. This prompt snapshot omits usage totals and model catalogs; use get_platform_state when available for usage, and include_models only on explicit demand. If a fact is unavailable, say so.
${JSON.stringify(snapshot(userId, botId))}`;
}
