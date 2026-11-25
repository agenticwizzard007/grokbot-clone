// Production full app with local SSE, polling and voice fixtures. No live account or provider access.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';

const root = path.resolve(process.env.UI_WEB_ROOT || 'web');
const evidence = process.env.UI_EVIDENCE || '.context/composer-live-performance';
await mkdir(evidence, { recursive: true });
const outDir = path.resolve(evidence, 'dist');
// Instrument real component bodies only in this test build, including memoized bodies.
const markers = [
  ['Transcript.tsx', 'Transcript', '  const scrollRef = useRef<HTMLDivElement>(null);'],
  ['Transcript.tsx', 'Bubble', '  const b = row.body as MessageBody;'],
  ['Transcript.tsx', 'SystemRow', '  const [retrying, setRetrying] = useState(false);'],
  ['Composer.tsx', 'Composer', '  const draftKey = `${accountId}:${bot.id}`;'],
  ['ActivityLine.tsx', 'ActivityLine', 'export function ActivityLine({ bot, live, rows }: { bot: Bot; live: LiveState; rows: Row[] }) {'],
  ['MarkdownRenderer.tsx', 'Markdown', 'export const Markdown = React.memo(function Markdown({ text }: { text: string }) {'],
];
await build({ root, build: { outDir, emptyOutDir: true }, plugins: [{
  name: 'local-live-profile', enforce: 'pre',
  transform(source, id) {
    let code = source;
    for (const [file, name, marker] of markers) if (id.endsWith(`/components/${file}`)) {
      assert.ok(code.includes(marker), `instrument ${name}`);
      code = code.replace(marker, `${marker}\nwindow.__renders ??= {}; window.__renders.${name} = (window.__renders.${name} || 0) + 1;`);
    }
    if (id.endsWith('/src/store.ts')) code += '\nwindow.__store = useStore;';
    if (id.endsWith('/lib/models.ts')) code += '\nwindow.__models = useModels;';
    if (id.endsWith('/voice/call.ts')) {
      code += '\nwindow.__voice = useVoice;';
      code = code.replace('export function callLevels(): { out: number; mic: number } {', `export function callLevels(): { out: number; mic: number } {
        if (window.__meter) { window.__meterFrames = (window.__meterFrames || 0) + 1; return { out: Math.abs(Math.sin(performance.now() / 200)), mic: 0.2 }; }`);
    }
    return code === source ? undefined : code;
  },
}] });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [], failures = [];
const check = (condition, label) => { if (!condition) failures.push(label); };
const counts = page => page.evaluate(() => ({ ...window.__renders, at: performance.now() }));
const diff = (a, b) => Object.fromEntries(Object.keys(b).filter(k => k !== 'at').map(k => [k, (b[k] || 0) - (a[k] || 0)]));
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 }, { timezoneId: 'America/Los_Angeles' });
    page.setDefaultTimeout(30000);
    // Exercise real animations and a non-UTC local waiting timestamp.
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    const bot = fixture.bots[0];
    fixture.bots[1].id = 'bot_RESEARCH123456';
    bot.onboarding = { status: 'active', revision: 1 };
    const since = Date.now() - 14000;
    const rows = Array.from({ length: 300 }, (_, i) => ({ botId: bot.id, generation: 1, seq: i + 1, updatedSeq: i + 1,
      kind: 'message', createdAt: since - 400000 + i * 1000,
      body: { type: 'message', role: i % 2 ? 'assistant' : 'user', text: i % 2
        ? `## Report ${i}\n\n${'- **Finding:** synthetic markdown with a [reference](https://example.test).\n'.repeat(30)}\n| Source | Result |\n| --- | --- |\n| Local | Ready |\n\n\`\`\`js\nconst ready = true;\n\`\`\`` : `Review local report ${i}.` },
    }));
    rows[1].body.text += '\nAsk bot_RESEARCH123456 to review it.';
    for (let i = 0; i < 4; i++) rows.push({ botId: bot.id, generation: 1, seq: 301 + i, updatedSeq: 301 + i, kind: 'card', createdAt: since - 3000 + i * 1000,
      body: { type: 'card', card: 'approval', approvalId: `local-approval-${i}`, tool: 'send_email', toolkit: 'gmail', toolkitName: 'Gmail', title: `Send report ${i + 1}`, status: i === 3 ? 'pending' : 'allowed',
        args: { to: 'review@example.test', subject: `Report ${i + 1}`, body: 'Please review this local report before sending it.\nThe next step needs your approval.' } } });
    const live = { botId: bot.id, isRunning: false, activity: { kind: 'waiting_for_you', since }, awaiting: { reason: 'Review the email before sending.', since }, startedAt: since - 2000, revision: 1 };
    fixture.respond = ({ path }) => {
      if (path === '/api/bots') return { json: { bots: fixture.bots, live: [live] } };
      if (path.endsWith('/rows')) return { json: { generation: 1, rows, olderCursor: null } };
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
      if (path === '/api/models') return { json: { provider: 'codex-cli', billing: 'plan', models: [], favourites: [], canFast: false } };
      return null;
    };
    await page.goto(`${origin}/#bot/${bot.id}`);
    const input = page.locator('.composer__input');
    await input.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-row-seq]').length >= 304);
    await page.getByText('Codex · ChatGPT plan', { exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    // Visit history so lazy markdown has parsed, as it would after reading a long chat.
    await page.evaluate(async () => {
      for (const row of document.querySelectorAll('.bubble-wrap.is-left')) {
        row.scrollIntoView({ block: 'start' });
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const el = document.querySelector('.transcript'); el.scrollTop = el.scrollHeight;
    });
    await frame(page);
    const result = { width, theme, messages: 300, approvals: 4 };
    const waiting = page.locator('.activity-line.is-waiting');
    await waiting.waitFor();
    const waitingBefore = await waiting.textContent(), idleBefore = await counts(page);
    await page.waitForTimeout(2200);
    const idleAfter = await counts(page);
    result.waitingRenders = diff(idleBefore, idleAfter);
    const staticLabel = await waiting.locator('time').evaluateAll(elements => elements.map(el => ({ text: el.textContent, title: el.title, dateTime: el.dateTime })));
    const expectedTime = await page.evaluate(since => ({ text: `Waiting since ${new Date(since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, title: new Date(since).toLocaleString([], { dateStyle: 'full', timeStyle: 'long' }), dateTime: new Date(since).toISOString() }), since);
    check(JSON.stringify(staticLabel) === JSON.stringify([expectedTime]), `${width} ${theme}: R6-5 local static waiting time and full-date tooltip`);
    check(await waiting.textContent() === waitingBefore && result.waitingRenders.ActivityLine === 0 && result.waitingRenders.Transcript === 0, `${width} ${theme}: R6-5 waiting does not tick or render the transcript`);

    // Place the pending card at several scroll offsets. Any intersection with the
    // scroll viewport can obscure text or controls, even if clipping masks a DOM rect.
    await page.screenshot({ path: `${evidence}/${width}-${theme}-static.png` });
    const overlaps = [];
    for (const offset of [300, 160, 80]) {
      await page.locator('.transcript').evaluate((el, offset) => { el.scrollTop = el.scrollHeight - el.clientHeight - offset; }, offset);
      const pill = page.getByRole('button', { name: 'Jump to latest', exact: true });
      await pill.waitFor(); await frame(page);
      overlaps.push(await page.evaluate(() => {
        const pill = document.querySelector('.jump-btn').getBoundingClientRect(), pane = document.querySelector('.transcript').getBoundingClientRect();
        const intersects = r => r.left < pill.right && r.right > pill.left && r.top < pill.bottom && r.bottom > pill.top;
        return { viewport: intersects(pane), controls: [...document.querySelectorAll('.card button, .card__title, .card__body, .card p')].filter(el => { const r = el.getBoundingClientRect(); return intersects({ left: Math.max(r.left, pane.left), right: Math.min(r.right, pane.right), top: Math.max(r.top, pane.top), bottom: Math.min(r.bottom, pane.bottom) }); }).length };
      }));
    }
    result.pillOverlap = overlaps;
    check(overlaps.every(item => !item.viewport && item.controls === 0), `${width} ${theme}: R6-4 jump pill has space outside all message text and controls`);
    await page.screenshot({ path: `${evidence}/${width}-${theme}-waiting.png` });
    await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
    await page.waitForFunction(() => { const el = document.querySelector('.transcript'); return el.scrollHeight - el.scrollTop - el.clientHeight < 2; });

    await page.evaluate(({ bot, live, since }) => {
      window.__meter = true;
      window.__voice.setState({ status: 'live', botId: bot.id, callId: 'local-call', startedAt: since, speaking: true });
      let revision = 1000;
      window.__loadTimers = [];
      window.__startLoad = (streaming = false) => {
        window.__loadTimers.push(setInterval(() => {
          window.__emitFixture({ type: 'live', state: { ...live, revision: ++revision } });
          if (streaming) window.__emitFixture({ type: 'rows', botId: bot.id, generation: 1, rows: [{ botId: bot.id, generation: 1, seq: 305, updatedSeq: revision, kind: 'message', createdAt: since + 1000,
            body: { type: 'message', role: 'assistant', streaming: true, text: `## Voice follow-up\n\n${'New streamed words. '.repeat(revision % 100 + 1)}` } }] });
        }, 250));
        window.__loadTimers.push(setInterval(() => {
          window.__emitFixture({ type: 'bot', bot: { ...bot, lastPreview: `Live update ${revision}`, lastActivityAt: Date.now() } });
          window.__emitFixture({ type: 'computer', state: { status: 'running', screens: [], orgoId: null, error: null } });
          window.__voice.setState({ captions: [{ id: 'local-caption', role: 'assistant', text: `Voice caption ${revision}`, final: false }], speaking: revision % 2 === 0 });
        }, 500));
        window.__loadTimers.push(setInterval(() => {
          window.__emitFixture({ type: 'native' });
          window.__models.setState({ usage: { available: true, checkedAt: Date.now(), windows: [{ label: 'Session', usedPercent: revision % 100, resetsAt: null }] } });
        }, 1000));
      };
      window.__stopLoad = () => { window.__loadTimers.forEach(clearInterval); window.__loadTimers = []; };
      window.__startLoad();
    }, { bot, live, since });
    await page.locator('.vcall.is-live').waitFor();
    await page.waitForTimeout(1200);
    const passiveBefore = await counts(page);
    await page.waitForTimeout(3000);
    const passiveAfter = await counts(page);
    result.passive = { renders: diff(passiveBefore, passiveAfter), seconds: (passiveAfter.at - passiveBefore.at) / 1000 };
    result.passive.rendersPerSecond = Object.fromEntries(Object.entries(result.passive.renders).map(([name, n]) => [name, n / result.passive.seconds]));
    check(result.passive.renders.Bubble === 0, `${width} ${theme}: R6-2 presence and usage must not render historical messages`);
    check(result.passive.renders.Composer === 0, `${width} ${theme}: R6-2 presence, live status, captions and usage must not render composer`);
    await page.evaluate(() => { window.__stopLoad(); window.__startLoad(true); });
    await page.locator('[data-row-seq="305"]').waitFor();
    await input.focus(); await frame(page);
    await page.evaluate(() => {
      window.__typing = [];
      if (!PerformanceObserver.supportedEntryTypes.includes('event')) throw new Error('Event Timing support is required');
      window.__eventPaint = [];
      window.__eventObserver = new PerformanceObserver(list => window.__eventPaint.push(...list.getEntries().map(entry => entry.toJSON())));
      window.__eventObserver.observe({ type: 'event', durationThreshold: 16 });
      window.__longFrames = [];
      new PerformanceObserver(list => window.__longFrames.push(...list.getEntries().map(entry => entry.toJSON()))).observe({ type: 'long-animation-frame' });
      const input = document.querySelector('.composer__input');
      let start, handlerStart;
      input.addEventListener('keydown', event => { start = event.timeStamp; handlerStart = performance.now(); }, true);
      window.addEventListener('input', event => {
        if (event.target !== input || !start) return;
        const sample = { expected: input.value, startedAt: start, inputDelayMs: handlerStart - start };
        queueMicrotask(() => {
          sample.scriptMs = performance.now() - handlerStart;
          sample.keydownToCommitMs = performance.now() - start;
          sample.value = input.value;
          const started = start;
          requestAnimationFrame(() => {
            sample.frameMs = performance.now() - started;
            sample.paintedValue = input.value;
            window.__typing.push(sample);
          });
        });
      });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    if (process.env.UI_TRACE) await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReturnAsStream' });
    const metricsBefore = (await cdp.send('Performance.getMetrics')).metrics;
    const typingBefore = await counts(page);
    const text = 'A local typing performance check keeps the composer responsive while a long conversation stays ready. '.slice(0, 100);
    await input.pressSequentially(text, { delay: 35, timeout: 60000 });
    await frame(page);
    await page.waitForFunction(() => window.__typing.length === 100);
    const typingAfter = await counts(page);
    const metricsAfter = (await cdp.send('Performance.getMetrics')).metrics;
    if (process.env.UI_TRACE) {
      const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      const { stream } = await done;
      let trace = '';
      for (;;) { const part = await cdp.send('IO.read', { handle: stream }); trace += part.data; if (part.eof) break; }
      await cdp.send('IO.close', { handle: stream });
      await writeFile(`${evidence}/${width}-${theme}-trace.json`, trace);
    }
    result.browserWork = Object.fromEntries(metricsAfter.filter(m => /Duration|LayoutCount|RecalcStyleCount/.test(m.name)).map(m => [m.name, m.value - metricsBefore.find(b => b.name === m.name).value]));
    await page.waitForTimeout(100);
    const samples = await page.evaluate(() => {
      const entries = [...window.__eventPaint, ...window.__eventObserver.takeRecords().map(entry => entry.toJSON())].filter(entry => entry.name === 'keydown');
      window.__eventObserver.disconnect();
      // Event Timing reports presentation latency in 8ms buckets. Events below
      // its minimum 16ms reporting threshold are conservatively counted as 16ms.
      return window.__typing.map(sample => ({ ...sample, eventPaintMs: entries.find(entry => Math.abs(entry.startTime - sample.startedAt) < 1)?.duration ?? 16 }));
    });
    await writeFile(`${evidence}/${width}-${theme}-keys.json`, JSON.stringify(samples, null, 2));
    await writeFile(`${evidence}/${width}-${theme}-frames.json`, JSON.stringify(await page.evaluate(() => window.__longFrames), null, 2));
    const percentile = key => samples.map(s => s[key]).sort((a, b) => a - b)[94];
    result.typing = { eventPaintP95Ms: percentile('eventPaintMs'), maxEventPaintMs: Math.max(...samples.map(s => s.eventPaintMs)), inputDelayP95Ms: percentile('inputDelayMs'), scriptP95Ms: percentile('scriptMs'), keydownToCommitP95Ms: percentile('keydownToCommitMs'), nextFrameP95Ms: percentile('frameMs'), renders: diff(typingBefore, typingAfter), seconds: (typingAfter.at - typingBefore.at) / 1000 };
    result.typing.rendersPerSecond = Object.fromEntries(Object.entries(result.typing.renders).map(([name, n]) => [name, n / result.typing.seconds]));
    check(samples.every((s, i) => s.value === text.slice(0, i + 1) && s.value === s.expected && s.paintedValue.startsWith(s.expected)), `${width} ${theme}: R6-2 each key is current by the next frame`);
    check(result.typing.scriptP95Ms < 16, `${width} ${theme}: R6-2 input script p95 under 16 ms (${result.typing.scriptP95Ms})`);
    check(result.typing.eventPaintP95Ms < 50 && result.typing.nextFrameP95Ms < 34 && result.typing.maxEventPaintMs < 150, `${width} ${theme}: R6-2 no queued multi-frame typing stalls (${result.typing.eventPaintP95Ms})`);
    check(result.typing.renders.Bubble < 100, `${width} ${theme}: R6-2 streaming renders only the changing reply`);
    assert.equal(await input.inputValue(), text);
    await page.evaluate(() => window.__stopLoad()); await page.waitForTimeout(500); await frame(page);
    await input.fill(''); await frame(page);
    const keyBefore = await counts(page);
    await input.pressSequentially('Typing with only the voice meter active.', { delay: 35 }); await frame(page);
    result.keysOnly = diff(keyBefore, await counts(page));
    check(result.keysOnly.Transcript === 0, `${width} ${theme}: R6-2 keystrokes and voice meter never render transcript`);
    check(await page.evaluate(() => window.__meterFrames > 60), `${width} ${theme}: voice levels sampled at animation-frame rate`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${theme}: no horizontal overflow`);
    // Narrow subscriptions still refresh relevant identity changes and preserve drafts.
    await page.evaluate(() => {
      for (const bot of window.__store.getState().bots) window.__emitFixture({ type: 'bot', bot: { ...bot, name: bot.id === 'coordinator' ? 'Updated coordinator' : 'Updated research Bot' } });
    });
    await page.getByRole('textbox', { name: 'Message Updated coordinator', exact: true }).waitFor();
    assert.ok((await page.locator('[data-row-seq="2"]').textContent()).includes('Updated research Bot'));
    assert.equal(await input.inputValue(), 'Typing with only the voice meter active.');
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    results.push(result);
    await writeFile(`${evidence}/results.json`, JSON.stringify({ results, failures }, null, 2));
    console.log(JSON.stringify(result));
    await page.screenshot({ path: `${evidence}/${width}-${theme}-live.png` });
    await page.context().close();
  }
  assert.deepEqual(failures, [], 'R6 live composer, jump spacing and static waiting regression checks');
  console.log('PASS R6-2 live composer performance, R6-4 jump pill clearance, R6-5 static waiting at 1280/390 in light/dark');
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
