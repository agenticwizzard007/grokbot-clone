import { useEffect, useState } from 'react';
import { configApi, type KnowledgeMemory, type KnowledgeSkill, type MessageSource, type SkillProposal, type SkillRevision, type SourceMessage } from '../../lib/configApi';
import { learningApi } from '../../lib/learningApi';
import { shortDate } from './ui';

export function SourceMessages({ sources }: { sources: MessageSource[] }) {
  const [messages, setMessages] = useState<SourceMessage[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const read = async (source: MessageSource) => {
    setBusy(true); setError('');
    try { setMessages((await configApi.sourceMessages(source)).messages); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="cfg-field__hint">
    {sources.map(s => <a key={`${s.botId}:${s.generation}:${s.seq}:${s.kind ?? 'message'}`} href={`/api/bots/${encodeURIComponent(s.botId)}/messages/${s.generation}/${s.seq}${s.kind ? '?kind=tool' : ''}`} onClick={e => { e.preventDefault(); void read(s); }} style={{ marginRight: 10 }}>{s.kind === 'tool' ? 'Tool source' : 'Source'} {s.generation}:{s.seq}</a>)}
    {busy && <span role="status">Loading sources…</span>}
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {messages && <div className="cfg-editor">
      <button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setMessages(null)}>Close sources</button>
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
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{r.body}</pre>
        {r.resources && Object.entries(r.resources).map(([path, content]) => <details key={path}><summary>{path}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content}</pre></details>)}
        {(r.pinned || r.locked || r.scope) && <p className="cfg-field__hint">{r.pinned ? 'Pinned · ' : ''}{r.locked ? 'Locked · ' : ''}{r.scope ?? 'private'}</p>}
        <SourceMessages sources={r.evidence} />
        {r.revision !== skill.revision && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void restore(r.revision)}>{busy ? 'Restoring…' : `Restore revision ${r.revision}`}</button>}
      </details>)}
    </div>}
  </div>;
}

export function SkillReview({ botId, version, onChange }: { botId: string; version: string; onChange: () => void }) {
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [archive, setArchive] = useState<KnowledgeSkill[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true; setError('');
    Promise.all([configApi.skillProposals(botId), learningApi.skills(botId, true)]).then(([p, a]) => {
      if (active) { setProposals(p.proposals.filter(p => p.status === 'pending')); setArchive(a.skills.filter(s => s.deleted)); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [botId, version, refresh]);
  const review = async (p: SkillProposal, decision: 'approve' | 'reject') => {
    setBusy(p.id); setError('');
    try { await configApi.reviewSkill(p.id, decision, p.baseRevision); setRefresh(r => r + 1); onChange(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  return <div>
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {proposals.length > 0 && <div className="cfg-editor">
      <strong>Learned skills awaiting review ({proposals.length})</strong>
      <div className="cfg-field__hint">Review the proposed steps and sources before they become active.</div>
      {proposals.map(p => <details key={p.id}>
        <summary>{p.content.name} · {p.baseRevision ? `Updates revision ${p.baseRevision}` : 'New skill'}</summary>
        <p>{p.reason}</p>
        <pre aria-label="Proposed skill diff" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{p.diff}</pre>
        <SourceMessages sources={p.evidence} />
        <div className="cfg-editor__actions">
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void review(p, 'reject')}>Reject</button>
          <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy} onClick={() => void review(p, 'approve')}>{busy === p.id ? 'Reviewing…' : 'Approve'}</button>
        </div>
      </details>)}
    </div>}
    {archive.length > 0 && <details><summary>Deleted skills ({archive.length})</summary>{archive.map(s => <div className="cfg-editor" key={s.id}><strong>{s.name}</strong><SkillHistory skill={s} onChange={() => { setRefresh(r => r + 1); onChange(); }} /></div>)}</details>}
  </div>;
}

export function MemoryEvidence({ memory, onChange }: { memory: KnowledgeMemory; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ action: string; memory: KnowledgeMemory; createdAt: number }[] | null>(null);
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

export function ConversationSearch({ botId }: { botId: string }) {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<SourceMessage[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const search = async () => {
    setBusy(true); setError('');
    try { setMessages((await configApi.searchConversations(botId, query)).messages); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <details className="cfg-editor"><summary>Search conversation sources, including archived chats</summary>
    <form onSubmit={e => { e.preventDefault(); void search(); }}>
      <input className="text-input" value={query} maxLength={500} onChange={e => setQuery(e.target.value)} aria-label="Search conversation sources" placeholder="Words from a past conversation" />
      <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
    </form>
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {messages?.length === 0 && <div className="cfg-field__hint">No messages match.</div>}
    {messages?.map(m => <div key={m.sourceKey} className="cfg-editor"><div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div><SourceMessages sources={[m]} /></div>)}
  </details>;
}

export function MemoryArchive({ botId, version }: { botId: string; version: string }) {
  const [open, setOpen] = useState(false);
  const [memories, setMemories] = useState<KnowledgeMemory[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    configApi.knowledgeMemories(botId, true).then(r => { if (active) setMemories(r.memories.filter(m => m.status !== 'active')); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [botId, open, version]);
  return <div><button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setOpen(!open)}>{open ? 'Hide earlier facts' : 'Earlier and forgotten facts'}</button>
    {open && <div className="cfg-editor"><div className="cfg-field__hint">These facts are excluded from recall. Forgotten facts cannot be relearned from these sources.</div>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {!memories.length && <div>No earlier facts.</div>}
      {memories.map(m => <div key={m.id}><span className="cfg-chip">{m.status}</span> {m.text}<SourceMessages sources={m.evidence} /></div>)}
    </div>}
  </div>;
}
