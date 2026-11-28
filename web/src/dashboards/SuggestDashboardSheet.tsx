import { useEffect, useRef, useState } from 'react';
import type { UiPreviewCardBody } from '@shared/ui-config';
import { ButtonGroup, Section } from '../components/layout';
import { UiPreviewCard } from '../components/cards/UiPreviewCard';
import { appearanceRequest } from '../components/config/appearance/api';
import { DashboardDialog } from './Dialog';

export function SuggestDashboardSheet({ close }: { close(): void }) {
  const [role, setRole] = useState(''), [goals, setGoals] = useState('');
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0), [preview, setPreview] = useState<UiPreviewCardBody>();
  const pending = useRef(false);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void appearanceRequest<{ profile: { role: string; goals: string[] } | null; revision: number }>('/ui/requirements')
      .then(value => { if (alive) { setRole(value.profile?.role ?? ''); setGoals(value.profile?.goals.join('\n') ?? ''); setRevision(value.revision); } })
      .catch(() => { if (alive) setError('Could not load your profile.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [attempt]);
  return <DashboardDialog title={preview ? 'Suggested dashboard' : 'About you'} fullScreen close={() => { if (!pending.current) close(); }}>
    {preview ? <UiPreviewCard body={preview} /> : loading ? <p role="status">Loading your profile...</p> : <form onSubmit={async event => {
      event.preventDefault(); if (pending.current || !role.trim()) return;
      pending.current = true; setBusy(true); setError('');
      try {
        const saved = await appearanceRequest<{ revision: number }>('/ui/requirements', 'PUT', { patch: [{ op: 'replace', path: '/role', value: role.trim() }, { op: 'replace', path: '/goals', value: goals.split('\n').map(goal => goal.trim()).filter(Boolean) }] }, revision);
        setRevision(saved.revision);
        const result = await appearanceRequest<{ previewId: string; title: string; summary: string[]; warnings: { message: string }[] }>('/ui/requirements/suggest', 'POST', {}, saved.revision);
        setPreview({ card: 'ui_preview', previewId: result.previewId, title: result.title, lines: result.summary, warnings: result.warnings.map(warning => warning.message), moreCount: 0, status: 'pending' });
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not suggest a dashboard. Try again.'); }
      finally { pending.current = false; setBusy(false); }
    }}><Section>
      <label className="dashboard-field">Role<input maxLength={60} value={role} disabled={busy} onChange={event => setRole(event.target.value)} placeholder="Project coordinator" /></label>
      <label className="dashboard-field">Goals<textarea rows={3} maxLength={720} value={goals} disabled={busy} onChange={event => setGoals(event.target.value)} placeholder="Draft the launch email" /></label>
      {error ? <p role="alert">{error}</p> : <p role="status">{busy ? 'Preparing your preview...' : !role.trim() ? 'Enter your role to preview a dashboard.' : 'Add one goal per line.'}</p>}
      <ButtonGroup>{error && <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Retry</button>}<button type="submit" className="btn btn--primary" disabled={busy || !role.trim()}>Preview dashboard</button></ButtonGroup>
    </Section></form>}
  </DashboardDialog>;
}
