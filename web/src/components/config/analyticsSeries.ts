/** Pure helpers for the Bot analytics charts. No DOM or CSS imports, so tests can load them directly. */

export interface AnalyticsDay { day: string; messages: number; minutesSaved: number }

/**
 * R2F-035: running total of hours saved, in calendar order. Days are sorted by their YYYY-MM-DD key and
 * negative or missing values count as zero, so the series can never fall.
 */
export function cumulativeHours(days: AnalyticsDay[]): number[] {
  let total = 0;
  return [...days].sort((a, b) => a.day.localeCompare(b.day)).map(day => {
    total += Number.isFinite(day.minutesSaved) && day.minutesSaved > 0 ? day.minutesSaved / 60 : 0;
    return total;
  });
}

/** Horizontal centre of a day's slot, as a fraction of the plot width. Bars, line points and date labels share it. */
export const slotCentre = (index: number, count: number) => (count > 0 ? (index + 0.5) / count : 0);
