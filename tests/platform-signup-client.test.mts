import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../web/src/lib/api.ts';
import { configApi } from '../web/src/lib/configApi.ts';

const settings = { mode: 'invite' as const, signupsPerDay: 10, memberInvites: 2, revision: 'fixture-revision' };

test('SO D-03: missing signup routes and the standalone HTML fallback are not admin surfaces', async t => {
  for (const response of [
    new Response('<!doctype html><html><body>Swarm</body></html>', { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
    new Response('<html>Swarm</html>', { headers: { 'Content-Type': 'Text/HTML' } }),
    new Response('Not Found', { status: 404 }),
    Response.json({ error: 'Not found' }, { status: 404 }),
  ]) {
    const fetch = t.mock.method(globalThis, 'fetch', async (input, init) => {
      assert.equal(input, '/api/platform/signup');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.credentials, 'include');
      return response;
    });
    assert.deepEqual(await configApi.platformSignup(), { admin: false });
    assert.equal(response.bodyUsed, true, 'Absent admin surfaces release the response body');
    fetch.mock.restore();
  }
});

test('SO D-03: platform admin discovery and non-admin responses are preserved', async t => {
  for (const body of [{ admin: true, settings }, { admin: false }]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(body));
    assert.deepEqual(await configApi.platformSignup(), body);
    fetch.mock.restore();
  }
});

test('SO D-03: authentication and service failures remain actionable', async t => {
  for (const status of [401, 403, 500, 503]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Signup unavailable' }, { status }));
    await assert.rejects(configApi.platformSignup(), error => error instanceof ApiError && error.status === status && error.message === 'Signup unavailable');
    fetch.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Unavailable</html>', { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(configApi.platformSignup(), error => error instanceof ApiError && error.status === 503 && error.message === 'Service Unavailable');
});

test('SO D-03: malformed JSON and network failures are not mistaken for absent administration', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(configApi.platformSignup(), SyntaxError);
  fetch.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Network unavailable'); });
  await assert.rejects(configApi.platformSignup(), /Network unavailable/);
});

test('SO D-03: signup writes and ordinary messaging reads retain normal error handling', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Not found' }, { status: 404 }));
  await assert.rejects(configApi.savePlatformSignup(settings), error => error instanceof ApiError && error.status === 404);
  await assert.rejects(configApi.messaging(), error => error instanceof ApiError && error.status === 404);
});
