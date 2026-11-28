import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardDisclosureKey, readDashboardDisclosure, writeDashboardDisclosure } from '../../../web/src/lib/sidebarDisclosure.ts';

test('Dashboard disclosure remembers each account without sharing its choice', () => {
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  assert.equal(readDashboardDisclosure('sample-a'), null);
  writeDashboardDisclosure('sample-a', false);
  assert.equal(readDashboardDisclosure('sample-a'), false);
  assert.equal(readDashboardDisclosure('sample-b'), null);
  writeDashboardDisclosure('sample-b', true);
  assert.equal(readDashboardDisclosure('sample-b'), true);
  assert.equal(readDashboardDisclosure('sample-a'), false);
  writeDashboardDisclosure('sample-a', true);
  assert.equal(readDashboardDisclosure('sample-a'), true);
  saved.set(dashboardDisclosureKey('sample-a'), 'invalid');
  assert.equal(readDashboardDisclosure('sample-a'), null);
  writeDashboardDisclosure(null, true);
  assert.equal(saved.size, 2);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('Missing identity and disabled browser storage use the viewport default', () => {
  assert.equal(readDashboardDisclosure(null), null);
  assert.equal(readDashboardDisclosure('sample-a'), null);
  assert.doesNotThrow(() => writeDashboardDisclosure('sample-a', true));
});
