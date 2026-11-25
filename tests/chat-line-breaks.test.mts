import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../web/src/components/MarkdownRenderer.js';
import { ActionPreview } from '../web/src/components/cards/ToolPreview.js';
import { toolPreviews } from '../web/src/components/cards/actionPreview.js';
import { emailBody, emailArgs } from './fixtures/cli-apps-runner.mjs';

test('a 16-line email renders as 16 chat lines and keeps all 16 approval preview lines', () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { text: emailBody }));
  assert.equal((html.match(/<br\/>/g) ?? []).length, 15);
  assert.equal((html.match(/Email line \d+/g) ?? []).length, 16);
  const args = { connectionId: 'fixture-gmail', revision: 1, tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', arguments: emailArgs };
  const preview = toolPreviews('SWARM_APPS_EXECUTE', args)[0];
  assert.equal(preview.body, emailBody);
  const approval = renderToStaticMarkup(React.createElement(ActionPreview, { tool: 'SWARM_APPS_EXECUTE', args }));
  assert.ok(approval.split('<details')[0].includes(emailBody));
});

test('paragraphs, existing Markdown hard breaks, lists and code keep their intended breaks', () => {
  const render = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { text }));
  assert.match(render('First paragraph.\n\nSecond paragraph.'), /<p>First paragraph\.<\/p>\n<p>Second paragraph\.<\/p>/);
  assert.equal((render('First  \nSecond\\\nThird').match(/<br\/>/g) ?? []).length, 2, 'Existing hard breaks must not double');
  assert.match(render('- First\n- Second'), /<li>First<\/li>\n<li>Second<\/li>/);
  assert.match(render('```text\nFirst\nSecond\n```'), /First\nSecond\n<\/code>/);
});
