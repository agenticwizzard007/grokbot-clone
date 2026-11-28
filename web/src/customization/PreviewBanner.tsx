import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfigUI } from '../configStore';
import { ButtonGroup } from '../components/layout';
import { usePreview } from './hooks';
import { useCustomization, dismissUndo, recoverAppearance, refreshUiConfig } from './store.js';

export function PreviewBanner() {
  const { preview, apply, discard, showBefore, setShowBefore } = usePreview();
  const safe = useCustomization(s => s.safe);
  const cardVisible = useCustomization(s => !!s.preview && Object.values(s.visiblePreviewCards).includes(s.preview.id));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!preview || safe || cardVisible) return null;
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
  const message = useCustomization(s => s.undoMessage);
  const [error, setError] = useState('');
  useEffect(() => {
    const onNavigation = () => {
      const state = useCustomization.getState();
      if (state.undoUntil && state.undoLocation !== window.location.hash) dismissUndo();
    };
    const unsubscribe = useConfigUI.subscribe(onNavigation);
    window.addEventListener('hashchange', onNavigation);
    window.addEventListener('popstate', onNavigation);
    return () => { unsubscribe(); window.removeEventListener('hashchange', onNavigation); window.removeEventListener('popstate', onNavigation); };
  }, []);
  useEffect(() => { setError(''); }, [until]);
  if (!until) return null;
  return createPortal(<div className="ui-toast-overlay"><aside className="ui-undo-toast" role="status" aria-live="polite" aria-label={message.replace(/\.$/, '')}>
    <span>{message}</span>
    <button className="btn btn--secondary" onClick={() => { void recoverAppearance('undo').catch(error => setError(error.message)); }}>Undo</button>
    {error && <p role="alert">{error}</p>}
  </aside></div>, document.body);
}
