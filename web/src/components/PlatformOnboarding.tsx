import { useEffect, useState } from 'react';
import { AuthButton } from './AuthButton';
import '../styles/platform-onboarding.css';

const states: Record<string, [string, string]> = {
  invite_accepted: ['Invite accepted', 'Continue below to create your Swarm account. Your place is confirmed when sign-in finishes.'],
  invite_needed: ['Swarm is invite only right now', 'Have an invite? Open your invite link, then continue below. You can also join the waitlist.'],
  invite_invalid: ['This invite has expired or been used up', 'Ask for a new invite or join the waitlist.'],
  at_capacity: ['Swarm is at capacity right now', 'All current places are taken. Join the waitlist for the next opening.'],
  closed: ['New accounts are paused right now', 'Join the waitlist and an operator can invite you when places reopen.'],
  waitlist_joined: ['You are on the waitlist', 'Your contact details have been saved. An operator will review your request.'],
};
export function PlatformOnboarding({ invite, result }: { invite?: string; result?: string }) {
  const [state, setState] = useState(''), [contact, setContact] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/auth/onboarding${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(value => { if (value.platform === true) setState(result && ['invite_needed', 'invite_invalid', 'at_capacity', 'closed'].includes(result) ? result : value.state); else throw new Error(); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not check signup availability. Please try again.'); });
    return () => controller.abort();
  }, [invite, result, retry]);
  const copy = states[state];
  return <section className="platform-onboarding" aria-label="Signup availability">
    {copy && <div role="status"><strong>{copy[0]}</strong><p>{copy[1]}</p></div>}
    {copy && !['invite_accepted', 'waitlist_joined'].includes(state) && <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        const response = await fetch('/api/auth/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: contact.trim() }) });
        const value = await response.json();
        if (!response.ok || value.platform !== true || value.state !== 'waitlist_joined') throw new Error(value.error || 'Could not join the waitlist. Please try again.');
        setState('waitlist_joined');
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>
      <label><span>Email or phone number</span><input className="text-input" required maxLength={254} value={contact} onChange={event => setContact(event.target.value)} placeholder="Email or +15550000000" /></label>
      <AuthButton type="submit" disabled={busy}>{busy ? 'Joining...' : 'Join waitlist'}</AuthButton>
    </form>}
    {copy && state !== 'invite_accepted' && <p>Already have an account? Sign in below as usual.</p>}
    {error && <p role="alert">{error}</p>}
    {error && !copy && <AuthButton type="button" onClick={() => { setError(''); setRetry(n => n + 1); }}>Try again</AuthButton>}
  </section>;
}
