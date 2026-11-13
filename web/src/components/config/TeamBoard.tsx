import { useEffect, useState } from 'react';
import { teamApi, type TeamState, type TeamTask } from '../../lib/teamApi';
import { useNativeRefresh } from '../../lib/useNativeRefresh';
import { useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { SourceMessages } from './KnowledgePanels';
import type { MessageSource } from '../../lib/configApi';
import './native-learning.css';

function sources(evidence: unknown[]): MessageSource[] {
  return evidence.filter((item): item is MessageSource => !!item && typeof item === 'object' && typeof (item as MessageSource).botId === 'string' && Number.isInteger((item as MessageSource).generation) && Number.isInteger((item as MessageSource).seq));
}
function nextStep(task: TeamTask): string {
  if (task.reason) return task.reason;
  if (task.status === 'completed') return task.resultValidated ? 'Acceptance evidence verified.' : 'Completion recorded; inspect acceptance evidence.';
  if (task.dependsOn.length && task.status === 'pending') return 'Waiting for prerequisites.';
  if (task.activeJobId) return 'Inspect the current job or wait for its result.';
  return 'Open the workflow to review or continue this task.';
}
export function TeamBoard({ botId }: { botId?: string }) {
  const [state, setState] = useState<TeamState | null>(null), [error, setError] = useState('');
  const [revision, refresh] = useNativeRefresh();
  const connected = useStore(s => s.sseConnected);
  useEffect(() => {
    let active = true;
    teamApi.state().then(r => { if (active) { setState(r.state); setError(''); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [revision, connected]);
  const name = (id: string | null) => state?.agents.find(a => a.botId === id)?.name ?? (id ? 'Unavailable Bot' : 'Unassigned');
  const openBot = (id: string) => { useStore.getState().selectBot(id); useConfigUI.getState().setView('chat'); };
  const workflows = state?.workflows.filter(w => !botId || w.botId === botId || w.tasks.some(t => t.workerBotId === botId || t.assignedBotId === botId)) ?? [];
  return <section className="native-panel team-board" aria-labelledby="team-board-heading">
    <header><div><h2 id="team-board-heading">{name(state?.primaryBotId ?? null) === 'Unassigned' ? 'Team board' : `${name(state?.primaryBotId ?? null)}’s board`}</h2><p>Owners, dependencies and evidence from current team records.</p></div><button className="cfg-btn cfg-btn--secondary" type="button" onClick={refresh}>Refresh board</button></header>
    {error && <p className="cfg-error" role="alert">{state ? 'Board could not refresh. Showing the last loaded records. ' : ''}{error}</p>}
    {!state && !error && <p role="status">Loading team state…</p>}
    {state && <>
      <div className="native-meta">Snapshot {new Date(state.generatedAt).toLocaleTimeString()} · Runtime: {state.health.runtime}{state.health.lastTickAt ? ` · Last check ${new Date(state.health.lastTickAt).toLocaleTimeString()}` : ' · No runtime check recorded'}</div>
      {state.health.lastError && <p className="cfg-error" role="alert">Coordination: {state.health.lastError}</p>}
      <div className="team-roster">{state.agents.filter(a => !botId || a.botId === botId).map(a => <button type="button" key={a.botId} onClick={() => openBot(a.botId)}><strong>{a.name}</strong><span>{a.pendingDecision ? 'Waiting for your decision' : a.status}{a.isPrimary ? ' · Coordinator' : ''}</span></button>)}</div>
      {!workflows.length && <p className="native-meta">No workflows in this view. Create one below to assign work and prerequisites.</p>}
      {workflows.map(w => <article className="team-workflow" key={w.id}>
        <h3>{w.title} <span className="cfg-chip">{w.status}</span></h3><p className="native-meta">Coordinator: {name(w.botId)}{w.reason ? ` · ${w.reason}` : ''}</p>
        <div className="team-task-grid">{w.tasks.map(t => <article className="team-task" key={t.id}>
          <div><strong>{t.title}</strong> <span className="cfg-chip">{t.status}</span></div>
          <dl><dt>Owner</dt><dd>{name(t.workerBotId ?? t.assignedBotId ?? w.botId)}</dd><dt>Depends on</dt><dd>{t.dependsOn.map(id => w.tasks.find(other => other.id === id)?.title ?? id).join(', ') || 'None'}</dd><dt>Next step / blocker</dt><dd>{nextStep(t)}</dd><dt>Evidence</dt><dd>{t.resultValidated ? 'Result validated' : 'No validated result recorded'}{t.evidence.length ? ` · ${t.evidence.length} evidence record(s)` : ''}</dd></dl>
          {!!t.evidence.length && <details><summary>Inspect evidence</summary><SourceMessages sources={sources(t.evidence)} /><pre>{JSON.stringify(t.evidence, null, 2)}</pre></details>}
          {t.activeJobId && <details><summary>Current job</summary><code>{t.activeJobId}</code><p>{state.jobs.find(j => j.id === t.activeJobId)?.state ?? 'No current job record in this snapshot'}</p></details>}
        </article>)}</div>
      </article>)}
      {!!state.artifacts.length && <details><summary>Saved artifacts and delivery ({state.artifacts.length})</summary>{state.artifacts.filter(a => !botId || a.botId === botId).map(a => <div className="native-history" key={a.id}><a href={`/api/deliverables/artifacts/${encodeURIComponent(a.id)}/download`}>{a.title}</a><span>{a.status} · {name(a.botId)}</span>{state.deliveries.filter(d => d.artifactId === a.id).map(d => <span key={d.id}>Delivery: {d.status}</span>)}</div>)}</details>}
      <details><summary>Snapshot sources</summary><p className="native-meta">Event cursor {state.eventCursor}. Records may change after this snapshot.</p><pre>{JSON.stringify(state.sourceVersions, null, 2)}</pre></details>
      <InternalActivity botId={botId} />
    </>}
  </section>;
}
function InternalActivity({ botId }: { botId?: string }) {
  const [open, setOpen] = useState(false), [pages, setPages] = useState(1);
  const [data, setData] = useState<Awaited<ReturnType<typeof teamApi.requests>> | null>(null), [error, setError] = useState('');
  const [revision, refresh] = useNativeRefresh();
  const bots = useStore(s => s.bots);
  useEffect(() => { setData(null); setPages(1); setError(''); }, [botId]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    (async () => {
      let response = await teamApi.requests(0, botId);
      for (let page = 1; page < pages && response.hasMore; page++) {
        const next = await teamApi.requests(response.nextCursor, botId);
        response = { ...next, requests: [...response.requests, ...next.requests] };
      }
      if (active) { setData(response); setError(''); }
    })().catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [open, botId, pages, revision]);
  const name = (id: string) => bots.find(b => b.id === id)?.name ?? 'Unavailable Bot';
  return <details open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary>Internal team activity</summary>
    <p className="native-meta">Assignments and correlated results. Admission means work was accepted; completion is recorded separately.</p>
    {error && <p className="cfg-error" role="alert">{error} <button type="button" onClick={refresh}>Refresh activity</button></p>}
    {!data && !error && <p role="status">Loading activity…</p>}
    {data?.requests.length === 0 && <p>No internal exchanges recorded.</p>}
    {data?.requests.map(r => <details className="native-history" key={r.id}><summary>{name(r.fromBotId)} → {name(r.toBotId)} · {r.kind} · {r.status}</summary><p>{r.text}</p>{r.reason && <p>{r.reason}</p>}{r.result && <p>{r.result}</p>}<small>{new Date(r.updatedAt).toLocaleString()} · Request {r.id} · Correlation {r.correlationId}{r.jobId ? ` · Job ${r.jobId}` : ''}</small></details>)}
    {data?.hasMore && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPages(n => n + 1)}>Load more exchanges</button>}
  </details>;
}
