import { AuthLink } from './AuthButton';

export function OpenRouterMark() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12h5c4 0 4-6 8-6h5M17 2l4 4-4 4M8 12c4 0 4 6 8 6h5M17 14l4 4-4 4" /></svg>;
}

export function OpenRouterSignIn({ link = false, label }: { link?: boolean; label?: string }) {
  const text = label ?? (link ? 'Connect OpenRouter' : 'Continue with OpenRouter');
  return <AuthLink href={`/api/auth/openrouter/start${link ? '?intent=link' : ''}`} aria-label={text} icon={<OpenRouterMark />}>{label ?? <><span className="openrouter-signin__prefix">{link ? 'Connect ' : 'Continue with '}</span>OpenRouter</>}</AuthLink>;
}
