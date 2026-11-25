import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { lastModelLabel, rememberModelLabel } from '../web/src/lib/modelMemory.js';

const tmp = mkdtempSync(join(tmpdir(), 'composer-first-render-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const bundle = await build({ stdin: { contents: `
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ComposerModelMenu} from './web/src/components/ComposerModelMenu';
import {liveVoiceMenuItem} from './web/src/components/Composer';
import {Menu} from './web/src/components/Menu';
import {useStore} from './web/src/store';
import {useModels} from './web/src/lib/models';
export function render(bot) {
  useStore.setState({user:{id:'alice'},bots:[bot]});
  useModels.setState({status:'loading'});
  return renderToStaticMarkup(React.createElement(ComposerModelMenu,{bot}));
}
export function menu(onSelect) {
  const item = liveVoiceMenuItem(onSelect, false);
  return {item, html:renderToStaticMarkup(React.createElement(Menu,{items:[item],onClose:()=>{},triggerRef:{current:null}}))};
}
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false,
  tsconfig: 'web/tsconfig.json', loader: { '.css': 'empty', '.svg': 'dataurl' },
  plugins: [{ name: 'rendered-account', setup(b) {
    b.onResolve({ filter: /\/store$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      let state = {user:null,bots:[],mobile:false};
      export const backToList = () => {}, enterChatPane = () => {};
      export const useStore = Object.assign(selector => selector(state), {
        getState:()=>state, setState:next=>Object.assign(state,next), subscribe:()=>()=>{},
      });` }));
  } }],
});
const file = join(tmp, 'components.cjs'); writeFileSync(file, bundle.outputFiles[0].text);
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  location: { hash: '', search: '' },
} });
after(() => Reflect.deleteProperty(globalThis, 'window'));
Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, style: {} } } });
after(() => Reflect.deleteProperty(globalThis, 'document'));
const components = createRequire(import.meta.url)(file);

test('model chip renders the Bot saved model before its list loads', () => {
  const html = components.render({ id: 'bot-a', model: 'openai/gpt-5.5', effort: 'high' });
  assert.match(html, /model-pill__name[^>]*>GPT 5.5</);
  assert.doesNotMatch(html, /Loading models/);
});

test('model chip restores the last resolved default per account and Bot', t => {
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  const bot = { id: 'bot-a', model: null };
  rememberModelLabel('alice', bot, 'Opus 5.5');
  assert.equal(lastModelLabel('alice', bot), 'Opus 5.5');
  assert.equal(lastModelLabel('bob', bot), 'Loading model');
  assert.equal(lastModelLabel('alice', { ...bot, id: 'bot-b' }), 'Loading model');
  assert.equal(lastModelLabel('alice', { ...bot, model: 'gpt-5.5' }), 'GPT 5.5');
  assert.match(components.render(bot), /model-pill__name[^>]*>Opus 5.5</);
});

test('composer plus menu contains an accessible Talk live action using the live call handler', () => {
  let calls = 0;
  const { item, html } = components.menu(() => calls++);
  assert.match(html, /role="menuitem"/); assert.match(html, /Talk live/);
  assert.ok(item.icon); item.onSelect(); assert.equal(calls, 1);
});


test('loading model memory preserves the visible plan label and isolates Bot preferences', t => {
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  const bot = { id: 'plan-bot', model: null };
  rememberModelLabel('account-a', bot, 'Codex · ChatGPT plan');
  assert.equal(lastModelLabel('account-a', bot), 'Codex · ChatGPT plan');
  assert.equal(lastModelLabel('account-b', bot), 'Loading model');
  assert.equal(lastModelLabel('account-a', { ...bot, id: 'other-bot' }), 'Loading model');
  assert.equal(lastModelLabel('account-a', { ...bot, model: 'openai/gpt-5.5' }), 'GPT 5.5');
  storage.set('swarm.model-label:account-a:plan-bot', '{invalid');
  assert.equal(lastModelLabel('account-a', bot), 'Loading model');
  storage.set('swarm.model-label:account-a:plan-bot', JSON.stringify({ model: null, label: 'CLI default' }));
  assert.equal(lastModelLabel('account-a', bot), 'Loading model', 'legacy internal labels stay neutral until the catalog settles');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage unavailable'); } });
  assert.doesNotThrow(() => rememberModelLabel('account-a', bot, 'Codex · ChatGPT plan'));
  assert.equal(lastModelLabel('account-a', bot), 'Loading model');
});
