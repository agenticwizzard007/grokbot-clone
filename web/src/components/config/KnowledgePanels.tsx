import { useEffect, useRef, useState } from 'react';
import { configApi, type KnowledgeMemory, type KnowledgeSkill, type MessageSource, type SkillProposal, type SkillRevision, type SourceMessage, type SkillEvaluation } from '../../lib/configApi';
import { learningApi } from '../../lib/learningApi';
import { conversationSourcePath, knowledgeUiApi, type ConversationFilters, type ConversationPage } from '../../lib/knowledgeUiApi';
import { useStore } from '../../store';
import { useBotSettingsDraft } from '../../configStore';
import { shortDate } from './ui';

export function SourceMessages({ sources }: { sources: MessageSource[] }) {
  const userId = useStore(state => state.user?.id);
  const scope = JSON.stringify([userId, sources.map(source => conversationSourcePath(source))]);
  return <SourceMessageReader key={scope} sources={sources} userId={userId} />;
}

function SourceMessageReader({ sources, userId }: { sources: MessageSource[]; userId?: string }) {
  const [messages, setMessages] = useState<SourceMessage[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const read = async (source: MessageSource) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && useStore.getState().user?.id === userId;
    setBusy(true); setError(''); setMessages(null);
    try {
      const value = await knowledgeUiApi.source(source, controller.signal);
      if (current()) setMessages(value.messages.filter(message => message.botId === source.botId && message.generation === source.generation));
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(false); }
  };
  return <div className="cfg-field__hint">
    {sources.map(source => <button type="button" className="cfg-btn cfg-btn--secondary knowledge-source__open" key={conversationSourcePath(source)} onClick={() => void read(source)}>{source.kind === 'tool' ? 'Open tool source' : 'Open conversation source'} {source.generation}:{source.seq}</button>)}
    {busy && <span role="status">Loading sources…</span>}
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {messages && <div className="cfg-editor">
      <button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setMessages(null)}>Close sources</button>
      <h4>Conversation excerpt</h4>
      {messages.length === 0 && <p>No longer available.</p>}
      {messages.map(m => <div key={m.sourceKey} style={{ marginTop: 10 }}>
        <strong>{m.from && ['bot', 'routine'].includes(m.from.kind) ? `${m.from.kind}: ${m.from.name}` : m.role === 'user' ? 'User' : m.role === 'tool' ? 'Tool observation' : 'Assistant'} · {m.generation}:{m.seq}{m.archived ? ' · Archived conversation' : ''}</strong>
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</div>
      </div>)}
    </div>}
  </div>;
}

