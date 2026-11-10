import assert from 'node:assert/strict';
import { after, afterEach, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-image-test-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'isolated-image-test', COMPUTER_PROVIDER: 'cloudvm', VM_DRIVER: 'fake', VM_IMAGE: 'test-image:v2', FLY_API_TOKEN: '', COMPOSIO_API_KEY: '' });
const { db } = await import('../server/src/db.js');
const { driver, suspendVm, vmFor } = await import('../server/src/computers/cloudvm.js');
afterEach(() => mock.restoreAll());
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function seed(id: string, image: string) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
  db.prepare('INSERT INTO vms(vm_id,user_id,driver,ext_id,volume_id,status,image,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`vm-${id}`, id, 'fake', `machine-${id}`, `disk-${id}`, 'running', image, Date.now(), Date.now());
}

test('image upgrades stop the VM first and preserve its machine and persistent disk', async () => {
  seed('upgrade', 'test-image:v1');
  const calls: string[] = [];
  mock.method(driver, 'stop', async id => {
    assert.equal(id, 'machine-upgrade');
    assert.equal(vmFor('upgrade')?.status, 'suspending');
    calls.push('stop');
  });
  mock.method(driver, 'setImage', async (id, image) => {
    assert.deepEqual(calls, ['stop']);
    assert.equal(id, 'machine-upgrade');
    assert.equal(image, 'test-image:v2');
    assert.equal(vmFor('upgrade')?.image, 'test-image:v1');
    calls.push('setImage');
  });
  await suspendVm('upgrade', 'idle');
  const vm = vmFor('upgrade')!;
  assert.deepEqual(calls, ['stop', 'setImage']);
  assert.equal(vm.status, 'stopped');
  assert.equal(vm.image, 'test-image:v2');
  assert.equal(vm.ext_id, 'machine-upgrade');
  assert.equal(vm.volume_id, 'disk-upgrade');
});

test('a current-image VM uses normal suspend without an image update', async () => {
  seed('current', 'test-image:v2');
  const suspend = mock.method(driver, 'suspend', async () => {});
  const update = mock.method(driver, 'setImage', async () => { throw new Error('unexpected image update'); });
  await suspendVm('current', 'idle');
  assert.equal(suspend.mock.callCount(), 1);
  assert.equal(update.mock.callCount(), 0);
  assert.equal(vmFor('current')?.status, 'suspended');
});

test('a failed provider update never records the new image or discards the persistent disk', async () => {
  seed('failed', 'test-image:v1');
  mock.method(driver, 'stop', async () => {});
  mock.method(driver, 'setImage', async () => { throw new Error('provider unavailable'); });
  await assert.rejects(suspendVm('failed', 'idle'), /provider unavailable/);
  assert.equal(vmFor('failed')?.image, 'test-image:v1');
  assert.equal(vmFor('failed')?.volume_id, 'disk-failed');
});
