import { isEffort } from './types.js';
import { db, now } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { newId } from './lib/ids.js';
import { getBot } from './store.js';
import type { AvatarColor, AvatarShape, Bot } from './types.js';
import { saveSetup, removeSetupFiles, type BotBrief, type SetupSource } from './bot-setup.js';

export const AVATAR_SHAPES: AvatarShape[] = [
  'blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex',
  'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf',
  'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star',
];

export const AVATAR_COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

export interface CreateBotInput {
  name: string;
  label?: string;
  description?: string;
  instructions?: string;
  avatarShape?: string;
  avatarColor?: string;
  mode?: string;
  isPrimary?: boolean;
  effort?: string;
  model?: string | null;
  brief?: BotBrief;
  source?: SetupSource;
}

function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

function clean(value: unknown, max: number) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createBot(userId: string, b: CreateBotInput): Bot {
  const id = newId('bot');
  const shape = AVATAR_SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, AVATAR_SHAPES.slice(0, 13));
  const color = AVATAR_COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, AVATAR_COLORS.filter((c) => c !== 'black'));
  const effort = isEffort(b.effort) ? b.effort : 'medium';
  const model = typeof b.model === 'string' ? b.model.trim().slice(0, 120) || null : null;
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,effort,model,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        userId,
        clean(b.name, 60) || 'New Bot',
        clean(b.label, 40),
        clean(b.description, 300),
        String(b.instructions ?? '').trim().slice(0, 8000),
        shape,
        color,
        b.mode === 'teammate' ? 'teammate' : 'personal',
        b.isPrimary ? 1 : 0,
        effort,
        model,
        now(),
        now(),
      );
      const purpose = b.brief?.purpose || String(b.description || b.label || 'Help the user with their assigned work.');
      saveSetup(id, b.brief ?? {
        purpose, responsibilities: [purpose], out_of_scope: [], success_criteria: ['Complete the user’s assigned work and report results and blockers.'],
        context_summary: String(b.instructions || purpose), shared_resources: [], handoff_notes: [],
      }, b.source ?? { messages: [] }, b.isPrimary ? 'active' : 'interviewing');
    })();
  } catch (e) {
    removeSetupFiles(id);
    throw e;
  }
  hub.emit(userId, { type: 'roster' });
  // Cloud VMs: every Bot has its own screen, so the user's VM grows to fit (a background job; it waits until no Bot is working).
  if (env.computerProvider === 'cloudvm' && !b.isPrimary) void import('./provisioning.js').then((m) => m.enqueueVmJob('resize', { userId })).catch(() => {});
  return getBot(id)!;
}

export function visibleAgentByName(userId: string, name: string) {
  return db.prepare(
    "SELECT * FROM bots WHERE user_id=? AND lower(name)=lower(?) AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')<>'room'",
  ).get(userId, name.trim()) as any;
}
