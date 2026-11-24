import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import http2 from 'node:http2';
import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { compress } from 'hono/compress';
import type { Row, ServerEvent } from '../server/src/types.js';

const root = mkdtempSync(path.join(tmpdir(), 'sse-stream-'));
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'sse-local-fixture', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '',
});
// All model and toolkit network traffic is disabled in this API fixture.
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected backend request'); });
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api, SseQueue, SSE_QUEUE_CAP, SSE_HEARTBEAT_MS } = await import('../server/src/routes.js');
const { hub } = await import('../server/src/lib/hub.js');
const { securityHeaders, withHeadSupport } = await import('../server/src/security/request.js');
const { revokeSession } = await import('../server/src/lib/auth.js');
const app = new Hono();
app.use('*', securityHeaders);
// Guard against future compression middleware as well as proxy transformations.
app.use('*', compress({ threshold: 0 }));
app.route('/api', api);
const servers: ReturnType<typeof serve>[] = [];
const cookies: Record<string, string> = {}, users: Record<string, string> = {};

before(async () => {
  for (const fixture of ['http1', 'http2', 'burst', 'overflow', 'revoked']) {
    const login = await app.request('/api/auth/dev', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${fixture}@example.test`, name: 'SSE fixture' }),
    });
    assert.equal(login.status, 200);
    cookies[fixture] = login.headers.get('set-cookie')!.split(';')[0];
    users[fixture] = ((await (await app.request('/api/auth/me', { headers: { cookie: cookies[fixture] } })).json()) as any).user.id;
  }
});
after(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  mock.restoreAll(); db.close(); rmSync(root, { recursive: true, force: true });
});

function frames() {
  let buffer = '', failure: Error | undefined;
  const pending: { resolve: (ev: ServerEvent) => void; reject: (error: Error) => void }[] = [];
  const events: ServerEvent[] = [];
  return {
    push(chunk: Buffer | string) {
      buffer += chunk.toString();
      for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        assert.match(frame, /^data: /);
        const event = JSON.parse(frame.slice(6));
        const waiter = pending.shift();
        if (waiter) waiter.resolve(event); else events.push(event);
      }
    },
    fail(error: Error) { failure = error; for (const waiter of pending.splice(0)) waiter.reject(error); },
    async next(ms = 1500): Promise<ServerEvent> {
      if (failure) throw failure;
      if (events.length) return events.shift()!;
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([
          new Promise<ServerEvent>((resolve, reject) => pending.push({ resolve, reject })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSE frame was not flushed')), ms); }),
        ]);
      } finally { clearTimeout(timer!); }
    },
  };
}

for (const protocol of ['http1', 'http2'] as const) {
  test(`SSE headers and heartbeats arrive uncompressed over ${protocol}`, { timeout: 40_000 }, async () => {
    const server = serve({ fetch: withHeadSupport(app.fetch), hostname: '127.0.0.1', port: 0,
      ...(protocol === 'http2' ? { createServer: http2.createServer as any } : {}),
    });
    servers.push(server);
    if (!server.listening) await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const received = frames();
    const client = protocol === 'http2' ? http2.connect(base) : undefined;
    const request = client ? client.request({ ':path': '/api/events', cookie: cookies[protocol], 'accept-encoding': 'gzip, deflate, br' })
      : http.get(`${base}/api/events`, { headers: { cookie: cookies[protocol], 'accept-encoding': 'gzip, deflate, br' } });
    request.on('error', error => received.fail(error));
    client?.on('error', error => received.fail(error));
    const started = Date.now();
    try {
      const response = await new Promise<any>((resolve, reject) => {
        request.once('error', reject);
        request.once('response', response => {
          const readable = client ? request : response;
          readable.on('data', (chunk: Buffer) => received.push(chunk));
          readable.on('end', () => received.fail(new Error('SSE ended while idle')));
          readable.on('error', (error: Error) => received.fail(error));
          resolve(client ? response : response.headers);
        });
        client && request.end();
      });
      assert.equal(response['cache-control'], 'no-cache, no-transform');
      assert.equal(response['x-accel-buffering'], 'no');
      assert.equal(response['content-encoding'], 'identity');
      assert.equal(response['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(response['content-length'], undefined);
      if (client) for (const header of ['connection', 'transfer-encoding', 'keep-alive']) assert.equal(response[header], undefined);
      assert.equal((await received.next()).type, 'hello');
      assert.ok(Date.now() - started < 1500, 'headers and greeting arrive immediately');
      // Keep the event stream open while another authenticated request shares the connection.
      const rosterStarted = Date.now();
      const roster = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const other = client ? client.request({ ':path': '/api/bots', cookie: cookies[protocol] })
          : http.get(`${base}/api/bots`, { headers: { cookie: cookies[protocol] } });
        other.once('error', reject);
        other.once('response', response => {
          let body = '';
          const readable = client ? other : response;
          readable.on('data', chunk => { body += chunk; });
          readable.once('end', () => resolve({ status: client ? response[':status'] : response.statusCode, body }));
        });
        if (client) other.end();
      });
      assert.equal(roster.status, 200);
      assert.ok(Array.isArray(JSON.parse(roster.body).bots));
      assert.ok(Date.now() - rosterStarted < 1500, 'SSE does not block the roster request');
      assert.ok(SSE_HEARTBEAT_MS <= 10_000);
      for (let i = 0; i < 3; i++) {
        const previous = Date.now();
        assert.deepEqual(await received.next(12_000), { type: 'ping' });
        assert.ok(Date.now() - previous < 12_000, 'idle bytes arrive before a short proxy deadline');
      }
    } finally {
      request.destroy(); client?.destroy();
    }
  });
}

const rowEvent = (seq: number, revision = seq, generation = 1): ServerEvent => ({ type: 'rows', botId: 'burst-bot', generation,
  rows: [{ botId: 'burst-bot', generation, seq, updatedSeq: revision, kind: 'message',
    body: { type: 'message', role: 'assistant', text: `Fixture ${revision}` }, createdAt: seq } as Row],
});

test('P-01 retains 5000 distinct rows and coalesces only matching row generations and snapshots', () => {
  const queue = new SseQueue();
  assert.equal(SSE_QUEUE_CAP, 5000);
  for (let seq = 1; seq <= SSE_QUEUE_CAP; seq++) assert.equal(queue.push(rowEvent(seq)), true);
  assert.equal(queue.push(rowEvent(1, 9000)), true, 'a replacement still fits at capacity');
  assert.equal(queue.push(rowEvent(1, 1, 2)), false, 'a new generation is a distinct event');
  for (let seq = 2; seq <= SSE_QUEUE_CAP; seq++) assert.deepEqual(JSON.parse(queue.shift()!), rowEvent(seq));
  assert.deepEqual(JSON.parse(queue.shift()!), rowEvent(1, 9000));
  for (let i = 0; i < SSE_QUEUE_CAP * 2; i++) assert.equal(queue.push({ type: 'roster' }), true);
  assert.equal(queue.length, 1);
});

test('P-01 sends an entire retained burst to a slow reader in order', { timeout: 10_000 }, async () => {
  const response = await app.request('/api/events', { headers: { cookie: cookies.burst } });
  assert.equal(response.headers.get('connection'), null, 'application does not force protocol framing');
  assert.equal(response.headers.get('transfer-encoding'), null);
  const reader = response.body!.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"hello"/);
    for (let seq = 1; seq <= SSE_QUEUE_CAP; seq++) hub.emit(users.burst, rowEvent(seq));
    assert.equal(hub.isOnline(users.burst), true);
    for (let seq = 1; seq <= SSE_QUEUE_CAP; seq++) {
      const frame = new TextDecoder().decode((await reader.read()).value);
      assert.deepEqual(JSON.parse(frame.slice(6).trim()), rowEvent(seq));
    }
  } finally { await reader.cancel(); }
  assert.equal(hub.isOnline(users.burst), false);
});

test('overflow and session revocation release a subscriber and its idle wait', async () => {
  for (const fixture of ['overflow', 'revoked']) {
    const response = await app.request('/api/events', { headers: { cookie: cookies[fixture] } });
    const reader = response.body!.getReader();
    await reader.read();
    if (fixture === 'overflow') {
      for (let seq = 1; seq <= SSE_QUEUE_CAP + 2; seq++) hub.emit(users[fixture], rowEvent(seq));
    } else {
      const row = db.prepare('SELECT token FROM auth_sessions WHERE user_id=?').get(users[fixture]) as { token: string };
      revokeSession(row.token);
    }
    assert.equal(hub.isOnline(users[fixture]), false);
    await reader.cancel();
  }
});
