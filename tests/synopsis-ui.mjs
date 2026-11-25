// Real server + Reports work area; no provider/API credentials or model fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'synopsis-browser-'));
const evidence=process.env.SYNOPSIS_EVIDENCE_DIR??path.join(root,'.context/quinn-synopsis-browser');fs.mkdirSync(evidence,{recursive:true});
for(const file of ['failure.png','server.log','result.json'])fs.rmSync(path.join(evidence,file),{force:true});
const children=[],logs=[];let browser;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const apiPort=await port(),uiPort=await port(),base=`http://127.0.0.1:${uiPort}`,apiBase=`http://127.0.0.1:${apiPort}`;
const env={...process.env,DB_PATH:path.join(temp,'app.db'),FILES_DIR:path.join(temp,'files'),SWARM_ROLE:'standalone',NODE_ENV:'test',SWARM_NO_SCHEDULER:'1',SESSION_SECRET:'synopsis-browser-secret',COMPUTER_PROVIDER:'local',DEV_LOGIN:'1',PORT:String(apiPort),APP_URL:base,SERVER_URL:base,DIRECT_API_KEY:'',OPENROUTER_API_KEY:'',COMPOSIO_API_KEY:'',INKBOX_TUNNEL:'0',WHATSAPP_DISABLED:'1'};
function start(args,cwd=root,extra={}){const child=spawn(process.execPath,args,{cwd,env:{...env,...extra},stdio:['ignore','pipe','pipe']});children.push(child);for(const s of [child.stdout,child.stderr])s.on('data',d=>logs.push(String(d)));return child;}
async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await sleep(100);}throw new Error('Timed out: '+label);}
async function api(url){const r=await fetch(apiBase+'/api'+url,{headers:{cookie:'swarm_session=synopsis-browser-token'}});assert.ok(r.ok,await r.clone().text());return r.json();}
try{
 const seed=start(['--import','tsx','tests/fixtures/synopsis.seed.mts']);assert.equal(await new Promise(r=>seed.on('exit',r)),0,logs.join(''));
 start(['--import','tsx','server/src/index.ts']);await until(()=>fetch(apiBase+'/api/health').then(r=>r.ok).catch(()=>false),'server');
 start([path.join(root,'web/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(uiPort)],path.join(root,'web'),{SWARM_API:apiBase});await until(()=>fetch(base).then(r=>r.ok).catch(()=>false),'web');
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'swarm_session',value:'synopsis-browser-token',url:base}]);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(15000);
 const openSynopses=async()=>{
  await page.locator('.sidebar').getByRole('button',{name:'Tasks',exact:true}).click();
  await page.getByRole('navigation',{name:'Work sections'}).getByRole('button',{name:'Reports',exact:true}).click();
  await page.getByRole('button',{name:'Daily synopses',exact:true}).click();
 };
 // Keep the account unset while checking the UTC fallback; the explicit picker save follows below.
 await page.route('**/api/auth/me',route=>route.request().method()==='PATCH'?route.abort():route.continue());
 await page.goto(base);await openSynopses();
 const panel=page.getByRole('region',{name:'Daily synopses',exact:true}),toggle=panel.getByRole('checkbox',{name:'Scheduled daily synopsis',exact:true});
 await toggle.waitFor();assert.equal(await toggle.isChecked(),false);await panel.getByText(/UTC fallback: account timezone unavailable/).waitFor();
 await toggle.click();await until(async()=>(await api('/checkins')).enabled&&await toggle.isChecked(),'schedule enabled');await toggle.click();await until(async()=>!(await api('/checkins')).enabled&&!await toggle.isChecked(),'schedule disabled');
 await panel.getByRole('button',{name:'Prepare today’s synopsis',exact:true}).click();await until(async()=>(await api('/checkins/reports')).reports[0]?.delivery?.status==='delivered','offline factual report');
 await panel.getByRole('button',{name:'Refresh synopses',exact:true}).click();await panel.getByText('Saved in Library',{exact:true}).waitFor();
 const before=(await api('/checkins/reports')).reports[0];assert.equal(before.delivery.channel,'library');assert.ok(before.artifactId);
 await panel.getByRole('button',{name:'Prepare today’s synopsis',exact:true}).click();await sleep(200);assert.equal((await api('/checkins/reports')).reports.length,1);
 const report=await api('/checkins/reports/'+before.id);assert.match(report.report.content,/Quinn daily synopsis/);assert.ok(report.report.sha256);assert.equal(report.report.delivery.attempts.length,1);
 assert.equal((await api('/checkins')).enabled,false);await page.screenshot({path:path.join(evidence,'synopsis-desktop.png'),fullPage:true});
 // R2F-036: the schedule line names what the latest synopsis was made from.
 await panel.locator('.synopsis-source').filter({hasText:/^from your team’s \S/}).waitFor();
 const sourceKinds=(await api('/checkins/reports/'+before.id+'/sources?after=0')).sources.map(source=>source.kind);
 assert.ok(sourceKinds.length>0,'the factual report recorded its sources');
 assert.notEqual(await panel.locator('.synopsis-source').innerText(),'from your team’s records','sources are named once a synopsis exists');
 // R2F-017: changing the account time zone in Settings refreshes the open synopsis line without Refresh.
 await page.unroute('**/api/auth/me');
 await page.evaluate(()=>{location.hash='#settings/account';});
 await page.getByRole('button',{name:'Time zone',exact:true}).click();
 await page.getByRole('combobox',{name:'Search time zones',exact:true}).fill('London');
 await page.getByRole('option',{name:/London/}).click();
 await until(async()=>(await api('/checkins')).timezone==='Europe/London','account zone saved');
 await page.getByRole('region',{name:'Settings',exact:true}).getByRole('button',{name:'Back to tasks',exact:true}).click();
 await panel.getByText(/· Europe\/London ·/).waitFor();
 assert.equal(await panel.getByText(/UTC fallback/).count(),0,'no stale UTC fallback after the zone change');
 // A zone change made elsewhere arrives as a 'synopses' event; the open line follows it without Refresh.
 const put=await fetch(apiBase+'/api/checkins',{method:'PUT',headers:{cookie:'swarm_session=synopsis-browser-token','content-type':'application/json'},body:JSON.stringify({timezone:'Asia/Dubai'})});assert.ok(put.ok,await put.text());
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('swarm:event',{detail:{type:'synopses'}})));
 await panel.getByText(/· Asia\/Dubai ·/).waitFor();
 await page.setViewportSize({width:390,height:844});await page.reload();
 // Reload restores Reports directly on phones, where the sidebar is not mounted.
 await page.getByRole('navigation',{name:'Work sections'}).waitFor();
 assert.equal(new URL(page.url()).hash,'#reports');
 await page.waitForFunction(()=>document.title==='Reports');
 await page.getByRole('button',{name:'Daily synopses',exact:true}).click();
 await panel.scrollIntoViewIfNeeded();assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'synopsis fits phone');
 await page.screenshot({path:path.join(evidence,'synopsis-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,reportId:before.id,attempts:report.report.delivery.attempts.length}));
 console.log('PASS synopsis browser: disabled defaults, visible UTC fallback, enable/disable preservation, model-free factual report, repeated-click identity, receipt and mobile layout');
}catch(error){fs.writeFileSync(path.join(evidence,'server.log'),logs.join(''));if(browser){const page=browser.contexts().flatMap(c=>c.pages())[0];if(page)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();for(const child of children.reverse())child.kill('SIGTERM');fs.rmSync(temp,{recursive:true,force:true});}
