import { Page, Card } from './layout';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { SwarmMark } from './SwarmMark';
import { configApi, type JoinInfo } from '../lib/configApi';
import { WhatsAppIcon } from './WhatsAppIcon';
import '../styles/messaging.css';
import '../styles/signin-brand.css';

/** Public /join/:code page: claim an invite with your phone number, then text the line to create your account. */
export function JoinPage({ code }: { code: string | null }) {
  return <InvitePage key={code} code={code} />;
}

function InvitePage({ code }: { code: string | null }) {
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // MF-051: a signed-in visitor goes back to the app, not to a sign-in page.
  const submitting = useRef(false);

  useEffect(() => {
    if (code === null) return;
    let current = true;
    setLoadError(null);
    configApi.joinInfo(code).then(result => { if (current) setInfo(result); }).catch(e => { if (current) setLoadError((e as Error).message); });
    return () => { current = false; };
  }, [code, attempt]);

  const claim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code === null || submitting.current) return;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) { setError('Enter your full number with country code, like +1 415 555 0123.'); return; }
    submitting.current = true;
    setBusy(true); setError(null);
    try { await configApi.claimInvite(code, phone.trim()); setClaimed(true); }
    catch (err) { setError((err as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  };

  let body: React.ReactNode;
  if (code === null) {
    body = <><h1 className="join__title">Invite unavailable</h1><p className="join__pitch">Ask for a new invitation.</p></>;
  } else if (loadError) {
    body = <><h1 className="join__title">Something went wrong</h1><div className="card__error join__error" role="alert">{loadError}</div><button className="btn btn--primary" type="button" onClick={() => setAttempt(value => value + 1)}>Retry invitation</button></>;
  } else if (!info) {
    body = <p className="join__pitch" role="status">Loading invitation...</p>;
  } else if (!info.valid || !info.line) {
    body = (
      <>
        <h1 className="join__title">Invite unavailable</h1>
        <p className="join__pitch">{info.reason ?? 'This invite has expired or has been used up.'}</p>
      </>
    );
  } else if (!claimed) {
    body = (
      <>
        <h1 className="join__title">Join Swarm</h1>
        {info.inviter && <p className="join__by">by {info.inviter}</p>}
        <h2 className="join__section-title">Your invitation</h2>
        <form className="join__form" onSubmit={claim}>
          <label htmlFor="join-phone">Phone number</label>
          <input id="join-phone" className="text-input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setError(null); }} aria-describedby="join-phone-hint" aria-invalid={!!error} disabled={busy} />
          <span className="join__hint" id="join-phone-hint">Include the country code.</span>
          {error && <div className="card__error join__error" role="alert">{error}</div>}
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Saving...' : 'Continue'}</button>
        </form>
      </>
    );
  } else {
    body = (
      <>
        <h1 className="join__title">One last step</h1>
        <p className="join__pitch">Send the prefilled text from the number you entered.</p>
        <div className="join__claimed"><strong>Invited number</strong><span>{phone.trim()}</span><span>Claimed</span></div>
        {info.line.whatsapp?.messageLink
          ? <a className="btn btn--primary join__text-btn" href={info.line.whatsapp.messageLink}><WhatsAppIcon size={20} /> Open WhatsApp</a>
          : <a className="btn btn--primary join__text-btn" href={info.line.smsLink}>Text Swarm</a>}
        <div className="join__panel"><strong>On a computer?</strong><p className="join__copy">Scan with your phone's camera to open {info.line.whatsapp?.messageLink ? 'WhatsApp' : 'Messages'}.</p>
          <img className="msg-qr join__qr" src={info.line.whatsapp?.qr ?? info.line.qr} alt={`QR code to message Swarm on ${info.line.whatsapp?.messageLink ? 'WhatsApp' : 'Messages'}`} width={148} height={148} />
        </div>
        <div className="join__panel join__number"><strong>Manual fallback · send to {info.line.number}</strong><code>{info.line.connectCommand}</code></div>
        <div className="join__panel join__panel--hint"><strong>No reply after a minute?</strong><p>Send "hi" in the same thread.</p></div>
      </>
    );
  }

  return (
    <div className="join access-invite">
      <header className="join__bar"><a href="/" aria-label="Back"><ChevronLeft size={18} aria-hidden /><span>Back</span></a><SwarmMark size={24} /><span>Swarm</span></header>
      <main><Page type="form"><Card className="join__card">
        {body}

      </Card></Page></main>
    </div>
  );
}
