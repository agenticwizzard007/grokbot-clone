import { useEffect, useState } from 'react';
import { configApi, type MessagingInvite, type PlatformSignupPolicy, type PlatformWaitlistEntry } from '../../lib/configApi';
import { shortDate } from './ui';

/** Platform administration is discovered independently of tenant server ownership. */
export function PlatformSignupSettings({ version }: { version: number }) {
  const [policy, setPolicy] = useState<PlatformSignupPolicy | null>(null);
  const [invites, setInvites] = useState<MessagingInvite[]>([]);
  const [waiting, setWaiting] = useState<PlatformWaitlistEntry[]>([]);
  const [inviteCursor, setInviteCursor] = useState<string | null>(null);
  const [waitCursor, setWaitCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteUses, setInviteUses] = useState('1');
  const [inviteDays, setInviteDays] = useState('7');
  async function loadInvites(more = false) {
    const page = await configApi.platformInvites(more ? inviteCursor ?? '' : '');
    setInvites(previous => more ? [...previous, ...page.invites] : page.invites); setInviteCursor(page.next);
  }
  async function loadWaitlist(more = false) {
    const page = await configApi.platformWaitlist(more ? waitCursor ?? '' : '');
    setWaiting(previous => more ? [...previous, ...page.waitlist] : page.waitlist); setWaitCursor(page.next);
  }
  useEffect(() => {
    let live = true;
    void configApi.platformSignup().then(async result => {
      if (!live) return;
      if (!result.admin || !result.settings) { setPolicy(null); return; }
      setPolicy(result.settings);
      const [i, w] = await Promise.all([configApi.platformInvites(), configApi.platformWaitlist()]);
      if (!live) return;
      setInvites(i.invites); setInviteCursor(i.next); setWaiting(w.waitlist); setWaitCursor(w.next);
    }).catch(() => { if (live) setPolicy(null); });
    return () => { live = false; };
  }, [version]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!policy) return null;
  return <>
    <section className="cfg-section">
      <div className="cfg-section__label">Signup administration</div>
      <div className="cfg-card cfg-key">
        <form className="cfg-key__form" onSubmit={e => { e.preventDefault(); void act(async () => { setPolicy((await configApi.savePlatformSignup(policy)).settings); }); }}>
          <label className="cfg-field"><span className="cfg-field__label">Who can join by phone</span>
            <select className="text-input" value={policy.mode} onChange={e => setPolicy({ ...policy, mode: e.target.value as PlatformSignupPolicy['mode'] })} disabled={busy}>
              <option value="invite">Invitations and approved waitlist</option><option value="open">Open</option><option value="closed">Closed</option>
            </select>
          </label>
          <label className="cfg-field"><span className="cfg-field__label">New phone accounts per day</span>
            <input className="text-input" type="number" min="0" max="100000" required value={policy.signupsPerDay} onChange={e => setPolicy({ ...policy, signupsPerDay: e.target.valueAsNumber })} disabled={busy} />
            <span className="cfg-field__hint">0 removes the daily signup limit.</span>
          </label>
          <label className="cfg-field"><span className="cfg-field__label">Invitations per member</span>
            <input className="text-input" type="number" min="0" max="1000" required value={policy.memberInvites} onChange={e => setPolicy({ ...policy, memberInvites: e.target.valueAsNumber })} disabled={busy} />
          </label>
          <button className="cfg-btn cfg-btn--primary" disabled={busy}>Save signup settings</button>
        </form>
        {error && <p className="cfg-key__err" role="alert">{error}</p>}
      </div>
    </section>
    <section className="cfg-section">
      <div className="cfg-section__label">Invitations</div>
      <div className="cfg-card">
        <form className="msg-invite-form" onSubmit={e => { e.preventDefault(); void act(async () => {
          await configApi.createInvite({ maxUses: Number(inviteUses), expiresInDays: Number(inviteDays) }); await loadInvites();
        }); }}>
          <label className="cfg-field"><span className="cfg-field__label">Uses</span><input className="text-input" type="number" min="1" max="100000" required value={inviteUses} onChange={e => setInviteUses(e.target.value)} disabled={busy} /></label>
          <label className="cfg-field"><span className="cfg-field__label">Expires in days</span><input className="text-input" type="number" min="1" max="365" required value={inviteDays} onChange={e => setInviteDays(e.target.value)} disabled={busy} /></label>
          <button className="cfg-btn cfg-btn--primary" disabled={busy}>Create invite</button>
        </form>
        {invites.map(invite => <div className="cfg-row" key={invite.code}>
          <div className="cfg-row__text"><div className="cfg-row__title"><a href={invite.url}>{invite.code}</a></div><div className="cfg-row__sub">{invite.uses} of {invite.maxUses} used · {invite.revoked ? 'Revoked' : invite.expiresAt ? `Expires ${shortDate(invite.expiresAt)}` : 'No expiry'}</div></div>
          {!invite.revoked && <button className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void act(async () => { await configApi.revokeInvite(invite.code); await loadInvites(); })}>Revoke</button>}
        </div>)}
        {inviteCursor && <button className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void act(() => loadInvites(true))}>Load more invites</button>}
      </div>
    </section>
    <section className="cfg-section">
      <div className="cfg-section__label">Waitlist</div>
      <p className="cfg-field__hint">Approval lets this number join when they next verify their phone or message Swarm. Closing signups pauses all new phone accounts.</p>
      <div className="cfg-card">
        {!waiting.length && <div className="cfg-empty cfg-empty--flat">Nobody is waiting.</div>}
        {waiting.map(row => <div className="cfg-row" key={row.phone}>
          <div className="cfg-row__text"><div className="cfg-row__title">+{row.phone}</div><div className="cfg-row__sub">{row.channel} · {row.status} · {shortDate(row.createdAt)}</div></div>
          {row.status !== 'approved' && <button className="cfg-btn cfg-btn--primary" disabled={busy} onClick={() => void act(async () => { await configApi.decidePlatformWaitlist(row.phone, row.revision, 'approve'); await loadWaitlist(); })}>Approve</button>}
          {row.status !== 'declined' && <button className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void act(async () => { await configApi.decidePlatformWaitlist(row.phone, row.revision, 'decline'); await loadWaitlist(); })}>Decline</button>}
        </div>)}
        {waitCursor && <button className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void act(() => loadWaitlist(true))}>Load more people</button>}
      </div>
    </section>
  </>;
}
