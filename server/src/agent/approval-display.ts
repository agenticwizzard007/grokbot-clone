import { db } from '../db.js';

/** Hidden helpers present decisions in the nearest visible parent's conversation. */
export function approvalDisplayBot(botId: string): string {
  const seen = new Set<string>();
  let current = db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;
  const owner = current?.user_id;
  while (current?.hidden && current.parent_bot_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = db.prepare('SELECT * FROM bots WHERE id=?').get(current.parent_bot_id) as any;
    if (!parent || parent.user_id !== owner) return botId;
    current = parent;
  }
  return current && !current.hidden ? current.id : botId;
}
