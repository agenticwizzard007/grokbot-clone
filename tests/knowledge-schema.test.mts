import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { checkKnowledgeRollback } from '../scripts/check-knowledge-rollback.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-knowledge-schema-'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
let sequence = 0;
const fresh = () => path.join(directory, `${++sequence}.db`);
const legacyTrigger = `CREATE TRIGGER knowledge_receipt_no_delete BEFORE DELETE ON knowledge_use_receipts
 WHEN EXISTS(SELECT 1 FROM bots WHERE id=OLD.bot_id)
 BEGIN SELECT RAISE(ABORT,'Knowledge receipts are immutable'); END;`;
const imports = `
  import assert from 'node:assert/strict';
  globalThis.fetch = async () => { throw new Error('No network in schema regression'); };
  const { db } = await import('./server/src/db.ts');
`;
const application = `
  await import('./server/src/knowledge/schema.ts');
  const { createBot } = await import('./server/src/bots.ts');
  const { acceptJob } = await import('./server/src/agent/jobs.ts');
  const { deleteAccount } = await import('./server/src/accounts.ts');
  const { createSkill, deleteSkill } = await import('./server/src/knowledge/skills.ts');
  function seed(userId) {
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,1)').run(userId,userId+'@example.invalid',userId);
    const botId = createBot(userId,{name:userId,isPrimary:true}).id;
    const skill = createSkill(userId,botId,{name:'Existing skill',description:'fixture',body:'Approved instructions'});
    const job = acceptJob(botId,{type:'user',text:'Recorded work'}).id;
    const reviewJob = acceptJob(botId,{type:'learning-review',text:'Recorded review'}).id;
    const bind = {userId,botId,skillId:skill.id,job,reviewJob,id:userId};
    const insert = sql => db.prepare(sql).run(bind);
    insert("INSERT INTO memories(id,bot_id,text,created_at) VALUES(@id,@botId,'Current memory',1)");
    insert("INSERT INTO knowledge_memory_events(memory_id,bot_id,action,snapshot,actor,created_at) VALUES(@id,@botId,'create','{}',@userId,1)");
    insert("INSERT INTO knowledge_use_receipts(user_id,bot_id,job_id,kind,source_id,revision,hash,actor,created_at) VALUES(@userId,@botId,@job,'skill',@skillId,1,'hash',@userId,1)");
    insert("INSERT INTO knowledge_learning_state(bot_id,user_id) VALUES(@botId,@userId)");
    insert("INSERT INTO knowledge_learning_turns(job_id,user_id,bot_id,created_at) VALUES(@job,@userId,@botId,1)");
    insert("INSERT INTO knowledge_learning_reviews(id,user_id,bot_id,job_id,parent_job_id,status,reason,review_memory,review_skills,model,provider,settings_revision,foreground_epoch,generation,snapshot,source_snapshot,settings,created_at) VALUES(@id,@userId,@botId,@reviewJob,@job,'completed','fixture',1,1,'fixture','fixture','1',0,1,'[]','[]','{}',1)");
    insert("INSERT INTO knowledge_skill_proposals(id,bot_id,skill_id,base_revision,generation,snapshot,reason,evidence,created_at) VALUES(@id,@botId,@skillId,1,1,'{}','fixture','[]',1)");
    insert("INSERT INTO knowledge_promotion_policies(skill_id,bot_id,revision,snapshot,actor,created_at) VALUES(@skillId,@botId,1,'{}',@userId,1)");
    insert("INSERT INTO knowledge_skill_evaluations(id,bot_id,proposal_id,candidate_hash,source_hash,base_hash,policy_revision,settings_revision,evaluator,status,reason,results,created_at) VALUES(@id,@botId,@id,'hash','hash','hash',1,'1','fixture','passed','fixture','[]',1)");
    insert("INSERT INTO knowledge_skill_promotions(id,bot_id,skill_id,proposal_id,evaluation_id,revision,policy_revision,actor,rollback,created_at) VALUES(@id,@botId,@skillId,@id,@id,1,1,@userId,'{}',1)");
    insert("INSERT INTO knowledge_memory_reviews(id,bot_id,sources,result,created_at) VALUES(@id,@botId,'[]','{}',1)");
    insert("INSERT INTO knowledge_procedure_applications(id,bot_id,skill_id,revision,job_id,input_hash,output,created_at) VALUES(@id,@botId,@skillId,1,@job,'hash','fixture',1)");
    insert("INSERT INTO knowledge_skill_regressions(id,bot_id,skill_id,revision,policy_revision,checks,action,reason,created_at) VALUES(@id,@botId,@skillId,1,1,'[]','unchanged','fixture',1)");
    return bind;
  }
  const tables = () => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,10)='knowledge_' ORDER BY name").all().map(r=>r.name);
  const knowledge = () => Object.fromEntries(tables().map(t=>[t,db.prepare('SELECT * FROM '+t).all().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  const owned = p => Object.fromEntries(Object.entries(knowledge()).map(([t,rows])=>[t,rows.filter(r=>r.bot_id===p.botId||r.user_id===p.userId)]));
`;
function run(script: string, file = fresh(), setup = application) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', imports + setup + script + '\ndb.close();'], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, DB_PATH: file, FILES_DIR: file + '-files', CLI_PROFILES_DIR: file + '-profiles',
      SWARM_ROLE: 'standalone', NODE_ENV: 'test', COMPUTER_PROVIDER: 'local', SESSION_SECRET: 'schema-regression',
      SWARM_NO_SCHEDULER: '1', INKBOX_TUNNEL: '0', COMPOSIO_API_KEY: '', DIRECT_API_KEY: '',
      ADMIN_USER_IDS: '', ADMIN_PHONES: '', ADMIN_EMAILS: '' },
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const resultJson = (output: string) => JSON.parse(output.split('RESULT ').at(-1)!.trim());

