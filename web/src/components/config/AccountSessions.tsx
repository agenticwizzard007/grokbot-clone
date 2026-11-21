import { useEffect, useRef, useState } from 'react';
import { accessApi, verifyAccessAccount, type AccountSession } from '../../lib/accessApi';
import { ApiError } from '../../lib/api';
import { useStore } from '../../store';

function sessionDate(value: string | number | null) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function AccountSessions({ accountId }: { accountId: string }) {
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState<AccountSession | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const acting = useRef(false);
  const current = () => alive.current && useStore.getState().user?.id === accountId;

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    setLoading(true); setLoadError(''); setSessions([]);
    void (async () => {
      await verifyAccessAccount(accountId, controller.signal);
      const { sessions: own } = await accessApi.sessions(controller.signal);
      await verifyAccessAccount(accountId, controller.signal);
      return own.sort((first, next) => Number(next.current) - Number(first.current) || (sessionDate(next.last_seen_at)?.getTime() ?? 0) - (sessionDate(first.last_seen_at)?.getTime() ?? 0));
    })().then(own => { if (current() && !controller.signal.aborted) setSessions(own); })
      .catch(err => { if (current() && !controller.signal.aborted) setLoadError(err instanceof Error ? err.message : 'Couldn’t load sessions.'); })
      .finally(() => { if (current() && !controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, [accountId, refresh]);

  async function revoke() {
    if (!confirming || acting.current || !current()) return;
    const target = confirming;
    acting.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await verifyAccessAccount(accountId);
      if (!current()) return;
      const { revokedCurrent } = await accessApi.revokeSession(target.id);
      if (revokedCurrent && useStore.getState().user?.id === accountId) {
        window.location.replace('/');
        return;
      }
      if (!current()) return;
      setConfirming(null); setNotice('Session signed out.'); setRefresh(value => value + 1);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 404) {
        setConfirming(null); setRefresh(value => value + 1);
      }
      setError(err instanceof Error ? err.message : 'Couldn’t sign out this session.');
    } finally {
      acting.current = false;
      if (current()) setBusy(false);
    }
  }

  return <section className="cfg-section account-sessions" aria-labelledby="account-sessions-title">
    <h2 id="account-sessions-title" className="cfg-section__label">Signed-in sessions</h2>
    <p className="access-section-note">Review where this account is signed in. Sign out of a session to end its access.</p>
    {loading && <p className="cfg-empty" role="status">Loading sessions…</p>}
    {loadError && <><p className="cfg-error" role="alert">{loadError}</p><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setRefresh(value => value + 1)}>Try again</button></>}
    {!loading && !loadError && !sessions.length && <p className="cfg-empty">No active sessions were reported.</p>}
    {!!sessions.length && <div className="cfg-card">
      {sessions.map(session => {
        const confirmingThis = confirming?.id === session.id;
        const dates = [ ['Signed in', session.created_at], ['Last active', session.last_seen_at], ['Expires', session.expires_at] ] as const;
        return <div className="cfg-row account-session" key={session.id}>
          <div className="cfg-row__text">
            <div className="cfg-row__title">{session.current ? 'Current session' : session.device || 'Other session'}</div>
            {session.current && session.device && <div className="cfg-row__sub">{session.device}</div>}
            <dl className="account-session__dates">
              {dates.map(([label, value]) => {
                const date = sessionDate(value);
                return date && <div key={label}><dt>{label}</dt><dd><time dateTime={date.toISOString()}>{date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></dd></div>;
              })}
            </dl>
            {confirmingThis && <div className="cfg-row__sub">{session.current ? 'You’ll return to sign-in on this device.' : 'That device will need to sign in again.'}</div>}
          </div>
          <div className="access-row-actions">
            {confirmingThis ? <>
              <button type="button" className="cfg-btn cfg-btn--danger" disabled={busy} onClick={() => void revoke()}>{busy ? 'Signing out…' : 'Confirm sign-out'}</button>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
            </> : <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => { setConfirming(session); setError(''); setNotice(''); }}>{session.current ? 'Sign out here' : 'Sign out session'}</button>}
          </div>
        </div>;
      })}
    </div>}
    {error && <p className="cfg-error" role="alert">{error}</p>}
    {notice && <p className="access-section-note" role="status">{notice}</p>}
  </section>;
}
