import { isTenant } from '../deployment.js';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { env } from '../env.js';
import { voiceProvider } from './voice-provider.js';
import { selectedCli } from '../cli/store.js';
import { currentUserId } from '../usage-context.js';
import { recordModelUsage, recordUnits } from '../usage.js';
import { openrouterConnection, personalOpenRouterKey, usesPersonalOpenRouter } from '../providers/openrouter.js';

/**
 * Speech for Bots: transcription (voice notes, dictation) and text-to-speech (voice replies, previews).
 *
 * Standalone voice notes try OpenRouter first, then platform voice and the legacy direct provider.
 * CLI subscriptions use platform voice without falling back to shared text API credentials.
 * Speech synthesis keeps platform voice first, including CLI and personal OpenRouter users.
 * Live voice calls are separate: they need direct provider's realtime API (voice.ts).
 */

export const STT_MODEL = () => process.env.OPENROUTER_STT_MODEL || 'openai/gpt-4o-mini-transcribe';
/** model's own voices through OpenRouter, so a Bot sounds the same in texts as on a live call. */
export const TTS_MODEL = () => process.env.OPENROUTER_TTS_MODEL || 'openai/gpt-4o-mini-tts';
const DIRECT_STT_MODEL = () => process.env.DIRECT_STT_MODEL ?? 'audio-transcribe-latest';

/** provider voices (the same ids Bots use for live calls; see voice.ts). */
export const TTS_VOICES = ['altair', 'ara', 'atlas', 'aurora', 'carina', 'castor', 'celeste', 'cosmo', 'eve', 'helios', 'helix', 'iris', 'kepler', 'leo',
  'liora', 'lumen', 'luna', 'lux', 'naksh', 'orion', 'perseus', 'rex', 'rigel', 'sal', 'sirius', 'ursa', 'zagan', 'zenith'];
export const DEFAULT_TTS_VOICE = 'luna';

export interface Audio { data: Buffer; mime: string }

export class SpeechUnavailable extends Error {}

export const SUBSCRIPTION_VOICE_UNAVAILABLE = 'Platform voice is not configured yet. Ask your platform admin to enable it. Voice is billed separately from CLI subscriptions.';
const subscriptionMode = () => !!selectedCli(currentUserId());
const openrouterKey = () => usesPersonalOpenRouter(currentUserId()) ? personalOpenRouterKey(currentUserId()!) : env.openrouterKey;

export function speechStatus() {
  const platform = isTenant ? !!voiceProvider().key : !!env.voiceKey;
  const personal = openrouterConnection(currentUserId());
  const subscription = subscriptionMode();
  const or = !subscription && (personal?.enabled ? !!personal.encrypted_key : !isTenant && !!env.openrouterKey);
  const direct = !isTenant && !subscription && !personal?.enabled && !!env.directKey;
  const transcriptionOr = isTenant ? !platform && or : personal?.enabled ? !!personal.encrypted_key : !subscription && !!env.openrouterKey;
  const transcriptionDirect = !isTenant && !subscription && !!env.directKey;
  return {
    transcription: transcriptionOr ? 'openrouter' : platform ? 'xai' : transcriptionDirect ? 'direct' : null,
    speech: platform ? 'xai' : or ? 'openrouter' : direct ? 'direct' : null,
    sttModel: transcriptionOr ? STT_MODEL() : platform ? 'xai-stt' : transcriptionDirect ? DIRECT_STT_MODEL() : null,
    ttsModel: platform ? 'xai-tts' : or ? TTS_MODEL() : null,
  } as const;
}

// ---------- formats ----------

/** OpenRouter transcription accepts these container formats directly. */
const ACCEPTED: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/webm': 'webm',
};
const baseMime = (mime: string) => mime.split(';')[0].trim().toLowerCase();
export const formatFor = (mime: string): string | null => ACCEPTED[baseMime(mime)] ?? null;

let ffmpegPath: string | null | undefined;
function ffmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    ffmpegPath = p && fs.existsSync(p) ? p : null;
  } catch { ffmpegPath = null; }
  return ffmpegPath;
}

