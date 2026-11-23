// Synthetic data only. Shared by the API and browser performance checks.
export const CHAT_OPEN_ROWS = 720;
export const CHAT_OPEN_BOT = 'chat-open-fixture';
export function seedChatOpen(db, owner) {
  const now = 1_790_000_000_000;
  db.transaction(() => {
    db.prepare('INSERT INTO bots(id,user_id,name,next_seq,rev,unread,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(CHAT_OPEN_BOT, owner, 'History performance Bot', CHAT_OPEN_ROWS + 1, CHAT_OPEN_ROWS, 1, now, now);
    db.prepare('INSERT INTO bot_setups(bot_id,brief,source,onboarding_status,confirmed_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(CHAT_OPEN_BOT, '{}', '{}', 'active', now, now);
    const insert = db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,?,?,?)');
    for (let seq = 1; seq <= CHAT_OPEN_ROWS; seq++) {
      const body = seq % 3 === 2
        ? { type: 'tool-call', callId: `fixture-${seq}`, name: 'read_file', label: 'Read local fixture', status: 'done',
          args: { path: '/fixture/report.txt', content: Array.from({ length: 640 }, (_, i) => `Record ${i}: synthetic report data for pagination and local performance measurement.\n`).join('') }, summary: 'Read fixture' }
        : { type: 'message', role: seq % 3 === 1 ? 'user' : 'assistant', text: seq % 3 === 1 ? `Fixture request ${seq}`
          : `Latest fixture ${seq}\n\n## Local report\n\n${'- **Result:** synthetic data with a [reference](https://example.test).\n'.repeat(12)}\n\`\`\`js\nconst result = "fixture";\n\`\`\`` };
      insert.run(CHAT_OPEN_BOT, seq, seq, body.type, JSON.stringify(body), now + seq * 1000);
    }
  })();
}
