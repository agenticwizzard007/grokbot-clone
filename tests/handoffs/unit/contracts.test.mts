import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import ts from 'typescript';
import path from 'node:path';
import { DDL, loopSpecSchema, submitOutputSchema, verdictSchema, flowSummarySchema } from '../../../server/src/handoffs/schema.js';
import { buildOutputContent, contentHash, extractLinks, parseReference, redactOutputText, summarizeOutput } from '../../../server/src/handoffs/output.js';
import { assertAutoLinkAcyclic, assertHandoffAllowed, checkChain } from '../../../server/src/handoffs/chain.js';
import { nextHandoffStatus, HANDOFF_EVENT_TYPES } from '../../../server/src/handoffs/events.js';
import { recomputeVerdict, detectStall, selectBestOutput } from '../../../server/src/handoffs/verdict.js';
import { canonicalJson } from '../../../server/src/flow/hash.js';
import { loopSpec, output, verdict } from './fixtures.mts';

test('DDL is repeatable, has eleven tables, all FK parents resolve and cascades enforce ownership', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  try {
    for (const parent of ['users', 'bots', 'agent_jobs', 'tasks', 'coordination_requests', 'output_artifacts']) db.exec(`CREATE TABLE ${parent}(id TEXT PRIMARY KEY)`);
    db.exec(DDL); db.exec(DDL);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name);
    assert.equal(tables.length, 17);
    for (const table of tables) for (const fk of db.pragma(`foreign_key_list(${table})`) as { table: string; to: string }[]) {
      assert.ok(tables.includes(fk.table), `${table}: missing ${fk.table}`);
      assert.ok((db.pragma(`table_info(${fk.table})`) as { name: string }[]).some(col => col.name === fk.to));
    }
    db.exec("INSERT INTO users VALUES('u'); INSERT INTO bots VALUES('b'); INSERT INTO agent_jobs VALUES('j')");
    const insert = db.prepare("INSERT INTO run_outputs(id,user_id,bot_id,job_id,source,status,title,summary,manifest,provenance,content_hash,created_at) VALUES(?,?,?,?,'run','final','Test','Test','[]','{}','hash',0)");
    insert.run('out_test', 'u', 'b', 'j'); assert.throws(() => insert.run('out_other', 'u', 'b', 'j'), /UNIQUE/); assert.throws(() => insert.run('out_bad', 'missing', 'b', null), /FOREIGN KEY/);
    db.exec("INSERT INTO run_output_parts VALUES('out_test','p_body','text','body','Placeholder','hash',0)");
    db.exec("DELETE FROM users WHERE id='u'"); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM run_output_parts').get() as { n: number }).n, 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});
test('strict schemas reject unknown fields, invalid JSON, size, links, malformed step shapes and caps', () => {
  assert.ok(submitOutputSchema.safeParse({ summary: 'Test', dataParts: [{ name: 'scores', json: { pass: true } }] }).success);
  for (const bad of [{ summary: 'x'.repeat(1201) }, { summary: 'Test', userId: 'other' }, { summary: 'Test', links: [{ url: 'http://example.test', title: 'Link', relation: 'source' }] }, { summary: 'Test', dataParts: [{ name: 'test', json: 'x'.repeat(262145) }] }, { summary: 'Test', dataParts: [{ name: 'test', json: undefined }] }]) assert.equal(submitOutputSchema.safeParse(bad).success, false);
  assert.equal(verdictSchema.safeParse({ ...verdict(), unknown: true }).success, false);
  assert.equal(verdictSchema.safeParse({ ...verdict(), checklist: [{ id: 'a', pass: true, note: '', unknown: true }] }).success, false);
  const spec = loopSpec(); assert.ok(loopSpecSchema.safeParse(spec).success);
  for (const bad of [{ ...spec, limits: { ...spec.limits, maxIterations: 11 } }, { ...spec, steps: [spec.steps[0]] }, { ...spec, steps: [spec.steps[0], spec.steps[0]] }, { ...spec, seed: { outputRef: 'https://example.test' } }]) assert.equal(loopSpecSchema.safeParse(bad).success, false);
  assert.equal(flowSummarySchema.safeParse({ steps: [{ label: 'x'.repeat(41) }] }).success, false);
});
test('refs enforce exact grammar, prefixes and safe page ranges', () => {
  assert.deepEqual(parseReference('swarm://output/out_test#p_body?o=10&l=20'), { kind: 'output', outputId: 'out_test', partId: 'p_body', offset: 10, limit: 20 });
  assert.deepEqual(parseReference('swarm://handoff/ho_test'), { kind: 'handoff', handoffId: 'ho_test' });
  for (const ref of ['https://output/out_test', 'swarm://output/out_a/../out_b', 'swarm://output/out_a#p_a?o=-1&l=5', 'swarm://output/out_a?o=0&l=8001', 'swarm://output/out_a?o=9007199254740992&l=2', 'swarm://output/out_a?o=1&l=0', 'swarm://handoff/ho_test#p_body']) assert.throws(() => parseReference(ref));
});
test('output summary honors short body and first paragraph, sentence boundaries and secret redaction', () => {
  assert.equal(summarizeOutput('Small.\n\nSecond paragraph.'), 'Small.\n\nSecond paragraph.');
  assert.equal(summarizeOutput('First paragraph.\n\n' + 'x'.repeat(1500)), 'First paragraph.');
  assert.equal(summarizeOutput('First sentence. ' + 'x'.repeat(1500)), 'First sentence.');
  assert.equal(summarizeOutput('x'.repeat(1500)).length, 1200);
  assert.doesNotMatch(redactOutputText('Bearer placeholder_secret_value api_key=placeholder_token password=test'), /placeholder_secret_value|placeholder_token|password=test/);
});
test('output preserves original capped body, reports truncation, extracts https links and content hashes ignore generated ids', () => {
  const content = buildOutputContent('x'.repeat(200001)); assert.equal(content.bodies.p_body.length, 200000); assert.ok(content.truncated);
  const links = extractLinks('[Brief](https://example.test/brief) https://example.test/brief https://example.test/result. http://example.test/unsafe');
  assert.deepEqual(links.map(l => [l.url, l.title]), [['https://example.test/brief', 'Brief'], ['https://example.test/result', 'example.test']]);
  assert.equal(extractLinks('https://user:password@example.test/file').length, 0);
  const a = buildOutputContent('Test body'); const b = a.parts.map(p => ({ ...p, id: 'p_new' }));
  assert.equal(contentHash(a.parts, a.bodies), contentHash(b, { p_new: a.bodies.p_body }));
  assert.notEqual(contentHash(a.parts, a.bodies), contentHash(a.parts, { p_body: 'Changed body' }));
  assert.equal(canonicalJson({ z: 1, a: { b: true, a: 2 } }), '{"a":{"a":2,"b":true},"z":1}');
});
test('verdict recomputes required checks, score zero is a real threshold and duplicate or missing answers fail', () => {
  const exit = { mode: 'checklist' as const, items: [{ id: 'required', text: 'Check', required: true }, { id: 'optional', text: 'Extra', required: false }], minScore: 0 };
  const claimed = { pass: true, score: 0, feedback: '', checklist: [{ id: 'required', pass: false, note: '' }] };
  assert.deepEqual(recomputeVerdict(claimed, exit), { ...claimed, pass: false, claimedPass: true, corrected: true });
  assert.equal(recomputeVerdict({ ...claimed, checklist: [{ id: 'required', pass: true, note: '' }] }, exit).pass, true);
  assert.equal(recomputeVerdict({ pass: true, feedback: '', checklist: [{ id: 'required', pass: true, note: '' }] }, exit).pass, false);
  assert.throws(() => recomputeVerdict(verdict(true), exit), /every required/);
  assert.throws(() => recomputeVerdict({ ...claimed, checklist: [...claimed.checklist, ...claimed.checklist] }, exit), /once/);
});
test('stall needs two identical outputs or three identical feedback hashes; flat scores only warn', () => {
  const rows = [1, 2, 3].map(iteration => ({ iteration, outputId: `out_${iteration}`, contentHash: String(iteration), feedbackHash: 'same', verdict: { ...verdict(), score: 0.5 } }));
  assert.equal(detectStall(rows.slice(0, 2)).stalled, false); assert.deepEqual(detectStall(rows), { stalled: true, scoreWarning: true });
  assert.deepEqual(detectStall(rows.map(r => ({ ...r, feedbackHash: String(r.iteration) }))), { stalled: false, scoreWarning: true });
  assert.equal(detectStall([rows[0], { ...rows[1], contentHash: '1' }]).stalled, true);
  assert.equal(detectStall([rows[0], { ...rows[2], contentHash: '1' }]).stalled, false);
});
test('best output counts required passes then latest iteration, independent of row order', () => {
  const exit = { mode: 'checklist' as const, items: [{ id: 'a', text: 'A', required: true }, { id: 'b', text: 'B', required: false }] };
  const rows = [1, 2, 3].map(iteration => ({ iteration, outputId: `out_${iteration}`, contentHash: '', feedbackHash: '', verdict: { ...verdict(), checklist: [{ id: 'a', pass: iteration < 3, note: '' }, { id: 'b', pass: true, note: '' }] } }));
  assert.equal(selectBestOutput(rows, exit)?.outputId, 'out_2'); assert.equal(selectBestOutput(rows.reverse(), exit)?.outputId, 'out_2'); assert.equal(selectBestOutput([], exit), null);
});
test('chain walks all provenance branches, refuses cycles, sixth hop and missing parents', () => {
  const rows = Array.from({ length: 6 }, (_, i) => output('Test', { id: `out_${i}`, botId: `bot_${i}` }));
  rows.forEach((row, i) => { row.provenance = { ...row.provenance, consumed: i ? [rows[i - 1].id] : [] }; });
  assert.equal(checkChain(rows[4], 'bot_next', rows).length, 5);
  assert.throws(() => checkChain(rows[5], 'bot_next', rows), /too long/); assert.throws(() => checkChain(rows[3], 'bot_0', rows), /back/);
  assert.throws(() => checkChain(rows[2], 'bot_next', []), /not found/); assert.deepEqual(checkChain(rows[5], 'bot_0', rows, true), []);
  rows[0].provenance.consumed = [rows[2].id]; assert.throws(() => checkChain(rows[2], 'bot_next', rows), /back/);
});
test('auto links reject cycles but suggestions do not', () => {
  const links = [{ fromBotId: 'a', toBotId: 'b', mode: 'auto' as const }, { fromBotId: 'b', toBotId: 'a', mode: 'auto' as const }];
  assert.throws(() => assertAutoLinkAcyclic(links), /cycle/); assertAutoLinkAcyclic([links[0], { ...links[1], mode: 'suggest' }]);
});
test('policy matrix rejects foreign, room, setup, hidden, self, disabled and rate limited targets', () => {
  const base = { userId: 'user_test', fromBotId: 'bot_maker', target: { id: 'bot_checker', userId: 'user_test' }, settings: { enabled: true, agentHandoffs: 'team' as const }, links: [], initiatedBy: 'agent' as const };
  assertHandoffAllowed(base);
  for (const target of [{ ...base.target, userId: 'other' }, { ...base.target, kind: 'room' }, { ...base.target, hidden: true }, { ...base.target, isConfiguring: true }, { ...base.target, id: 'bot_maker' }, { ...base.target, active: false }]) assert.throws(() => assertHandoffAllowed({ ...base, target }));
  assertHandoffAllowed({ ...base, target: { ...base.target, hidden: true, helperOfBotId: 'bot_maker' } });
  for (const overrides of [{ settings: { ...base.settings, enabled: false } }, { settings: { ...base.settings, agentHandoffs: 'off' as const } }, { settings: { ...base.settings, agentHandoffs: 'links_only' as const } }, { botHourlyCount: 20 }, { userDailyCount: 100 }, { inLoop: true }]) assert.throws(() => assertHandoffAllowed({ ...base, ...overrides }));
});
test('handoff statuses are monotonic and terminal observations are absorbing', () => {
  assert.equal(nextHandoffStatus('queued', 'delivered'), 'delivered'); assert.equal(nextHandoffStatus('running', 'queued'), 'running'); assert.equal(nextHandoffStatus('completed', 'running'), 'completed');
  assert.equal(new Set(HANDOFF_EVENT_TYPES).size, 27);
});
test('web compiler resolves @shared/handoffs and @shared/flow contracts and browser-safe layout imports', () => {
  const config = ts.readConfigFile('web/tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.resolve('web'));
  const virtual = path.resolve('web/src/__ho_a_contract_check.ts');
  const source = `import type { RunOutput, LoopSpec, Verdict, HandoffService, FlowStore, FlowModel } from '@shared/handoffs/index';\nimport { layoutFlow } from '@shared/flow/layout';\nimport { layoutRunGraph } from '@shared/handoffs/graph-layout';\nimport type { ServerEvent, RowKind } from '@shared/types';\nexport type Contracts = [RunOutput, LoopSpec, Verdict, HandoffService, FlowStore, FlowModel];\nexport const row: RowKind = 'handoff';\nexport const event: ServerEvent = { type: 'loop', id: 'lp_test', status: 'running', iteration: 1 };\nexport { layoutFlow, layoutRunGraph };`;
  const host = ts.createCompilerHost(parsed.options), read = host.readFile.bind(host), exists = host.fileExists.bind(host), get = host.getSourceFile.bind(host);
  host.readFile = name => name === virtual ? source : read(name); host.fileExists = name => name === virtual || exists(name);
  host.getSourceFile = (name, version, onError, create) => name === virtual ? ts.createSourceFile(name, source, version, true) : get(name, version, onError, create);
  host.getCurrentDirectory = () => path.resolve('web');
  const program = ts.createProgram([virtual], { ...parsed.options, configFilePath: path.resolve('web/tsconfig.json'), noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
});
