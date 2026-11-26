// R2F-003, R3-061, R2F-036 and R3-081. Uses only intercepted local API fixtures.
// UI_ORIGIN=http://127.0.0.1:<root-preview-port> node tests/qa-r3-work-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { fixturePage, gate, origin } from './qa-r3-work-fixture.mjs';

const evidence = new URL('../.context/qa-r3-work/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  const { page, fixture, errors, writes, reads } = await fixturePage(browser);
  const nextRunAt = Date.now() + 86_400_000;
  fixture.routines = [{ id: 'routine-check', botId: 'research-bot', name: 'Daily check', description: 'Every morning', prompt: 'Summarize saved work', schedule: '0 9 * * *', timezone: 'Asia/Dubai', enabled: true, nextRunAt, createdAt: 0 }];
  let failRun = false;
  fixture.respond = ({ path, method }) => {
    if (method === 'POST' && path === '/api/routines/routine-check/run') return failRun
      ? { status: 503, json: { error: 'Routine run unavailable. Try again.' } }
      : { json: { ok: true } };
  };
  await page.goto(origin);
  await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
  const work = page.locator('.tasks-view');
  const tab = name => work.getByRole('navigation', { name: 'Work sections' }).getByRole('button', { name, exact: true });
  const heading = work.locator('.work-heading');

  // Global chrome remains generic even when the primary Bot has an arbitrary name.
  await tab('Goals').click();
  const board = work.getByRole('button', { name: 'Team board', exact: true });
  await board.waitFor();
  assert.equal(await work.getByRole('button', { name: /Coordinator.*board/ }).count(), 0);
  await board.click();
  assert.match(await heading.innerText(), /Team board · Owners, dependencies and evidence/);
  assert.doesNotMatch(await heading.innerText(), /Coordinator/);
  await tab('Files').click();
  await work.getByText('Ask this Bot to save a file, or set up a daily synopsis.', { exact: true }).waitFor();
  assert.doesNotMatch(await heading.innerText(), /Coordinator/);
  await work.getByRole('combobox', { name: 'Bot' }).selectOption('research-bot');
  await work.getByText('Ask this Bot to save a file. Files saved by this Bot appear here.', { exact: true }).waitFor();
  assert.match(await heading.innerText(), /Research Bot/);
  assert.doesNotMatch(await heading.innerText(), /Coordinator/);

  // Changing the task scope carries through Goals, Team and Reports.
  await tab('Tasks').click();
  await work.getByRole('combobox', { name: 'Filter tasks by bot' }).selectOption('research-bot');
  await tab('Goals').click();
  await board.waitFor();
  assert.match(await heading.innerText(), /Research Bot/);
  assert.doesNotMatch(await heading.innerText(), /Coordinator/);
  await board.click();
  assert.match(await heading.innerText(), /Team board · Research Bot · /);
  assert.doesNotMatch(await heading.innerText(), /Coordinator/);
  await tab('Files').click();
  await work.getByText('Ask this Bot to save a file. Files saved by this Bot appear here.', { exact: true }).waitFor();
  assert.equal(await work.getByRole('combobox', { name: 'Bot' }).count(), 0);
  assert.match(await heading.innerText(), /Research Bot/);
  await work.getByRole('button', { name: 'Routines', exact: true }).click();
  const routines = work.getByRole('region', { name: 'Routines', exact: true });
  const run = routines.getByRole('button', { name: 'Run Daily check now', exact: true });
  await run.waitFor();
  assert.match(await routines.innerText(), /Next run .*Asia\/Dubai/);

  // A shared dialog asks before any run request. Cancel and Escape run nothing.
  const before = await run.boundingBox();
  await run.click();
  const dialog = page.locator('.confirm-dialog');
  await dialog.getByRole('heading', { name: 'Run Daily check now?', exact: true }).waitFor();
  await dialog.getByText('It runs once now. Its schedule does not change.', { exact: true }).waitFor();
  assert.deepEqual(await run.boundingBox(), before, 'Run now does not shift when confirmation opens');
  await page.screenshot({ path: new URL('work-run-confirm.png', evidence).pathname });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(writes, []);
  await run.click();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(writes, []);
  await run.click();
  await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
  await routines.getByText('Run requested. Open run history to check the recorded status.', { exact: true }).waitFor();
  assert.deepEqual(writes.map(({ path, method }) => `${method} ${path}`), ['POST /api/routines/routine-check/run']);
  failRun = true;
  await run.click();
  await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
  await routines.getByRole('alert').filter({ hasText: 'Routine run unavailable. Try again.' }).waitFor();
  assert.equal(writes.length, 2);
  assert.ok(reads.includes('/api/bots/research-bot/routines'));

  // The settings card uses the shared next-run formatter and keeps its own confirmation.
  await page.goto(`${origin}/#bot/research-bot/settings/routines`);
  const settings = page.getByRole('main', { name: 'Research Bot settings' });
  const next = settings.locator('.cfg-item__sub').filter({ hasText: 'Next' });
  await next.waitFor();
  const time = new Date(nextRunAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Dubai' });
  assert.ok((await next.innerText()).includes(`${time} Asia/Dubai`), 'card shows the routine time and its zone');
  await settings.getByRole('button', { name: 'Run Daily check now', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Run Daily check now?', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(writes.length, 2, 'settings cancellation still does not run');

  // Root owns the Composer fix. Exercise its real routine prefill pathway here.
  await settings.getByRole('button', { name: 'Ask Research Bot to add a routine', exact: true }).click();
  const composer = page.locator('.composer__input');
  await composer.waitFor();
  const prefill = await composer.inputValue();
  assert.match(prefill, /^Please add a routine: /);
  await composer.focus();
  assert.deepEqual(await composer.evaluate(element => [element.selectionStart, element.selectionEnd]), [prefill.length, prefill.length]);
  await composer.evaluate(element => element.blur());
  await composer.focus();
  assert.deepEqual(await composer.evaluate(element => [element.selectionStart, element.selectionEnd]), [prefill.length, prefill.length]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.app.is-mobile.pane-list').waitFor({ state: 'visible' });
  await page.locator('.sidebar .bot-row').filter({ hasText: 'Research Bot' }).click();
  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.inputValue(), prefill, 'opening the Bot from the phone list preserves its routine prefill');
  await composer.evaluate(element => element.blur());
  await composer.click({ position: { x: 12, y: 10 } });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.deepEqual(await composer.evaluate(element => [element.selectionStart, element.selectionEnd]), [prefill.length, prefill.length], 'pointer focus near the beginning also preserves the prefill caret on a phone');
  await composer.click({ position: { x: 12, y: 10 } });
  assert.ok(await composer.evaluate(element => element.selectionStart < element.value.length), 'a later click in the focused field can reposition the caret');
  await composer.press('Control+End');
  await page.keyboard.type(' Add a saved-work summary.');
  assert.equal(await composer.inputValue(), `${prefill} Add a saved-work summary.`);
  assert.ok(!writes.some(call => call.path.endsWith('/messages')), 'prefill and typing never send a message');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Unknown or paginated source kinds must not pretend to be an exhaustive app source list.
  const record = id => ({ id, seq: 1, slotKey: 'manual:fixture', slotCount: 1, timezone: 'Asia/Dubai', windowStart: 0, windowEnd: Date.now(), sourceCount: 105, status: 'saved', artifactId: null, gaps: [], coverage: { snapshotComplete: true, summaryComplete: false, pages: 2 }, delivery: null, generationNote: null, lastError: null });
  fixture.reports = [record('first-report')];
  fixture.sources = ['routine', 'goal', 'internal_snapshot_revision'].map((kind, ordinal) => ({ kind, ordinal, id: `source-${ordinal}`, title: 'Saved work', owner: 'Team', state: 'saved', revision: '1', details: '', changed: false }));
  await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
  await tab('Tasks').click();
  await work.getByRole('combobox', { name: 'Filter tasks by bot' }).selectOption('all');
  await tab('Files').click();
  await work.getByRole('combobox', { name: 'Bot' }).selectOption('coordinator');
  await work.getByRole('button', { name: 'Daily synopses', exact: true }).click();
  const synopses = work.getByRole('region', { name: 'Daily synopses', exact: true });
  const source = synopses.locator('.synopsis-source');
  await source.filter({ hasText: 'including routines and goals' }).waitFor();
  assert.equal(await source.innerText(), 'from your team’s work records in Swarm, including routines and goals');
  assert.doesNotMatch(await source.innerText(), /Gmail|internal|revision/);

  const delayedSources = gate();
  fixture.reports = [record('second-report')];
  fixture.respond = async ({ path }) => {
    if (path === '/api/checkins/reports/second-report/sources') {
      await delayedSources.wait;
      return { json: { sources: [{ ...fixture.sources[0], kind: 'artifact' }], nextCursor: 100, hasMore: true } };
    }
  };
  const arrived = page.waitForRequest(request => new URL(request.url()).pathname === '/api/checkins/reports/second-report/sources');
  await synopses.getByRole('button', { name: 'Refresh synopses', exact: true }).click();
  await arrived;
  assert.equal(await source.innerText(), 'from your team’s work records in Swarm', 'old source examples disappear while the new report loads');
  delayedSources.release();
  await source.filter({ hasText: 'including saved reports' }).waitFor();
  await page.screenshot({ path: new URL('synopsis-source.png', evidence).pathname });
  assert.deepEqual(errors, []);
  console.log('PASS R3 work: confirm/cancel/error, fixed button, routine zone, prefill caret, scoped chrome, accurate synopsis sources');
} finally { await browser.close(); }
