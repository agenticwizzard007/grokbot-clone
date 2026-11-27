import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Same isolated seed, offline boundary and server as layout-fixture.mjs, with
// a second seed process for handoff records and a local mock provider.
export async function integrationServer(evidence) {
  const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-i-'));
  async function port() { const server = net.createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
  const apiPort = await port(), uiPort = await port(), mockPort = await port(), base = `http://127.0.0.1:${uiPort}`;
  const fixtureFile = path.join(temp, 'fixture.json');
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1',
    DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
    SESSION_SECRET: 'layout-test', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', WHATSAPP_DISABLED: '1',
    PHONE_QA_FIXTURE_FILE: fixtureFile, PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
    DIRECT_API_KEY: 'placeholder', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, LLM_PROVIDER: 'direct' };
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `const local = fetch; globalThis.fetch = (input, init) => { const url = new URL(input instanceof Request ? input.url : input); if (['127.0.0.1','localhost'].includes(url.hostname)) { if (url.port === '${mockPort}' && url.pathname.endsWith('/responses') && typeof init?.body === 'string') { const body = JSON.parse(init.body); const user = body.input?.findLast(item => item.role === 'user'); if (user) { const slow = JSON.stringify(user.content).includes('Review the next release draft'); user.content = (slow ? 'mock-delay:3000 ' : '') + 'mock: say The release note includes the version, benefits and next step. Ready to publish.'; init = {...init, body:JSON.stringify(body)}; } } return local(input, init); } return Promise.resolve(Response.json({data:[],items:[]})); };`);
  const children = [], logs = [];
  function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); return child; }
  async function ready(url, child) { for (let i = 0; i < 300; i++) { assert.equal(child.exitCode, null, logs.join('')); if (await fetch(url).then(r => r.ok).catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(logs.join('')); }
  const close = async () => { for (const child of children) if (child.exitCode === null) child.kill(); await Promise.all(children.filter(child => child.exitCode === null).map(child => once(child, 'exit'))); fs.writeFileSync(path.join(evidence, 'server.log'), logs.join('')); fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    const seed = start(['--import', 'tsx', 'tests/fixtures/layout.seed.mts']); assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    const seedFile = path.join(evidence, 'seed.mts');
    fs.writeFileSync(seedFile, `
import fs from 'node:fs';
const root = ${JSON.stringify(root)};
const { db } = await import(root + '/server/src/db.ts');
const jobs = await import(root + '/server/src/agent/jobs.ts');
const requests = await import(root + '/server/src/coordination/requests.ts');
const outputs = await import(root + '/server/src/handoffs/outputs.ts');
const loops = await import(root + '/server/src/handoffs/loop-service.ts');
const links = await import(root + '/server/src/handoffs/link-service.ts');
const runner = await import(root + '/server/src/handoffs/loop-runner.ts');
const hooks = await import(root + '/server/src/handoffs/hooks.ts');
const reconcile = await import(root + '/server/src/handoffs/reconcile.ts');
const { appendRow } = await import(root + '/server/src/store.ts');
const { saveMcpServer } = await import(root + '/server/src/mcp/store.ts');
const fixture = JSON.parse(fs.readFileSync(process.env.PHONE_QA_FIXTURE_FILE!, 'utf8'));
const userId = fixture.userId, maker = fixture.bot.id;
db.prepare("INSERT INTO skills(id,bot_id,name,body,created_at) VALUES('skill_integration',?,'Source verification','Verify release sources.',?)").run(maker, Date.now());
const mcp = saveMcpServer(userId, {name:'Reference library',transport:'http',url:'https://example.test/mcp',botIds:[maker],enabled:false});
const checker = (db.prepare("SELECT id FROM bots WHERE user_id=? AND id<>? AND kind='agent'").get(userId, maker) as any).id;
db.prepare("UPDATE bot_setups SET onboarding_status='active'").run();
db.prepare("UPDATE bots SET instructions='1. Review the brief.\\n2. Draft the report.' WHERE kind='agent'").run();
db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES('routine_integration',?,'Review release sources','Review release sources','0 9 * * 1','UTC',1,?)").run(maker, Date.now());
db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES('task_integration',?,'Release note draft','done','Version 1.0 is ready for review.',?,?)").run(maker, Date.now(), Date.now());
appendRow(maker, 'message', { type: 'message', role: 'assistant', text: 'The release note draft is ready for review.' });
appendRow(fixture.room, 'message', { type: 'message', role: 'assistant', text: 'Release draft ready for review.', from: {kind:'bot',id:maker,name:'Coordinator'} });
links.replaceLinks(userId,maker,[{toBotId:checker,mode:'suggest',trigger:'any_run',template:'Review {title}.',autoApproveLoops:false}]);
requests.configureCoordinationRuntime({ enqueue: (botId: string, trigger: any) => jobs.acceptJob(botId, trigger).id, interrupt() {} });
const spec = { name: 'Release note review', goal: 'Review the version, length and call to action.', kind: 'maker_checker', steps: [{id:'maker',botId:maker,role:'maker',instruction:'Draft release notes.'},{id:'checker',botId:checker,role:'checker',instruction:'Check the release draft.'}],seed:{text:'Release brief.'},exit:{mode:'verdict'},limits:{maxIterations:3,maxMinutes:30,stepTimeoutMinutes:10},gate:{before:'none',onCap:'stop'} };
const loop = loops.createLoop(userId, { spec, idempotencyKey: 'integration-demo', start: true } as any).loop;
for (let i=0; i<40; i++) {
  await new Promise(resolve => setImmediate(resolve)); reconcile.reconcileHandoffs(userId); runner.driveLoop(userId, loop.id);
  const current = loops.getLoop(userId, loop.id); if (loops.terminal(current.status)) break;
  const job = db.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND state IN ('queued','running') ORDER BY rowid LIMIT 1").get(userId) as any;
  if (!job) continue;
  jobs.beginJob(job.id);
  const step = loops.loopSteps(userId, loop.id).find(step => step.jobId === job.id)!;
  if (step.role === 'checker') loops.submitVerdict({userId,botId:job.bot_id,jobId:job.id,toolCallId:'verdict-'+i}, {pass:current.iteration===3,checklist:[],feedback:'Review pass '+current.iteration});
  const text = step.role === 'maker' ? 'Version '+current.iteration+'.0: Release notes. Try the release.' : 'Review pass '+current.iteration;
  jobs.finishJob(job.id, true); const result = {userId,botId:job.bot_id,jobId:job.id,status:'completed',finalText:text};
  requests.recordCoordinationJobOutcome(result); hooks.onJobFinished(result); requests.onInternalJobFinished(result);
}
const finished = loops.getLoop(userId, loop.id); if (finished.status !== 'succeeded') throw new Error('Seed loop did not converge: '+finished.status);
const chatJob = jobs.acceptJob(maker, {type:'user',text:'Draft a release note.'}); jobs.beginJob(chatJob.id); jobs.finishJob(chatJob.id,true);
hooks.onJobFinished({userId,botId:maker,jobId:chatJob.id,status:'completed',finalText:'Release note draft\\nVersion 2.0 improves search and simplifies setup. Try it in your next project.'});
appendRow(maker,'message',{type:'message',role:'assistant',jobId:chatJob.id,text:'Release note draft ready for review.'});
const paused = loops.createLoop(userId, { spec: {...spec,name:'Follow-up review'}, idempotencyKey:'integration-paused', start:false } as any).loop;
db.prepare("UPDATE loops SET status='paused' WHERE id=?").run(paused.id);
fs.writeFileSync(process.env.PHONE_QA_FIXTURE_FILE!, JSON.stringify({...fixture,checker,mcpId:mcp.id,loopId:loop.id,pausedLoopId:paused.id,outputId:finished.bestOutputId}));
runner.stopLoopDeadlines(); reconcile.stopHandoffRecovery(); db.close();
`);
    const extra = start(['--import', preload, '--import', 'tsx', seedFile]); assert.equal((await once(extra, 'exit'))[0], 0, logs.join(''));
    await ready(`http://127.0.0.1:${mockPort}/_requests`, start(['tests/mock-provider.mjs', String(mockPort)]));
    await ready(`http://127.0.0.1:${apiPort}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
    const viteConfig = path.join(evidence, 'vite.config.mts');
    fs.writeFileSync(viteConfig, `import config from ${JSON.stringify(path.join(root, 'web/vite.config.ts'))}; export default {...config, cacheDir:${JSON.stringify(path.join(temp, 'vite-cache'))}};`);
    await ready(base, start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--config', viteConfig, '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` }));
    return { base, fixture: JSON.parse(fs.readFileSync(fixtureFile, 'utf8')), close };
  } catch (error) { await close(); throw error; }
}

