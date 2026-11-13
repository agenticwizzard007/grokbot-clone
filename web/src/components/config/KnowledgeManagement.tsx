import { useEffect, useState } from 'react';
import { learningApi, type KnowledgeScope, type LearningSkill, type MemoryChange, type ScopedKnowledge } from '../../lib/learningApi';
import { useNativeRefresh } from '../../lib/useNativeRefresh';
import { useStore } from '../../store';
import { SourceMessages } from './KnowledgePanels';
import './native-learning.css';

export function KnowledgeScopeControl({ kind, item, onChange }: { kind: 'skills' | 'memories'; item: { id: string; revision: number; botId: string } & Partial<ScopedKnowledge>; onChange: () => void }) {
  const [open, setOpen] = useState(false), [scope, setScope] = useState<KnowledgeScope>(item.scope ?? 'private');
  const [project, setProject] = useState(item.projectId ?? ''), [botIds, setBotIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const bots = useStore(s => s.bots);
  useEffect(() => { setScope(item.scope ?? 'private'); setProject(item.projectId ?? ''); }, [item.scope, item.projectId, item.revision]);
  const save = async () => {
    setBusy(true); setError('');
    try { await learningApi.scope(kind, item.id, item.revision, scope, project.trim(), botIds); setOpen(false); onChange(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div>
    <button type="button" className="cfg-btn cfg-btn--secondary" aria-expanded={open} onClick={() => setOpen(v => !v)}>Sharing: {item.scope === 'account' ? 'Account' : item.scope === 'project' ? `Project ${item.projectId ?? ''}` : 'Private to this Bot'}</button>
    {open && <form className="knowledge-scope" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>Knowledge visibility<select aria-label="Knowledge visibility" value={scope} onChange={e => setScope(e.currentTarget.value as KnowledgeScope)}><option value="private">Private to this Bot</option><option value="project">Selected Bots in a project</option><option value="account">All Bots in this account</option></select></label>
      <p className="native-meta">{scope === 'private' ? 'Revokes shared access for future context and reads.' : scope === 'account' ? 'Publishes this knowledge to all current and future Bots in this account.' : 'Publishes this knowledge only to the explicitly selected Bots. Select the complete replacement grant list.'} Sharing knowledge does not publish private conversations.</p>
      {scope === 'project' && <><label>Project identifier<input required value={project} onChange={e => setProject(e.currentTarget.value)} /></label><label>Bots with project access<select aria-label="Bots with project access" multiple required value={botIds} onChange={e => setBotIds(Array.from(e.currentTarget.selectedOptions, o => o.value))}>{bots.filter(b => b.kind !== 'room').map(b => <option key={b.id} value={b.id}>{b.name}{b.id === item.botId ? ' (owner)' : ''}</option>)}</select></label></>}
      {error && <p role="alert" className="cfg-error">{error}</p>}
      <div className="learning-actions"><button className="cfg-btn cfg-btn--primary" disabled={busy || (scope === 'project' && (!project.trim() || !botIds.length))} type="submit">{busy ? 'Saving…' : 'Save sharing'}</button><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>}
  </div>;
}

export function SkillPackageControls({ skillId, revision, onChange }: { skillId: string; revision: number; onChange: () => void }) {
  const [open, setOpen] = useState(false), [skill, setSkill] = useState<LearningSkill | null>(null);
  const [resources, setResources] = useState<{ path: string; text: string }[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0), [archive, setArchive] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true; setError('');
    learningApi.skill(skillId).then(r => { if (active) { setSkill(r.skill); setResources(Object.entries(r.skill.resources).map(([path, text]) => ({ path, text }))); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [open, skillId, revision, attempt]);
  const mutate = async (run: (s: LearningSkill) => Promise<{ skill: LearningSkill }>) => {
    if (!skill) return;
    setBusy(true); setError(''); setNotice('');
    try { const next = await run(skill); setSkill(next.skill); setNotice(`Saved package revision ${next.skill.revision}.`); setArchive(false); onChange(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const invalid = resources.some(r => !/^(references|templates|scripts)\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\s\\]+$/.test(r.path)) || new Set(resources.map(r => r.path)).size !== resources.length;
  return <div className="native-panel">
    <button type="button" className="cfg-btn cfg-btn--secondary" aria-expanded={open} onClick={() => setOpen(v => !v)}>Package resources and protections</button>
    {open && <div className="package-editor">
      {error && <p role="alert" className="cfg-error">{error} <button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setAttempt(n => n + 1)}>Reload package</button></p>}
      {!skill && !error && <p role="status">Loading package…</p>}
      {skill && <>
        <p className="native-meta">Revision {skill.revision} · {{ active: 'Active', stale: 'Stale', archived: 'Archived' }[skill.lifecycle ?? (skill.deleted ? 'archived' : 'active')]} · {skill.managed ? 'Managed' : 'Owner maintained'}{skill.lastUsedAt ? ` · Last used ${new Date(skill.lastUsedAt).toLocaleString()}` : ' · No use recorded'}</p>
        <div className="learning-actions"><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void mutate(s => learningApi.updateSkill(s.id, { expectedRevision: s.revision, pinned: !s.pinned }))}>{skill.pinned ? 'Unpin' : 'Pin'} package</button><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void mutate(s => learningApi.updateSkill(s.id, { expectedRevision: s.revision, locked: !s.locked }))}>{skill.locked ? 'Unlock' : 'Lock'} agent edits</button><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void mutate(s => learningApi.updateSkill(s.id, { expectedRevision: s.revision, managed: !s.managed }))}>{skill.managed ? 'Exclude from maintenance' : 'Include in maintenance'}</button></div>
        <p className="native-meta">Pinned packages are protected from maintenance. A lock blocks agent changes; you can unlock it here.</p>
        <KnowledgeScopeControl kind="skills" item={skill} onChange={() => { setAttempt(n => n + 1); onChange(); }} />
        <form className="learning-fields" onSubmit={e => { e.preventDefault(); if (!invalid) void mutate(s => learningApi.updateSkill(s.id, { expectedRevision: s.revision, resources: Object.fromEntries(resources.map(r => [r.path, r.text])) })); }}>
          <h3>Package resources</h3><p className="native-meta">References, templates and scripts are versioned with the instructions. Saving a script does not run it.</p>
          {resources.map((r, i) => <div className="resource-row" key={i}><label>Resource path<input required value={r.path} placeholder="references/sources.md" onChange={e => { const path = e.currentTarget.value; setResources(rows => rows.map((row, n) => n === i ? { ...row, path } : row)); }} /></label><label>Resource content<textarea value={r.text} onChange={e => { const text = e.currentTarget.value; setResources(rows => rows.map((row, n) => n === i ? { ...row, text } : row)); }} /></label><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setResources(rows => rows.filter((_, n) => n !== i))}>Remove resource</button></div>)}
          {invalid && <p role="alert" className="cfg-error">Use unique relative paths under references/, templates/ or scripts/, without parent directory segments.</p>}
          <div className="learning-actions"><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setResources(rows => [...rows, { path: '', text: '' }])}>Add resource</button><button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || invalid}>Save resources</button></div>
        </form>
        {!skill.deleted && <div><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setArchive(v => !v)}>Archive package…</button>{archive && <div><p>Archive this package? Its complete history remains available for rollback.</p><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void mutate(s => learningApi.archive(s.id, s.revision))}>Confirm archive</button></div>}</div>}
        {notice && <p role="status">{notice}</p>}
      </>}
    </div>}
  </div>;
}

