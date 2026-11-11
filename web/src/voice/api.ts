import type { VoiceOption } from '@shared/types';

export interface VoiceSession {
  callId: string;
  clientSecret: string;
  clientSecretProtocol?: 'xai-client-secret' | 'direct-client-secret';
  expiresAt: number;
  model: string;
  websocketUrl: string;
  sampleRate: number;
  instructions: string;
  voice: string;
  speed: number;
  language: string;
  tools: unknown[];
  session: Record<string, unknown>;
}

export interface VoiceOptions { voices: VoiceOption[]; languages: { code: string; name: string }[]; speeds: number[] }

export interface VoiceToolResult { output: string; taskSeq?: number; taskBotId?: string; taskId?: string }
export interface VoiceUpdate {
  id: number;
  botId: string;
  botName: string;
  kind: 'message' | 'input' | 'waiting' | 'status';
  text: string;
}
export interface VoiceTask {
  id: string;
  botId: string;
  botName: string;
  request: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
}
export interface VoiceUpdates { cursor: number; updates: VoiceUpdate[]; tasks: VoiceTask[] }

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/voice${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

let optionsPromise: Promise<VoiceOptions> | null = null;

export const voiceApi = {
  options: () => (optionsPromise ??= fetch('/api/voice/options', { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<VoiceOptions>;
  }).catch((e) => { optionsPromise = null; throw e; })),
  session: (botId: string) => post<VoiceSession>('/session', { botId }),
  tool: (botId: string, callId: string, name: string, args: unknown, toolCallId?: string) => post<VoiceToolResult>('/tool', { botId, callId, name, args, toolCallId }),
  updates: (botId: string, callId: string, after: number, signal?: AbortSignal) => post<VoiceUpdates>('/updates', { botId, callId, after }, signal),
  end: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], error?: string) => post<{ ok: true }>('/end', { botId, callId, transcript, error }),
  /** Best-effort end on tab close. */
  endBeacon: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[]) => {
    try { navigator.sendBeacon('/api/voice/end', new Blob([JSON.stringify({ botId, callId, transcript })], { type: 'application/json' })); } catch { /* ignore */ }
  },
  async preview(p: { botId: string; voice?: string; speed?: number; language?: string; text?: string }): Promise<Int16Array> {
    const res = await fetch('/api/voice/preview', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, codec: 'pcm' }) });
    if (!res.ok) throw new Error('Preview unavailable');
    const buf = await res.arrayBuffer();
    return new Int16Array(buf, 0, buf.byteLength >> 1);
  },
  async transcribe(blob: Blob, language?: string): Promise<string> {
    const fd = new FormData();
    if (language) fd.append('language', language);
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    fd.append('file', blob, `dictation.${ext}`);
    const res = await fetch('/api/voice/stt', { method: 'POST', credentials: 'include', body: fd });
    if (!res.ok) {
      let msg = 'Transcription failed';
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return ((await res.json()) as { text: string }).text;
  },
};
