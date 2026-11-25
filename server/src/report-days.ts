const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function reportTimezone(value?: string | null): string {
  if (value) {
    try { new Intl.DateTimeFormat('en-CA', { timeZone: value }); return value; } catch { /* Use UTC for invalid legacy values. */ }
  }
  return 'UTC';
}

export function reportDay(at: number, timezone: string): string {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDay(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

/** First instant of a calendar day, including DST changes at midnight. */
export function reportDayStart(day: string, timezone: string): number {
  const utc = Date.parse(`${day}T00:00:00Z`);
  if (timezone === 'UTC') return utc;
  let lo = utc - 36 * 3_600_000, hi = utc + 36 * 3_600_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (reportDay(mid, timezone) < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
