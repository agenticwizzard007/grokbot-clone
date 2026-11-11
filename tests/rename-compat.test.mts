// An install from before the Swarm rename keeps its database, saved keys, sign-in and signed links.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { AuthVars } from '../server/src/lib/auth.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rename-'));
const SECRET = 'rename-tests-only';
Object.assign(process.env, {
  DB_PATH: path.join(root, 'db.sqlite'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: SECRET, COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  APP_URL: 'http://localhost:5173', SERVER_URL: 'http://localhost:8787', GROKBOT_RENAME_TEST: 'from-old-env',
});
delete process.env.SWARM_RENAME_TEST;
// Seed an actual pre-upgrade database so startup migration, not a runtime
// plaintext-token fallback, provides compatibility.
const legacyDb = new Database(process.env.DB_PATH!);
legacyDb.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,avatar_url TEXT,created_at INTEGER NOT NULL);
  CREATE TABLE auth_sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
legacyDb.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('usr_old','old@example.com','Old Browser',Date.now());
legacyDb.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run('tok_old','usr_old',Date.now(),Date.now()+3600_000);
legacyDb.close();
const { env, preferExisting } = await import('../server/src/env.js');
const { db, now } = await import('../server/src/db.js');
const { loadSettings, sealSecret, unsealSecret } = await import('../server/src/settings.js');
const { requireUser, userFromCookieHeader } = await import('../server/src/lib/auth.js');
const { signUser, verifyUserSig } = await import('../server/src/messaging/store.js');

/** How secrets were sealed before the rename. */
function legacySeal(plain: string) {
  const key = crypto.createHash('sha256').update(`grokbot-settings:${SECRET}`).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

test('GROKBOT_* variables are read as SWARM_*', () => {
  assert.equal(process.env.SWARM_RENAME_TEST, 'from-old-env');
});

test('the old database file is used until a new one exists', () => {
  const dir = fs.mkdtempSync(path.join(root, 'data-'));
  const current = path.join(dir, 'swarm.db'), legacy = path.join(dir, 'grokbot.db');
  assert.equal(preferExisting(current, legacy), current, 'fresh install');
  fs.writeFileSync(legacy, '');
  assert.equal(preferExisting(current, legacy), legacy, 'install from before the rename');
  fs.writeFileSync(current, '');
  assert.equal(preferExisting(current, legacy), current, 'both: the new file wins');
});

test('keys saved before the rename still decrypt, and are re-saved under the new key', () => {
  const old = legacySeal('sk-or-legacy-key');
  assert.equal(unsealSecret(old), 'sk-or-legacy-key');
  assert.equal(unsealSecret(sealSecret('sk-or-new-key')), 'sk-or-new-key');
  assert.equal(unsealSecret('v1:' + Buffer.alloc(40).toString('base64')), null, 'garbage still fails');
  db.prepare('INSERT OR REPLACE INTO server_settings(key,value,updated_by,updated_at) VALUES (?,?,?,?)').run('openrouter', old, null, now());
  loadSettings();
  assert.equal(env.openrouterKey, 'sk-or-legacy-key');
  const stored = (db.prepare("SELECT value FROM server_settings WHERE key='openrouter'").get() as { value: string }).value;
  assert.notEqual(stored, old, 'resealed');
  assert.equal(unsealSecret(stored), 'sk-or-legacy-key');
});

test('a browser signed in before the rename stays signed in', async () => {
  assert.equal(db.prepare('SELECT 1 FROM auth_sessions WHERE token=?').get('tok_old'), undefined, 'legacy bearer removed');
  assert.ok(db.prepare('SELECT 1 FROM auth_sessions WHERE token=?').get(crypto.createHash('sha256').update('tok_old').digest('hex')), 'legacy session stored only as a hash');
  assert.equal(userFromCookieHeader('grokbot_session=tok_old')?.id, 'usr_old');
  assert.equal(userFromCookieHeader('swarm_session=nope; grokbot_session=tok_old'), null, 'the current cookie wins');
  const app = new Hono<AuthVars>().get('/me', requireUser, (c) => c.json({ id: c.get('user').id }));
  const res = await app.request('/me', { headers: { cookie: 'grokbot_session=tok_old' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'usr_old' });
  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith('swarm_session=tok_old;')), 'moved to the new cookie');
  assert.ok(cookies.some((c) => c.startsWith('grokbot_session=;')), 'old cookie cleared');
  assert.ok(cookies.some((c) => c.startsWith('swarm_session=') && Number(c.match(/Max-Age=(\d+)/)?.[1]) <= 3600), 'rename does not extend expiry');
  assert.equal(userFromCookieHeader('grokbot_session=%ZZ'), null, 'malformed encoding fails closed');
  const bad = await app.request('/me', { headers: { cookie: 'grokbot_session=expired' } });
  assert.equal(bad.status, 401);
  assert.ok(!bad.headers.getSetCookie().some((c) => c.startsWith('swarm_session=')), 'unknown tokens are not copied');
});

test('links signed before the rename still verify', () => {
  const key = crypto.createHash('sha256').update(`grokbot-messaging:${SECRET}`).digest();
  const old = crypto.createHmac('sha256', key).update('apps-callback:usr_old').digest('base64url').slice(0, 32);
  assert.equal(verifyUserSig('usr_old', 'apps-callback', old), true);
  assert.equal(verifyUserSig('usr_old', 'apps-callback', signUser('usr_old', 'apps-callback')), true);
  assert.equal(verifyUserSig('usr_other', 'apps-callback', old), false);
  assert.equal(verifyUserSig('usr_old', 'apps-callback', 'x'.repeat(32)), false);
});
