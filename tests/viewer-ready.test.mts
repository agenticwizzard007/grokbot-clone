import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-viewer-ready-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: root, SESSION_SECRET: 'viewer-test', COMPUTER_PROVIDER: 'cloudvm' });
const { db } = await import('../server/src/db.js');
const { attachCompanionSocket, createPairing, localProvider } = await import('../server/src/computers/local.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('viewer-user', 'viewer@example.com', 'Viewer', Date.now());
const server = http.createServer();
attachCompanionSocket(server);
const viewers = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/viewer') viewers.handleUpgrade(req, socket, head, ws => { void localProvider.viewer!(ws, 'viewer-user', 'viewer-bot', 'watch'); });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
const companion = new WebSocket(`${origin}/api/companion`);
await once(companion, 'open');
const welcome = once(companion, 'message');
companion.send(JSON.stringify({ type: 'hello', token: createPairing('viewer-user'), mode: 'multi', width: 1920, height: 1080 }));
await welcome;
const requests: any[] = [];
companion.on('message', raw => { requests.push(JSON.parse(raw.toString())); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function request() {
  const end = Date.now() + 3000;
  while (!requests.length && Date.now() < end) await sleep(10);
  assert.ok(requests.length, 'companion receives a request');
  return requests.shift();
}
function reply(req: any, result: unknown) { companion.send(JSON.stringify({ id: req.id, result })); }
after(async () => {
  for (const ws of viewers.clients) ws.terminate();
  companion.terminate();
  viewers.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('the cloud viewer stays loading until Chrome and Playwright are ready', async () => {
  const viewer = new WebSocket(`${origin}/viewer`);
  const messages: Buffer[] = [];
  viewer.on('message', raw => { messages.push(Buffer.from(raw as Buffer)); });
  await once(viewer, 'open');
  const prepare = await request();
  assert.equal(prepare.method, 'browser');
  assert.deepEqual(prepare.params, { botId: 'viewer-bot', tool: 'browser_tabs', args: { action: 'list' } });
  await sleep(100);
  assert.equal(messages.length, 0, 'no RFB ready signal while browser startup is pending');
  assert.equal(requests.length, 0, 'no premature desktop screenshot');
  reply(prepare, { content: [], isError: false });
  const screenshot = await request();
  assert.equal(screenshot.method, 'screenshot');
  const greeting = once(viewer, 'message');
  reply(screenshot, { data: Buffer.from([255, 216, 255, 217]).toString('base64') });
  assert.equal((await greeting)[0].toString(), 'RFB 003.008\n');
  viewer.close();
  await once(viewer, 'close');
});

test('failed browser readiness is retryable instead of displaying an empty desktop', async () => {
  const viewer = new WebSocket(`${origin}/viewer`);
  await once(viewer, 'open');
  const prepare = await request();
  const closed = once(viewer, 'close');
  reply(prepare, { content: [], isError: true });
  const [code] = await closed;
  assert.equal(code, 1011);
  assert.equal(requests.length, 0, 'failed preparation never captures or starts streaming');
});

test('closing the viewer during startup does not capture or stream afterwards', async () => {
  const viewer = new WebSocket(`${origin}/viewer`);
  await once(viewer, 'open');
  const prepare = await request();
  viewer.close();
  await once(viewer, 'close');
  reply(prepare, { content: [], isError: false });
  await sleep(100);
  assert.equal(requests.length, 0);
});
