// Transient states use only the development server and the seeded local Bot.
export async function preparePbeState(page, state, botId) {
  if(state === 'error') await page.route('**/api/cli', route => route.fulfill({json:{runtime:'server',selected:'claude',connected:false,providers:{claude:{installed:true,authenticated:false,subscription:false},codex:{installed:true,authenticated:false,subscription:false}}}}));
  await page.evaluate(async ({state,botId}) => {
    const {useStore} = await import('/src/store.ts');
    const {useVoice} = await import('/src/voice/call.ts');
    const bot=useStore.getState().bots.find(bot=>bot.id===botId);
    const now=Date.now();
    const row=(seq,body)=>({seq,botId,generation:bot.generation,createdAt:now+seq,body});
    const rows=state==='approval' || state==='declined' ? [row(1,{type:'tool-call',callId:'layout-tool',name:'web_search',label:'Read launch plan',args:{},status:'done'}),row(2,{type:'message',role:'assistant',text:'The email is ready.'}),row(3,{type:'card',card:'approval',approvalId:'layout-approval',tool:'gmail_send_email',title:'Send an email?',toolkit:'gmail',args:{to:'team@example.com',subject:'Launch plan',body:'The plan is ready.'},status:state==='declined'?'denied':'pending'})] : state==='error' ? [row(1,{type:'notice',tone:'error',text:'Not sent. Try again.',retry:{text:'Summarize the launch plan.'}})] : [];
    useStore.setState(s=>({bots:s.bots.map(b=>b.id===botId?{...b,onboarding:{status:'active',revision:1}}:b),transcripts:{...s.transcripts,[botId]:{generation:bot.generation,loaded:state!=='loading',loading:state==='loading',bySeq:Object.fromEntries(rows.map(r=>[r.seq,r]))}}}));
    if(state==='voice')useVoice.setState({status:'live',botId,callId:'local-layout',startedAt:now,listening:true});
    if(state==='error') {useStore.setState({sseConnected:false});const {cliApi}=await import('/src/lib/cliApi.ts');await cliApi.status();}
  },{state,botId});
  if(state==='error')await page.getByText('Connection lost',{exact:true}).waitFor();
  if(state==='approval')await page.getByRole('button',{name:/Run log/}).click();
}
