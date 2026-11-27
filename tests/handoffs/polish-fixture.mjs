import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { integrationServer } from './integration-routes-ui.mjs';
import { recordedRun, scenarios, bots } from './ui-e-fixture.mjs';
import { fixture as handoffFixture } from './ui-d-fixture.mjs';

export const screens = [
  'receipt', 'output-card', 'send-sheet', 'handoff-detail', 'output-viewer', 'handoff-list',
  'loops-list', 'loop-timeline', 'loop-graph', 'loop-sheet', 'gate-card', 'flow-tab', 'flow-compact', 'link-sheet', 'sidebar-loops',
  ...Object.keys(scenarios).filter(x => !['converged', 'gated'].includes(x)).map(x => `loop-${x}`),
  ...['loading', 'empty', 'error'].flatMap(x => [`output-${x}`, `handoffs-${x}`, `loops-${x}`, `flow-${x}`]),
  ...['loading','empty','error'].flatMap(x => [`handoff-${x}`, `viewer-${x}`, `send-${x}`]), 'handoff-approval', 'gate-cap', 'gate-manual',
  'flow-suggestions', 'flow-long', 'link-edit', 'send-loop',
];
export async function polishFixture() {
  const root = path.resolve('.context/ho-p'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'fixture-'));
  const server = await integrationServer(dir);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const d = await handoffFixture();
  const { fixtures } = await tsImport('../flow/fixtures.mts', import.meta.url);
  const { buildFlowModel } = await tsImport('../../server/src/flow/build.ts', import.meta.url);
  const botId = server.fixture.bot.id;
  return {
    async open(name, width, theme) {
      const dView = /^handoff-(loading|empty|error|approval)$/.test(name) ? 'detail' : /^viewer-(loading|empty|error)$/.test(name) ? 'viewer' : /^send-(loading|empty|error)$/.test(name) ? 'sheet' : name === 'handoff-list' ? 'list' : name.startsWith('output-') && ['loading','empty','error'].includes(name.slice(7)) ? 'card' : name.startsWith('handoffs-') ? 'list' : name.startsWith('send-') && ['error','loop'].includes(name.slice(5)) ? 'sheet' : null;
      if (dView) {
        const state = name.split('-').at(-1);
        const page = await d.page({ view: dView, state: ['loading','empty','error'].includes(state) && name !== 'send-error' ? state : 'ready', width, theme, loops: state === 'loop' });
        if (name === 'handoff-approval') { await page.evaluate(() => { window.fixture.status = 'pending_approval'; window.refreshFixture(); }); await page.getByRole('button', {name:'Approve',exact:true}).waitFor(); }
        if (name === 'send-error') { await page.getByRole('button', { name: /^Checker/ }).click(); await page.evaluate(() => { window.fixture.failSend = true; }); await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.getByRole('alert').waitFor(); }
        if (name === 'send-loop') { await page.getByRole('button', { name: /^Checker/ }).click(); await page.getByLabel('Keep improving', { exact: true }).check(); }
        return { page, selector: dView === 'sheet' ? 'dialog[open]' : '#root', close: () => page.close() };
      }
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => console.error(name, error.message));
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      await page.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '1'); }, theme);
      await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
      let hash = name === 'sidebar-loops' ? '#bots' : `#bot/${botId}`, selector = name === 'output-card' ? '.ho-output-card' : '.ho-receipt, .ho-output-card, .ho-message-actions';
      if (name.startsWith('loop') || name.startsWith('gate-')) {
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
      await page.goto(server.base + '/' + hash);
      if (name === 'loop-sheet') { await page.getByRole('button', { name: 'New loop', exact: true }).click(); selector = '.ho-loop-sheet'; }
      if (name === 'loop-graph') await page.getByRole('tab', { name: 'Graph', exact: true }).click();
      if (name === 'send-sheet') { await page.locator('.ho-output-card').getByRole('button', { name: 'Send to agent', exact: true }).first().click(); selector = 'dialog[open]'; }
      if (name === 'link-sheet' || name === 'link-edit') { await page.getByRole('button', { name: 'Add handoff', exact: true }).click(); selector = '.flow-sheet'; if (name === 'link-edit') await page.getByRole('button', { name: /^Edit handoff/ }).first().click(); }
      if (name === 'sidebar-loops') { if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await page.getByRole('button', { name: 'Account & settings', exact: true }).click(); selector = '.sidebar .menu__item:has(.lucide-git-branch)'; }
      await page.locator(selector).first().waitFor(); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
      return { page, selector, close: () => context.close() };
    },
    async close() { await d.close(); await browser.close(); await server.close(); },
  };
}
