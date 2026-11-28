// Isolated local sessions and seeded jobs. No provider calls or real account data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';

const server = await layoutServer({ root: path.resolve(process.env.LW_ROOT || '.') });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const shots = process.env.LW_SHOTS || '.context/livewalk/shots';
fs.mkdirSync(shots, { recursive: true });
const db = new Database(server.dbPath), failures = [];
try {
  const { bot, userId } = server.fixture, at = Date.now();
  for (const [index, state] of ['running', 'completed'].entries()) {
    const job = `job_d4_${state}`;
    db.prepare('INSERT INTO agent_jobs(id,user_id,bot_id,trigger,state,created_at) VALUES(?,?,?,?,?,?)')
      .run(job, userId, bot.id, '{"type":"user"}', state, at);
    db.prepare('INSERT INTO rows(bot_id,generation,seq,kind,body,created_at,updated_seq) VALUES(?,?,?,?,?,?,?)')
      .run(bot.id, bot.generation, index + 1, 'message', JSON.stringify({ type: 'message', role: 'assistant', text: `Local ${state} reply.`, jobId: job }), at, index + 1);
  }
  for (const width of [390, 1280]) {
    db.prepare("UPDATE agent_jobs SET state='running' WHERE id='job_d4_running'").run();
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await context.addInitScript(() => { localStorage.setItem('swarm.theme', 'light'); localStorage.setItem('swarm.detailsOpen', '0'); });
    const page = await context.newPage(), errors = [], failed = [], calls = [];
    const watched = url => /\/api\/(ui\/config|outputs\/by-job\/)/.test(url);
    page.on('response', r => {
      if (watched(r.url()) && r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
      if (r.url().includes('/outputs/by-job/') && r.ok()) calls.push({ job: r.url().split('/').at(-1), at: Date.now() });
    });
    page.on('requestfailed', r => { if (watched(r.url()) && !r.failure()?.errorText.includes('ERR_ABORTED')) failed.push(r.url()); });
    page.on('console', message => { if (message.type() === 'error' && watched(message.location().url || '')) errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.base}/#bot/${bot.id}`);
    await page.getByText('Local completed reply.', { exact: true }).waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, `D4-${process.env.LW_STAGE || 'after'}-${width}.png`), fullPage: true });
    const terminalReads = () => calls.filter(call => call.job === 'job_d4_completed').length;
    const initial = terminalReads();
    for (let n = 0; n < 6; n++) await page.evaluate(() => window.dispatchEvent(new CustomEvent('swarm:event', { detail: { type: 'output', id: 'unrelated', botId: 'another-bot' } })));
    await page.waitForTimeout(3600);
    const active = calls.filter(call => call.job === 'job_d4_running');
    try {
      assert.deepEqual(failed, [], `${width}: failed route responses`);
      assert.deepEqual(errors, [], `${width}: console errors`);
      assert.ok(initial > 0, 'completed reply must be checked');
      assert.equal(terminalReads(), initial, 'terminal jobs ignore unrelated invalidations');
      assert.ok(active.length >= 3 && active.length <= 4, 'active jobs use bounded polling');
      assert.ok(active.at(-1).at - active.at(-2).at >= 1800, 'empty results back off');
    } catch (error) { failures.push(error); }
    db.prepare("UPDATE agent_jobs SET state='completed' WHERE id='job_d4_running'").run();
    await page.waitForTimeout(4500);
    const settled = calls.length;
    await page.waitForTimeout(8500);
    try { assert.equal(calls.length, settled, 'polling stops when a job becomes terminal'); }
    catch (error) { failures.push(error); }
    console.log(`${width}: ${failed.length} failed requests, ${errors.length} console errors, ${calls.length} output reads`);
    await context.close();
  }
  assert.deepEqual(failures.map(error => error.message), []);
  console.log('PASS D4 chat requests, backoff and terminal stop at 390 and 1280');
} finally { db.close(); await browser.close(); await server.close(); }
