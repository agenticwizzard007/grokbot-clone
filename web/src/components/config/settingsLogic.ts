/** Pure helpers for Settings and the Work area. No DOM or CSS imports, so tests can load them directly. */
import type { NeedsYouItem } from '../../lib/api';
import { appName } from '../../../../server/src/tool-activity'; // relative so node tests load it without the @shared alias

/** macOS browsers (and desktop-mode iPads, which report as a Mac). Phones that say "like Mac OS X" do not count. */
export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false;
  return /^Mac/i.test(nav.platform ?? '') || /Macintosh/.test(nav.userAgent ?? '');
}

/** Account scoped localStorage key for "Hide suggestion" in Bot details. */
export const hideSuggestedKey = (userId: string | undefined) => `swarm.${userId ?? 'anon'}.hideSuggested`;

/** turnsUsed is optional: summaries without it (team board) show an active goal as in progress. */
export interface GoalLike { status: 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled' | string; turnsUsed?: number }

/** One status label for a goal everywhere it is shown. */
export function goalStatusLabel(goal: GoalLike): string {
  switch (goal.status) {
    case 'active': return goal.turnsUsed === 0 ? 'Not started' : 'In progress';
    case 'paused': return 'Paused';
    case 'blocked': return 'Blocked';
    case 'completed': return 'Completed';
    case 'cancelled': return 'Stopped';
    default: return goal.status ? goal.status.charAt(0).toUpperCase() + goal.status.slice(1) : 'Unknown';
  }
}

/** Only stopped or completed goals can be deleted (the server returns 409 otherwise). */
export const goalDeletable = (goal: GoalLike) => goal.status === 'cancelled' || goal.status === 'completed';

/** Short user facing title for a needs-you item, used in the Tasks list. */
export function needsYouChip(type: NeedsYouItem['type']): string {
  switch (type) {
    case 'setup_review': return 'Setup review';
    case 'approval': return 'Approval';
    case 'question': return 'Question';
    case 'connect': return 'Connect app';
  }
}

/** Needs-you items scoped to one Bot (or all), oldest first, without duplicates. */
export function scopeNeedsYou(items: NeedsYouItem[] | null | undefined, botId?: string): NeedsYouItem[] {
  if (!items) return [];
  const seen = new Set<string>();
  return items.filter(item => {
    if (botId && item.botId !== botId) return false;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.createdAt - b.createdAt);
}

/** IANA zones for the Time zone select, with the current value first if the runtime does not list it. */
export function timeZoneOptions(current?: string | null): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    zones = supported ? supported('timeZone') : [];
  } catch { zones = []; }
  if (!zones.length) zones = ['UTC', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
  if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones;
}

/** The browser's own zone, or null when it cannot be read. */
export function browserTimeZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

/** R2F-027: browser network failures ("Failed to fetch", "Load failed", "NetworkError…") read as a plain next step. */
export function loadErrorText(failure: unknown): string {
  const message = (failure as Error | undefined)?.message?.trim() ?? '';
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline || !message || /failed to fetch|load failed|networkerror|network request failed|fetch failed|err_internet_disconnected/i.test(message)) return 'Check your connection.';
  return message;
}

/** R2F-026: an app's display name. Catalog name first, then the shared slug mapping ("notion" reads "Notion"). */
export function toolkitDisplayName(slug: string, catalogName?: string | null): string {
  const name = catalogName?.trim();
  if (name) return name;
  return appName(slug) ?? (slug.trim() || 'App');
}
