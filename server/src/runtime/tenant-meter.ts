import fs from 'node:fs/promises';
import type { MeterReport, MeterAllowance } from './meter-contract.js';
import type { PlanUsageSummary } from '../plan-usage-types.js';

/** Only the runtime JWT is used. Response and request work are both bounded. */
export function tenantMeterTransport(origin: string, tokenFile: string, request: typeof fetch = fetch,
  readToken = async () => (await fs.readFile(tokenFile,'utf8')).trim()) {
  const endpoint = new URL(origin);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Meter transport requires HTTPS.');
  async function send(path: string, report?: MeterReport) {
    const response = await request(new URL(path,endpoint), { method: report ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${await readToken()}`, 'content-type': 'application/json' },
      ...(report ? { body: JSON.stringify(report) } : {}) });
    if (!response.ok || report) {
      void response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error('Meter request refused.');
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing allowance.');
    let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length; if (bytes > 2048) throw new Error('Oversized allowance.'); chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString()) as MeterAllowance;
    } finally { void reader.cancel().catch(() => {}); }
  }
  return { report: async (report: MeterReport) => { await send('/internal/runtime/meter',report); },
    allowance: async () => (await send('/internal/runtime/meter/allowance'))! };
}

/** Each tick sends a fresh cumulative snapshot. No retry queue and no duplicate increments. */
export class TenantMeterReporter {
  private busy = false;
  constructor(private snapshot: () => MeterReport, private send: (report: MeterReport) => Promise<void>) {}
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { await this.send(this.snapshot()); } finally { this.busy = false; }
  }
}
export async function startTenantMeter() {
  const { isTenant, tenantId } = await import('../deployment.js');
  const { tenantMeteringEnabled } = await import('./meter-contract.js');
  if (!isTenant || !tenantMeteringEnabled() || process.env.SWARM_NO_SCHEDULER === '1') return;
  const { dailyMeterClaims } = await import('../usage.js');
  const transport = tenantMeterTransport(process.env.PLATFORM_URL!,process.env.RUNTIME_TOKEN_FILE!);
  const reporter = new TenantMeterReporter(() => {
    const at = Date.now(); return { version: 1, tenant: tenantId, at, days: dailyMeterClaims(tenantId,at) };
  }, transport.report);
  const tick = () => { void reporter.tick().catch(() => {}); };
  tick(); const timer = setInterval(tick,60_000).unref();
  return () => clearInterval(timer);
}

export function applyMeterAllowance(summary: PlanUsageSummary, allowance: MeterAllowance): PlanUsageSummary {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(allowance.month) || allowance.source !== 'tenant'
    || !Number.isFinite(allowance.spendUsd) || allowance.spendUsd < 0
    || allowance.allowanceUsd !== null && (!Number.isFinite(allowance.allowanceUsd) || allowance.allowanceUsd <= 0)) throw new Error('Invalid allowance.');
  const periodStart = Date.parse(`${allowance.month}-01`), next = new Date(periodStart); next.setUTCMonth(next.getUTCMonth()+1);
  const periodEnd = next.getTime();
  return { ...summary, plan: { ...summary.plan, name: 'Monthly allowance', billing: 'api', provider: null, unit: 'usd',
    periodStart, periodEnd, resetsAt: periodEnd, usedCents: Math.round(allowance.spendUsd*100),
    limitCents: allowance.allowanceUsd === null ? null : Math.round(allowance.allowanceUsd*100),
    percentUsed: allowance.allowanceUsd === null ? null : allowance.spendUsd/allowance.allowanceUsd*100,
    softLimit: true, softLimitExceeded: allowance.softLimitExceeded, source: 'tenant', reportedAt: allowance.reportedAt } };
}
export async function tenantAllowanceSummary(summary: PlanUsageSummary) {
  const transport = tenantMeterTransport(process.env.PLATFORM_URL!,process.env.RUNTIME_TOKEN_FILE!);
  return applyMeterAllowance(summary,await transport.allowance());
}
