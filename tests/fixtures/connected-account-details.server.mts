// Temporary SQLite and fake providers only. No external requests or account mutations.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
assert.equal(process.env.DEV_LOGIN, '1');
assert.equal(process.env.NODE_ENV, 'test');
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev' && url.pathname === '/api/v3.1/toolkits') return Response.json({ items: [
    { slug: 'gmail', name: 'Gmail', meta: { description: 'Read and send email.', categories: [] }, composio_managed_auth_schemes: ['OAUTH2'] },
    { slug: 'github', name: 'GitHub', meta: { description: 'Work with repositories.', categories: [] }, composio_managed_auth_schemes: ['OAUTH2'] },
  ] });
  if (url.origin === 'http://model.invalid' && url.pathname === '/v1/models') return Response.json({ data: [] });
  throw new Error('External request blocked by account details fixture');
});
const { db } = await import('../../server/src/db.js');
db.exec('CREATE TABLE fixture_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT NOT NULL)');
const { composio } = await import('../../server/src/composio.js');
const client = composio();
mock.method(client.connectedAccounts, 'list', async (query: { userIds: string[]; accountType: string }) => {
  assert.equal(query.accountType, 'PRIVATE');
  return { items: db.prepare('SELECT body FROM fixture_accounts WHERE user_id=? ORDER BY id').all(query.userIds[0]).map((r: any) => JSON.parse(r.body)), nextCursor: null };
});
mock.method(client.connectedAccounts, 'get', async (id: string) => {
  const row = db.prepare('SELECT body FROM fixture_accounts WHERE id=?').get(id) as any;
  assert.ok(row); return JSON.parse(row.body);
});
mock.method(client.tools, 'proxyExecute', async (input: any) => {
  assert.equal(input.endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
  assert.equal(input.method, 'GET');
  const row = db.prepare('SELECT body FROM fixture_accounts WHERE id=?').get(input.connectedAccountId) as any;
  assert.ok(row);
  return { status: 200, data: { emailAddress: 'profile@gmail.com' } };
});
for (const [target, method] of [[client.connectedAccounts, 'delete'], [client.connectedAccounts, 'refresh'], [client.tools, 'execute']] as const) {
  mock.method(target, method as any, async () => { throw new Error('Account mutations forbidden in details fixture'); });
}
await import('../../server/src/index.js');
