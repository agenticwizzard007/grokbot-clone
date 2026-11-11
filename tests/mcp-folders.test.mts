import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { mcpFoldersSchema, openMcpFolder } from '../server/src/security/mcp-folders.js';
import { McpFolderLease, type FolderMountDriver } from '../server/src/runtime/mcp-folders.js';
import { containerArguments } from '../server/src/runtime/container-policy.js';
import { attachSupervisor } from '../server/src/runtime/supervisor.js';

const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(done => setTimeout(done, 5)); }
  throw new Error('Timed out waiting for runner state.');
}
function filesystem(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mcp-folders-'));
  const files = path.join(root, 'files');
  fs.mkdirSync(path.join(files, 'bot_owned/docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'subscriptions'), { recursive: true });
  fs.writeFileSync(path.join(files, 'bot_owned/docs/selected'), 'owner-chosen-data');
  fs.writeFileSync(path.join(root, 'subscriptions/secret'), 'must-not-be-mounted');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, files };
}

test('folder selections reject traversal, flags, absolute paths, overlap and unbounded grants', () => {
  assert.deepEqual(mcpFoldersSchema.parse(undefined), []);
  for (const value of ['/etc', '../subscriptions', 'bot/../app', 'bot//x', 'bot/.', 'bot/\\..', 'bot/\0key', 'bot/\nkey', '--mount,src=/data', 'bot/' + 'a'.repeat(256)]) assert.throws(() => mcpFoldersSchema.parse([value]));
  for (const value of [['bot/a', 'bot/a'], ['bot/a', 'bot/a/b'], Array.from({ length: 9 }, (_, i) => `bot/${i}`)]) assert.throws(() => mcpFoldersSchema.parse(value));
  assert.deepEqual(mcpFoldersSchema.parse(['bot/My notes', 'bot/comma,name']), ['bot/My notes', 'bot/comma,name']);
});

test('directory walking rejects final and intermediate symlinks and non-directories', t => {
  const { root, files } = filesystem(t);
  fs.symlinkSync(path.join(root, 'subscriptions'), path.join(files, 'bot_owned/link'));
  fs.symlinkSync(path.join(files, 'bot_owned'), path.join(files, 'alias'));
  for (const folder of ['bot_owned/link', 'bot_owned/link/secret', 'alias/docs', 'bot_owned/docs/selected', '../subscriptions']) assert.throws(() => openMcpFolder(files, folder));
  const fd = openMcpFolder(files, 'bot_owned/docs');
  try { assert.equal(fs.readFileSync(`/proc/self/fd/${fd}/selected`, 'utf8'), 'owner-chosen-data'); }
  finally { fs.closeSync(fd); }
});

test('host mount pins selected inode across a pathname replacement and uses no workload path in Docker', async t => {
  const { root, files } = filesystem(t), name = `swarm-${randomUUID()}`;
  let descriptor = '';
  const driver: FolderMountDriver = {
    async bind(source) {
      descriptor = source;
      fs.renameSync(path.join(files, 'bot_owned/docs'), path.join(files, 'bot_owned/original'));
      fs.symlinkSync(path.join(root, 'subscriptions'), path.join(files, 'bot_owned/docs'));
      assert.equal(fs.readFileSync(`${source}/selected`, 'utf8'), 'owner-chosen-data');
      assert.equal(fs.existsSync(`${source}/secret`), false);
    }, async unmount() {},
  };
  const lease = new McpFolderLease(files, ['bot_owned/docs'], name, driver, path.join(root, 'mounts'));
  await lease.prepare();
  assert.match(descriptor, new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
  assert.equal(fs.existsSync(descriptor), false, 'descriptor closes only after bind returns');
  const image = 'sha256:' + 'a'.repeat(64);
  const args = containerArguments({ tenantId: 'usr_folder_owner', root, runnerImage: image, mcpImage: image, network: 'swarm-public' }, { kind: 'mcp', id: 'mcp_folder_test', folderCount: 1 }, name);
  assert.ok(args.includes(`type=bind,src=/run/swarm-host/mcp-folders/${name}/1,dst=/workspace/folders/1,readonly,bind-recursive=disabled`));
  assert.equal(args.some(arg => arg.includes('bot_owned') || arg.includes('subscriptions')), false);
  await lease.close(); assert.equal(fs.existsSync(lease.directory), false);
});

test('partial mount failures retain cleanup ownership until every unmount is confirmed', async t => {
  const { root, files } = filesystem(t);
  fs.mkdirSync(path.join(files, 'bot_owned/second'));
  let failUnmount = true; const mounted: string[] = [], removed: string[] = [];
  const driver: FolderMountDriver = {
    async bind(_source, destination) { mounted.push(destination); if (mounted.length === 2) throw new Error('remount failed after bind'); },
    async unmount(destination) { if (failUnmount) throw new Error('busy mount'); removed.push(destination); },
  };
  const lease = new McpFolderLease(files, ['bot_owned/docs', 'bot_owned/second'], `swarm-${randomUUID()}`, driver, path.join(root, 'mounts'));
  await assert.rejects(lease.prepare(), /remount failed/);
  await assert.rejects(lease.close(), /busy mount/);
  assert.equal(fs.existsSync(lease.directory), true);
  failUnmount = false; await lease.close();
  assert.deepEqual(removed, [...mounted].reverse());
  assert.equal(fs.existsSync(lease.directory), false);
  await lease.close();
});

test('host mount staging refuses a writable or symlinked root', async t => {
  const { root, files } = filesystem(t), mounts = path.join(root, 'mounts');
  let called = false; const driver = { async bind() { called = true; }, async unmount() {} };
  fs.mkdirSync(mounts, { mode: 0o777 }); fs.chmodSync(mounts, 0o777);
  await assert.rejects(new McpFolderLease(files, ['bot_owned/docs'], `swarm-${randomUUID()}`, driver, mounts).prepare(), /Unsafe/);
  fs.rmdirSync(mounts); fs.symlinkSync(files, mounts);
  await assert.rejects(new McpFolderLease(files, ['bot_owned/docs'], `swarm-${randomUUID()}`, driver, mounts).prepare(), /Unsafe/);
  assert.equal(called, false);
});

async function supervisorFixture(t: any) {
  const { root, files } = filesystem(t), workers: any[] = [], frames: any[] = [], clients: WebSocket[] = [], removals: string[] = [], unmounts: string[] = [];
  const hold = defer(); let holdMount = true, failRemoval = false, failures = 0, mountStarted = false;
  const server = http.createServer();
  const policy = { tenantId: 'usr_folder_owner', root, runnerImage: 'sha256:' + 'a'.repeat(64), mcpImage: 'sha256:' + 'b'.repeat(64), network: 'swarm-public' };
  const supervisor = attachSupervisor(server, policy, {
    start(args) {
      const child = new EventEmitter() as any; child.stdout = new PassThrough();
      child.stdin = new Writable({ write(_data, _encoding, cb) { child.stdout.write('{"type":"ready"}\n'); cb(); } });
      child.kill = () => true; workers.push({ args, child }); return child;
    },
    async remove(name) { removals.push(name); if (failRemoval) throw new Error('container still running'); }, async resetProfile() {},
  }, { mounts: { root: path.join(root, 'mounts'), driver: {
    async bind(source) { mountStarted = true; assert.equal(fs.existsSync(`${source}/selected`), true); if (holdMount) await hold.promise; },
    async unmount(destination) { unmounts.push(destination); },
  } }, onBoundaryFailure: () => { failures++; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { hold.resolve(); failRemoval = false; for (const ws of clients) ws.terminate(); await supervisor.close(); await new Promise<void>(done => server.close(() => done())); });
  async function open() {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/mcp`); clients.push(ws);
    ws.on('error', () => {}); ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    ws.send(JSON.stringify({ tenantId: policy.tenantId, id: 'mcp_folder_owner', revision: 1, config: { command: 'server', args: [], folders: ['bot_owned/docs'] } }));
    return ws;
  }
  return { open, workers, frames, removals, unmounts, hold, files, supervisor, get mountStarted() { return mountStarted; }, get failures() { return failures; }, unhold: () => { holdMount = false; hold.resolve(); }, setFailRemoval: (value: boolean) => { failRemoval = value; } };
}

test('cancellation during folder preparation never starts a container and waits for mount cleanup', async t => {
  const f = await supervisorFixture(t), ws = await f.open();
  await until(() => f.mountStarted); ws.terminate();
  const stopping = f.supervisor.close();
  await new Promise(done => setTimeout(done, 10)); assert.equal(f.unmounts.length, 0);
  f.unhold(); await stopping;
  assert.equal(f.workers.length, 0); assert.equal(f.unmounts.length, 1);
});

test('failed container revocation keeps folder mounts owned, closes admission and signals host shutdown', async t => {
  const f = await supervisorFixture(t); f.unhold(); const ws = await f.open();
  await until(() => f.frames.length === 1); f.setFailRemoval(true); ws.terminate();
  await until(() => f.failures > 0);
  assert.equal(f.unmounts.length, 0);
  await assert.rejects(f.open()); assert.equal(f.workers.length, 1);
  f.setFailRemoval(false); await f.supervisor.close();
  assert.equal(f.unmounts.length, 1);
});
