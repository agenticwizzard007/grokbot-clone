// Full chat → model tool call → durable teammate → real separate Chrome browsers.
// Isolated API, mock model, database and companion; no real API keys or existing accounts touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-chat-'));
const children = [];
const logs = [];
let browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
const apiPort = await port(); const mockPort = await port();
const base = `http://127.0.0.1:${apiPort}`; const mock = `http://127.0.0.1:${mockPort}`;
function start(args, env = {}) { const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] }); children.push(p); p.stdout.on('data', (d) => logs.push(String(d))); p.stderr.on('data', (d) => logs.push(String(d))); return p; }
async function until(fn, timeout = 30000) { const end = Date.now()+timeout; while (Date.now()<end) { const value = await fn().catch(() => null); if (value) return value; await sleep(150); } throw new Error('Timed out'); }
try {
  start(['tests/mock-provider.mjs', String(mockPort)]);
  await until(async () => (await fetch(`${mock}/v1/models`)).ok);
  start(['--import', 'tsx', 'server/src/index.ts'], { DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'isolated-test-only', COMPUTER_PROVIDER: 'local', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `${mock}/v1`, OPENROUTER_API_KEY: '', COMPOSIO_API_KEY: '', LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0' });
  await until(async () => (await fetch(`${base}/api/health`)).ok);
  const login = await fetch(`${base}/api/auth/dev`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email:'isolated@example.com'}) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function api(url, method='GET', body) { const r = await fetch(`${base}/api${url}`, { method, headers:{cookie,'content-type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); assert.ok(r.ok, `${method} ${url}: ${r.status} ${text}`); return JSON.parse(text); }
  const primary = (await api('/bots')).bots.find((b) => b.isPrimary);
  const pair = await api('/computer/pair','POST');
  start(['companion/swarm-companion.mjs', '--server', base, '--token', pair.token, '--data-dir', path.join(root, 'companion')], { COMPANION_NO_SANDBOX: '1' });
  await until(async () => (await api('/computer')).computer.status === 'running');
  async function chat(id,text) { const {row}=await api(`/bots/${id}/messages`,'POST',{text}); return await until(async () => { const {rows}=await api(`/bots/${id}/rows`); const newer=rows.filter((r)=>r.seq>row.seq); const notice=newer.find((r)=>r.kind==='notice'); if(notice) throw new Error(notice.body.text); const done=newer.find((r)=>r.kind==='message'&&r.body.role==='assistant'&&!r.body.streaming); return done && {row, rows:newer,reply:done.body.text}; },60000); }
  const brief = await chat(primary.id, 'Create a LinkedIn research teammate who owns three sourced leads per week for Acme, never sends outreach, and reports to Quinn.\nmock: say I cannot create teammates from this chat.');
  const spec = { name:'Nia', label:'LinkedIn Research', purpose:'Research qualified Acme leads.', responsibilities:['Prepare three sourced leads per week'], out_of_scope:['Do not send outreach'], success_criteria:['Three leads with source links delivered to Quinn'], context_summary:'The user wants research only, with no outreach. Quinn reviews the report.', shared_resources:['Research guide supplied by the user; ask for the link when needed'], handoff_notes:['Report results and blockers to Quinn'], source_message_seqs:[brief.row.seq], handoff_message:'Confirm your assigned responsibility. mock: say I own three sourced leads per week and will not send outreach.' };
  const created = await chat(primary.id, `mock: create_bot ${JSON.stringify(spec)} | say Created Nia: {last}`);
  assert.equal(created.rows.find((r)=>r.body.name==='create_bot').body.status,'done');
  const teammate=(await api('/bots')).bots.find((b)=>b.name==='Nia'); assert.ok(teammate);
  assert.equal((await api(`/bots/${teammate.id}/setup`)).computer.status,'ready');
  assert.ok((await api(`/bots/${teammate.id}/rows`)).rows.some((r)=>r.body.role==='assistant'&&r.body.text.includes('configure Nia')));
  const listing = await api(`/bots/${teammate.id}/files?path=Setup`); assert.equal(listing.files.length,8);
  const charter = await (await fetch(`${base}/api/bots/${teammate.id}/setup/AGENTS.md`,{headers:{cookie}})).text(); assert.match(charter,/Do not send outreach/);
  await chat(primary.id, 'mock: computer_screenshot {} | say My browser is ready.');
  let screens=(await api('/computer/details')).screens; assert.ok(screens.some((s)=>s.botId===primary.id)); assert.ok(screens.some((s)=>s.botId===teammate.id));
  const profiles=fs.readdirSync(path.join(root,'companion','profiles')); assert.ok(profiles.includes(primary.id)); assert.ok(profiles.includes(teammate.id));
  // The setup boundary is enforced even when a model fabricates an operational call.
  const blocked = await chat(teammate.id, 'mock: open_browser {"url":"https://example.com"} | say Waiting for setup.');
  assert.equal(blocked.rows.find(r=>r.body.name==='open_browser').body.status,'denied');
  const answer = await chat(teammate.id, 'On my request, use my notes to prepare three sourced leads. Never contact them. Mark missing evidence, then send a concise report to Quinn. mock: say I will save those requirements.');
  const current = await api(`/bots/${teammate.id}/setup`);
  const complete = { ...current.manifest.brief, revision:current.onboarding.revision, stage:'review', instructions:'Keep reports concise.', source_message_seqs:[answer.row.seq], communication_style:'Concise, factual, and explicit about missing evidence.', action_boundaries:'Use supplied notes only. Never contact leads. Ask the user when an important decision is missing.', workflows:[{name:'Lead summary',trigger:'The user requests a report and supplies notes',steps:['Identify three relevant leads','Cite their sources or flag missing evidence','Send the report to Quinn'],output:'Three sourced lead summaries'}], open_questions:[] };
  // Exercise the real side panel, document reader and revision-specific activation.
  browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome', args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'swarm_session',value:cookie.slice(cookie.indexOf('=')+1),url:base}]);
  const page = await context.newPage(); await page.goto(base);
  await page.locator('.bot-row').filter({hasText:'Nia · LinkedIn Research'}).click();
  // Opening the chat pill reveals the details panel if it is closed.
  const config = page.getByRole('button',{name:'Configuration',exact:true});
  if(!await config.isVisible()) await page.getByRole('button',{name:'Show details',exact:true}).click();
  await config.click();
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.agent-config__status').getByText('Setup interview',{exact:true}).waitFor();
  const saved = await chat(teammate.id, `mock: save_agent_setup ${JSON.stringify(complete)} | say Your configuration is ready for review.`);
  assert.equal(saved.rows.find(r=>r.body.name==='save_agent_setup').body.status,'done');
  const review = await api(`/bots/${teammate.id}/setup`); assert.equal(review.onboarding.status,'review');
  await page.getByText('Ready for your review',{exact:true}).waitFor();
  // Responsibilities are immediately visible; harness and generated files have explicit navigation.
  for (const name of ['Mission & responsibilities', 'Expected results', 'Planned workflows', 'Agreed limits']) {
    assert.ok(await page.getByRole('heading',{name,exact:true}).isVisible(), name+' should be visible');
  }
  assert.equal(await page.getByRole('heading',{name:'Working style',exact:true}).isVisible(),false);
  for (const placeholder of await page.getByText('None specified.',{exact:true}).all()) assert.equal(await placeholder.isVisible(),false);
  const harnessTab = page.getByRole('tab',{name:'Harness',exact:true});
  const filesTab = page.getByRole('tab',{name:'Files',exact:true});
  const responsibilitiesTab = page.getByRole('tab',{name:'Responsibilities',exact:true});
  let previewCalls = 0;
  page.on('request', req => { if(req.url().endsWith(`/bots/${teammate.id}/instructions`)) previewCalls++; });
  await harnessTab.click();
  assert.equal(previewCalls,0,'opening Harness does not assemble a prompt until requested');
  await page.locator('summary').filter({hasText:'Preview assembled instructions'}).click();
  await page.getByLabel('Assembled system instructions').waitFor();
  assert.match(await page.getByLabel('Assembled system instructions').innerText(),/setup consultant for Nia/);
  await filesTab.click();
  await page.getByRole('button',{name:'SOUL.md Style & working principles',exact:true}).click();
  await page.getByText('Concise, factual, and explicit about missing evidence.',{exact:true}).last().waitFor();
  await until(async () => page.getByRole('region',{name:'SOUL.md contents',exact:true}).evaluate(el=>document.activeElement === el));
  const download = page.waitForEvent('download');
  await page.getByRole('link',{name:'Download',exact:true}).click();
  const downloaded = await download;
  assert.equal(downloaded.suggestedFilename(),'SOUL.md');
  assert.match(fs.readFileSync(await downloaded.path(),'utf8'),/Concise, factual/);
  fs.mkdirSync('.context/shots',{recursive:true});
  await page.locator('.agent-config__file').screenshot({path:'.context/shots/agent-soul-file.png'});
  await responsibilitiesTab.click();
  await page.locator('.details__scroll').evaluate(el=>el.scrollTop=0);
  await page.locator('aside.details').screenshot({path:'.context/shots/agent-configuration-review.png'});
  await page.getByRole('button',{name:'Activate agent',exact:true}).click();
  await page.getByText('Active configuration',{exact:true}).waitFor();
  assert.equal((await api(`/bots/${teammate.id}/setup`)).onboarding.status,'active');
  await until(async () => !(await api('/bots')).live.some(l=>l.botId===teammate.id&&l.isRunning));
  await page.locator('.details__scroll').evaluate(el=>el.scrollTop=0);
  await page.locator('aside.details').screenshot({path:'.context/shots/agent-configuration-active.png'});
  // Keyboard navigation and instruction editing use the real owner-scoped save path.
  await responsibilitiesTab.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await harnessTab.getAttribute('aria-selected'),'true');
  await page.getByRole('button',{name:'Edit instructions',exact:true}).click();
  await page.getByRole('textbox',{name:'Standing instructions',exact:true}).fill('Unsaved draft');
  await filesTab.click(); await harnessTab.click();
  assert.equal(await page.getByRole('textbox',{name:'Standing instructions',exact:true}).inputValue(),'Unsaved draft');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal((await api(`/bots/${teammate.id}/setup`)).manifest.bot.instructions,'Keep reports concise.');
  await page.getByRole('button',{name:'Edit instructions',exact:true}).click();
  const standing = 'Keep reports concise. Include source links and flag uncertainty.';
  await page.getByRole('textbox',{name:'Standing instructions',exact:true}).fill(standing);
  const botUrl = `${base}/api/bots/${teammate.id}`;
  await page.route(botUrl, route => route.request().method() === 'PATCH' ? route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Save temporarily unavailable'})}) : route.continue());
  await page.getByRole('button',{name:'Save instructions',exact:true}).click();
  await page.getByText('Save temporarily unavailable',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Standing instructions',exact:true}).inputValue(),standing);
  await page.unroute(botUrl);
  // A second browser can save after this editor's last roster event, even while its request is in flight.
  await page.route(botUrl, async route => {
    if (route.request().method() === 'PATCH') await api(`/bots/${teammate.id}`,'PATCH',{instructions:'Newer instructions from another browser'});
    await route.continue();
  });
  await page.getByRole('button',{name:'Save instructions',exact:true}).click();
  await page.getByText('Instructions changed elsewhere. Reload the current instructions before saving.',{exact:true}).waitFor();
  assert.equal((await api(`/bots/${teammate.id}/setup`)).manifest.bot.instructions,'Newer instructions from another browser');
  assert.equal(await page.getByRole('textbox',{name:'Standing instructions',exact:true}).inputValue(),standing);
  await page.unroute(botUrl);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Edit instructions',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'Standing instructions',exact:true}).inputValue(),'Newer instructions from another browser');
  await page.getByRole('textbox',{name:'Standing instructions',exact:true}).fill(standing);
  await page.getByRole('button',{name:'Save instructions',exact:true}).click();
  await page.getByText('Instructions saved.',{exact:true}).waitFor();
  assert.equal((await api(`/bots/${teammate.id}/setup`)).manifest.bot.instructions,standing);
  await until(async () => (await page.getByLabel('Assembled system instructions').innerText()).includes(standing));
  assert.match(await page.getByLabel('Assembled system instructions').innerText(),/You are Nia,/);
  const previewUrl = `${base}/api/bots/${teammate.id}/instructions`;
  await page.route(previewUrl, route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Preview temporarily unavailable'})}));
  await page.getByRole('button',{name:'Refresh preview',exact:true}).click();
  await page.getByText('Preview temporarily unavailable',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Assembled system instructions').count(),0,'failed refresh must not show stale instructions');
  await page.unroute(previewUrl);
  await page.getByRole('button',{name:'Retry preview',exact:true}).click();
  await page.getByLabel('Assembled system instructions').waitFor();
  // Returning from Skills settings refreshes an already-open preview without another manual refresh.
  await page.getByRole('button',{name:'Skills',exact:true}).click();
  const settings = page.getByRole('dialog',{name:'Nia settings',exact:true});
  await settings.getByRole('button',{name:'New skill',exact:true}).click();
  await settings.getByRole('textbox',{name:'Skill name',exact:true}).fill('Evidence checklist');
  await settings.getByRole('textbox',{name:'Skill steps',exact:true}).fill('Check each source before presenting the lead summary.');
  await settings.getByRole('button',{name:'Add skill',exact:true}).click();
  await settings.getByText('Evidence checklist',{exact:true}).waitFor();
  await settings.getByRole('button',{name:'Close',exact:true}).click();
  await until(async () => (await page.getByLabel('Assembled system instructions').innerText()).includes('Check each source before presenting the lead summary.'));

  await page.locator('summary').filter({hasText:'Preview assembled instructions'}).click();
  await page.locator('.details__scroll').evaluate(el=>el.scrollTop=180);
  await page.locator('aside.details').screenshot({path:'.context/shots/agent-configuration-harness.png'});
  // Narrow layouts retain readable controls and do not introduce horizontal scrolling.
  for (const width of [320,375,390,430,768,1024]) {
    await page.setViewportSize({width,height:900});
    if (!await page.locator('aside.details').isVisible()) {
      const botRow = page.locator('.bot-row').filter({hasText:'Nia · LinkedIn Research'});
      if (await botRow.isVisible()) await botRow.click();
      await page.getByRole('button',{name:'Show details',exact:true}).click();
      await config.click();
    }
    for (const section of [responsibilitiesTab,harnessTab,filesTab]) {
      await section.click();
      assert.ok(await page.locator('aside.details').evaluate(el=>el.scrollWidth<=el.clientWidth),`panel overflow at ${width}`);
      assert.ok(await page.locator('.details__scroll').evaluate(el=>el.scrollWidth<=el.clientWidth),`content overflow at ${width}`);
      if (width <= 760) {
        const undersized = await page.locator('.agent-config button, .agent-config summary, .agent-config__row > a').evaluateAll(els => els.filter(el => {
          const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44;
        }).map(el => el.textContent));
        assert.deepEqual(undersized,[],`touch actions are at least 44px at ${width}`);
      }
      if (width === 390 || width === 1024) {
        await page.locator('.details__scroll').evaluate(el=>el.scrollTop=0);
        await page.locator('aside.details').screenshot({path:`.context/shots/agent-configuration-paper-${width}-${(await section.innerText()).toLowerCase()}.png`});
        if (width === 390 && await section.innerText() === 'Files') {
          const soul = page.getByRole('button',{name:'SOUL.md Style & working principles',exact:true});
          await soul.click();
          await page.locator('aside.details').screenshot({path:'.context/shots/agent-configuration-paper-file-reader.png',animations:'disabled'});
          await page.getByRole('button',{name:'Back to files',exact:true}).click();
          assert.ok(await soul.evaluate(el=>document.activeElement===el),'Back to files returns focus to the selected file');
        }

      }

    }
  }
  await page.setViewportSize({width:390,height:900});
  if (!await page.locator('aside.details').isVisible()) {
    const botRow = page.locator('.bot-row').filter({hasText:'Nia · LinkedIn Research'});
    if (await botRow.isVisible()) await botRow.click();
    await page.getByRole('button',{name:'Show details',exact:true}).click();
    await config.click();
  }
  await harnessTab.click();
  await page.getByRole('button',{name:'Edit instructions',exact:true}).click();
  await page.locator('.agent-config__instructions').scrollIntoViewIfNeeded();
  await page.screenshot({path:'.context/shots/agent-configuration-paper-editor.png'});
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.locator('summary').filter({hasText:'Preview assembled instructions'}).click();
  await page.getByLabel('Assembled system instructions').waitFor();
  await page.getByLabel('Assembled system instructions').scrollIntoViewIfNeeded();
  await page.screenshot({path:'.context/shots/agent-configuration-paper-preview.png'});
  await page.locator('summary').filter({hasText:'Preview assembled instructions'}).click();
  await page.locator('.details__scroll').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:'.context/shots/agent-configuration-mobile.png'});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:'.context/shots/agent-configuration-mobile-dark.png',animations:'disabled'});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.setViewportSize({width:1440,height:1000});
  if (!await config.isVisible()) await page.getByRole('button',{name:'Show details',exact:true}).click();
  await config.click();
  await responsibilitiesTab.click();
  await api(`/bots/${teammate.id}/fresh`,'POST');
  await chat(teammate.id, 'mock: say My charter is still loaded.');
  const requests=await (await fetch(`${mock}/_requests`)).json();
  const modelRequests=requests.filter((r)=>r.body.input?.[0]?.content?.startsWith('You are Nia,'));
  assert.ok(modelRequests.length); assert.match(modelRequests.at(-1).body.input[0].content,/Do not send outreach/);
  assert.ok(modelRequests.at(-1).body.input[0].content.includes(standing),'saved instructions reach the next actual model request');
  assert.ok(!modelRequests.at(-1).body.tools.some((t)=>t.name==='create_bot'));
  const masterRequests=requests.filter((r)=>r.body.input?.[0]?.content?.startsWith('You are Quinn,'));
  assert.ok(masterRequests.some((r)=>r.body.tools.some((t)=>t.name==='create_bot')));
  await chat(primary.id,'mock: replicate_bot {"bot_name":"Nia","new_name":"Nia Replica"} | say Replicated.');
  const replica=(await api('/bots')).bots.find((b)=>b.name==='Nia Replica'); assert.ok(replica); assert.notEqual(replica.id,teammate.id);
  assert.deepEqual((await api(`/bots/${replica.id}/setup`)).manifest.brief,(await api(`/bots/${teammate.id}/setup`)).manifest.brief);
  assert.ok(fs.readdirSync(path.join(root,'companion','profiles')).includes(replica.id));
  const {bot:blank}=await api('/bots','POST',{name:'Blank QA'});
  await page.locator('.bot-row').filter({hasText:'Blank QA'}).click();
  await page.getByText('No specific job defined yet. Describe what you want this agent to handle in chat.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Expected results',exact:true}).count(),0);
  for (const placeholder of await page.getByText('None specified.',{exact:true}).all()) assert.equal(await placeholder.isVisible(),false);
  assert.ok((await api(`/bots/${blank.id}/rows`)).rows.some(r=>r.body.text?.includes('What job would you like Blank QA to handle?')));
  await page.locator('aside.details').screenshot({path:'.context/shots/agent-configuration-empty.png'});
  // A room reached from Configuration keeps its ordinary Library header.
  await api('/rooms','POST',{name:'Configuration room QA',botIds:[primary.id,teammate.id]});
  await page.locator('.bot-row').filter({hasText:'Configuration room QA'}).click();
  assert.equal(await page.getByRole('button',{name:'Configuration',exact:true}).count(),0);
  assert.equal(await page.locator('.agent-config').count(),0);
  assert.equal(await page.locator('aside.details').evaluate(el=>el.classList.contains('details--configuration')),false);

  console.log('PASS creation, guided setup, tool enforcement, saved answers/SOUL/workflows, responsibilities/harness/files navigation, live instruction preview, editable standing instructions, failure recovery, keyboard navigation, mobile layouts and downloaded files, clean empty state, reviewed activation, deferred handoff, separate browsers, fresh-chat persistence and replication');
} catch(e) { console.error(logs.join('').slice(-7000)); throw e; }
finally { if(browser) await browser.close(); for(const p of children.reverse()) { if(p.exitCode===null) { p.kill('SIGTERM'); await Promise.race([new Promise((r)=>p.once('exit',r)),sleep(3000)]); if(p.exitCode===null) p.kill('SIGKILL'); } } fs.rmSync(root,{recursive:true,force:true}); }