test('real account deletion removes populated knowledge and preserves a different account', () => {
  run(`
    const owner = seed('owner'), other = seed('other');
    const untouched = owned(other);
    let authorizations = 0;
    await deleteAccount(owner.userId, () => { authorizations++; });
    assert.ok(authorizations >= 5);
    assert.equal(db.prepare('SELECT 1 FROM users WHERE id=?').get(owner.userId),undefined);
    assert.equal(db.prepare('SELECT 1 FROM bots WHERE id=?').get(owner.botId),undefined);
    for (const rows of Object.values(owned(owner))) assert.equal(rows.length,0);
    assert.deepEqual(owned(other),untouched);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  `);
});

test('direct user cascade and bot cascade both remove receipts and all dependent evidence', () => {
  run(`
    const owner = seed('owner');
    db.prepare('DELETE FROM users WHERE id=?').run(owner.userId);
    for (const rows of Object.values(owned(owner))) assert.equal(rows.length,0);
    const other = seed('other');
    db.prepare('DELETE FROM bots WHERE id=?').run(other.botId);
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').get(other.userId));
    for (const rows of Object.values(owned(other))) assert.equal(rows.length,0);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  `);
});

test('receipts, revisions and learning evidence remain immutable while their owner and bot exist', () => {
  run(`
    const owner = seed('owner');
    const before = knowledge();
    for (const table of ['knowledge_use_receipts','knowledge_skill_revisions','knowledge_promotion_policies','knowledge_skill_evaluations','knowledge_skill_promotions','knowledge_memory_reviews','knowledge_procedure_applications','knowledge_skill_regressions']) {
      assert.throws(()=>db.exec('DELETE FROM '+table),/immutable/);
      assert.throws(()=>db.exec('UPDATE '+table+' SET bot_id=bot_id'),/immutable/);
    }
    assert.throws(()=>db.prepare('DELETE FROM skills WHERE id=?').run(owner.skillId),/immutable/);
    assert.throws(()=>db.prepare('DELETE FROM knowledge_skill_proposals WHERE id=?').run(owner.id),/immutable/);
    assert.deepEqual(knowledge(),before);
  `);
});

