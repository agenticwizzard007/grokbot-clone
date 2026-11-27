import { db } from '../db.js';
import { isConfiguring } from '../bot-setup.js';
import { appendRow, updateRow } from '../store.js';
import { transactionWithEffects } from '../lib/commit-effects.js';
import { syncLoopTasks, syncHandoffTasks } from './tasks.js';
import type { LoopSpec, StopReason } from './contracts.js';
import type { EventBody, RowBody } from '../types.js';
type HandoffBody = Extract<RowBody, { type: 'handoff' }>;

export const ROOM_TARGET_REFUSAL = 'Choose an agent. Groups cannot receive handoffs.';

function ownRoom(userId: string, roomId: string) {
  const room = db.prepare("SELECT id,members,generation FROM bots WHERE id=? AND user_id=? AND kind='room'").get(roomId, userId) as { id: string; members: string | null; generation: number } | undefined;
  if (!room) throw new Error('Group not found.');
  return { ...room, members: JSON.parse(room.members ?? '[]') as string[] };
}

/** Members first; the optional other-agent list is informational, never an authorization grant. */
export function roomHandoffTargets(userId: string, roomId: string, fromBotId: string) {
  const room = ownRoom(userId, roomId);
  if (!room.members.includes(fromBotId)) throw new Error('Agent is not a group member.');
  const agents = db.prepare("SELECT id,name FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 AND id<>? ORDER BY name,id").all(userId, fromBotId) as { id: string; name: string }[];
  return agents.map(agent => ({ ...agent, member: room.members.includes(agent.id), disabled: !room.members.includes(agent.id) || isConfiguring(agent.id) }))
    .sort((a, b) => Number(b.member) - Number(a.member));
}

export function assertRoomHandoffTarget(userId: string, roomId: string, fromBotId: string, toBotId: string) {
  const target = db.prepare('SELECT kind FROM bots WHERE id=? AND user_id=?').get(toBotId, userId) as { kind: string } | undefined;
  if (!target) throw new Error('Agent not found.');
  if (target.kind === 'room') throw new Error(ROOM_TARGET_REFUSAL);
  if (!roomHandoffTargets(userId, roomId, fromBotId).some(agent => agent.id === toBotId && !agent.disabled)) throw new Error('Choose an active member of this group.');
}

const transitions = new Set(['loop.created', 'loop.approval_requested', 'loop.approved', 'loop.declined', 'loop.started',
  'loop.step_dispatched', 'loop.step_completed', 'loop.step_failed', 'loop.verdict', 'loop.paused', 'loop.resumed', 'loop.extended', 'loop.finished']);
const reasonText: Record<StopReason, string> = {
  passed: 'All checks passed', max_iterations: 'Pass limit reached', max_minutes: 'Time limit reached', max_cost: 'Cost limit reached',
  max_tokens: 'Token limit reached', stalled: 'No progress between the last two passes', step_failed: 'A step failed',
  no_verdict: 'No verdict received', user_stopped: 'Stopped by you', declined: 'Approval declined', gate_expired: 'Approval expired',
};
const integer = (value: unknown, fallback = 0) => Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), 10000) : fallback;

