import { ChevronLeft } from 'lucide-react';
import { Page, Row } from './layout';
import { ProviderLabel } from './ProviderMark';
import { useEffect, useState } from 'react';
import '@fontsource-variable/instrument-sans';
import '../styles/signin-brand.css';
import { api } from '../lib/api';
import { PhoneAuth } from './PhoneAuth';
import '../styles/messaging.css';
import { useStore } from '../store';
import { AppleSignIn } from './AppleSignIn';
import { AuthLink } from './AuthButton';
import { OpenRouterSignIn } from './OpenRouterSignIn';
import { useAuthCallback } from '../lib/authCallback';
import { planResume, useConfigUI } from '../configStore';
import { PlatformOnboarding } from './PlatformOnboarding';

export function SignIn() {
  const platform = useStore(s => s.platform);
  const [invitation] = useState(() => new URLSearchParams(location.search).get('invite') ?? undefined);
  const [onboarding, setOnboarding] = useState(() => new URLSearchParams(location.search).get('onboarding') ?? undefined);
  const invite = platform ? invitation : undefined;
  const devLogin = useStore((s) => s.devLogin);
  const googleLogin = useStore((s) => s.googleLogin);
  const appleLogin = useStore((s) => s.appleLogin);
  const checkAuth = useStore((s) => s.checkAuth);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [codeStep, setCodeStep] = useState(false);
  const [phoneAttempt, setPhoneAttempt] = useState(0);
  const { code: loginCode, error: callbackError } = useAuthCallback();
  const [error, setError] = useState<string | null>(callbackError);
  const expired = loginCode === 'expired';
  const googleRecovery = !!error && loginCode.startsWith('google_');

  useEffect(() => {
    // A genuinely expired session may need a provider redirect before connecting.
    // Preserve the destination across that redirect, without another Login click.
    const resume = useConfigUI.getState().resume;
    if (resume?.section === 'subscriptions' && resume.expiresAt > Date.now()) planResume(resume);
  }, []);

  const dev = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) { setError('Enter an email address'); return; }
    setBusy(true); setError(null);
    try { await api.devLogin(email.trim(), name.trim() || undefined); await checkAuth(); } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <main className="signin access-signin">
      <aside className="signin__story" aria-label="About Swarm">
        <div className="signin__brand"><img className="signin__brand-light" src="/assets/swarms/wordmark.svg" alt="swarms.so" /><img className="signin__brand-dark" src="/assets/swarms/wordmark-night.svg" alt="swarms.so" /></div>
        <div><h2>Ready on day one.</h2><Row title="Roles" /><Row title="Control" /><Row title="Your plan" /></div>
        <div className="signin__works"><ProviderLabel provider="claude">Claude</ProviderLabel><ProviderLabel provider="openai">ChatGPT</ProviderLabel><ProviderLabel provider="openrouter">OpenRouter</ProviderLabel></div>
      </aside>
      <div className="signin__form-column">{(codeStep || googleRecovery) && <header className="signin__topbar"><button type="button" aria-label="Back" onClick={() => codeStep ? setPhoneAttempt(n => n + 1) : setError(null)}><ChevronLeft size={20} aria-hidden /><span>Back</span></button></header>}<Page type="form" className="signin-page"><div className="signin__card">
        <header className="signin__header">
          <div className="signin__brand signin__phone-brand">
            <img className="signin__brand-light" src="/assets/swarms/wordmark.svg" width="200" height="32.62" alt="swarms.so" />
            <img className="signin__brand-dark" src="/assets/swarms/wordmark-night.svg" width="200" height="32.62" alt="swarms.so" />
          </div>
          <div className="signin__intro">
            <h1 className="signin__title">Welcome</h1>

          </div>
        </header>
        {platform && <PlatformOnboarding invite={invite} result={onboarding} />}
        {expired && <div className="signin__notice" role="status">That sign-in link has expired or was already used.</div>}
        {error && (googleRecovery ? <div className="signin__recovery">
          <div className="card__error signin__error" role="alert">{error}</div>
          {googleLogin && <AuthLink href={`/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`}>Try again</AuthLink>}
        </div> : <div className="card__error signin__error" role="alert">{error}</div>)}
        <PhoneAuth key={phoneAttempt} mode="signin" onCodeStep={setCodeStep} inviteCode={invite} onOnboarding={platform ? setOnboarding : undefined} />
        <section className="access-signin__alternatives" aria-labelledby="signin-other-methods">
          <h2 className="signin__divider" id="signin-other-methods">or</h2>
          <div className="signin__providers">
            {googleLogin && <AuthLink className="signin__google" href={`/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`} icon={<GoogleG />}>Continue with Google</AuthLink>}
            {appleLogin && <AppleSignIn invite={invite} />}
            <OpenRouterSignIn invite={invite} label="Continue with OpenRouter" />
          </div>
          <details className="signin__info"><summary>Learn more</summary><p>OpenRouter uses your model credits. Google may request Gmail access through Composio to verify your email.</p></details>
        </section>
        {devLogin && (
          <form className="signin__dev" onSubmit={dev}>
            <div className="signin__divider"><span>Dev sign-in</span></div>
            <input className="text-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <input className="text-input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <button type="submit" className="btn btn--secondary" disabled={busy}>{busy ? 'Signing in...' : 'Continue with email'}</button>
          </form>
        )}
      </div></Page></div>
    </main>
  );
}

export function GoogleG() {
  return (
    <svg className="auth-button__google-mark" width="20" height="20" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
