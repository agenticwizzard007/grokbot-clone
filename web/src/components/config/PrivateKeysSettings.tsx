import { useEffect,useState } from 'react';
async function request(path:string,method='GET',body?:unknown){
  const r=await fetch(`/api/providers/private-keys${path}`,{method,credentials:'include',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await r.json();if(!r.ok)throw new Error(value.error??'Could not update this credential.');return value;
}
export function PrivateKeysSettings(){
  const [keys,setKeys]=useState<{provider:string;hint:string;connected:number}[]>([]),[values,setValues]=useState({direct:'',voice:''}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=()=>request('').then(r=>setKeys(r.keys));
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
  async function action(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section className="cfg-section"><h2 className="cfg-section__label">Your private API credentials</h2>
    <p className="cfg-field__hint">Optional. These credentials belong only to your account. Your selected subscription continues to run your bots until you choose an API provider.</p>
    {(['direct','voice'] as const).map(provider=>{
      const saved=keys.find(k=>k.provider===provider);
      return <form className="cfg-card cfg-key" key={provider} onSubmit={e=>{e.preventDefault();void action(async()=>{await request(`/${provider}`,'PUT',{key:values[provider]});setValues(v=>({...v,[provider]:''}));});}}>
        <div className="cfg-row"><div className="cfg-row__text"><h3>{provider==='voice'?'xAI voice':'Model API'}</h3><p>{saved?.connected?`Connected ${saved.hint}`:'No credential configured'}</p></div></div>
        <div className="cfg-key__form"><input aria-label={`${provider} API key`} className="text-input" type="password" autoComplete="off" value={values[provider]} onChange={e=>setValues(v=>({...v,[provider]:e.target.value}))} placeholder="Paste your API key" />
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy||!values[provider]}>Save</button>
        {saved?.connected&&<button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={()=>void action(()=>request(`/${provider}`,'DELETE'))}>Disconnect</button>}
        {provider==='direct'&&!!saved?.connected&&<button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={()=>void action(()=>request('/direct/select','POST',{}))}>Use for models</button>}</div>
      </form>;
    })}{error&&<div className="cfg-error" role="alert">{error}</div>}
  </section>;
}