test('authorization refusal and failed cascade preserve the account and immutable evidence', () => {
  run(`
    const owner = seed('owner');
    const before = knowledge();
    await assert.rejects(deleteAccount(owner.userId,()=>{throw new Error('authorization changed');}),/authorization changed/);
    db.exec("CREATE TRIGGER reject_account_delete AFTER DELETE ON users BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END;");
    await assert.rejects(deleteAccount(owner.userId),/injected deletion failure/);
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').get(owner.userId));
    assert.deepEqual(knowledge(),before);
    assert.throws(()=>db.exec('DELETE FROM knowledge_use_receipts'),/immutable/);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  `);
});

test('cold-process upgrade replaces the installed v39/v40 trigger without rewriting evidence', () => {
  const file = fresh();
  const before = resultJson(run(`
    seed('owner'); seed('other');
    db.exec('DROP TRIGGER knowledge_receipt_no_delete');
    db.exec(${JSON.stringify(legacyTrigger)});
    assert.throws(()=>db.prepare('DELETE FROM users WHERE id=?').run('owner'),/Knowledge receipts are immutable/);
    console.log('RESULT '+JSON.stringify(knowledge()));
  `, file));
  assert.deepEqual(resultJson(run("console.log('RESULT '+JSON.stringify(knowledge()));", file)), before);
  assert.deepEqual(resultJson(run("console.log('RESULT '+JSON.stringify(knowledge()));", file)), before, 'restart is idempotent');
  run(`
    await deleteAccount('owner');
    assert.equal(db.prepare("SELECT 1 FROM users WHERE id='owner'").get(),undefined);
    assert.ok(db.prepare("SELECT 1 FROM knowledge_use_receipts WHERE user_id='other'").get());
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  `, file);
});

test('failed trigger replacement rolls back the DROP and retains all old evidence', () => {
  const file = fresh();
  run(`seed('owner'); db.exec('DROP TRIGGER knowledge_receipt_no_delete'); db.exec(${JSON.stringify(legacyTrigger)});`, file);
  run(`
    const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='knowledge_receipt_no_delete'").get();
    const receipt = db.prepare('SELECT * FROM knowledge_use_receipts').all();
    const original = db.exec;
    db.exec = function(sql) {
      if (sql.includes('CREATE TRIGGER knowledge_receipt_no_delete')) {
        assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='knowledge_receipt_no_delete'").get(),undefined);
        throw new Error('injected migration failure');
      }
      return original.call(this,sql);
    };
    await assert.rejects(import('./server/src/knowledge/schema.ts'),/injected migration failure/);
    db.exec = original;
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_schema WHERE name='knowledge_receipt_no_delete'").get(),trigger);
    assert.deepEqual(db.prepare('SELECT * FROM knowledge_use_receipts').all(),receipt);
    assert.throws(()=>db.exec('DELETE FROM knowledge_use_receipts'),/immutable/);
  `, file, '');
  run("await deleteAccount('owner'); assert.equal(db.prepare('SELECT count(*) n FROM knowledge_use_receipts').get().n,0);", file);
});

test('an old migration-held schema refuses the replacement and preserves its exact fence', () => {
  const file = fresh();
  run(`
    seed('usr_owner_12345678');
    await import('./server/src/routes.ts'); await import('./server/src/routes-config.ts');
    await import('./server/src/mcp/oauth.ts'); await import('./server/src/provisioning.ts');
    (await import('./server/src/agent/rooms.ts')).initRooms();
    (await import('./server/src/agent/subagents.ts')).initSubagents();
    db.exec('DROP TRIGGER knowledge_receipt_no_delete'); db.exec(${JSON.stringify(legacyTrigger)});
    const fence = await import('./server/src/platform/legacy-database-fence.ts');
    fence.holdLegacyDatabase(db,'usr_owner_12345678','migration:knowledge:12345678','1');
    fence.assertLegacyDatabaseFences(db);
  `, file);
  run(`
    const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='knowledge_receipt_no_delete'").get();
    const before = db.prepare('SELECT * FROM legacy_owner_fences').all();
    const receipt = db.prepare('SELECT * FROM knowledge_use_receipts').all();
    await assert.rejects(import('./server/src/knowledge/schema.ts'),/schema changed; source must remain stopped/);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_schema WHERE name='knowledge_receipt_no_delete'").get(),trigger);
    assert.deepEqual(db.prepare('SELECT * FROM legacy_owner_fences').all(),before);
    assert.deepEqual(db.prepare('SELECT * FROM knowledge_use_receipts').all(),receipt);
    (await import('./server/src/platform/legacy-database-fence.ts')).assertLegacyDatabaseFences(db);
    assert.throws(()=>db.prepare("DELETE FROM users WHERE id='usr_owner_12345678'").run(),/migration_hold/);
  `, file, '');
});

