import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Row, ToolCallBody } from '../server/src/types.js';
import { savedFileResult, savedFileLinksByMessage } from '../web/src/lib/savedFiles.js';
import { Markdown } from '../web/src/components/MarkdownRenderer.js';

const href = '#bot/qa-temp-1~0123456789abc/reports';
const savedFile = { filename: 'fixture.txt', href };
const saved: ToolCallBody = { type: 'tool-call', callId: 'save', name: 'save_file', label: 'Saving notes', status: 'done', savedFile };
const row = (seq: number, body: Row['body']): Row => ({ botId: 'fixture', generation: 1, seq, updatedSeq: seq, createdAt: seq, kind: body.type, body });

test('R15 only a completed save result exposes scoped file navigation', () => {
  assert.deepEqual(savedFileResult(saved), savedFile);
  for (const status of ['queued', 'running', 'error', 'denied', 'uncertain', 'interrupted', 'awaiting-approval'] as const) {
    assert.equal(savedFileResult({ ...saved, status }), undefined);
  }
  assert.equal(savedFileResult({ ...saved, name: 'tool_call' }), undefined);
  assert.equal(savedFileResult({ ...saved, savedFile: undefined }), undefined);
  for (const invalid of ['#reports', '#bot/fixture/tasks', 'https://example.test/', 'javascript:alert(1)']) {
    assert.equal(savedFileResult({ ...saved, savedFile: { ...savedFile, href: invalid } }), undefined);
  }
});

test('R15 duplicate links are scoped to the loaded save result and its own job', () => {
  const rows = [
    row(1, { type: 'message', role: 'user', text: 'Save a file' }),
    row(2, { type: 'message', role: 'assistant', text: 'Saving', jobId: 'saving' }),
    row(3, { ...saved, jobId: 'saving' }),
    row(4, { type: 'message', role: 'user', text: 'Another queued request' }),
    row(5, { type: 'message', role: 'assistant', text: 'Saved', jobId: 'saving' }),
    row(6, { type: 'message', role: 'assistant', text: 'See Reports', jobId: 'other' }),
  ];
  assert.deepEqual([...savedFileLinksByMessage(rows)], [[2, [href]], [5, [href]]]);
  assert.deepEqual([...savedFileLinksByMessage(rows.filter(r => r.seq !== 3))], []);
  assert.deepEqual([...savedFileLinksByMessage(rows.map(r => ({ ...r, body: { ...r.body, jobId: undefined } })))], [[2, [href]]]);
});

test('R15 Markdown omits repeated save navigation but retains other links, code and legacy replies', t => {
  const render = (text: string, links?: string[]) => renderToStaticMarkup(React.createElement(Markdown, { text, savedFileLinks: links }));
  const text = `Saved fixture.txt. [View saved files](${href})`;
  const legacy = render(text);
  assert.match(legacy, /View saved files<\/a>/);
  assert.doesNotMatch(legacy, /target=/);
  assert.equal(render(text, [href]), '<div class="md"><p>Saved fixture.txt. </p></div>');
  assert.match(render(`[Other Bot](#bot/other~0123456789abc/reports)`, [href]), /<a href=/);
  assert.match(render(`[Reference](https://example.test/${href})`, [href]), /target="_blank"/);
  assert.match(render('`' + text + '`', [href]), /<code>.*View saved files/);
  Object.defineProperty(globalThis, 'window', { value: { location: new URL('http://localhost:5199/') }, configurable: true });
  t.after(() => { delete (globalThis as any).window; });
  assert.doesNotMatch(render(`[View saved files](http://localhost:5199/${href})`, [href]), /<a |View saved files/);
  assert.match(render(`[Other page](http://localhost:5199/other${href})`, [href]), /<a /);
});
