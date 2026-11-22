import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIRD_SHAPES } from '../server/src/avatar-shapes.js';
import { BIRD_PATH, BIRD_FORMATIONS } from '../web/src/avatar/birds.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bird-avatars-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'avatar-test-only', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '' });
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { createBot, botCreateSchema, botPatchSchema, AVATAR_SHAPES } = await import('../server/src/bots.js');
const { getBot } = await import('../server/src/store.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.test', 'Owner', Date.now());
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const legacy = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];

test('ten SVG formations retain the official Paper wing path in both themes', () => {
  const official = fs.readFileSync(new URL('../web/public/assets/swarms/flock.svg', import.meta.url), 'utf8');
  assert.equal(BIRD_SHAPES.length, 10);
  assert.ok(official.includes(`d="${BIRD_PATH}"`));
  for (const id of BIRD_SHAPES) {
    for (const suffix of ['', '-night']) {
      const svg = fs.readFileSync(new URL(`../web/public/assets/swarms/avatars/${id}${suffix}.svg`, import.meta.url), 'utf8');
      assert.ok(svg.includes('viewBox="0 0 100 100"'));
      assert.equal([...svg.matchAll(/<path /g)].length, BIRD_FORMATIONS[id].length);
      for (const transform of BIRD_FORMATIONS[id]) assert.ok(svg.includes(`<path transform="${transform}" d="${BIRD_PATH}"`));
      assert.ok(svg.includes(suffix ? '#9BAAF0' : '#3043AB'));
    }
  }
});

test('create and edit accept every bird and all 25 legacy ids, rejecting unknown ids', () => {
  assert.deepEqual(new Set(AVATAR_SHAPES), new Set([...BIRD_SHAPES, ...legacy]));
  for (const avatarShape of [...BIRD_SHAPES, ...legacy]) {
    assert.ok(botCreateSchema.safeParse({ avatarShape }).success, `POST ${avatarShape}`);
    assert.ok(botPatchSchema.safeParse({ avatarShape }).success, `PATCH ${avatarShape}`);
    const bot = createBot('owner', { name: `Fixture ${avatarShape}`, avatarShape, avatarColor: 'black' });
    assert.equal(getBot(bot.id)?.avatarShape, avatarShape);
    assert.equal(getBot(bot.id)?.avatarColor, 'black');
  }
  for (const schema of [botCreateSchema, botPatchSchema]) assert.equal(schema.safeParse({ avatarShape: 'bird-unknown' }).success, false);
});

test('creation without an avatar chooses only birds and does not rewrite stored silhouettes', () => {
  const stored = db.prepare('SELECT id, avatar_shape, avatar_color FROM bots').all();
  for (let n = 0; n < 16; n++) {
    const bot = createBot('owner', { name: 'Default fixture' });
    assert.ok(BIRD_SHAPES.some(id => id === bot.avatarShape));
  }
  for (const row of stored as { id: string; avatar_shape: string; avatar_color: string }[]) {
    assert.equal(getBot(row.id)?.avatarShape, row.avatar_shape);
    assert.equal(getBot(row.id)?.avatarColor, row.avatar_color);
  }
});
