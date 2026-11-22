import { useEffect, useRef, useState, type ReactNode } from 'react';
import { teamApi, type TeamState } from '../../lib/teamApi';
import { useNativeRefresh } from '../../lib/useNativeRefresh';
import { useStore } from '../../store';
import { SourceMessages } from './KnowledgePanels';
import type { MessageSource } from '../../lib/configApi';
import { openWorkChat, useWorkLifetime } from './workScope';
import './workArea.css';
import { goalStatusLabel } from './settingsLogic';

function sources(evidence: unknown[]): MessageSource[] {
  return evidence.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Partial<MessageSource> & { source?: { botId?: string; generation?: number; rowSeq?: number; callId?: string } };
    const botId = record.source?.botId ?? record.botId, generation = record.source?.generation ?? record.generation, seq = record.source?.rowSeq ?? record.seq;
    if (typeof botId !== 'string' || typeof generation !== 'number' || !Number.isInteger(generation) || typeof seq !== 'number' || !Number.isInteger(seq)) return [];
    return [{ botId, generation, seq, kind: record.source?.callId ? 'tool' : record.kind, contentHash: record.contentHash }];
  });
}

function label(value: string) {
  return value.replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());
}

function TeamDisclosure({ title, copy, button = title, children, onOpen }: { title: string; copy: string; button?: string; children: ReactNode; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  return <div className="work-row">
    <div className="work-row__body"><div><h3>{title}</h3><p className="work-meta">{copy}</p></div>
      <button type="button" className="work-button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) onOpen?.(); }}>{button}</button>
    </div>
    {open && <div className="work-stack">{children}</div>}
  </div>;
}

export function TeamBoard({ botId, onGoals }: { botId?: string; onGoals?: () => void }) {
  const userId = useStore(s => s.user?.id);
  const bots = useStore(s => s.bots);
  const [state, setState] = useState<TeamState | null>(null), [error, setError] = useState('');
  const [setting, setSetting] = useState(false), [settingError, setSettingError] = useState('');
  const [enabledReceipt, setEnabledReceipt] = useState<boolean>();
  const [readBusy, setReadBusy] = useState(false);
  const mutation = useRef(false);
  const lifetime = useWorkLifetime();
  const [revision, refresh] = useNativeRefresh();
  const connected = useStore(s => s.sseConnected);
  useEffect(() => {
    if (!userId || mutation.current) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && !mutation.current && useStore.getState().user?.id === userId;
    setReadBusy(true);
    teamApi.state(controller.signal).then(({ state: next }) => {
      if (!current()) return;
      if (next.userId !== userId) throw new Error('This snapshot does not match the current account.');
      setState(next); setError(''); setEnabledReceipt(undefined);
    }).catch(err => { if (current()) setError(err.message); })
      .finally(() => { if (current()) setReadBusy(false); });
    return () => controller.abort();
  }, [userId, revision, connected, setting]);
  const toggle = async (enabled: boolean) => {
    if (mutation.current || !userId) return;
    mutation.current = true; setSetting(true); setSettingError('');
    const current = () => lifetime.current && useStore.getState().user?.id === userId;
    try {
      const next = await teamApi.setCoordination(enabled);
      if (current()) setEnabledReceipt(next.enabled);
    } catch (err) {
      if (current()) setSettingError(`${(err as Error).message} Refresh the board to confirm the saved setting before trying again.`);
    } finally {
      mutation.current = false;
      if (current()) setSetting(false);
    }
  };
  const name = (id: string | null) => state?.agents.find(agent => agent.botId === id)?.name ?? bots.find(bot => bot.id === id)?.name ?? (id ? 'Unavailable bot' : 'Unassigned');
  const scoped = <Record extends { botId: string }>(records: Record[]) => records.filter(record => !botId || record.botId === botId);
  const workflows = state?.workflows.filter(workflow => !botId || workflow.botId === botId || workflow.tasks.some(task => task.workerBotId === botId || task.assignedBotId === botId)) ?? [];
  const healthy = state?.health;
  return <section className="team-board" aria-label="Team snapshot">
    {error && <p className="work-error" role="alert">{state ? 'Board could not refresh. Showing the last loaded records. ' : ''}{error}</p>}
    {!state && !error && <p role="status">Loading team state…</p>}
    {state && healthy && <>
      <div className="work-row">
        <h3>Team snapshot</h3><p className="work-meta">{new Date(state.generatedAt).toLocaleString()} · Runtime {label(healthy.runtime).toLowerCase()}{healthy.lastTickAt ? ` · Last check ${new Date(healthy.lastTickAt).toLocaleTimeString()}` : ' · No runtime check recorded'}</p>
        {healthy.lastError && <p className="work-error">Runtime: {healthy.lastError}</p>}
        <label className="team-coordination"><input type="checkbox" role="switch" checked={enabledReceipt ?? healthy.runtime !== 'disabled'} disabled={setting || readBusy || !!error} onChange={event => void toggle(event.currentTarget.checked)} /> Account coordination</label>
        <p className="work-meta">Applies to all Bots in this account. Turning coordination off keeps existing work and history visible.</p>
        {setting && <p role="status">Saving coordination preference…</p>}
        {settingError && <p className="work-error" role="alert">{settingError}</p>}
        {!!state.humanSources?.pending && !botId && <p className="work-meta">{state.humanSources.pending} user update(s) waiting for coordinator review.</p>}
        {Object.values(state.coverage ?? {}).some(coverage => coverage.omitted > 0) && <p className="work-meta">This snapshot is limited. More job records are available in work history.</p>}
      </div>
      {scoped(state.agents).map(agent => <div className="work-row" key={agent.botId}><div className="work-row__body">
        <div><h3>{agent.name}</h3><p className="work-meta">{agent.pendingDecision ? 'Waiting for your decision' : label(agent.status)}{agent.isPrimary ? ' · Coordinator' : agent.parentBotId ? ' · Temporary helper' : ''}{agent.observation === 'no_recent_progress_observed' ? ' · No recent progress recorded' : ''}</p></div>
        {bots.some(bot => bot.id === agent.botId) && <button className="work-button" type="button" aria-label={`Open ${agent.name} chat`} onClick={() => openWorkChat(agent.botId)}>Open chat</button>}
      </div></div>)}
      {!scoped(state.agents).length && <div className="work-row"><p className="work-meta">No team agents were observed in this scope.</p></div>}
      {scoped(state.goals ?? []).map(goal => <div className="work-row" key={goal.id}><h3>{goal.title}</h3><p className="work-meta">Goal {goalStatusLabel(goal).toLowerCase()} · Owner {name(goal.botId)}{goal.reason ? ` · ${goal.reason}` : ''}</p></div>)}
      {workflows.map(workflow => <article className="team-workflow" key={workflow.id}>
        <h3 className="work-title">{workflow.title}</h3><p className="work-meta">{label(workflow.status)} · Coordinator {name(workflow.botId)}{workflow.reason ? ` · ${workflow.reason}` : ''}</p>
        {workflow.tasks.map(task => {
          const copy = `${name(task.workerBotId ?? task.assignedBotId ?? workflow.botId)} · ${task.dependsOn.length ? `Depends on ${task.dependsOn.map(id => workflow.tasks.find(other => other.id === id)?.title ?? id).join(', ')}` : 'No prerequisites'} · ${label(task.status)}${task.resultValidated ? ' · Result validated' : ''}${task.reason ? ` · ${task.reason}` : ''}`;
          const evidence = task.evidence.length > 0;
          const job = state.jobs.find(record => record.id === task.activeJobId);
          return evidence || task.activeJobId ? <TeamDisclosure key={task.id} title={task.title} copy={copy} button={evidence ? 'Inspect evidence' : 'Current job'}>
            {evidence && <><SourceMessages sources={sources(task.evidence)} /><pre>{JSON.stringify(task.evidence, null, 2)}</pre></>}
            {task.activeJobId && <section className="work-stack" aria-label={`Current job for ${task.title}`}>
              <h4>Current job</h4>
              {job ? <><p className="work-meta">Assignee: {name(job.botId)}</p><p className="work-meta">Status: {label(job.state)}</p></> : <p className="work-meta">Not present in this snapshot. Assignee and status are unavailable.</p>}
              <p className="work-meta">Job <code>{task.activeJobId}</code></p>
              <h4>Prerequisites</h4>
              {task.dependsOn.length ? <ul>{task.dependsOn.map(id => {
                const prerequisite = workflow.tasks.find(other => other.id === id);
                return <li key={id}>{prerequisite ? `${prerequisite.title} · ${label(prerequisite.status)} · ${prerequisite.resultValidated ? 'Verified result' : 'No validated result recorded'}` : `${id} · Not present in this snapshot`}</li>;
              })}</ul> : <p className="work-meta">No prerequisites.</p>}
              <p className="work-meta">Result: {task.resultValidated ? 'Validated result recorded.' : 'No validated result recorded.'}</p>
            </section>}
          </TeamDisclosure> : <div className="work-row" key={task.id}><h4>{task.title}</h4><p className="work-meta">{copy} · No source evidence recorded.</p></div>;
        })}
      </article>)}
      {!workflows.length && <div className="work-row"><h3>Workflows</h3><p className="work-meta">No workflows in this view.</p></div>}
      {scoped(state.artifacts).map(artifact => <div className="work-row" key={artifact.id}><div className="work-row__body">
        <div><h3>{artifact.title}</h3><p className="work-meta">{name(artifact.botId)} · Saved report{state.deliveries.filter(delivery => delivery.artifactId === artifact.id).map(delivery => ` · Delivery: ${label(delivery.status)}`).join('')}</p></div>
        <a className="work-button" href={`/api/deliverables/artifacts/${encodeURIComponent(artifact.id)}/download`} download>Download report</a>
      </div></div>)}
      <TeamDisclosure title="Snapshot sources" copy="See which records this snapshot used."><p className="work-meta">Event cursor {state.eventCursor}. Records may change after this snapshot.</p><pre>{JSON.stringify(state.sourceVersions, null, 2)}</pre></TeamDisclosure>
      <InternalActivity botId={botId} />
      <WorkHistory name={name} botId={botId} />
    </>}
    <div className="work-actions is-stack"><button className="work-button is-primary" type="button" onClick={() => { setSettingError(''); refresh(); }} disabled={setting || readBusy}>{readBusy ? 'Refreshing board…' : 'Refresh board'}</button>
      {onGoals && <button className="work-button" type="button" onClick={onGoals}>Goals and workflows</button>}</div>
  </section>;
}

function WorkHistory({ name, botId }: { name: (id: string | null) => string; botId?: string }) {
  const [page, setPage] = useState<Awaited<ReturnType<typeof teamApi.records>> | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const lifetime = useWorkLifetime();
  const pending = useRef(false);
  const load = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const next = await teamApi.records('jobs', page?.nextCursor ?? 0, page?.through);
      if (lifetime.current) setPage(previous => ({ ...next, records: [...(previous?.records ?? []), ...next.records] }));
    } catch (err) { if (lifetime.current) setError((err as Error).message); }
    finally { pending.current = false; if (lifetime.current) setBusy(false); }
  };
  const records = page?.records.filter(record => !botId || all || record.bot_id === botId);
  return <TeamDisclosure title="Complete team work history" copy={botId && !all ? `See past jobs for ${name(botId)}.` : 'See past jobs across all Bots.'} onOpen={() => { if (!page) void load(); }}>
    {botId && <label className="team-coordination"><input type="checkbox" checked={all} onChange={event => setAll(event.currentTarget.checked)} /> Show all Bots in work history</label>}
    {error && <p className="work-error" role="alert">{error}</p>}
    {records?.length === 0 && <p className="work-meta">{page?.hasMore ? 'No matching work in the pages loaded so far.' : 'No past work recorded in this scope.'}</p>}
    {records?.map(record => <div key={record.id}><strong>{name(record.bot_id ?? null)} · {label(record.state ?? 'unknown')}</strong>{record.created_at && <p className="work-meta">{new Date(record.created_at).toLocaleString()}</p>}</div>)}
    {(!page || page.hasMore) && <button type="button" className="work-button" disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : error ? 'Retry work history' : 'Load more work'}</button>}
  </TeamDisclosure>;
}

