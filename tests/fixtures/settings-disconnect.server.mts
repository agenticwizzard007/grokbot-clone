// Local-only backend for QA SO E-02. Provider state is stored in the temporary test DB.
import assert from 'node:assert/strict';
import { mock } from 'node:test';

assert.equal(process.env.DEV_LOGIN, '1');
assert.equal(process.env.NODE_ENV, 'test');
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev' && url.pathname === '/api/v3.1/toolkits') {
    return Response.json({ items: [{ slug: 'gmail', name: 'Gmail', meta: { description: 'Fixture email accounts', categories: [] }, composio_managed_auth_schemes: ['OAUTH2'] }] });
  }
  if (url.origin === 'http://model.invalid' && url.pathname === '/v1/models') return Response.json({ data: [] });
  throw new Error('Unexpected backend request blocked by the disconnect fixture');
});
const { db } = await import('../../server/src/db.js');
db.exec(`
  CREATE TABLE fixture_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
  CREATE TABLE fixture_deletes (id TEXT NOT NULL);
  CREATE TABLE fixture_control (fail INTEGER NOT NULL, hold INTEGER NOT NULL);
  INSERT INTO fixture_control VALUES (0, 0);
`);
const { composio } = await import('../../server/src/composio.js');
mock.method(composio().connectedAccounts, 'list', async (query: { userIds: string[] }) => ({
  items: db.prepare('SELECT id FROM fixture_accounts WHERE user_id = ? ORDER BY id').all(query.userIds[0]).map((row: any) => ({ id: row.id, toolkit: { slug: 'gmail' }, status: 'ACTIVE' })),
  nextCursor: null,
}));
mock.method(composio().connectedAccounts, 'delete', async (id: string) => {
  db.prepare('INSERT INTO fixture_deletes VALUES (?)').run(id);
  while ((db.prepare('SELECT hold FROM fixture_control').get() as any).hold) await new Promise(resolve => setTimeout(resolve, 20));
  if ((db.prepare('SELECT fail FROM fixture_control').get() as any).fail) throw new Error('Fixture disconnect unavailable');
  assert.equal(db.prepare('DELETE FROM fixture_accounts WHERE id = ?').run(id).changes, 1);
  return { success: true };
});
await import('../../server/src/index.js');
