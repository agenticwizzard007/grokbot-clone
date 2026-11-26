import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskCountState, taskCountText } from '../web/src/lib/taskCount.js';
import React, { createElement } from 'react';
// Node's tsx runner uses classic JSX without the web project's tsconfig.
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCount } from '../web/src/components/config/TaskCount.js';

test('task counts wait for both tasks and pending input instead of reporting a partial total', () => {
  assert.equal(taskCountState([{ known: false }, { known: false, loading: true }]), 'loading');
  assert.equal(taskCountState([{ known: true }, { known: false, loading: true }]), 'loading');
  assert.equal(taskCountState([{ known: false }, { known: true }]), 'loading');
  assert.equal(taskCountState([{ known: true }, { known: true }]), 'ready');
  assert.equal(taskCountState([{ known: true }]), 'ready', 'working and done counts do not depend on pending input');
});

test('task counts distinguish failed requests, stale snapshots and active retries', () => {
  for (const known of [false, true]) {
    assert.equal(taskCountState([{ known, error: true, loading: false }]), 'unavailable');
    assert.equal(taskCountState([{ known, error: true, loading: true }]), 'loading');
  }
  assert.equal(taskCountState([{ known: true, error: true }, { known: true }]), 'unavailable');
  assert.equal(taskCountState([{ known: true }, { known: true, error: true }]), 'unavailable');
  assert.equal(taskCountState([{ known: true, loading: true, error: false }]), 'ready', 'a healthy snapshot survives background refresh');
});

test('zero, ordinary counts and large counts fit one reserved badge slot', () => {
  for (const [count, text] of [[0, '0'], [1, '1'], [9, '9'], [10, '10'], [99, '99'], [100, '99+'], [1234, '99+']] as const) assert.equal(taskCountText(count), text);
});

test('count badges expose loading, failure, zero and exact large counts without question marks', () => {
  const render = (state: 'loading' | 'unavailable' | 'ready', count = 0, quietZero = false) => renderToStaticMarkup(createElement(TaskCount, { state, count, quietZero, label: `${count} waiting on you`, className: 'test-count' }));
  for (const state of ['loading', 'unavailable'] as const) {
    const html = render(state);
    assert.match(html, new RegExp(`aria-label="Pending input count ${state}"`));
    assert.match(html, /is-neutral/);
    assert.doesNotMatch(html, /\?/);
  }
  assert.match(render('ready', 0), /aria-label="0 waiting on you">0<\/span>/);
  assert.match(render('ready', 0, true), /is-neutral.*aria-label="0 waiting on you"><\/span>/);
  assert.match(render('ready', 1234), /aria-label="1234 waiting on you">99\+<\/span>/);
});