export function SkillHistory({ skill, onChange }: { skill: KnowledgeSkill; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<SkillRevision[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    configApi.skillHistory(skill.id).then(r => { if (active) setRevisions(r.revisions); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [open, skill.id, skill.revision]);
  const restore = async (revision: number) => {
    setBusy(true); setError('');
    try { await configApi.rollbackSkill(skill.id, revision, skill.revision); onChange(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div>
    <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide history' : `History · revision ${skill.revision}`}</button>
    {open && <div className="cfg-editor">
      {error && <div className="cfg-error" role="alert">{error}</div>}
      <div className="cfg-field__hint">Restoring a version adds a new revision and preserves the history.</div>
      {revisions.map(r => <details key={r.revision}>
        <summary>Revision {r.revision} · {r.action} · {shortDate(r.createdAt)}{r.deleted ? ' · Deleted' : ''}</summary>
        <div>{r.name} · {r.description}</div>
        {r.promotion&&<div><p>Automatically promoted under policy revision {r.promotion.policyRevision}. Rollback target: revision {r.promotion.rollback.revision}.</p><EvaluationResults evaluations={r.promotion.evaluations??[]} /></div>}
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{r.body}</pre>
        {r.resources && Object.entries(r.resources).map(([path, content]) => <details key={path}><summary>{path}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content}</pre></details>)}
        {(r.pinned || r.locked || r.scope) && <p className="cfg-field__hint">{r.pinned ? 'Pinned · ' : ''}{r.locked ? 'Locked · ' : ''}{r.scope ?? 'private'}</p>}
        <SourceMessages sources={r.evidence} />
        {r.revision !== skill.revision && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void restore(r.revision)}>{busy ? 'Restoring…' : `Restore revision ${r.revision}`}</button>}
      </details>)}
      <ProcedurePolicy skill={skill} onChange={onChange} />
    </div>}
  </div>;
}

function EvaluationResults({evaluations}:{evaluations:SkillEvaluation[]}) {
 return <>{evaluations.map(e=><details key={e.id}><summary>Evaluation: {e.status} · {e.results.length} frozen cases</summary><p>{e.reason}</p><p className="cfg-field__hint">Policy {e.policyRevision} · Settings {e.settingsRevision} · {e.evaluator}</p>{e.results.map(r=><p key={r.id}>{r.id} ({r.category}): {r.passed?'passed':'failed'} · expected {r.expected}, observed {r.actual} · baseline {r.baseline}</p>)}<p className="cfg-field__hint" style={{overflowWrap:'anywhere'}}>Candidate {e.candidateHash}<br/>Sources {e.sourceHash}<br/>Rollback baseline {e.baseHash}</p></details>)}</>;
}
function ProcedurePolicy({skill,onChange}:{skill:KnowledgeSkill;onChange:()=>void}) {
 const [view,setView]=useState<{revision:number;policy:Record<string,unknown>}|null>(null),[draft,setDraft]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;learningApi.promotionPolicy(skill.id).then(r=>{if(active){setView(r.standingPolicy);setDraft(r.standingPolicy?JSON.stringify(r.standingPolicy.policy,null,2):'');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[skill.id]);
 const save=async()=>{setBusy(true);setError('');try{const r=await learningApi.savePromotionPolicy(skill.id,view?.revision??0,JSON.parse(draft));setView(r.standingPolicy);setNotice('Standing policy saved. Existing candidates require a fresh review.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <details><summary>Automatic improvement policy{view?` · revision ${view.revision}`:' · owner review required'}</summary><p>Automatic improvements require an approved responsibility and at least five frozen cases covering the triggering defect, existing behavior, an out-of-scope case and a failure case. Only pure decision tables support automatic evaluation; prose changes wait for review.</p><p>Cases and allowed outcomes are owner decisions. Labels cannot change recipients, schedules, budgets, permissions or sharing.</p>{error&&<p role="alert" className="cfg-error">{error}</p>}{notice&&<p role="status">{notice}</p>}<label>Standing policy and frozen cases<textarea aria-label="Standing policy and frozen cases" className="text-input cfg-textarea" rows={12} value={draft} onChange={e=>setDraft(e.currentTarget.value)} placeholder={'{"enabled":false,"responsibility":"report_triage","allowedOutcomes":["review","failure","out_of_scope"],"cases":[]}'} /></label><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy||!draft} onClick={()=>void save()}>Save standing policy</button>{view&&<button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={()=>{setBusy(true);learningApi.recheck(skill.id,skill.revision).then(r=>{setNotice(`Procedure check: ${r.action.replaceAll('_',' ')}.`);onChange();}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>Check current procedure</button>}</details>;
}

export function SkillReview({ botId, version, onChange }: { botId: string; version: string; onChange: () => void }) {
  const [proposals, setProposals] = useState<SkillProposal[] | null>(null);
  const [archive, setArchive] = useState<KnowledgeSkill[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true; setError('');
    Promise.all([configApi.skillProposals(botId), learningApi.skills(botId, true)]).then(([p, a]) => {
      if (active) { setProposals(p.proposals); setArchive(a.skills.filter(s => s.deleted && s.botId === botId)); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [botId, version, refresh]);
  const review = async (p: SkillProposal, decision: 'approve' | 'reject' | 'evaluate') => {
    if (busy || p.status !== 'pending') return;
    setBusy(p.id); setError('');
    try {
      if (decision === 'evaluate') await learningApi.evaluateProposal(p.id);
      else await configApi.reviewSkill(p.id, decision, p.baseRevision);
      setRefresh(r => r + 1); onChange();
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const pending = proposals?.filter(proposal => proposal.status === 'pending') ?? [];
  const reviewed = proposals?.filter(proposal => proposal.status !== 'pending') ?? [];
  const proposalRow = (proposal: SkillProposal) => <details className="native-history" key={proposal.id}>
    <summary>{proposal.content.name} · {proposal.baseRevision ? `Base revision ${proposal.baseRevision}` : 'New skill'} · {proposal.status}</summary>
    <p>{proposal.reason}</p>
    {proposal.status === 'pending' && <p className="native-meta">The current skill stays active until a change is approved.</p>}
    <pre aria-label="Proposed skill diff" className="knowledge-item__diff">{proposal.diff}</pre>
    <details><summary>Proposal evaluation</summary><EvaluationResults evaluations={proposal.evaluations ?? []} />
      {proposal.status === 'pending' && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void review(proposal, 'evaluate')}>Evaluate frozen proposal</button>}
    </details>
    <SourceMessages sources={proposal.evidence} />
    {proposal.status === 'pending' && <div className="cfg-editor__actions">
      <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void review(proposal, 'reject')}>Reject</button>
      <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy} onClick={() => void review(proposal, 'approve')}>{busy === proposal.id ? 'Updating…' : 'Approve'}</button>
    </div>}
  </details>;
  return <div>
    {error && <div className="cfg-error" role="alert">{error} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setRefresh(value => value + 1)}>Refresh skill changes</button></div>}
    <details className="knowledge-item">
      <summary className="knowledge-item__row"><span><strong>Learned skill changes</strong><small>{pending.length ? `${pending.length} pending review.` : proposals ? 'No pending proposals.' : 'Review proposed steps and sources.'}</small></span><span className="knowledge-item__action">Review changes</span></summary>
      {!proposals && !error && <p role="status">Loading proposed changes…</p>}
      {pending.map(proposalRow)}
      {!!reviewed.length && <details className="knowledge-item__details"><summary>Earlier skill proposals ({reviewed.length})</summary>{reviewed.map(proposalRow)}</details>}
    </details>
    <details className="knowledge-item"><summary className="knowledge-item__row"><span><strong>Deleted skills</strong><small>Find archived procedures and their history.</small></span><span className="knowledge-item__action">Show deleted skills</span></summary>
      {!archive.length && proposals && <p>No archived skills.</p>}
      {archive.map(s => <div className="cfg-editor" key={s.id}><strong>{s.name}</strong><SkillHistory skill={s} onChange={() => { setRefresh(r => r + 1); onChange(); }} /></div>)}
    </details>
  </div>;
}

export function MemoryEvidence({ memory, onChange }: { memory: KnowledgeMemory; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ action: string; memory: KnowledgeMemory; createdAt: number }[] | null>(null);
  useBotSettingsDraft(`memory:${memory.id}`, 'Memories', editing && !busy && text.trim() !== memory.text);
  const correct = async () => {
    setBusy(true); setError('');
    try { await configApi.correctMemory(memory.id, text, memory.revision); setEditing(false); onChange(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div>
    {memory.evidence.length ? <SourceMessages sources={memory.evidence} /> : <div className="cfg-field__hint">{memory.supersedes ? 'Corrected by you' : 'No saved source (legacy memory)'}</div>}
    <div className="cfg-editor__actions">
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing(!editing)}>Correct</button>
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { if (history) setHistory(null); else configApi.memoryHistory(memory.id).then(r => setHistory(r.events)).catch(e => setError(e.message)); }}>{history ? 'Hide history' : 'History'}</button>
    </div>
    {history && history.map((e, i) => <div key={i} className="cfg-field__hint">{e.action} · {shortDate(e.createdAt)} · {e.memory.text}</div>)}
    {editing && <form className="cfg-editor" onSubmit={e => { e.preventDefault(); void correct(); }}>
      <textarea className="text-input cfg-textarea" value={text} maxLength={1000} onChange={e => setText(e.target.value)} aria-label="Corrected memory" />
      <div className="cfg-field__hint">The earlier fact stays in history and is excluded from future recall.</div>
      <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !text.trim() || text.trim() === memory.text}>{busy ? 'Saving…' : 'Save correction'}</button>
    </form>}
    {error && <div className="cfg-error" role="alert">{error}</div>}
  </div>;
}

export function ConversationSearch({ botId, expanded = false }: { botId: string; expanded?: boolean }) {
  const userId = useStore(state => state.user?.id);
  return <ConversationSearchForm key={JSON.stringify([userId, botId])} botId={botId} userId={userId} expanded={expanded} />;
}

function ConversationSearchForm({ botId, userId, expanded }: { botId: string; userId?: string; expanded: boolean }) {
  const [filters, setFilters] = useState<ConversationFilters>({ query: '', role: '', generation: '' });
  const [result, setResult] = useState<(ConversationPage & { filters: ConversationFilters }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'search' | 'more' | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const search = async (submitted: ConversationFilters, offset = 0) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && useStore.getState().user?.id === userId;
    setBusy(offset ? 'more' : 'search'); setError('');
    if (!offset) setResult(null);
    try {
      const value = await knowledgeUiApi.search(botId, submitted, offset, controller.signal);
      if (!current()) return;
      const messages = value.messages.filter(message => message.botId === botId && (!submitted.generation || message.generation === Number(submitted.generation)) && (!submitted.role || message.role === submitted.role));
      setResult(previous => ({ filters: submitted,
        nextOffset: value.nextOffset != null && value.nextOffset > offset && value.nextOffset <= 10000 ? value.nextOffset : null,
        messages: [...new Map([...(offset ? previous?.messages ?? [] : []), ...messages].map(message => [message.sourceKey, message])).values()],
      }));
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(null); }
  };
  const content = <>
    <p className="native-meta">Find evidence in current or archived chats. Saved tool observations can be opened from their linked records.</p>
    <form className="knowledge-source__filters" onSubmit={event => { event.preventDefault(); void search(filters); }}>
      <label>Search conversation sources<input className="text-input" value={filters.query} maxLength={500} onChange={event => setFilters({ ...filters, query: event.target.value })} placeholder="Words from a past conversation" /></label>
      <div className="learning-grid">
        <label>Message role<select value={filters.role} onChange={event => setFilters({ ...filters, role: event.target.value as ConversationFilters['role'] })}>
          <option value="">All messages</option><option value="user">Human</option><option value="assistant">Assistant</option>
        </select></label>
        <label>Conversation generation<input className="text-input" type="number" min="1" step="1" placeholder="All conversations" value={filters.generation} onChange={event => setFilters({ ...filters, generation: event.target.value })} /></label>
      </div>
      <button type="submit" className="cfg-btn cfg-btn--primary">Search</button>
    </form>
    {busy && <p role="status">{busy === 'more' ? 'Loading older sources…' : 'Searching conversation sources…'}</p>}
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {result?.messages.length === 0 && <p role="status">No messages match.</p>}
    {result?.messages.map(message => <article key={message.sourceKey} className="knowledge-source__result">
      <strong>{message.archived ? 'Archived conversation' : 'Current conversation'} · {message.generation}:{message.seq}</strong>
      <p>{message.text}</p><SourceMessages sources={[message]} />
    </article>)}
    {result && result.nextOffset !== null && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void search(result.filters, result.nextOffset ?? 0)}>{error ? 'Retry older sources' : 'Load older sources'}</button>}
    {result && result.nextOffset === null && result.messages.length > 0 && <p className="native-meta" role="status">No more matching sources.</p>}
  </>;
  return expanded ? <section className="knowledge-source" aria-label="Conversation source search">{content}</section>
    : <details className="knowledge-source"><summary>Conversation sources</summary>{content}</details>;
}

export function MemoryArchive({ botId, version }: { botId: string; version: string }) {
  const [open, setOpen] = useState(false);
  const [memories, setMemories] = useState<KnowledgeMemory[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError('');
    configApi.knowledgeMemories(botId, true).then(r => { if (active) setMemories(r.memories.filter(m => m.botId === botId && m.status !== 'active')); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [botId, open, version, attempt]);
  return <div className="knowledge-item"><div className="knowledge-item__row"><div><strong>Earlier and forgotten memories</strong><p>See facts that are no longer used.</p></div><button className="cfg-btn cfg-btn--secondary" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide earlier facts' : 'Show earlier facts'}</button></div>
    {open && <div className="cfg-editor"><div className="cfg-field__hint">These facts are excluded from recall. Forgotten facts cannot be relearned from these sources.</div>
      {error && <div className="cfg-error" role="alert">{error} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
      {!memories && !error && <p role="status">Loading earlier facts…</p>}
      {memories?.length === 0 && <div>No earlier facts.</div>}
      {memories?.map(m => <div key={m.id}><span className="cfg-chip">{m.status}</span> {m.text}<SourceMessages sources={m.evidence} /></div>)}
    </div>}
  </div>;
}
