import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { layoutServer } from '../layout-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';

const stamp = Date.UTC(2026, 0, 15, 12);
export const output = {
  id: 'out_fixture', userId: 'usr_fixture', botId: 'bot_maker', jobId: 'job_fixture', taskId: null,
  source: 'run', status: 'final', revision: 1, title: 'Release note draft',
  summary: 'A short release note with the version, three changes, and a clear next step. Ready for a second agent to review against the brief.',
  parts: [
    { id: 'p_body', kind: 'text', name: 'body', chars: 12000, sha256: 'fixture' },
    { id: 'p_file', kind: 'file', artifactId: 'artifact_fixture', filename: 'release-notes.md', mime: 'text/markdown', size: 2048, sha256: 'fixture' },
    { id: 'p_data', kind: 'data', name: 'Review checklist', bytes: 120, sha256: 'fixture' },
    { id: 'p_link', kind: 'link', url: 'https://example.com/brief', title: 'Release brief', relation: 'source' },
  ],
  provenance: { producer: { botId: 'bot_maker', botName: 'Maker' }, jobId: 'job_fixture', trigger: 'user', model: 'openai/gpt-fixture', effort: 'Standard', startedAt: stamp, finishedAt: stamp + 60000, consumed: [], handoffId: null, loopId: null, iteration: null, stepId: null, tools: [], declaredBy: 'auto' },
  contentHash: 'fixture', createdAt: stamp, finalizedAt: stamp + 60000,
};
const agent = (id, name, label, extra = {}) => ({ id, name, label, kind: 'agent', onboarding: { status: 'active' }, avatarShape: 'bird-sparrow', avatarColor: 'blue', lastActivityAt: stamp, ...extra });
export const agents = [agent('bot_maker', 'Maker', 'Drafts release notes'), agent('bot_checker', 'Checker', 'Checks the brief'), agent('bot_editor', 'Editor', 'Polishes the draft'),
  agent('bot_room', 'Project room', '', { kind: 'room' }), agent('bot_setup', 'Setup agent', '', { onboarding: { status: 'interviewing' } }), agent('bot_hidden', 'Hidden agent', '', { hidden: true }), agent('bot_inactive', 'Inactive agent', '', { active: false })];
export const link = { id: 'link_fixture', userId: 'usr_fixture', fromBotId: 'bot_maker', toBotId: 'bot_checker', mode: 'suggest', trigger: 'any_run', template: 'Review {title} against the brief.', autoApproveLoops: false, createdAt: stamp, updatedAt: stamp };
export const handoff = { id: 'ho_fixture', userId: 'usr_fixture', fromBotId: 'bot_maker', toBotId: 'bot_checker', sourceOutputId: output.id, resultOutputId: 'out_result', initiatedBy: 'user', instruction: 'Review this and improve it.', priority: 'normal', returnResult: true, createTask: true, status: 'completed', reason: '', requestId: 'req_fixture', jobId: 'job_receiver', loopId: null, iteration: null, stepId: null, roomId: null, chainDepth: 1, parentHandoffId: null, idempotencyKey: 'fixture', fingerprint: 'fixture', revision: 1, createdAt: stamp, updatedAt: stamp + 60000 };
export const events = ['created', 'delivered', 'read', 'completed'].map((type, index) => ({ seq: index + 1, type: `handoff.${type}`, createdAt: stamp + index * 15000, data: type === 'read' ? { partId: 'p_body', bytes: 500 } : {} }));

