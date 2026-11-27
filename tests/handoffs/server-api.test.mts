import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fixture, output, outputs, handoffs, loops, links, makeLoop, app, db, requests, finish, flush, reconcile, hdb, hub, jobs, spec, cleanup } from './server-fixture.test.mts';
after(cleanup);
const call = (f: any, path: string, method = 'GET', data?: unknown) => app.request(`/api${path}`, { method, headers: f.headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
test('handoff transport returns exactly one structured result and ordered status transitions', async () => {
    const f = fixture(), o = output(f), input = { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Review the fixture.', idempotencyKey: 'first' };
    const response = await call(f, '/handoffs', 'POST', input);
    assert.equal(response.status, 201);
    const h: any = await response.json();
    assert.equal((await call(f, '/handoffs', 'POST', input)).status, 200);
    assert.equal((await call(f, '/handoffs', 'POST', { ...input, instruction: 'Different.' })).status, 409);
    await flush(f);
    const admitted = handoffs.getHandoff(f.userId, h.id);
    assert.equal(admitted.status, 'delivered');
    finish(f, admitted.jobId!, 'Reviewed fixture.');
    await flush(f);
    const completed = handoffs.getHandoff(f.userId, h.id);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.resultOutputId);
    const returns = db.prepare("SELECT * FROM coordination_requests WHERE user_id=? AND kind='result'").all(f.userId) as any[];
    assert.equal(returns.length, 1);
    assert.equal(returns[0].parent_request_id, h.requestId);
    assert.match(returns[0].text, /Result of your handoff/);
    assert.match(returns[0].text, /swarm:\/\/output\//);
    const result = outputs.getOutput(f.userId, completed.resultOutputId!);
    assert.deepEqual(result.provenance.consumed, [o.id]);
    assert.equal(result.provenance.handoffId, h.id);
    reconcile.recoverHandoffs();
    assert.equal((db.prepare("SELECT count(*) n FROM coordination_requests WHERE user_id=? AND kind='result'").get(f.userId) as any).n, 1);
    assert.deepEqual(hdb.events(f.userId, { handoffId: h.id }).filter(e => e.type.startsWith('handoff.')).map(e => e.type), ['handoff.created', 'handoff.delivered', 'handoff.running', 'handoff.completed']);
});
test('every resource route refuses foreign ids with the same 404 and no writes', async () => {
    const a = fixture(), b = fixture(), o = output(a), l = makeLoop(a, {}, false), h = handoffs.createHandoff(a.userId, { source: { outputId: o.id }, toBotId: a.checker.id, instruction: 'Fixture.', idempotencyKey: 'matrix' }).handoff;
    const paths = [`/outputs/${o.id}`, `/outputs/by-job/${o.jobId}`, `/outputs/${o.id}/parts/p_body`, `/outputs?botId=${a.maker.id}`, `/handoffs/${h.id}`, `/handoffs?botId=${a.maker.id}`, `/handoff-links?botId=${a.maker.id}`, `/loops/${l.id}`, `/loops/${l.id}/events`];
    for (const p of paths) {
        const r = await call(b, p);
        assert.equal(r.status, 404, p);
        assert.deepEqual(await r.json(), { error: 'Not found.', code: 'not_found' }, p);
    }
    for (const action of ['approve', 'decline', 'cancel'])
        assert.equal((await call(b, `/handoffs/${h.id}/${action}`, 'POST', {})).status, 404);
    for (const action of ['start', 'pause', 'resume', 'stop', 'approve', 'decline', 'extend', 'done'])
        assert.equal((await call(b, `/loops/${l.id}/${action}`, 'POST', {})).status, 404);
    assert.equal((await call(b, '/handoffs', 'POST', { source: { outputId: o.id }, toBotId: b.checker.id, instruction: 'Fixture.', idempotencyKey: 'foreign' })).status, 404);
    assert.equal((await call(b, '/outputs/from-message', 'POST', { botId: a.maker.id, generation: 1, seq: 1 })).status, 404);
    assert.equal((await call(b, `/handoff-links?botId=${a.maker.id}`, 'PUT', { links: [] })).status, 404);
    assert.equal((await call(b, '/loops', 'POST', { spec: spec(a), idempotencyKey: 'foreign-loop' })).status, 404);
    for (const p of ['/outputs', '/handoffs', '/loops']) {
        const r = await call(b, p);
        assert.equal(r.status, 200);
        assert.ok(!JSON.stringify(await r.json()).includes(a.userId));
    }
    assert.equal((await app.request('/api/loops')).status, 401);
});
test('target matrix, chain cycles, policy and agent rate limits are enforced', () => {
    const f = fixture(), foreign = fixture(), o = output(f);
    const send = (toBotId: string, key: string, agent = false) => handoffs.createHandoff(f.userId, { source: { outputId: o.id }, toBotId, instruction: 'Fixture.', idempotencyKey: key }, agent ? 'agent' : 'user');
    assert.throws(() => send(foreign.checker.id, 'foreign'), (e: any) => e.status === 404);
    assert.throws(() => send(f.maker.id, 'self'), (e: any) => e.code === 'cycle_detected');
    db.prepare("UPDATE bots SET kind='room' WHERE id=?").run(f.checker.id);
    assert.throws(() => send(f.checker.id, 'room'), (e: any) => e.code === 'target_not_allowed');
    db.prepare("UPDATE bots SET kind='agent',hidden=1 WHERE id=?").run(f.checker.id);
    assert.throws(() => send(f.checker.id, 'hidden'), (e: any) => e.code === 'target_not_allowed');
    db.prepare('UPDATE bots SET hidden=0 WHERE id=?').run(f.checker.id);
    db.prepare("UPDATE bot_setups SET onboarding_status='interview' WHERE bot_id=?").run(f.checker.id);
    assert.throws(() => send(f.checker.id, 'configuring'), (e: any) => e.code === 'target_not_allowed');
    db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(f.checker.id);
    links.updateSettings(f.userId, { enabled: true, agentHandoffs: 'off' });
    assert.throws(() => send(f.checker.id, 'off', true), (e: any) => e.code === 'policy_denied');
    links.updateSettings(f.userId, { enabled: true, agentHandoffs: 'links_only' });
    assert.throws(() => send(f.checker.id, 'links', true), /restricted/);
    links.replaceLinks(f.userId, f.maker.id, [{ toBotId: f.checker.id, mode: 'suggest' }]);
    for (let i = 0; i < 20; i++)
        send(f.checker.id, `rate-${i}`, true);
    assert.throws(() => send(f.checker.id, 'limit', true), (e: any) => e.status === 429);
});
test('automatic link cycles are rejected and replacing links is atomic', () => {
    const f = fixture();
    links.replaceLinks(f.userId, f.maker.id, [{ toBotId: f.checker.id, mode: 'auto' }]);
    assert.throws(() => links.replaceLinks(f.userId, f.checker.id, [{ toBotId: f.maker.id, mode: 'auto' }]), /cycle/);
    assert.equal(links.listLinks(f.userId, f.checker.id).length, 0);
    links.replaceLinks(f.userId, f.checker.id, [{ toBotId: f.maker.id, mode: 'suggest' }]);
    assert.equal(links.listLinks(f.userId, f.checker.id).length, 1);
});
test('agent loops require a first gate unless the exact pair is approved', () => {
    const f = fixture(), s = spec(f);
    const l = loops.createLoop(f.userId, { spec: s, idempotencyKey: 'agent', start: true }, 'agent', f.maker.id).loop;
    assert.equal(l.status, 'awaiting_approval');
    assert.equal(loops.loopSteps(f.userId, l.id).length, 0);
    links.replaceLinks(f.userId, f.maker.id, [{ toBotId: f.checker.id, mode: 'suggest', autoApproveLoops: true }]);
    assert.equal(loops.createLoop(f.userId, { spec: s, idempotencyKey: 'approved-agent', start: true }, 'agent', f.maker.id).loop.status, 'running');
});
test('kill switch covers every API path without reads or mutations', async () => {
    const f = fixture(), o = output(f), l = makeLoop(f, {}, false), h = handoffs.createHandoff(f.userId, { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Fixture.', idempotencyKey: 'kill' }).handoff;
    process.env.HANDOFFS_DISABLED = '1';
    try {
        for (const p of ['/outputs', `/outputs/${o.id}`, `/outputs/by-job/${o.jobId}`, `/outputs/${o.id}/parts/p_body`, '/handoffs', `/handoffs/${h.id}`, `/handoff-links?botId=${f.maker.id}`, '/handoff-settings', '/loops', `/loops/${l.id}`, `/loops/${l.id}/events`])
            assert.equal((await call(f, p)).status, 503, p);
        for (const p of ['/outputs/from-message', '/handoffs', '/loops', `/handoffs/${h.id}/cancel`, `/handoffs/${h.id}/approve`, `/handoffs/${h.id}/decline`, ...['start', 'pause', 'resume', 'stop', 'approve', 'decline', 'extend', 'done'].map(a => `/loops/${l.id}/${a}`)])
            assert.equal((await call(f, p, 'POST', {})).status, 503, p);
        assert.equal((await call(f, '/handoff-settings', 'PUT', {})).status, 503);
        assert.equal((await call(f, `/handoff-links?botId=${f.maker.id}`, 'PUT', {})).status, 503);
    }
    finally {
        delete process.env.HANDOFFS_DISABLED;
    }
});
test('strict body and query validation, pagination and payload limits', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++)
        output(f, `Page ${i}.`);
    const r: any = await (await call(f, '/outputs?limit=2')).json();
    assert.equal(r.outputs.length, 2);
    assert.ok(r.next);
    const next: any = await (await call(f, `/outputs?limit=2&after=${r.next}`)).json();
    assert.equal(next.outputs.length, 1);
    assert.ok(!r.outputs.some((o: any) => o.id === next.outputs[0].id));
    assert.equal((await call(f, '/loops', 'POST', { spec: spec(f), idempotencyKey: 'strict', userId: 'forged' })).status, 400);
    assert.equal((await call(f, '/outputs?limit=51')).status, 400);
    assert.equal((await call(f, '/outputs?after=bad')).status, 400);
    assert.equal((await call(f, '/handoffs', 'POST', { instruction: 'x'.repeat(300000) })).status, 413);
});
test('handoff and loop SSE events observe committed rows and no rolled back records', async () => {
    const f = fixture(), o = output(f), seen: string[] = [];
    const off = hub.subscribe(f.userId, e => {
        if (e.type === 'handoff' || e.type === 'loop') {
            assert.equal(db.inTransaction, false);
            assert.ok(db.prepare(`SELECT 1 FROM ${e.type === 'loop' ? 'loops' : 'handoffs'} WHERE id=?`).get(e.id));
            seen.push(e.type);
        }
    });
    assert.throws(() => hdb.atomic(() => { handoffs.createHandoff(f.userId, { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Rollback.', idempotencyKey: 'rollback' }); throw new Error('rollback'); }));
    await flush();
    assert.equal(seen.length, 0);
    makeLoop(f, {}, false);
    handoffs.createHandoff(f.userId, { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Commit.', idempotencyKey: 'commit' });
    await flush(f);
    assert.ok(seen.includes('loop') && seen.includes('handoff'));
    off();
});
test('POST handoffs p95 stays below 80 ms on the real SQLite fixture', async () => {
    const f = fixture(), o = output(f), times: number[] = [];
    for (let i = 0; i < 40; i++) {
        const start = performance.now();
        assert.equal((await call(f, '/handoffs', 'POST', { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Performance fixture.', idempotencyKey: `perf-${i}`, createTask: false })).status, 201);
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * .95) - 1];
    console.log(`POST /api/handoffs p95 ${p95.toFixed(2)} ms (${times.length} requests)`);
    assert.ok(p95 < 80);
});
test('standing auto links fire once after a matching run and suggest links stay idle', async () => {
    const f = fixture();
    links.replaceLinks(f.userId, f.maker.id, [{ toBotId: f.checker.id, mode: 'auto', template: 'Review {title}.' }]);
    const o = output(f, 'Standing fixture.');
    await flush(f);
    const list = handoffs.listHandoffs(f.userId, { botId: f.maker.id, direction: 'sent' }).handoffs;
    assert.equal(list.length, 1);
    assert.equal(list[0].sourceOutputId, o.id);
    reconcile.recoverHandoffs();
    await flush(f);
    assert.equal(handoffs.listHandoffs(f.userId, { botId: f.maker.id, direction: 'sent' }).handoffs.length, 1);
    const g = fixture();
    links.replaceLinks(g.userId, g.maker.id, [{ toBotId: g.checker.id, mode: 'suggest' }]);
    output(g);
    await flush(g);
    assert.equal(handoffs.listHandoffs(g.userId).handoffs.length, 0);
});
test('fire and forget handoffs settle without a result wake, and legacy requests still return', async () => {
    const f = fixture(), o = output(f);
    const h = handoffs.createHandoff(f.userId, { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Fixture.', idempotencyKey: 'no-return', returnResult: false }).handoff;
    await flush(f);
    finish(f, handoffs.getHandoff(f.userId, h.id).jobId!, 'No reply expected.');
    assert.equal((db.prepare("SELECT count(*) n FROM coordination_requests WHERE user_id=? AND kind='result'").get(f.userId) as any).n, 0);
    const id = requests.enqueueInternalMessage(f.maker.id, f.checker.id, 'Legacy fixture.', 0);
    finish(f, requests.getInternalRequest(f.userId, id).jobId!, 'Legacy reply.');
    assert.equal((db.prepare("SELECT count(*) n FROM coordination_requests WHERE user_id=? AND kind='result'").get(f.userId) as any).n, 1);
});
test('false checklist pass is corrected, unknown verdicts and altered submissions are refused', async () => {
    const f = fixture(), l = makeLoop(f);
    await flush(f);
    finish(f, loops.loopSteps(f.userId, l.id)[0].jobId!, 'Checklist draft.');
    await flush(f);
    const step = loops.loopSteps(f.userId, l.id).at(-1)!, ctx = { userId: f.userId, botId: f.checker.id, jobId: step.jobId!, toolCallId: 'verdict' };
    const input = { pass: true, checklist: ['version', 'short', 'action'].map(id => ({ id, pass: false, note: 'Missing.' })), feedback: 'Fix all checks.' };
    const result = loops.submitVerdict(ctx, input);
    assert.equal(result.pass, false);
    assert.equal(result.claimedPass, true);
    assert.equal(result.corrected, true);
    assert.equal(loops.submitVerdict(ctx, input).pass, false);
    assert.throws(() => loops.submitVerdict(ctx, { ...input, feedback: 'Changed.' }), /cannot change/);
    assert.equal(hdb.events(f.userId, { loopId: l.id }).filter(e => e.type === 'verdict.corrected').length, 1);
    const j = jobs.acceptJob(f.maker.id, { type: 'user' });
    assert.throws(() => loops.submitVerdict({ ...ctx, botId: f.maker.id, jobId: j.id }, input), /No review/);
});
test('per-user setting disables execution and can be restored without an environment change', async () => {
    const f = fixture();
    assert.equal((await call(f, '/handoff-settings', 'PUT', { enabled: false, agentHandoffs: 'team' })).status, 200);
    assert.equal((await call(f, '/outputs')).status, 503);
    assert.equal((await call(f, '/handoff-settings')).status, 200);
    assert.equal((await call(f, '/handoff-settings', 'PUT', { enabled: true, agentHandoffs: 'team' })).status, 200);
    assert.equal((await call(f, '/outputs')).status, 200);
});
test('cancelling a deferred handoff never interrupts unrelated work on the receiver', async () => {
    const { interrupted } = await import('./server-fixture.test.mts');
    const f = fixture(), o = output(f), busy = jobs.acceptJob(f.checker.id, { type: 'user' });
    jobs.beginJob(busy.id);
    const h = handoffs.createHandoff(f.userId, { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Wait for receiver.', idempotencyKey: 'busy-cancel' }).handoff;
    assert.equal(requests.getInternalRequest(f.userId, h.requestId!).status, 'deferred');
    handoffs.controlHandoff(f.userId, h.id, 'cancel');
    assert.ok(!interrupted.includes(busy.id));
    assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(busy.id) as any).state, 'running');
});
