import { env } from '../env.js';

/** Read credentials per request so admin key changes apply without a restart. */
export function voiceProvider() {
  const platform = !!env.voiceKey;
  const baseUrl = (platform ? env.voiceBaseUrl : env.directBaseUrl).replace(/\/$/, '');
  const model = platform ? 'grok-voice' : process.env.DIRECT_VOICE_MODEL || 'voice-realtime-latest';
  return {
    key: platform ? env.voiceKey : env.directKey,
    baseUrl,
    provider: platform ? 'xai' : 'direct',
    model,
    // xAI selects its realtime model at the endpoint; legacy compatible servers accept a model query.
    websocketUrl: `${baseUrl.replace(/^http/i, 'ws')}/realtime${platform ? '' : `?model=${encodeURIComponent(model)}`}`,
  };
}

/** Validate realtime access rather than accepting a key that only has text-model permissions.
 * Never expose provider error bodies: they may contain credentials. */
export async function mintVoiceSecret(key: string, baseUrl: string): Promise<{ value: string; expires_at: number }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/realtime/client_secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'The voice provider rejected this key or its realtime permissions.'
    : `The voice provider could not start a session (HTTP ${response.status}). Check its credits and service status.`);
  const body = await response.json();
  if (typeof body?.value !== 'string' || !body.value.trim() || body.value === key ||
      typeof body.expires_at !== 'number' || !Number.isFinite(body.expires_at) || body.expires_at <= Date.now() / 1000) {
    throw new Error('The voice provider returned an invalid session credential.');
  }
  return { value: body.value, expires_at: body.expires_at };
}
