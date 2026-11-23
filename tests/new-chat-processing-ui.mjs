// Full app with local API fixtures. No live Bots or provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const origin = new URL(process.env.UI_ORIGIN || `http://127.0.0.1:${port}`).origin;
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Use a dedicated local UI server');
const vite = process.env.UI_ORIGIN ? undefined : spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '', browser;
vite?.stdout.on('data', data => { logs += data; });
vite?.stderr.on('data', data => { logs += data; });
const evidence = new URL('../.context/new-chat-processing/', import.meta.url);
await mkdir(evidence, { recursive: true });
const bots = [
  { id: 'primary', name: 'Primary Bot', isPrimary: true, avatarShape: 'bird-soar', avatarColor: 'orange' },
  { id: 'research', name: 'Research Bot', isPrimary: false, avatarShape: 'bird-pair', avatarColor: 'violet' },
].map(bot => ({ kind: 'agent', mode: 'personal', generation: 1, unread: 0, createdAt: 0, lastActivityAt: 0, description: '', label: '', instructions: '', model: null, effort: 'medium', ...bot }));

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(origin).then(response => response.ok, () => false)) break;
    if (vite && vite.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const scenarios = [
    { width: 1440, height: 900 }, { width: 1440, height: 900, long: true },
    { width: 390, height: 900 }, { width: 320, height: 568 }, { width: 320, height: 568, long: true },
  ];
  for (const scenario of scenarios) for (const theme of ['light', 'dark']) for (const identity of bots) {
    const { width, height } = scenario;
    const bot = { ...identity, description: scenario.long ? 'A Bot for detailed research, planning, and careful review. '.repeat(5) : '' };
    const label = `${width}-${theme}-${bot.id}${scenario.long ? '-long' : ''}`;
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'no-preference' });
    page.setDefaultTimeout(8000);
    const unexpected = [];
    page.on('pageerror', error => unexpected.push(error.message));
    let generation = 1, rows = [], exchanges = [];
    const row = (seq, role, text, streaming = false) => ({ botId: bot.id, generation, seq, updatedSeq: seq, kind: 'message', audience: 'user', createdAt: Date.now(), body: { type: 'message', role, text, streaming } });
    await page.addInitScript(({ theme, botId }) => {
      localStorage.setItem('swarm.theme', theme);
      localStorage.setItem('swarm.selectedBot', botId);
      window.EventSource = class {
        static CLOSED = 2;
        constructor() {
          window.emitProcessingEvent = event => this.onmessage?.({ data: JSON.stringify(event) });
          setTimeout(() => this.onopen?.(), 0);
        }
        close() {}
      };
    }, { theme, botId: bot.id });
    const emit = event => page.evaluate(async value => {
      window.emitProcessingEvent(value);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, event);
    let runStartedAt = null;
    const live = changes => {
      if (changes?.isRunning === false) runStartedAt = null;
      else runStartedAt ??= Date.now();
      return emit({ type: 'live', state: { botId: bot.id, audience: 'user', isRunning: true, startedAt: runStartedAt, activity: null, awaiting: null, ...changes } });
    };
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
      if (!path.startsWith('/api/')) return route.continue();
      if (path.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
      if (request.method() === 'POST' && path === `/api/bots/${bot.id}/messages`) {
        rows = [row(1, 'user', request.postDataJSON().text)];
        await route.fulfill({ json: { row: rows[0] } });
        await emit({ type: 'rows', botId: bot.id, generation, rows });
        return;
      }
      if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${path}`); return route.abort(); }
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' } };
      else if (path === '/api/bots') body = { bots: bots.map(candidate => candidate.id === bot.id ? bot : candidate), live: [] };
      else if (path.endsWith('/rows')) body = { generation, rows: path === `/api/bots/${bot.id}/rows` ? rows : [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path === '/api/team/exchanges') body = { exchanges, nextBefore: null };
      else if (path === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [], favourites: [], canFast: false };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (path === '/api/checkins/reports') body = { reports: [], nextCursor: null, hasMore: false };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      return route.fulfill({ json: body });
    });
    await page.goto(origin);
    if (width < 761) await page.locator(bot.isPrimary ? '.pinned__tile' : '.bot-row').filter({ hasText: bot.name }).click();
    const panel = page.locator('.first-response');
    const mark = panel.locator('.first-response__mark');
    const moving = mark.locator('.bot-avatar--working > svg');
    const idle = mark.locator('.bot-avatar > svg');
    const geometry = () => page.evaluate(() => Object.fromEntries(['.composer-area', '.transcript', '.bubble-wrap.is-right'].map(selector => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return [selector, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null];
    })));
    const sameGeometry = (before, after) => {
      for (const selector of Object.keys(before)) if (before[selector]) {
        assert.ok(after[selector], `${label}: ${selector} remains mounted`);
        for (const key of Object.keys(before[selector])) assert.ok(Math.abs(before[selector][key] - after[selector][key]) < 1, `${label}: ${selector} ${key} does not jump (${before[selector][key]} -> ${after[selector][key]})`);
      }
    };
    const working = async () => {
      await moving.waitFor();
      assert.equal(await moving.getAttribute('data-bird'), bot.avatarShape);
      assert.equal(await mark.locator('.flock-mark, .bot-avatar__working').count(), 0);
      const box = await mark.boundingBox();
      assert.equal(box.width, 72); assert.equal(box.height, 72);
      const viewport = await page.locator('.transcript').boundingBox();
      assert.ok(box.y >= viewport.y && box.y + box.height <= viewport.y + viewport.height, `${label}: the whole processing mark is inside the transcript clip`);
    };
    const hasPixelMotion = async () => {
      const first = await moving.screenshot();
      for (let frame = 0; frame < 8; frame++) {
        await page.waitForTimeout(110);
        if (!first.equals(await moving.screenshot())) return;
      }
      assert.fail(`${label}: the working artwork must animate`);
    };
    await page.locator('.empty-chat').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const emptyGeometry = await geometry();
    await live(); // A run can start before the first user row arrives.
    await working();
    sameGeometry(emptyGeometry, await geometry());
    await live({ isRunning: false });
    assert.equal(await moving.count(), 0);
    sameGeometry(emptyGeometry, await geometry());
    await live({ audience: 'internal' });
    assert.equal(await moving.count(), 0, 'internal runs do not animate the default state');
    await live({ isRunning: false });

    // Exercise the real composer send flow and the row-before-live event ordering.
    await page.getByRole('textbox', { name: `Message ${bot.name}` }).fill(scenario.long ? 'Please review all requirements and prepare a detailed plan with milestones, validation steps, and dependencies. '.repeat(5) : 'Summarize the research.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.bubble.is-user').waitFor();
    await page.waitForFunction(() => document.querySelector('.composer__input')?.value === '');
    const before = await geometry();
    await live();
    await working();
    await hasPixelMotion();
    assert.equal(await page.locator('.activity-line').count(), 0, 'the default first-turn animation is the Bot avatar');
    sameGeometry(before, await geometry());
    assert.equal(await page.locator('.chat__header .bot-avatar > svg').count(), 1, 'the Bot identity shape stays in the header');
    await page.screenshot({ path: new URL(`${label}-working.png`, evidence).pathname });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await idle.waitFor();
    assert.equal(await idle.evaluate(el => el.getAnimations().length), 0);
    const staticFrame = await mark.screenshot();
    await page.waitForTimeout(400);
    assert.ok(staticFrame.equals(await mark.screenshot()), `${label}: reduced motion is still`);
    sameGeometry(before, await geometry());
    await page.screenshot({ path: new URL(`${label}-reduced.png`, evidence).pathname });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await working();
    await live({ isRunning: false });
    assert.equal(await moving.count(), 0, 'finishing without output stops the animation');
    sameGeometry(before, await geometry());
    await live();
    await working();
    await live({ awaiting: { reason: 'Confirm the task', since: Date.now() } });
    assert.equal(await moving.count(), 0, 'awaiting input stops the primary processing artwork');
    await live();
    await working();

    // Delegation during this first run is still processing, even before any text.
    exchanges = [{ id: 'first-run-exchange', firstSeq: 1, lastSeq: 1, createdAt: Date.now(), messageCount: 1, version: 1,
      participants: bots.map(({ id, name, avatarColor, avatarShape }) => ({ id, name, avatarColor, avatarShape })) }];
    await emit({ type: 'native', botId: bot.id });
    await page.locator('.agent-exchange').waitFor();
    await working();
    const beforeStream = await geometry();
    const response = row(2, 'assistant', 'Ready.', true);
    rows.push(response);
    await emit({ type: 'rows', botId: bot.id, generation, rows: [response] });
    await page.locator('.bubble.is-streaming').waitFor();
    assert.equal(await panel.count(), 0, 'streaming removes the processing panel');
    sameGeometry(beforeStream, await geometry());
    await page.screenshot({ path: new URL(`${label}-streaming.png`, evidence).pathname });
    response.body.streaming = false; response.updatedSeq = 3;
    await emit({ type: 'rows', botId: bot.id, generation, rows: [response] });
    await live();
    assert.equal(await panel.count(), 0, 'a pause after the first assistant message never restarts the default loader');
    assert.equal(await page.locator('.activity-line').count(), 0, 'a delivered reply does not add another loading treatment');
    const tool = { ...row(3, 'assistant', ''), kind: 'tool-call', body: { type: 'tool-call', callId: 'lookup', name: 'search', label: 'Checking sources', args: {}, status: 'running' } };
    await emit({ type: 'rows', botId: bot.id, generation, rows: [tool] });
    assert.equal(await panel.count(), 0, 'a later tool row keeps established chat activity');
    await live({ isRunning: false });
    assert.equal(await page.locator('.transcript .bot-avatar--working').count(), 0);

    // Clearing a conversation starts a fresh first turn in the new generation.
    generation++; rows = []; exchanges = [];
    await emit({ type: 'cleared', botId: bot.id, generation });
    await page.locator('.empty-chat').waitFor();
    await live();
    await working();
    await live({ isRunning: false });

    // Multiple queued prompts and tool status must share the same stable handoff.
    const queued = [row(1, 'user', 'Review the research. '.repeat(scenario.long ? 25 : 1)), row(2, 'user', 'Include the sources.')];
    const firstTool = { ...row(3, 'assistant', ''), kind: 'tool-call', body: { type: 'tool-call', callId: 'sources', name: 'search', label: 'Checking sources', args: {}, status: 'running' } };
    await emit({ type: 'rows', botId: bot.id, generation, rows: [...queued, firstTool] });
    await live();
    await working();
    await panel.locator('.activity-line').waitFor();
    const withTools = await geometry();
    const reserved = (await panel.boundingBox()).height;
    const firstReply = row(4, 'assistant', 'Ready.', true);
    await emit({ type: 'rows', botId: bot.id, generation, rows: [firstReply] });
    await page.locator('.bubble.is-streaming').waitFor();
    sameGeometry(withTools, await geometry());
    const responseGroup = page.locator('.group.is-left').first();
    assert.ok((await responseGroup.boundingBox()).height >= reserved, 'the response inherits the entire loader and tool-status slot');
    firstReply.body.streaming = false; firstReply.updatedSeq = 5;
    await emit({ type: 'rows', botId: bot.id, generation, rows: [firstReply, row(5, 'user', 'Continue.')] });
    assert.ok((await responseGroup.boundingBox()).height >= reserved, 'another user message does not revoke the reservation');
    await live({ isRunning: false });
    await live();
    await working();
    await live({ isRunning: false });

    // Older exchanges must not turn the main processing treatment into a small activity mark.
    generation++; rows = [];
    exchanges = [{ id: 'prior-exchange', firstSeq: 1, lastSeq: 1, createdAt: Date.now() - 60_000, messageCount: 1, version: 1,
      participants: bots.map(({ id, name, avatarColor, avatarShape }) => ({ id, name, avatarColor, avatarShape })) }];
    await emit({ type: 'cleared', botId: bot.id, generation });
    await page.locator('.agent-exchange').waitFor();
    await emit({ type: 'rows', botId: bot.id, generation, rows: [row(1, 'user', 'Continue the existing research.')] });
    await live();
    await working();
    await hasPixelMotion();
    await live({ isRunning: false });

    // Every reply gets the large loader, including after completed assistant messages.
    generation++; exchanges = [];
    rows = [row(1, 'user', 'Earlier request.'), row(2, 'assistant', 'Earlier response.')];
    await emit({ type: 'cleared', botId: bot.id, generation });
    await emit({ type: 'rows', botId: bot.id, generation, rows });
    await page.locator('.bubble.is-agent').waitFor();
    const nextPrompt = row(3, 'user', 'Say hi in five words. '.repeat(scenario.long ? 25 : 1));
    await emit({ type: 'rows', botId: bot.id, generation, rows: [nextPrompt] });
    const established = await geometry();
    for (const kind of ['queued', 'thinking', 'working']) {
      await live({ activity: { kind, detail: kind === 'thinking' ? 'Waiting for model response' : undefined, since: Date.now() } });
      await working();
      sameGeometry(established, await geometry());
    }
    await hasPixelMotion();
    await page.screenshot({ path: new URL(`${label}-existing-working.png`, evidence).pathname });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await idle.waitFor();
    assert.equal(await idle.evaluate(el => el.getAnimations().length), 0);
    const still = await mark.screenshot();
    await page.waitForTimeout(300);
    assert.ok(still.equals(await mark.screenshot()), 'the existing-chat reduced-motion avatar is static');
    sameGeometry(established, await geometry());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await live({ isRunning: false, activity: null, startedAt: null });
    assert.equal(await moving.count(), 0, 'an existing-chat run ending without output stops motion');
    sameGeometry(established, await geometry());
    await live({ activity: { kind: 'thinking', detail: 'Waiting for model response', since: Date.now() } });
    await working();
    const nextReply = row(4, 'assistant', '', true);
    await emit({ type: 'rows', botId: bot.id, generation, rows: [nextReply] });
    await working();
    sameGeometry(established, await geometry());
    nextReply.body.text = 'Hi, glad you are here.'; nextReply.updatedSeq++;
    await emit({ type: 'rows', botId: bot.id, generation, rows: [nextReply] });
    await page.locator('.bubble.is-streaming').waitFor();
    assert.equal(await panel.count(), 0, 'the current reply removes the main loader on its first text');
    assert.equal(await page.locator('.transcript > .transcript__col > .activity-line .flock-mark__moving').count(), 0);
    sameGeometry(established, await geometry());
    // A queued prompt must not restart motion while the preceding answer still streams.
    const queuedPrompt = row(5, 'user', 'Please continue.');
    await emit({ type: 'rows', botId: bot.id, generation, rows: [queuedPrompt] });
    assert.equal(await moving.count(), 0, 'a queued prompt does not animate over an active stream');
    nextReply.body.streaming = false; nextReply.updatedSeq++;
    await emit({ type: 'rows', botId: bot.id, generation, rows: [nextReply] });
    assert.equal(await panel.count(), 0, 'finishing a stream does not restart the loader in the same run');
    await live({ isRunning: false });
    await live();
    await working();
    const queuedGeometry = await geometry();
    const directReply = row(6, 'assistant', 'The next response.');
    await emit({ type: 'rows', botId: bot.id, generation, rows: [directReply] });
    assert.equal(await panel.count(), 0, 'a direct completed reply also removes the main loader');
    sameGeometry(queuedGeometry, await geometry());
    await live({ isRunning: false, startedAt: null });
    assert.equal(await page.locator('.transcript .bot-avatar--working').count(), 0);

    // Two prompts may both arrive before the first run produces any text.
    generation++; rows = []; exchanges = [];
    await emit({ type: 'cleared', botId: bot.id, generation });
    await emit({ type: 'rows', botId: bot.id, generation, rows: [row(1, 'user', 'First queued request.')] });
    await live();
    await emit({ type: 'rows', botId: bot.id, generation, rows: [row(2, 'user', 'Second queued request.')] });
    await working();
    const answerA = row(3, 'assistant', 'First answer.', true);
    await emit({ type: 'rows', botId: bot.id, generation, rows: [answerA] });
    assert.equal(await moving.count(), 0);
    answerA.body.streaming = false; answerA.updatedSeq++;
    await emit({ type: 'rows', botId: bot.id, generation, rows: [answerA] });
    await live({ isRunning: false });
    const firstAnswerHeight = (await page.locator('.group.is-left').boundingBox()).height;
    await live({ activity: { kind: 'thinking', detail: 'Waiting for model response', since: Date.now() } });
    await working();
    assert.equal((await page.locator('.group.is-left').boundingBox()).height, firstAnswerHeight, 'a second queued run does not resize the earlier answer');
    const secondQueuedGeometry = await geometry();
    const answerB = row(4, 'assistant', 'Second answer.', true);
    await emit({ type: 'rows', botId: bot.id, generation, rows: [answerB] });
    assert.equal(await moving.count(), 0, 'the second queued run stops its own loader at its first text');
    sameGeometry(secondQueuedGeometry, await geometry());
    assert.equal((await page.locator('.group.is-left').first().boundingBox()).height, firstAnswerHeight, 'the second answer inherits its own reservation');
    answerB.body.streaming = false; answerB.updatedSeq++;
    await emit({ type: 'rows', botId: bot.id, generation, rows: [answerB] });
    await live({ isRunning: false });
    if (width === 320 && !scenario.long) for (const returnToWide of [false, true]) {
      await page.setViewportSize({ width: 760, height: 900 });
      generation++; rows = []; exchanges = [];
      await emit({ type: 'cleared', botId: bot.id, generation });
      const wrappingTool = { ...row(2, 'assistant', ''), kind: 'tool-call', body: { type: 'tool-call', callId: 'wrapping-tool', name: 'lookup', label: 'Checking source details across connected apps and the research archive before preparing the response', args: {}, status: 'running' } };
      await emit({ type: 'rows', botId: bot.id, generation, rows: [row(1, 'user', 'Review the requirements, milestones, validation steps and dependencies. '.repeat(8)), wrappingTool] });
      await live({ activity: { kind: 'connecting_service', since: Date.now() } });
      await working();
      const wideHeight = (await panel.boundingBox()).height;
      await page.setViewportSize({ width: 320, height: 568 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('.transcript').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await working();
      const narrowHeight = (await panel.boundingBox()).height;
      assert.ok(narrowHeight > wideHeight, 'tool status grows after viewport reflow');
      if (returnToWide) {
        await page.setViewportSize({ width: 760, height: 900 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator('.transcript').evaluate(element => { element.scrollTop = element.scrollHeight; });
        await working();
        assert.ok((await panel.boundingBox()).height >= narrowHeight, 'widening preserves the outgoing slot reservation too');
      }
      const beforeResizeStream = await geometry();
      await emit({ type: 'rows', botId: bot.id, generation, rows: [row(3, 'assistant', 'Ready.', true)] });
      await page.locator('.bubble.is-streaming').waitFor();
      sameGeometry(beforeResizeStream, await geometry());
      assert.ok((await page.locator('.group.is-left').boundingBox()).height >= narrowHeight, 'the response inherits the resized slot');
      await live({ isRunning: false });
    }
    assert.deepEqual(unexpected, [], `${label}: no errors, external requests or unexpected writes`);
    await page.close();
    console.log(`PASS ${label}: new/existing chat, waiting/queued/running, pixels, reduced motion, stop/stream, stable layout, fresh generation, tools and exchanges`);
  }
} finally {
  await browser?.close();
  vite?.kill();
}
