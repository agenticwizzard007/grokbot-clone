// Settings usage accounting states with controlled reports, without provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'pipe' });
let browser, logs = '';
vite.stdout.on('data', value => logs += value); vite.stderr.on('data', value => logs += value);
try {
  await mkdir('.context/hosted-mobile', { recursive: true });
  for (let i = 0; i < 100; i++) { if (await fetch(origin).then(response => response.ok, () => false)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let mode = 'unavailable';
    const report = () => {
      const coverage = mode === 'unavailable' ? { partialUsageRequests: 0, unavailableUsageRequests: 2, knownTokenRequests: 0, knownInputRequests: 0, knownOutputRequests: 0 }
        : mode === 'mixed' ? { partialUsageRequests: 1, unavailableUsageRequests: 1, knownTokenRequests: 2, knownInputRequests: 2, knownOutputRequests: 1 }
        : mode === 'partial' ? { partialUsageRequests: 1, unavailableUsageRequests: 0, knownTokenRequests: 1, knownInputRequests: 1, knownOutputRequests: 0 }
        : { partialUsageRequests: 0, unavailableUsageRequests: 0, knownTokenRequests: 1, knownInputRequests: 1, knownOutputRequests: 1 };
      const requests = mode === 'mixed' ? 3 : mode === 'unavailable' ? 2 : 1;
      const inputTokens = mode === 'mixed' ? 107 : mode === 'partial' ? 7 : 0, outputTokens = mode === 'mixed' ? 50 : 0;
      const row = { ...coverage, key: 'codex/default', label: 'Codex', tokens: inputTokens + outputTokens, requests, costUsd: 0, unpriced: 0, minutes: 0, recordings: 0, characters: 0 };
      return { range: { key: '30d', from: 0, to: Date.now() }, scope: 'me', canSeeAll: false, canSeeProvider: false, provider: 'codex-cli',
        accounting: { unavailableUsage: 'counted', tokenTotals: 'observed' },
        totals: { ...coverage, requests, inputTokens, outputTokens, cachedTokens: 0, reasoningTokens: 0, toolCalls: 0, voiceMinutes: 0, costUsd: 0, estimatedUsd: 0, unpricedRequests: 0, unpricedVoice: 0 },
        days: ['2026-11-10', '2026-11-11'].map(day => ({ ...row, day, computerUsd: 0 })),
        byBot: [row], byModel: [row], byKind: [row],
        computer: { costUsd: 0, runningHours: 0, asleepHours: 0, archivedHours: 0, now: null },
        computerProvider: 'local', computerRates: {}, limits: { dailyMessages: null } };
    };
    await page.route('**/api/**', route => route.fulfill({ json: report() }));
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {UsageSection} from '/src/components/config/UsageSection.tsx';
import {useStore} from '/src/store.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/config.css';import '/src/styles/settings.css';
document.documentElement.dataset.theme='light';useStore.setState({mobile:innerWidth<760,user:{id:'alice'}});
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{className:'app-settings__page',style:{maxWidth:'760px',margin:'auto',padding:'24px'}},React.createElement(UsageSection)));
` }));
    await page.goto(origin);
    const tokenTile = page.locator('.usage-tile').filter({ hasText: /^(Known tokens|Tokens)/ }).first();
    await page.getByRole('status').filter({ hasText: 'Token accounting is incomplete' }).waitFor();
    assert.equal(await tokenTile.locator('.usage-tile__value').innerText(), 'Unavailable');
    assert.match(await tokenTile.innerText(), /Unavailable in · Unavailable out/);
    assert.match(await page.getByRole('status').filter({ hasText: 'Token accounting is incomplete' }).innerText(), /2 requests with unavailable usage/);
    assert.equal(await page.locator('.usage-ranked__figure').first().innerText(), 'Unavailable');
    assert.match(await page.getByRole('img').first().getAttribute('aria-label'), /Token usage unavailable/);
    await page.locator('.usage-table summary').click();
    assert.equal(await page.getByRole('cell', { name: 'Unavailable', exact: true }).count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `.context/hosted-mobile/usage-unavailable-${width}.png`, fullPage: true });

    mode = 'mixed'; await page.getByRole('radio', { name: '7 days', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.usage-tile__value')?.textContent === '157 known');
    assert.match(await tokenTile.innerText(), /107 in · 50 out/);
    assert.match(await page.getByRole('status').filter({ hasText: 'Token accounting is incomplete' }).innerText(), /1 request with partial usage and 1 request with unavailable usage/);
    await page.screenshot({ path: `.context/hosted-mobile/usage-mixed-${width}.png`, fullPage: true });

    mode = 'partial'; await page.getByRole('radio', { name: 'Today', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.usage-tile__value')?.textContent === '7 known');
    assert.match(await tokenTile.innerText(), /7 in · Unavailable out/);
    mode = 'zero'; await page.getByRole('radio', { name: '7 days', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.usage-tile__value')?.textContent === '0');
    assert.match(await tokenTile.innerText(), /0 in · 0 out/);
    assert.equal(await page.getByRole('status').filter({ hasText: 'Token accounting is incomplete' }).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${width}px: counted unavailable usage, masked totals/table/chart, partial input only, measured zero, no overflow`);
  }
} catch (error) { console.error(logs.slice(-2000)); throw error; }
finally { await browser?.close(); vite.kill('SIGTERM'); if (vite.exitCode === null) await new Promise(resolve => vite.once('exit', resolve)); }
