import { useState } from 'react';
import { ButtonGroup } from '../components/layout';
import { usePreview } from './hooks';
import { useCustomization, recoverAppearance, refreshUiConfig } from './store.js';

export function PreviewBanner() {
  const { preview, apply, discard, showBefore, setShowBefore } = usePreview();
  const safe = useCustomization(s => s.safe);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!preview || safe) return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : 'Try again.'); await refreshUiConfig(); }
    finally { setBusy(false); }
  };
  return <aside className="ui-runtime-banner" role="status" aria-live="polite" aria-label="Appearance preview">
    <div className="ui-runtime-banner__copy">Previewing: {preview.intent}</div>
    <ButtonGroup>
      <button disabled={busy} onClick={() => void run(apply)}>Apply</button>
      <button disabled={busy} onClick={() => void run(discard)}>Discard</button>
      <button aria-pressed={showBefore} onClick={() => setShowBefore(!showBefore)}>Show before</button>
    </ButtonGroup>
    {error && <p role="alert">{error}</p>}
  </aside>;
}

export function AppearanceUndo() {
  const until = useCustomization(s => s.undoUntil);
  const [error, setError] = useState('');
  if (!until) return null;
  return <aside className="ui-runtime-banner" role="status" aria-label="Appearance updated">
    <span>Appearance updated.</span>
    <button onClick={() => { void recoverAppearance('undo').catch(error => setError(error.message)); }}>Undo</button>
    {error && <p role="alert">{error}</p>}
  </aside>;
}
