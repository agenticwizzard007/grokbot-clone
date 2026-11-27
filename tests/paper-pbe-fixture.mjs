import { shellFixture } from './paper-shell-fixture.mjs';
const now = Date.UTC(2026, 10, 27, 9);
export async function pbeFixture(browser, width, theme) {
  const f = await shellFixture(browser, width, theme);
  const original = f.fixture.respond;
  const state = { screen: 'chat-rest', denied: false, decision: null, retry: false, verified: false, codeError: false };
  const row = (seq, body) => ({ seq, botId: 'coordinator', generation: 1, createdAt: now + seq * 1000, body });
  const steps = [row(2, { type: 'tool-call', callId: 'fixture-search', name: 'web_search', label: 'Searched launch checklists', args: {}, status: 'done', startedAt: now, completedAt: now + 42000 })];
  const approval = row(4, { type: 'card', card: 'approval', approvalId: 'fixture-approval', tool: 'gmail_send_email', toolkit: 'gmail', toolkitName: 'Gmail', title: 'Send an email?', args: { to: 'team@example.com', subject: 'Launch checklist', body: 'The checklist is ready.' }, status: state.denied ? 'denied' : 'pending' });
  f.fixture.respond = async args => {
    const { path, method, request } = args;
    if (path === '/api/auth/me' && ['landing','signin-code','join'].includes(state.screen)) return { json: { user: null, googleLogin: true, appleLogin: true, devLogin: false } };
    if (path === '/api/join/pbe-fixture') return {json:{valid:true,line:{number:'+15555550123',connectCommand:'connect fixture',smsLink:'sms:+15555550123',qr:''}}};
    if (path === '/api/auth/phone/start') return { json: { id: 'fixture-code', delivery: 'sent' } };
    if (path === '/api/auth/phone/verify') { state.codeError = true; return { status: 400, json: { error: 'Wrong code. Try again.' } }; }
    if (path === '/api/cli' && state.screen === 'error') return { json: { runtime: 'server', selected: 'claude', connected: false, providers: { claude: { installed: true, authenticated: false, subscription: false, hasSavedState: true }, codex: { installed: true, authenticated: false, subscription: false } } } };
    if (path.endsWith('/rows')) {
      let rows = [];
      if (state.screen === 'chat-rest' || state.screen === 'chat-voice') rows = [row(1, {type:'message',role:'user',text:'Help me plan the next step for our launch.'}), ...steps, row(3,{type:'message',role:'assistant',text:'The launch is on track. Research is ready, the draft is in review, and the next step is to confirm the schedule.\n\nI can turn the open questions into a short checklist.'}), row(4,{type:'message',role:'user',text:'Yes please, and email it to the team.'})];
      if (state.screen === 'chat-run') rows = [row(1,{type:'message',role:'user',text:'Yes please, and email it to the team.'}), ...steps, row(3,{type:'message',role:'assistant',text:'Here is the checklist. The email is ready to send.'}), {...approval, body: {...approval.body,status:state.denied?'denied':'pending'}}];
      if (state.screen === 'error') rows = [row(1,{type:'message',role:'user',text:'Summarize the launch plan.'}),row(2,{type:'notice',tone:'error',text:'Not sent. Try again.',retry:{text:'Summarize the launch plan.'}})];
      if (state.screen === 'loading') await new Promise(r=>setTimeout(r,10000));
      return {json:{generation:1,rows,hasMore:false}};
    }
    if(path==='/api/approvals/fixture-approval' && method==='POST') {state.decision=request.postDataJSON().decision;state.denied=state.decision==='deny'; return {json:{ok:true}};}
    if(path==='/api/bots/coordinator/messages' && method==='POST') {state.retry=true;return {json:{row:row(3,{type:'message',role:'user',text:'Summarize the launch plan.'}),jobIds:[],submissionId:request.postDataJSON().submissionId}};}
    if(path.endsWith('/tasks')) return {json:{tasks:[
      {id:'t1',botId:'coordinator',title:'Draft launch note',state:'working',note:'',updatedAt:now},
      {id:'t2',botId:'research-bot',title:'Review launch plan',state:'needs_input',note:'',updatedAt:now},
      {id:'t3',botId:'coordinator',title:'Collect references',state:'done',note:'',updatedAt:now},
    ]}};
    if(path==='/api/conversation-search') return {json:{results:[{botId:'coordinator',generation:1,seq:3,role:'assistant',text:'The launch is on track.',createdAt:now}]}};
    if(/^\/api\/deliverables\/bots\/[^/]+$/.test(path)) return {json:{artifacts:path.includes('coordinator')?[{id:'fixture-file',botId:'coordinator',filename:'Launch plan.md',mimeType:'text/markdown',size:256,createdAt:now,libraryPath:'Launch plan.md',downloadUrl:'/api/fixture-download',deliveries:[]}]:[]}};
    return original(args);
  };
  return {...f,state};
}
