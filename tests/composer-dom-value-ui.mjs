// R8-4: real production composer, local API/voice fixtures, native browser input only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
const evidence = '.context/composer-dom-value';
await mkdir(evidence, { recursive: true });
const root = path.resolve('web'), outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true }, plugins: [{ name: 'local-voice-load', enforce: 'pre', transform(code, id) {
  if (id.endsWith('/voice/call.ts')) return code.replace('export function callLevels(): { out: number; mic: number } {', 'export function callLevels(): { out: number; mic: number } { if (window.__meter) return { out: Math.abs(Math.sin(performance.now()/200)), mic: 0.2 };') + '\nwindow.__voice = useVoice;';
  if (id.endsWith('/lib/inputLatency.ts')) return code + '\nwindow.__resetInputLatency = resetInputLatency;';
} }] });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const text = 'Checking the composer DOM value during a local voice call now'.slice(0, 59);
assert.equal(text.length, 59);
const results = [];
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    fixture.bots[0].onboarding = { status: 'active', revision: 1 };
    await page.goto(`${origin}/#bot/coordinator`);
    const input = page.locator('.composer__input'); await input.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      window.__samples = [];
      document.addEventListener('input', event => {
        const el = event.target;
        if (!el.matches('.composer__input')) return;
        const sample = { data: event.data, value: el.value, at: performance.now(), trusted: event.isTrusted };
        window.__samples.push(sample);
      }, true);
      // React's root listener has finished before input bubbles to window.
      // A microtask queued by the capture listener could run before React.
      window.addEventListener('input', event => {
        const el = event.target;
        if (!el.matches('.composer__input')) return;
        const sample = window.__samples.at(-1);
        sample.afterReact = el.value;
        sample.commitMs = performance.now() - sample.at;
        queueMicrotask(() => { sample.afterMicrotask = el.value; });
      });
    });
    const cdp = await page.context().newCDPSession(page);
    for (const voice of [false, true]) {
      if (voice) await page.evaluate(() => {
        window.__meter = true;
        window.__voice.setState({ status: 'live', botId: 'coordinator', callId: 'local', startedAt: Date.now(), speaking: true });
        let revision = 100;
        window.__load = setInterval(() => {
          window.__voice.setState({ captions: [{ id: 'fixture', role: 'assistant', text: `Local caption ${revision}`, final: false }] });
          window.__emitFixture({ type: 'rows', botId: 'coordinator', generation: 1, rows: [{ botId: 'coordinator', generation: 1, seq: 1, updatedSeq: ++revision, kind: 'message', createdAt: Date.now(), body: { type: 'message', role: 'assistant', text: `Local streamed text ${revision}`, streaming: true } }] });
        }, 100);
      });
      for (const mode of ['insertText', 'keyboard.type', 'per-key-dispatch']) {
        await input.fill(''); await input.focus();
        await page.evaluate(() => { window.__samples = []; });
        const start = performance.now();
        if (mode === 'insertText') await cdp.send('Input.insertText', { text });
        else if (mode === 'keyboard.type') await page.keyboard.type(text, { delay: 5 });
        else for (let i = 0; i < text.length; i++) {
          const key = text[i];
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
          // Read the actual DOM synchronously after the browser acknowledges each key.
          const value = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector(".composer__input").value', returnByValue: true });
          assert.equal(value.result.value, text.slice(0, i + 1));
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
        }
        const completionMs = performance.now() - start;
        assert.equal(await input.inputValue(), text);
        const samples = await page.evaluate(() => window.__samples);
        assert.equal(samples.length, mode === 'insertText' ? 1 : text.length, `${width} ${theme} voice=${voice} ${mode}`);
        samples.forEach((sample, i) => {
          assert.equal(sample.trusted, true);
          assert.equal(sample.value, mode === 'insertText' ? text : text.slice(0, i + 1));
          assert.equal(sample.afterReact, sample.value);
          assert.equal(sample.afterMicrotask, sample.value);
        });
        results.push({ width, theme, voice, mode, completionMs, samples });
      }
    }
    // Model an external injector returning after enqueueing, before Chrome receives keys.
    if (width === 1280 && theme === 'light') {
      await input.fill('');
      await page.waitForTimeout(100);
      await page.evaluate(() => { window.__samples = []; window.__resetInputLatency(); });
      const start = performance.now();
      const producer = (async () => {
        for (const key of text) {
          await new Promise(resolve => setTimeout(resolve, 100));
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
        }
      })();
      const enqueueReturnMs = performance.now() - start;
      const earlyValue = await input.inputValue();
      await producer;
      const deliveredMs = performance.now() - start;
      assert.equal(await input.inputValue(), text);
      await page.waitForTimeout(100);
      results.push({ width, theme, voice: true, mode: 'paced-external-queue', enqueueReturnMs, earlyValue, deliveredMs, meter: await page.evaluate(() => window.__swarmInputLatency()), samples: await page.evaluate(() => window.__samples) });
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${evidence}/${width}-${theme}.png` });
    await page.evaluate(() => clearInterval(window.__load));
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    await page.close();
  }
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ samples, ...r }) => ({ ...r, inputs: samples.length, maxCommitMs: Math.max(...samples.map(s => s.commitMs)) })), null, 2));
  console.log('PASS 24 composer input scenarios and one queued injection demonstration');
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