function InternalActivity({ botId }: { botId?: string }) {
  const [opened, setOpened] = useState(false), [pages, setPages] = useState(1);
  const [data, setData] = useState<Awaited<ReturnType<typeof teamApi.requests>> | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useNativeRefresh();
  const bots = useStore(s => s.bots);
  useEffect(() => {
    if (!opened) return;
    let active = true;
    setBusy(true);
    (async () => {
      let response = await teamApi.requests(0, botId);
      for (let page = 1; page < pages && response.hasMore; page++) {
        const next = await teamApi.requests(response.nextCursor, botId);
        response = { ...next, requests: [...response.requests, ...next.requests] };
      }
      if (active) { setData(response); setError(''); }
    })().catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [opened, botId, pages, revision]);
  const name = (id: string) => bots.find(bot => bot.id === id)?.name ?? 'Unavailable bot';
  return <TeamDisclosure title="Internal team activity" copy="Read assignments and their recorded results." onOpen={() => setOpened(true)}>
    <p className="work-meta">Admission means work was accepted; completion is recorded separately.</p>
    {error && <p className="work-error" role="alert">{error} <button className="work-button" type="button" onClick={refresh}>Refresh activity</button></p>}
    {!data && !error && <p role="status">Loading activity…</p>}
    {data?.requests.length === 0 && <p>No internal exchanges recorded.</p>}
    {data?.requests.map(record => <details key={record.id}><summary>{name(record.fromBotId)} → {name(record.toBotId)} · {record.kind} · {record.status}</summary><p>{record.text}</p>{record.reason && <p>{record.reason}</p>}{record.result && <p>{record.result}</p>}<small title={`Reference for support: request ${record.id}, correlation ${record.correlationId}${record.jobId ? `, job ${record.jobId}` : ''}`}>{new Date(record.updatedAt).toLocaleString()}</small></details>)}
    {data?.hasMore && <button type="button" className="work-button" disabled={busy} onClick={() => setPages(count => count + 1)}>{busy ? 'Loading…' : 'Load more exchanges'}</button>}
  </TeamDisclosure>;
}
