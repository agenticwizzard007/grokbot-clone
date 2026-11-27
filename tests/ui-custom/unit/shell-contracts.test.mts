import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { COMPONENT_IDS } from '../../../server/src/ui-config/registry-components.ts';
import { tsImport } from 'tsx/esm/api';
const { effectiveBindings, setShortcutBindings, shortcutLabel, shortcutMatches } = await tsImport('../../../web/src/lib/shortcuts.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const files = ['web/src/AuthenticatedShell.tsx', ...['Sidebar', 'BotsView', 'ChatView', 'Transcript'].map(name => `web/src/components/${name}.tsx`), 'web/src/customization/layout/markers.tsx'];
const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
for (const id of COMPONENT_IDS) test(`one visibility call and marker for ${id}`, () => {
  assert.equal(source.split(`useComponentVisible('${id}')`).length - 1, 1);
  assert.equal(source.split(`data-ui-id="${id}"`).length - 1, 1);
});
test('reserved, missing Settings and duplicate bindings cannot lock out Settings', () => {
  const map = effectiveBindings({ settings: null, search: 'Mod+,', focusComposer: 'Mod+W', newBot: 'Alt+F4' });
  assert.equal(map.settings, 'Mod+,'); assert.equal(map.search, null); assert.equal(map.focusComposer, null); assert.equal(map.newBot, null);
  assert.equal(effectiveBindings({ settings: 'Mod+Alt+0' }).settings, 'Mod+,');
});
test('new binding updates handler and labels while old binding stops', () => {
  setShortcutBindings({ focusComposer: 'Alt+J' });
  assert.equal(shortcutLabel('focus', false), 'Alt+J');
  assert.ok(shortcutMatches('focusComposer', { key: 'j', code: 'KeyJ', altKey: true, shiftKey: false, metaKey: false, ctrlKey: false }));
  assert.equal(shortcutMatches('focusComposer', { key: 'i', code: 'KeyI', altKey: false, shiftKey: false, metaKey: false, ctrlKey: true }), false);
  setShortcutBindings({});
});
test('UI strings added by the shell use no long dashes', () => {
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /[\u2013\u2014]/, file);
});
