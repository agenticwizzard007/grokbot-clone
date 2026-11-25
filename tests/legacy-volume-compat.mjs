// Run against an untouched checkout: node tests/legacy-volume-compat.mjs .context/baseline
// Creates only synthetic data, then upgrades a copy of the c6940ea database twice.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const baseline = path.resolve(process.argv[2] ?? '.context/baseline');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).trim(), 'c6940eafed5c0d44df96749f71afb14542c91bc9');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-volume-copy-'));
const before = path.join(tmp, 'old.db'), copy = path.join(tmp, 'copy.db');
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', FILES_DIR: path.join(tmp, 'files'), SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0' };
function run(root, dbPath, code) {
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const root = ${JSON.stringify(pathToFileURL(root + '/').href)};\nconst { db } = await import(root + 'server/src/db.ts');\n${code}`], { cwd: root, env: { ...env, DB_PATH: dbPath }, encoding: 'utf8' });
}
try {
  run(baseline, before, `
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('owner','fixture@example.test','Fixture',1000);
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,next_seq) VALUES(?,?,?,?,?,?)').run('bot','owner','Fixture Bot',1000,1000,5);
    const row = (seq, kind, body, at) => db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)').run('bot',1,seq,seq,kind,JSON.stringify(body),at);
    row(1,'event',{type:'event',event:'voice-call',text:'Voice call started',call:{id:'legacy',phase:'started'}},1000);
    row(2,'card',{type:'card',card:'approval',approvalId:'approval',status:'denied',title:'Allow a Gmail draft?',args:{tool_slug:'GMAIL_CREATE_EMAIL_DRAFT',arguments:{subject:'Voice R7'}}},2000);
    db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,?,?,?,?,?)').run('approval','bot',2,'tool-call','SWARM_APPS_EXECUTE','denied',2000);
    row(3,'event',{type:'event',event:'voice-call',text:'Voice call ended · 41s. 1 approval from this call is still pending: Gmail draft with subject "Voice R7"',call:{id:'legacy',phase:'ended',durationMs:41000}},42000);
    row(4,'event',{type:'event',event:'voice-call',text:'Voice call ended · 41s. 1 approval is still pending: Unknown subject',call:{id:'unknown',phase:'ended',durationMs:41000}},43000);
    db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  `);
  fs.copyFileSync(before, copy);
  const original = fs.readFileSync(before);
  let rows;
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = run(process.cwd(), copy, `
      const assert = (await import('node:assert/strict')).default;
      const { listRows, getBot } = await import(root + 'server/src/store.ts');
      const stored = db.prepare('SELECT * FROM rows ORDER BY seq').all();
      const result = listRows('bot');
      assert.match(result[2].body.text, /was not allowed.*Voice R7/);
      assert.doesNotMatch(result[3].body.text, /pending|Unknown/);
      assert.deepEqual(db.prepare('SELECT * FROM rows ORDER BY seq').all(), stored);
      assert.equal(db.pragma('table_info(bots)').filter(c => c.name === 'suggestions_snapshot').length, 1);
      const { saveSuggestions } = await import(root + 'server/src/suggestion-store.ts');
      assert.equal(saveSuggestions('owner','bot',{version:1,filterVersion:'purpose-2',computedAt:1000,hasContext:true,suggestions:[]}),true);
      assert.deepEqual(getBot('bot').suggestedApps.suggestions,[]);
      assert.deepEqual(db.pragma('foreign_key_check'),[]);
      console.log(JSON.stringify(stored)); db.close();
    `).trim();
    const current = JSON.parse(output.split('\n').at(-1));
    if (rows) assert.deepEqual(current, rows); else rows = current;
  }
  assert.deepEqual(fs.readFileSync(before), original, 'original database stays untouched');
  console.log('PASS c6940ea database copy: additive schema twice, legacy linked and unlinked serialization, no row loss or rewrite, original unchanged');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
