import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-correction-errors-'));
Object.assign(process.env, {
    DB_PATH: path.join(dir, 'test.db'), FILES_DIR: path.join(dir, 'files'),
    SESSION_SECRET: 'correction-errors-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
    COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '',
    INKBOX_TUNNEL: '0', DIRECT_API_KEY: 'test-only', LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1'
});
mock.method(globalThis, 'fetch', async () => { throw new Error('No network or real sends in correction tests'); });
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const memory = await import('../server/src/knowledge/memory.js');
const store = await import('../server/src/store.js');
const { hub } = await import('../server/src/lib/hub.js');

db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,1)').run('owner', 'owner@test.invalid', 'Owner');
beforeEach(() => {
    db.exec('DELETE FROM bots');
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,1,1)').run('alpha', 'owner', 'Alpha');
});
after(() => { mock.restoreAll(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const beforeText = 'I prefer weekly pipeline reports.';
const afterText = 'I now prefer daily pipeline reports.';
const body = (text: string, streaming = false) => ({ type: 'message' as const, role: 'user' as const, audience: 'user' as const, text, streaming });
function seed() {
    const source = store.appendRow('alpha', 'message', body(beforeText));
    const prior = memory.saveMemory('owner', 'alpha', {
        text: 'Prefers weekly pipeline reports.', evidence: [{ botId: source.botId, generation: source.generation, seq: source.seq }]
    }).memory!;
    return { source, prior };
}
function snapshot() {
    return {
        bot: db.prepare('SELECT next_seq,rev,updated_at FROM bots WHERE id=?').get('alpha'),
        rows: db.prepare('SELECT * FROM rows WHERE bot_id=? ORDER BY generation,seq').all('alpha'),
        events: db.prepare('SELECT * FROM native_events WHERE user_id=? ORDER BY seq').all('owner'),
        memories: db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY id').all('alpha'),
        history: db.prepare('SELECT * FROM knowledge_memory_events WHERE bot_id=? ORDER BY id').all('alpha'),
        suppressions: db.prepare('SELECT * FROM knowledge_memory_suppressions WHERE bot_id=? ORDER BY fingerprint').all('alpha'),
        pending: memory.listMemoryChanges('owner', 'alpha')
    };
}

test('explicit correction classification propagates unexpected ownership-read failures', t => {
    const { prior } = seed();
    const failure = new Error('Injected database ownership read failure');
    const prepare = db.prepare.bind(db);
    const fault = t.mock.method(db, 'prepare', (sql: string) => {
        if (sql.startsWith('SELECT id,user_id,generation FROM bots')) throw failure;
        return prepare(sql);
    });
    try {
        assert.throws(() => memory.explicitPreferenceCorrection('owner', prior, 'Prefers daily pipeline reports.', [{ botId: 'alpha', generation: 1, seq: 999 }]), e => e === failure);
    }
    finally { fault.mock.restore(); }
});

for (const operation of ['append', 'update'] as const) {
    for (const failureAt of ['ownership', 'prior evidence', 'correction evidence'] as const) {
        test(`${operation} rolls back the source transaction on a correction ${failureAt} DB-read failure`, t => {
            const { source } = seed();
            const unfinished = operation === 'update' ? store.appendRow('alpha', 'message', body(afterText, true)) : undefined;
            const before = snapshot();
            let observed = 0, faultReached = false, sourceEventVisibleAtFault = false;
            const off = store.onRowChange(() => { observed++; });
            t.after(off);
            const fanout = t.mock.method(hub, 'emit', () => {});
            const failure = new Error(`Injected ${failureAt} DB read failure`);
            const prepare = db.prepare.bind(db);
            let listedMemories = false, readPrior = false;
            const fail = () => {
                faultReached = true;
                const events = prepare('SELECT count(*) n FROM native_events WHERE user_id=?').get('owner') as { n: number };
                sourceEventVisibleAtFault = events.n > before.events.length;
                throw failure;
            };
            const fault = t.mock.method(db, 'prepare', (sql: string) => {
                if (failureAt === 'ownership' && listedMemories && sql.startsWith('SELECT id,user_id,generation FROM bots')) fail();
                const statement = prepare(sql);
                if (sql.startsWith('SELECT * FROM memories WHERE bot_id=')) listedMemories = true;
                if (sql !== 'SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=? AND kind=?') return statement;
                return new Proxy(statement, {
                    get(target, property) {
                        if (property === 'get') return (...args: any[]) => {
                            const prior = args[2] === source.seq;
                            if (failureAt === 'prior evidence' && prior) fail();
                            if (failureAt === 'correction evidence' && !prior && readPrior) fail();
                            const result = target.get(...args);
                            if (prior) readPrior = true;
                            return result;
                        };
                        const value = Reflect.get(target, property);
                        return typeof value === 'function' ? value.bind(target) : value;
                    }
                });
            });
            try {
                assert.throws(() => operation === 'append'
                    ? store.appendRow('alpha', 'message', body(afterText))
                    : store.updateRow('alpha', unfinished!.seq, body(afterText)), e => e === failure);
            }
            finally { fault.mock.restore(); }
            assert.equal(faultReached, true);
            assert.equal(sourceEventVisibleAtFault, true, 'Fault must occur after the source event was inserted');
            assert.deepEqual(snapshot(), before, 'Source rows/events, sequence/revision, memories and pending changes must all roll back');
            assert.equal(observed, 0);
            assert.equal(fanout.mock.callCount(), 0);
        });
    }
}

for (const unavailable of ['stale', 'missing', 'forgotten'] as const) {
    test(`${unavailable} prior evidence or memory skips correction without blocking a human message`, t => {
        const { source, prior } = seed();
        if (unavailable === 'stale')
            db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=?').run(JSON.stringify(body('That earlier preference was inaccurate.')), 'alpha', source.seq);
        else if (unavailable === 'missing')
            db.prepare('DELETE FROM rows WHERE bot_id=? AND seq=?').run('alpha', source.seq);
        else
            memory.forgetMemory('owner', prior.id, prior.revision);
        const before = snapshot();
        let observed = 0;
        const off = store.onRowChange(() => { observed++; });
        t.after(off);
        const result = store.appendRow('alpha', 'message', body(afterText));
        const after = snapshot();
        assert.ok(after.rows.some((row: any) => row.seq === result.seq && JSON.parse(row.body).text === afterText));
        assert.equal(after.events.length, before.events.length + 1);
        assert.equal((after.events.at(-1) as any).kind, 'coordination.human_source');
        assert.deepEqual(after.memories, before.memories);
        assert.deepEqual(after.history, before.history);
        assert.deepEqual(after.suppressions, before.suppressions);
        assert.deepEqual(after.pending, before.pending);
        assert.equal(observed, 1);
        assert.equal(memory.listMemories('owner', 'alpha').length, unavailable === 'forgotten' ? 0 : 1);
    });
}
