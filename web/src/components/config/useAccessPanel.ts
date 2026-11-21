import { useCallback, useLayoutEffect, useRef } from 'react';
import { useStore } from '../../store';

export function useAccessPanel(accountId: string | undefined) {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return useCallback(() => mounted.current && !!accountId && useStore.getState().user?.id === accountId, [accountId]);
}
