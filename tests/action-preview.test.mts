import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toolPreviews, htmlToText } from '../web/src/components/cards/actionPreview.js';
import { ActionPreview } from '../web/src/components/cards/ToolPreview.js';

const email = {
  recipient_email: ['Review team <review@example.test>', 'second@example.test'],
  cc: ['copy@example.test', 'another@example.test'], bcc: ['private@example.test'],
  subject: 'Release ✓ "ready"', body: 'First paragraph.\n\nSecond line.\nありがとう 🌍',
  include_signature: true, thread_id: 'private-thread-id', timezone: 'Europe/Paris', is_html: false,
};
const values = (preview: ReturnType<typeof toolPreviews>[number]) => Object.fromEntries(preview.fields.map(f => [f.label, f.value]));
for (const tool of ['GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD']) {
  test(`${tool}: exact recipients, subject, full body, signature and thread without internal fields`, () => {
    const args = { connectionId: 'private-account-id', revision: 1, tool_slug: tool, arguments: email };
    const before = JSON.stringify(args);
    const [preview] = toolPreviews('SWARM_APPS_EXECUTE', args);
    assert.deepEqual(values(preview), { To: email.recipient_email.join(', '), Cc: email.cc.join(', '), Bcc: email.bcc.join(', '), Subject: email.subject });
    assert.equal(preview.body, email.body);
    assert.deepEqual(preview.notes, ['Signature will be added', 'Reply in existing thread']);
    assert.equal(JSON.stringify(args), before);
    assert.ok(!JSON.stringify(preview).includes('private-thread-id'));
    assert.ok(!JSON.stringify(preview).includes('Europe/Paris'));
  });
}
for (const tool of ['OUTLOOK_CREATE_DRAFT', 'OUTLOOK_SEND_EMAIL', 'OUTLOOK_REPLY_TO_EMAIL']) {
  test(`${tool}: Graph recipients, HTML body and known thread subject are accurate`, () => {
    const args = { message: { toRecipients: [{ emailAddress: { name: 'Review team', address: 'review@example.test' } }, { emailAddress: { address: 'second@example.test' } }], ccRecipients: [{ emailAddress: { address: 'copy@example.test' } }], bccRecipients: [{ emailAddress: { address: 'private@example.test' } }], subject: email.subject, body: { contentType: 'HTML', content: '<p>First &quot;paragraph&quot; &amp; ✓</p><p>Second<br>line</p>' } }, message_id: 'reply-id', thread_subject: 'Earlier subject', include_signature: false };
    const [preview] = toolPreviews(tool, args);
    assert.deepEqual(values(preview), { To: 'Review team <review@example.test>, second@example.test', Cc: 'copy@example.test', Bcc: 'private@example.test', Subject: email.subject });
    assert.equal(preview.body, 'First "paragraph" & ✓\n\nSecond\nline');
    assert.deepEqual(preview.notes, ['Reply to: Earlier subject']);
  });
}
test('email preview preserves the entire long Unicode body and renders raw args only in closed Details', () => {
  const body = `${email.body}\n${'Long body 📨\n'.repeat(800)}FINAL CONTENT`;
  const args = { ...email, body };
  assert.equal(toolPreviews('GMAIL_SEND_EMAIL', args)[0].body, body);
  const markup = renderToStaticMarkup(React.createElement(ActionPreview, { tool: 'GMAIL_SEND_EMAIL', args }));
  const [main, details] = markup.split('<details');
  assert.ok(main.includes('FINAL CONTENT'));
  assert.ok(main.includes('Show full'));
  assert.ok(main.includes('aria-expanded="false"'));
  assert.ok(!main.includes('recipient_email'));
  assert.ok(!main.includes('timezone'));
  assert.ok(details.includes('<summary>Details</summary>'));
  assert.ok(details.includes('recipient_email'));
  assert.ok(!details.includes(' open'));
});
test('HTML conversion strips executable content, keeps safe link destinations and never mounts markup', () => {
  const html = '<script>bad()</script><style>bad-css</style><svg onload="bad()"><text>bad-svg</text></svg><p>Hi &lt;review&gt; &amp; &#x1F30D;</p><p><img src="https://tracking.example.test" onerror="bad()" alt="Logo"> <a href="https://example.test/path">Read more</a><br><a href="javascript:bad()">unsafe link text</a></p>';
  const text = htmlToText(html);
  assert.equal(text, 'Hi <review> & 🌍\n\nLogo Read more (https://example.test/path)\nunsafe link text');
  const markup = renderToStaticMarkup(React.createElement(ActionPreview, { tool: 'GMAIL_CREATE_EMAIL_DRAFT', args: { body: html, is_html: true } }));
  assert.ok(!/<(script|style|svg|img|a)\b/.test(markup));
  assert.ok(markup.includes('&lt;review&gt;'));
});
test('plain email display handles double-escaped line endings without JSON escapes or invented values', () => {
  const [preview] = toolPreviews('OUTLOOK_CREATE_DRAFT', { to_email: 'only@example.test', body: 'First\\n\\nSecond', include_signature: false, thread_id: 'known', thread_subject: 'Original' });
  assert.deepEqual(values(preview), { To: 'only@example.test' });
  assert.equal(preview.body, 'First\n\nSecond');
  assert.deepEqual(preview.notes, ['Reply to: Original']);
});
test('Slack previews channel and complete multiline message, including block-only messages', () => {
  const [preview] = toolPreviews('SLACK_SEND_MESSAGE', { channel: '#release', text: 'Hello team\n\nhttps://example.test/' + 'long'.repeat(100), thread_ts: 'internal' });
  assert.deepEqual(values(preview), { Channel: '#release' });
  assert.ok(preview.body?.endsWith('long'.repeat(100)));
  assert.equal(toolPreviews('SLACK_POST_MESSAGE', { channel_id: 'C123', blocks: [{ text: { type: 'mrkdwn', text: 'Block one' } }, { fields: [{ text: 'Block two' }] }] })[0].body, 'Block one\n\nBlock two');
});
test('Calendar previews supplied local times, offsets, timezone, attendees, location and description', () => {
  const [preview] = toolPreviews('GOOGLECALENDAR_CREATE_EVENT', { summary: 'Planning', start: { dateTime: '2026-12-01T09:30:00+01:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-12-01T10:30:00+01:00', timeZone: 'Europe/Paris' }, attendees: [{ email: 'first@example.test' }, { email: 'second@example.test' }], location: 'Room 2', description: 'Agenda\n\nPlan the release.', calendar_id: 'private' });
  assert.deepEqual(values(preview), { Title: 'Planning', Start: '2026-12-01 09:30:00+01:00 · Europe/Paris', End: '2026-12-01 10:30:00+01:00 · Europe/Paris', Attendees: 'first@example.test, second@example.test', Location: 'Room 2' });
  assert.equal(preview.body, 'Agenda\n\nPlan the release.');
  const [allDay] = toolPreviews('OUTLOOK_CALENDAR_CREATE_EVENT', { subject: 'Away', start: { date: '2026-12-01' }, end: { date: '2026-12-02' } });
  assert.deepEqual(values(allDay), { Title: 'Away', Start: '2026-12-01', End: '2026-12-02' });
});
test('generic and batched proposals humanize supplied fields and keep JSON and identifiers in Details', () => {
  const [preview] = toolPreviews('CUSTOM_ACTION', { project_title: 'Release', messageText: 'Full\ntext', count: 3, enabled: true, timezone: 'UTC', thread_id: 'hidden', connectionId: 'hidden', payload: '{"raw":"json"}', nested: { secret: 'hidden' } });
  assert.deepEqual(values(preview), { 'Project title': 'Release', 'Message Text': 'Full\ntext', Count: '3', Enabled: 'true' });
  assert.deepEqual(toolPreviews('BATCH', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: email }, { tool_slug: 'SLACK_SEND_MESSAGE', args: { channel: '#team', text: 'Update' } }] }).map(p => p.kind), ['email', 'slack']);
});

test('Slack renders emphasis and safe links while escaping markup and unsafe URLs', () => {
  const markup = renderToStaticMarkup(React.createElement(ActionPreview, { tool: 'SLACK_SEND_MESSAGE', args: { channel: '#release', text: '*Ready*\n_Review_ ~old~ `code` <https://example.test|Open> <javascript:alert(1)|bad> <img src=x onerror=alert(1)>' } }));
  const main = markup.split('<details')[0];
  assert.ok(main.includes('<strong>Ready</strong>'));
  assert.ok(main.includes('<em>Review</em>'));
  assert.ok(main.includes('href="https://example.test"'));
  assert.ok(!main.includes('href="javascript:'));
  assert.ok(!main.includes('<img'));
});
