import { useStore } from '../store';
import '../styles/load-feedback.css';

export function LoadFeedback({ label, error, loading, stale, onRetry }: {
  label: string; error?: string | null; loading: boolean; stale: boolean; onRetry(): void;
}) {
  return <div className="load-feedback" aria-busy={loading}>
    <div role={error ? 'alert' : 'status'}>
      {error || `Loading ${label}...`}
      {stale && <p>Showing previously loaded data. {label === 'Bots' ? 'Your Bot list' : 'Your messages'} may be out of date.</p>}
      {error && loading && <p role="status">Retrying...</p>}
    </div>
    {error && <button type="button" className="btn btn--secondary" disabled={loading} onClick={onRetry}>Retry {label}</button>}
  </div>;
}

export function RosterFeedback() {
  const loaded = useStore(s => s.botsLoaded);
  const loading = useStore(s => s.botsLoading);
  const error = useStore(s => s.botsError);
  const hasBots = useStore(s => s.bots.length > 0);
  if (loaded && !loading && !error) return null;
  return <LoadFeedback label="Bots" error={error} loading={loading || (!loaded && !error)} stale={loaded || hasBots} onRetry={() => { void useStore.getState().loadBots(); }} />;
}
