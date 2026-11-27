import { useState } from 'react';
import { ButtonGroup } from '../components/layout';
import { useCustomization, recoverAppearance, refreshUiConfig } from './store';
import { closeSafeMode } from './safeMode';

export function SafeModeBanner() {
  const safe = useCustomization(s => s.safe), invalid = useCustomization(s => s.invalidStored);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!safe && !invalid) return null;
  const run = async (action: 'reset' | 'undo') => {
    setBusy(true); setError('');
    try { await recoverAppearance(action); setConfirm(false); closeSafeMode(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Try again.'); await refreshUiConfig(); }
    finally { setBusy(false); }
  };
  return <aside className="ui-runtime-banner" role="status" aria-live="polite" aria-label="Appearance recovery">
    <div>{safe ? 'Safe mode. Using the default look.' : 'Your saved appearance could not load. Using the default look.'}</div>
    {confirm && <p>Reset theme, layout, visibility and shortcuts? Dashboards stay.</p>}
    <ButtonGroup>
      <button disabled={busy} onClick={() => confirm ? void run('reset') : setConfirm(true)}>{confirm ? 'Confirm reset' : 'Reset'}</button>
      <button disabled={busy} onClick={() => void run('undo')}>Undo</button>
      {confirm ? <button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button> : safe && <button onClick={closeSafeMode}>Exit safe mode</button>}
    </ButtonGroup>
    {error && <p role="alert">{error}</p>}
  </aside>;
}
