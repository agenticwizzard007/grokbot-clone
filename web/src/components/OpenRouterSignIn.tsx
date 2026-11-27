import { ProviderMark } from './ProviderMark';
import { AuthLink } from './AuthButton';

export function OpenRouterMark() {
  return <ProviderMark provider="openrouter" />;
}

export function OpenRouterSignIn({ link = false, label }: { link?: boolean; label?: string }) {
  const text = label ?? (link ? 'Connect OpenRouter' : 'Continue with OpenRouter');
  return <AuthLink href={`/api/auth/openrouter/start${link ? '?intent=link' : ''}`} aria-label={text} icon={<OpenRouterMark />}>{label ?? <><span className="openrouter-signin__prefix">{link ? 'Connect ' : 'Continue with '}</span>OpenRouter</>}</AuthLink>;
}
