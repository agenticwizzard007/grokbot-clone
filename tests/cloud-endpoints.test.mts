import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { KMSClient, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { tenantKmsConfig, TenantEnvelopes } from '../server/src/platform/envelopes.js';
import { backupS3Config, S3BackupStorage } from '../server/src/platform/backup-storage.js';

for (const [name, config, prefix] of [['KMS', tenantKmsConfig, 'TENANT_KMS'], ['S3', backupS3Config, 'BACKUP_S3']] as const) {
  test(`${name}: default SDK region and credential chain remain available`, () => {
    assert.deepEqual(config({ NODE_ENV: 'production' }), { ignoreConfiguredEndpointUrls: true });
  });
  test(`${name}: production requires the exact allow flag for each override`, () => {
    const changes = [{ [`${prefix}_ENDPOINT`]: 'http://127.0.0.1:9000' }, { [`${prefix}_REGION`]: 'us-east-1' }, ...(name === 'S3' ? [{ BACKUP_S3_FORCE_PATH_STYLE: 'false' }] : [])];
    for (const change of changes) {
      for (const flag of [undefined, '0', 'true']) assert.throws(() => config({ NODE_ENV: 'production', SWARM_ALLOW_LOCAL_CLOUD: flag, ...change }), /SWARM_ALLOW_LOCAL_CLOUD=1/);
      assert.doesNotThrow(() => config({ NODE_ENV: 'production', SWARM_ALLOW_LOCAL_CLOUD: '1', ...change }));
      assert.doesNotThrow(() => config({ NODE_ENV: 'test', ...change }));
    }
  });
  test(`${name}: endpoints cannot contain credentials or invalid protocols`, () => {
    for (const endpoint of ['not a URL', 'file:///tmp/socket', 'ftp://localhost', 'http://user:secret@localhost', 'http://localhost?secret=bad', 'http://localhost/#bad']) {
      assert.throws(() => config({ [`${prefix}_ENDPOINT`]: endpoint }), new RegExp(`Invalid ${prefix}_ENDPOINT`));
    }
    assert.throws(() => config({ [`${prefix}_REGION`]: 'invalid region' }), /Invalid/);
  });
}
test('S3 path style has explicit true/false values and rejects typos', () => {
  for (const value of ['true', '1']) assert.equal(backupS3Config({ BACKUP_S3_FORCE_PATH_STYLE: value }).forcePathStyle, true);
  for (const value of ['false', '0']) assert.equal(backupS3Config({ BACKUP_S3_FORCE_PATH_STYLE: value }).forcePathStyle, false);
  assert.throws(() => backupS3Config({ BACKUP_S3_FORCE_PATH_STYLE: 'yes' }), /Invalid/);
});
test('separate S3 credentials never become KMS credentials, and partial credentials fail closed', () => {
  const env = { NODE_ENV: 'production', BACKUP_S3_ACCESS_KEY_ID: 'storage-only', BACKUP_S3_SECRET_ACCESS_KEY: 'storage-secret', BACKUP_S3_SESSION_TOKEN: 'storage-session' };
  assert.deepEqual(backupS3Config(env).credentials, { accessKeyId: 'storage-only', secretAccessKey: 'storage-secret', sessionToken: 'storage-session' });
  assert.equal('credentials' in tenantKmsConfig(env), false);
  for (const key of ['BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_SESSION_TOKEN']) assert.throws(() => backupS3Config({ [key]: 'partial' }), /Both BACKUP_S3/);
});
test('SDK sends KMS and S3 requests only to configured local endpoints, signed by distinct credentials', async () => {
  const requests: { authorization: string; url: string; target: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization ?? '', url: req.url!, target: String(req.headers['x-amz-target'] ?? '') });
    if (req.method === 'HEAD') res.end();
    else { res.setHeader('content-type', 'application/x-amz-json-1.1'); res.end('{}'); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const kms = new KMSClient({ ...tenantKmsConfig({ TENANT_KMS_ENDPOINT: endpoint, TENANT_KMS_REGION: 'us-east-1' }), credentials: { accessKeyId: 'kms-only', secretAccessKey: 'kms-secret' } });
  const s3 = new S3Client(backupS3Config({ BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_REGION: 'us-east-1', BACKUP_S3_FORCE_PATH_STYLE: 'true', BACKUP_S3_ACCESS_KEY_ID: 'storage-only', BACKUP_S3_SECRET_ACCESS_KEY: 'storage-secret' }));
  try {
    await kms.send(new GenerateDataKeyCommand({ KeyId: 'fixture', KeySpec: 'AES_256', EncryptionContext: { tenant: 'usr_fixture1', purpose: 'swarm-tenant-master-v1' } }));
    await s3.send(new HeadBucketCommand({ Bucket: 'fixture-bucket' }));
    assert.equal(requests.length, 2);
    assert.match(requests[0].authorization, /Credential=kms-only\//);
    assert.equal(requests[0].target, 'TrentService.GenerateDataKey');
    assert.match(requests[1].authorization, /Credential=storage-only\//);
    assert.equal(requests[1].url, '/fixture-bucket/');
  } finally { kms.destroy(); s3.destroy(); await new Promise<void>(r => server.close(() => r())); }
});
test('real constructors enforce the production endpoint policy', () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = 'production'; delete process.env.SWARM_ALLOW_LOCAL_CLOUD;
    process.env.TENANT_KMS_ENDPOINT = 'http://localhost:8080'; process.env.BACKUP_S3_ENDPOINT = 'http://localhost:9000';
    assert.throws(() => new TenantEnvelopes({} as any, 'fixture'), /SWARM_ALLOW_LOCAL_CLOUD/);
    assert.throws(() => new S3BackupStorage('fixture-bucket'), /SWARM_ALLOW_LOCAL_CLOUD/);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});
test('tenant runtime rejects every separate S3 credential while standalone still starts', () => {
  for (const key of ['BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_SESSION_TOKEN']) {
    for (const role of ['tenant', 'standalone']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "(await import('./server/src/deployment.ts')).validateDeployment()"], {
        env: { PATH: process.env.PATH, NODE_ENV: 'production', SWARM_ROLE: role, SWARM_TENANT_ID: 'usr_fixture123', [key]: 'fixture' }, encoding: 'utf8',
      });
      if (role === 'tenant') { assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(`Platform credential ${key}`)); }
      else assert.equal(result.status, 0, result.stderr);
    }
  }
});
