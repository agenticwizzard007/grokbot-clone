import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
const vite = await createServer({ root: `${process.cwd()}/web`, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
await mkdir('.context/r7-bb-ui', { recursive: true });
const user = { id: 'fixture', email: 'account@example.test', role: 'user' };
const bot = { id: 'memory-fixture', name: 'Test Bot', label: 'Test Bot', kind: 'agent', isPrimary: true, avatarColor: 'blue', avatarShape: 'blob', mode: 'personal', generation: 1, instructions: '', effort: 'medium', model: null };
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const errors = [], writes = [];
    let historyChars = 500, compactAtChars = 300000;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { errors.push(`External request: ${url.origin}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET') writes.push(request.method());
      let body = {};
      if (url.pathname.endsWith('/settings')) body = { memories: [], skills: [], routines: [], tasks: [], memory: { historyChars, compactAtChars, lastCompaction: null } };
      else if (url.pathname.endsWith('/routines')) body = { routines: [] };
      else if (url.pathname.endsWith('/proposals')) body = { proposals: [] };
      else if (url.pathname.endsWith('/archive')) body = { memories: [], nextBefore: null };
      return route.fulfill({ json: body });
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {BotSettingsModal} from '/src/components/config/BotSettingsModal.tsx';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/mobile.css';import '/src/styles/config.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
useStore.setState({user:${JSON.stringify(user)},bots:[${JSON.stringify(bot)}],mobile:innerWidth<760});
useConfigUI.getState().openBotSettings('memory-fixture','memories');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(BotSettingsModal));
` }));
    await page.goto(origin);
    const meter = page.locator('.cfg-meter');
    await meter.getByText('0% used', { exact: true }).waitFor();
    assert.match(await meter.innerText(), /Conversation history[\s\S]*Saved memories are separate/);
    assert.doesNotMatch(await meter.innerText(), /full|Conversation memory|NaN|Infinity/);
    await meter.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.context/r7-bb-ui/${width}-${theme}-conversation-usage.png` });
    for (const [chars, limit, label] of [[0, 300000, '0% used'], [30000, 300000, '10% used'], [297000, 300000, '99% used'], [500, 0, 'Usage unavailable']]) {
      historyChars = chars; compactAtChars = limit;
      await page.reload();
      await meter.getByText(label, { exact: true }).waitFor();
      assert.equal(await meter.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    await page.close();
    console.log(`PASS conversation usage ${width} ${theme}`);
  }
} finally { await browser.close(); await vite.close(); }
