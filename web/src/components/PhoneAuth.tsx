import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { ApiError } from '../lib/api';
import { configApi, type MessagingStatus, type PhoneStart } from '../lib/configApi';
import { WhatsAppIcon } from './WhatsAppIcon';
import { AuthButton } from './AuthButton';
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
        const result = await configApi.phoneVerify(start.id, code, needInvite ? invite.trim() : undefined);
        window.location.href = result.created ? '/#settings/messaging' : '/';
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
        <label className="phone-auth__field">
          <span className="phone-auth__label">Phone number</span>
          <input className="text-input phone-auth__input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 415 555 0123" value={phone} onChange={(e) => { setPhone(e.target.value); setError(null); }} aria-invalid={!!error} />
        </label>
        <AuthButton type="submit" disabled={busy} aria-busy={busy} icon={<Smartphone size={20} strokeWidth={1.75} />}>{busy ? 'One moment…' : mode === 'signin' ? 'Continue with phone' : 'Send me a code'}</AuthButton>
        {error && <div className="card__error phone-auth__error" role="alert">{error}</div>}
        {mode === 'signin' && <div className="phone-auth__hint">New here? We’ll create your account.</div>}
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
      <AuthButton type="submit" disabled={busy} aria-busy={busy} icon={<Smartphone size={20} strokeWidth={1.75} />}>{busy ? 'Checking…' : mode === 'signin' ? 'Continue' : 'Connect this number'}</AuthButton>
      {error && <div className="card__error phone-auth__error" role="alert">{error}</div>}
      {start.line && (
        <div className="phone-auth__help">
          <div><b>No text yet?</b> Say Hi Swarm and we'll text your code right back.</div>
          {start.line.whatsapp?.messageLink && <a className="btn btn--secondary phone-auth__btn phone-auth__btn--whatsapp" href={start.line.whatsapp.messageLink}><WhatsAppIcon /> Open WhatsApp</a>}
          <a className="btn btn--secondary phone-auth__btn" href={start.line.smsLink}>Open Messages</a>
          <div className="phone-auth__small">WhatsApp or Messages will fill in the connection text for you. If Messages doesn't, text <code>{start.line.connectCommand}</code> to <code>{prettyNumber(start.line.number)}</code>, then send “hi” if the code doesn't arrive.</div>
        </div>
      )}
      <button type="button" className="phone-auth__link" onClick={() => { setStart(null); setError(null); setNeedInvite(false); }}>Use a different number</button>
    </form>
  );
}
