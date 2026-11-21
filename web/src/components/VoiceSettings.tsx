import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Bot } from '@shared/types';
import { useStore } from '../store';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { endCall, isCallActive, previewVoice, startCall, useVoice } from '../voice/call';

const speedLabel = (speed: number) => `${Number(speed.toFixed(2))}×`;

function VoiceField<Value extends string | number>({ label, value, options, onChange, disabled, hint }: {
  label: string; value: Value; options: { value: Value; label: string }[]; onChange: (value: Value) => void; disabled: boolean; hint?: string;
}) {
  const choices = options.some(option => option.value === value) ? options : [{ value, label: String(value) }, ...options];
  return <label className="voice-settings__field">
    <span>{label}</span>
    <span className="voice-settings__control">
      <select className="text-input" aria-label={label} value={String(value)} disabled={disabled} onChange={event => {
        const option = choices.find(item => String(item.value) === event.target.value);
        if (option) onChange(option.value);
      }}>
        {choices.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
      </select>
      <ChevronDown size={15} aria-hidden />
    </span>
    {hint && <small>{hint}</small>}
  </label>;
}

type VoicePatch = Pick<Bot, 'voice' | 'voiceSpeed' | 'voiceLanguage'>;
const fieldName: Record<keyof VoicePatch, string> = { voice: 'voice', voiceSpeed: 'speed', voiceLanguage: 'language' };

export function VoiceSettings({ bot }: { bot: Bot }) {
  const accountId = useStore(state => state.user?.id);
  return <BotVoiceSettings key={`${accountId}:${bot.id}`} accountId={accountId} bot={bot} />;
}

function BotVoiceSettings({ bot, accountId }: { bot: Bot; accountId?: string }) {
  const [options, setOptions] = useState<VoiceOptions | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const inCall = useVoice(state => isCallActive(state) && state.botId === bot.id);
  const current = () => mounted.current && useStore.getState().user?.id === accountId;

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    setOptionsError(false);
    void voiceApi.options().then(result => { if (alive && current()) setOptions(result); })
      .catch(() => { if (alive && current()) setOptionsError(true); });
    return () => { alive = false; mounted.current = false; };
  }, [accountId, attempt]);

  async function save<Field extends keyof VoicePatch>(field: Field, value: VoicePatch[Field]) {
    if (!current() || pending.current) return;
    const previousValue = bot[field];
    pending.current = true; setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }) });
      if (!res.ok) throw new Error('Save failed');
      const { bot: saved } = await res.json() as { bot: Bot };
      if (useStore.getState().user?.id !== accountId || saved.id !== bot.id) return;
      useStore.setState(state => ({ bots: state.bots.map(item => item.id === bot.id && item[field] === previousValue ? { ...item, [field]: saved[field] } : item) }));
    } catch {
      if (current()) setError({ title: `Couldn’t save the ${fieldName[field]}`, detail: `Your previous value is still active. Choose a ${fieldName[field]} again to retry.` });
    } finally {
      pending.current = false;
      if (current()) setSaving(false);
    }
  }

  async function preview() {
    if (previewing || saving || !current()) return;
    setPreviewing(true); setError(null);
    try { await previewVoice({ botId: bot.id, voice: bot.voice, speed: bot.voiceSpeed, language: bot.voiceLanguage }); }
    catch (err) { if (current()) setError({ title: 'Couldn’t play a voice sample', detail: err instanceof Error ? err.message : 'Choose Preview to try again.' }); }
    finally { if (current()) setPreviewing(false); }
  }

  return <section className="voice-settings" aria-label="Voice settings">
    <div className="voice-settings__title"><h2>Set {bot.name}’s voice</h2><p>Voice, speed and language save for this Bot. Listen before starting a call.</p></div>
    {!options && (optionsError ? <div className="voice-settings__notice" role="alert">Voice choices couldn’t be loaded. <button type="button" className="voice-preview" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> : <p role="status">Loading voice choices…</p>)}
    {options && <>
      <VoiceField label="Voice" value={bot.voice} options={options.voices.map(voice => ({ value: voice.id, label: voice.name }))} disabled={saving} onChange={value => void save('voice', value)} hint="Choose from the voices currently available." />
      <VoiceField label="Speed" value={bot.voiceSpeed} options={options.speeds.map(speed => ({ value: speed, label: speedLabel(speed) }))} disabled={saving} onChange={value => void save('voiceSpeed', value)} />
      <VoiceField label="Language" value={bot.voiceLanguage} options={options.languages.map(language => ({ value: language.code, label: language.name }))} disabled={saving} onChange={value => void save('voiceLanguage', value)} />
    </>}
    <div className="voice-settings__sample"><div><strong>Voice sample</strong><p>Preview the selected voice without starting a call.</p></div><button type="button" className="voice-preview" onClick={() => void preview()} disabled={previewing || saving}>{previewing ? 'Playing…' : 'Preview'}</button></div>
    {error && <div className="voice-settings__notice" role="alert"><strong>{error.title}</strong><p>{error.detail}</p></div>}
    <button type="button" className={`voice-settings__call${inCall ? ' is-active' : ''}`} onClick={() => (inCall ? endCall() : startCall(bot.id))}>{inCall ? 'End voice chat' : 'Start voice chat'}</button>
  </section>;
}
