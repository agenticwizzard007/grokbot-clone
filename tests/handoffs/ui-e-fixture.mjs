import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { layoutServer } from '../layout-fixture.mjs';

export const bots = [{ id: 'bot_maker', name: 'Draft agent' }, { id: 'bot_checker', name: 'Review agent' }, { id: 'bot_judge', name: 'Judge agent' }, { id: 'bot_room', name: 'Test room', kind: 'room' }, { id: 'bot_setup', name: 'Setup agent', onboarding: { status: 'interviewing' } }, { id: 'bot_hidden', name: 'Hidden agent', hidden: true }];
export const goal = 'Write a release note with a version, benefits, migration steps, a link and a call to action.';
export const baseSpec = {
  name: 'Release note review', goal, kind: 'maker_checker',
  steps: [{ id: 'maker', botId: 'bot_maker', role: 'maker', instruction: 'Draft a release note and fix the feedback.' }, { id: 'checker', botId: 'bot_checker', role: 'checker', instruction: 'Check each required item.' }],
  seed: { text: 'Prepare the placeholder release note for version 2.' },
  exit: { mode: 'checklist', items: ['Version', 'Benefits', 'Migration steps', 'Link', 'Call to action'].map((text, n) => ({ id: `check${n}`, text, required: true })) },
  limits: { maxIterations: 4, maxMinutes: 30, stepTimeoutMinutes: 10 }, gate: { before: 'none', onCap: 'ask' },
};
const start = Date.UTC(2026, 10, 27, 10);
export const scenarios = {
  converged: ['succeeded', 'passed', 3], capped: ['capped', 'max_iterations', 4], stalled: ['stalled', 'stalled', 4],
  failed: ['failed', 'step_failed', 1], gated: ['awaiting_approval', null, 0], paused: ['paused', null, 2],
  running: ['running', null, 2], budget: ['capped', 'max_cost', 2], stopped: ['cancelled', 'user_stopped', 2],
  noverdict: ['failed', 'no_verdict', 1], declined: ['cancelled', 'declined', 0], expired: ['cancelled', 'gate_expired', 0],
};
export function recordedRun(name = 'converged') {
  const [status, stopReason, count] = scenarios[name];
  const spec = structuredClone(baseSpec), steps = [], verdicts = [], events = [];
  const loop = { id: `lp_${name}`, userId: 'usr_fixture', ownerBotId: 'bot_maker', spec, status, stopReason, iteration: count, bestOutputId: count ? `out_${name}_${count}` : null, initiatedBy: name === 'gated' ? 'agent' : 'user', idempotencyKey: `fixture-${name}`, revision: 1, startedAt: start, finishedAt: stopReason ? start + count * 60000 : null, createdAt: start, updatedAt: start + count * 60000 };
  const add = (type, data = {}) => events.push({ seq: events.length + 1, type, createdAt: start + events.length * 1000, data });
  add('loop.created'); add(name === 'gated' ? 'loop.approval_requested' : 'loop.started', { iteration: name === 'gated' ? 1 : 0 });
  for (let iteration = 1; iteration <= count; iteration++) {
    for (const [index, bot] of bots.slice(0, 2).entries()) {
      const active = name === 'running' && iteration === count && index === 1;
      const failed = name === 'failed' && index === 1;
      const outputId = index === 0 ? `out_${name}_${iteration}` : `out_${name}_feedback_${iteration}`;
      const run = { id: `run_${name}_${iteration}_${index}`, stepId: index ? 'checker' : 'maker', botId: bot.id, botName: bot.name, role: index ? 'checker' : 'maker', iteration, status: active ? 'running' : failed ? 'failed' : 'completed', outputId: active || failed ? null : outputId, outputTitle: index ? 'feedback' : `Draft v${iteration}`, startedAt: start + (iteration - 1) * 60000 + index * 20000, finishedAt: active ? null : start + (iteration - 1) * 60000 + (index + 1) * 20000, inputs: index ? [{ id: `out_${name}_${iteration}`, title: `Draft v${iteration}` }] : iteration > 1 ? [{ id: `out_${name}_${iteration - 1}`, title: `Draft v${iteration - 1}` }, { id: `out_${name}_feedback_${iteration - 1}`, title: 'feedback' }] : [] };
      steps.push(run); add('loop.step_dispatched', { iteration, stepId: run.stepId, runId: run.id, botId: run.botId });
      if (!active) add(failed ? 'loop.step_failed' : 'loop.step_completed', { iteration, stepId: run.stepId, runId: run.id, outputId: run.outputId });
    }
    if (!(name === 'failed' || name === 'noverdict' || (name === 'running' && iteration === count))) {
      const pass = name === 'converged' && iteration === 3;
      const passing = pass ? 5 : Math.min(iteration, 3);
      verdicts.push({ iteration, pass, score: passing / 5, checklist: spec.exit.items.map((item, n) => ({ id: item.id, pass: n < passing, note: n < passing ? `${item.text} is present.` : `Add ${item.text.toLowerCase()}.` })), feedback: pass ? 'All required checks passed.' : 'Keep what passed. Add the missing required items before the next review.' });
      add('loop.verdict', { iteration, pass, passing, total: 5 });
    }
  }
  if (name === 'paused') add('loop.paused', { iteration: count });
  if (stopReason) add('loop.finished', { iteration: count, stopReason, status });
  const detail = { loop, steps, verdicts, bestOutput: count ? { id: loop.bestOutputId, title: `Draft v${count}` } : null, usage: { tracked: name !== 'paused', costUsd: count * 0.02, tokens: count * 1000 }, canExtend: name === 'capped', ...(name === 'gated' ? { gate: { kind: 'first', iteration: 1, expiresAt: start + 86400000 } } : {}) };
  return { detail, events };
}

