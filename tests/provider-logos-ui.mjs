// Local production app and synthetic accounts only. Never contacts a live provider.
import assert from 'node:assert/strict';
import { readableWords } from './paper-label-geometry.mjs';
import { boxFullyVisible } from './ui-box-assertions.mjs';
import { cp, mkdir } from 'node:fs/promises';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import path from 'node:path';
import { chromium } from 'playwright';

const evidence = '.context/provider-logos';
await mkdir(evidence, { recursive: true });
const outDir = path.resolve(evidence, 'dist');
await cp('web/dist', outDir, { recursive: true });
const vite = await preview({ root: `${process.cwd()}/web`, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin, gate } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const model = (id, short, author) => ({ id, short, name: short, author, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', vision: true, reasoning: true, context: 200000 });
const catalogMakers = [
  ['z-ai', 'zai'], ['minimax', 'minimax'], ['amazon', 'nova'], ['nvidia', 'nvidia'], ['perplexity', 'perplexity'],
  ['aion-labs', 'aionlabs'], ['baidu', 'baidu'], ['bytedance-seed', 'bytedance'], ['fireworks', 'fireworks'],
  ['ibm-granite', 'ibm'], ['liquid', 'liquid'], ['microsoft', 'microsoft'], ['nousresearch', 'nousresearch'],
  ['rekaai', 'reka'], ['relace', 'relace'], ['sakana', 'sakana'], ['stepfun', 'stepfun'], ['tencent', 'tencent'],
  ['upstage', 'upstage'], ['xiaomi', 'xiaomimimo'], ['google', 'gemini'], ['meta-llama', 'meta'],
  ['mistralai', 'mistral'], ['deepseek', 'deepseek'], ['qwen', 'qwen'], ['moonshotai', 'moonshot'], ['cohere', 'cohere'],
  ['unlisted-maker', 'openrouter'],
].map(([author, mark]) => ({ ...model(`${author}/catalog-model`, `Catalog complete extended model for ${author}`, author), mark }));
const cases = [
  { name: 'claude-fable', provider: 'claude-cli', selected: 'claude', billing: 'plan', plan: 'max', plans: ['claude'], plansLabel: 'Manage plans', mark: 'claude', models: [
    { ...model('claude/claude-fable-5-2', 'Claude Fable 5 2', 'anthropic'), resolvedModel: 'claude-fable-5-2' },
  ] },
  { name: 'catalog-makers', provider: 'openrouter', selected: null, billing: 'api', plans: [], statusChecking: true, plansLabel: 'Plans', mark: 'zai', models: catalogMakers },
  { name: 'claude', provider: 'claude-cli', selected: 'claude', billing: 'plan', plan: 'max', plans: ['claude'], plansLabel: 'Manage plans', mark: 'claude', models: [
    { ...model('claude/default', 'Opus', 'anthropic'), resolvedModel: 'claude-opus-5-5' },
    { ...model('claude/sonnet', 'Sonnet', 'anthropic'), resolvedModel: 'claude-sonnet-5-5' },
    { ...model('claude/haiku', 'Haiku', 'anthropic'), resolvedModel: 'claude-haiku-4-5-20251001' },
  ] },
  { name: 'codex', provider: 'codex-cli', selected: 'codex', billing: 'plan', plans: ['codex'], plansLabel: 'Manage plans', mark: 'openai', models: [] },
  { name: 'grok-api', provider: 'openrouter', selected: null, billing: 'api', plans: ['codex'], plansLabel: 'Manage plans', mark: 'xai', models: [model('x-ai/grok-4.7', 'Grok 4.7', 'x-ai')] },
  { name: 'direct-grok', provider: 'direct', selected: null, billing: 'api', plans: [], plansLabel: 'Connect plan', mark: 'xai', models: [model('grok-4.7', 'Grok 4.7', 'custom')] },
  { name: 'openai-api', provider: 'openrouter', selected: null, billing: 'api', plans: ['claude'], plansLabel: 'Manage plans', mark: 'openai', models: [model('openai/gpt-5.5', 'GPT 5.5', 'openai')] },
];
async function markVisible(locator, brand) {
  const mark = locator.locator(`svg.provider-icon[data-provider="${brand}"]`).first();
  return inspectMark(mark);
}
async function inspectMark(mark) {
  await mark.waitFor({ state: 'visible' });
  await mark.evaluate(el => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Provider artwork did not load')), 5000);
    const check = () => { if (el.getBBox().width > 0) { clearTimeout(timeout); resolve(); } else requestAnimationFrame(check); };
    check();
  }));
  assert.equal(await mark.getAttribute('aria-hidden'), 'true', 'visible text supplies the accessible name');
  await boxFullyVisible(mark, { width: 16, height: 16 });
  assert.equal(await mark.evaluate(el => getComputedStyle(el).color), await mark.evaluate(el => el.dataset.provider === 'claude' ? 'rgb(217, 119, 87)' : getComputedStyle(el.parentElement).color));
  return mark;
}
async function readable(scope) {
  for (const row of await scope.locator('.mm-row').all()) {
    assert.equal(await row.evaluate(el => {
      const box = el.getBoundingClientRect(), label = el.querySelector('.mm-row__name').getBoundingClientRect();
      return label.top >= box.top - 1 && label.bottom <= box.bottom + 1;
    }), true, 'wrapped model labels stay inside their own row without overlapping adjacent rows');
  }
  for (const mark of await scope.locator('svg.provider-icon').all()) {
    // Closed disclosures intentionally do not render their body. Every other mark
    // must be visible, including marks accidentally hidden by responsive CSS.
    if (await mark.evaluate(el => {
      for (let node = el.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS' && !node.open && !node.querySelector(':scope > summary')?.contains(el)) return true;
      return false;
    })) continue;
    await inspectMark(mark);
    // Some labels are plain text beside a mark instead of ProviderLabel spans.
    const parent = mark.locator('..');
    assert.equal(await parent.evaluate(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis'), true, `complete mark container: ${await parent.innerText()}`);
  }
  for (const label of await scope.locator('.provider-label__text, .model-pill__name, .model-pill__effort, .mm-row__name, .mm-row__resolved, .mm-back > span, .model-picker__current, .model-picker__name, .model-picker__meta, .model-billing, .provider-effort [role="radio"], .usage-card__title, .usage-ranked__label').all()) {
    if (!await label.isVisible()) continue;
    const text = await label.innerText();
    await readableWords(label);
    assert.equal(await label.evaluate(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis'), true, `complete label: ${text}`);
  }
}
try {
  for (const width of [320, 390, 500, 768, 1280]) for (const theme of ['light', 'dark']) for (const sample of cases) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme });
    page.setDefaultTimeout(10000);
    await page.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    const bot = fixture.bots[0];
    bot.onboarding = { status: 'active', revision: 1 }; bot.model = sample.models[0]?.id ?? null;
    const health = { installed: true, authenticated: true, subscription: true };
    const disconnected = { installed: true, authenticated: false, subscription: false };
    let statusReads = 0;
    const catalog = { ...sample, defaultModel: bot.model, favourites: sample.models.map(m => m.id), canFast: false };
    const catalogReady = gate();
    fixture.respond = async ({ path }) => {
      if (path === '/api/models' || path === '/api/settings/models') { await catalogReady.wait; return { json: catalog }; }
      if (path === '/api/learning/settings') {
        const settings = { enabled: true, automaticReview: false, memoryReview: true, skillReview: false, skillApproval: true, memoryTurnInterval: 10, skillIterationInterval: 10, maxIterations: 10, maxInputTokens: null, auxiliaryModel: null, auxiliaryProvider: null, curatorEnabled: false, curatorIntervalHours: 24, curatorMinIdleHours: 1, curatorStaleDays: 30, curatorArchiveDays: 90, curatorConsolidate: false };
        return { json: { settings, account: settings, overrides: null, revision: 1, accountRevision: 1, botId: null } };
      }
      if (path === '/api/learning/reviews') return { json: { reviews: [{ id: 'local-review', botId: bot.id, status: 'completed', reason: 'Local review', model: bot.model ?? 'codex/default', provider: sample.provider, originModel: bot.model ?? 'codex/default', originProvider: sample.provider, createdAt: Date.now(), iterations: 1, inputTokens: 20, outputTokens: 10, usageStatus: 'complete', generation: 1, summary: 'Local fixture run.' }], nextBefore: null } };
      if (path === '/api/cli') {
        statusReads++;
        return { json: { selected: sample.selected, connected: true, runtime: 'server', serverLoginAvailable: true, statusChecking: sample.statusChecking,
          providers: Object.fromEntries(['claude', 'codex'].map(provider => [provider, sample.plans.includes(provider) ? health : disconnected])) } };
      }
      if (path === '/api/providers/openrouter') return { json: { provider: sample.provider, connected: true, linked: true, active: !sample.selected, selected: !sample.selected, model: bot.model, settingsUrl: 'https://openrouter.ai/settings/credits' } };
      if (path === '/api/usage/provider') return { json: { note: 'Local provider account fixture.', openrouter: { label: 'Local complete provider account label', usage: { today: 0, week: 0, month: 0, allTime: 0 }, budgets: [] } } };
      if (path === '/api/usage') {
        const coverage = { partialUsageRequests: 0, unavailableUsageRequests: 0, knownTokenRequests: 1, knownInputRequests: 1, knownOutputRequests: 1 };
        const row = { ...coverage, key: bot.model ?? 'codex/default', label: sample.models[0]?.short ?? 'Codex', tokens: 120, requests: 1, costUsd: 0, unpriced: 0, minutes: 0, recordings: 0, characters: 0 };
        return { json: { timezone: 'UTC', range: { key: '7d', from: 0, to: Date.now() }, scope: 'me', canSeeAll: false, canSeeProvider: true, provider: sample.provider,
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
      await page.goto(`${origin}/#bots`, { waitUntil: 'domcontentloaded' });
      const sidebarSlot = page.locator('.sidebar-usage strong .provider-icon');
      await sidebarSlot.waitFor();
      const reserved = await sidebarSlot.boundingBox();
      assert.equal(reserved.width, 16); assert.equal(reserved.height, 16);
      const labelBeforeCatalog = await page.locator('.sidebar-usage .provider-label__text').boundingBox();
      catalogReady.release();
      await page.waitForFunction(() => !document.querySelector('.sidebar-usage')?.textContent.includes('Loading usage'));
      const labelAfterCatalog = await page.locator('.sidebar-usage .provider-label__text').boundingBox();
      assert.equal(labelAfterCatalog.x, labelBeforeCatalog.x, 'sidebar reserves the mark slot while the catalog loads');
      await page.goto(`${origin}/#bot/${bot.id}`, { waitUntil: 'domcontentloaded' });
      const pill = page.locator('.model-pill');
      await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
      const beforeArtwork = await pill.locator('.provider-icon').boundingBox();
      releaseArtwork();
      const icon = await markVisible(pill, sample.mark);
      assert.deepEqual(await icon.boundingBox(), beforeArtwork, 'loading the artwork does not move or resize its slot');
      const iconBox = await icon.boundingBox(), textBox = await pill.locator('.model-pill__name').boundingBox() ?? await pill.locator('.model-pill__effort').boundingBox();
      assert.ok(textBox.width > 0, 'the model name keeps visible space beside the mark and effort');
      assert.ok(iconBox.x + iconBox.width <= textBox.x + 1, 'mark precedes the plan/model label');
      assert.ok(Math.abs(iconBox.y + 8 - (textBox.y + textBox.height / 2)) < 1, 'mark aligns with the label');
      if (sample.models.length) assert.equal(await pill.locator('.model-pill__effort').isVisible(), true);
      await readable(pill);
      if (sample.name === 'claude-fable') assert.match(await pill.getAttribute('aria-label'), /Claude Fable 5\.2/);
      {
        const input = page.locator('.composer__input');
        assert.ok((await input.boundingBox()).width >= (width <= 480 ? width - 70 : 160), 'field has priority over the model chip');
        const before = await page.locator('.composer').boundingBox(), markBefore = await icon.boundingBox();
        await input.pressSequentially('Hi all.');
        assert.equal((await page.locator('.composer').boundingBox()).height, before.height, 'one-line sentence keeps composer height');
        assert.deepEqual(await icon.boundingBox(), markBefore, 'one-line sentence keeps the logo in place');
        await input.fill('');
      }
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-composer.png` });
      const readsBeforePicker = statusReads;
      await pill.click();
      const picker = page.getByRole('dialog', { name: 'Model and effort', exact: true });
      await markVisible(picker, sample.mark);
      await readable(picker);
      if (sample.name === 'claude-fable') assert.equal(await picker.locator('.mm-row__resolved').innerText(), 'Claude Fable 5.2');
      assert.equal(await picker.getByRole('button', { name: sample.plansLabel, exact: true }).count(), 1);
      assert.equal(statusReads, readsBeforePicker, 'rendering the plan row does not request provider status');
      for (const row of await picker.locator('.mm-row__name').all()) assert.doesNotMatch(await row.innerText(), /\b\d \d\b/, 'version digits retain their dot');
      if (sample.name === 'claude') {
        assert.deepEqual(await picker.locator('.mm-row__resolved').allTextContents(), ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 4.5']);
      }
      if (sample.name === 'catalog-makers') {
        await picker.getByRole('searchbox', { name: 'Search models', exact: true }).fill('/');
        for (const item of catalogMakers) await markVisible(picker.locator('.mm-row__main').filter({ hasText: item.short }), item.mark);
        await readable(picker);
        await picker.getByRole('searchbox', { name: 'Search models', exact: true }).fill('');
      }
      if (sample.models.length) {
        await markVisible(picker.locator('.mm-row__main'), sample.mark);
        await picker.getByRole('radiogroup', { name: 'Effort', exact: true }).waitFor();
        await readableWords(picker.locator('.mm-effort-section'));
      }
      await page.keyboard.press('Escape');
      if (width <= 760) await page.getByRole('button', { name: 'All Bots', exact: true }).click();
      if (sample.provider === 'direct') assert.equal(await page.locator('.sidebar-usage svg.provider-icon').count(), 0, 'an unnamed custom billing endpoint does not claim a provider brand');
      else await markVisible(page.locator('.sidebar-usage strong'), sample.billing === 'plan' ? sample.mark : 'openrouter');
      await readable(page.locator('.sidebar-usage'));
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-sidebar.png` });
      await page.getByRole('button', { name: /^Search(?: |$)/ }).click();
      const searchDialog = page.getByRole('dialog', { name: 'Search', exact: true });
      await searchDialog.waitFor();
      assert.equal(await searchDialog.locator('.provider-icon').count(), 0, 'Search contains Bot names and messages, not provider labels');
      await page.keyboard.press('Escape');
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
        await readable(page.locator('.app-settings'));
      }
      if (sample.selected) await markVisible(page.locator('.subscription-settings__current-route'), sample.mark);
      await markVisible(page.locator('#personal-openrouter-title'), 'openrouter');
      await readable(page.locator('.app-settings'));
      await page.locator('.subscription-settings__context > summary').click();
      if (sample.selected) await markVisible(page.locator('.subscription-settings__context'), 'openai');
      else assert.equal(await page.locator('.subscription-settings__context .provider-icon').count(), 0, 'API run diagnostics do not name a provider or model');
      await readable(page.locator('.subscription-settings__context'));
      await page.locator('.subscription-settings__advanced > summary').click();
      await readable(page.locator('.subscription-settings__advanced'));
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-access.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page overflow');
      await page.goto(`${origin}/#bot/${bot.id}/settings/general`);
      const botModel = page.getByRole('button', { name: /^Bot model:/ });
      await markVisible(botModel, sample.mark);
      if (sample.name === 'claude-fable') assert.match(await botModel.innerText(), /Claude Fable 5\.2/);
      if (sample.models.length) {
        await markVisible(page.locator('.cfg-field').filter({ has: page.getByRole('radiogroup', { name: 'Thinking effort', exact: true }) }), sample.mark);
        await botModel.click();
        await markVisible(page.getByRole('listbox', { name: 'Bot model options', exact: true }), sample.mark);
        await readable(page.getByRole('listbox', { name: 'Bot model options', exact: true }));
        await page.keyboard.press('Escape');
      }
      await readable(page.locator('.bot-settings-page'));
      await botModel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-bot-settings.png` });
      await page.goto(`${origin}/#settings/usage`);
      if (sample.provider !== 'direct') await markVisible(page.locator('.usage-billing'), sample.selected ? sample.mark : 'openrouter');
      await page.getByRole('button', { name: 'Show more', exact: true }).click();
      await markVisible(page.locator('.usage-ranked__label'), sample.mark);
      if (sample.name === 'claude-fable') {
        assert.equal(await page.locator('.usage-ranked__label').innerText(), 'Claude Fable 5.2');
        assert.match(await page.locator('.usage-ranked__row').getAttribute('aria-label'), /Claude Fable 5\.2/);
      }
      await markVisible(page.locator('.usage-card__title'), 'openrouter');
      await readable(page.locator('.app-settings'));
      await page.screenshot({ path: `${evidence}/${sample.name}-${width}-${theme}-usage.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'settings and usage fit');
      await page.goto(`${origin}/#settings/learning`);
      await page.getByRole('button', { name: 'Review history', exact: true }).click();
      const history = page.getByRole('region', { name: 'Learning review history', exact: true });
      await history.locator('.native-history > summary').click();
      await markVisible(history, sample.mark);
      await readable(history);
      if (sample.name === 'claude-fable') assert.equal(await history.getByText('Claude Fable 5.2', { exact: true }).count(), 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'run route labels fit');
      assert.deepEqual(errors, []); assert.deepEqual(writes.filter(write => !write.path.endsWith('/suggested-apps')), [], 'only the read-only suggestion POST is permitted');
      console.log(`PASS provider logos: ${sample.name} ${width} ${theme}, composer, picker, effort, sidebar, Models & access, Bot settings, Usage, Search and run routes`);
    } catch (error) {
      await page.screenshot({ path: `${evidence}/failure.png` });
      throw error;
    } finally { await page.context().close(); }
  }
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
