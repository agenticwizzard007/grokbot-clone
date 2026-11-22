import { useCallback, useEffect, useRef, useState } from 'react';
import { useNativeRefresh } from '../../lib/useNativeRefresh';
import { useStore } from '../../store';
import { SourceMessages } from './KnowledgePanels';
import type { MessageSource } from '../../lib/configApi';
import './agent-history.css';

interface Entry { version:number;kind:string;sourceId:string;sourceRevision:string|null;action:string;actor:string|null;reason:string|null;runId:string|null;occurredAt:number;recordedAt:number;origin:'recorded'|'historical'|'baseline' }
interface Change extends Entry {before:unknown;after:unknown;changes:{field:string;before:unknown;after:unknown}[];evidence:MessageSource[];review:{id:string;reason:string;model:string;provider:string;status:string}|null}
interface Page {entries:Entry[];through:number;latestVersion:number;nextBefore:number|null;coverage:string}
async function read<T>(botId:string,path:string,signal?:AbortSignal):Promise<T> {
  const response=await fetch(`/api/learning/bots/${encodeURIComponent(botId)}/history${path}`,{credentials:'include',signal});
  if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error??'History could not load.');
  return response.json();
}
const label=(s:string)=>s.replaceAll('-',' ').replaceAll('_',' ');
/** R2F-012: setup and profile changes carry the setup revision; rows without one say so the same way every time. */
export const revisionText=(entry:Pick<Entry,'kind'|'sourceRevision'>)=>entry.sourceRevision===null||entry.sourceRevision===''?'no revision':`${entry.kind==='setup'||entry.kind==='profile'?'setup':label(entry.kind)} revision ${entry.sourceRevision}`;
const format=(value:unknown)=>value===null?'Not recorded':typeof value==='string'?value:JSON.stringify(value,null,2);
export function AgentHistory({botId}:{botId:string}) {
  const userId = useStore(state => state.user?.id);
  return <AgentHistoryPage key={JSON.stringify([userId, botId])} botId={botId} userId={userId} />;
}
function AgentHistoryPage({ botId, userId }: { botId: string; userId?: string }) {
  const [data,setData]=useState<Page|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [refresh,requestRefresh]=useNativeRefresh();
  const [latest,setLatest]=useState<number|null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (page?: Page) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && useStore.getState().user?.id === userId;
    setBusy(true); setError('');
    const params = page?.nextBefore != null ? `?through=${page.through}&before=${page.nextBefore}` : '';
    try {
      const next = await read<Page>(botId, params, controller.signal);
      if (!current()) return;
      setData(old => params && old ? { ...next, entries: [...new Map([...old.entries, ...next.entries].map(entry => [entry.version, entry])).values()] } : next);
      setLatest(old => Math.max(old ?? 0, next.latestVersion));
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(false); }
  }, [botId, userId]);

  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);
  useEffect(()=>{
    const controller=new AbortController();
    if (refresh) read<Page>(botId,'?limit=1',controller.signal).then(page => {
      if (!controller.signal.aborted && useStore.getState().user?.id === userId) setLatest(page.latestVersion);
    }).catch(()=>{});
    return()=>controller.abort();
  },[botId,refresh,userId]);
  return <section className="agent-history" aria-label="Agent change history">
    <header><h3>History</h3></header>
    <p>See changes to this agent’s role, memories and skills, including proposals and evaluations. Learning is loaded into model context; these records do not rewrite the setup files.</p>
    <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={()=>{requestRefresh();void load();}}>Refresh history</button>
    {data && <p className="agent-config__muted">{data.coverage}</p>}
    {!data && busy && <p role="status">Loading recorded changes…</p>}
    {latest!==null&&data&&latest>data.through&&<p role="status">New changes are available. Refresh history to include them.</p>}
    {error&&<p role="alert" className="cfg-error">{error}</p>}
    {data?.entries.length===0&&<p>No recorded changes yet.</p>}
    {data?.entries.map(entry=><HistoryEntry key={`${botId}:${entry.version}`} botId={botId} entry={entry}/>)}
    {data?.nextBefore!=null&&<button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={()=>void load(data)}>{busy?'Loading…':'Load older changes'}</button>}
  </section>;
}
function HistoryEntry({botId,entry}:{botId:string;entry:Entry}) {
  const [open,setOpen]=useState(false),[detail,setDetail]=useState<Change|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!open||detail)return;
    const controller=new AbortController();setError('');
    read<Change>(botId,`/${entry.version}`,controller.signal).then(value => {
      if (value.version !== entry.version) throw new Error('The server returned a different change. Refresh history and try again.');
      if (!controller.signal.aborted) setDetail(value);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[botId,entry.version,open,detail,attempt]);
  return <details className="agent-history__entry" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>Change {entry.version} · {label(entry.kind)} · {label(entry.action)}{` · ${revisionText(entry)}`}</summary>
    <p><time dateTime={new Date(entry.occurredAt).toISOString()}>{new Date(entry.occurredAt).toLocaleString()}</time>{entry.origin==='historical'?' · From retained history':entry.origin==='baseline'?' · Starting snapshot':''}</p>
    <p>Recorded actor: {entry.actor??'Not recorded'}{entry.reason?` · ${entry.reason}`:''}</p>
    {entry.kind.endsWith('proposal')&&<p>A proposal is not an active revision. Approved changes have separate skill or memory entries.</p>}
    {entry.kind==='evaluation'&&<p>This records an evaluation, not a change to the active procedure.</p>}
    {error&&<p role="alert">{error} <button type="button" onClick={()=>setAttempt(n=>n+1)}>Retry</button></p>}
    {open&&!detail&&!error&&<p role="status">Loading change…</p>}
    {detail&&<>
      {detail.review&&<p>Learning review: {detail.review.reason} · {detail.review.provider} / {detail.review.model} · {detail.review.status}</p>}
      {!!detail.evidence.length&&<SourceMessages sources={detail.evidence}/>}
      {!detail.changes.length&&<p>No content difference recorded.</p>}
      {detail.changes.map(c=><div className="agent-history__change" key={c.field}><h4>{label(c.field)}</h4><div className="agent-history__comparison"><section aria-label={`Before ${c.field}`}><strong>Before</strong><pre>{format(c.before)}</pre></section><section aria-label={`After ${c.field}`}><strong>After</strong><pre>{format(c.after)}</pre></section></div></div>)}
      <details><summary>Full recorded snapshots</summary><pre>{JSON.stringify({before:detail.before,after:detail.after,sourceId:detail.sourceId,runId:detail.runId},null,2)}</pre></details>
    </>}
  </details>;
}
