import { llmProvider } from './lib/llm.js';
import { personalOpenRouterKey, usesPersonalOpenRouter } from './providers/openrouter.js';
import { selectedCli } from './cli/store.js';
import { Hono } from 'hono';
import { env } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { dailyUsage } from './messaging/signup.js';
import { canManageServer } from './settings.js';
import { usageCsv, usageReport, type UsageRange } from './usage.js';
import { vmRates } from './usage-vm.js';

/**
 * /api/usage: the AI usage monitor. Everyone sees their own usage; the server's owner (who pays
 * the provider, BYOK) can also see every account and the provider account's own figures.
 */
export const usageApi = new Hono<AuthVars>();
usageApi.use('*', requireUser);

const RANGES: UsageRange[] = ['today', '7d', '30d', 'month'];
const parseRange = (v: string | undefined): UsageRange => (RANGES.includes(v as UsageRange) ? (v as UsageRange) : '30d');

const nextUtcMidnight = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

usageApi.get('/', (c) => {
  const user = c.get('user');
  const owner = canManageServer(user);
  const scope = c.req.query('scope') === 'all' && owner ? 'all' : 'me';
  const report = usageReport(scope === 'all' ? null : user.id, parseRange(c.req.query('range')));
  const daily = dailyUsage(user.id);
  return c.json({
    ...report,
    scope,
    canSeeAll: owner,
    canSeeProvider: owner || usesPersonalOpenRouter(user.id) || !!selectedCli(user.id),
    provider: llmProvider(),
    computerProvider: env.computerProvider,
    computerRates: vmRates(),
    // Free plan (accounts that signed up by text): a daily message allowance that resets at midnight UTC.
    limits: { dailyMessages: daily.limit > 0 ? { used: daily.used, limit: daily.limit, resetsAt: nextUtcMidnight() } : null },
  });
});

// ---------- personal provider usage, or shared defaults for the owner ----------

let providerCache: { at: number; key: string; body: unknown } | null = null;

usageApi.get('/provider', async (c) => {
  const cli = selectedCli(c.get('user').id);
  if (cli) return c.json({ provider: `${cli}-cli`, openrouter: null, note: 'Model requests use your CLI subscription. Swarm records token counts and zero API charges; subscription fees, provider extra usage and third-party services are separate. Check your provider account for remaining allowance.' });
  const personal = usesPersonalOpenRouter(c.get('user').id);
  if (!personal && !canManageServer(c.get('user'))) return c.json({ error: 'Only the owner of this server can see the provider account.' }, 403);
  let key: string;
  try { key = personal ? personalOpenRouterKey(c.get('user').id) : env.openrouterKey; }
  catch { return c.json({ provider: 'openrouter', openrouter: null, note: 'Reconnect your personal OpenRouter key in Settings → API keys.' }); }
  if (!key) {
    return c.json({
      provider: llmProvider(),
      openrouter: null,
      note: env.directKey
        ? "The direct provider doesn't share key usage with apps. Costs on this page are what it reported per request (or estimates), recorded by Swarm."
        : 'No model key is set yet.',
    });
  }
  if (providerCache && providerCache.key === key && Date.now() - providerCache.at < 60_000) return c.json(providerCache.body);
  try {
    const r = await fetch(`${env.openrouterBaseUrl}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return c.json({ provider: llmProvider(), openrouter: null, note: `OpenRouter answered ${r.status}.` });
    const d = ((await r.json()) as any)?.data ?? {};
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const body = {
      provider: llmProvider(),
      openrouter: {
        label: typeof d.label === 'string' ? d.label : null,
        usage: { today: n(d.usage_daily), week: n(d.usage_weekly), month: n(d.usage_monthly), allTime: n(d.usage) },
        byokUsage: { today: n(d.byok_usage_daily), month: n(d.byok_usage_monthly) },
        limit: n(d.limit),
        limitRemaining: n(d.limit_remaining),
        limitReset: typeof d.limit_reset === 'string' ? d.limit_reset : null,
        budgets: Array.isArray(d.budgets)
          ? d.budgets.map((b: any) => ({ scope: String(b.scope ?? ''), limitUsd: n(b.limit_usd), spendUsd: n(b.spend_usd), remainingUsd: n(b.remaining_usd), resetInterval: b.reset_interval ?? null, resetsAt: b.resets_at ?? null }))
          : [],
        freeTier: d.is_free_tier === true,
      },
      note: 'From OpenRouter: everything this key spent, including use outside Swarm. Credits are US dollars.',
    };
    providerCache = { at: Date.now(), key, body };
    return c.json(body);
  } catch (e) {
    return c.json({ provider: llmProvider(), openrouter: null, note: "Could not reach OpenRouter. Try again shortly." });
  }
});

// ---------- export ----------

usageApi.get('/export.csv', (c) => {
  const user = c.get('user');
  const all = c.req.query('scope') === 'all' && canManageServer(user);
  const range = parseRange(c.req.query('range'));
  return c.body(usageCsv(all ? null : user.id, range), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="swarm-usage-${all ? 'all' : 'me'}-${range}.csv"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
});
