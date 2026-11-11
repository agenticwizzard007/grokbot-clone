// Pairing secrets are passed as `--token <secret>`; a leading '-' made the CLI bridge reject the command.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mock, test } from 'node:test';
import { parseArgs } from 'node:util';
import { token } from '../server/src/lib/ids.ts';

test('secrets never begin with a dash, so `--token <secret>` always parses', () => {
  const dashFirst = Buffer.alloc(32, 0xf8); // base64url of 0xf8… begins with '-'
  assert.ok(dashFirst.toString('base64url').startsWith('-'));
  const normal = Buffer.alloc(32, 0x41);
  const draws = [dashFirst, dashFirst, normal];
  const randomBytes = mock.method(crypto, 'randomBytes', () => draws.shift());
  try {
    const value = token();
    assert.equal(value, normal.toString('base64url'));
    assert.equal(randomBytes.mock.callCount(), 3);
  } finally {
    randomBytes.mock.restore();
  }
  // The bridge's own option parser (companion/cli-bridge.mjs) accepts every generated secret.
  for (let n = 0; n < 2000; n++) {
    const secret = token();
    assert.ok(!secret.startsWith('-'));
    const { values } = parseArgs({ args: ['--server', 'http://x', '--token', secret], options: { server: { type: 'string' }, token: { type: 'string' } }, strict: true });
    assert.equal(values.token, secret);
  }
});
