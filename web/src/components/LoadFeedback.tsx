import { useEffect, useState, useSyncExternalStore } from 'react';
import { Card, Row, ButtonGroup } from './layout';
import { ProviderMark } from './ProviderMark';
import { getCachedCliStatus, subscribeCliStatus } from '../lib/cliApi';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import '../styles/load-feedback.css';

export function LoadFeedback({ label, error, loading, stale, onRetry }: {
  label: string; error?: string | null; loading: boolean; stale: boolean; onRetry(): void;
}) {
  return <Card className="load-feedback" aria-busy={loading}>
    <div role={error ? 'alert' : 'status'}>
      {error || `Loading ${label}...`}
      {stale && <p>Showing the last update.</p>}
      {error && loading && <p role="status">Retrying...</p>}
    </div>
    {error && <button type="button" className="btn btn--secondary" disabled={loading} onClick={onRetry}>Retry {label}</button>}
  </Card>;
}

export function RosterFeedback() {
  const loaded = useStore(s => s.botsLoaded);
  const loading = useStore(s => s.botsLoading);
  const error = useStore(s => s.botsError);
  const hasBots = useStore(s => s.bots.length > 0);
  if (loaded && !loading && !error) return null;
  return <LoadFeedback label="Bots" error={error} loading={loading || (!loaded && !error)} stale={loaded || hasBots} onRetry={() => { void useStore.getState().loadBots().catch(() => {}); }} />;
}

export function ConnectionFeedback() {
  const connected = useStore(s => s.sseConnected);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (connected) { setLost(false); return; }
    const timer = setTimeout(() => setLost(true), 5000);
    return () => clearTimeout(timer);
  }, [connected]);
  if (!lost) return null;
  return <Card className="connection-feedback" role="status"><span>Connection lost</span><button type="button" className="btn btn--secondary" onClick={() => window.dispatchEvent(new Event('swarm:resume'))}>Try again</button></Card>;
}

export function PlanFeedback() {
  const status = useSyncExternalStore(subscribeCliStatus, getCachedCliStatus, getCachedCliStatus);
  if (!status?.selected || status.statusChecking || status.statusUnavailable || status.providers[status.selected].authenticated) return null;
  const provider = status.selected;
  const name = provider === 'claude' ? 'Claude' : 'ChatGPT';
  return <Card className="plan-feedback">
    <Row leading={<ProviderMark provider={provider} />} title={`${name} signed out`} trailing={<span className="plan-feedback__status">Sign in needed</span>} />
    <ButtonGroup stack><button type="button" className="btn btn--primary" onClick={() => { useConfigUI.getState().openAppSettings('subscriptions'); useConfigUI.setState({ subscriptionProvider: provider }); }}>Reconnect {name}</button></ButtonGroup>
  </Card>;
}
