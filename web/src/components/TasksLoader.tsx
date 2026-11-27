import { Page, Card } from './layout';
import { useEffect, useState, type ComponentType } from 'react';
import { retryImport } from '../lib/retryImport';

type Module = typeof import('./config/TasksView');
let pending: Promise<Module> | undefined;
export function preloadTasks() {
  return pending ??= retryImport(() => import('./config/TasksView'), url => import(/* @vite-ignore */ url), window.location.origin)
    .catch(error => { pending = undefined; throw error; });
}

export function TasksLoader() {
  const [View, setView] = useState<ComponentType | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    preloadTasks().then(module => { if (active) setView(() => module.TasksView); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  if (View) return <View />;
  return <main className="chat chat--empty" aria-label="Tasks">
    <Page type="list"><Card><p role={error ? 'alert' : 'status'}>{error ? 'Tasks unavailable.' : 'Loading Tasks...'}</p>
    {error && <button type="button" className="btn btn--secondary" onClick={() => setAttempt(n => n + 1)}>Retry Tasks</button>}
  </Card></Page></main>;
}
