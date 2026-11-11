// Real transcript components with controlled execution events. No live app actions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '', browser;
vite.stdout.on('data', data => logs += data); vite.stderr.on('data', data => logs += data);
await mkdir('.context/latency-analysis', { recursive: true });
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(origin).then(r => r.ok, () => false)) break;
    if (vite.exitCode !== null) throw new Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 820 } });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {Transcript} from '/src/components/Transcript.tsx';
import {useStore} from '/src/store.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/chat.css';import '/src/styles/mobile.css';
const bot={id:'progress',name:'Quinn',label:'Chief of Staff',model:'claude/opus',effort:'max',avatarShape:'blob',avatarColor:'black'};
useStore.setState({user:{id:'test'},bots:[bot]});
const now=Date.now();
const call=(seq,name,args,status)=>({botId:bot.id,generation:1,seq,updatedSeq:seq,kind:'tool-call',createdAt:now-6000,body:{type:'tool-call',callId:'call-'+seq,name,args,status,label:'Using a connected app',...(status==='running'?{startedAt:now-2000}:{})}});
const initial=[
 {botId:bot.id,generation:1,seq:1,updatedSeq:1,kind:'message',createdAt:now-8000,body:{type:'message',role:'user',text:'Build a lead scoring matrix in Notion.'}},
 call(2,'list_app_connections',{},'done'),
 call(3,'SWARM_APPS_SEARCH',{toolkit:'notion',query:'PRIVATE QUERY'},'done'),
 call(4,'SWARM_APPS_EXECUTE',{tool_slug:'NOTION_FETCH_DATABASE',arguments:{token:'PRIVATE ARGUMENT'}},'running'),
 call(5,'SWARM_APPS_EXECUTE',{tool_slug:'NOTION_CREATE_PAGE'},'queued')
];
function Harness(){
 const [rows,setRows]=React.useState(initial);
 const [live,setLive]=React.useState({botId:bot.id,isRunning:true,startedAt:now-8000,activity:{kind:'connecting_service',since:now-2000}});
 window.phase=phase=>{
  setRows(old=>old.map(r=>r.seq===4?{...r,body:{...r.body,status:'done',startedAt:now-2000,completedAt:now,summary:'done'}}:r.seq===5?{...r,body:{...r.body,status:phase==='approval'?'awaiting-approval':'denied',summary:phase==='approval'?undefined:'Not allowed'}}:r));
  setLive(phase==='approval'?{botId:bot.id,isRunning:false,startedAt:now-8000,activity:{kind:'waiting_for_you',since:now},awaiting:{reason:'Create page',since:now}}:{botId:bot.id,isRunning:true,startedAt:now-8000,activity:{kind:'thinking',detail:'Waiting for Claude',since:now}});
 };
 return React.createElement('div',{style:{maxWidth:'960px',height:'100dvh',margin:'0 auto',display:'flex',flexDirection:'column'}},React.createElement(Transcript,{bot,rows,live,loaded:true}));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
    await page.goto(origin);
    await page.locator('.step.is-running').waitFor();
    assert.equal(await page.locator('.steps__toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.step.is-running .step__label').innerText(), 'Notion: Fetch database');
    assert.equal(await page.locator('.step.is-queued .step__label').innerText(), 'Notion: Create page');
    assert.equal(await page.locator('.activity-line__text').innerText(), 'Notion: Fetch database');
    const elapsed = await page.locator('.step.is-running .elapsed').innerText();
    await page.waitForFunction(previous => document.querySelector('.step.is-running .elapsed')?.textContent !== previous, elapsed);
    await page.locator('.steps__toggle').click();
    await page.getByText('Checking app connections', { exact: true }).waitFor();
    await page.getByText('Finding Notion actions', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.transcript').innerText(), /Using a connected app|PRIVATE QUERY|PRIVATE ARGUMENT/);
    const fits = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no horizontal overflow`);
    await fits();
    if (width !== 320) await page.screenshot({ path: `.context/latency-analysis/progress-${width}.png` });
    await page.locator('.steps__toggle').click();
    await page.evaluate(() => window.phase('approval'));
    await page.getByText('Waiting for approval', { exact: true }).waitFor();
    assert.equal(await page.locator('.step.is-running').count(), 0);
    await page.evaluate(() => window.phase('model'));
    await page.getByText('Waiting for Claude', { exact: true }).waitFor();
    await page.locator('.steps__toggle').click();
    await page.getByText('Done · 2.0s', { exact: true }).waitFor();
    assert.equal(await page.locator('.step.is-queued').count(), 0);
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await fits();
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${width}px: visible live operations, elapsed timer, historical labels, queued/approval/completed states, model wait, dark mode`);
  }
} finally { await browser?.close(); vite.kill(); }
