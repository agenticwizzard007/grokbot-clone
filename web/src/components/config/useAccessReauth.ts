import { useEffect, useState } from 'react';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { cliApi } from '../../lib/cliApi';

type AccessSection = 'mcp' | 'account' | 'keys';
const lifetime = 10 * 60_000;

export function useAccessReauth<Intent>(section: AccessSection, accountId: string, parse: (value: unknown) => Intent | null) {
  const key = `swarm.access-return.${section}`;
  const [callbackFailed] = useState(() => {
    const callback = new URLSearchParams(window.location.search);
    return callback.has('login') || (callback.has('openrouter') && callback.get('openrouter') !== 'connected');
  });
  const [resume] = useState(() => {
    const target = useConfigUI.getState().resume;
    if (target?.section !== section || target.action !== 'login') return null;
    let intent: Intent | null = null;
    if (target.accountId === accountId && target.expiresAt > Date.now()) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (saved?.accountId === accountId && saved.expiresAt > Date.now() && saved.expiresAt <= Date.now() + lifetime) intent = parse(saved.intent);
      } catch { /* storage unavailable */ }
    }
    return { intent };
  });
  const [pending, setPending] = useState<{ intent: Intent; reason: string } | null>(null);
  const [returned, setReturned] = useState<Intent | null>(null);
  const [checking, setChecking] = useState(!!resume);
  const [error, setError] = useState('');

  function request(intent: Intent, reason: string) {
    if (useStore.getState().user?.id !== accountId) return;
    try { sessionStorage.setItem(key, JSON.stringify({ accountId, expiresAt: Date.now() + lifetime, intent })); } catch { /* storage unavailable */ }
    setError('');
    setPending({ intent, reason });
  }

  function cancel() {
    try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ }
    setPending(null);
  }

  useEffect(() => {
    if (!resume) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && useStore.getState().user?.id === accountId;
    if (useConfigUI.getState().resume?.section === section) useConfigUI.getState().clearResume();
    const finish = () => {
      try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ }
      setChecking(false);
    };
    if (!resume.intent) {
      setError('The previous sign-in request expired or belongs to another account. Nothing was retried.');
      finish();
    } else if (callbackFailed) {
      request(resume.intent, 'Sign-in did not complete. Sign in again to continue.');
      setChecking(false);
    } else {
      const intent = resume.intent;
      void cliApi.verifyAuth(accountId, controller.signal).then(() => {
        if (current()) { setReturned(intent); finish(); }
      }).catch(() => {
        if (!current()) return;
        request(intent, 'Couldn’t verify a recent sign-in for this account. Sign in again to continue.');
        setChecking(false);
      });
    }
    return () => controller.abort();
  }, [accountId, callbackFailed, key, resume, section]);

  return { pending, returned, checking, error, request, cancel };
}