export async function fixture() {
  const root = path.resolve('.context/ho-d'); fs.mkdirSync(root, { recursive: true });
  const out = fs.mkdtempSync(path.join(root, 'fixture-'));
  const from = name => JSON.stringify(path.resolve(`web/src/handoffs/${name}`));
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Handoff fixture</title></head><body><main id="root"></main><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; await import("./index.tsx");</script></body></html>');
  fs.writeFileSync(path.join(out, 'index.tsx'), `
import React, {useState, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Page, Section, Card} from ${JSON.stringify(path.resolve('web/src/components/layout/index.tsx'))};
import {OutputCard} from ${from('OutputCard.tsx')};
import {SendSheet} from ${from('SendSheet.tsx')};
import {HandoffRow} from ${from('HandoffRow.tsx')};
import {HandoffDetail} from ${from('HandoffDetail.tsx')};
import {OutputViewer} from ${from('OutputViewer.tsx')};
import {HandoffList, HandoffSettingsControls} from ${from('HandoffList.tsx')};
import {refreshHandoffs} from ${from('useHandoffs.ts')};
import ${JSON.stringify(path.resolve('web/src/styles/tokens.css'))};
import ${JSON.stringify(path.resolve('web/src/styles/base.css'))};
const params = new URLSearchParams(location.search), mode = params.get('state') || 'ready';
document.documentElement.dataset.theme = params.get('theme') || 'light';
document.body.style.overflow = 'auto'; document.documentElement.style.height = 'auto';
const output = ${JSON.stringify(output)}, link = ${JSON.stringify(link)};
window.refreshFixture = refreshHandoffs;
function App() {
 const [hash, setHash] = useState(location.hash), [open, setOpen] = useState(false), [target, setTarget] = useState(''), [receipt, setReceipt] = useState(null);
 useEffect(() => { const listener = () => setHash(location.hash); window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); }, []);
 const view = hash.startsWith('#handoff/') ? 'detail' : hash.startsWith('#output/') ? 'viewer' : params.get('view') || 'card';
 const send = (_output, targetId) => { setTarget(targetId || ''); setOpen(true); };
 const row = {handoffId: 'ho_fixture', direction: 'sent', otherBotId: 'bot_checker', status: mode === 'ready' ? 'running' : mode === 'error' ? 'failed' : 'queued', title: output.title};
 const body = view === 'detail' ? <HandoffDetail handoffId="ho_fixture" onBack={() => history.back()} onSend={send}/> : view === 'viewer' ? <OutputViewer outputId="out_fixture" partId={new URLSearchParams(hash.split('?')[1]).get('part') || undefined} onBack={() => history.back()} onSend={send} onStartLoop={() => { window.loopRequested = true; }}/> :
 <Page className="ho" title={view === 'settings' ? 'Agents' : view === 'list' ? 'Activity' : view === 'row' ? 'Conversation' : 'Run output'}>
 {view === 'settings' ? <HandoffSettingsControls botId={params.get('global') ? undefined : 'bot_maker'}/> : view === 'list' ? <HandoffList botId="bot_maker"/> : view === 'row' ? <Card variant="list"><HandoffRow body={row} otherBotName="Checker"/></Card> : <Section title="Finished run"><OutputCard output={mode === 'empty' || mode === 'loading' ? null : output} loading={mode === 'loading'} error={mode === 'error' ? 'Could not load this output.' : undefined} onRetry={() => { location.search = '?view=card'; }} onSend={send} suggestions={[{link, name: 'Checker'}]}/></Section>}
 {view === 'sheet' && <button className="ho-button" onClick={() => setOpen(true)}>Open Send sheet</button>}
 {receipt && <Card variant="list"><HandoffRow body={{...row, handoffId:receipt.id, status:receipt.status}} otherBotName="Checker"/></Card>}
 </Page>;
 const source = params.get('source') === 'task' ? {taskId:'task_fixture'} : params.get('source') === 'message' ? {messageRef:{botId:'bot_maker',generation:1,seq:5}} : undefined;
 return <>{body}<SendSheet open={open} onClose={() => setOpen(false)} senderId="bot_maker" output={source ? undefined : output} source={source} title="Release note draft" roomId={params.get('room') ? 'bot_room' : undefined} roomMemberIds={params.get('room') ? ['bot_editor'] : undefined} initialTargetId={target} onSent={value => setReceipt(value)}/></>;
}
createRoot(document.getElementById('root')).render(<App/>);
`);
  const server = await layoutServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  return {
    server, browser,
    async page({ view = 'card', state = 'ready', width = 390, theme = 'light', source = 'output', room = false, global = false } = {}) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
      });
      await page.addInitScript(({ output, agents, handoff, link, events, state }) => {
        const nativeFetch = window.fetch.bind(window);
        const f = window.fixture = { calls: [], sent: [], failSend: false, failOnce: false, failAfterCommit: false, links: [link], settings: { enabled: true, agentHandoffs: 'team' }, status: handoff.status, agents, ids: {}, state, failLinks: false, output, delay: 100 };
        window.fetch = async (input, init = {}) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
          if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
          const body = init.body ? JSON.parse(init.body) : undefined;
          f.calls.push({ path: url.pathname, query: url.search, method: init.method || 'GET', body });
          const reply = (value, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
          if (state === 'loading') return new Promise(() => {});
          if (state === 'error' && init.method !== 'POST') return reply({ error: 'Could not load this. Try again.', code: 'fixture_error' }, 503);
          if (url.pathname === '/api/bots') return reply({ bots: state === 'empty' ? [] : f.agents });
          if (url.pathname === '/api/handoff-settings') { if (init.method === 'PUT') f.settings = body; return reply({ settings: f.settings }); }
          if (url.pathname === '/api/handoff-links') {
            if (init.method === 'PUT') {
              if (f.failLinks) return reply({ error: 'That would create an automatic cycle.', code: 'cycle_detected' }, 422);
              f.links = body.links.map((item, index) => ({ ...link, ...item, id: item.id || 'link_' + index }));
            }
            return reply({ links: state === 'empty' ? [] : f.links });
          }
          if (url.pathname === '/api/handoffs' && init.method === 'POST') {
            await new Promise(resolve => setTimeout(resolve, f.delay));
            if (f.failSend || f.failOnce) { f.failOnce = false; return reply({ error: 'That would send the work back to Maker. Use a loop instead.', code: 'cycle_detected' }, 422); }
            if (!f.ids[body.idempotencyKey]) { f.ids[body.idempotencyKey] = { ...handoff, id: 'ho_sent_' + f.sent.length, status: 'running', toBotId: body.toBotId }; f.sent.push(body); }
            if (f.failAfterCommit) { f.failAfterCommit = false; throw new TypeError('Connection lost. Try again.'); }
            return reply({ handoff: f.ids[body.idempotencyKey] }, 201);
          }
          if (url.pathname === '/api/handoffs') {
            const direction = url.searchParams.get('direction');
            const rows = state === 'empty' ? [] : Array.from({ length: url.searchParams.has('after') ? 5 : 20 }, (_, index) => ({ ...handoff, id: 'ho_' + (url.searchParams.has('after') ? index + 20 : index), instruction: 'Review draft ' + (index + 1), fromBotId: direction === 'received' || (!direction && index % 2) ? 'bot_checker' : 'bot_maker', toBotId: direction === 'received' || (!direction && index % 2) ? 'bot_maker' : 'bot_checker' }));
            return reply({ handoffs: rows, next: state === 'empty' || url.searchParams.has('after') ? null : 'page2' });
          }
          if (url.pathname === '/api/handoffs/ho_fixture') return reply({ handoff: state === 'empty' ? null : { ...handoff, status: f.status }, events });
          if (/\/handoffs\/ho_fixture\/(cancel|approve|decline)$/.test(url.pathname)) { f.status = url.pathname.endsWith('cancel') ? 'cancelled' : url.pathname.endsWith('approve') ? 'queued' : 'declined'; return reply({ handoff: { ...handoff, status: f.status } }); }
          if (/\/outputs\/[^/]+\/parts\//.test(url.pathname)) return reply({ text: url.searchParams.get('offset') === '0' ? 'First body page. <script>window.injected = true</script>' : 'Last body page.', next: url.searchParams.get('offset') === '0' ? 8000 : null });
          if (url.pathname.startsWith('/api/outputs/')) return reply({ output: state === 'empty' ? null : url.pathname.endsWith('out_result') ? { ...f.output, id: 'out_result', title: 'Reviewed release note', summary: 'All requested changes are in the reviewed note.' } : f.output });
          throw new Error('Unstubbed API: ' + url.pathname);
        };
      }, { output, agents, handoff, link, events, state });
      await page.goto(`${server.base}/@fs${out}/index.html?view=${view}&state=${state}&theme=${theme}&source=${source}${room ? '&room=1' : ''}${global ? '&global=1' : ''}`);
      await page.locator('[data-layout="page"]').first().waitFor();
      if (view === 'sheet') await page.getByRole('button', { name: 'Open Send sheet', exact: true }).click();
      if (state !== 'loading') await page.waitForTimeout(220);
      await page.evaluate(() => document.fonts.ready);
      page.fixtureErrors = errors;
      return page;
    },
    async close() { await browser.close(); await server.close(); },
  };
}

