import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from '../../lib/toast';
import '../../styles/config.css';

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`toggle${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle__knob" />
    </button>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="cfg-field">
      <label className="cfg-field__label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="cfg-field__hint">{hint}</div>}
    </div>
  );
}

/** A small segmented control with optional per-option hints. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const tabIndex = Math.max(0, options.findIndex(option => option.value === value));
  return (
    <div className="cfg-seg" role="radiogroup" aria-label={label}>
      {options.map((o, index) => (
        <button key={o.value} ref={element => { buttons.current[index] = element; }} type="button" role="radio" aria-checked={value === o.value} tabIndex={index === tabIndex ? 0 : -1} className={value === o.value ? 'is-active' : ''} onClick={() => onChange(o.value)}
          onKeyDown={event => {
            const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
              : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
            if (!direction) return;
            event.preventDefault();
            const next = (index + direction + options.length) % options.length;
            buttons.current[next]?.focus();
            onChange(options[next].value);
          }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Button that asks "Sure?" in place before running a destructive action. The question stays until the user
 * answers it: a click elsewhere or Escape cancels, and nothing reverts on a timer (R2F-003). A failure shows an error.
 */
export function ConfirmButton({ children, confirmLabel = 'Delete', onConfirm, className = 'cfg-btn cfg-btn--ghost-danger', disabled, title }: { children: ReactNode; confirmLabel?: string; onConfirm: () => Promise<unknown> | void; className?: string; disabled?: boolean; title?: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!asking || busy) return;
    const outside = (event: PointerEvent) => { if (!button.current?.contains(event.target as Node)) setAsking(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && document.activeElement === button.current) { event.preventDefault(); event.stopPropagation(); setAsking(false); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [asking, busy]);
  if (!asking) return <button ref={button} type="button" className={className} disabled={disabled} title={title} onClick={() => setAsking(true)}>{children}</button>;
  return (
    <button
      ref={button}
      type="button"
      className="cfg-btn cfg-btn--danger"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await onConfirm(); }
        catch (failure) { toast((failure as Error)?.message || 'That did not work. Try again.', { tone: 'error' }); }
        finally { setBusy(false); setAsking(false); }
      }}
    >
      {busy ? 'Working…' : confirmLabel}
    </button>
  );
}

export function shortDate(ts: number): string {
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

/** "Next today 8:00 AM Asia/Dubai", shown in the routine's own time zone. */
export function nextRunLabel(ts: number | null, timeZone?: string): string {
  if (!ts) return '';
  let tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; }
  const dayKey = (t: number) => new Date(t).toLocaleDateString('en-US', { timeZone: tz });
  const day = new Date(ts).toLocaleDateString('en-US', { weekday: 'short', timeZone: tz });
  const time = new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  const rel = dayKey(ts) === dayKey(Date.now()) ? 'today' : dayKey(ts) === dayKey(Date.now() + 86_400_000) ? 'tomorrow' : day;
  return `Next ${rel} ${time} ${tz}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
