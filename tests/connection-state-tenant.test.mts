import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('tenant connection state is owner-scoped read-only metadata with bounded, cancellable gateway errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-connection-state-tenant-'));
  const tenant = 'usr_connection_state';
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ tenantId: tenant, volumeId: 'test-volume' }));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    const readFile = fs.readFile;
    fs.readFile = async (...args) => args[0] === '/run/swarm/test-token' ? 'runtime-secret-sentinel' : readFile(...args);
    let mode = 'available';
    const requests = [], signals = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://gateway.test/rpc');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer runtime-secret-sentinel');
      const request = JSON.parse(init.body); requests.push(request); signals.push(init.signal);
      assert.equal(request.operation, 'connections', 'Only read-only account listing is allowed');
      assert.deepEqual(request.input, {});
      assert.equal(request.sessionHash, 'owner-session-hash');
      assert.ok(init.signal instanceof AbortSignal);
      if (mode === 'error') return Response.json({ error: 'upstream-token-sentinel https://private.invalid' }, { status: 503 });
      if (mode === 'slow') return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('upstream-token-sentinel')), { once: true });
      });
      return Response.json([{ id: 'account-private-sentinel', toolkit: 'gmail', status: 'ACTIVE', revision: 3, isDefault: true }]);
    };
    const { db } = await import('./server/src/db.ts');
    await import('./server/src/agent/jobs.ts');
    const { connectionState, CONNECTION_STATE_TIMEOUT_MS } = await import('./server/src/agent/connection-state.ts');
    const { withSessionContext } = await import('./server/src/security/request-context.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('${tenant}', 'owner@test.invalid', 'Owner', Date.now());
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('own-bot', '${tenant}', 'Quinn', Date.now(), Date.now());
    const inspect = () => withSessionContext('owner-session-hash', () => connectionState('${tenant}', 'own-bot'));
    await assert.rejects(connectionState('another-owner', 'own-bot'), /unavailable/);
    await assert.rejects(connectionState('${tenant}', 'missing-bot'), /unavailable/);
    assert.equal(requests.length, 0);
    const available = await inspect();
    assert.equal(available.status, 'available');
    assert.equal(available.scope, 'registered_active_accounts');
    assert.deepEqual(available.connectedToolkits, ['gmail']);
    assert.equal(available.totalAccounts, 1);
    assert.equal(available.services[0].status, 'connected');
    assert.doesNotMatch(JSON.stringify(available), /sentinel|private.invalid|owner-session|revision|isDefault/);
    mode = 'error';
    const failure = await inspect();
    assert.equal(failure.status, 'unknown');
    assert.equal(failure.reason, 'provider_unavailable');
    for (const field of ['connectedToolkits', 'services', 'activeToolkitCount', 'totalAccounts']) assert.equal(failure[field], null);
    assert.doesNotMatch(JSON.stringify(failure), /sentinel|private.invalid/);
    mode = 'slow';
    const start = performance.now();
    const timeout = await inspect();
    const elapsed = performance.now() - start;
    assert.equal(CONNECTION_STATE_TIMEOUT_MS, 1500);
    assert.ok(elapsed >= 1400 && elapsed < 4000, 'Deadline elapsed: ' + elapsed);
    assert.equal(timeout.status, 'unknown');
    assert.equal(timeout.reason, 'timeout');
    assert.equal(timeout.connectedToolkits, null);
    assert.equal(signals.at(-1).aborted, true, 'Caller cancellation reaches the tenant HTTP fetch');
    assert.equal(requests.length, 3, 'No retries, authorization or tool execution');
    assert.equal(db.prepare('SELECT count(*) n FROM agent_jobs').get().n, 0);
    db.close();
    console.log('tenant connection snapshot verified');
  `;
  const childEnv = { ...process.env, NODE_ENV: 'test', SWARM_ROLE: 'tenant', SWARM_TENANT_ID: tenant, SWARM_VOLUME_ID: 'test-volume',
    TENANT_MANIFEST_FILE: manifest, TENANT_DATA_KEY_FILE: path.join(root, 'unused-key'), DB_PATH: path.join(root, 'tenant.db'),
    FILES_DIR: path.join(root, 'files'), COMPOSIO_GATEWAY_URL: 'https://gateway.test', RUNTIME_TOKEN_FILE: '/run/swarm/test-token',
    COMPUTER_PROVIDER: 'local', SESSION_SECRET: 'connection-state-test', INKBOX_TUNNEL: '0' };
  for (const name of ['COMPOSIO_API_KEY', 'COMPOSIO_WEBHOOK_SECRET', 'FLY_API_TOKEN', 'DATABASE_URL', 'MIGRATION_DATABASE_URL',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'INKBOX_ADMIN_API_KEY', 'INKBOX_API_KEY', 'DIRECT_API_KEY',
    'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GOOGLE_CLIENT_SECRET', 'APPLE_PRIVATE_KEY']) delete childEnv[name];
  try {
    assert.match(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: childEnv, encoding: 'utf8', timeout: 15_000,
    }), /tenant connection snapshot verified/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
