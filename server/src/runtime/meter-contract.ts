/** UTC daily claims. These are never infrastructure observations or billing evidence. */
export interface MeterDay { day: string; modelSpendUsd: number; computerMinutes: number; voiceMinutes: number }
export interface MeterReport { version: 1; tenant: string; at: number; days: MeterDay[] }
export interface MeterAllowance {
  month: string; allowanceUsd: number | null; spendUsd: number; percentUsed: number | null;
  softLimitExceeded: boolean; source: 'tenant'; reportedAt: string | null;
}
export function tenantMeteringEnabled(value = process.env.TENANT_METERING) {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error('TENANT_METERING must be unset, 0 or 1.');
}
export const meterDayMs = 86_400_000;
export function utcDay(at: number) { return new Date(at).toISOString().slice(0, 10); }
