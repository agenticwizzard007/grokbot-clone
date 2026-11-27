import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { inspectAlignment } from '../layout-alignment-ui.mjs';

// Same isolated seed, offline boundary and server as layout-fixture.mjs, with
// a second seed process for handoff records and a local mock provider.
async function integrationServer(evidence) {
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
  fs.writeFileSync(preload, `const local = fetch; globalThis.fetch = (input, init) => { const url = new URL(input instanceof Request ? input.url : input); if (['127.0.0.1','localhost'].includes(url.hostname)) return local(input, init); return Promise.resolve(Response.json({data:[],items:[]})); };`);
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
const runner = await import(root + '/server/src/handoffs/loop-runner.ts');
const hooks = await import(root + '/server/src/handoffs/hooks.ts');
const reconcile = await import(root + '/server/src/handoffs/reconcile.ts');
const { appendRow } = await import(root + '/server/src/store.ts');
const fixture = JSON.parse(fs.readFileSync(process.env.PHONE_QA_FIXTURE_FILE!, 'utf8'));
const userId = fixture.userId, maker = fixture.bot.id;
const checker = (db.prepare("SELECT id FROM bots WHERE user_id=? AND id<>? AND kind='agent'").get(userId, maker) as any).id;
db.prepare("UPDATE bot_setups SET onboarding_status='active'").run();
db.prepare("UPDATE bots SET instructions='1. Review the brief.\\n2. Draft the report.' WHERE kind='agent'").run();
db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES('routine_integration',?,'Review fixture sources','Review placeholder sources','0 9 * * 1','UTC',1,?)").run(maker, Date.now());
db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES('task_integration',?,'Placeholder release draft','done','Version 1.0 is ready for review.',?,?)").run(maker, Date.now(), Date.now());
appendRow(maker, 'message', { type: 'message', role: 'assistant', text: 'The placeholder release draft is ready. Open Tasks to send it for review.' });
requests.configureCoordinationRuntime({ enqueue: (botId: string, trigger: any) => jobs.acceptJob(botId, trigger).id, interrupt() {} });
const spec = { name: 'Placeholder release review', goal: 'Review the version, length and call to action.', kind: 'maker_checker', steps: [{id:'maker',botId:maker,role:'maker',instruction:'Draft placeholder release notes.'},{id:'checker',botId:checker,role:'checker',instruction:'Check the placeholder draft.'}],seed:{text:'Placeholder release brief.'},exit:{mode:'verdict'},limits:{maxIterations:3,maxMinutes:30,stepTimeoutMinutes:10},gate:{before:'none',onCap:'stop'} };
const loop = loops.createLoop(userId, { spec, idempotencyKey: 'integration-demo', start: true } as any).loop;
for (let i=0; i<40; i++) {
  await new Promise(resolve => setImmediate(resolve)); reconcile.reconcileHandoffs(userId); runner.driveLoop(userId, loop.id);
  const current = loops.getLoop(userId, loop.id); if (loops.terminal(current.status)) break;
  const job = db.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND state IN ('queued','running') ORDER BY rowid LIMIT 1").get(userId) as any;
  if (!job) continue;
  jobs.beginJob(job.id);
  const step = loops.loopSteps(userId, loop.id).find(step => step.jobId === job.id)!;
  if (step.role === 'checker') loops.submitVerdict({userId,botId:job.bot_id,jobId:job.id,toolCallId:'verdict-'+i}, {pass:current.iteration===3,checklist:[],feedback:'Placeholder review pass '+current.iteration});
  const text = step.role === 'maker' ? 'Version '+current.iteration+'.0: Placeholder release notes. Try the release.' : 'Placeholder review pass '+current.iteration;
  jobs.finishJob(job.id, true); const result = {userId,botId:job.bot_id,jobId:job.id,status:'completed',finalText:text};
  requests.recordCoordinationJobOutcome(result); hooks.onJobFinished(result); requests.onInternalJobFinished(result);
}
const finished = loops.getLoop(userId, loop.id); if (finished.status !== 'succeeded') throw new Error('Seed loop did not converge: '+finished.status);
const paused = loops.createLoop(userId, { spec: {...spec,name:'Placeholder follow-up review'}, idempotencyKey:'integration-paused', start:false } as any).loop;
db.prepare("UPDATE loops SET status='paused' WHERE id=?").run(paused.id);
fs.writeFileSync(process.env.PHONE_QA_FIXTURE_FILE!, JSON.stringify({...fixture,checker,loopId:loop.id,pausedLoopId:paused.id,outputId:finished.bestOutputId}));
runner.stopLoopDeadlines(); reconcile.stopHandoffRecovery(); db.close();
`);
    const extra = start(['--import', preload, '--import', 'tsx', seedFile]); assert.equal((await once(extra, 'exit'))[0], 0, logs.join(''));
    await ready(`http://127.0.0.1:${mockPort}/_requests`, start(['tests/mock-provider.mjs', String(mockPort)]));
    await ready(`http://127.0.0.1:${apiPort}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
    await ready(base, start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` }));
    return { base, fixture: JSON.parse(fs.readFileSync(fixtureFile, 'utf8')), close };
  } catch (error) { await close(); throw error; }
}