export async function checkLayout(page) {
  const selector = await page.locator('dialog[open]').count() ? 'dialog[open]' : '#root';
  assert.deepEqual(await page.evaluate(inspectAlignment, { selector }), []);
  // Summary is intentionally expandable; labels and controls must remain complete.
  for (const label of await page.locator(`${selector} :is(button,a,label,h1,h2,.layout-row):visible`).all()) await readableWords(label);
  assert.deepEqual(page.fixtureErrors, []);
}

const require = createRequire(import.meta.url);
function axeFile() {
  if (process.env.HO_D_AXE_PATH) return path.resolve(process.env.HO_D_AXE_PATH);
  for (const location of ['axe-core/axe.min.js', '@axe-core/playwright/node_modules/axe-core/axe.min.js']) { try { return require.resolve(location); } catch {} }
  const local = path.resolve('.context/ho-d/axe.min.js');
  return fs.existsSync(local) ? local : null;
}
export async function checkAccessibility(page) {
  const axe = axeFile();
  if (axe) {
    await page.addScriptTag({ path: axe });
    const results = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(node => node.html) })));
    assert.deepEqual(results, [], 'axe WCAG A/AA');
    return 'axe';
  }
  // Spec 22 permits this fallback before UC-H supplies axe. Report it explicitly.
  const failures = await page.evaluate(() => [...document.querySelectorAll('button,input,textarea,select,a')].filter(element => element.checkVisibility() && !element.closest('[inert]')).flatMap(element => {
    const named = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.textContent.trim() || element.labels?.length;
    return named ? [] : [element.outerHTML];
  }));
  assert.deepEqual(failures, [], 'Accessible control names');
  return 'lightweight (axe unavailable)';
}
