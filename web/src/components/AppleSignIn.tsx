import { AuthLink } from './AuthButton';

export function AppleSignIn({ link = false }: { link?: boolean }) {
  return (
    <AuthLink className="signin__apple" href={`/api/auth/apple/start${link ? '?intent=link' : ''}`} icon={
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
        <path d="M17.05 12.54c.03 3.2 2.81 4.27 2.84 4.28-.02.08-.44 1.52-1.46 3.01-.88 1.29-1.8 2.58-3.24 2.61-1.41.03-1.87-.84-3.49-.84-1.62 0-2.13.81-3.47.87-1.39.05-2.45-1.4-3.33-2.68-1.8-2.62-3.18-7.4-1.33-10.62.92-1.6 2.56-2.61 4.34-2.64 1.36-.03 2.64.92 3.47.92.83 0 2.39-1.14 4.03-.97.69.03 2.62.28 3.86 2.1-.1.06-2.3 1.34-2.22 3.96ZM14.39 4.75c.73-.89 1.23-2.13 1.1-3.36-1.05.04-2.33.7-3.09 1.59-.68.79-1.28 2.06-1.12 3.27 1.17.09 2.36-.6 3.11-1.5Z" />
      </svg>
    }>
      {link ? 'Connect Apple' : 'Sign in with Apple'}
    </AuthLink>
  );
}
