import { Hono } from 'hono';
import { env } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { dailyUsage } from './messaging/signup.js';
import { canManageServer } from './settings.js';
import { usageCsv, usageReport, type UsageRange } from './usage.js';

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
    provider: env.llmProvider,
    // Free plan (accounts that signed up by text): a daily message allowance that resets at midnight UTC.
    limits: { dailyMessages: daily.limit > 0 ? { used: daily.used, limit: daily.limit, resetsAt: nextUtcMidnight() } : null },
  });
});

// ---------- the provider account (owner only; cached briefly) ----------

let providerCache: { at: number; key: string; body: unknown } | null = null;

usageApi.get('/provider', async (c) => {
  if (!canManageServer(c.get('user'))) return c.json({ error: 'Only the owner of this server can see the provider account.' }, 403);
  if (!env.openrouterKey) {
    return c.json({
      provider: env.llmProvider,
      openrouter: null,
      note: env.directKey
        ? "The direct provider doesn't share key usage with apps. Costs on this page are what it reported per request (or estimates), recorded by Swarm."
        : 'No model key is set yet.',
    });
  }
  if (providerCache && providerCache.key === env.openrouterKey && Date.now() - providerCache.at < 60_000) return c.json(providerCache.body);
  try {
    const r = await fetch(`${env.openrouterBaseUrl}/key`, { headers: { Authorization: `Bearer ${env.openrouterKey}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return c.json({ provider: env.llmProvider, openrouter: null, note: `OpenRouter answered ${r.status}.` });
    const d = ((await r.json()) as any)?.data ?? {};
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const body = {
      provider: env.llmProvider,
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
    providerCache = { at: Date.now(), key: env.openrouterKey, body };
    return c.json(body);
  } catch (e) {
    return c.json({ provider: env.llmProvider, openrouter: null, note: `Couldn't reach OpenRouter: ${(e as Error).message}` });
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
