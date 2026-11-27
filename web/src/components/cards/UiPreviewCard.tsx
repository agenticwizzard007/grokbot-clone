import { useEffect, useRef, useState } from 'react';
import type { UiPreviewCardBody, StoredPreview } from '@shared/ui-config/index';
import { usePreview, useUiConfig } from '../../customization';
import { ButtonGroup, Card } from '../layout';
import { appearanceRequest, readPreview } from '../config/appearance/api';
import { compareAppliedAppearance, refreshAppearance } from '../config/appearance/runtime';
import '../../styles/appearance.css';

export function UiPreviewCard({ body }: { body: UiPreviewCardBody }) {
  const active = usePreview();
  const { saved, revision } = useUiConfig();
  const before = useRef<{ doc: typeof saved; revision: number } | null>(body.status === 'pending' ? { doc: saved, revision } : null);
  const comparing = useRef(false);
  const [stored, setStored] = useState<StoredPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [undone, setUndone] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const current = active.preview?.id === body.previewId ? active.preview : stored;
  const status = stored?.status === 'expired' ? 'expired' : current?.status ?? body.status;
  useEffect(() => () => { if (comparing.current) compareAppliedAppearance(null); }, []);
  useEffect(() => { if (current?.status === 'pending' && revision === current.baseRevision) before.current = { doc: saved, revision }; }, [current, saved, revision]);
  useEffect(() => {
    let alive = true;
    void readPreview(body.previewId).then(value => { if (alive) setStored(value); }).catch(() => {});
    return () => { alive = false; };
  }, [body.previewId, body.status, revision, active.preview?.status]);
  useEffect(() => {
    if (status !== 'pending' || !current) return;
    const timer = setTimeout(() => setStored({ ...current, status: 'expired' }), Math.max(0, current.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [current, status]);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); requestAnimationFrame(() => statusRef.current?.focus()); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const decide = async (action: 'apply' | 'discard') => {
    if (active.preview?.id === body.previewId) await active[action]();
    else { await appearanceRequest(`/ui/previews/${encodeURIComponent(body.previewId)}/${action}`, 'POST', {}, revision); await refreshAppearance(); }
    setStored(await readPreview(body.previewId));
  };
  const compare = (show: boolean) => {
    comparing.current = show;
    if (active.preview?.id === body.previewId) active.setShowBefore(show);
    else compareAppliedAppearance(show ? before.current?.doc ?? null : null);
  };
  const lines = current?.summary ?? body.lines;
  const warnings = current?.warnings.map(w => w.message) ?? body.warnings;
  return <Card className="ui-preview-card" role="region" aria-label={body.title}>
    <strong className="ui-preview-card__title">{body.title}</strong>
    <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite"><span className="cfg-chip">{undone ? 'Undone' : status[0].toUpperCase() + status.slice(1)}</span></p>
    <ul>{lines.slice(0, 6).map((line, i) => <li key={i}>{line}</li>)}</ul>
    {Math.max(body.moreCount, lines.length - 6) > 0 && <p>and {Math.max(body.moreCount, lines.length - 6)} more</p>}
    {warnings.length > 0 && <ul aria-label="Warnings">{warnings.map((line, i) => <li key={i}>{line}</li>)}</ul>}
    {status === 'pending' && <ButtonGroup>
      <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={() => void run(() => decide('apply'))}>Apply</button>
      <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void run(() => decide('discard'))}>Discard</button>
    </ButtonGroup>}
    {status === 'applied' && !undone && <ButtonGroup>
      <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || (current?.revision !== undefined && current.revision !== revision)} onClick={() => void run(async () => { await appearanceRequest('/ui/undo', 'POST', { steps: 1 }, revision); await refreshAppearance(); setUndone(true); })}>Undo</button>
      <button type="button" className="cfg-btn cfg-btn--secondary" aria-pressed={active.showBefore} disabled={busy || !before.current || before.current.revision !== current?.baseRevision} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); compare(true); }} onPointerUp={() => compare(false)} onPointerCancel={() => compare(false)} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); compare(true); } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); compare(false); } }} onBlur={() => compare(false)}>Show before</button>
    </ButtonGroup>}
    {error && <p role="alert" className="cfg-error">{error}</p>}
  </Card>;
}
