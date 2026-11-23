import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@shared/types';
import { api, type NeedsYouItem } from '../../lib/api';
import { configApi } from '../../lib/configApi';
import { useVersion } from '../../configStore';
import { useStore } from '../../store';
import { scopeNeedsYou } from './settingsLogic';

/** Setup reviews, approvals, questions and connect cards waiting on the user (GET /api/needs-you). */
export function useNeedsYou(botId?: string, available = true) {
  const userId = useStore(s => s.user?.id);
  const version = useVersion('needs-you');
  const connected = useStore((s) => s.sseConnected);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ userId?: string; items: NeedsYouItem[] | null; error: boolean; loading: boolean }>();
  useEffect(() => {
    if (!userId || !available) return;
    let alive = true;
    setResult(prev => ({ userId, items: prev?.userId === userId ? prev.items : null, error: prev?.userId === userId && prev.error, loading: true }));
    api.needsYou().then(r => {
      if (alive && useStore.getState().user?.id === userId) setResult({ userId, items: Array.isArray(r?.items) ? r.items : [], error: false, loading: false });
    }).catch(() => {
      if (alive && useStore.getState().user?.id === userId) setResult(prev => ({ userId, items: prev?.userId === userId ? prev.items : null, error: true, loading: false }));
    });
    return () => { alive = false; };
  }, [userId, available, version, connected, attempt]);
  const current = available && result?.userId === userId ? result : undefined;
  const items = current?.items ?? null;
  const scoped = useMemo(() => items ? scopeNeedsYou(items, botId) : null, [items, botId]);
  // Keep the error and stale label during retries until a successful response arrives.
  return { items: scoped, error: current?.error ?? false, loading: current?.loading ?? true, retry: () => setAttempt(n => n + 1) };
}

export function useTasks(botId?: string, available = true) {
  const userId = useStore(s => s.user?.id);
  const generation = useStore(s => s.bots.find(bot => bot.id === botId)?.generation);
  const scope = JSON.stringify([userId, botId, generation]);
  const version = useVersion(botId ? `tasks:${botId}` : 'tasks');
  const connected = useStore((s) => s.sseConnected);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ scope: string; tasks: Task[] | null; error: boolean }>();
  useEffect(() => {
    if (!userId || !available) return;
    let alive = true;
    (botId ? configApi.botTasks(botId) : configApi.tasks()).then((r) => {
      if (alive && useStore.getState().user?.id === userId) setResult({ scope, tasks: r.tasks.filter(task => !botId || task.botId === botId), error: false });
    }).catch(() => {
      if (alive) setResult((prev) => ({ scope, tasks: prev?.scope === scope ? prev.tasks : null, error: true }));
    });
    return () => { alive = false; };
  }, [userId, botId, scope, available, version, attempt, connected]);
  const retry = () => {
    setResult((prev) => prev && ({ ...prev, error: false }));
    setAttempt((n) => n + 1);
  };
  return { tasks: available && result?.scope === scope ? result.tasks : null, error: available && result?.scope === scope && result.error, retry };
}