/** Project only allowlisted ids, counts and statuses, never instruction, output, feedback or packet text. */
export function postLoopRoomEvent(userId: string, eventSeq: number) {
  return transactionWithEffects(() => {
    const row = db.prepare(`SELECT e.*, l.room_id, l.spec FROM handoff_events e JOIN loops l ON l.id=e.loop_id AND l.user_id=e.user_id
      WHERE e.seq=? AND e.user_id=?`).get(eventSeq, userId) as { seq: number; loop_id: string; room_id: string | null; spec: string; type: string; data: string } | undefined;
    if (!row || !row.room_id || !transitions.has(row.type)) return null;
    const room = ownRoom(userId, row.room_id);
    const ref = `#loop/${encodeURIComponent(row.loop_id)}?event=${row.seq}`;
    const exists = db.prepare("SELECT seq FROM rows WHERE bot_id=? AND generation=? AND kind='event' AND json_extract(body,'$.ref')=?").get(room.id, room.generation, ref) as { seq: number } | undefined;
    if (exists) return exists.seq;
    const spec = JSON.parse(row.spec) as LoopSpec;
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const pass = integer(data.iteration);
    const progress = `Pass ${pass} of ${integer(spec.limits.maxIterations)}`;
    let text: string;
    switch (row.type) {
      case 'loop.created': text = 'Loop created'; break;
      case 'loop.approval_requested': text = 'Loop needs your approval'; break;
      case 'loop.approved': text = 'Loop approved'; break;
      case 'loop.declined': text = 'Loop approval declined'; break;
      case 'loop.started': text = 'Loop started'; break;
      case 'loop.step_dispatched': text = `${progress}: step started`; break;
      case 'loop.step_completed': text = `${progress}: step completed`; break;
      case 'loop.step_failed': text = `${progress}: step failed`; break;
      case 'loop.verdict': text = `${progress}: ${data.pass === true ? 'checks passed' : Number.isSafeInteger(data.gaps) ? `${integer(data.gaps)} gaps found` : 'changes requested'}`; break;
      case 'loop.paused': text = 'Loop paused'; break;
      case 'loop.resumed': text = 'Loop resumed'; break;
      case 'loop.extended': text = 'Loop pass limit extended'; break;
      default: {
        const reason = data.stopReason as StopReason;
        text = reason === 'passed' ? `Done in ${pass} ${pass === 1 ? 'pass' : 'passes'}` : `Loop stopped: ${reasonText[reason] ?? 'Review the loop'}`;
      }
    }
    const body: EventBody = { type: 'event', event: 'bot-message', text, ref };
    return appendRow(room.id, 'event', { ...body, audience: 'user' }).seq;
  });
}

/** Exactly one room receipt per handoff, updated in place as its status changes. */
export function postRoomHandoff(userId: string, handoffId: string) {
  return transactionWithEffects(() => {
    const handoff = db.prepare('SELECT * FROM handoffs WHERE id=? AND user_id=?').get(handoffId, userId) as {
      room_id: string | null; from_bot_id: string; to_bot_id: string; status: HandoffBody['status']; loop_id: string | null; iteration: number | null;
    } | undefined;
    if (!handoff?.room_id) return null;
    const room = ownRoom(userId, handoff.room_id);
    // Membership is checked when creating a handoff. Removed members must still get a final receipt.
    const body: HandoffBody = { type: 'handoff', handoffId, direction: 'sent', otherBotId: handoff.to_bot_id,
      status: handoff.status, title: 'Agent handoff', ...(handoff.loop_id ? { loopId: handoff.loop_id } : {}), ...(handoff.iteration !== null ? { iteration: handoff.iteration } : {}) };
    const existing = db.prepare("SELECT seq,body FROM rows WHERE bot_id=? AND generation=? AND kind='handoff' AND json_extract(body,'$.handoffId')=?").get(room.id, room.generation, handoffId) as { seq: number; body: string } | undefined;
    if (existing) {
      const before = JSON.parse(existing.body);
      if (before.status !== body.status) updateRow(room.id, existing.seq, { ...body, audience: 'user' });
      return existing.seq;
    }
    return appendRow(room.id, 'handoff', { ...body, audience: 'user' }).seq;
  });
}

/** HO-B calls this after a durable transition and replays event seqs during recovery. */
export function projectHandoffEvent(userId: string, eventSeq: number) {
  return transactionWithEffects(() => {
    const event = db.prepare('SELECT type,loop_id,handoff_id FROM handoff_events WHERE seq=? AND user_id=?').get(eventSeq, userId) as {
      type: string; loop_id: string | null; handoff_id: string | null;
    } | undefined;
    if (!event) return;
    if (event.loop_id && transitions.has(event.type)) {
      syncLoopTasks(userId, event.loop_id);
      postLoopRoomEvent(userId, eventSeq);
    }
    if (event.handoff_id && ['handoff.created', 'handoff.approved', 'handoff.declined', 'handoff.delivered', 'handoff.completed', 'handoff.failed', 'handoff.cancelled', 'handoff.expired'].includes(event.type)) {
      syncHandoffTasks(userId, event.handoff_id);
      postRoomHandoff(userId, event.handoff_id);
    }
  });
}
