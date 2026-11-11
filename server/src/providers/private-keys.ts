import { db, now } from '../db.js';
import { assertTenant } from '../deployment.js';
import { sealPrivate, openPrivate } from '../security/secrets.js';
db.exec(`CREATE TABLE IF NOT EXISTS private_api_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL CHECK(provider IN ('direct','voice')),
  secret TEXT,hint TEXT,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,provider));`);
export type PrivateProvider='direct'|'voice';
export function privateKey(userId:string|null|undefined,provider:PrivateProvider){
  if(!userId)return '';assertTenant(userId);
  const row=db.prepare('SELECT secret FROM private_api_keys WHERE user_id=? AND provider=?').get(userId,provider) as {secret:string|null}|undefined;
  return row?.secret?openPrivate<string>(userId,`api:${provider}`,row.secret):'';
}
export function privateKeyStatus(userId:string){assertTenant(userId);return db.prepare('SELECT provider,hint,revision,updated_at,secret IS NOT NULL AS connected FROM private_api_keys WHERE user_id=?').all(userId);}
export function savePrivateKey(userId:string,provider:PrivateProvider,key:string|null){
  assertTenant(userId);
  db.prepare(`INSERT INTO private_api_keys(user_id,provider,secret,hint,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET secret=excluded.secret,hint=excluded.hint,revision=revision+1,updated_at=excluded.updated_at`)
    .run(userId,provider,key?sealPrivate(userId,`api:${provider}`,key):null,key?`…${key.slice(-4)}`:null,now());
}
