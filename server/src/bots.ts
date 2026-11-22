import { assertTenant } from './deployment.js';
import { assertLegacyWorkOpen } from './security/legacy-work.js';
import { publishNativeEvent } from './native/events.js';
import { z } from 'zod';
import { EFFORTS, isEffort, type Effort } from './types.js';
import { BIRD_SHAPES } from './avatar-shapes.js';
import { db, now } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { newId } from './lib/ids.js';
import { getBot } from './store.js';
import type { AvatarColor, AvatarShape, Bot } from './types.js';
import { saveSetup, removeSetupFiles, type BotBrief, type SetupSource } from './bot-setup.js';

export const AVATAR_SHAPES: AvatarShape[] = [
  ...BIRD_SHAPES,
  'blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex',
  'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf',
  'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star',
];

export const AVATAR_COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

/** Field limits shared by create (POST /bots) and edit (PATCH /bots/:id). */
export const BOT_LIMITS = { name: 60, label: 40, description: 300, instructions: 8000, model: 120, voice: 40, voiceLanguage: 40, voiceSpeedMin: 0.7, voiceSpeedMax: 1.5 } as const;

/** Every field a client may edit on a Bot. Unknown keys are rejected. */
export const botPatchSchema = z.object({
  name: z.string().transform((v) => v.replace(/\s+/g, ' ').trim()).pipe(z.string().min(1, 'Name is required').max(BOT_LIMITS.name)),
  label: z.string().transform((v) => v.replace(/\s+/g, ' ').trim()).pipe(z.string().max(BOT_LIMITS.label)),
  description: z.string().transform((v) => v.trim()).pipe(z.string().max(BOT_LIMITS.description)),
  instructions: z.string().max(BOT_LIMITS.instructions),
  expectedInstructions: z.string().max(100_000),
  avatarShape: z.enum(AVATAR_SHAPES as [AvatarShape, ...AvatarShape[]]),
  avatarColor: z.enum(AVATAR_COLORS as [AvatarColor, ...AvatarColor[]]),
  mode: z.enum(['personal', 'teammate']),
  effort: z.enum(EFFORTS as unknown as [Effort, ...Effort[]]),
  pinned: z.boolean(),
  voice: z.string().trim().min(1).max(BOT_LIMITS.voice),
  voiceSpeed: z.number().finite().min(BOT_LIMITS.voiceSpeedMin).max(BOT_LIMITS.voiceSpeedMax),
  voiceLanguage: z.string().trim().min(1).max(BOT_LIMITS.voiceLanguage),
  model: z.string().max(BOT_LIMITS.model).nullable().transform((v) => v?.trim() || null),
  fast: z.boolean(),
}).partial().strict().superRefine((p, ctx) => {
  if (p.expectedInstructions !== undefined && p.instructions === undefined) ctx.addIssue({ code: 'custom', path: ['instructions'], message: 'Instructions are required with expectedInstructions' });
});
export type BotPatch = z.infer<typeof botPatchSchema>;

/** POST /bots body. Same limits as edit; unknown keys are ignored for older clients. */
export const botCreateSchema = z.object({
  name: z.string().max(BOT_LIMITS.name).optional(),
  label: z.string().max(BOT_LIMITS.label).optional(),
  description: z.string().max(BOT_LIMITS.description).optional(),
  instructions: z.string().max(BOT_LIMITS.instructions).optional(),
  avatarShape: z.enum(AVATAR_SHAPES as [AvatarShape, ...AvatarShape[]]).optional(),
  avatarColor: z.enum(AVATAR_COLORS as [AvatarColor, ...AvatarColor[]]).optional(),
  mode: z.enum(['personal', 'teammate']).optional(),
  effort: z.enum(EFFORTS as unknown as [Effort, ...Effort[]]).optional(),
  model: z.string().max(BOT_LIMITS.model).nullable().optional(),
  brief: z.unknown().optional(),
});

/** Brief relevant fields: changing one of these is a new setup revision (MF-013). */
export const BRIEF_FIELDS = ['name', 'label', 'description', 'instructions', 'mode'] as const;

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
  const shape = AVATAR_SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, BIRD_SHAPES);
  const color = AVATAR_COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, AVATAR_COLORS.filter((c) => c !== 'black'));
  const effort = isEffort(b.effort) ? b.effort : 'medium';
  const model = typeof b.model === 'string' ? b.model.trim().slice(0, BOT_LIMITS.model) || null : null;
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,effort,model,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        userId,
        clean(b.name, BOT_LIMITS.name) || 'New Bot',
        clean(b.label, BOT_LIMITS.label),
        clean(b.description, BOT_LIMITS.description),
        String(b.instructions ?? '').trim().slice(0, BOT_LIMITS.instructions),
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

/** Call inside the same transaction as deletion/demotion. */
export function assertPrimaryRemovalAllowed(userId:string,botId:string) {
  assertTenant(userId);assertLegacyWorkOpen(userId);
  const bot=db.prepare('SELECT is_primary FROM bots WHERE id=? AND user_id=?').get(botId,userId) as any;
  if(!bot)throw new Error('Bot not found.');
  if(bot.is_primary && !db.prepare("SELECT 1 FROM bots b JOIN bot_setups s ON s.bot_id=b.id WHERE b.user_id=? AND b.id!=? AND b.is_primary=1 AND COALESCE(b.hidden,0)=0 AND b.parent_bot_id IS NULL AND COALESCE(b.kind,'agent')!='room' AND s.onboarding_status='active'").get(userId,botId))throw new Error('Transfer the primary role to an activated teammate before removing this Bot.');
}
/** Atomic compare-and-transfer; permanent teammates keep their job lineage. */
export function transferPrimary(userId:string,fromBotId:string,toBotId:string) {
  assertTenant(userId);assertLegacyWorkOpen(userId);
  return db.transaction(()=>{
    const from=db.prepare('SELECT * FROM bots WHERE id=? AND user_id=? AND is_primary=1').get(fromBotId,userId) as any;
    const to=db.prepare(`SELECT b.* FROM bots b JOIN bot_setups s ON s.bot_id=b.id WHERE b.id=? AND b.user_id=? AND COALESCE(b.hidden,0)=0 AND b.parent_bot_id IS NULL AND COALESCE(b.kind,'agent')!='room' AND s.onboarding_status='active'`).get(toBotId,userId) as any;
    if(!from||!to||fromBotId===toBotId)throw new Error('Primary transfer requires the current primary and an activated permanent teammate.');
    db.prepare('UPDATE bots SET is_primary=CASE WHEN id=? THEN 1 ELSE 0 END,updated_at=? WHERE user_id=? AND (is_primary=1 OR id=?)').run(toBotId,now(),userId,toBotId);
    publishNativeEvent({userId,botId:toBotId,kind:'coordination.primary_transferred',sourceType:'bot',sourceId:toBotId,audience:'internal',data:{fromBotId,toBotId}});
    hub.emit(userId,{type:'roster'});return getBot(toBotId)!;
  })();
}
