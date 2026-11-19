import { useCallback, useEffect, useRef, useState } from 'react';
import './SynopsesPanel.css';

interface Settings { enabled:boolean; times:string[]; timezone:string; timezoneSource:string; quietHours:Array<{start:string;end:string}> }
interface Synopsis { id:string; seq:number; slotKey:string; slotCount:number; timezone:string; windowStart:number; windowEnd:number;
  sourceCount:number; status:string; artifactId:string|null; gaps:string[]; coverage:{snapshotComplete:boolean;summaryComplete:boolean;pages:number};
  delivery:{status:string;channel:string}|null; generationNote:string|null; lastError:string|null }
async function request<T>(path:string,method='GET',body?:unknown):Promise<T> {
 const response=await fetch(`/api/checkins${path}`,{method,credentials:'include',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const value=await response.json();if(!response.ok)throw new Error(value.error??'Could not load daily synopses.');return value;
}
/** Report preferences and receipts share the existing saved-deliverables surface. */
export function SynopsesPanel({ onUpdated }: { onUpdated?:()=>void }) {
 const [settings,setSettings]=useState<Settings|null>(null),[reports,setReports]=useState<Synopsis[]>([]),[cursor,setCursor]=useState(0),[more,setMore]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');const active=useRef(true);
 const load=useCallback(async(after=0)=>{
  try{
   const [prefs,page]=await Promise.all([request<Settings>(''),request<{reports:Synopsis[];nextCursor:number;hasMore:boolean}>(`/reports?after=${after}&limit=10`)]);
   if(active.current){setSettings(prefs);setReports(old=>after?[...old,...page.reports]:page.reports);setCursor(page.nextCursor);setMore(page.hasMore);}
  }catch(e){if(active.current)setError((e as Error).message);}
 },[]);
 useEffect(()=>{active.current=true;void load();return()=>{active.current=false;};},[load]);
 const act=async(fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await fn();await load();if(active.current)onUpdated?.();}catch(e){if(active.current)setError((e as Error).message);}finally{if(active.current)setBusy(false);}};
 return <section aria-label="Daily synopses" className="panel-card synopsis-panel">
  <div className="section-label section-label--row"><span>Daily synopses</span><button type="button" className="link-btn link-btn--small" disabled={busy} onClick={()=>void load()}>Refresh synopses</button></div>
  {error&&<p className="lib-err" role="alert">{error}</p>}
  {settings&&<>
   <label><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e=>void act(()=>request('','PUT',{enabled:e.currentTarget.checked}))}/> Scheduled daily synopsis</label>
   <p className="panel-row__meta">{settings.enabled?'Scheduled':'Paused'} · {settings.times.length?settings.times.join(', '):'No times selected'} · {settings.timezone}{settings.timezoneSource==='utc_fallback'?' (UTC fallback: account timezone unavailable)':''}. Saved in Library.</p>
   {!!settings.quietHours.length&&<p className="panel-row__meta">Quiet hours: {settings.quietHours.map(q=>`${q.start}–${q.end}`).join(', ')}.</p>}
  </>}
  <button type="button" className="link-btn link-btn--small" disabled={busy} onClick={()=>void act(()=>request('/now','POST'))}>Prepare today’s synopsis</button>
  {!reports.length&&<p className="panel-row__meta">Daily synopses appear here with their coverage and saved delivery status.</p>}
  {reports.map(r=><div className="panel-row" key={r.id}><div>
   <strong>{r.slotKey.startsWith('manual:')?'Requested synopsis':r.slotKey} · {r.timezone}</strong>
   <p className="panel-row__meta">{r.slotCount>1?`Catch-up for ${r.slotCount} slots · `:''}{r.delivery?.status==='delivered'?'Saved in Library':r.delivery?.status==='unknown'?'Send outcome unknown: verify in Saved reports':r.delivery?.status==='failed'?'Not sent':r.status==='preparing'?'Preparing factual report':r.delivery?.status??'Waiting to save'}</p>
   <p className="panel-row__meta">Coverage through {new Date(r.windowEnd).toLocaleString()} · {r.sourceCount} observations{r.coverage.summaryComplete?'':` · Partial summary; ${r.coverage.pages} saved source pages`}.</p>
   {r.artifactId&&<a href={`/api/deliverables/artifacts/${encodeURIComponent(r.artifactId)}/download`}>Read synopsis and source pages</a>}
   {r.delivery?.status==='failed'&&<button type="button" className="link-btn link-btn--small" disabled={busy} onClick={()=>void act(()=>request(`/reports/${encodeURIComponent(r.id)}/retry`,'POST'))}>Retry original saved report</button>}
   <details><summary>Coverage observations</summary>{r.gaps.map((gap,i)=><p key={i} className="panel-row__meta">{gap}</p>)}{r.lastError&&<p className="lib-err">{r.lastError}</p>}</details>
  </div></div>)}
  {more&&<button type="button" className="link-btn link-btn--small" disabled={busy} onClick={()=>void load(cursor)}>Load more synopses</button>}
 </section>;
}
