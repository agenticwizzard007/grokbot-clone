import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useVersion } from '../../configStore';
import './workflows.css';
import { teamApi, type TeamState } from '../../lib/teamApi';

interface Criterion {id:string;description:string;kind:'row'|'file'|'result';contains?:string}
interface Goal {id:string;botId:string;title:string;status:string;reason:string;criteria:Criterion[];maxTurns:number;turnsUsed:number;tokensUsed:number;maxTokens:number|null;spendUsd:number;maxSpendUsd:number|null;unknownTokenTurns:number;unknownSpendTurns:number}
interface Task {id:string;key:string;title:string;status:string;reason:string;dependsOn:string[];assignedBotId:string|null;workerBotId?:string|null;correctionCount:number;result:unknown;criteria:Criterion[]}
interface Workflow {id:string;botId:string;goalId:string|null;title:string;status:string;reason:string;tasks:Task[]}
interface State {goals:Goal[];workflows:Workflow[]}
async function request<T>(path:string,body?:unknown):Promise<T> {
  const res=await fetch(`/api/workflows${path}`,{method:body===undefined?'GET':'POST',credentials:'include',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await res.json();if(!res.ok)throw new Error(value?.error || 'Could not update workflow.');return value;
}
function EvidenceForm({criteria,onSubmit,busy,sourceBotId}:{criteria:Criterion[];onSubmit:(evidence:unknown[])=>void;busy:boolean;sourceBotId:string}) {
  const [sources,setSources]=useState<Record<string,string>>({});
  return <form className="workflow-evidence" onSubmit={e=>{e.preventDefault();onSubmit(criteria.map(c=>({criterionId:c.id,kind:c.kind,...(c.kind==='row'?{rowSeq:Number(sources[c.id]),botId:sourceBotId}:c.kind==='file'?{path:sources[c.id],botId:sourceBotId}:{taskId:sources[c.id]})})));}}>
    {criteria.map(c=><label key={c.id}>{c.description}<small>{c.kind==='row'?'Message or tool result number':c.kind==='file'?'File in this agent’s storage':'Validated task result ID'}{c.contains?` · must contain “${c.contains}”`:''}</small><input required type={c.kind==='row'?'number':'text'} min={c.kind==='row'?1:undefined} value={sources[c.id]??''} onChange={e=>{const value=e.currentTarget.value;setSources(s=>({...s,[c.id]:value}));}}/></label>)}
    <button className="btn btn--secondary" disabled={busy} type="submit">Verify evidence and complete</button>
  </form>;
}
/** Mount inside the existing task panel; no separate client/runtime or route tree. */
export function WorkflowsPanel({botId}:{botId?:string}) {
  const bots=useStore(s=>s.bots),connected=useStore(s=>s.sseConnected),version=useVersion('tasks');
  const [state,setState]=useState<State>({goals:[],workflows:[]}),[scope,setScope]=useState(botId??''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [create,setCreate]=useState<'goal'|'workflow'|null>(null),[title,setTitle]=useState(''),[criteria,setCriteria]=useState(''),[turns,setTurns]=useState(10);
  const [steps,setSteps]=useState([{title:'',instructions:'',dependsOn:[] as string[],delegate:false,workerBotId:''}]);
  const [team,setTeam]=useState<TeamState|null>(null);
  useEffect(()=>{let active=true;teamApi.state().then(r=>{if(active)setTeam(r.state);}).catch(()=>{if(active)setTeam(null);});return()=>{active=false;};},[revision,connected]);
  const updateStep=(index:number,patch:Partial<(typeof steps)[number]>)=>setSteps(current=>current.map((step,i)=>i===index?{...step,...patch}:step));
  const [showEvidence,setShowEvidence]=useState<string|null>(null);
  const activeBot=botId || scope || bots.find(b=>b.isPrimary)?.id || bots[0]?.id;
  useEffect(()=>{setScope(botId??'');setState({goals:[],workflows:[]});},[botId]);
  useEffect(()=>{
    let alive=true;
    request<Partial<State>|null>(botId?`?botId=${encodeURIComponent(botId)}`:'').then(r=>{if(alive){setState({goals:Array.isArray(r?.goals)?r.goals:[],workflows:Array.isArray(r?.workflows)?r.workflows:[]});setError('');}}).catch(e=>{if(alive)setError(e.message);});
    return()=>{alive=false;};
  },[botId,version,revision,connected]);
  const mutate=async(path:string,body:unknown)=>{setBusy(true);setError('');try{await request(path,body);setRevision(r=>r+1);return true;}catch(e){setError(e instanceof Error?e.message:'Could not update workflow.');return false;}finally{setBusy(false);}};
  const control=(kind:'goal'|'workflow',id:string,action:string)=>mutate(`${kind==='goal'?'/goals':''}/${encodeURIComponent(id)}/control`,{action});
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();if(!activeBot)return;
    const ok=create==='goal'?await mutate('/goals',{botId:activeBot,title,maxTurns:turns,criteria:criteria.split('\n').map(s=>s.trim()).filter(Boolean).map((text,i)=>({id:`criterion-${i+1}`,description:text,kind:'row',contains:text}))})
      :await mutate('',{botId:activeBot,title,tasks:steps.map((s,i)=>({key:`step-${i+1}`,title:s.title,instructions:s.instructions,dependsOn:s.dependsOn,delegate:s.delegate,...(s.workerBotId?{workerBotId:s.workerBotId}:{}),criteria:[{id:'result',description:'A nonempty, schema-validated summary of the completed work',kind:'result'}],outputSchema:{type:'object',properties:{summary:{type:'string',minLength:1}},required:['summary'],additionalProperties:false}}))});
    if(ok){setCreate(null);setTitle('');setCriteria('');setSteps([{title:'',instructions:'',dependsOn:[],delegate:false,workerBotId:''}]);}
  };
  const controls=(kind:'goal'|'workflow',item:{id:string;status:string})=>['completed','cancelled'].includes(item.status)?null:<div className="workflow-actions">
    {kind==='workflow'&&item.status==='draft'?<button type="button" disabled={busy} onClick={()=>mutate(`/${item.id}/start`,{})}>Start</button>
      :<button type="button" disabled={busy} onClick={()=>control(kind,item.id,item.status==='active'?'pause':'resume')}>{item.status==='active'?'Pause':'Resume'}</button>}
    <button type="button" disabled={busy} onClick={()=>control(kind,item.id,'stop')}>Stop</button>
  </div>;
  return <section className="workflows-panel" aria-labelledby="native-workflows-heading">
    <header><div><h2 id="native-workflows-heading">Goals and workflows</h2><p>Persistent goals, verified results and tasks that wait for their prerequisites.</p></div><div className="workflow-actions"><button type="button" onClick={()=>{setCreate('goal');setError('');}}>New goal</button><button type="button" onClick={()=>{setCreate('workflow');setError('');}}>New workflow</button></div></header>
    {error&&<p className="workflow-error" role="alert">{error}<button type="button" onClick={()=>setRevision(r=>r+1)}>Refresh</button></p>}
    {create&&<form className="workflow-create" onSubmit={submit}>
      <h3>{create==='goal'?'New persistent goal':'New workflow'}</h3>
      {!botId&&<label>Agent<select required value={activeBot??''} onChange={e=>setScope(e.target.value)}>{bots.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
      <label>{create==='goal'?'Goal':'Workflow name'}<input required maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
      {create==='goal'?<><label>Acceptance checks<textarea required value={criteria} onChange={e=>setCriteria(e.target.value)} placeholder="One expected phrase per line. Completion will require existing assistant or tool output containing each phrase."/></label><label>Maximum turns<input type="number" min={1} max={1000} required value={turns} onChange={e=>setTurns(Number(e.target.value))}/></label></>:<>
        {steps.map((step,i)=><fieldset key={i}><legend>Task {i+1}</legend><label>Title<input required value={step.title} onChange={e=>updateStep(i,{title:e.currentTarget.value})}/></label><label>Instructions<textarea required value={step.instructions} onChange={e=>updateStep(i,{instructions:e.currentTarget.value})}/></label>
          {i>0&&<label>Wait for<select aria-label="Wait for" multiple value={step.dependsOn} onChange={e=>updateStep(i,{dependsOn:Array.from(e.currentTarget.selectedOptions,o=>o.value)})}>{steps.slice(0,i).map((s,n)=><option key={n} value={`step-${n+1}`}>{s.title||`Task ${n+1}`}</option>)}</select></label>}
          <label>Worker<select aria-label="Worker" value={step.workerBotId || (step.delegate?'temporary':'')} onChange={e=>updateStep(i,{workerBotId:e.currentTarget.value==='temporary'?'':e.currentTarget.value,delegate:!!e.currentTarget.value})}><option value="">Workflow coordinator</option><option value="temporary">Temporary helper</option>{team?.agents.filter(a=>a.setupStatus==='active').map(a=><option key={a.botId} value={a.botId}>{a.name}</option>)}</select></label>

        </fieldset>)}
        <button type="button" onClick={()=>setSteps(s=>[...s,{title:'',instructions:'',dependsOn:[],delegate:false,workerBotId:''}])}>Add task</button>
      </>}
      <div className="workflow-actions"><button className="btn btn--primary" disabled={busy||!activeBot} type="submit">{create==='goal'?'Create and start':'Create workflow'}</button><button type="button" onClick={()=>setCreate(null)}>Cancel</button></div>
    </form>}
    {state.goals.map(g=><article className="workflow-card" key={g.id}><header><h3>{g.title}</h3><span className={`workflow-status is-${g.status}`}>{g.status}</span></header><p>{g.turnsUsed} / {g.maxTurns} turns{g.maxTokens!==null?` · ${g.tokensUsed} / ${g.maxTokens} tokens`:''}{g.maxSpendUsd!==null?` · $${g.spendUsd.toFixed(3)} / $${g.maxSpendUsd} spent`:''}</p>{g.reason&&<p>{g.reason}</p>}{!!(g.unknownTokenTurns||g.unknownSpendTurns)&&<small>Some usage measurements are unavailable.</small>}<ul>{g.criteria.map(c=><li key={c.id}>{c.description}</li>)}</ul>{controls('goal',g)}
      {!['completed','cancelled'].includes(g.status)&&<button type="button" onClick={()=>setShowEvidence(showEvidence===g.id?null:g.id)}>Add completion evidence</button>}
      {showEvidence===g.id&&<EvidenceForm busy={busy} sourceBotId={g.botId} criteria={g.criteria} onSubmit={evidence=>{void mutate(`/goals/${g.id}/verify`,{evidence});}}/>}
    </article>)}
    {state.workflows.map(w=><article className="workflow-card" key={w.id}><header><h3>{w.title}</h3><span className={`workflow-status is-${w.status}`}>{w.status}</span></header>{w.reason&&<p>{w.reason}</p>}{controls('workflow',w)}<ol className="workflow-task-list">{w.tasks.map(t=><li key={t.id}><div><strong>{t.title}</strong><span className={`workflow-status is-${t.status}`}>{t.status}</span></div>{t.dependsOn.length>0&&<small>Waits for: {t.dependsOn.map(id=>w.tasks.find(t=>t.id===id)?.title??id).join(', ')}</small>}{(t.workerBotId||t.assignedBotId)&&<small>Owner: {bots.find(b=>b.id===(t.workerBotId??t.assignedBotId))?.name??'Unavailable Bot'}</small>}{t.reason&&<p>{t.reason}</p>}{t.correctionCount>0&&<small>One output correction requested</small>}{t.result!==null&&<details><summary>Result</summary><pre>{JSON.stringify(t.result,null,2)}</pre></details>}
      {!['completed','cancelled'].includes(t.status)&&<button type="button" onClick={()=>setShowEvidence(showEvidence===t.id?null:t.id)}>Verify task evidence</button>}{showEvidence===t.id&&<EvidenceForm busy={busy} sourceBotId={t.assignedBotId??w.botId} criteria={t.criteria} onSubmit={evidence=>{void mutate(`/${w.id}/tasks/${t.id}/complete`,{evidence});}}/>}</li>)}</ol></article>)}
    {!state.goals.length&&!state.workflows.length&&!create&&<p className="workflow-empty">Create a goal with acceptance checks, or a workflow with tasks and prerequisites.</p>}
  </section>;
}
