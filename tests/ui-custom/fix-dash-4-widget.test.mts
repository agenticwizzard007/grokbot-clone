import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentFixture } from './agent-fixture.mjs';
import { widgetProviderReplay } from './fix-dash-4-provider.mjs';

// E2E: authenticated real run route -> WidgetService -> runAgentWidget ->
// llmClient -> real codex/claude Responses adapter -> local companion RPC replay.
const server = await agentFixture();
after(() => server.close());
const user = server.fixture.userId;
server.db.prepare('INSERT INTO account_preferences(user_id,updated_at,ui_widget_cost_cap_usd) VALUES(?,?,100) ON CONFLICT(user_id) DO UPDATE SET ui_widget_cost_cap_usd=100').run(user, Date.now());
let config = (await server.request('GET', '/ui/config')).body;
const saved = await server.request('PATCH', '/ui/config', [{op:'add',path:'/dashboards/-',value:{id:'$new1',name:'Daily summary',icon:'layout-dashboard',widgets:[{id:'$new2',type:'agent',title:'Ask your agent',span:12,rows:3,options:{botId:server.fixture.bot.id,prompt:'Say hi in five words.',display:'text',schedule:'manual'}}]}}], config.revision);
assert.equal(saved.status, 200, JSON.stringify(saved));
config = (await server.request('GET', '/ui/config')).body;
const dashboard = config.doc.dashboards.at(-1), widget = dashboard.widgets[0];
const path = `/ui/widgets/${dashboard.id}/${widget.id}`;
const answer = async () => {
  for (let i = 0; i < 300; i++) {
    const snapshot = (await server.request('GET', `${path}/result`)).body;
    if (snapshot.state !== 'running') return snapshot;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Run did not finish');
};
for (const provider of ['codex', 'claude']) test(`E2E real widget route and ${provider} adapter with companion result replay`, async t => {
  const replay = await widgetProviderReplay({ ...server, provider });
  try {
    for (const [name, text, expected] of [
      ['plain sentence without source or usage', 'Hello there, nice to meet you.', { kind: 'text', text: 'Hello there, nice to meet you.' }],
      ['fenced JSON', '```json\n{"kind":"text","text":"Daily summary is ready."}\n```', { kind:'text', text:'Daily summary is ready.' }],
      ['surrounded JSON', 'Here is your answer:\n{"kind":"stat","value":"3","label":"Tasks"}\nAll set.', {kind:'stat',value:'3',label:'Tasks'}],
      ['strict typed JSON', '{"kind":"list","rows":[{"title":"Draft the launch email"}]}', {kind:'list',rows:[{title:'Draft the launch email'}]}],
      ['empty output', '', 'Your model returned no answer. Try again.'],
      ['invalid typed output', '{"kind":"text","text":"<script>"}', 'The answer format was invalid. Try again.'],
    ]) await t.test(name as string, async () => {
      replay.set({ text, delayMs: 10 });
      const run = await server.request('POST', `${path}/run`, {});
      assert.equal(run.status, 202); assert.equal(run.body.state, 'running');
      const result = await answer();
      if (typeof expected === 'string') { assert.equal(result.state, 'error'); assert.equal(result.error, expected); }
      else { assert.equal(result.state, 'ready', JSON.stringify(result)); assert.deepEqual(result.doc, expected); }
    });
    for (const [error, message] of [['CLI generation timed out', 'The answer took too long. Try again.'], ['CLI is offline', 'Your model is unavailable. Check Models & access in Settings.'], ['Insufficient credits', 'Your account usage limit has been reached.']]) await t.test(error, async () => {
      replay.set({ error, delayMs: 10 });
      assert.equal((await server.request('POST', `${path}/run`, {})).status, 202);
      assert.equal((await answer()).error, message);
    });
    assert.ok(replay.requests.every(request => request.params.timeoutMs === 120_000), 'CLI cold starts have a bounded 120 second deadline');
    assert.ok(server.db.prepare("SELECT COUNT(*) n FROM usage_events WHERE user_id=? AND usage_status='unavailable' AND key_kind='subscription'").get(user).n >= 4);
    const failures = server.logs.join('').split('\n').filter(line => line.startsWith('{"event":"ui_widget_failure"')).map(line => JSON.parse(line));
    assert.ok(failures.some(entry => entry.provider === `${provider}-cli` && entry.reason === 'empty' && entry.widgetId === widget.id));
    assert.ok(failures.every(entry => entry.userIdHash && !JSON.stringify(entry).includes(user)));
  } finally { await replay.close(); }
});
