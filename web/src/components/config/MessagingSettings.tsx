import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  configApi,
  type MessagingCode,
  type MessagingInvite,
  type MessagingLink,
  type MessagingOwner,
  type MessagingStatus,
  type InkboxWhatsAppInfo,
  type InkboxProfile,
  type SignupMode,
  type VoiceReplies,
  type WaitlistEntry,
} from '../../lib/configApi';
import { api, openPopup } from '../../lib/api';
import { relativeShort } from '../../lib/time';
import { PhoneAuth } from '../PhoneAuth';
import { WhatsAppIcon } from '../WhatsAppIcon';
import { useVersion } from '../../configStore';
import { useStore } from '../../store';
import { ConfirmButton, Segmented, Switch, shortDate } from './ui';
import '../../styles/messaging.css';

/** Settings → Messaging: run your Bots by iMessage, SMS or WhatsApp through the server's Inkbox line. */

const fmtPhone = (p: string | null | undefined) => (p ? (p.startsWith('+') ? p : `+${p}`) : '');
const ago = (ts: number) => {
  const r = relativeShort(ts);
  return r === 'now' ? 'just now' : /^\d/.test(r) ? `${r} ago` : r.toLowerCase();
};
const statusDot = (s: MessagingLink['status']) => (s === 'connected' ? 'on' : s === 'pairing' ? 'busy' : 'off');
const statusText: Record<MessagingLink['status'], string> = { connected: 'Connected', pairing: 'Connecting', disconnected: 'Disconnected', logged_out: 'Signed out', error: 'Error' };

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1600); return () => clearTimeout(t); }, [done]);
  return (
    <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { navigator.clipboard.writeText(text).then(() => setDone(true), () => {}); }}>
      {done ? 'Copied' : label}
    </button>
  );
}

function Note({ note }: { note: { tone: 'ok' | 'error'; text: string } | null }) {
  if (!note) return null;
  return <span className={note.tone === 'error' ? 'cfg-key__err' : 'cfg-key__ok'} role="status">{note.text}</span>;
}

type NoteState = { tone: 'ok' | 'error'; text: string } | null;

