// Real Settings, sidebar and Analytics with local fixtures. No login or provider calls.
// node --import tsx tests/usage-readiness-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import { billingNote } from '../server/src/usage-summary.ts';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
process.env.UI_ORIGIN = origin;
const { fixturePage } = await import('./qa-r3-work-fixture.mjs');
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'pipe' });
let browser, logs = '';
vite.stdout.on('data', value => logs += value); vite.stderr.on('data', value => logs += value);
const evidence = '.context/usage-readiness';
const days = Array.from({ length: 7 }, (_, i) => `2026-11-${19 + i}`);
const computer = { status: 'suspended', provider: 'cloudvm', screens: [], orgoId: null, error: null };
try {
  await mkdir(evidence, { recursive: true });
  for (let i = 0; i < 100; i++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors } = await fixturePage(browser, { width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    let mode = 'mixed', timezone = 'Asia/Dubai', limited = false;
    const report = range => {
      const api = ['mixed', 'api', 'unknown'].includes(mode), cli = ['mixed', 'cli'].includes(mode);
      const sources = [
        ...(api ? [{ source: 'api', provider: 'openrouter', requests: 5, costUsd: mode === 'unknown' ? 0 : 42.99, estimatedUsd: 0, unpricedRequests: mode === 'unknown' ? 5 : 0 }] : []),
        ...(cli ? [{ source: 'subscription', provider: 'codex-cli', requests: 560, costUsd: 0, estimatedUsd: 0, unpricedRequests: 0 }] : []),
      ];
      const requests = sources.reduce((sum, row) => sum + row.requests, 0);
      const coverage = { partialUsageRequests: cli ? 1 : 0, unavailableUsageRequests: 0, knownTokenRequests: requests, knownInputRequests: requests, knownOutputRequests: requests - (cli ? 1 : 0) };
      const costUsd = sources.reduce((sum, row) => sum + row.costUsd, 0);
      const vmCost = mode === 'empty' ? 0 : 0.43;
      return {
        timezone, range: { key: range, from: Date.parse(`${days[0]}T00:00:00Z`), to: Date.parse(`${days.at(-1)}T12:00:00Z`) },
        scope: 'me', canSeeAll: false, canSeeProvider: true, provider: 'codex-cli',
        totals: { ...coverage, requests, inputTokens: requests * 100, outputTokens: requests * 20, cachedTokens: 0, reasoningTokens: 0, toolCalls: 0, voiceMinutes: 0, costUsd, estimatedUsd: 0, unpricedRequests: mode === 'unknown' ? 5 : 0, unpricedVoice: 0 },
        billing: { sources, note: billingNote(sources) },
        days: days.map((day, i) => ({ day, ...coverage, tokens: i === 3 ? requests * 120 : 0, requests: i === 3 ? requests : 0, costUsd: i === 3 ? costUsd : 0, computerUsd: i === 3 ? vmCost : 0 })),
        computer: { costUsd: vmCost, runningHours: vmCost ? 5.4 : 0, asleepHours: vmCost ? 140 : 0, archivedHours: 0, now: vmCost ? { provider: 'cloudvm-fly', state: 'asleep', cpus: 2, memoryMb: 2816, diskGb: 10, perHourUsd: 0.0027 } : null },
        computerProvider: 'cloudvm', computerRates: { hoursPerMonth: 730, fly: { cpuMonth: 2.19, ramGbMonth: 6, rootfsGbMonth: 0.15, rootfsGb: 3, volumeGbMonth: 0.15 }, orgo: { runningHour: 0.055, stoppedHour: 0.0027 } },
        byBot: [], byModel: [], byKind: [], limits: { dailyMessages: limited ? { used: 2, limit: 5, resetsAt: Date.now() + (limited === 'expired' ? -3_600_000 : 3_600_000) } : null },
      };
    };
    fixture.respond = ({ path, url }) => {
      if (path === '/api/auth/me') return { json: { user: { id: 'fixture-owner', name: 'Account', email: 'account@example.test', timezone } } };
      if (path === '/api/models') return { json: { provider: 'codex-cli', billing: 'plan', plan: null, usage: { available: false, windows: [], checkedAt: Date.now() }, models: [], favourites: [] } };
      if (path === '/api/usage') return { json: report(url.searchParams.get('range')) };
      if (path === '/api/usage/provider') return { json: { provider: 'codex-cli', openrouter: null, note: 'Your current connection uses your ChatGPT subscription. Check your provider account for remaining limits and any extra usage charges. The report above includes all billing sources used in the selected period.' } };
      if (path === '/api/usage/export.csv') return { contentType: 'text/csv', body: 'day,timezone\n2026-11-22,Asia/Dubai\n' };
      if (path.endsWith('/analytics')) return { json: { range: '7d', timezone, days: days.map(day => ({ day, messages: 5, minutesSaved: 10 })), totals: { messages: 35, minutesSaved: 70 }, breakdown: [], rates: { pageRead: 3, webSearch: 2, command: 1, computerStep: 0.5, wordsPerMinute: 40 } } };
      if (path === '/api/computer') return { json: { computer } };
      if (path === '/api/computer/details') return { json: { computer, screens: [], hibernation: { idleMinutes: 10 }, localComputer: { enabled: false }, pairing: null } };
      if (path === '/api/preferences') return { json: { askBeforeComputer: false } };
      if (path === '/api/apps') return { json: { apps: [], categories: [], total: 0 } };
      return null;
    };
    const open = async section => page.evaluate(async section => {
      const { useConfigUI } = await import('/src/configStore.ts');
      useConfigUI.getState().openAppSettings(section);
    }, section);
    await page.goto(`${origin}/#settings/usage`);
    await page.locator('.usage-report__summary strong').waitFor();
    // Settings can be the first catalog consumer on a cold link.
    await page.evaluate(async () => (await import('/src/lib/models.ts')).useModels.getState().load());
    const footer = page.locator('.sidebar-usage');
    await page.waitForFunction(() => document.querySelector('.sidebar-usage')?.textContent.includes('Limits unavailable'));
    assert.match(await footer.innerText(), /Codex plan/);
    assert.equal(await footer.and(page.getByRole('button', { name: /Limits unavailable/ })).count(), 1);
    const rangeLabel = page.locator('.usage-head__span');
    assert.equal(await rangeLabel.innerText(), 'Nov 19 to Nov 25 · Asia/Dubai');
    assert.ok(await rangeLabel.isVisible());
    assert.equal(await page.locator('.usage-report__summary strong').innerText(), '565 requests');
    assert.equal(await page.locator('.usage-report__summary [role=status]').innerText(), 'Token counts are incomplete for 1 request; totals include only reported tokens.');
    const billing = page.locator('.usage-billing');
    assert.match(await billing.innerText(), /API provider usage · OpenRouter\s+\$42.99/);
    assert.match(await billing.innerText(), /CLI plan usage · ChatGPT\s+560 requests/);
    assert.match(await billing.innerText(), /no Swarm API charge/);
    assert.match(await page.locator('.usage-billing__note').innerText(), /API requests are billed per request/);
    assert.doesNotMatch(await page.locator('.usage-page').innerText(), /zero API charges|Provider usage unavailable|0 requests with|Recorded spend/);
    assert.match(await page.getByLabel('Scope').locator('..').innerText(), /Only admins can view usage for everyone/);
    assert.match(await page.locator('.usage-tile').filter({ hasText: 'Computer on' }).innerText(), /5.4 h\s+140 h asleep/);
    assert.match(await page.locator('.usage-page').innerText(), /time without a Bot screen open/);
    assert.match(await page.locator('.usage-page').innerText(), /No daily message limit in Swarm. Provider limits still apply/);
    await page.getByRole('button', { name: 'Show more', exact: true }).click();
    await page.getByText('Asleep now', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show less', exact: true }).click();

    // Axis labels stay inside the chart, and every bar has space above its peak.
    await page.locator('.usage-chart').scrollIntoViewIfNeeded();
    const geometry = await page.locator('.usage-chart').evaluate(chart => {
      const box = chart.getBoundingClientRect();
      const plot = chart.querySelector('.usage-chart__plot').getBoundingClientRect();
      const labels = [...chart.querySelectorAll('.usage-chart__axis span')].map(el => el.getBoundingClientRect());
      const bars = [...chart.querySelectorAll('.usage-chart__col')].map(el => el.getBoundingClientRect());
      return { box: { top: box.top, bottom: box.bottom }, plot: { top: plot.top, bottom: plot.bottom }, labels: labels.map(b => ({ top: b.top, bottom: b.bottom })), bars: bars.map(b => ({ top: b.top, bottom: b.bottom, height: b.height })) };
    });
    assert.ok(geometry.labels.every(b => b.top >= geometry.box.top && b.bottom <= geometry.box.bottom + 1), JSON.stringify(geometry));
    assert.ok(geometry.bars.filter(b => b.height > 0).every(b => b.top >= geometry.plot.top + 8 && b.bottom <= geometry.plot.bottom + 1), JSON.stringify(geometry));
    await page.locator('.usage-chart__slot').nth(3).focus();
    assert.match(await page.locator(width === 390 ? '.usage-readout' : '.usage-tip').innerText(), /43.42/);
    await page.screenshot({ path: `${evidence}/chart-${width}-${theme}.png` });
    for (const title of ['Breakdown', 'Plan limits', 'Provider account']) {
      const row = page.locator('.access-row').filter({ has: page.getByText(title, { exact: true }) });
      assert.equal(await row.locator(':scope > .settings-row__icon').count(), 1);
    }
    const xs = await page.locator('.access-row .cfg-row__title').evaluateAll(rows => rows.filter(row => ['Breakdown', 'Plan limits', 'Provider account'].includes(row.textContent)).map(row => row.getBoundingClientRect().left));
    assert.ok(Math.max(...xs) - Math.min(...xs) < 1, JSON.stringify(xs));
    const csv = page.getByRole('link', { name: 'Download CSV' });
    await csv.scrollIntoViewIfNeeded();
    for (const state of ['normal', 'hover', 'focus']) {
      if (state === 'hover') await csv.hover();
      if (state === 'focus') { await csv.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); }
      assert.equal(await csv.evaluate(el => getComputedStyle(el).textDecorationLine), 'none', state);
    }
    assert.ok(await csv.evaluate(el => getComputedStyle(el).outlineStyle !== 'none' || getComputedStyle(el).boxShadow !== 'none'), 'CSV retains its focus ring');
    assert.ok(await page.locator('.app-settings__main').evaluate(el => el.scrollWidth <= el.clientWidth), 'no settings overflow');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
    await page.getByRole('radio', { name: 'Table', exact: true }).click();
    await page.getByRole('columnheader', { name: 'Day (Asia/Dubai)' }).waitFor();
    await page.locator('.app-settings__main').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `${evidence}/usage-${width}-${theme}.png` });
    const usageRange = await rangeLabel.innerText();
    await page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().openBotSettings('coordinator', 'analytics'));
    await page.locator('.an-range__span').waitFor();
    assert.equal(await page.locator('.an-range__span').innerText(), usageRange, 'Usage and Analytics share the same range label');
    await open('computer');
    await page.getByText('No Bot screens are open.', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.app-settings__page').innerText(), /No Bot has used the computer/);
    await open('usage');
    await page.locator('.usage-report__summary strong').waitFor();
    for (const [next, range] of [['cli', '30d'], ['api', 'today'], ['empty', 'month'], ['unknown', '7d']]) {
      mode = next; timezone = 'UTC'; limited = next === 'cli';
      await page.getByLabel('Report period').selectOption(range);
      await page.waitForFunction(expected => document.querySelector('.usage-report__summary strong')?.textContent === expected, mode === 'cli' ? '560 requests' : mode === 'empty' ? '0 requests' : '5 requests');
      assert.equal(await rangeLabel.innerText(), 'Nov 19 to Nov 25 · UTC');
      const note = await page.locator('.usage-billing__note').innerText();
      assert.equal(note.includes('CLI requests use'), mode === 'cli');
      assert.equal(note.includes('API requests are billed per request'), ['api', 'unknown'].includes(mode));
      assert.equal(note.includes('no Swarm API charge'), mode === 'cli');
      if (mode === 'cli') {
        await page.getByText('Messages today (UTC)', { exact: true }).waitFor();
        assert.match(await page.locator('.usage-meter').innerText(), /Resets at midnight UTC/);
      }
      if (mode === 'unknown') assert.match(await billing.innerText(), /Price not reported/);
      assert.doesNotMatch(await page.locator('.usage-page').innerText(), /0 requests with/);
    }
    limited = 'expired';
    await page.getByLabel('Report period').selectOption('30d');
    await page.waitForFunction(() => document.querySelector('.usage-page') && !document.querySelector('.usage-page').textContent.includes('No daily message limit in Swarm'));
    assert.equal(await page.locator('.usage-meter').count(), 0, 'an expired allowance never claims the plan is unlimited');
    assert.deepEqual(errors, []);
    await page.context().close();
    console.log(`PASS ${width}px ${theme}: billing sources, copy, sidebar, computer, time-zone parity, chart bounds, CSV focus and overflow`);
  }
} catch (error) { console.error(logs.slice(-3000)); throw error; }
finally { await browser?.close(); vite.kill('SIGTERM'); if (vite.exitCode === null) await new Promise(resolve => vite.once('exit', resolve)); }
