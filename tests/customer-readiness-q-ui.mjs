// Local full-app fixtures only. UI_WEB_ROOT can point at an untouched baseline checkout.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
process.env.UI_ORIGIN = origin;
const { fixturePage } = await import('./qa-r3-work-fixture.mjs');
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.env.UI_WEB_ROOT || new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '', browser;
vite.stdout.on('data', chunk => logs += chunk); vite.stderr.on('data', chunk => logs += chunk);
after(async () => { await browser?.close(); vite.kill(); });
for (let i = 0; i < 200; i++) {
  if (await fetch(origin).then(r => r.ok, () => false)) break;
  if (i === 199) throw new Error(logs);
  await new Promise(resolve => setTimeout(resolve, 100));
}
browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const evidence = process.env.UI_EVIDENCE || '.context/readiness-q';
await mkdir(evidence, { recursive: true });
const providerNote = 'Your current connection uses your ChatGPT subscription. Check your provider account for remaining limits and any extra usage charges.';
const days = Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${19 + i}`, tokens: i === 3 ? 600 : 0, requests: i === 3 ? 3 : 0, costUsd: i === 3 ? 2 : i === 1 ? 0.00001 : 0, computerUsd: i === 3 ? 0.5 : i === 1 ? 0.00001 : 0 }));
const usage = {
  timezone: 'UTC', range: { key: '7d', from: Date.parse('2026-11-19T00:00:00Z'), to: Date.parse('2026-11-25T12:00:00Z') },
  scope: 'me', canSeeAll: false, canSeeProvider: true, provider: 'codex-cli',
  totals: { requests: 3, inputTokens: 500, outputTokens: 100, cachedTokens: 0, reasoningTokens: 0, toolCalls: 0, voiceMinutes: 0, costUsd: 2, estimatedUsd: 0, unpricedRequests: 0, unpricedVoice: 0 },
  billing: { sources: [], note: 'Recorded usage for this account.' }, days,
  computer: { costUsd: 0.5, runningHours: 5, asleepHours: 100, archivedHours: 0, now: null },
  computerProvider: 'cloudvm', byBot: [], byModel: [], byKind: [], limits: { dailyMessages: null },
};
for (const width of [1280, 1024, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`customer readiness Q at ${width} ${theme}`, async t => {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    fixture.respond = ({ path }) => {
      if (path === '/api/models') return { json: { provider: 'codex-cli', billing: 'plan', plan: null, usage: { available: false, windows: [], checkedAt: Date.now() }, models: [{ id: 'codex/default', name: 'Codex CLI default', short: 'Codex CLI default', author: 'openai', efforts: [], defaultEffort: null, billing: 'plan', vision: true }], defaultModel: 'codex/default', favourites: ['codex/default'], canFast: false } };
      if (path === '/api/models/icon/openai') return { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' };
      if (path === '/api/usage') return { json: usage };
      if (path === '/api/usage/provider') return { json: { provider: 'codex-cli', openrouter: null, note: providerNote } };
      if (path === '/api/providers/openrouter') return { json: { connected: false, linked: false, selected: false, active: false, hint: null, settingsUrl: 'https://openrouter.ai/settings/keys' } };
      if (path === '/api/settings/keys') { const key = { set: false, source: null }; return { json: { canEdit: false, isolated: false, provider: { value: 'direct', chosen: 'direct' }, model: { value: 'fixture' }, openrouterModel: { value: 'fixture' }, openrouter: key, direct: key, composio: key, voice: key } }; }
      if (path === '/api/messaging') return { json: { enabled: true, links: [], line: { number: '+15550101234', channels: ['sms'] }, preferences: { voiceReplies: 'off' }, speech: {}, invites: { allowance: 0 }, phoneAuth: { available: true } } };
      if (path === '/api/cli') return { json: { runtime: 'server', selected: 'codex', connected: true, providers: { codex: { installed: true, authenticated: true, subscription: true }, claude: {} } } };
      return null;
    };
    const open = section => page.evaluate(async section => (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings(section), section);
    const shot = name => page.screenshot({ path: `${evidence}/${width}-${theme}-${name}.png` });
    const fits = async () => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
      for (const container of await page.locator('.app-settings__main, .app-settings__page, .composer').all()) {
        assert.ok(await container.evaluate(el => el.scrollWidth <= el.clientWidth), 'no container overflow');
      }
    };
    try {
      await page.goto(`${origin}/#bot/coordinator`);
      await page.locator('.model-pill').filter({ hasText: 'Codex' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await t.test('R2-1 composer label fits and names the plan once', async () => {
        const chip = page.locator('.model-pill');
        await shot('composer');
        assert.equal(await chip.locator('.model-pill__name').innerText(), 'Codex · ChatGPT plan');
        assert.equal((await chip.innerText()).match(/plan/gi)?.length, 1);
        assert.ok(await chip.locator('.model-pill__name').evaluate(el => el.scrollWidth <= el.clientWidth), 'label is not truncated');
        assert.match(await chip.getAttribute('title'), /Codex CLI default.*ChatGPT plan/);
        assert.match(await chip.getAttribute('aria-label'), /Codex CLI default.*ChatGPT plan/);
        await fits();
        await chip.click();
        assert.ok(await page.getByRole('dialog', { name: 'Model' }).isVisible());
        assert.match(await page.locator('.model-menu').innerText(), /Codex CLI default/);
        assert.match(await page.locator('.model-menu').innerText(), /Subscription/);
        await page.keyboard.press('Escape');
      });
      if (![1280, 390].includes(width)) return;
      await t.test('U24 API key rows and field hints share icon and text columns', async () => {
        await open('keys');
        const section = page.locator('.openrouter-settings');
        await section.getByText('Personal key', { exact: true }).waitFor();
        await section.scrollIntoViewIfNeeded();
        await shot('keys');
        const xs = await section.locator('.cfg-row__title, .cfg-row__sub, label[for="personal-openrouter-key"], #personal-openrouter-key, .openrouter-settings__key .cfg-field__hint').evaluateAll(els => els.map(el => el.getBoundingClientRect().left));
        assert.ok(Math.max(...xs) - Math.min(...xs) <= 1, `text indents: ${xs}`);
        const icons = await section.locator('.settings-row__icon').evaluateAll(els => els.map(el => el.getBoundingClientRect().left));
        assert.ok(Math.max(...icons) - Math.min(...icons) <= 1, `icon indents: ${icons}`);
        await fits();
      });
      await open('usage');
      await page.getByText(providerNote, { exact: true }).waitFor();
      await t.test('R2-2 Provider account description stays in its heading row', async () => {
        const row = page.locator('.access-row').filter({ has: page.getByText('Provider account', { exact: true }) });
        assert.equal(await row.locator('.cfg-row__sub').innerText(), providerNote);
        await row.scrollIntoViewIfNeeded();
        await shot('provider');
        await fits();
      });
      await t.test('R2-3 zero days have no painted bar and tiny stacks stay above the baseline', async () => {
        await page.locator('.usage-chart').scrollIntoViewIfNeeded();
        const geometry = await page.locator('.usage-chart__plot').evaluate(plot => {
          const baseline = plot.getBoundingClientRect().bottom;
          return [...plot.querySelectorAll('.usage-chart__slot')].map(slot => ({
            label: slot.getAttribute('aria-label'),
            bars: [...slot.querySelectorAll('.usage-chart__col, .usage-chart__seg')].map(el => ({ height: el.getBoundingClientRect().height, bottom: el.getBoundingClientRect().bottom, baseline })),
          }));
        });
        await shot('chart');
        for (const [i, day] of geometry.entries()) {
          if (i !== 1 && i !== 3) assert.ok(day.bars.every(bar => bar.height === 0), JSON.stringify(day));
          if (i === 3) assert.ok(day.bars.some(bar => bar.height > 0));
          assert.ok(day.bars.every(bar => bar.bottom <= bar.baseline + 0.1), JSON.stringify(day));
        }
        await page.locator('.usage-chart__slot').first().focus();
        assert.match(await page.locator(width === 390 ? '.usage-readout' : '.usage-tip').innerText(), /\$0\b/);
        await fits();
      });
      await t.test('R2-4 Bot number label and value align with the phone field', async () => {
        await open('messaging');
        const label = page.getByText('Bot number', { exact: true });
        await label.waitFor();
        const xs = await page.locator('.cfg-row__text > .msg-facts__row > span, .msg-phone-auth input, .phone-auth__label, .phone-auth__input-hint').evaluateAll(els => els.map(el => el.getBoundingClientRect().left));
        assert.equal(xs.length, 5);
        assert.ok(Math.max(...xs) - Math.min(...xs) <= 1, `phone indents: ${xs}`);
        await shot('messaging');
        await fits();
      });
      await t.test('R2-5 Sign out uses a secondary button', async () => {
        await open('account');
        const button = page.getByRole('button', { name: 'Sign out', exact: true });
        await button.waitFor();
        assert.ok(!(await button.getAttribute('class')).includes('cfg-btn--primary'));
        assert.ok((await button.getAttribute('class')).includes('cfg-btn--secondary'));
        await shot('account');
        await fits();
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, []);
    } finally { await page.close(); }
  });
}
