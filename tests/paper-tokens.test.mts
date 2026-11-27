import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../web/src/styles/tokens.css', import.meta.url), 'utf8');
const sections = css.split(":root[data-theme='dark'] {");
const value = (theme: number, name: string) => sections[theme].match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1];
const expected = {
  'color-bg-pane': ['#FFFFFF', '#1D2A3B'], 'color-bg-sidebar': ['#FBFAF7', '#17222F'],
  'color-bg-active': ['#EDEFFA', '#30415E'], 'color-bg-subtle': ['#F5F6F7', '#223144'],
  'color-bg-tertiary': ['#F5F6F7', '#223144'], 'color-bg-hover': ['#EEF0F2', '#283A50'],
  'color-text-primary': ['#18202A', '#FFFFFF'], 'color-text-secondary': ['#525B5E', '#C4CBD5'],
  'color-text-tertiary': ['#697176', '#AFB9C6'], 'color-border-secondary': ['#DCDEE0', '#3A4859'],
  'color-border-tertiary': ['#EBECEE', '#2B394B'], 'color-primary': ['#3043AB', '#B5C1FF'],
  'color-on-primary': ['#FFFFFF', '#17222F'], 'color-bubble-user': ['#EDEFFA', '#3043AB'],
  'color-bubble-agent': ['#FBFAF7', '#243347'], 'color-bg-elevated': ['#FFFFFF', '#253348'],
  'color-success': ['#27804F', '#3CC384'], 'color-success-bg': ['#ECF4EE', '#173A2E'],
  'color-warn-text': ['#9A5B08', '#F0B45A'], 'color-warn-bg': ['#FCF0DA', '#3A3020'],
  'color-danger': ['#E72E3B', '#F05A64'], 'color-danger-text': ['#A1353D', '#FF9AA1'],
  'color-danger-bg': ['#FCEDEE', '#3D2229'], 'color-bg-scrim': ['#10161E73', '#00000099'],
  'color-bot-pink': ['#E52F8B', '#F93498'], 'color-bot-green': ['#14A862', '#14C16F'],
  'color-bot-orange': ['#E8620E', '#FD690F'], 'color-bot-teal': ['#13A592', '#13B7A2'],
};
for (const [theme, name] of ['light', 'dark'].entries()) test(`Paper ${name} token contract`, () => {
  for (const [token, colors] of Object.entries(expected)) assert.equal(value(theme, token), colors[theme], token);
});
test('Paper phone tab type and composer radius retain their shared token names', () => {
  assert.equal(value(0, 'text-tab'), '11px'); assert.equal(value(0, 'line-tab'), '14px');
  assert.equal(value(0, 'radius-composer'), '24px');
});

test('Paper v3 layout spacing and control geometry', () => {
  for (const [token, expected] of Object.entries({ 'space-1': '4px', 'space-2': '8px', 'space-3': '16px', 'space-4': '24px', 'space-5': '32px', 'radius-card': '12px', 'control-h': '44px' })) assert.equal(value(0, token), expected, token);
});
