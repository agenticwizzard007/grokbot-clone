// Disposable local Docker only. Never records release-gate evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
if (docker.status !== 0 || spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
  console.error('NOT RUN: Docker daemon and Compose plugin are required. See docs/docker-platform.md.');
  process.exit(77);
}
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-docker-smoke-'));
const envFile = path.join(temp, 'local.env'), project = `swarm-smoke-${randomBytes(6).toString('hex')}`;
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const ports = [await freePort(), await freePort()];
const values = parseEnv(fs.readFileSync('deploy/docker/.env.example', 'utf8'));
for (const key of Object.keys(values)) if (/PASSWORD|SECRET|ACCESS_KEY_ID|API_KEY|MINIO_ROOT_USER/.test(key)) values[key] = randomBytes(32).toString('hex');
Object.assign(values, { PLATFORM_KEYS_DIR: path.join(temp, 'keys'), COMPOSE_PROJECT_NAME: project,
  SWARM_BUILD_REVISION: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  PLATFORM_HTTPS_PORT: String(ports[0]), GATEWAY_HTTPS_PORT: String(ports[1]),
  LOCAL_UID: String(process.getuid()), LOCAL_GID: String(process.getgid()),
  MINIO_KMS_SECRET_KEY: `local-key:${randomBytes(32).toString('base64')}` });
