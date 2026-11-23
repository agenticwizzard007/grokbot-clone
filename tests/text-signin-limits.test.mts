// P-14 defensive fixtures. No external requests or real recipients.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientIpPolicy } from '../server/src/security/client-ip.js';
import { TextSigninLimiter, TEXT_SIGNIN_WINDOW_MS, TEXT_SIGNIN_MAX_BUCKETS } from '../server/src/messaging/text-signin-limiter.js';

test('P-14 source identity ignores headers unless the socket peer is explicitly trusted', () => {
  const direct = clientIpPolicy('');
  assert.equal(direct('192.0.2.1', '198.51.100.1'), '192.0.2.1');
  assert.equal(direct('::ffff:192.0.2.1', '198.51.100.1'), '192.0.2.1');
  assert.equal(direct('2001:0db8:0:0:0:0:0:1', undefined), '2001:db8::1');
  assert.equal(direct(undefined, '198.51.100.1'), 'unknown');
  assert.equal(direct('invalid', '198.51.100.1'), 'unknown');
});

test('P-14 proxy chains stop at the first untrusted hop from the socket', () => {
  const resolve = clientIpPolicy('127.0.0.1/32,192.0.2.0/24,2001:db8:1::/48');
  assert.equal(resolve('::ffff:127.0.0.1', '203.0.113.1, 198.51.100.1'), '198.51.100.1');
  assert.equal(resolve('127.0.0.1', '198.51.100.1, 192.0.2.2'), '198.51.100.1');
  assert.equal(resolve('2001:db8:1::1', '2001:0db8:2:0::1'), '2001:db8:2::1');
  assert.equal(resolve('198.51.100.1', '192.0.2.2'), '198.51.100.1');
  assert.equal(resolve('127.0.0.1', undefined), '127.0.0.1');
});

test('P-14 malformed and oversized trusted chains fall back to the socket', () => {
  const resolve = clientIpPolicy('127.0.0.1/32');
  for (const header of ['invalid', '198.51.100.1,', '198.51.100.1:80', 'x'.repeat(2049), Array(33).fill('192.0.2.1').join(',')]) {
    assert.equal(resolve('127.0.0.1', header), '127.0.0.1');
  }
  assert.throws(() => clientIpPolicy('not-a-cidr'), /valid IP CIDRs/);
  assert.throws(() => clientIpPolicy('192.0.2.0/99'), /valid IP CIDRs/);
});

test('P-14 recipient quota is shared by independent sources', () => {
  const limiter = new TextSigninLimiter();
  for (let i = 0; i < 3; i++) assert.equal(limiter.allow(`source-${i}`, 'recipient'), true);
  assert.equal(limiter.allow('source-3', 'recipient'), false);
  assert.equal(limiter.allow('source-3', 'other-recipient'), true);
});

test('P-14 source quota is shared by independent recipients', () => {
  const limiter = new TextSigninLimiter();
  for (let i = 0; i < 10; i++) assert.equal(limiter.allow('source', `recipient-${i}`), true);
  assert.equal(limiter.allow('source', 'recipient-10'), false);
  assert.equal(limiter.allow('other-source', 'recipient-10'), true);
});

test('P-14 recipient denials still consume source attempts', () => {
  const limiter = new TextSigninLimiter();
  for (let i = 0; i < 10; i++) assert.equal(limiter.allow('source', 'recipient'), i < 3);
  assert.equal(limiter.allow('source', 'fresh-recipient'), false);
});

test('P-14 rolling expiry releases only elapsed attempts and denied requests do not extend it', () => {
  let now = 0;
  const limiter = new TextSigninLimiter(() => now);
  assert.equal(limiter.allow('source', 'recipient'), true);
  now = 100;
  assert.equal(limiter.allow('source', 'recipient'), true);
  now = 200;
  assert.equal(limiter.allow('source', 'recipient'), true);
  now = TEXT_SIGNIN_WINDOW_MS - 1;
  assert.equal(limiter.allow('source', 'recipient'), false);
  now++;
  assert.equal(limiter.allow('source', 'recipient'), true);
  assert.equal(limiter.allow('source', 'recipient'), false);
  now += 100;
  assert.equal(limiter.allow('source', 'recipient'), true);
});

test('P-14 source quota expires at the rolling boundary', () => {
  let now = 0;
  const limiter = new TextSigninLimiter(() => now);
  for (let i = 0; i < 10; i++) assert.equal(limiter.allow('source', `recipient-${i}`), true);
  now = TEXT_SIGNIN_WINDOW_MS - 1;
  assert.equal(limiter.allow('source', 'fresh'), false);
  now++;
  assert.equal(limiter.allow('source', 'fresh'), true);
  assert.equal(limiter.size, 2, 'all untouched expired identities are reclaimed');
});

test('P-14 storage cap fails closed without evicting active quotas and recovers after expiry', () => {
  let now = 0;
  const limiter = new TextSigninLimiter(() => now);
  for (let i = 0; i < TEXT_SIGNIN_MAX_BUCKETS / 2; i++) assert.equal(limiter.allow(`source-${i}`, `recipient-${i}`), true);
  assert.equal(limiter.size, TEXT_SIGNIN_MAX_BUCKETS);
  assert.equal(limiter.allow('fresh-source', 'fresh-recipient'), false);
  assert.equal(limiter.allow('source-0', 'fresh-recipient'), false);
  assert.equal(limiter.size, TEXT_SIGNIN_MAX_BUCKETS);
  assert.equal(limiter.allow('source-0', 'recipient-0'), true);
  assert.equal(limiter.allow('source-0', 'recipient-0'), true);
  assert.equal(limiter.allow('source-0', 'recipient-0'), false);
  now = TEXT_SIGNIN_WINDOW_MS;
  assert.equal(limiter.allow('fresh-source', 'fresh-recipient'), true);
  assert.equal(limiter.size, 2);
});
