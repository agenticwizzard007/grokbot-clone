// Local production app and synthetic accounts only. Never contacts a live provider.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';

const vite = await preview({ root: `${process.cwd()}/web`, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const evidence = '.context/provider-logos';
await mkdir(evidence, { recursive: true });
const model = (id, short, author) => ({ id, short, name: short, author, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', vision: true, reasoning: true, context: 200000 });
const cases = [
  { name: 'claude', provider: 'claude-cli', selected: 'claude', billing: 'plan', plan: 'max', mark: 'claude', models: [model('claude/opus-4-6', 'Opus 4.6', 'anthropic')] },
  { name: 'codex', provider: 'codex-cli', selected: 'codex', billing: 'plan', mark: 'openai', models: [] },
  { name: 'grok-api', provider: 'openrouter', selected: null, billing: 'api', mark: 'xai', models: [model('x-ai/grok-4', 'Grok 4', 'x-ai')] },
  { name: 'direct-grok', provider: 'direct', selected: null, billing: 'api', mark: 'xai', models: [model('grok-4', 'Grok 4', 'custom')] },
  { name: 'openai-api', provider: 'openrouter', selected: null, billing: 'api', mark: 'openai', models: [model('openai/gpt-5.5', 'GPT 5.5', 'openai')] },
];
async function markVisible(locator, brand) {
  const mark = locator.locator(`svg.provider-icon[data-provider="${brand}"]`).first();
  await mark.waitFor({ state: 'visible' });
  await mark.evaluate(el => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Provider artwork did not load')), 5000);
    const check = () => { if (el.getBBox().width > 0) { clearTimeout(timeout); resolve(); } else requestAnimationFrame(check); };
    check();
  }));
  const box = await mark.boundingBox();
  assert.equal(box.width, 16, 'brand slot width is fixed');
  assert.equal(box.height, 16, 'brand slot height is fixed');
  assert.equal(await mark.getAttribute('aria-hidden'), 'true', 'visible text supplies the accessible name');
  assert.equal(await mark.evaluate(el => getComputedStyle(el).flexShrink), '0');
  return mark;
}
try {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) for (const sample of cases) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme });
    page.setDefaultTimeout(10000);
    await page.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    const bot = fixture.bots[0];
    bot.onboarding = { status: 'active', revision: 1 }; bot.model = sample.models[0]?.id ?? null;
    const health = { installed: true, authenticated: true, subscription: true };
    const catalog = { ...sample, defaultModel: bot.model, favourites: sample.models.map(m => m.id), canFast: false };
    fixture.respond = ({ path }) => {
      if (path === '/api/models' || path === '/api/settings/models') return { json: catalog };
      if (path === '/api/cli') return { json: { selected: sample.selected, connected: true, runtime: 'server', serverLoginAvailable: true, providers: { claude: health, codex: health } } };
      if (path === '/api/providers/openrouter') return { json: { provider: sample.provider, connected: true, linked: true, active: !sample.selected, selected: !sample.selected, model: bot.model, settingsUrl: 'https://openrouter.ai/settings/credits' } };
      if (path === '/api/usage') {
        const coverage = { partialUsageRequests: 0, unavailableUsageRequests: 0, knownTokenRequests: 1, knownInputRequests: 1, knownOutputRequests: 1 };
        const row = { ...coverage, key: bot.model ?? 'codex/default', label: sample.models[0]?.short ?? 'Codex', tokens: 120, requests: 1, costUsd: 0, unpriced: 0, minutes: 0, recordings: 0, characters: 0 };
        return { json: { timezone: 'UTC', range: { key: '7d', from: 0, to: Date.now() }, scope: 'me', canSeeAll: false, canSeeProvider: false, provider: sample.provider,
          totals: { ...coverage, requests: 1, inputTokens: 100, outputTokens: 20, cachedTokens: 0, reasoningTokens: 0, toolCalls: 0, voiceMinutes: 0, costUsd: 0, estimatedUsd: 0, unpricedRequests: 0, unpricedVoice: 0 },
          billing: { sources: [{ source: sample.selected ? 'subscription' : 'api', provider: sample.provider, requests: 1, costUsd: 0, estimatedUsd: 0, unpricedRequests: 0 }], note: 'Local fixture usage.' },
          days: [{ ...row, day: '2026-11-25', computerUsd: 0 }], byBot: [], byModel: [row], byKind: [],
          computer: { costUsd: 0, runningHours: 0, asleepHours: 0, archivedHours: 0, now: null }, computerProvider: 'local', computerRates: {}, limits: { dailyMessages: null },
        } };
      }
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
      return null;
    };
    try {
      let releaseArtwork;
      const artwork = new Promise(resolve => { releaseArtwork = resolve; });
      await page.route('**/assets/providers/*.svg', async route => { await artwork; await route.continue(); });
      await page.goto(`${origin}/#bot/${bot.id}`, { waitUntil: 'domcontentloaded' });
      const pill = page.locator('.model-pill');
      await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
      const beforeArtwork = await pill.locator('.provider-icon').boundingBox();
      releaseArtwork();
      const icon = await markVisible(pill, sample.mark);
      assert.deepEqual(await icon.boundingBox(), beforeArtwork, 'loading the artwork does not move or resize its slot');
      const iconBox = await icon.boundingBox(), textBox = await pill.locator('.model-pill__name').boundingBox();
      assert.ok(iconBox.x + iconBox.width <= textBox.x + 1, 'mark precedes the plan/model label');
      assert.ok(Math.abs(iconBox.y + 8 - (textBox.y + textBox.height / 2)) < 1, 'mark aligns with the label');
      if (sample.models.length) assert.equal(await pill.locator('.model-pill__effort').isVisible(), true);
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-composer.png` });
      await pill.click();
      const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
      await markVisible(picker, sample.mark);
      if (sample.models.length) {
        await markVisible(picker.locator('.mm-row__main'), sample.mark);
        await picker.getByRole('button', { name: 'Effort', exact: true }).click();
        const effortHeading = page.locator('.mm-effort-model, .mm-sheet-head .mm-back').filter({ has: page.locator('.provider-icon') });
        await markVisible(effortHeading, sample.mark);
        await page.keyboard.press('Escape');
      }
      await page.keyboard.press('Escape');
      if (width === 390) await page.getByRole('button', { name: 'All Bots', exact: true }).click();
      if (sample.provider === 'direct') assert.equal(await page.locator('.sidebar-usage .provider-icon').count(), 0, 'an unnamed custom billing endpoint does not claim a provider brand');
      else await markVisible(page.locator('.sidebar-usage strong'), sample.billing === 'plan' ? sample.mark : 'openrouter');
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-sidebar.png` });
      if (width === 1280) {
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        const collapsedUsage = page.locator('.sidebar-usage');
        if (sample.provider !== 'direct') await markVisible(collapsedUsage, sample.billing === 'plan' ? sample.mark : 'openrouter');
        assert.match(await collapsedUsage.getAttribute('aria-label'), /Usage: (Claude|Codex|API credits)/, 'icon-only usage retains its accessible name');
      }
      // Full Settings UI: tabs, connection label, current route and key connection.
      await page.goto(`${origin}/#settings/subscriptions`);
      for (const [tab, brand] of [['Claude Code', 'claude'], ['Codex', 'openai']]) {
        const trigger = page.getByRole('tab', { name: tab, exact: true });
        await markVisible(trigger, brand);
        await trigger.click();
        await markVisible(page.getByRole('region', { name: 'Plan connection', exact: true }).locator('.cfg-row__title'), brand);
      }
      if (sample.selected) await markVisible(page.locator('.subscription-settings__current-route'), sample.mark);
      await markVisible(page.locator('#personal-openrouter-title'), 'openrouter');
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-access.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page overflow');
      await page.goto(`${origin}/#bot/${bot.id}/settings/general`);
      const botModel = page.getByRole('button', { name: 'Bot model', exact: true });
      await markVisible(botModel, sample.mark);
      if (sample.models.length) {
        await markVisible(page.locator('.cfg-field').filter({ has: page.getByRole('radiogroup', { name: 'Thinking effort', exact: true }) }), sample.mark);
        await botModel.click();
        await markVisible(page.getByRole('listbox', { name: 'Bot model options', exact: true }), sample.mark);
        await page.keyboard.press('Escape');
      }
      await botModel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-bot-settings.png` });
      await page.goto(`${origin}/#settings/usage`);
      if (sample.provider !== 'direct') await markVisible(page.locator('.usage-billing'), sample.selected ? sample.mark : 'openrouter');
      await page.getByRole('button', { name: 'Show more', exact: true }).click();
      await markVisible(page.locator('.usage-ranked__label'), sample.mark);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'settings and usage fit');
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      console.log(`PASS provider logos: ${sample.name} ${width} ${theme}, composer, picker, effort, sidebar, Models & access, Bot settings and Usage`);
    } catch (error) {
      await page.screenshot({ path: `${evidence}/failure.png` });
      throw error;
    } finally { await page.context().close(); }
  }
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
