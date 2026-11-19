import { useEffect, useState } from 'react';
import type { Bot, CoworkerSetupView } from '@shared/types';
import { configApi } from '../lib/configApi';
import { useVersion } from '../configStore';
import './coworker-setup.css';

/** Human review stays in the coordinator conversation; activation pins the visible revision. */
export function CoworkerSetupCards({ coordinator }: { coordinator: Bot }) {
  const version = useVersion(`setup:${coordinator.id}`);
  const [setups, setSetups] = useState<CoworkerSetupView[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    configApi.coworkerSetups(coordinator.id).then(data => { if (current) { setSetups(data.setups); setError(null); } }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [coordinator.id, version, refresh]);
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === 'setup' || detail.type === 'roster') setRefresh(v => v + 1);
    };
    window.addEventListener('swarm:event', update);
    return () => window.removeEventListener('swarm:event', update);
  }, []);
  if (!setups.length && !error && !confirmation) return null;
  return <section className="coworker-setups" aria-label="Coworker setup reviews">
    {confirmation && <p role="status">{confirmation}</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setRefresh(v => v + 1)}>Retry coworker setups</button></p>}
    {setups.map(setup => <CoworkerSetupCard key={setup.botId} coordinatorId={coordinator.id} setup={setup} onRefresh={() => setRefresh(v => v + 1)} onActivated={() => { setConfirmation(`${setup.manifest.bot.name} activated.`); setRefresh(v => v + 1); }} />)}
  </section>;
}

function CoworkerSetupCard({ coordinatorId, setup, onRefresh, onActivated }: { coordinatorId: string; setup: CoworkerSetupView; onRefresh: () => void; onActivated: () => void }) {
  const [review, setReview] = useState<CoworkerSetupView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);
  const displayed = review ?? setup;
  const { brief, bot, source } = displayed.manifest;
  const stale = !!review && review.onboarding.revision !== setup.onboarding.revision;
  const activate = async () => {
    if (!review) return;
    setBusy(true); setError(null);
    try { await configApi.activateSetup(setup.botId, review.onboarding.revision, coordinatorId); setActivated(true); onActivated(); }
    catch (e) { setError((e as Error).message); onRefresh(); }
    finally { setBusy(false); }
  };
  if (activated) return <p role="status">{bot.name} activated.</p>;
  return <article className="coworker-setup" aria-label={`${bot.name} setup`}>
    <div className="coworker-setup__heading"><strong>{bot.name}</strong><span>Revision {displayed.onboarding.revision} · {displayed.onboarding.status === 'review' ? 'Ready for review' : 'Needs your input'}</span></div>
    <p>{brief.purpose}</p>
    {!!displayed.onboarding.missing.length && <div><strong>Decisions to finish here</strong><ul>{displayed.onboarding.missing.map((question, i) => <li key={i}>{question}</li>)}</ul></div>}
    <p className="coworker-setup__readiness">{setup.computer.status === 'ready' ? 'Computer ready. App access and approval rules still apply.' : 'Computer preparation pending. Work waits for readiness.'}</p>
    {!review ? <button type="button" onClick={() => { setReview(setup); setError(null); }}>Review {bot.name} configuration</button> : <>
      <dl><dt>Responsibilities</dt><dd><ul>{brief.responsibilities.map((v, i) => <li key={i}>{v}</li>)}</ul></dd><dt>Expected results</dt><dd><ul>{brief.success_criteria.map((v, i) => <li key={i}>{v}</li>)}</ul></dd><dt>Action boundaries</dt><dd>{brief.action_boundaries || 'Needs your decision'}</dd><dt>Out of scope</dt><dd>{brief.out_of_scope.join('; ') || 'None specified'}</dd><dt>Standing instructions</dt><dd>{bot.instructions || 'Follow the saved brief'}</dd></dl>
      {brief.workflows.map((workflow, i) => <div key={i}><strong>{workflow.name}</strong><p>Starts when: {workflow.trigger}</p><ol>{workflow.steps.map((v, j) => <li key={j}>{v}</li>)}</ol><p>Produces: {workflow.output}</p></div>)}
      <dl><dt>Resources</dt><dd>{brief.shared_resources.join('; ') || 'None specified'}</dd><dt>Handoffs</dt><dd>{brief.handoff_notes.join('; ') || 'Report to the assigning coworker'}</dd><dt>Context</dt><dd>{brief.context_summary}</dd><dt>Working style</dt><dd>{brief.communication_style}<ul>{brief.working_principles.map((v, i) => <li key={i}>{v}</li>)}</ul></dd></dl>
      <details><summary>Original user answers</summary>{source?.sourceRefs?.map(ref => <blockquote key={`${ref.botId}:${ref.generation}:${ref.seq}`}><p>{ref.text}</p><small>{ref.botId} · Conversation {ref.generation}, message {ref.seq}</small></blockquote>)}{!source?.sourceRefs?.length && source?.messages.map(m => <blockquote key={m.seq}><p>{m.text}</p><small>Message {m.seq}</small></blockquote>)}</details>
      {stale && <p role="status">The configuration changed. Review the latest revision before activating.</p>}
      {stale && <button type="button" onClick={() => { setReview(setup); setError(null); }}>Review latest revision</button>}
      {displayed.onboarding.status === 'review' && <button type="button" disabled={busy || stale || !!displayed.onboarding.missing.length} onClick={activate}>{busy ? 'Activating…' : `Activate ${bot.name} · revision ${displayed.onboarding.revision}`}</button>}
      <button type="button" onClick={() => { setReview(null); setError(null); }} disabled={busy}>Close review</button>
      {error && <p role="alert">{error}</p>}
    </>}
  </article>;
}
