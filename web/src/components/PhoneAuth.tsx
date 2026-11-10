import { useState } from 'react';
import { ApiError } from '../lib/api';
import { configApi, type MessagingStatus, type PhoneStart } from '../lib/configApi';
import '../styles/messaging.css';

const prettyNumber = (n: string) => n.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 ($1) $2-$3');

/**
 * Continue with your phone number. A 6-digit code reaches the phone: texted right away when the number already
 * reaches Swarm, otherwise after the person texts the line (one tap opens Messages with the connect text).
 * mode 'signin': verifying signs in, or creates the account. mode 'attach': connects the number to this account.
 */
export function PhoneAuth({ mode, onAttached }: { mode: 'signin' | 'attach'; onAttached?: (s: MessagingStatus) => void }) {
  const [phone, setPhone] = useState('');
  const [start, setStart] = useState<PhoneStart | null>(null);
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const [needInvite, setNeedInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.replace(/\D/g, '').length < 8) { setError('Enter your full number with country code, like +1 415 555 0123.'); return; }
    setBusy(true); setError(null);
    try { setStart(await (mode === 'signin' ? configApi.phoneStart(phone.trim()) : configApi.phoneAttachStart(phone.trim()))); setCode(''); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!start) return;
    if (code.replace(/\D/g, '').length !== 6) { setError('Enter the 6-digit code.'); return; }
    setBusy(true); setError(null);
    try {
      if (mode === 'signin') {
        await configApi.phoneVerify(start.id, code, needInvite ? invite.trim() : undefined);
        window.location.href = '/';
        return;
      }
      onAttached?.(await configApi.phoneAttachVerify(start.id, code));
      setStart(null); setPhone(''); setCode('');
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof ApiError && err.status === 403 && /invite/i.test(msg)) setNeedInvite(true);
      setError(msg);
    } finally { setBusy(false); }
  };

  if (!start) {
    return (
      <form className="phone-auth" onSubmit={begin}>
        <input className="text-input phone-auth__input" type="tel" inputMode="tel" autoComplete="tel" placeholder="Phone number, like +1 415 555 0123" value={phone} onChange={(e) => { setPhone(e.target.value); setError(null); }} aria-label="Phone number" />
        <button type="submit" className="btn btn--primary phone-auth__btn" disabled={busy}>{busy ? 'One moment…' : mode === 'signin' ? 'Continue with phone' : 'Send me a code'}</button>
        {error && <div className="card__error phone-auth__error">{error}</div>}
        {mode === 'signin' && <div className="phone-auth__hint">New here? This creates your account. You can add an email later.</div>}
      </form>
    );
  }

  return (
    <form className="phone-auth" onSubmit={verify}>
      <div className="phone-auth__title">Enter the code we text you</div>
      <input className="text-input phone-auth__input phone-auth__code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" value={code} onChange={(e) => { setCode(e.target.value.replace(/[^\d]/g, '')); setError(null); }} aria-label="6-digit code" autoFocus />
      {needInvite && (
        <input className="text-input phone-auth__input" placeholder="Invite code" value={invite} onChange={(e) => { setInvite(e.target.value.toUpperCase()); setError(null); }} aria-label="Invite code" />
      )}
      <button type="submit" className="btn btn--primary phone-auth__btn" disabled={busy}>{busy ? 'Checking…' : mode === 'signin' ? 'Continue' : 'Connect this number'}</button>
      {error && <div className="card__error phone-auth__error">{error}</div>}
      {start.line && (
        <div className="phone-auth__help">
          <div><b>No text yet?</b> Your number isn't connected to Swarm. Tap below to send the prefilled message, and we'll text your code right back.</div>
          <a className="btn btn--secondary phone-auth__btn" href={start.line.smsLink}>Open Messages</a>
          <div className="phone-auth__small">Or text <code>{start.line.connectCommand}</code> to <code>{prettyNumber(start.line.number)}</code>. If the code doesn't come in a few seconds, send “hi” in that thread.</div>
        </div>
      )}
      <button type="button" className="phone-auth__link" onClick={() => { setStart(null); setError(null); setNeedInvite(false); }}>Use a different number</button>
    </form>
  );
}