export async function runIntegrationDemo() {
  const evidence = path.resolve('.context/handoffs/demo-i'); fs.mkdirSync(evidence, { recursive: true });
  const server = await integrationServer(evidence);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const checks = [], screenshots = []; let lastPage;
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      const page = await context.newPage(); lastPage = page; page.setDefaultTimeout(15000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => ['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await page.addInitScript(() => localStorage.setItem('swarm.theme', 'light'));
      const check = (name, detail = {}) => checks.push({ width, name, ...detail, pass: true });
      const capture = async name => { const file = path.join(evidence, `${name}-${width}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); };
      const alignment = async () => {
        const selector = await page.locator('main.paper-shell').count() ? 'main.paper-shell' : '.shell-content > :not(.shell-header):not(.phone-tabs)';
        assert.deepEqual(await page.evaluate(inspectAlignment, { selector }), []);
        if (width === 390) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
      };
      await page.goto(`${server.base}/#bot/${server.fixture.bot.id}`);
      await page.locator('.chat__bot-details').click();
      await page.locator('.pb-bot-tabs').getByRole('button', { name: 'Tasks', exact: true }).click();
      await page.getByRole('radio', { name: 'All', exact: true }).click();
      await page.getByRole('button', { name: 'Send to agent', exact: true }).first().click();
      const sheet = page.getByRole('dialog', { name: 'Send to agent' });
      await sheet.getByRole('button', { name: /Research/ }).click();
      await sheet.getByLabel('Ask', { exact: true }).fill('mock: say The placeholder review is ready.');
      await sheet.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByText('Sent to Research', { exact: false }).waitFor();
      await alignment(); await capture('receipt'); check('Chat to Tasks to Send to agent to receipt');
      await page.getByRole('link', { name: 'View', exact: true }).first().click();
      await page.getByRole('heading', { name: 'Handoff', exact: true }).waitFor();
      const handoffHash = new URL(page.url()).hash;
      await page.getByText('mock: say The placeholder review is ready.', { exact: true }).waitFor();
      await alignment(); check('Receipt opens real mounted handoff detail');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      if (width === 390) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
      await page.getByRole('link', { name: 'Loops', exact: true }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByText('Placeholder release review', { exact: true }).click();
      await page.getByText('Done in 3 passes: all checks passed.', { exact: true }).waitFor();
      await alignment(); await capture('loop-timeline'); check('Tasks Loops entry opens converged timeline');
      await page.getByRole('button', { name: 'Use this', exact: true }).click();
      await page.getByRole('heading', { name: /Version 3/ }).waitFor();
      await alignment(); check('Use this opens output viewer');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.locator('.shell-back').click();
      await page.locator('.pb-bot-tabs').getByRole('button', { name: 'Flow', exact: true }).click();
      await page.locator('.flow-chart').waitFor();
      await alignment(); await capture('flow'); check('Tasks tab to Flow through real app tabs');
      await page.getByRole('button', { name: /Review fixture sources/ }).click();
      await page.locator('[data-flow-focus="routine:routine_integration"]').waitFor();
      assert.equal(await page.locator('[data-flow-focus]').evaluate(el => document.activeElement === el), true);
      check('Flow routine destination consumes focus hint');
      await page.goBack(); await page.locator('.flow-chart').waitFor();
      await page.getByRole('button', { name: /Placeholder follow-up review/ }).click();
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
      assert.deepEqual(errors, []); await context.close();
    }
    const report = { checks, passed: checks.length, screenshots, realProviderCalls: 0,
      deviations: ['Stage 1 enters Send to agent through the existing chat Tasks tab. Chat message mounts await stage 2.'], fixture: server.fixture };
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`HO-I integration UI: ${checks.length} checks passed; 0 real provider calls`);
    console.log(`Demo output: ${path.join(evidence, 'report.json')}`);
    return report;
  } catch (error) { if (lastPage && !lastPage.isClosed()) { await lastPage.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(evidence, 'failure.html'), await lastPage.content()); } throw error; }
  finally { await browser.close(); await server.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await runIntegrationDemo();