test('legacy reads expose tombstones and legacy skill deletion fails: same-volume downgrade must be refused', async () => {
  const file = fresh();
  run(`
    const owner = seed('owner');
    deleteSkill(owner.userId,owner.skillId,1);
    db.prepare("UPDATE memories SET status='superseded' WHERE id=?").run(owner.id);
    db.prepare("INSERT INTO memories(id,bot_id,text,status,created_at) VALUES('deleted',?,'Forgotten fact','deleted',2)").run(owner.botId);
    db.prepare("INSERT INTO memories(id,bot_id,text,status,created_at) VALUES('current',?,'Corrected fact','active',3)").run(owner.botId);
    // Queries from pre-Hermes 1fd91e1 prompt.ts/routes-config.ts/memory.ts.
    assert.equal(db.prepare('SELECT name, body FROM skills WHERE bot_id=?').all(owner.botId).length,1);
    assert.equal(db.prepare('SELECT * FROM skills WHERE bot_id=?').all(owner.botId).length,1);
    assert.equal(db.prepare('SELECT text FROM memories WHERE bot_id=?').all(owner.botId).length,3);
    assert.throws(()=>db.prepare('DELETE FROM skills WHERE id=?').run(owner.skillId),/immutable/);
  `, file);
  const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const names = fs.readdirSync(directory);
  const report = await checkKnowledgeRollback(file);
  assert.equal(report.status, 'incompatible');
  assert.equal(report.rollbackApproved, false);
  assert.equal(report.snapshotSha256, before);
  assert.deepEqual(fs.readdirSync(directory), names, 'inspection never creates source WAL/SHM files');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
  const cli = spawnSync(process.execPath, ['scripts/check-knowledge-rollback.mjs', file], { encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'incompatible');
});

test('an empty upgraded schema is still incompatible; deleting rows cannot authorize downgrade', async () => {
  const file = fresh();
  run('', file);
  assert.equal((await checkKnowledgeRollback(file)).status, 'incompatible');
});

test('legacy schema inspection is not a release approval, and partial knowledge upgrades fail closed', async () => {
  const file = fresh();
  run("await import('./server/src/db-config.ts');", file, '');
  const report = await checkKnowledgeRollback(file);
  assert.equal(report.status, 'no-knowledge-schema-detected');
  assert.equal(report.rollbackApproved, false);
  const database = new Database(file);
  database.exec('ALTER TABLE skills ADD COLUMN deleted_at INTEGER');
  database.close();
  assert.equal((await checkKnowledgeRollback(file)).status, 'incompatible');
});

test('checker refuses missing, invalid, unrecognized and journal-bearing inputs without mutation', async () => {
  const missing = fresh();
  await assert.rejects(checkKnowledgeRollback(missing), /ENOENT/);
  assert.equal(fs.existsSync(missing), false);
  const invalid = fresh(); fs.writeFileSync(invalid, 'not sqlite');
  await assert.rejects(checkKnowledgeRollback(invalid));
  assert.equal(fs.readFileSync(invalid, 'utf8'), 'not sqlite');
  const empty = fresh(); const database = new Database(empty); database.exec('CREATE TABLE unrelated(id)'); database.close();
  await assert.rejects(checkKnowledgeRollback(empty), /recognized/);
  const file = fresh(); run('', file);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    fs.writeFileSync(file + suffix, 'fixture');
    await assert.rejects(checkKnowledgeRollback(file), /sidecars/);
    assert.equal(fs.readFileSync(file + suffix, 'utf8'), 'fixture');
    fs.unlinkSync(file + suffix);
  }
  const link = fresh(); fs.symlinkSync(file, link);
  await assert.rejects(checkKnowledgeRollback(link), /regular/);
});
