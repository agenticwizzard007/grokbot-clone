import { useEffect, useState } from 'react';
import { BotAvatar } from '../avatar/BotAvatar';
import { configApi, type JoinInfo } from '../lib/configApi';
import '../styles/messaging.css';

/** Public /join/:code page: claim an invite with your phone number, then text the line to create your account. */
export function JoinPage({ code }: { code: string }) {
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    configApi.joinInfo(code).then(setInfo).catch((e) => setLoadError((e as Error).message));
  }, [code]);

  const claim = async (e: React.FormEvent) => {
    e.preventDefault();
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) { setError('Enter your full number with country code, like +1 415 555 0123.'); return; }
    setBusy(true); setError(null);
    try { await configApi.claimInvite(code, phone.trim()); setClaimed(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  let body: React.ReactNode;
  if (loadError) {
    body = <><h1 className="join__title">Something went wrong</h1><div className="card__error join__error">{loadError}</div></>;
  } else if (!info) {
    body = <p className="join__pitch">Loading…</p>;
  } else if (!info.valid || !info.line) {
    body = (
      <>
        <h1 className="join__title">This invite can’t be used</h1>
        <p className="join__pitch">{info.reason ?? 'This invite has expired or has been used up.'}</p>
        <a className="btn btn--secondary" href="/">Go to Swarm</a>
      </>
    );
  } else if (!claimed) {
    body = (
      <>
        <h1 className="join__title">You’re invited to Swarm</h1>
        {info.inviter && <p className="join__by">by {info.inviter}</p>}
        <p className="join__pitch">Your own team of AI Bots you run by text.</p>
        <form className="join__form" onSubmit={claim}>
          <input className="text-input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 415 555 0123" value={phone} onChange={(e) => { setPhone(e.target.value); setError(null); }} aria-label="Your phone number" />
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
        </form>
        <div className="join__hint">Use the number you’ll text from. It’s only used for your account.</div>
        {error && <div className="card__error join__error">{error}</div>}
      </>
    );
  } else {
    body = (
      <>
        <h1 className="join__title">One last step</h1>
        <p className="join__pitch">Tap below and send the message as is. Quinn, your first Bot, texts you back within a few seconds.</p>
        <a className="btn btn--primary join__text-btn" href={info.line.smsLink}>Text Swarm</a>
        <img className="msg-qr join__qr" src={info.line.qr} alt={`QR code to text ${info.line.number}`} width={180} height={180} />
        <div className="join__qr-label">On a computer? Scan with your phone’s camera.</div>
        <div className="join__number">Or text <code>{info.line.connectCommand}</code> to <code>{info.line.number}</code></div>
        <div className="join__hint">No reply after a minute? Send “hi” in the same thread.</div>
      </>
    );
  }

  return (
    <div className="join">
      <div className="join__card">
        <div className="join__hero"><BotAvatar shape="blob" color="black" size={72} /></div>
        {body}
        <p className="join__foot">Already have an account? <a href="/">Sign in</a></p>
      </div>
    </div>
  );
}
