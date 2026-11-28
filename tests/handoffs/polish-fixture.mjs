import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { integrationServer } from './integration-routes-ui.mjs';
import { recordedRun, scenarios, bots } from './ui-e-fixture.mjs';
import { fixture as handoffFixture } from './ui-d-fixture.mjs';
import { agentsSettingsScreens, agentsSettingsState } from './agents-settings-fixture.mjs';

export const screens = [
  'receipt', 'receipt-expanded', 'receipt-running', 'receipt-named', 'receipt-long', 'receipt-agent-long', 'message-actions', 'output-card', 'send-sheet', 'handoff-detail', 'output-viewer', 'handoff-list',
  'loops-list', 'loop-timeline', 'loop-graph', 'loop-sheet', 'gate-card', 'flow-tab', 'flow-compact', 'link-sheet', 'sidebar-loops',
  ...Object.keys(scenarios).filter(x => !['converged', 'gated'].includes(x)).map(x => `loop-${x}`),
  ...['loading', 'empty', 'error'].flatMap(x => [`output-${x}`, `handoffs-${x}`, `loops-${x}`, `flow-${x}`]),
  ...['loading','empty','error'].flatMap(x => [`handoff-${x}`, `viewer-${x}`, `send-${x}`]), 'handoff-approval', 'gate-cap', 'gate-manual',
  'flow-suggestions', 'flow-long', 'link-edit', 'send-loop', 'output-linked',
  ...agentsSettingsScreens,
];
export async function polishFixture() {
  const root = path.resolve('.context/ho-q'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'fixture-'));
  const server = await integrationServer(dir);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const d = await handoffFixture({ server });
  const { fixtures } = await tsImport('../flow/fixtures.mts', import.meta.url);
  const { buildFlowModel } = await tsImport('../../server/src/flow/build.ts', import.meta.url);
  const botId = server.fixture.bot.id;
  const contexts = new Map();
  return {
    async open(name, width, theme) {
      const dView = /^handoff-(loading|empty|error|approval)$/.test(name) ? 'detail' : /^viewer-(loading|empty|error)$/.test(name) ? 'viewer' : /^send-(loading|empty|error)$/.test(name) ? 'sheet' : name === 'handoff-list' ? 'list' : name.startsWith('output-') && ['loading','empty','error'].includes(name.slice(7)) ? 'card' : name.startsWith('handoffs-') ? 'list' : name.startsWith('send-') && ['error','loop'].includes(name.slice(5)) ? 'sheet' : null;
      if (dView) {
        const state = name.split('-').at(-1);
        const page = await d.page({ view: dView, state: ['loading','empty','error'].includes(state) && name !== 'send-error' ? state : 'ready', width, theme, loops: state === 'loop' });
        if (name === 'handoff-approval') { await page.evaluate(() => { window.fixture.status = 'pending_approval'; window.refreshFixture(); }); await page.getByRole('button', {name:'Approve',exact:true}).waitFor(); }
        if (name === 'send-error') { await page.getByRole('button', { name: /^Checker/ }).click(); await page.evaluate(() => { window.fixture.failSend = true; }); await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.getByRole('alert').waitFor(); }
        if (name === 'send-loop') { await page.getByRole('button', { name: /^Checker/ }).click(); await page.getByLabel('Keep improving', { exact: true }).check(); await page.getByLabel('Stop when', {exact:true}).waitFor(); }
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
        return { page, selector: dView === 'sheet' ? 'dialog[open]' : '#root', close: () => page.close() };
      }
      // Retain asset caches per viewport/theme. Each state has a fresh page and
      // page-local API handlers, so its policy/link mutations cannot leak into
      // the next state. Theme and sidebar preferences are reset below.
      const key = `${width}:${theme}`;
      if (!contexts.has(key)) contexts.set(key, await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme: theme }));
      const context = contexts.get(key);
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => console.error(name, error.message));
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      // Follow each context's system theme. A legacy light/dark preference would
      // migrate into the shared fixture account and override later contexts.
      await page.addInitScript(() => { localStorage.setItem('swarm.theme', 'system'); localStorage.setItem('swarm.sidebarCollapsed', '1'); });
      await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
      if (name === 'output-linked') await page.route('**/api/outputs/by-job/*', async route => {
        const response = await route.fetch(), data = await response.json();
        data.output.parts.push({ id: 'p_release', kind: 'link', url: 'https://example.test/releases/2', title: 'Release details', relation: 'reference' });
        await route.fulfill({ response, json: data });
      });
      const receiptView = name.startsWith('receipt');
      let liveLoop, receiptTitle;
      if (receiptView) {
        const response = await context.request.get(`${server.base}/api/loops/${server.fixture.loopId}`);
        liveLoop = await response.json();
        liveLoop.loop.spec.name = name === 'receipt-named' ? 'Release note review' : name === 'receipt-long' ? 'Review the release notes and verify the accessibility improvements before publication' : 'Agent loop';
        const longMaker = 'Release research and accessibility coordinator';
        receiptTitle = ['receipt-named', 'receipt-long'].includes(name) ? liveLoop.loop.spec.name : `${name === 'receipt-agent-long' ? longMaker : 'Coordinator'} and Research loop`;
        if (name === 'receipt-agent-long') {
          for (const bot of liveLoop.bots ?? []) if (bot.id === botId) bot.name = longMaker;
          await page.route(/\/api\/bots$/, async route => {
            const response = await route.fetch(), data = await response.json();
            for (const bot of data.bots) if (bot.id === botId) bot.name = longMaker;
            await route.fulfill({ response, json: data });
          });
        }
        await page.route(`**/api/bots/${botId}/rows*`, async route => {
          const response = await route.fetch(), data = await response.json();
          const last = data.rows.at(-1), template = data.rows.find(row => row.kind === 'handoff');
          // Real seeded loop receipts plus one independent handoff and the output.
          data.rows.splice(-1, 0, { ...template, seq: last.seq, updatedSeq: last.updatedSeq, createdAt: last.createdAt - 1,
            body: { ...template.body, handoffId: 'ho_standalone', direction: 'sent', otherBotId: server.fixture.checker, title: 'Release note', loopId: undefined, iteration: undefined } });
          last.seq++;
          await route.fulfill({ response, json: data });
        });
        if (name === 'receipt-running') {
          Object.assign(liveLoop.loop, { status: 'running', iteration: 2, finishedAt: null, stopReason: null });
          liveLoop.loop.spec.limits.maxIterations = 4;
        }
        await page.route(`**/api/loops/${server.fixture.loopId}`, route => route.fulfill({ json: liveLoop }));
      }
      let hash = name === 'sidebar-loops' ? '#bots' : `#bot/${botId}`, selector = name === 'output-card' ? '.ho-output-card' : '.ho-receipt, .ho-output-card, .ho-message-actions';
      const settings = name.startsWith('settings-agents') ? await agentsSettingsState(page, server.fixture, name) : null;
      if (settings) { hash = settings.hash; selector = settings.selector; }
      else if (name.startsWith('loop') || name.startsWith('gate-')) {
        const runName = name.startsWith('gate-') ? 'gated' : name.startsWith('loop-') && scenarios[name.slice(5)] ? name.slice(5) : 'converged';
        const run = recordedRun(runName);
        if (name === 'gate-cap' || name === 'gate-manual') { run.detail.gate.kind = name.slice(5); run.detail.canExtend = true; }
        await page.route(/\/api\/loops(?:\/[^?]*)?(?:\?.*)?$/, route => {
          const pathname = new URL(route.request().url()).pathname;
          if (name === 'loops-loading') return new Promise(() => {});
          if (name === 'loops-error') return route.fulfill({ status: 503, json: { error: 'Could not load loops. Try again.' } });
          return route.fulfill({ json: pathname.endsWith('/events') ? { events: run.events, next: null } : pathname.endsWith('/loops') ? { loops: name === 'loops-empty' ? [] : Object.keys(scenarios).map(x => recordedRun(x).detail.loop), next: null } : run.detail });
        });
        await page.route(/\/api\/bots$/, async route => { const response = await route.fetch(); const data = await response.json(); return route.fulfill({ json: { ...data, bots: [...data.bots, ...bots.map(bot => ({ ...data.bots[0], ...bot, avatarShape: 'bird-flock', avatarColor: 'blue' }))] } }); });
        hash = name === 'loops-list' || name === 'loop-sheet' || name.startsWith('loops-') ? '#loops' : `#loop/lp_${runName}`;
        selector = '.ho-loops';
      } else if (name === 'handoff-detail') {
        const response = await context.request.get(`${server.base}/api/handoffs?botId=${botId}`); const data = await response.json();
        hash = `#handoff/${data.handoffs[0].id}`; selector = '.ho-route';
      } else if (name === 'output-viewer') { hash = `#output/${server.fixture.outputId}`; selector = '.ho-route'; }
      else if (name.startsWith('flow-') || name.startsWith('link-')) {
        const input = structuredClone(fixtures[name === 'flow-long' ? 'long' : name === 'flow-suggestions' ? 'suggestions' : name === 'flow-empty' ? 'empty' : 'rich']); const originalId = input.bot.id; input.bot.id = botId;
        for (const link of input.links) { if (link.fromBotId === originalId) link.fromBotId = botId; if (link.toBotId === originalId) link.toBotId = botId; }
        const model = buildFlowModel(input);
        await page.route(/\/api\/bots\/[^/]+\/flow$/, route => name === 'flow-loading' ? new Promise(() => {}) : route.fulfill(name === 'flow-error' ? { status: 503, json: { error: 'Could not load flow. Try again.' } } : { json: model }));
        hash = `#bot/${botId}/details/${name === 'flow-compact' ? 'setup' : 'flow'}`; selector = name === 'flow-compact' ? '.flow-compact' : '.flow-tab';
      }
      const network = await context.newCDPSession(page);
      await network.send('Network.setCacheDisabled', { cacheDisabled: false });
      await page.goto(server.base + '/' + hash);
      if (settings) await settings.ready();
      if (name === 'loop-sheet') { await page.getByRole('button', { name: 'New loop', exact: true }).click(); selector = '.ho-loop-sheet'; }
      if (name === 'loop-graph') await page.getByRole('tab', { name: 'Graph', exact: true }).click();
      if (name === 'send-sheet') { await page.locator('.ho-output-card').getByRole('button', { name: 'Send to agent', exact: true }).first().click(); selector = 'dialog[open]'; }
      if (name === 'link-sheet' || name === 'link-edit') { await page.getByRole('button', { name: 'Add handoff', exact: true }).click(); selector = '.flow-sheet'; if (name === 'link-edit') await page.getByRole('button', { name: /^Edit handoff/ }).first().click(); }
      if (name === 'sidebar-loops') { if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await page.getByRole('button', { name: /Account & settings$/ }).click(); selector = '.sidebar .menu__item:has(.lucide-git-branch)'; }
      await page.locator(selector).first().waitFor();
      if (receiptView) {
        await page.locator('.ho-receipt--loop').getByRole('status').filter({hasText: name === 'receipt-running' ? 'Running' : 'Completed'}).waitFor();
        if (name === 'receipt-expanded') await page.locator('.ho-receipt-expand').click();
      }
      if (name === 'message-actions') await page.getByRole('button', {name:'Message actions',exact:true}).first().waitFor();
      // Audit the requested state, never its transient loading fallback.
      if (name === 'loops-list') await page.locator('.ho-loop-title-link').first().waitFor();
      if (name === 'loops-empty') await page.getByText('Nothing here yet', {exact:true}).waitFor();
      if (name === 'loops-error') await page.getByRole('alert').waitFor();
      if ((name.startsWith('loop-') && name !== 'loop-sheet') || name.startsWith('gate-')) await page.locator('[data-loop-revision]').waitFor();
      if (['flow-tab','flow-suggestions','flow-long','flow-empty'].includes(name)) await page.locator('.flow-chart').waitFor();
      if (name === 'flow-error') await page.getByRole('button', {name:'Retry',exact:true}).waitFor();
      if (name === 'output-viewer') await page.getByRole('heading', {name:'Parts',exact:true}).waitFor();
      if (name === 'handoff-detail') await page.getByRole('heading', {name:'Events',exact:true}).waitFor();
      if (name === 'send-sheet') await page.locator('.ho-target').first().waitFor();
      if (name.startsWith('link-')) await page.getByRole('combobox', {name:'Agent',exact:true}).waitFor();
      await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      return { page, selector, receiptTitle, async advanceLoop() {
        liveLoop.loop.iteration++; liveLoop.loop.revision++;
        await page.evaluate(id => window.dispatchEvent(new CustomEvent('swarm:event', {detail:{type:'loop',id}})), server.fixture.loopId);
      }, close: () => page.close() };
    },
    async close() { await d.close(); await browser.close(); await server.close(); },
  };
}
