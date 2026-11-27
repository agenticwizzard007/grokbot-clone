import { db, requireEnabled } from './db.js';
export function handoffMetrics(userId: string) {
    requireEnabled(userId);
    const count = (table: 'handoffs' | 'loops', where: string) => (db.prepare(`SELECT count(*) n FROM ${table} WHERE user_id=? AND ${where}`).get(userId) as {
        n: number;
    }).n;
    return { created: count('handoffs', '1=1'), completed: count('handoffs', "status='completed'"), failed: count('handoffs', "status='failed'"), loopsRunning: count('loops', "status='running'"), loopsCapped: count('loops', "status='capped'"),
        averagePasses: (db.prepare('SELECT AVG(iteration) n FROM loops WHERE user_id=? AND finished_at IS NOT NULL').get(userId) as any).n ?? 0,
        averageStepDurationMs: (db.prepare('SELECT AVG(finished_at-started_at) n FROM loop_steps WHERE user_id=? AND finished_at IS NOT NULL').get(userId) as any).n ?? 0 };
}