fs.writeFileSync(envFile, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
const cleanEnv = { ...process.env };
for (const name of Object.keys(values)) delete cleanEnv[name];
function compose(args, input) {
  return execFileSync('docker', ['compose', '--env-file', envFile, '-f', 'deploy/docker/compose.platform.yml', ...args],
    { cwd: root, env: cleanEnv, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
}
let checks = 0;
try {
  const up = spawnSync('bash', ['scripts/platform-local-up.sh'], { cwd: root, env: { ...cleanEnv, PLATFORM_ENV_FILE: envFile }, stdio: 'inherit' });
  assert.equal(up.status, 0, 'platform-local-up must succeed');
  const services = compose(['config', '--services']).trim().split('\n');
  for (const service of services) {
    const id = compose(['ps', '-aq', service]).trim();
    assert.ok(id, `${service} container exists`);
    const state = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .State}}', id], { encoding: 'utf8' }));
    if (['migrate', 'minio-init', 'kms-volume-init'].includes(service)) { assert.equal(state.Status, 'exited'); assert.equal(state.ExitCode, 0); }
    else { assert.equal(state.Running, true); assert.equal(state.Health.Status, 'healthy', service); }
    checks++; console.log(`PASS ${service} ${state.Status === 'exited' ? 'completed' : state.Health.Status}`);
  }
  // Trust only this stack's generated CA, without disabling TLS verification.
  const ca = compose(['exec', '-T', 'https', 'cat', '/data/caddy/pki/authorities/local/root.crt']);
  const caFile = path.join(temp, 'local-ca.crt'); fs.writeFileSync(caFile, ca);
  for (const [port, route] of [[ports[0], '/api/health'], [ports[1], '/health']]) {
    const result = execFileSync('curl', ['--fail', '--silent', '--show-error', '--cacert', caFile, `https://localhost:${port}${route}`], { encoding: 'utf8' });
    assert.equal(JSON.parse(result).ok, true); checks++;
  }
  const held = compose(['exec', '-T', 'provisioner', 'node', '-e', "fetch('http://127.0.0.1:8788/health').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"]);
  assert.equal(JSON.parse(held).provisioning, 'held'); checks++;
  const result = compose(['exec', '-T', 'platform', 'node', '--input-type=module'], `
    import assert from 'node:assert/strict';
    import { randomBytes, createHash } from 'node:crypto';
    import { Readable } from 'node:stream';
    import { Client } from 'pg';
    import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
    import { S3Client, PutObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
    import { tenantKmsConfig } from './server/dist/platform/envelopes.js';
    import { backupS3Config, S3BackupStorage } from './server/dist/platform/backup-storage.js';
    const db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
    try {
      assert.ok(Number((await db.query("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).rows[0].count) > 20);
      assert.equal((await db.query("SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='tenants'")).rows[0].tableowner, 'directory_owner');
      const role = (await db.query("SELECT current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, pg_has_role(current_user,'directory_owner','MEMBER') AS owner, has_schema_privilege(current_user,'public','CREATE') AS ddl FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.equal(role.current_user,'app_runtime');
      for (const key of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','owner','ddl']) assert.equal(role[key],false);
      await assert.rejects(db.query('CREATE TABLE forbidden_owner_probe(id text)'), /permission denied/);
      assert.equal((await db.query('SELECT count(*) FROM release_gates')).rows[0].count, '0');
      await db.query('BEGIN');
      await db.query("INSERT INTO tenants(id,display_name,composio_user_id) VALUES('usr_local_smoke','Local smoke','local_smoke')");
      await db.query('ROLLBACK');
    } finally { await db.end(); }
    const kms = new KMSClient(tenantKmsConfig());
    const context = {tenant:'usr_local_smoke',purpose:'swarm-tenant-master-v1'};
    let generated, decrypted;
    try {
      generated = await kms.send(new GenerateDataKeyCommand({KeyId:process.env.TENANT_KMS_KEY_ID,KeySpec:'AES_256',EncryptionContext:context}));
      decrypted = await kms.send(new DecryptCommand({KeyId:process.env.TENANT_KMS_KEY_ID,CiphertextBlob:generated.CiphertextBlob,EncryptionContext:context}));
      assert.equal(generated.Plaintext.length,32);assert.deepEqual(generated.Plaintext,decrypted.Plaintext);
      await assert.rejects(kms.send(new DecryptCommand({KeyId:process.env.TENANT_KMS_KEY_ID,CiphertextBlob:generated.CiphertextBlob,EncryptionContext:{...context,tenant:'usr_foreign_smoke'}})));
    } finally { generated?.Plaintext?.fill(0); decrypted?.Plaintext?.fill(0); kms.destroy(); }
    const s3 = new S3Client(backupS3Config()), storage = new S3BackupStorage(undefined,undefined,s3);
    const id=randomBytes(16).toString('hex'), tenant='usr_local_smoke', bytes=Buffer.from('local encrypted-part fixture');
    try {
      for(let n=0;n<2;n++) await storage.put(tenant,id,'0.bin',Readable.from([bytes]),bytes.length,createHash('sha256').update(bytes).digest('hex'));
      const part=await storage.get(tenant,id,'0.bin');const chunks=[];for await(const chunk of part.body)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);
      const input={Bucket:process.env.BACKUP_BUCKET,Prefix:'swarm-backups/'+tenant+'/'+id+'/'};
      assert.equal((await s3.send(new ListObjectVersionsCommand(input))).Versions.length,2);
      await assert.rejects(s3.send(new PutObjectCommand({Bucket:process.env.BACKUP_BUCKET,Key:'outside-prefix/denied',Body:'local fixture'})));
      await storage.remove(tenant,id);
      const remaining=await s3.send(new ListObjectVersionsCommand(input));assert.equal(remaining.Versions?.length ?? 0,0);
    } finally { s3.destroy(); }
    console.log('PASS directory owner/runtime grants, empty release gates, KMS context binding, S3 versioned roundtrip and scoped deletion');
  `);
  console.log(result.trim()); checks += 5;
  console.log(`PASS Docker platform smoke: ${checks} checks. Provisioning held; no external provider qualification.`);
} catch (error) {
  // Do not dump environment, inspect config or credential-bearing provider errors.
  console.error('FAIL Docker platform smoke:', error instanceof assert.AssertionError ? error.message : 'A local command failed. Inspect the local service status.');
  process.exitCode = 1;
} finally {
  try { compose(['down', '--volumes', '--remove-orphans', '--timeout', '15']); }
  catch { console.error('Smoke cleanup failed for project ' + project); process.exitCode = 1; }
  fs.rmSync(temp, { recursive: true, force: true });
}