export function MessagingSettings() {
  const version = useVersion('messaging');
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<MessagingCode | null>(null);

  const load = useCallback(() => {
    configApi.messaging().then((s) => { setStatus(s); setError(null); }).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => { load(); }, [load, version]);

  // While a link code is on screen, check every few seconds in case the event is missed.
  useEffect(() => {
    if (!code) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [code, load]);
  useEffect(() => { if (status?.links.length) setCode(null); }, [status?.links.length]);

  const head = <PageHead title="Messaging" sub="Run your Bots by iMessage, SMS or WhatsApp. Text them like a friend, get their updates and approvals on your phone." />;
  if (error && !status) return <>{head}<div className="cfg-error">{error}</div></>;
  if (!status) return <>{head}<div className="cfg-empty cfg-empty--flat">Loading…</div></>;

  return (
    <>
      {head}
      <PhoneSection status={status} setStatus={setStatus} code={code} setCode={setCode} />
      <AccountSection status={status} setStatus={setStatus} />
      {status.links.length > 0 && <PrefsSection status={status} setStatus={setStatus} />}
      {status.line && <InviteFriendsSection allowance={status.invites.allowance} />}
      {status.line && <CommandsSection />}
      {status.owner && <OwnerSections owner={status.owner} status={status} setStatus={setStatus} version={version} />}
    </>
  );
}

type SectionProps = { status: MessagingStatus; setStatus: (s: MessagingStatus) => void };

function LinkCodePanel({ code }: { code: MessagingCode }) {
  const qr = code.whatsapp?.qr ?? code.qr;
  const qrAlt = code.whatsapp?.qr ? 'QR code to message Swarm on WhatsApp' : `QR code to text ${code.number}`;
  const whatsappLink = code.whatsapp?.number
    ? `https://wa.me/${code.whatsapp.number.replace(/\D/g, '')}?text=${encodeURIComponent(code.connectCommand)}`
    : code.whatsapp?.messageLink;
  return (
    <div className="msg-connect">
      <img className="msg-qr" src={qr} alt={qrAlt} width={148} height={148} />
      <ol className="msg-steps">
        <li>
          <div>Send <code className="msg-inline-code">{code.connectCommand}</code> to <b>{code.number}</b>.</div>
          <div className="msg-steps__actions">
            {whatsappLink && <a className="cfg-btn cfg-btn--whatsapp" href={whatsappLink}><WhatsAppIcon /> Connect WhatsApp</a>}
            <a className="cfg-btn cfg-btn--secondary" href={code.smsLink}>Open Messages</a>
            <CopyButton text={code.number} label="Copy number" />
          </div>
          <div className="cfg-field__hint">On a computer? Scan the code with your phone’s camera, then send the link code below.</div>
        </li>
        <li>
          <div>Then send <code className="msg-inline-code">LINK {code.code}</code></div>
          <div className="cfg-field__hint">The code works for 15 minutes. This page updates once your phone is connected.</div>
        </li>
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your phone

function PhoneSection({ status, setStatus, code, setCode }: SectionProps & { code: MessagingCode | null; setCode: (c: MessagingCode | null) => void }) {
  const [busy, setBusy] = useState<'code' | 'test' | null>(null);
  const [note, setNote] = useState<NoteState>(null);
  const hasWhatsApp = status.links.some((l) => l.channel === 'whatsapp');
  const canConnectWhatsApp = !!status.line?.whatsapp?.messageLink;

  const connect = async () => {
    setBusy('code'); setNote(null);
    try { setCode(await configApi.messagingCode()); } catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test'); setNote(null);
    try { await configApi.messagingTest(); setNote({ tone: 'ok', text: 'Sent. Check your phone.' }); } catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(null); }
  };
  const unlink = async (l: MessagingLink) => {
    setNote(null);
    try { setStatus(await configApi.messagingUnlink(l.channel)); } catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
  };

  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Your phone</div>
      {status.links.length > 0 ? (
        <div className="cfg-card">
          {status.links.map((l) => (
            <div key={l.channel} className="cfg-row">
              <span className={`computer-status-dot is-${statusDot(l.status)}`} aria-hidden />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{l.channelName}{l.phone ? ` · ${fmtPhone(l.phone)}` : ''} · {statusText[l.status]}</div>
                <div className="cfg-row__sub">{l.lastInboundAt ? `Last message from you ${ago(l.lastInboundAt)}` : 'No messages from you yet'}</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Sending…' : 'Send a test'}</button>
              <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Disconnect" onConfirm={() => unlink(l)}>Disconnect</ConfirmButton>
            </div>
          ))}
          {canConnectWhatsApp && !hasWhatsApp && (
            <div className="cfg-row msg-whatsapp-row">
              <span className="msg-wa-tile"><WhatsAppIcon size={18} /></span>
              <div className="cfg-row__text">
                <div className="cfg-row__title">Connect WhatsApp</div>
                <div className="cfg-row__sub">Add WhatsApp to this account so your Bots can reply there too.</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--whatsapp" disabled={!!busy} onClick={() => void connect()}>
                <WhatsAppIcon /> {busy === 'code' ? 'Getting code...' : code ? 'Show code' : 'Connect WhatsApp'}
              </button>
            </div>
          )}
          {status.links.some((l) => l.error) && <div className="cfg-error cfg-error--inset">{status.links.find((l) => l.error)!.error}</div>}
          {code && <LinkCodePanel code={code} />}
          {note && <div className="cfg-key__foot"><Note note={note} /></div>}
        </div>
      ) : status.line ? (
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="computer-status-dot is-off" aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Not connected</div>
              <div className="cfg-row__sub">Enter your number to text your Bots at {status.line.number}. We'll text you a code.</div>
            </div>
          </div>
          {canConnectWhatsApp && (
            <div className="msg-whatsapp-cta">
              <span className="msg-wa-tile msg-wa-tile--large"><WhatsAppIcon size={22} /></span>
              <div className="msg-whatsapp-cta__text">
                <div className="cfg-row__title">Connect WhatsApp</div>
                <div className="cfg-row__sub">Fastest path: open WhatsApp, send “Say Hi Swarm”, then send the link code shown here.</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--whatsapp" disabled={!!busy} onClick={() => void connect()}>
                <WhatsAppIcon /> {busy === 'code' ? 'Getting code...' : code ? 'Refresh code' : 'Connect WhatsApp'}
              </button>
            </div>
          )}
          <div className="msg-phone-auth">
            <PhoneAuth mode="attach" onAttached={(s) => { setStatus(s); setCode(null); }} />
            <button type="button" className="phone-auth__link" disabled={!!busy} onClick={() => void connect()}>
              {busy === 'code' ? 'Getting a code…' : code ? 'New link code' : 'Or use a link code instead'}
            </button>
          </div>
          {code && <LinkCodePanel code={code} />}
          {note && <div className="cfg-key__foot"><Note note={note} /></div>}
        </div>
      ) : (
        <div className="cfg-empty">
          Texting isn’t set up on this server yet.
          {status.owner ? ' Set up the iMessage & SMS line below.' : ' Ask the person who runs this server to set it up.'}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Account

function AccountSection({ status, setStatus }: SectionProps) {
  const { account } = status;
  const googleLogin = useStore((s) => s.googleLogin);
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const setModal = useStore((s) => s.setModal);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'email' | 'gmail' | null>(null);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [note, setNote] = useState<NoteState>(null);
  const needsEmail = account.signupSource === 'text' || !account.email;
  useEffect(() => {
    let alive = true;
    setGmailConnected(null);
    configApi.connectedApps()
      .then((r) => {
        if (!alive) return;
        setGmailConnected(r.connected.includes('gmail') || !!r.connectedApps?.some((a) => a.slug === 'gmail'));
      })
      .catch(() => { if (alive) setGmailConnected(false); });
    return () => { alive = false; };
  }, [connectionsVersion]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) { setNote({ tone: 'error', text: 'Enter an email address.' }); return; }
    setBusy('email'); setNote(null);
    try { setStatus(await configApi.messagingEmail(email.trim())); setEmail(''); setNote({ tone: 'ok', text: 'Saved. Use this same email when you sign in with Google on web or desktop.' }); }
    catch (err) { setNote({ tone: 'error', text: (err as Error).message }); }
    finally { setBusy(null); }
  };
  const connectGmail = async () => {
    if (gmailConnected) { setModal('apps'); return; }
    const popup = openPopup('about:blank');
    setBusy('gmail'); setNote(null);
    try {
      const { redirectUrl } = await api.connect('gmail');
      if (popup) popup.location.href = redirectUrl; else window.open(redirectUrl, '_blank');
      setNote({ tone: 'ok', text: 'Finish the Google window. Gmail will show as connected here when it completes.' });
    } catch (err) {
      popup?.close();
      setNote({ tone: 'error', text: (err as Error).message || 'Couldn’t start Gmail connection.' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Account access</div>
      <div className="cfg-card cfg-key">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">{account.email ? 'Desktop sign-in email saved' : 'Add a desktop sign-in email'}</div>
            <div className="cfg-row__sub">
              {account.email ? `${account.email} should match the Google account you use on web or desktop.` : 'Save the Google or Gmail address you want to use when opening Swarm on desktop.'}
              {account.phone ? ` Phone: ${fmtPhone(account.phone)}.` : ''}
            </div>
          </div>
          <span className={`cfg-chip${account.email ? '' : ' cfg-chip--warn'}`}>{account.email ? 'Ready' : 'Recommended'}</span>
        </div>
        {needsEmail && (
          <>
            <form className="cfg-key__form" onSubmit={save}>
              <input className="text-input cfg-key__input msg-input" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email for sign-in" />
              <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!!busy}>{busy === 'email' ? 'Saving…' : account.email ? 'Change email' : 'Save sign-in email'}</button>
            </form>
          </>
        )}
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Gmail</div>
            <div className="cfg-row__sub">{gmailConnected ? 'Connected for Bots to read and send mail with your approval.' : 'Connect Gmail next so your Bots can help with email.'}</div>
          </div>
          <button type="button" className={gmailConnected ? 'cfg-btn cfg-btn--secondary' : 'cfg-btn cfg-btn--primary'} disabled={!!busy || !googleLogin || gmailConnected === null} onClick={() => void connectGmail()}>
            {busy === 'gmail' ? 'Opening…' : gmailConnected === null ? 'Checking…' : gmailConnected ? 'Manage Gmail' : 'Connect Gmail'}
          </button>
        </div>
        {!googleLogin && <div className="cfg-key__foot">Connected apps need a Composio project key from the server owner.</div>}
        <div className="cfg-key__foot">{note ? <Note note={note} /> : account.email ? 'Gmail connection is separate from sign-in, so Bots only get app access after you connect it.' : 'Save your Google/Gmail address first, then connect Gmail so Bots can help with mail.'}</div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How it works

function PrefsSection({ status, setStatus }: SectionProps) {
  const bots = useStore((s) => s.bots).filter((b) => b.kind !== 'room');
  const primary = bots.find((b) => b.isPrimary);
  const [note, setNote] = useState<NoteState>(null);
  const patch = async (p: { forward?: 'all' | 'engaged'; activeBotId?: string | null; voiceReplies?: VoiceReplies; ttsVoice?: string | null }) => {
    setNote(null);
    try { setStatus(await configApi.messagingPrefs(p)); setNote({ tone: 'ok', text: 'Saved.' }); }
    catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
  };
  const active = status.prefs.activeBot?.id ?? '';
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">How it works</div>
      <div className="cfg-card cfg-key">
        <div className="cfg-key__form">
          <div className="cfg-row__text"><div className="cfg-row__title">Messages go to</div><div className="cfg-row__sub">Where plain texts go. Start a text with @Name to reach another Bot.</div></div>
          <select className="text-input msg-select" value={active} onChange={(e) => void patch({ activeBotId: e.target.value || null })} aria-label="Messages go to">
            <option value="">{primary ? `${primary.name} (primary)` : 'Primary Bot'}</option>
            {bots.filter((b) => !b.isPrimary).map((b) => <option key={b.id} value={b.id}>{b.name}{b.label ? ` · ${b.label}` : ''}</option>)}
            {status.prefs.activeBot && !bots.some((b) => b.id === status.prefs.activeBot!.id) && <option value={status.prefs.activeBot.id}>{status.prefs.activeBot.name}</option>}
          </select>
        </div>
        <div className="cfg-key__form">
          <div className="cfg-row__text"><div className="cfg-row__title">Send me</div><div className="cfg-row__sub">Bot replies, approvals and questions that reach your phone.</div></div>
          <Segmented label="Send me" value={status.prefs.forward} onChange={(v) => void patch({ forward: v })}
            options={[{ value: 'all', label: 'Every Bot’s updates' }, { value: 'engaged', label: 'Only Bots I message by text' }]} />
        </div>
        <VoiceRepliesRow status={status} patch={patch} />
        {note && <div className="cfg-key__foot"><Note note={note} /></div>}
      </div>
    </section>
  );
}

/** Reply by voice: when Bots also answer with a voice note, in which voice. Text replies always arrive too. */
function VoiceRepliesRow({ status, patch }: { status: MessagingStatus; patch: (p: { voiceReplies?: VoiceReplies; ttsVoice?: string | null }) => Promise<void> }) {
  const bots = useStore((s) => s.bots);
  const primaryVoice = bots.find((b) => b.isPrimary)?.voice ?? 'luna';
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const available = !!status.speech?.speech;
  const voices = status.speech?.voices ?? [];
  const play = async () => {
    setErr(null); setPlaying(true);
    try {
      const url = URL.createObjectURL(await configApi.voiceSample(status.prefs.ttsVoice ?? primaryVoice));
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); setPlaying(false); };
      await audio.play();
    } catch (e) { setErr((e as Error).message); setPlaying(false); }
  };
  return (
    <div className="cfg-key__form msg-voice">
      <div className="cfg-row__text">
        <div className="cfg-row__title">Reply by voice</div>
        <div className="cfg-row__sub">
          {available ? `Bots also answer with a voice note on iMessage (speech by ${status.speech.speech === 'openrouter' ? 'OpenRouter' : 'custom provider'}). Text it /voice to change this from your phone.` : 'Needs an OpenRouter or custom provider key on this server.'}
          {err && <span className="msg-voice__err"> {err}</span>}
        </div>
      </div>
      <div className="msg-voice__controls">
        <Segmented label="Reply by voice" value={status.prefs.voiceReplies} onChange={(v) => void patch({ voiceReplies: v })}
          options={[{ value: 'off', label: 'Off' }, { value: 'voice-in', label: 'When I send a voice note' }, { value: 'always', label: 'Always' }]} />
        {voices.length > 0 && (
          <div className="msg-voice__pick">
            <select className="text-input msg-select" value={status.prefs.ttsVoice ?? ''} onChange={(e) => void patch({ ttsVoice: e.target.value || null })} aria-label="Voice" disabled={!available}>
              <option value="">Each Bot's own voice</option>
              {voices.map((v) => <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}
            </select>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void play()} disabled={!available || playing}>{playing ? 'Playing…' : '▶ Preview'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invite friends

function InviteFriendsSection({ allowance }: { allowance: number }) {
  const [invite, setInvite] = useState<{ url: string; remaining: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const get = async () => {
    setBusy(true); setErr(null);
    try { setInvite(await configApi.messagingMyInvite()); } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Invite friends</div>
      <div className="cfg-card cfg-key">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Share Swarm</div>
            <div className="cfg-row__sub">{allowance > 0 ? `Friends get their own Bots by text. You can invite ${allowance} ${allowance === 1 ? 'person' : 'people'}.` : 'Invites are turned off on this server.'}</div>
          </div>
          {allowance > 0 && !invite && <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={() => void get()}>{busy ? 'Getting…' : 'Get my invite link'}</button>}
        </div>
        {invite && (
          <div className="cfg-pair">
            <div className="cfg-pair__cmd"><code className="cfg-pair__code">{invite.url}</code><CopyButton text={invite.url} /></div>
            <div className="cfg-field__hint">{invite.remaining} {invite.remaining === 1 ? 'invite' : 'invites'} left.</div>
          </div>
        )}
        {err && <div className="cfg-error cfg-error--inset">{err}</div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// In your texts

const COMMANDS: [ReactNode, string][] = [
  ['Just type', 'Goes to your active Bot'],
  [<><code>@Name</code> …</>, 'Talk to a specific Bot'],
  ['Reply to a message', 'Goes to the Bot that sent it'],
  [<><code>yes K7P2</code> / <code>no K7P2</code>, or 👍 / 👎 on it</>, 'Answer an approval'],
  [<><code>1</code> / <code>2</code> / <code>3</code></>, 'Answer a Bot’s question'],
  ['Voice note or photo', 'Bots hear and see them'],
  [<><code>/bots</code> <code>/status</code> <code>/tasks</code></>, 'Your Bots, what they’re doing, their tasks'],
  [<><code>/use Name</code></>, 'Make a Bot your active Bot'],
  [<><code>/stop</code> <code>/new</code></>, 'Stop the Bot, or start a fresh conversation'],
  [<><code>/apps</code> <code>/connect gmail</code></>, 'See and connect apps'],
  [<><code>/activate Name</code></>, 'Finish setting up a new Bot'],
  [<code>/invite</code>, 'Get an invite link for a friend'],
  [<code>/web</code>, 'Get a link that signs you in here'],
  [<code>/me</code>, 'Your account'],
  [<code>/computer</code>, 'Your Bots’ computer'],
  [<code>/delete</code>, 'Delete your account'],
];

function CommandsSection() {
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">In your texts</div>
      <div className="cfg-card">
        <dl className="msg-commands">
          {COMMANDS.map(([what, does], i) => (
            <div key={i} className="msg-commands__row"><dt>{what}</dt><dd>{does}</dd></div>
          ))}
        </dl>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Owner only

function OwnerSections({ owner, status, setStatus, version }: SectionProps & { owner: MessagingOwner; version: number }) {
  return (
    <>
      <div className="msg-owner-divider"><span>Server owner</span></div>
      <InkboxSection owner={owner} status={status} setStatus={setStatus} />
      {owner.inkbox.configured && <WhatsAppSection owner={owner} />}
      {owner.inkbox.configured && <ContactCardSection />}
      <SignupSection owner={owner} setStatus={setStatus} />
      <InvitesSection version={version} />
      <WaitlistSection version={version} />
    </>
  );
}

function InkboxSection({ owner, status, setStatus }: SectionProps & { owner: MessagingOwner }) {
  const ink = owner.inkbox;
  const [key, setKey] = useState('');
  const [handle, setHandle] = useState(ink.handle);
  const [withPhone, setWithPhone] = useState(false);
  const [busy, setBusy] = useState<'key' | 'setup' | null>(null);
  const [note, setNote] = useState<NoteState>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  useEffect(() => { setHandle(ink.handle); }, [ink.handle]);

  const saveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) { setNote({ tone: 'error', text: 'Paste your Inkbox admin key first.' }); return; }
    setBusy('key'); setNote(null);
    try { setStatus(await configApi.inkboxSaveKey(key.trim())); setKey(''); setNote({ tone: 'ok', text: 'Verified and saved.' }); }
    catch (err) { setNote({ tone: 'error', text: (err as Error).message }); }
    finally { setBusy(null); }
  };
  const setup = async (rotateSigningKey = false) => {
    setBusy('setup'); setSetupError(null); setNote(null);
    try {
      const { setup: r, ...s } = await configApi.inkboxSetup({ handle: handle.trim() || undefined, withPhone, ...(rotateSigningKey ? { rotateSigningKey: true } : {}) });
      setStatus(s as MessagingStatus);
      if (r.step !== 'done') setSetupError(r.error ?? `Setup stopped at the ${r.step} step.`);
      else setNote({ tone: 'ok', text: 'Your line is ready.' });
    } catch (err) { setSetupError((err as Error).message); }
    finally { setBusy(null); }
  };
  const forget = async () => {
    setNote(null);
    try { setStatus(await configApi.inkboxForget()); } catch (err) { setNote({ tone: 'error', text: (err as Error).message }); }
  };
  const localWebhook = /^http:\/\/(localhost|127\.0\.0\.1)/.test(ink.webhookUrl);
  const inbox = ink.inbox.filter((r) => r.n > 0);

  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Inkbox line</div>
      <div className="cfg-card cfg-key">
        <div className="cfg-row">
          <span className={`computer-status-dot is-${ink.configured ? 'on' : 'off'}`} aria-hidden />
          <div className="cfg-row__text">
            <div className="cfg-row__title">Texting line · {ink.configured ? 'Set up' : ink.adminKeySet ? 'Key saved, line not set up' : 'Not set up'}</div>
            <div className="cfg-row__sub">One line for everyone on this server. People text it to reach their own Bots.</div>
          </div>
          {(ink.configured || ink.adminKeySet) && <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Forget line" onConfirm={forget}>Forget line</ConfirmButton>}
        </div>

        {ink.configured && (
          <div className="msg-facts">
            <Fact k="Handle">{ink.handle}</Fact>
            {status.line && <Fact k="Number">{status.line.number}</Fact>}
            {status.line && <Fact k="Connect command"><code className="msg-inline-code">{status.line.connectCommand}</code></Fact>}
            <Fact k="SMS">{ink.sms ? 'On' : 'Off (iMessage only)'}</Fact>
            <Fact k="WhatsApp">{ink.whatsapp ? `${ink.whatsapp.enabled ? 'On' : 'Off'}${ink.whatsapp.status ? ` · ${ink.whatsapp.status}` : ''}` : 'Unavailable'}</Fact>
            <Fact k="Inbox">{inbox.length ? inbox.map((r) => `${r.n} ${r.status}`).join(' · ') : 'Empty'}</Fact>
          </div>
        )}

        <form className="cfg-key__form" onSubmit={saveKey}>
          <input className="text-input cfg-key__input" type="password" autoComplete="off" spellCheck={false} placeholder={ink.adminKeySet ? 'Paste a new admin key to replace it' : 'Inkbox admin key'} value={key} onChange={(e) => setKey(e.target.value)} aria-label="Inkbox admin key" />
          <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!!busy}>{busy === 'key' ? 'Verifying…' : 'Verify and save'}</button>
        </form>

        {ink.adminKeySet && !ink.configured && (
          <div className="msg-setup">
            <div className="cfg-field">
              <label className="cfg-field__label" htmlFor="inkbox-handle">Handle</label>
              <input id="inkbox-handle" className="text-input msg-input" value={handle} onChange={(e) => setHandle(e.target.value)} spellCheck={false} />
              <div className="cfg-field__hint">The name of this server’s Inkbox identity.</div>
            </div>
            <div className="msg-switch-row">
              <div className="cfg-row__text"><div className="cfg-row__title">Also get a phone number for SMS</div><div className="cfg-row__sub">Without one, the line works over iMessage only.</div></div>
              <Switch on={withPhone} onChange={setWithPhone} label="Also get a phone number for SMS" />
            </div>
            <div><button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy} onClick={() => void setup()}>{busy === 'setup' ? 'Setting up…' : 'Set up line'}</button></div>
            {setupError && (
              <div className="cfg-error">
                {setupError}
                {/signing key/i.test(setupError) && (
                  <div className="msg-error-action"><button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void setup(true)}>Replace signing key</button></div>
                )}
              </div>
            )}
          </div>
        )}

        {(ink.adminKeySet || localWebhook) && (
          <div className="cfg-pair">
            <div className="cfg-pair__step">Webhook URL{ink.configured ? '' : ' (registered with Inkbox when you set up the line)'}</div>
            <div className="cfg-pair__cmd"><code className="cfg-pair__code">{ink.webhookUrl}</code><CopyButton text={ink.webhookUrl} /></div>
            {localWebhook && <div className="msg-warn">This address is only reachable from this machine, so Inkbox can’t deliver texts to it. Set SERVER_URL to this server’s public HTTPS address (for example a tunnel) and set the line up again.</div>}
          </div>
        )}

        <div className="cfg-key__foot">{note ? <Note note={note} /> : <a href="https://inkbox.ai" target="_blank" rel="noreferrer">Get a key at inkbox.ai</a>}</div>
      </div>
    </section>
  );
}

function WhatsAppSection({ owner }: { owner: MessagingOwner }) {
  const [info, setInfo] = useState<InkboxWhatsAppInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<NoteState>(null);
  const load = useCallback(async () => {
    setBusy(true); setNote(null);
    try { setInfo(await configApi.inkboxWhatsApp()); }
    catch (err) { setNote({ tone: 'error', text: (err as Error).message }); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const wa = info?.status ?? owner.inkbox.whatsapp;
  const onb = info?.onboarding ?? null;
  const ready = onb?.ready && !!onb.messageLink;

  return (
    <section className="cfg-section">
      <div className="cfg-section__label">WhatsApp</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <span className={`computer-status-dot is-${wa?.enabled ? 'on' : 'off'}`} aria-hidden />
          <div className="cfg-row__text">
            <div className="cfg-row__title">WhatsApp · {wa?.enabled ? 'Ready to test' : wa ? 'Not ready yet' : 'Not enabled'}</div>
            <div className="cfg-row__sub">Dedicated WhatsApp runs through the same Inkbox identity and webhook as iMessage.</div>
          </div>
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void load()}>{busy ? 'Checking...' : 'Refresh'}</button>
        </div>

        <div className="msg-facts">
          <Fact k="Status">{wa?.status || (wa ? 'unknown' : 'Unavailable')}</Fact>
          <Fact k="Number">{wa?.number ? fmtPhone(wa.number) : 'Not assigned'}</Fact>
          <Fact k="Webhook">Subscribed after Set up line</Fact>
        </div>

        {ready ? (
          <div className="cfg-pair">
            <div className="cfg-pair__step">Scan this QR code or open the link, then send the prefilled WhatsApp message.</div>
            <div className="msg-whatsapp-test">
              {onb.messageQrPngDataUrl && <img className="msg-qr" src={onb.messageQrPngDataUrl} alt="WhatsApp QR code for Swarm" width={148} height={148} />}
              <div className="msg-whatsapp-test__links">
                <a className="cfg-btn cfg-btn--whatsapp" href={onb.messageLink!} target="_blank" rel="noreferrer"><WhatsAppIcon /> Open WhatsApp</a>
                <CopyButton text={onb.messageLink!} label="Copy link" />
                {onb.messageText && <div className="cfg-field__hint">Prefilled message: <code className="msg-inline-code">{onb.messageText}</code></div>}
              </div>
            </div>
          </div>
        ) : (
          <div className="msg-warn">Enable Dedicated WhatsApp for this Inkbox identity, then rerun Set up line so the webhook has the WhatsApp event subscriptions.</div>
        )}

        {note && <div className="cfg-key__foot"><Note note={note} /></div>}
      </div>
    </section>
  );
}

/** The line's contact card: what people see when they connect (name, a line under Notes, and the photo). */
function ContactCardSection() {
  const [profile, setProfile] = useState<InkboxProfile | null>(null);
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [busy, setBusy] = useState<'save' | 'photo' | null>(null);
  const [note, setNote] = useState<NoteState>(null);
  const [v, setV] = useState(0);
  const apply = (p: InkboxProfile) => { setProfile(p); setName(p.displayName ?? ''); setAbout(p.description ?? ''); setV((x) => x + 1); };
  useEffect(() => { configApi.inkboxProfile().then(apply).catch((e) => setNote({ tone: 'error', text: (e as Error).message })); }, []);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('save'); setNote(null);
    try { apply(await configApi.inkboxSaveProfile({ displayName: name, description: about })); setNote({ tone: 'ok', text: 'Saved. New connections get the updated card.' }); }
    catch (err) { setNote({ tone: 'error', text: (err as Error).message }); }
    finally { setBusy(null); }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy('photo'); setNote(null);
    try { apply(await configApi.inkboxUploadAvatar(file)); setNote({ tone: 'ok', text: 'Photo updated.' }); }
    catch (err) { setNote({ tone: 'error', text: (err as Error).message }); }
    finally { setBusy(null); }
  };
  const removePhoto = async () => {
    try { apply(await configApi.inkboxDeleteAvatar()); } catch (err) { setNote({ tone: 'error', text: (err as Error).message }); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Contact card</div>
      <div className="cfg-card">
        <div className="msg-card">
          <div className="msg-card__photo">
            {profile?.hasAvatar ? <img src={`/api/messaging/inkbox/avatar?v=${v}`} alt="Line photo" width={88} height={88} /> : <div className="msg-card__ph" aria-hidden>{(name || 'G').charAt(0).toUpperCase()}</div>}
            <label className="cfg-btn cfg-btn--secondary msg-card__upload">
              {busy === 'photo' ? 'Uploading…' : profile?.hasAvatar ? 'Change photo' : 'Add photo'}
              <input type="file" accept="image/*" hidden disabled={!!busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {profile?.hasAvatar && <button type="button" className="phone-auth__link" onClick={() => void removePhoto()}>Remove</button>}
          </div>
          <form className="msg-card__fields" onSubmit={save}>
            <label className="cfg-row__title" htmlFor="line-name">Name</label>
            <input id="line-name" className="text-input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Swarm" />
            <label className="cfg-row__title" htmlFor="line-about">Notes on the card</label>
            <input id="line-about" className="text-input" maxLength={300} value={about} onChange={(e) => setAbout(e.target.value)} placeholder="Your team of AI Bots. Text to get things done." />
            <div><button type="submit" className="cfg-btn cfg-btn--primary" disabled={!!busy || !profile}>{busy === 'save' ? 'Saving…' : 'Save'}</button></div>
            <div className="cfg-field__hint">People get this card when they connect, and can save it as a contact. Inkbox crops photos to a square. Changes apply to new connections; people who saved the old card keep it.</div>
          </form>
        </div>
        {note && <div className="cfg-key__foot"><Note note={note} /></div>}
      </div>
    </section>
  );
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return <div className="msg-facts__row"><span className="msg-facts__k">{k}</span><span className="msg-facts__v">{children}</span></div>;
}

function SignupSection({ owner, setStatus }: { owner: MessagingOwner; setStatus: (s: MessagingStatus) => void }) {
  const su = owner.signup;
  const [vals, setVals] = useState({ signupsPerDay: String(su.signupsPerDay), dailyTurns: String(su.dailyTurns), memberInvites: String(su.memberInvites) });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<NoteState>(null);
  useEffect(() => { setVals({ signupsPerDay: String(su.signupsPerDay), dailyTurns: String(su.dailyTurns), memberInvites: String(su.memberInvites) }); }, [su.signupsPerDay, su.dailyTurns, su.memberInvites]);
  const put = async (p: Parameters<typeof configApi.messagingSignup>[0]) => {
    setBusy(true); setNote(null);
    try { setStatus(await configApi.messagingSignup(p)); setNote({ tone: 'ok', text: 'Saved.' }); }
    catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const n = (s: string) => Number(s);
    const bad = Object.values(vals).some((v) => v.trim() === '' || !Number.isInteger(n(v)) || n(v) < 0);
    if (bad) { setNote({ tone: 'error', text: 'Use whole numbers, 0 or more.' }); return; }
    void put({ signupsPerDay: n(vals.signupsPerDay), dailyTurns: n(vals.dailyTurns), memberInvites: n(vals.memberInvites) });
  };
  const num = (key: keyof typeof vals, label: string, hint: string) => (
    <label className="cfg-field msg-num">
      <span className="cfg-field__label">{label}</span>
      <input className="text-input" type="number" min={0} step={1} inputMode="numeric" value={vals[key]} onChange={(e) => setVals((v) => ({ ...v, [key]: e.target.value }))} />
      <span className="cfg-field__hint">{hint}</span>
    </label>
  );
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Sign-up by text</div>
      <div className="cfg-card cfg-key">
        <div className="cfg-key__form msg-pad-top">
          <div className="cfg-row__text"><div className="cfg-row__title">Who can sign up</div><div className="cfg-row__sub">{su.mode === 'invite' ? 'New numbers need an invite link, or join the waitlist for you to approve.' : su.mode === 'open' ? 'Anyone who texts the line gets an account, up to the daily limit.' : 'Nobody new can sign up by text.'}</div></div>
          <Segmented<SignupMode> label="Who can sign up" value={su.mode} onChange={(mode) => void put({ mode })}
            options={[{ value: 'invite', label: 'Invites + waitlist' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]} />
        </div>
        <form className="msg-nums" onSubmit={save}>
          {num('signupsPerDay', 'Sign-ups per day', 'New text accounts a day, all together.')}
          {num('dailyTurns', 'Messages per day', 'Per text account. 0 = no limit.')}
          {num('memberInvites', 'Invites per member', 'Links each person can share.')}
          <div className="msg-nums__save"><button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
        </form>
        {note && <div className="cfg-key__foot"><Note note={note} /></div>}
      </div>
    </section>
  );
}

function InvitesSection({ version }: { version: number }) {
  const [invites, setInvites] = useState<MessagingInvite[] | null>(null);
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const [showQr, setShowQr] = useState<string | null>(null);
  const [form, setForm] = useState({ maxUses: '1', days: '7', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { configApi.invites().then((r) => setInvites(r.invites)).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load, version]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const maxUses = Number(form.maxUses);
    const days = form.days.trim() === '' ? null : Number(form.days);
    if (!Number.isInteger(maxUses) || maxUses < 1) { setErr('Uses must be a whole number, 1 or more.'); return; }
    if (days !== null && (!Number.isFinite(days) || days <= 0)) { setErr('Leave “expires” empty for never, or enter a number of days.'); return; }
    setBusy(true); setErr(null);
    try {
      const { invite } = await configApi.createInvite({ maxUses, expiresInDays: days, note: form.note.trim() || undefined });
      setQrs((q) => ({ ...q, [invite.code]: invite.qr }));
      setShowQr(invite.code);
      setForm((f) => ({ ...f, note: '' }));
      load();
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  };
  const revoke = async (code: string) => {
    try { await configApi.revokeInvite(code); load(); } catch (e) { setErr((e as Error).message); }
  };
  const list = (invites ?? []).filter((i) => !i.revoked);

  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Invite links</div>
      <div className="cfg-card cfg-key">
        <form className="msg-invite-form" onSubmit={create}>
          <label className="cfg-field"><span className="cfg-field__label">Uses</span><input className="text-input" type="number" min={1} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} /></label>
          <label className="cfg-field"><span className="cfg-field__label">Expires in days</span><input className="text-input" type="number" min={1} placeholder="Never" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></label>
          <label className="cfg-field msg-invite-form__note"><span className="cfg-field__label">Note</span><input className="text-input" placeholder="Who it’s for (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy}>{busy ? 'Creating…' : 'Create link'}</button>
        </form>
        {err && <div className="cfg-error cfg-error--inset">{err}</div>}
        {!invites ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : list.length === 0 ? (
          <div className="cfg-empty cfg-empty--flat">No invite links yet.</div>
        ) : list.map((i) => {
          const expired = i.expiresAt !== null && i.expiresAt < Date.now();
          const used = i.uses >= i.maxUses;
          return (
            <div key={i.code} className="msg-invite">
              <div className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title msg-mono">{i.url}</div>
                  <div className="cfg-row__sub">
                    {i.uses}/{i.maxUses} used
                    {i.expiresAt ? (expired ? ' · expired' : ` · expires ${shortDate(i.expiresAt)}`) : ' · never expires'}
                    {i.createdByName ? ` · by ${i.createdByName}` : ''}
                    {i.note ? ` · ${i.note}` : ''}
                    {used && !expired ? ' · used up' : ''}
                  </div>
                </div>
                <CopyButton text={i.url} />
                {qrs[i.code] && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setShowQr(showQr === i.code ? null : i.code)}>{showQr === i.code ? 'Hide QR' : 'QR'}</button>}
                <ConfirmButton className="cfg-btn cfg-btn--ghost-danger" confirmLabel="Revoke link" onConfirm={() => revoke(i.code)}>Revoke</ConfirmButton>
              </div>
              {showQr === i.code && qrs[i.code] && <div className="msg-invite__qr"><img className="msg-qr" src={qrs[i.code]} alt={`QR code for ${i.url}`} width={148} height={148} /></div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WaitlistSection({ version }: { version: number }) {
  const [rows, setRows] = useState<WaitlistEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { configApi.waitlist().then((r) => setRows(r.waitlist)).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load, version]);
  const decide = async (phone: string, yes: boolean) => {
    setBusy(phone); setErr(null);
    try { yes ? await configApi.approveWaitlist(phone) : await configApi.declineWaitlist(phone); load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const visible = (rows ?? []).filter((r) => r.status !== 'deleted');
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Waitlist</div>
      <div className="cfg-card">
        {err && <div className="cfg-error cfg-error--inset">{err}</div>}
        {!rows ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : visible.length === 0 ? (
          <div className="cfg-empty cfg-empty--flat">Nobody is waiting. People who text the line without an invite show up here.</div>
        ) : (
          <div className="msg-table-wrap">
            <table className="msg-table">
              <thead><tr><th>Who</th><th>First message</th><th>When</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.phone}>
                    <td><div className="msg-table__name">{r.name || 'Unknown'}</div><div className="msg-table__sub">{fmtPhone(r.phone)} · {r.channel === 'imessage' ? 'iMessage' : r.channel === 'sms' ? 'SMS' : r.channel}</div></td>
                    <td className="msg-table__msg" title={r.firstMessage ?? ''}>{r.firstMessage || '—'}</td>
                    <td className="msg-table__when">{ago(r.createdAt)}</td>
                    <td><span className={`cfg-chip${r.status === 'pending' ? ' cfg-chip--warn' : ' cfg-chip--muted'}`}>{r.status[0].toUpperCase() + r.status.slice(1)}</span></td>
                    <td className="msg-table__actions">
                      {r.status === 'pending' && (
                        <>
                          <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy === r.phone} onClick={() => void decide(r.phone, true)}>Approve</button>
                          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy === r.phone} onClick={() => void decide(r.phone, false)}>Decline</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
