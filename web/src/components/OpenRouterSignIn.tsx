import { ProviderMark } from './ProviderMark';
import { AuthLink } from './AuthButton';

export function OpenRouterMark() {
  return <ProviderMark provider="openrouter" />;
}

export function OpenRouterSignIn({ link = false, label, invite }: { link?: boolean; label?: string; invite?: string }) {
  const text = label ?? (link ? 'Connect OpenRouter' : 'Continue with OpenRouter');
  return <AuthLink href={`/api/auth/openrouter/start${link ? '?intent=link' : invite ? `?invite=${encodeURIComponent(invite)}` : ''}`} aria-label={text} icon={<OpenRouterMark />}>{label ?? <><span className="openrouter-signin__prefix">{link ? 'Connect ' : 'Continue with '}</span>OpenRouter</>}</AuthLink>;
}
