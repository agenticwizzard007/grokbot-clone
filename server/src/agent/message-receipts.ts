import { createHash } from 'node:crypto';
import { db } from '../db.js';
import type { Row } from '../types.js';

db.exec(`CREATE TABLE IF NOT EXISTS message_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(user_id, bot_id, submission_id)
);`);

export interface MessageReceipt { row: Row; jobIds: string[]; submissionId?: string }
export class SubmissionConflict extends Error {
  constructor() { super('This submission ID was already used for different text.'); }
}

/** Commit the receipt, conversation row and all admitted jobs together. */
export function acceptMessage(userId: string, botId: string, submissionId: string | undefined, text: string, accept: () => Omit<MessageReceipt, 'submissionId'>): MessageReceipt {
  return db.transaction(() => {
    const hash = createHash('sha256').update(text).digest('hex');
    if (submissionId !== undefined) {
      const prior = db.prepare('SELECT content_hash, receipt FROM message_receipts WHERE user_id=? AND bot_id=? AND submission_id=?')
        .get(userId, botId, submissionId) as { content_hash: string; receipt: string } | undefined;
      if (prior) {
        if (prior.content_hash !== hash) throw new SubmissionConflict();
        return JSON.parse(prior.receipt) as MessageReceipt;
      }
    }
    const receipt: MessageReceipt = { ...accept(), ...(submissionId === undefined ? {} : { submissionId }) };
    // Older clients can still send without a key. They cannot replay a receipt.
    if (submissionId !== undefined) db.prepare('INSERT INTO message_receipts(user_id,bot_id,submission_id,content_hash,receipt) VALUES (?,?,?,?,?)')
      .run(userId, botId, submissionId, hash, JSON.stringify(receipt));
    return receipt;
  }).immediate();
}
