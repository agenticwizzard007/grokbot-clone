import { db } from '../../db.js';
import { platformContext } from '../../agent/platform-state.js';
import type { SourceData } from './catalog.js';

/** platformContext is the existing synchronous, cache-only platform reader.
 * Its final line is the serialized public snapshot. Never call platformState or
 * cliDisplayCatalog here: even passive display discovery can probe a provider. */
export function cachedWindows(userId: string): SourceData {
  const bot = db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY id LIMIT 1').get(userId) as { id: string } | undefined;
  if (!bot) return { available: false, count: 0, rows: [] };
  const context = platformContext(userId, bot.id);
  const snapshot = JSON.parse(context.slice(context.lastIndexOf('\n') + 1));
  const usage = snapshot.cli?.catalog?.usage;
  const rows = usage?.available === true ? usage.windows.map((window: any) => ({
    label: window.label ?? 'Usage', usedPercent: window.usedPercent, resetsAt: window.resetsAt,
  })) : [];
  return { available: usage?.available === true, count: rows.length, rows: rows.slice(0, 25) };
}
