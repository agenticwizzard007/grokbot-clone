import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { createElement } from 'react';
// Node's tsx runner uses classic JSX without the web project's tsconfig.
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from 'react-dom/server';
import { Blocks, CircleUserRound, Gauge, KeyRound, MessageCircle, Monitor, Server, Settings, ShieldCheck, Terminal } from 'lucide-react';
import { NAV, matches, SettingsNavButton } from '../web/src/components/config/settingsNavigation.tsx';
import { SettingRow } from '../web/src/components/config/SettingRow.tsx';
import { AccessRow } from '../web/src/components/config/AccessRow.tsx';

const items = NAV.flatMap(group => group.items);
const expected = { general: Settings, account: CircleUserRound, messaging: MessageCircle, usage: Gauge, learning: Blocks, computer: Monitor, permissions: ShieldCheck, apps: Blocks, mcp: Server, subscriptions: Terminal, keys: KeyRound };
test('all eleven stable section IDs retain the historical Lucide icon map', () => {
  assert.deepEqual(items.map(item => item.id), Object.keys(expected));
  for (const item of items) assert.equal(item.icon, expected[item.id], item.id);
});
test('two plain groups keep each existing section reachable exactly once', () => {
  assert.deepEqual(NAV.map(group => [group.group, group.items.map(item => item.id)]), [
    ['Workspace', ['general', 'account', 'messaging', 'usage', 'learning', 'computer', 'permissions']],
    ['Connections', ['apps', 'mcp', 'subscriptions', 'keys']],
  ]);
  assert.equal(new Set(items.map(item => item.id)).size, 11);
  for (const [query, id] of [['sessions', 'account'], ['memory', 'learning'], ['model provider', 'keys'], ['mcp token', 'mcp']]) {
    assert.ok(items.filter(item => matches(item, query)).some(item => item.id === id));
  }
});
for (const mode of ['desktop', 'phone', 'strip']) test(`${mode} navigation renders the icon, label and active-page semantics for every item`, () => {
  for (const item of items) {
    const html = renderToStaticMarkup(createElement(SettingsNavButton, { item, compact: mode === 'phone', strip: mode === 'strip', active: true, onSelect() {} }));
    assert.match(html, /aria-current="page"/);
    assert.match(html, /class="[^"]*settings-nav__icon[^"]*"[^>]*aria-hidden="true"/);
    assert.match(html, /stroke-width="1.75"/);
    assert.match(html, new RegExp(`width="${mode === 'phone' ? 20 : 18}"`));
    assert.ok(html.includes(item.label.replace('&', '&amp;')));
    assert.equal((html.match(/settings-nav__icon/g) ?? []).length, 1);
  }
});
test('SettingRow renders one decorative icon, helper, status and an operable control in order', () => {
  const html = renderToStaticMarkup(createElement(SettingRow, { icon: ShieldCheck, title: 'Ask first', sub: 'Review changes.', status: 'Enabled', wrap: true }, createElement('button', { type: 'button' }, 'Change')));
  assert.match(html, /cfg-row settings-row--wrap/);
  assert.match(html, /settings-row__icon[^>]*aria-hidden="true"/);
  assert.match(html, /stroke-width="1.75"/);
  assert.ok(html.indexOf('<svg') < html.indexOf('Ask first'));
  assert.ok(html.indexOf('Review changes.') < html.indexOf('<button'));
  assert.match(html, /Enabled/);
});
test('access rows use the same SettingRow contract for integrations', () => {
  const html = renderToStaticMarkup(createElement(AccessRow, { icon: KeyRound, title: 'Personal key', description: 'Verify before saving.' }, createElement('button', null, 'Save')));
  assert.match(html, /cfg-row access-row/);
  assert.equal((html.match(/settings-row__icon/g) ?? []).length, 1);
  assert.match(html, /access-row__actions/);
  assert.match(html, /Verify before saving/);
});
