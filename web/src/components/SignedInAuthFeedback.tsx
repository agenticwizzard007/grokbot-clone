import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAuthCallback } from '../lib/authCallback';
import { useConfigUI } from '../configStore';
import '../styles/auth-callback.css';

const PROVIDERS = [
  { code: 'google', name: 'Google' },
  { code: 'apple', name: 'Apple' },
  { code: 'openrouter', name: 'OpenRouter' },
];

export function SignedInAuthFeedback({ children }: { children: ReactNode }) {
  // A resumed credential action reads the callback after its settings chunk loads.
  // Let that existing flow retain the marker until reauthentication succeeds.
  const [consume] = useState(() => !useConfigUI.getState().resume);
  const { code, error } = useAuthCallback(consume);
  const [dismissed, setDismissed] = useState(false);
  const banner = useRef<HTMLDivElement>(null);
  const provider = PROVIDERS.find(provider => code.startsWith(`${provider.code}_`));
  useLayoutEffect(() => {
    if (!banner.current) return;
    // Settings can be portalled to the body, so reserve space for the banner there too.
    const element = banner.current;
    const style = document.documentElement.style;
    const resize = () => style.setProperty('--auth-callback-height', `${element.getBoundingClientRect().height}px`);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => { observer.disconnect(); style.removeProperty('--auth-callback-height'); };
  }, [error, dismissed]);

  return <div className="signed-in-content">
    {error && !dismissed && <div className="auth-callback" role="alert" ref={banner}>
      <p className="auth-callback__message">{error}</p>
      <div className="auth-callback__actions">
        {provider && <a className="btn btn--secondary" href={`/api/auth/${provider.code}/start`}>Try {provider.name} again</a>}
        <button type="button" className="btn btn--secondary" onClick={() => setDismissed(true)} aria-label="Dismiss sign-in error">Dismiss</button>
      </div>
    </div>}
    {children}
  </div>;
}
