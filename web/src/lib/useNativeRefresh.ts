import { useEffect, useState } from 'react';

/** Poll durable views while visible, and refresh promptly after native activity/reconnect. */
export function useNativeRefresh() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setRevision(n => n + 1); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('swarm:event', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('swarm:event', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return [revision, () => setRevision(n => n + 1)] as const;
}
