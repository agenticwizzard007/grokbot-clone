import { useEffect, useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { cancelResume, planResume, type ResumeTarget } from '../../configStore';
import { AuthLink } from '../AuthButton';
import { AppleSignIn } from '../AppleSignIn';
import { OpenRouterSignIn } from '../OpenRouterSignIn';
import { PhoneAuth } from '../PhoneAuth';
import { GoogleG } from '../SignIn';
import '../../styles/messaging.css';

/**
 * Credential changes need a Swarm sign-in from the last few minutes. The session itself is still valid,
 * so this re-runs the normal sign-in in place and returns to `resume` when a provider leaves the page.
 */
export function ReauthPrompt({ accountEmail, reason, resume, retryLabel, terminalActive, onCancel }: {
  accountEmail: string;
  reason: string;
  resume: Omit<ResumeTarget, 'expiresAt'>;
  retryLabel: string;
  terminalActive: boolean;
  onCancel: () => void;
}) {
  const devLogin = useStore((s) => s.devLogin);
  const googleLogin = useStore((s) => s.googleLogin);
  const appleLogin = useStore((s) => s.appleLogin);
  const [email, setEmail] = useState(accountEmail.endsWith('@openrouter.invalid') ? '' : accountEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Provider sign-ins and phone verification reload the app. Come back here afterwards.
  useEffect(() => {
    planResume(resume);
    return () => cancelResume();
  }, [resume.section, resume.provider, resume.accountId, resume.action]);

  const dev = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.includes('@')) { setError('Enter an email address'); return; }
    setBusy(true); setError(null);
    try {
      await api.devLogin(email.trim());
      // Reload account-scoped shell data as well as settings, including after an account switch.
      const url = new URL(window.location.href);
      url.searchParams.delete('login'); url.searchParams.delete('openrouter');
      history.replaceState(history.state, '', url.pathname + url.search + `#settings/${resume.section}`);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Try again.');
      setBusy(false);
    }
  };

  return (
    <section className="cfg-card subscription-reauth" aria-labelledby="subscription-reauth-title">
      <div className="subscription-reauth__body">
        <div className="subscription-reauth__head">
          <ShieldCheck size={20} strokeWidth={1.75} aria-hidden />
          <h3 id="subscription-reauth-title">Confirm it’s you</h3>
        </div>
        <p role="alert">{reason}</p>
        <p>Sign in again the way you usually do for <strong>{accountEmail.endsWith('@openrouter.invalid') ? 'this account' : accountEmail}</strong>. You’ll come straight back here, then choose {retryLabel} again. This request has not been applied.</p>
        {terminalActive && <p>Your current terminal stays open. Signing in again may end that terminal session.</p>}
        <div className="subscription-reauth__providers">
          <PhoneAuth mode="signin" />
          <OpenRouterSignIn label="Continue with OpenRouter" />
          {appleLogin && <AppleSignIn />}
          {googleLogin && <AuthLink className="signin__google" href="/api/auth/google/start" icon={<GoogleG />}>Sign in with Google</AuthLink>}
        </div>
        {devLogin && (
          <form className="subscription-reauth__dev" onSubmit={(event) => void dev(event)}>
            <label htmlFor="subscription-reauth-email">Dev sign-in email</label>
            <div className="subscription-reauth__dev-row">
              <input id="subscription-reauth-email" className="text-input" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setError(null); }} autoComplete="email" disabled={busy} />
              <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={busy}>{busy ? 'Signing in…' : 'Continue with email'}</button>
            </div>
          </form>
        )}
        {error && <div className="cfg-error" role="alert">{error}</div>}
        <div className="subscription-settings__actions">
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onCancel} disabled={busy}>Not now</button>
        </div>
      </div>
    </section>
  );
}
