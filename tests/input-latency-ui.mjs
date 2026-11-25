// Production build, synthetic account and SSE only. Also runs unchanged d8602e9 via UI_WEB_ROOT.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
const root = path.resolve(process.env.UI_WEB_ROOT || 'web');
const evidence = process.env.UI_EVIDENCE || '.context/input-latency';
await mkdir(evidence, { recursive: true });
const outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true } });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [], failures = [];
const check = (ok, text) => { if (!ok) failures.push(text); };
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors } = await fixturePage(browser, { width, height: 900 });
    page.setDefaultTimeout(30000);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    const bot = fixture.bots[0]; bot.onboarding = { status: 'active', revision: 1 };
    const rows = Array.from({ length: 320 }, (_, i) => ({ botId: bot.id, generation: 1, seq: i + 1, updatedSeq: i + 1, kind: 'message', createdAt: Date.now() - 400000 + i * 1000,
      body: { type: 'message', role: i % 2 ? 'assistant' : 'user', text: i % 2 ? `## Local report ${i}\n\n${'- **Finding:** a synthetic [reference](https://example.test).\n'.repeat(30)}\n| Source | Result |\n| --- | --- |\n| Local | Ready |` : 'Review the local report.' } }));
    fixture.respond = ({ path }) => {
      if (path.endsWith('/rows')) return { json: { generation: 1, rows, olderCursor: null } };
      if (path.endsWith('/suggested-apps')) return { json: { filterVersion: 'purpose-2', suggestions: [] } };
      return null;
    };
    await page.goto(`${origin}/#bot/${bot.id}`);
    const input = page.locator('.composer__input'); await input.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-row-seq]').length === 320);
    await page.waitForLoadState('networkidle'); await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => {
      for (const row of document.querySelectorAll('.bubble-wrap.is-left')) {
        row.scrollIntoView({ block: 'start' }); await new Promise(requestAnimationFrame);
      }
      const el = document.querySelector('.transcript'); el.scrollTop = el.scrollHeight;
    });
    await page.evaluate(bot => {
      let revision = 1000;
      window.__load = setInterval(() => {
        window.__emitFixture({ type: 'live', state: { botId: bot.id, revision: ++revision, isRunning: true, startedAt: Date.now() - 1000, activity: { kind: 'thinking', since: Date.now() - 1000 } } });
        window.__emitFixture({ type: 'rows', botId: bot.id, generation: 1, rows: [{ botId: bot.id, generation: 1, seq: 321, updatedSeq: revision, kind: 'message', createdAt: Date.now(), body: { type: 'message', role: 'assistant', streaming: true, text: `## Update\n\n${'Live fixture words. '.repeat(revision % 100 + 1)}` } }] });
        window.__emitFixture({ type: 'bot', bot: { ...bot, lastPreview: `Update ${revision}`, lastActivityAt: Date.now() } });
        window.__emitFixture({ type: 'computer', state: { status: 'running', screens: [] } });
      }, 100);
      window.__native = setInterval(() => window.__emitFixture({ type: 'native' }), 1000);
      window.__long = [];
      window.__longObserver = new PerformanceObserver(list => window.__long.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration }))));
      window.__longObserver.observe({ type: 'longtask' });
      window.__event = [];
      if (PerformanceObserver.supportedEntryTypes.includes('event')) new PerformanceObserver(list => window.__event.push(...list.getEntries().filter(e => e.name === 'keydown').map(e => ({ start: e.startTime, duration: e.duration, interactionId: e.interactionId })))).observe({ type: 'event', durationThreshold: 16 });
      window.__keys = [];
      const input = document.querySelector('.composer__input'); let start = 0, handler = 0;
      input.addEventListener('keydown', e => { start = e.timeStamp; handler = performance.now(); }, true);
      let pending = [], scheduled = false;
      const schedule = () => {
        if (scheduled || !pending.length) return;
        scheduled = true;
        requestAnimationFrame(() => {
          const batch = pending; pending = [];
          setTimeout(() => {
            const end = performance.now(), length = input.value.length;
            for (const sample of batch) { sample.paintMs = end - sample.start; sample.paintLength = length; window.__keys.push(sample); }
            scheduled = false; schedule();
          }, 0);
        });
      };
      input.addEventListener('input', () => {
        const sample = { start, inputDelayMs: handler - start, expectedLength: input.value.length };
        queueMicrotask(() => { sample.scriptMs = performance.now() - handler; sample.commitLength = input.value.length; });
        pending.push(sample); schedule();
      });
    }, bot);
    const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
    for (const delay of [0, 20]) {
      await input.fill(''); await input.focus(); await page.waitForTimeout(150);
      const meterBefore = await page.evaluate(() => { window.__keys = []; window.__long = []; window.__event = []; return window.__swarmInputLatency?.() ?? null; });
      const metricsBefore = (await cdp.send('Performance.getMetrics')).metrics;
      const text = 'Please review the local report and share the next steps now';
      assert.equal(text.length, 59);
      const started = Date.now(); await page.keyboard.type(text, { delay }); const typingMs = Date.now() - started;
      assert.equal(await input.inputValue(), text, 'DOM contains all 59 characters immediately after typing');
      await page.waitForFunction(() => window.__keys.length === 59);
      const metricsAfter = (await cdp.send('Performance.getMetrics')).metrics;
      await page.waitForTimeout(100);
      const data = await page.evaluate(() => ({ keys: window.__keys, longTasks: window.__long, eventTiming: window.__event, meter: window.__swarmInputLatency?.() ?? null }));
      const percentile = (name, p) => data.keys.map(s => s[name]).sort((a, b) => a - b)[Math.ceil(59 * p) - 1];
      const eventPaint = data.keys.map(sample => data.eventTiming.find(event => Math.abs(event.start - sample.start) < 1)?.duration ?? 16).sort((a, b) => a - b);
      const result = { eventPaintP50Ms: eventPaint[29], eventPaintP95Ms: eventPaint[56], eventPaintMaxMs: eventPaint[58], width, theme, delay, messages: 320, pendingCards: 0, typingMs,
        paintP50Ms: percentile('paintMs', .5), paintP95Ms: percentile('paintMs', .95), paintMaxMs: percentile('paintMs', 1), scriptP95Ms: percentile('scriptMs', .95), inputDelayP95Ms: percentile('inputDelayMs', .95),
        longTasks: data.longTasks, eventTiming: data.eventTiming, meter: data.meter,
        browserWork: Object.fromEntries(metricsAfter.filter(m => /Duration|LayoutCount|RecalcStyleCount/.test(m.name)).map(m => [m.name, m.value - metricsBefore.find(b => b.name === m.name).value])) };
      results.push(result); console.log(JSON.stringify({ ...result, eventTiming: undefined, browserWork: undefined }));
      check(data.keys.every((s, i) => s.commitLength === i + 1 && s.paintLength >= s.expectedLength), `${width} ${theme} delay ${delay}: no queued DOM input`);
      check(result.eventPaintP95Ms < 50 && result.eventPaintMaxMs < 150 && result.scriptP95Ms < 16, `${width} ${theme} delay ${delay}: input latency budget`);
      check(data.longTasks.length === 0, `${width} ${theme} delay ${delay}: no main-thread long task during typing`);
      if (!process.env.UI_BASELINE) {
        check(data.meter.count - meterBefore.count === 59, 'session meter counts each input once');
        check(data.meter.sampleCount <= 256, 'session meter stays bounded');
        check(data.meter.method === 'event-timing' && data.meter.p95Ms < 50, 'meter uses actual browser presentation timing');
      }
    }
    await page.evaluate(() => { clearInterval(window.__load); clearInterval(window.__native); window.__longObserver.disconnect(); });
    if (!process.env.UI_BASELINE) {
      const before = await page.evaluate(() => window.__swarmInputLatency());
      await page.waitForTimeout(300);
      assert.deepEqual(await page.evaluate(() => window.__swarmInputLatency()), before, 'idle does not collect samples');
      // Composition Enter must keep the draft and must not submit a message.
      await input.dispatchEvent('compositionstart');
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
      await input.dispatchEvent('compositionend');
      assert.equal(await input.inputValue(), 'Please review the local report and share the next steps now');
      await page.evaluate(() => { location.hash = '#settings/general'; });
      await page.getByText('Typing diagnostics', { exact: true }).click();
      await page.getByText(/Typing responsiveness: p95/).waitFor();
      assert.ok((await page.locator('details').filter({ hasText: 'Typing diagnostics' }).innerText()).includes(`over ${before.count} inputs`));
      await page.screenshot({ path: `${evidence}/${width}-${theme}-diagnostics.png` });
    }
    assert.deepEqual(errors, []); await page.close();
  }
  await writeFile(`${evidence}/results.json`, JSON.stringify({ results, failures }, null, 2));
  assert.deepEqual(failures, []); console.log(`PASS input latency: 8 runs, 472 keys, 320 messages with live events${process.env.UI_BASELINE ? '.' : '; diagnostics and IME.'}`);
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