export async function loopFixture({ output = '.context/handoffs/ui-e' } = {}) {
  const { loopSpecSchema } = await tsImport('../../server/src/handoffs/schema.ts', import.meta.url);
  const out = path.resolve(output); fs.mkdirSync(out, { recursive: true });
  const state = { runs: Object.fromEntries(Object.keys(scenarios).map(name => [`lp_${name}`, recordedRun(name)])), calls: [], failures: {}, listEmpty: false, delay: 0, streams: new Set(), eventPageSize: 200 };
  let seeded;
  const mock = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', seeded?.base ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 100\ndata: {"type":"hello"}\n\n'); state.streams.add(res); req.on('close', () => state.streams.delete(res)); return;
    }
    state.calls.push({ method: req.method, path: url.pathname, search: url.search });
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    const failure = state.failures[url.pathname];
    if (failure) { state.failures[url.pathname]--; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Fixture unavailable. Try again.', code: 'fixture_error' })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/bots') return json({ bots });
    if (url.pathname === '/api/tasks') return json({ tasks: [{ id: 'task_fixture', title: 'Prepare the release note' }] });
    if (url.pathname === '/api/loops' && req.method === 'GET') return json({ loops: state.listEmpty ? [] : Object.values(state.runs).map(run => run.detail.loop), next: null });
    if (url.pathname === '/api/loops' && req.method === 'POST') {
      state.calls.at(-1).body = input;
      const validated = loopSpecSchema.safeParse(input.spec);
      if (!validated.success) { res.writeHead(400); return json({ error: validated.error.issues.map(issue => issue.message).join('; '), code: 'invalid_spec' }); }
      const prior = Object.values(state.runs).find(run => run.detail.loop.idempotencyKey === input.idempotencyKey);
      if (prior) return json({ loop: prior.detail.loop });
      const run = recordedRun('running'); run.detail.loop.id = 'lp_created'; run.detail.loop.spec = input.spec; run.detail.loop.idempotencyKey = input.idempotencyKey;
      state.runs.lp_created = run; return json({ loop: run.detail.loop });
    }
    const match = url.pathname.match(/^\/api\/loops\/([^/]+)(?:\/(\w+))?$/);
    const run = match && state.runs[decodeURIComponent(match[1])];
    if (!run) { res.writeHead(404); return json({ error: 'Not found' }); }
    const action = match[2];
    if (action === 'events') {
      const after = Number(url.searchParams.get('after') || 0), limit = Math.min(state.eventPageSize, Number(url.searchParams.get('limit') || 200));
      const remaining = run.events.filter(event => event.seq > after), events = remaining.slice(0, limit);
      return json({ events, next: remaining.length > events.length ? events.at(-1).seq : null });
    }
    if (req.method === 'POST') {
      const loop = run.detail.loop;
      loop.revision++;
      if (action === 'pause') loop.status = 'paused';
      if (['resume', 'start', 'approve', 'extend'].includes(action)) { loop.status = 'running'; loop.stopReason = null; delete run.detail.gate; }
      if (action === 'extend') { loop.spec.limits.maxIterations += 2; run.detail.canExtend = false; }
      if (['stop', 'decline'].includes(action)) { loop.status = 'cancelled'; loop.stopReason = action === 'stop' ? 'user_stopped' : 'declined'; }
      run.events.push({ seq: (run.events.at(-1)?.seq ?? 0) + 1, type: `loop.${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : action === 'extend' ? 'extended' : action === 'stop' ? 'finished' : 'approved'}`, createdAt: start + 999999, data: { iteration: loop.iteration } });
      broadcast(loop.id); return json({ loop });
    }
    return json(run.detail);
  });
  const broadcast = id => { for (const response of state.streams) response.write(`data: ${JSON.stringify({ type: 'loop', id, status: state.runs[id].detail.loop.status, iteration: state.runs[id].detail.loop.iteration })}\n\n`); };
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  try { seeded = await layoutServer(); } catch (error) { mock.close(); throw error; }
  const source = file => path.resolve(file);
  fs.writeFileSync(path.join(out, 'harness.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loops fixture</title></head><body><main id="root"></main><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import("./harness.tsx");</script></body></html>');
  fs.writeFileSync(path.join(out, 'harness.tsx'), `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LoopsPage } from '${source('web/src/handoffs/loops/LoopsPage.tsx')}';
import { LoopRun } from '${source('web/src/handoffs/loops/LoopRun.tsx')}';
import { LoopFields, newLoopSpec } from '${source('web/src/handoffs/loops/LoopSheet.tsx')}';
import { useStore } from '${source('web/src/store.ts')}';
import '${source('web/src/styles/tokens.css')}';
import '${source('web/src/styles/base.css')}';
import '${source('web/src/styles/modals.css')}';
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'light';
const events = new EventSource('${mockBase}/events', { withCredentials: true });
events.onopen = () => useStore.getState().set({ sseConnected: true });
events.onerror = () => useStore.getState().set({ sseConnected: false });
events.onmessage = event => window.dispatchEvent(new CustomEvent('swarm:event', { detail: JSON.parse(event.data) }));
function App() {
 const [hash, setHash] = useState(location.hash), [fields, setFields] = useState(newLoopSpec('bot_maker', 'bot_checker'));
 useEffect(() => { const changed = () => setHash(location.hash); addEventListener('hashchange', changed); return () => removeEventListener('hashchange', changed); }, []);
 return hash === '#fields' ? <div className="layout-page" data-layout="page"><h1>Keep improving</h1><LoopFields compact value={fields} onChange={setFields} bots={${JSON.stringify(bots)}} usageTracked={false} /><output data-testid="fields-value">{JSON.stringify(fields)}</output></div> : hash.startsWith('#loop/') ? <LoopRun key={hash} id={decodeURIComponent(hash.slice(6))} /> : <LoopsPage usageTracked={new URLSearchParams(location.search).get('tracked') !== 'no'} />;
}
createRoot(document.getElementById('root')).render(<App />);
`);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  return {
    state, out, browser, base: seeded.base,
    broadcast,
    disconnect() { for (const response of state.streams) response.end(); },
    reset() { state.runs = Object.fromEntries(Object.keys(scenarios).map(name => [`lp_${name}`, recordedRun(name)])); state.calls = []; state.failures = {}; state.listEmpty = false; state.delay = 0; state.eventPageSize = 200; },
    async page(width = 390, theme = 'light') {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
      const errors = [];
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
        if (url.pathname.startsWith('/api/loops') || url.pathname === '/api/bots' || url.pathname === '/api/tasks') {
          const response = await fetch(mockBase + url.pathname + url.search, { method: route.request().method(), headers: { 'Content-Type': 'application/json' }, body: route.request().postData() || undefined });
          return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
        }
        return route.continue();
      });
      return { page, errors, async open(hash = '#loops', query = '') { await page.goto('about:blank'); await page.goto(`${seeded.base}/@fs${out}/harness.html?theme=${theme}${query}${hash}`); await page.getByRole('heading', { level: 1 }).waitFor(); }, async close() { assert.deepEqual(errors, [], 'No browser exceptions'); await context.close(); } };
    },
    async close() { await browser.close(); for (const response of state.streams) response.end(); await new Promise(resolve => mock.close(resolve)); await seeded.close(); },
  };
}