export function PendingMemoryChanges({ botId, onChange }: { botId: string; onChange: () => void }) {
  const [changes, setChanges] = useState<MemoryChange[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [revision, refresh] = useNativeRefresh();
  useEffect(() => {
    let active = true;
    learningApi.memoryChanges(botId).then(r => { if (active) { setChanges(r.changes); setError(''); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [botId, revision]);
  const review = async (change: MemoryChange, decision: 'approve' | 'reject') => {
    setBusy(true); setError('');
    try { await learningApi.reviewMemory(change, decision); refresh(); onChange(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const pending = changes?.filter(c => c.status === 'pending') ?? [], history = changes?.filter(c => c.status !== 'pending') ?? [];
  const row = (c: MemoryChange) => <details key={c.id} className="native-history"><summary>{c.action} {c.target === 'user' ? 'preference' : 'environment fact'} · {c.status} · base revision {c.baseRevision}</summary><p style={{ whiteSpace: 'pre-wrap' }}>{c.text ?? 'Remove the existing fact from future recall.'}</p><SourceMessages sources={c.evidence} /><small>{new Date(c.createdAt).toLocaleString()}{c.runId ? ` · Review ${c.runId}` : ''}{c.memoryId ? ` · Memory ${c.memoryId}` : ''}</small>{c.status === 'pending' && <div className="learning-actions"><button className="cfg-btn cfg-btn--secondary" disabled={busy} type="button" onClick={() => void review(c, 'reject')}>Reject memory change</button><button className="cfg-btn cfg-btn--primary" disabled={busy} type="button" onClick={() => void review(c, 'approve')}>Approve memory change</button></div>}</details>;
  return <section className="native-panel" aria-label="Pending memory review"><header><h3>Pending memory changes{pending.length ? ` (${pending.length})` : ''}</h3><button type="button" className="cfg-btn cfg-btn--secondary" onClick={refresh}>Refresh changes</button></header><p className="native-meta">Background replacements and removals wait for approval. The previous fact remains active until approval; stale revisions or forgotten sources cannot be applied.</p>
    {error && <p role="alert" className="cfg-error">{error}</p>}{!changes && !error && <p role="status">Loading memory changes…</p>}{changes && !pending.length && <p>No pending memory changes.</p>}{pending.map(row)}{!!history.length && <details><summary>Memory review history ({history.length})</summary>{history.map(row)}</details>}
  </section>;
}
