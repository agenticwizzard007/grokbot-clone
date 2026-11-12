// Native workflows, reviewed knowledge and saved files through the real app/API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-native-ui-'));
const children=[],logs=[]; let browser;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function start(args,env={}){const p=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});children.push(p);for(const stream of [p.stdout,p.stderr])stream.on('data',d=>logs.push(String(d)));return p;}
async function until(fn){for(let i=0;i<200;i++){const v=await fn();if(v)return v;await sleep(100);}throw new Error('Timed out');}
const apiPort=await port(),mockPort=await port(),base=`http://127.0.0.1:${apiPort}`;
try {
 start(['tests/mock-provider.mjs',String(mockPort)]);
 start(['--import','tsx','server/src/index.ts'],{SWARM_ROLE:'standalone',DB_PATH:path.join(root,'app.db'),FILES_DIR:path.join(root,'files'),SESSION_SECRET:'native-ui-test',COMPUTER_PROVIDER:'local',DEV_LOGIN:'1',PORT:String(apiPort),APP_URL:base,SERVER_URL:base,DIRECT_API_KEY:'mock-key',DIRECT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,OPENROUTER_API_KEY:'',COMPOSIO_API_KEY:'',LLM_PROVIDER:'direct',SWARM_NO_SCHEDULER:'1',WHATSAPP_DISABLED:'1',MEMORY_CONSOLIDATE_IDLE_MINUTES:'0',ADMIN_EMAILS:'',INKBOX_TUNNEL:'0'});
 await until(()=>fetch(base+'/api/health').then(r=>r.ok).catch(()=>false));
 const login=await fetch(base+'/api/auth/dev',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'native-ui@example.test'})});
 assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0];
 async function api(url,method='GET',body){const r=await fetch(base+'/api'+url,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.ok(r.ok,`${method} ${url}: ${r.status} ${text}`);return JSON.parse(text);}
 const bot=(await api('/bots')).bots.find(b=>b.isPrimary);
 const original=(await api(`/bots/${bot.id}/messages`,'POST',{text:'I prefer concise weekly reports with links to sources.'})).row;
 await until(async()=>(await api(`/bots/${bot.id}/rows`)).rows.some(r=>r.seq>original.seq&&r.body.role==='assistant'&&!r.body.streaming));
 const evidence=[{botId:bot.id,generation:original.generation,seq:original.seq}];
 const proposal={expected_revision:0,name:'Weekly report',description:'Create a concise weekly report with source links.',body:'1. Retrieve the original sources.\n2. Check the reported facts.\n3. Save a concise report with source links.',reason:'The user requested concise, sourced reports.',evidence};
 const message=(await api(`/bots/${bot.id}/messages`,'POST',{text:`mock: remember ${JSON.stringify({text:'Prefers concise weekly reports with source links.',evidence})} | propose_skill ${JSON.stringify(proposal)} | save_file ${JSON.stringify({filename:'weekly-report.md',content:'# Weekly report\n\nVerified sources and completed work.'})} | say Saved for review.`})).row;
 await until(async()=>(await api(`/bots/${bot.id}/rows`)).rows.some(r=>r.seq>message.seq&&r.body.role==='assistant'&&!r.body.streaming));
 assert.equal((await api(`/bots/${bot.id}/skill-proposals`)).proposals.length,1);
 assert.equal((await api(`/bots/${bot.id}/memories`)).memories.length,1);
 const artifact=(await api(`/deliverables/bots/${bot.id}`)).artifacts[0]; assert.ok(artifact);
 const download=await fetch(base+artifact.downloadUrl,{headers:{cookie}});assert.equal(download.status,200);assert.match(await download.text(),/Verified sources/);
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'swarm_session',value:cookie.slice(cookie.indexOf('=')+1),url:base}]);
 const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(base);await page.locator('.composer__input').waitFor();
 // The owner reviews the actual proposed diff before activating the procedure.
 await page.getByRole('button',{name:'Bot settings',exact:true}).click();
 await page.getByRole('button',{name:'Skills',exact:true}).click();
 await page.getByText('Learned skills awaiting review (1)',{exact:true}).waitFor();
 await page.getByText('Weekly report · New skill',{exact:true}).click();
 await page.getByLabel('Proposed skill diff').waitFor();
 fs.mkdirSync('.context/native-shots',{recursive:true});await page.screenshot({path:'.context/native-shots/skill-review.png',animations:'disabled'});
 await page.getByRole('button',{name:'Approve',exact:true}).click();
 await page.getByRole('button',{name:'History · revision 1',exact:true}).waitFor();
 await page.getByRole('button',{name:/^Memories/}).click();
 await page.getByRole('link',{name:`Source ${original.generation}:${original.seq}`,exact:true}).click();
 await page.getByText('I prefer concise weekly reports with links to sources.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Close sources',exact:true}).click();
 await page.getByRole('button',{name:'Correct',exact:true}).click();
 await page.getByLabel('Corrected memory').fill('Prefers detailed monthly reports with source links.');
 await page.getByRole('button',{name:'Save correction',exact:true}).click();
 await page.getByText('Prefers detailed monthly reports with source links.',{exact:true}).waitFor();
 await page.screenshot({path:'.context/native-shots/sourced-memory.png',animations:'disabled'});
 await page.keyboard.press('Escape');
 await page.locator('.sidebar').getByRole('button',{name:'Tasks',exact:true}).click();
 const workflows=page.getByRole('region',{name:'Goals and workflows',exact:true});
 await workflows.getByRole('button',{name:'New workflow',exact:true}).click();
 await workflows.getByLabel('Workflow name',{exact:true}).fill('Research to report');
 await workflows.getByLabel('Title',{exact:true}).fill('Research sources');
 await workflows.getByLabel('Instructions',{exact:true}).fill('Find relevant sources and summarize them.');
 await workflows.getByRole('button',{name:'Add task',exact:true}).click();
 await workflows.getByLabel('Title',{exact:true}).nth(1).fill('Write report');
 await workflows.getByRole('group',{name:'Task 2',exact:true}).getByRole('textbox',{name:'Instructions',exact:true}).fill('Use the research to write a concise sourced report.');
 await workflows.getByRole('listbox',{name:'Wait for',exact:true}).selectOption('step-1');
 await workflows.getByRole('button',{name:'Create workflow',exact:true}).click();
 await workflows.getByRole('heading',{name:'Research to report',exact:true}).waitFor();
 assert.match(await workflows.innerText(),/Waits for: Research sources/);
 await page.screenshot({path:'.context/native-shots/workflows.png',animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.locator('.tasks-view__scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'workflow view fits mobile');
 await page.screenshot({path:'.context/native-shots/workflows-mobile.png',animations:'disabled'});
 assert.deepEqual(errors,[]);
 console.log('PASS native UI: real proposal review, source inspection, memory correction, artifact download, dependency creation, desktop/mobile rendering.');
} catch(e){if(browser){const p=browser.contexts()[0]?.pages()[0];if(p){await p.screenshot({path:'.context/native-shots/failure.png'});fs.writeFileSync('.context/native-ui-failure.html',await p.content());}}console.error(logs.join('').slice(-6500));throw e;} finally{await browser?.close();for(const child of children)child.kill();await sleep(300);fs.rmSync(root,{recursive:true,force:true});}