/**
 * Convert unsupported audio (iMessage voice notes are CAF) to mp3. Input goes through a temp file because
 * some containers (CAF) need a seekable input.
 */
export async function toMp3(a: Audio): Promise<Audio> {
  const bin = ffmpeg();
  if (!bin) throw new SpeechUnavailable(`can't read ${baseMime(a.mime)} audio (no ffmpeg on this server)`);
  const tmp = path.join(os.tmpdir(), `swarm-audio-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, a.data, { mode: 0o600 });
  try {
    const out = await new Promise<Buffer>((resolve, reject) => {
      execFile(bin, ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-vn', '-ac', '1', '-ar', '24000', '-f', 'mp3', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024, timeout: 30_000 },
        (err, stdout, stderr) => (err ? reject(new Error(`audio conversion failed: ${String(stderr).slice(0, 200) || err.message}`)) : resolve(stdout)));
    });
    if (!out.length) throw new Error('audio conversion produced nothing');
    return { data: out, mime: 'audio/mpeg' };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- transcription ----------

class TranscriptionFailure extends Error {
  constructor(provider: string, readonly status: number) { super(`${provider} transcription failed (${status}).`); }
}

async function openrouterTranscribe(a: Audio, language?: string): Promise<string> {
  const ready = formatFor(a.mime) ? a : await toMp3(a);
  const r = await fetch(`${env.openrouterBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openrouterKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: STT_MODEL(), input_audio: { data: ready.data.toString('base64'), format: formatFor(ready.mime) }, ...(language ? { language } : {}) }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) { await r.body?.cancel(); throw new TranscriptionFailure('OpenRouter', r.status); }
  const j = (await r.json()) as { text?: string; usage?: unknown };
  if (j.usage) void recordModelUsage({ kind: 'transcription', model: STT_MODEL(), provider: 'openrouter', response: j });
  else recordUnits({ kind: 'transcription', model: STT_MODEL(), provider: 'openrouter', units: 1, unit: 'recordings' });
  return String(j.text ?? '').trim();
}

