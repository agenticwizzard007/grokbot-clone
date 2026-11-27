import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { agentFixture } from './agent-fixture.mjs';
const output = path.resolve('.context/ui-custom/demo-c'); fs.mkdirSync(output, { recursive: true });
const server = await agentFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const transcript = [], screenshots = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${server.base}/#bot/${server.fixture.bot.id}`);
  const wait = async condition => { for (let i = 0; i < 300; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Timed out: ${server.logs.join('')}`); };
  const scenarios = [
    { name: 'theme', intent: 'Dark mode with a teal accent', patch: [{ op: 'replace', path: '/theme/mode', value: 'dark' }, { op: 'add', path: '/theme/colors/dark/primary', value: '#2DD4BF' }, { op: 'add', path: '/theme/colors/light/primary', value: '#0F766E' }] },
    { name: 'dashboard', intent: 'Add My week with 5 widgets', patch: [
      { op: 'add', path: '/dashboards/-', value: { id: '$new1', name: 'My week', icon: 'layout-dashboard', widgets: [
        { id: '$new2', type: 'stat', title: 'Needs you', span: 4, rows: 1, source: { id: 'needsYou.list', params: {} }, options: { field: 'count', format: 'number' } },
        { id: '$new3', type: 'stat', title: 'Spent this week', span: 4, rows: 1, source: { id: 'usage.summary', params: { range: '7d' } }, options: { field: 'costUsd', format: 'usd' } },
        { id: '$new4', type: 'stat', title: 'Working now', span: 4, rows: 1, source: { id: 'tasks.counts', params: {} }, options: { field: 'working', format: 'number' } },
        { id: '$new5', type: 'list', title: 'Open tasks', span: 6, rows: 3, source: { id: 'tasks.list', params: { state: 'needs_input', limit: 10 } }, options: { limit: 5 } },
        { id: '$new6', type: 'chart', title: 'Cost by day', span: 6, rows: 3, source: { id: 'usage.series', params: { range: '7d', metric: 'cost' } }, options: { kind: 'bar' } },
      ] } }, { op: 'add', path: '/layout/pinned/-', value: { type: 'dashboard', id: '$new1' } },
    ] },
  ];
  for (const scenario of scenarios) {
    const before = (await server.request('GET', '/ui/config')).body.revision;
    const text = `mock: preview_ui_patch ${JSON.stringify({ intent: scenario.intent, patch: scenario.patch, autofix: true })} | say Previewing ${scenario.name}. Press Apply to keep it.`;
    const sent = await server.request('POST', `/bots/${server.fixture.bot.id}/messages`, { text }); assert.equal(sent.status, 200, JSON.stringify(sent));
    const findCard = () => server.db.prepare("SELECT seq,body FROM rows WHERE bot_id=? AND kind='card' AND json_extract(body,'$.card')='ui_preview' AND json_extract(body,'$.title')=? ORDER BY seq DESC LIMIT 1").get(server.fixture.bot.id, scenario.intent);
    await wait(findCard);
    const row = findCard(), card = JSON.parse(row.body);
    const toolCalls = server.db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='tool-call' AND seq<? ORDER BY seq DESC LIMIT 1").all(server.fixture.bot.id, row.seq).map(r => JSON.parse(r.body));
    await wait(() => server.db.prepare("SELECT state FROM agent_jobs WHERE id=?").get(card.jobId)?.state === 'completed');
    const modelRequests = await fetch(`${server.model}/_requests`).then(r => r.json());
    const requests = Array.isArray(modelRequests) ? modelRequests : modelRequests.requests;
    const toolResults = requests.flatMap(request => request.body?.input ?? []).filter(item => item.type === 'function_call_output');
    assert.ok(toolResults.some(result => String(result.output).includes(card.previewId)), 'Model received compact preview result');
    assert.equal(card.status, 'pending'); assert.ok(card.lines.length <= 6);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(250);
      const screenshot = path.join(output, `${scenario.name}-pending-${width}.png`); await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
    }
    const applied = await server.request('POST', `/ui/previews/${card.previewId}/apply`, {}, before);
    assert.equal(applied.status, 200, JSON.stringify(applied)); assert.equal(applied.body.revision, before + 1);
    await wait(() => JSON.parse(findCard().body).status === 'applied');
    const entry = { scenario: scenario.name, text, toolCalls, toolResults, card: JSON.parse(findCard().body), revision: applied.body.revision };
    transcript.push(entry); console.log(JSON.stringify(entry, null, 2));
    await page.reload();
    const saved = (await server.request('GET', '/ui/config')).body;
    assert.equal(saved.revision, before + 1);
    if (scenario.name === 'theme') assert.equal(saved.doc.theme.mode, 'dark');
    else assert.equal(saved.doc.dashboards[0].widgets.length, 5);
    const screenshot = path.join(output, `${scenario.name}-applied-390.png`); await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
  }
  fs.writeFileSync(path.join(output, 'transcript.json'), JSON.stringify({ transcript, screenshots }, null, 2));
  console.log(`Demo C: 2/2 scenarios passed; 2 previews, 2 card updates, revision 2; output ${output}`);
} finally { await browser.close(); fs.writeFileSync(path.join(output, 'server.log'), server.logs.join('')); await server.close(); }
