import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fixture, output, outputs, handoffs, db, jobs, finish, hooks, hdb, flush, hub, recordArtifact, cleanup } from './server-fixture.test.mts';
after(cleanup);
test('completed job finalizes once and failed or cancelled jobs keep drafts incomplete', () => {
    const f = fixture(), o = output(f, 'Fixture finished body.');
    hooks.onJobFinished({ userId: f.userId, botId: f.maker.id, jobId: o.jobId!, status: 'completed', finalText: 'Must not replace final content.' });
    assert.equal(outputs.outputByJob(f.userId, o.jobId!).id, o.id);
    assert.equal(outputs.readPart(f.userId, o.id, 'p_body').text, 'Fixture finished body.');
    const job = jobs.acceptJob(f.maker.id, { type: 'user' });
    outputs.submitOutput({ userId: f.userId, botId: f.maker.id, jobId: job.id, toolCallId: 'draft' }, { summary: 'Incomplete draft.' });
    finish(f, job.id, 'failed text', 'failed');
    assert.equal(outputs.outputByJob(f.userId, job.id).status, 'draft');
});
test('declared fields win, revisions and replay receipts are stable, file artifacts are references', () => {
    const f = fixture(), job = jobs.acceptJob(f.maker.id, { type: 'user' }), ctx = { userId: f.userId, botId: f.maker.id, jobId: job.id, toolCallId: 'first' };
    const artifact = recordArtifact({ userId: f.userId, botId: f.maker.id, jobId: job.id, filename: 'fixture.txt', content: 'Fixture file body.' });
    const input = { title: 'Declared fixture', summary: 'Declared summary.', dataParts: [{ name: 'scores', json: { ok: true } }], files: [artifact.filename] };
    const draft = outputs.submitOutput(ctx, input);
    assert.equal(outputs.submitOutput(ctx, input).revision, 1);
    assert.equal(outputs.submitOutput({ ...ctx, toolCallId: 'second' }, { ...input, summary: 'Revised summary.' }).revision, 2);
    finish(f, job.id, 'Finished body with [Fixture link](https://example.test/fixture).');
    const final = outputs.outputByJob(f.userId, job.id);
    assert.equal(final.id, draft.id);
    assert.equal(final.summary, 'Revised summary.');
    assert.equal(final.revision, 3);
    assert.equal(final.parts.filter(p => p.kind === 'file').length, 1);
    assert.equal(final.parts.find(p => p.kind === 'link')?.title, 'Fixture link');
    assert.throws(() => outputs.submitOutput({ ...ctx, toolCallId: 'after' }, { summary: 'Cannot change.' }), /finished/);
});
test('large output pages, redaction, original owner reads and truncation marker', () => {
    const f = fixture(), secret = 'sk-placeholderSecretValue123456789', body = `Bearer ${secret}\n${'Fixture body. '.repeat(18000)}`;
    const o = output(f, body);
    assert.equal(o.summary.includes(secret), false);
    assert.equal(outputs.readPart(f.userId, o.id, 'p_body').text!.includes(secret), false);
    assert.equal(outputs.readPart(f.userId, o.id, 'p_body', 0, 8000, true).text!.includes(secret), true);
    assert.equal(outputs.readPart(f.userId, o.id, 'p_body').text!.length, 8000);
    assert.equal(outputs.readPart(f.userId, o.id, 'p_body').next, 8000);
    assert.equal((o.provenance as any).truncated, true);
    assert.throws(() => outputs.readPart(f.userId, o.id, 'p_body', -1), /page/);
    assert.throws(() => outputs.readPart(f.userId, o.id, 'p_body', 0, 8001), /page/);
});
test('message and done task sources are idempotent and foreign sources are hidden', () => {
    const f = fixture(), b = fixture();
    const row = db.prepare("INSERT INTO rows(bot_id,generation,seq,kind,body,created_at,updated_seq) VALUES(?,?,?,'message',?,?,?)");
    const generation = (db.prepare('SELECT generation FROM bots WHERE id=?').get(f.maker.id) as any).generation;
    row.run(f.maker.id, generation, 900, JSON.stringify({ type: 'message', role: 'assistant', text: 'Message fixture.' }), Date.now(), 900);
    const input = { botId: f.maker.id, generation, seq: 900 }, o = outputs.fromMessage(f.userId, input);
    assert.equal(outputs.fromMessage(f.userId, input).id, o.id);
    assert.throws(() => outputs.fromMessage(b.userId, input), /Not found/);
    db.prepare("INSERT INTO tasks VALUES(?,?,'Task fixture','done','Task body',?,?)").run('fixture-task', f.maker.id, Date.now(), Date.now());
    assert.equal(outputs.fromTask(f.userId, 'fixture-task').id, outputs.fromTask(f.userId, 'fixture-task').id);
    assert.throws(() => outputs.fromTask(b.userId, 'fixture-task'), /Not found/);
});
test('output events reach SSE only after commit and never after rollback', async () => {
    const f = fixture(), seen: any[] = [];
    const off = hub.subscribe(f.userId, e => {
        if (e.type === 'output') {
            assert.equal(db.inTransaction, false);
            assert.ok(db.prepare('SELECT 1 FROM run_outputs WHERE id=?').get(e.id));
            seen.push(e);
        }
    });
    assert.throws(() => hdb.atomic(() => { outputs.saveOutput({ userId: f.userId, botId: f.maker.id, body: 'Rollback fixture.', final: true }); throw new Error('rollback'); }));
    await flush();
    assert.equal(seen.length, 0);
    output(f);
    await flush();
    assert.equal(seen.length, 2);
    off();
});
test('reference authorization prevents another same-user Bot reading an unaddressed output', () => {
    const f = fixture(), o = output(f), job = jobs.acceptJob(f.checker.id, { type: 'user' }), ctx = { userId: f.userId, botId: f.checker.id, jobId: job.id, toolCallId: 'read' };
    assert.throws(() => handoffs.readHandoff(ctx, { ref: `swarm://output/${o.id}` }), /Not found/);
    const h = handoffs.createHandoff(f.userId, { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Read fixture.', idempotencyKey: 'read-fixture' }).handoff;
    assert.equal(handoffs.readHandoff(ctx, { handoffId: h.id, partId: 'p_body' }).text, 'Fixture output.');
    assert.equal(hdb.events(f.userId, { handoffId: h.id }).at(-1)?.type, 'handoff.read');
});
test('file reads and materialization stay inside the receiving Bot storage', () => {
    const f = fixture(), job = jobs.acceptJob(f.maker.id, { type: 'user' });
    recordArtifact({ userId: f.userId, botId: f.maker.id, jobId: job.id, filename: 'fixture.bin', content: Buffer.from([1, 2, 3]) });
    finish(f, job.id, 'File fixture.');
    const o = outputs.outputByJob(f.userId, job.id), part = o.parts.find(p => p.kind === 'file')!;
    const h = handoffs.createHandoff(f.userId, { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Read fixture.', idempotencyKey: 'file-read' }).handoff;
    const j = jobs.acceptJob(f.checker.id, { type: 'user' }), ctx = { userId: f.userId, botId: f.checker.id, jobId: j.id, toolCallId: 'read' };
    assert.match(handoffs.readHandoff(ctx, { handoffId: h.id, partId: part.id, materialize: true }).sandboxPath!, /^Handoffs\//);
    assert.equal(outputs.readPart(f.userId, o.id, part.id).text, undefined);
    assert.throws(() => outputs.materialize(f.userId, f.checker.id, { ...part, filename: '../escape' } as any), /path/);
});
test('deleted outputs leave tombstones and foreign ids retain a uniform 404', () => { const f = fixture(), other = fixture(), o = output(f); outputs.deleteOutput(f.userId, o.id); assert.throws(() => outputs.getOutput(f.userId, o.id), (e: any) => e.status === 410); assert.throws(() => outputs.getOutput(other.userId, o.id), (e: any) => e.status === 404); });
test('finished update_task tool links the output to its owned task', () => {
    const f = fixture(), j = jobs.acceptJob(f.maker.id, { type: 'user' }), generation = (db.prepare('SELECT generation FROM bots WHERE id=?').get(f.maker.id) as any).generation;
    db.prepare("INSERT INTO tasks VALUES(?,?,'Linked task fixture','done','Fixture.',?,?)").run('linked-task-fixture', f.maker.id, Date.now(), Date.now());
    db.prepare("INSERT INTO rows(bot_id,generation,seq,kind,body,created_at,updated_seq) VALUES(?,?,901,'tool-call',?,?,901)").run(f.maker.id, generation, JSON.stringify({ type: 'tool-call', name: 'update_task', status: 'done', jobId: j.id, args: { task_id: 'linked-task-fixture', state: 'done' } }), Date.now());
    finish(f, j.id, 'Linked task output.');
    assert.equal(outputs.outputByJob(f.userId, j.id).taskId, 'linked-task-fixture');
});
test('structured secrets remain valid redacted JSON and selected files stay bounded on reads', async () => {
    const f = fixture(), j = jobs.acceptJob(f.maker.id, { type: 'user' }), ctx = { userId: f.userId, botId: f.maker.id, jobId: j.id, toolCallId: 'output' };
    recordArtifact({ userId: f.userId, botId: f.maker.id, jobId: j.id, filename: 'included.txt', content: 'Included fixture.' });
    recordArtifact({ userId: f.userId, botId: f.maker.id, jobId: j.id, filename: 'excluded.txt', content: 'Excluded fixture.' });
    const o = outputs.submitOutput(ctx, { summary: 'Secrets fixture.', dataParts: [{ name: 'credentials', json: { password: 'placeholder-value', nested: { api_key: 'placeholder-key' }, score: 1 } }] });
    const data = o.parts.find(p => p.kind === 'data')!;
    const json = JSON.parse(outputs.readPart(f.userId, o.id, data.id).text!);
    assert.equal(json.password, '[redacted]');
    assert.equal(json.nested.api_key, '[redacted]');
    assert.equal(json.score, 1);
    const h = await handoffs.handoffService.handoffToAgent({ ...ctx, toolCallId: 'send' }, { outputRef: `swarm://output/${o.id}`, toBotId: f.checker.id, instruction: 'Read selected file.', includeFiles: ['included.txt'] });
    const receiver = jobs.acceptJob(f.checker.id, { type: 'user' }), readCtx = { userId: f.userId, botId: f.checker.id, jobId: receiver.id, toolCallId: 'read' };
    const denied = o.parts.find(p => p.kind === 'file' && p.filename === 'excluded.txt')!;
    assert.throws(() => handoffs.readHandoff(readCtx, { handoffId: h.id, partId: denied.id }), /Not found/);
    assert.equal(handoffs.readHandoff(readCtx, { handoffId: h.id }).output.parts.filter(p => p.kind === 'file').length, 1);
});
