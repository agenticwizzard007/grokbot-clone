import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { useStore } from '../store';
import { callLevels, endCall, startCall, toggleMute, useVoice } from '../voice/call';

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** In-call bar shown above the composer while a voice call is connecting, live, or just failed. */
export function VoiceCallBar() {
  useEffect(() => () => endCall(), []);
  const v = useVoice();
  const bot = useStore((s) => s.bots.find((b) => b.id === v.botId));
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  const avatarRef = useRef<HTMLSpanElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const active = v.status === 'connecting' || v.status === 'live';
  useEffect(() => { setExpanded(false); }, [v.callId, v.botId]);

  useEffect(() => {
    if (v.status !== 'live') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [v.status]);

  // Drive the speaking animation from the output level without re-rendering React every frame.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let out = 0;
    let mic = 0;
    const tick = () => {
      const l = callLevels();
      out = out * 0.7 + l.out * 0.3;
      mic = mic * 0.7 + Math.min(1, l.mic * 3) * 0.3;
      const el = avatarRef.current;
      if (el) { el.style.setProperty('--out', out.toFixed(3)); el.style.setProperty('--mic', mic.toFixed(3)); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useLayoutEffect(() => {
    if (expanded && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [expanded, v.captions]);

  if (v.status === 'idle' || v.status === 'ending' || !bot) return null;

  const working = v.working.length > 0;
  const status =
    v.status === 'connecting' ? v.waitingForMic ? 'Waiting for microphone permission' : 'Connecting…'
    : v.status === 'error' ? v.error ?? 'Call ended'
    : v.speaking ? 'Speaking'
    : v.listening ? 'Listening'
    : working ? 'Working on it…'
    : v.thinking ? 'Thinking…'
    : v.muted ? 'Muted'
    : 'Listening';
  const lines = v.captions.filter((c) => c.text.trim());
  const last = lines.slice(-1);

  return (
    <div
      className={`vcall is-${v.status}${v.speaking ? ' is-speaking' : ''}${v.listening ? ' is-listening' : ''}${working ? ' is-working' : ''}`}
      style={botVars(bot.avatarColor)}
      role="region"
      aria-label={`Voice call with ${bot.name}`}
    >
      <div className="vcall__main">
        <span className="vcall__avatar" ref={avatarRef}>
          <span className="vcall__halo" aria-hidden />
          <BotAvatarFor bot={bot} size={36} />
        </span>
        <div className="vcall__info">
          <div className="vcall__title">
            <span className="vcall__name">{bot.name}</span>
          </div>
          <div className={`vcall__status${working && !v.speaking && !v.listening ? ' vcall__shimmer' : ''}`} aria-live="polite">
            {v.status === 'live' && v.startedAt && <span className="vcall__time">{fmt(now - v.startedAt)} · </span>}{status}
          </div>
        </div>
        <div className="vcall__actions">
          {v.status === 'error' && <button type="button" className="vcall__btn" onClick={() => startCall(bot.id)}>Retry</button>}
          {active && (
            <button type="button" className={`vcall__btn${v.muted ? ' is-on' : ''}`} onClick={toggleMute} aria-pressed={v.muted} aria-label={v.muted ? 'Unmute' : 'Mute'} title={v.muted ? 'Unmute' : 'Mute'}>
              {v.muted ? 'Unmute' : 'Mute'}
            </button>
          )}
          {active ? (
            <button type="button" className="vcall__btn vcall__btn--end" onClick={endCall} aria-label="End call" title="End call">
              End
            </button>
          ) : (
            <button type="button" className="vcall__btn" onClick={endCall}>Dismiss</button>
          )}
        </div>
      </div>
      {v.status === 'live' && (
        expanded ? (
          <div className="vcall__transcript">
            <div className="vcall__log" ref={logRef}>
              <h2>Transcript</h2>
              {lines.length ? lines.map((c) => (
                <div key={c.id} className={`vcall__line is-${c.role}`}><b>{c.role === 'user' ? 'You' : bot.name}</b> {c.text}</div>
              )) : <div className="vcall__line is-empty">Nothing said yet.</div>}
            </div>
            <button type="button" className="vcall__toggle" onClick={() => setExpanded(false)}>Hide transcript</button>
          </div>
        ) : (
          <button type="button" className="vcall__captions" onClick={() => setExpanded(true)} aria-label="Show transcript">
            {last.length ? last.map((c) => (
              <span key={c.id} className={`vcall__caption is-${c.role}${c.final ? '' : ' is-partial'}`}>{c.text}</span>
            )) : <span className="vcall__caption is-empty">{v.muted ? 'You’re muted.' : `Say hi to ${bot.name}.`}</span>}
            <span className="vcall__captions-label" aria-hidden>Show transcript</span>
          </button>
        )
      )}
    </div>
  );
}
