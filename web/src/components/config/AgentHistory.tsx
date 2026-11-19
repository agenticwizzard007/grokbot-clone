import { useEffect, useState } from 'react';
import { useNativeRefresh } from '../../lib/useNativeRefresh';
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
const format=(value:unknown)=>value===null?'Not recorded':typeof value==='string'?value:JSON.stringify(value,null,2);
export function AgentHistory({botId}:{botId:string}) {
  const [data,setData]=useState<Page|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [refresh,requestRefresh]=useNativeRefresh();
  const [latest,setLatest]=useState<number|null>(null);
  useEffect(()=>{
    const controller=new AbortController();setData(null);setError('');setLatest(null);setBusy(false);
    read<Page>(botId,'',controller.signal).then(setData).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[botId]);
  useEffect(()=>{
    const controller=new AbortController();
    read<Page>(botId,'?limit=1',controller.signal).then(p=>setLatest(p.latestVersion)).catch(()=>{});
    return()=>controller.abort();
  },[botId,refresh]);
  async function load(more=false) {
    setBusy(true);setError('');
    try {
      const next=await read<Page>(botId,more&&data?`?through=${data.through}&before=${data.nextBefore}`:'');
      setData(old=>more&&old?{...next,entries:[...old.entries,...next.entries]}:next);setLatest(next.latestVersion);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="agent-history" aria-label="Agent change history">
    <header><h3>Agent history</h3><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={()=>{requestRefresh();void load();}}>Refresh history</button></header>
    <p>See changes to this agent’s role, memories and skills, including proposals and evaluations. Learning is loaded into model context; these records do not rewrite the setup files.</p>
    <p className="agent-config__muted">{data?.coverage??'Loading recorded changes…'}</p>
    {latest!==null&&data&&latest>data.through&&<p role="status">New changes are available. Refresh history to include them.</p>}
    {error&&<p role="alert" className="cfg-error">{error}</p>}
    {data?.entries.length===0&&<p>No recorded changes yet.</p>}
    {data?.entries.map(entry=><HistoryEntry key={`${botId}:${entry.version}`} botId={botId} entry={entry}/>)}
    {data?.nextBefore!==null&&data&&<button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={()=>void load(true)}>{busy?'Loading…':'Load older changes'}</button>}
  </section>;
}
function HistoryEntry({botId,entry}:{botId:string;entry:Entry}) {
  const [open,setOpen]=useState(false),[detail,setDetail]=useState<Change|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!open||detail)return;
    const controller=new AbortController();setError('');
    read<Change>(botId,`/${entry.version}`,controller.signal).then(setDetail).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[botId,entry.version,open,detail,attempt]);
  return <details className="agent-history__entry" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>Change {entry.version} · {label(entry.kind)} · {label(entry.action)}{entry.sourceRevision!==null?` · revision ${entry.sourceRevision}`:''}</summary>
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
