import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, beforeEach, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-expired-connections-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'expired-connections-test-only', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: '', COMPOSIO_ORG_ID: '', COMPOSIO_PROJECT_ID: '',
  SWARM_ROLE: 'standalone', NODE_ENV: 'test', ADMIN_EMAILS: '', ADMIN_PHONES: '',
});
let providerFetch: ((url: URL, init?: RequestInit) => Promise<Response>) | undefined;
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  assert.equal(url.hostname, 'backend.composio.dev', 'No real network calls are permitted');
  if (providerFetch) return providerFetch(url, init);
  throw new Error('Unexpected provider request: tests must mock every account operation');
});
const { db } = await import('../server/src/db.js');
const { setEnvOverride } = await import('../server/src/env.js');
const {
  composio, connectionsDetail, manageConnection, removeExpiredConnection, ExpiredConnectionRemovalError,
} = await import('../server/src/composio.js');
for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
}

type Account = { id: string; status: string; toolkit: { slug: string }; experimental?: { accountType: string } };
const account = (id: string, status = 'EXPIRED', accountType = 'PRIVATE'): Account => ({
  id, status, toolkit: { slug: 'gmail' }, experimental: { accountType },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
let sequence = 0, client: ReturnType<typeof composio>;
let accounts: Record<string, Account[]>;
let lists: any[], deletes: string[];
let listHook: ((query: any) => Promise<any>) | undefined;
let deleteHook: ((id: string, options: any) => Promise<any>) | undefined;
let rawDelete: (id: string, options?: any) => Promise<any>;
beforeEach(() => {
  setEnvOverride('COMPOSIO_ORG_ID', null);
  setEnvOverride('COMPOSIO_PROJECT_ID', null);
  setEnvOverride('COMPOSIO_API_KEY', `expired-test-project-${++sequence}`);
  client = composio();
  accounts = {}; lists = []; deletes = []; listHook = undefined; deleteHook = undefined; providerFetch = undefined;
  db.exec('DELETE FROM composio_sessions');
  rawDelete = client.connectedAccounts.delete.bind(client.connectedAccounts);
  mock.method(client.connectedAccounts, 'list', async (query: any) => {
    lists.push(query);
    assert.deepEqual(query.userIds.length, 1);
    assert.equal(query.accountType, 'PRIVATE');
    assert.equal(query.statuses, undefined, 'Read current state, including ACTIVE and pending accounts');
    const response = await listHook?.(query);
    if (response !== undefined) return response;
    const items = (accounts[query.userIds[0]] ?? []).filter(item => item.experimental?.accountType !== 'SHARED');
    const offset = Number(query.cursor ?? 0);
    return structuredClone({ items: items.slice(offset, offset + 100), nextCursor: offset + 100 < items.length ? String(offset + 100) : null });
  });
  mock.method(client.connectedAccounts, 'get', async () => { throw new Error('Never retrieve an unscoped account'); });
  mock.method(client.connectedAccounts, 'delete', async (id: string, options: any) => {
    deletes.push(id);
    if (deleteHook) return deleteHook(id, options);
    for (const user of Object.keys(accounts)) accounts[user] = accounts[user].filter(item => item.id !== id);
    return { success: true };
  });
});
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function refusal(promise: Promise<unknown>, code: InstanceType<typeof ExpiredConnectionRemovalError>['code']) {
  await assert.rejects(promise, (error: any) => {
    assert.ok(error instanceof ExpiredConnectionRemovalError);
    assert.equal(error.name, 'ExpiredConnectionRemovalError');
    assert.equal(error.code, code);
    assert.equal(error.status, code === 'not_expired' ? 409 : 503);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /SECRET|token|oauth\.example|expired-test-project/);
    return true;
  });
}

test('deletes only the exact owned PRIVATE EXPIRED account and invalidates only its user session', async () => {
  accounts.owner = [account('selected'), account('other-expired'), account('active', 'ACTIVE'), account('shared', 'EXPIRED', 'SHARED')];
  accounts.other = [account('foreign')];
  for (const userId of ['owner', 'other']) db.prepare('INSERT INTO composio_sessions(user_id,session_id) VALUES (?,?)').run(userId, `${userId}-session`);
  assert.deepEqual(await removeExpiredConnection('owner', 'selected'), { removed: true });
  assert.deepEqual(deletes, ['selected']);
  assert.deepEqual(accounts.owner.map(item => item.id), ['other-expired', 'active', 'shared']);
  assert.equal(lists.length, 2);
  assert.ok(lists.every(query => query.userIds[0] === 'owner'));
  assert.equal(db.prepare('SELECT 1 FROM composio_sessions WHERE user_id=?').get('owner'), undefined);
  assert.ok(db.prepare('SELECT 1 FROM composio_sessions WHERE user_id=?').get('other'));
});

test('both fresh ownership checks follow PRIVATE user-scoped pagination', async () => {
  accounts.owner = Array.from({ length: 205 }, (_, i) => account(`owned-${i}`));
  assert.deepEqual(await removeExpiredConnection('owner', 'owned-204'), { removed: true });
  assert.deepEqual(lists.map(query => query.cursor), [undefined, '100', '200', undefined, '100', '200']);
  assert.ok(lists.every(query => query.userIds[0] === 'owner' && query.accountType === 'PRIVATE'));
  assert.deepEqual(deletes, ['owned-204']);
});

test('missing, foreign, shared and toolkit IDs are indistinguishable no-ops without a provider delete', async () => {
  accounts.owner = [account('own-expired'), account('shared', 'EXPIRED', 'SHARED')];
  accounts.other = [account('foreign')];
  for (const id of ['missing', 'foreign', 'shared', 'gmail']) {
    assert.deepEqual(await removeExpiredConnection('owner', id), { removed: false });
  }
  assert.deepEqual(deletes, []);
  assert.ok(lists.every(query => query.userIds[0] === 'owner'));
});

test('an explicitly SHARED record cannot pass even if a provider list violates its PRIVATE filter', async () => {
  listHook = async () => ({ items: [account('shared', 'EXPIRED', 'SHARED')] });
  assert.deepEqual(await removeExpiredConnection('owner', 'shared'), { removed: false });
  assert.deepEqual(deletes, []);
});

for (const status of ['ACTIVE', 'INITIATED', 'INITIALIZING', 'FAILED', 'INACTIVE', 'REVOKED']) {
  test(`${status} accounts are refused with a sanitized 409 and never deleted`, async () => {
    accounts.owner = [account('selected', status)];
    await refusal(removeExpiredConnection('owner', 'selected'), 'not_expired');
    assert.equal(lists.length, 1);
    assert.deepEqual(deletes, []);
  });
}

test('a previously displayed EXPIRED state is not used as deletion authority', async () => {
  accounts.owner = [account('selected')];
  assert.equal((await connectionsDetail('owner'))[0].status, 'EXPIRED');
  accounts.owner[0].status = 'ACTIVE';
  await refusal(removeExpiredConnection('owner', 'selected'), 'not_expired');
  assert.deepEqual(deletes, []);
});

test('repeated removal is a no-op after a successful delete', async () => {
  accounts.owner = [account('selected')];
  assert.deepEqual(await removeExpiredConnection('owner', 'selected'), { removed: true });
  assert.deepEqual(await removeExpiredConnection('owner', 'selected'), { removed: false });
  assert.deepEqual(deletes, ['selected']);
});

test('concurrent same-ID requests share one delete without sharing ownership with another user', async () => {
  accounts.owner = [account('selected')];
  const started = deferred(), held = deferred();
  deleteHook = async () => { started.resolve(); await held.promise; accounts.owner = []; };
  const removals = Promise.all(Array.from({ length: 8 }, () => removeExpiredConnection('owner', 'selected')));
  try {
    await started.promise;
    assert.deepEqual(await removeExpiredConnection('other', 'selected'), { removed: false });
    assert.deepEqual(deletes, ['selected']);
  } finally { held.resolve(); }
  assert.ok((await removals).every(result => result.removed));
  assert.deepEqual(deletes, ['selected']);
});

for (const status of ['ACTIVE', 'INITIATED', 'INITIALIZING']) {
  test(`state becoming ${status} during revalidation prevents deletion`, async () => {
    accounts.owner = [account('selected')];
    listHook = async () => { if (lists.length === 2) accounts.owner[0].status = status; };
    await refusal(removeExpiredConnection('owner', 'selected'), 'not_expired');
    assert.equal(lists.length, 2);
    assert.deepEqual(deletes, []);
  });
}

test('ownership disappearing during revalidation returns a no-op', async () => {
  accounts.owner = [account('selected')];
  listHook = async () => { if (lists.length === 2) { accounts.other = accounts.owner; accounts.owner = []; } };
  assert.deepEqual(await removeExpiredConnection('owner', 'selected'), { removed: false });
  assert.deepEqual(deletes, []);
});

for (const check of [1, 2]) {
  test(`API key replacement during ownership check ${check} fails closed`, async () => {
    accounts.owner = [account('selected')];
    listHook = async () => { if (lists.length === check) setEnvOverride('COMPOSIO_API_KEY', `changed-project-${sequence}`); };
    await refusal(removeExpiredConnection('owner', 'selected'), 'project_changed');
    assert.deepEqual(deletes, []);
  });
}

test('changing project scope with the same developer key fails closed', async () => {
  setEnvOverride('COMPOSIO_API_KEY', 'uak_expired-test');
  setEnvOverride('COMPOSIO_ORG_ID', 'org-expired-test');
  setEnvOverride('COMPOSIO_PROJECT_ID', 'project-one');
  const scopedClient = composio();
  mock.method(scopedClient.connectedAccounts, 'list', async () => {
    setEnvOverride('COMPOSIO_PROJECT_ID', 'project-two');
    return { items: [account('selected')] };
  });
  const scopedDelete = mock.method(scopedClient.connectedAccounts, 'delete', async () => { throw new Error('Must not delete after a scope change'); });
  await refusal(removeExpiredConnection('owner', 'selected'), 'project_changed');
  assert.equal(scopedDelete.mock.callCount(), 0);
});

test('client replacement and restoration of the old key cannot reuse the captured project', async () => {
  accounts.owner = [account('selected')];
  const oldKey = `expired-test-project-${sequence}`;
  listHook = async () => {
    setEnvOverride('COMPOSIO_API_KEY', 'temporary-other-project');
    composio();
    setEnvOverride('COMPOSIO_API_KEY', oldKey);
  };
  await refusal(removeExpiredConnection('owner', 'selected'), 'project_changed');
  assert.deepEqual(deletes, []);
});

test('a key change during delete does not retry or dispatch against a replacement client', async () => {
  accounts.owner = [account('selected')];
  let replacementDelete: ReturnType<typeof mock.method> | undefined;
  deleteHook = async () => {
    setEnvOverride('COMPOSIO_API_KEY', 'replacement-project');
    replacementDelete = mock.method(composio().connectedAccounts, 'delete', async () => { throw new Error('Wrong project'); });
  };
  await refusal(removeExpiredConnection('owner', 'selected'), 'project_changed');
  assert.deepEqual(deletes, ['selected']);
  assert.equal(replacementDelete!.mock.callCount(), 0);
});

for (const check of [1, 2]) {
  test(`provider failure during ownership check ${check} is sanitized and never deletes`, async () => {
    accounts.owner = [account('selected')];
    listHook = async () => { if (lists.length === check) throw new Error('SECRET token https://oauth.example/private'); };
    await refusal(removeExpiredConnection('owner', 'selected'), 'upstream_unavailable');
    assert.deepEqual(deletes, []);
  });
}

test('a list 404 is an upstream failure, never an owned expired deletion', async () => {
  listHook = async () => { throw Object.assign(new Error('SECRET'), { status: 404 }); };
  await refusal(removeExpiredConnection('owner', 'selected'), 'upstream_unavailable');
  assert.deepEqual(deletes, []);
});

test('a delete 404 is idempotent only after two owned EXPIRED checks', async () => {
  accounts.owner = [account('selected')];
  deleteHook = async () => { throw Object.assign(new Error('SECRET'), { status: 404 }); };
  assert.deepEqual(await removeExpiredConnection('owner', 'selected'), { removed: false });
  assert.equal(lists.length, 2);
  assert.deepEqual(deletes, ['selected']);
});

test('uncertain provider deletes are sanitized, shared by concurrent callers, and never automatically retried', async () => {
  accounts.owner = [account('selected')];
  deleteHook = async (_id, options) => {
    assert.equal(options.maxRetries, 0);
    assert.ok(options.signal instanceof AbortSignal);
    throw Object.assign(new Error('SECRET token https://oauth.example/private'), { status: 503 });
  };
  await Promise.all(Array.from({ length: 5 }, () => refusal(removeExpiredConnection('owner', 'selected'), 'upstream_unavailable')));
  assert.deepEqual(deletes, ['selected']);
  assert.equal(lists.length, 2);
});

test('the SDK transport makes exactly one DELETE request on provider failure', async () => {
  accounts.owner = [account('selected')];
  let attempts = 0;
  providerFetch = async (url, init) => {
    assert.match(url.pathname, /\/connected_accounts\/selected$/);
    assert.equal(init?.method, 'DELETE');
    attempts++;
    return Response.json({ error: { message: 'SECRET provider failure' } }, { status: 503 });
  };
  deleteHook = (id, options) => rawDelete(id, options);
  await refusal(removeExpiredConnection('owner', 'selected'), 'upstream_unavailable');
  assert.equal(attempts, 1);
  assert.deepEqual(deletes, ['selected']);
});

test('an explicit retry after a failed delete freshly rechecks state', async () => {
  accounts.owner = [account('selected')];
  deleteHook = async () => { throw new Error('SECRET uncertain response'); };
  await refusal(removeExpiredConnection('owner', 'selected'), 'upstream_unavailable');
  accounts.owner[0].status = 'ACTIVE';
  await refusal(removeExpiredConnection('owner', 'selected'), 'not_expired');
  assert.deepEqual(deletes, ['selected']);
});

test('malformed pagination fails closed without attempting deletion', async () => {
  listHook = async () => ({ items: [], nextCursor: 'repeated' });
  await refusal(removeExpiredConnection('owner', 'selected'), 'upstream_unavailable');
  assert.equal(lists.length, 2);
  assert.deepEqual(deletes, []);
});

test('disabled or invalid credentials return sanitized 503 errors without provider access', async () => {
  for (const key of ['', 'ck_SECRET']) {
    setEnvOverride('COMPOSIO_API_KEY', key);
    await refusal(removeExpiredConnection('owner', 'selected'), 'upstream_unavailable');
  }
  assert.equal(lists.length, 0);
  assert.deepEqual(deletes, []);
});

test('normal account disconnect still deletes ACTIVE accounts and refuses expired ones', async () => {
  accounts.owner = [account('active', 'ACTIVE'), account('expired')];
  await manageConnection('owner', 'active', 'disconnect');
  await assert.rejects(manageConnection('owner', 'expired', 'disconnect'), /Connection not found/);
  assert.deepEqual(deletes, ['active']);
});

test('tenant cleanup refuses without inventing a gateway endpoint or reading raw provider accounts', () => {
  const moduleUrl = new URL('../server/src/composio.js', import.meta.url).href;
  const dbUrl = new URL('../server/src/db.js', import.meta.url).href;
  const manifest = path.join(root, 'tenant-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ tenantId: 'usr_cleanup_test', volumeId: 'expired-test-volume' }));
  const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    globalThis.fetch = async () => { throw new Error('No gateway/provider request is allowed'); };
    const { removeExpiredConnection, ExpiredConnectionRemovalError } = await import(${JSON.stringify(moduleUrl)});
    await assert.rejects(removeExpiredConnection('usr_cleanup_test', 'selected'), error =>
      error instanceof ExpiredConnectionRemovalError && error.code === 'unsupported' && error.status === 503);
    const { db } = await import(${JSON.stringify(dbUrl)});
    db.close();
    process.stdout.write('tenant-safe');
  `], { encoding: 'utf8', env: { ...process.env, SWARM_ROLE: 'tenant', SWARM_TENANT_ID: 'usr_cleanup_test',
    COMPOSIO_API_KEY: '', DB_PATH: path.join(root, 'tenant.db'), FILES_DIR: path.join(root, 'tenant-files'),
    SWARM_VOLUME_ID: 'expired-test-volume', TENANT_MANIFEST_FILE: manifest, TENANT_DATA_KEY_FILE: path.join(root, 'unused-key') } });
  assert.match(result, /tenant-safe/);
});