async function directTranscribe(a: Audio, language?: string, provider: Pick<ReturnType<typeof voiceProvider>, 'key' | 'baseUrl' | 'provider'> = voiceProvider()): Promise<string> {
  // Platform STT does not accept Apple's CAF container either. Keep the same
  // normalization as OpenRouter instead of bypassing it when platform voice is enabled.
  const ready = formatFor(a.mime) ? a : await toMp3(a);
  const model = provider.provider === 'xai' ? 'xai-stt' : DIRECT_STT_MODEL();
  const upload = (audio: Audio) => {
    const form = new FormData();
    if (provider.provider !== 'xai') form.append('model', model);
    if (language && /^[a-z]{2}$/.test(language)) form.append('language', language);
    form.append('file', new Blob([new Uint8Array(audio.data)], { type: baseMime(audio.mime) }), `voice.${formatFor(audio.mime)}`); // must be last
    return fetch(`${provider.baseUrl}/stt`, { method: 'POST', headers: { Authorization: `Bearer ${provider.key}` }, body: form, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  };
  let r = await upload(ready);
  // Retry rejected containers/codecs once as MP3 before trying another provider.
  if (provider.provider === 'xai' && (r.status === 400 || r.status === 415) && ready === a && formatFor(a.mime) !== 'mp3') {
    await r.body?.cancel();
    r = await upload(await toMp3(a));
  }
  if (!r.ok) { await r.body?.cancel(); throw new TranscriptionFailure('Voice', r.status); }
  const j = (await r.json()) as { text?: string; usage?: unknown };
  if (j.usage) void recordModelUsage({ kind: 'transcription', model, provider: provider.provider, response: j });
  else recordUnits({ kind: 'transcription', model, provider: provider.provider, units: 1, unit: 'recordings' });
  return String(j.text ?? '').trim();
}

/** Transcribe a recording. Throws SpeechUnavailable when no provider is set up; tries the other provider on failure. */
export async function transcribe(a: Audio, opts: { language?: string } = {}): Promise<string> {
  if (isTenant) {
    if (voiceProvider().key) return directTranscribe(a, opts.language);
    if (subscriptionMode()) throw new SpeechUnavailable(SUBSCRIPTION_VOICE_UNAVAILABLE);
    if (usesPersonalOpenRouter(currentUserId())) return openrouterTranscribe(a, opts.language);
    throw new SpeechUnavailable('Configure your own compatible voice API credential first.');
  }
  const subscription = subscriptionMode();
  const order = [
    usesPersonalOpenRouter(currentUserId()) || (!subscription && env.openrouterKey) ? 'openrouter' : null,
    env.voiceKey ? 'xai' : null,
    !subscription && env.directKey ? 'direct' : null,
  ].filter(Boolean) as ('openrouter' | 'xai' | 'direct')[];
  if (!order.length) throw new SpeechUnavailable(subscription ? SUBSCRIPTION_VOICE_UNAVAILABLE : 'Voice notes need an OpenRouter or direct provider key on this server.');
  let last: unknown;
  for (const p of order) {
    try {
      if (p === 'openrouter') return await openrouterTranscribe(a, opts.language);
      return await directTranscribe(a, opts.language, p === 'xai' ? voiceProvider() : { key: env.directKey, baseUrl: env.directBaseUrl.replace(/\/$/, ''), provider: 'direct' });
    } catch (e) {
      last = e;
      console.warn(`[speech] ${p} transcription failed: ${e instanceof TranscriptionFailure ? e.status : 'unavailable'}`);
    }
  }
  throw last;
}

// ---------- text-to-speech ----------

async function openrouterSpeak(text: string, voice: string, format: 'mp3' | 'pcm'): Promise<Audio> {
  const r = await fetch(`${env.openrouterBaseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openrouterKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL(), input: text, voice: TTS_VOICES.includes(voice) ? voice : DEFAULT_TTS_VOICE, response_format: format }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`OpenRouter speech failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const data = Buffer.from(await r.arrayBuffer());
  if (!data.length) throw new Error('OpenRouter speech returned no audio');
  recordUnits({ kind: 'speech', model: TTS_MODEL(), provider: 'openrouter', units: text.length, unit: 'characters' });
  return { data, mime: format === 'pcm' ? 'audio/pcm;rate=24000' : 'audio/mpeg' };
}

async function directSpeak(text: string, voice: string, format: 'mp3' | 'pcm'): Promise<Audio> {
  const provider = voiceProvider();
  const r = await fetch(`${provider.baseUrl}/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, ...(provider.provider === 'xai' ? { language: 'auto' } : {}), output_format: { codec: format, sample_rate: 24000 } }),
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
  });
  if (!r.ok) throw new Error(`Voice speech failed (${r.status}).`);
  recordUnits({ kind: 'speech', model: `${provider.provider}-tts`, provider: provider.provider, units: text.length, unit: 'characters' });
  return { data: Buffer.from(await r.arrayBuffer()), mime: format === 'pcm' ? 'audio/pcm;rate=24000' : 'audio/mpeg' };
}

/** Speak text. `voice` is an OpenRouter TTS voice (or a direct provider voice id when only direct provider is set up). */
export async function synthesize(text: string, voice: string, format: 'mp3' | 'pcm' = 'mp3'): Promise<Audio> {
  if (isTenant ? !!voiceProvider().key : !!env.voiceKey) return directSpeak(text, voice, format);
  if (subscriptionMode()) throw new SpeechUnavailable(SUBSCRIPTION_VOICE_UNAVAILABLE);
  if (usesPersonalOpenRouter(currentUserId())) return openrouterSpeak(text, voice, format);
  if (isTenant) throw new SpeechUnavailable('Configure your own compatible voice API credential first.');
  if (env.openrouterKey) return openrouterSpeak(text, voice, format);
  if (env.directKey) return directSpeak(text, voice, format);
  throw new SpeechUnavailable('Voice replies need an OpenRouter or direct provider key on this server.');
}