export async function runIntegrationDemo() {
  const { inspectAlignment } = await import('../layout-alignment-ui.mjs');
  const evidence = path.resolve('.context/handoffs/demo-i'); fs.mkdirSync(evidence, { recursive: true });
  const server = await integrationServer(evidence);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const checks = [], screenshots = []; let lastPage;
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      const page = await context.newPage(); lastPage = page; page.setDefaultTimeout(15000);
      const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.message); });
      await page.route('**/*', route => ['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await page.addInitScript(() => { localStorage.setItem('swarm.theme', 'light'); window.handoffEvents = []; window.addEventListener('swarm:event', event => window.handoffEvents.push(event.detail.type)); });
      const check = (name, detail = {}) => { checks.push({ width, name, ...detail, pass: true }); console.log(`PASS ${width}: ${name}`); };
      const capture = async name => { const file = path.join(evidence, `${name}-${width}.png`); if (name !== 'receipt') await page.setViewportSize({ width, height: Math.min(4000, await page.locator(name === 'flow' ? '.flow-page' : '.ho-route').evaluate(el => el.scrollHeight) + 160) }); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); await page.setViewportSize({ width, height: 1000 }); };
      const openSidebar = async () => { if (width === 390) await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); };
      const openBot = async name => { await openSidebar(); await page.locator('.sidebar').getByRole('button', { name: new RegExp(`^${name}(?:[^a-z]|$)`) }).click(); };
      const alignment = async () => {
        const selector = await page.locator('main.paper-shell').count() ? 'main.paper-shell' : '.shell-content > :not(.shell-header):not(.phone-tabs)';
        assert.deepEqual(await page.evaluate(inspectAlignment, { selector }), []);
        if (width === 390) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
      };
      await page.goto(`${server.base}/#bot/${server.fixture.bot.id}`);
      await page.getByRole('button', { name: 'Message actions', exact: true }).first().click();
      await page.getByRole('menuitem', { name: 'Send to agent', exact: true }).click();
      await page.getByRole('dialog', { name: 'Send to agent' }).waitFor(); await page.keyboard.press('Escape');
      check('Assistant message overflow snapshots output and opens Send to agent');
      await page.locator('.ho-output-card').getByRole('button', { name: 'Send to agent', exact: true }).first().click();
      const sheet = page.getByRole('dialog', { name: 'Send to agent' });
      await sheet.getByRole('button', { name: /Research/ }).click();
      const instruction = width === 390 ? 'Review the release note against the brief.' : 'Check the release note for missing details.';
      await sheet.getByLabel('Ask', { exact: true }).fill(instruction);
      await sheet.getByRole('button', { name: 'Send', exact: true }).click();
      const receipt = page.locator('.ho-receipt').filter({ hasText: instruction });
      await receipt.getByText('Sent to Research', { exact: true }).waitFor();
      await page.locator('.load-feedback[aria-busy="true"]').waitFor({ state: 'hidden' });
      await alignment(); await capture('receipt'); check('Chat output card to Send to agent to live receipt');
      await page.waitForFunction(() => ['handoff','output'].every(type => window.handoffEvents.includes(type)));
      check('Main SSE forwards handoff and output events');
      await receipt.getByRole('link', { name: /^View handoff/ }).click();
      await page.getByRole('heading', { name: 'Handoff', exact: true }).waitFor();
      const handoffHash = new URL(page.url()).hash;
      await page.getByText(instruction, { exact: true }).waitFor();
      await page.locator('.ho-output-card').waitFor();
      await alignment(); check('Receipt opens handoff detail with returned output');
      await openBot('Research');
      await page.locator('.ho-receipt').filter({ hasText: instruction }).getByText('Handed off from Coordinator', { exact: true }).waitFor();
      check('Receiver chat displays its handoff row');
      await page.locator('.shell-back:visible').click();
      await page.locator('.shell-back:visible').click();
      if (width === 390) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.locator('.sidebar').getByRole('button', { name: 'Account & settings', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Loops', exact: true }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByText('Release note review', { exact: true }).click();
      await page.getByText('Done in 3 passes: all checks passed.', { exact: true }).waitFor();
      await alignment(); await capture('loop-timeline'); check('Sidebar overflow opens Loops and converged timeline');
      await page.getByRole('button', { name: 'Use this', exact: true }).click();
      await page.getByRole('heading', { name: /Version 3/ }).waitFor();
      await alignment(); check('Use this opens output viewer');
      await page.locator('.shell-back:visible').click();
      await page.locator('.shell-back:visible').click();
      await page.locator('.shell-back:visible').click();
      await page.locator('.chat__bot-details').click();
      await page.locator('.pb-bot-tabs').getByRole('button', { name: 'Flow', exact: true }).click();
      await page.locator('.flow-chart').waitFor();
      await alignment(); await capture('flow'); check('Chat details to Flow through real app tabs');
      await page.getByRole('button', { name: /Review release sources/ }).click();
      await page.locator('[data-flow-focus="routine:routine_integration"]').waitFor();
      assert.equal(await page.locator('[data-flow-focus]').evaluate(el => document.activeElement === el), true);
      check('Flow routine destination consumes focus hint');
      await page.goBack(); await page.locator('.flow-chart').waitFor();
      for (const [label, focus] of [['Skill: Source verification', 'skill:skill_integration'], ['Reference library', `mcp:${server.fixture.mcpId}`]]) {
        await page.getByRole('button', { name: new RegExp(label) }).click();
        await page.locator(`[data-flow-focus="${focus}"]`).waitFor();
        assert.equal(await page.locator('[data-flow-focus]').evaluate(el => document.activeElement === el), true);
        check(`Flow ${focus.split(':')[0]} destination consumes focus hint`);
        await page.goBack(); await page.locator('.flow-chart').waitFor();
      }
      await page.getByRole('button', { name: /Follow-up review/ }).click();
      await page.getByRole('button', { name: 'Resume', exact: true }).waitFor(); check('Flow loop destination works warm');
      for (const [hash, marker] of [
        ['#loops', '.ho-loops'], [`#loop/${server.fixture.loopId}`, '[data-loop-revision]'], [handoffHash, '.ho-heading'],
        [`#output/${server.fixture.outputId}?part=p_body`, '.ho-part-text'],
        [`#bot/${server.fixture.bot.id}/details/flow`, '.flow-chart'],
        [`#bot/${server.fixture.bot.id}/details/flow?link=new`, '.flow-sheet'],
      ]) {
        await page.goto(server.base + '/' + hash); await page.locator(marker).waitFor();
        if (!hash.includes('link=')) await alignment();
        check('Cold route ' + hash);
      }
      await page.keyboard.press('Escape');
      await openBot('Project room');
      await page.getByRole('button', { name: 'Message actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Send to agent', exact: true }).click();
      await page.getByRole('dialog', { name: 'Send to agent' }).getByRole('button', { name: /Research/ }).click();
      assert.equal(await page.locator('.ho-target').count(), 1);
      await page.keyboard.press('Escape'); check('Room message Send lists the other member');
      await openBot('Coordinator');
      await page.locator('.ho-output-card').getByRole('button', { name: 'Send to agent', exact: true }).first().click();
      await sheet.getByRole('button', { name: /Research/ }).click();
      await page.waitForFunction(() => document.querySelector('.ho-dialog textarea')?.value.includes('Release note draft'));
      await sheet.getByLabel('Ask', { exact: true }).fill('Review the next release draft.');
      await sheet.getByLabel('Keep improving', { exact: true }).check();
      await sheet.getByLabel('Stop when', { exact: true }).selectOption('manual');
      await sheet.getByRole('button', { name: 'Start loop', exact: true }).click();
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page.getByText('Stopped by you.', { exact: true }).waitFor();
      await page.waitForFunction(() => window.handoffEvents.includes('loop'));
      check('Suggested Send to Keep improving starts a loop with Pause, Resume and Stop');
      await openSidebar();
      await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
      await page.locator('.task-filters .is-done').click();
      await page.locator('.task-card-frame').filter({ hasText: 'Release note draft' }).getByRole('button', { name: 'Send to agent', exact: true }).click();
      await sheet.waitFor(); await page.keyboard.press('Escape'); check('Done task card opens Send to agent');
      assert.deepEqual(errors, []); await context.close();
    }
    const report = { checks, passed: checks.length, screenshots, realProviderCalls: 0,
      deviations: ['Settings Agents and output chat card kinds remain gated on UC-G.'], fixture: server.fixture };
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`HO-I integration UI: ${checks.length} checks passed; 0 real provider calls`);
    console.log(`Demo output: ${path.join(evidence, 'report.json')}`);
    return report;
  } catch (error) { if (lastPage && !lastPage.isClosed()) { await lastPage.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(evidence, 'failure.html'), await lastPage.content()); } throw error; }
  finally { await browser.close(); await server.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await runIntegrationDemo();
