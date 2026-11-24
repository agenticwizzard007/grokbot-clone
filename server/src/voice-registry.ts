import { db } from './db.js';

export interface TeamUpdate { id: number; botId: string; botName: string; kind: 'message' | 'input' | 'waiting' | 'status'; text: string }
interface CallTask { id: string; botId: string; botName: string; request: string }
export interface ActiveCall {
  id: string; botId: string; generation: number; userId: string; startedAt: number; lastActiveAt: number; startSeq: number; tasks: string[]; provider: string; model: string;
  cursor: number; updates: TeamUpdate[]; seenRows: Map<string, string>; jobs: CallTask[];
  jobStates: Map<string, string>;
  toolCalls: Map<string, { signature: string; result: Promise<VoiceToolOutput>; output?: VoiceToolOutput }>;
  transcript: TranscriptLine[];
  transcriptRevision: number;
  sharedTranscripts: Map<string, TranscriptLine[]>;
  connectionBaseline: Map<string, { generation: number; seq: number }>;
  connectionsCheckedAt?: number;
}
export interface TranscriptLine { id?: string; role: 'user' | 'assistant'; text: string }
export interface VoiceToolOutput { output: string; taskSeq?: number; taskBotId?: string; taskId?: string }


// Audio connects directly to the provider and survives an app server restart.
// Persist the coordinator under the same app call ID before returning /session.
// Never persist the provider client secret. Account/bot deletion cascades the state.
db.exec(`CREATE TABLE IF NOT EXISTS voice_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  state TEXT NOT NULL
)`);

const interruptedTool = { output: 'The server restarted while this action was running. Its outcome is uncertain. Read the agent state before continuing; do not automatically repeat the action.' };
const mapFields = ['seenRows', 'jobStates', 'sharedTranscripts', 'connectionBaseline'] as const;
export const CALL_IDLE_MS = 2 * 3600_000;

export class VoiceRegistry extends Map<string, ActiveCall> {
  constructor() {
    super();
    for (const row of db.prepare('SELECT state FROM voice_calls').all() as { state: string }[]) {
      const call = JSON.parse(row.state);
      for (const field of mapFields) call[field] = new Map(call[field]);
      call.toolCalls = new Map(call.toolCalls.map(([id, tool]: [string, { signature: string; output?: VoiceToolOutput }]) =>
        [id, { ...tool, result: Promise.resolve(tool.output ?? interruptedTool) }]));
      super.set(call.id, call);
    }
  }
  override set(id: string, call: ActiveCall) {
    db.prepare('INSERT INTO voice_calls(id,user_id,bot_id,state) VALUES(?,?,?,?)').run(id, call.userId, call.botId, this.encode(call));
    return super.set(id, call);
  }
  save(call: ActiveCall) {
    // An in-flight request finishing after /end must never resurrect the call.
    if (this.get(call.id) !== call) return;
    db.prepare('UPDATE voice_calls SET state=? WHERE id=?').run(this.encode(call), call.id);
  }
  override delete(id: string) {
    db.prepare('DELETE FROM voice_calls WHERE id=?').run(id);
    return super.delete(id);
  }
  expired(at: number) { return [...this.values()].filter(call => at - call.lastActiveAt >= CALL_IDLE_MS); }
  private encode(call: ActiveCall) {
    return JSON.stringify({ ...call,
      ...Object.fromEntries(mapFields.map(field => [field, [...call[field]]])),
      toolCalls: [...call.toolCalls].map(([id, tool]) => [id, { signature: tool.signature, output: tool.output }]),
    });
  }
}
