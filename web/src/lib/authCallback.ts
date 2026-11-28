import { useEffect, useState } from 'react';
import { OPENROUTER_ERRORS } from './openrouterApi';

const AUTH_ERRORS: Record<string, string> = {
  ...OPENROUTER_ERRORS,
  failed: 'Sign-in didn’t finish. Try again.',
  google_denied: 'Google sign-in was cancelled. You can try again or choose another sign-in option.',
  google_failed: 'Google sign-in did not finish. Please try again.',
  google_pending: 'Google authorization was not completed. Start sign-in again and finish the Google consent screen.',
  google_permissions: 'Google sign-in could not verify your profile. Please try again.',
  google_unavailable: 'Google sign-in is temporarily unavailable. Please try again.',
  google_session: 'That sign-in link expired. Please try again.',
  google_invalid: 'Google sign-in could not be verified. Please try again.',
  google_busy: 'Google sign-in is busy. Please try again shortly.',
  google_expired: 'That sign-in link expired. Please try again.',
  google_link_required: 'You already have a Swarm account with this email. Sign in with your phone or Apple, then connect Google in Settings → Account.',
  google_already_linked: 'This Google account is already connected to a different Swarm account, or this Swarm account already has Google connected.',
  apple_denied: 'Apple sign-in was cancelled. You can try again or choose another sign-in option.',
  apple_session: 'Apple sign-in expired or no longer matches this browser. Please start again.',
  apple_invalid: 'Apple sign-in could not be verified. Please try again.',
  apple_unavailable: 'Apple sign-in is not configured on this server yet. Choose Google or phone sign-in.',
  apple_busy: 'Apple sign-in is busy. Please try again shortly.',
  apple_email_required: 'Apple did not provide a verified email. Review Swarm’s access in your Apple Account and try again.',
  apple_link_required: 'You already have a Swarm account with this email. Sign in with Google or phone, then connect Apple in Settings → Account.',
  apple_link_signin: 'Sign in to your existing Swarm account before connecting Apple.',
  apple_already_linked: 'This Apple Account is already connected to a different Swarm account, or this Swarm account already has Apple connected.',
};

// Capture the callback before removing its marker, including under StrictMode.
export function useAuthCallback(consume = true) {
  const [code] = useState(() => new URLSearchParams(location.search).get('login') ?? '');
  useEffect(() => {
    if (!consume) return;
    const params = new URLSearchParams(location.search);
    if (!params.has('login')) return;
    params.delete('login');
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }, [consume]);
  return { code, error: Object.hasOwn(AUTH_ERRORS, code) ? AUTH_ERRORS[code] : null };
}
