import { Cron } from 'croner';
import { db } from '../../db.js';
import { needsYou } from '../../routes-attention.js';
import { describeCron } from '../../store.js';
import { rangeBounds, usageReport, usageTimezone, type UsageRange } from '../../usage.js';
import { reportDay, reportDayStart, shiftDay } from '../../report-days.js';
import { SourceError, type Params, type SourceData } from './catalog.js';

type Row = Record<string, any>;
const all = (sql: string, args: (string | number)[]) => db.prepare(sql).all(...args) as Row[];
const one = (sql: string, args: (string | number)[]) => db.prepare(sql).get(...args) as Row;

function botScope(userId: string, params: Params) {
  if (params.botId && !db.prepare('SELECT 1 FROM bots WHERE user_id=? AND id=?').get(userId, params.botId)) {
    throw new SourceError('not_found', 'Bot not found.');
  }
  return { where: 'b.user_id=?' + (params.botId ? ' AND b.id=?' : ''), args: params.botId ? [userId, params.botId] : [userId] };
}

/** Routine receipts supersede their associated jobs, including follow-up jobs. */
const runsSql = `WITH runs AS (
  SELECT j.id, b.name AS botName,
    CASE WHEN json_valid(j.trigger) THEN CASE json_extract(j.trigger,'$.type')
      WHEN 'user' THEN 'user' WHEN 'routine' THEN 'routine' WHEN 'schedule' THEN 'schedule'
      WHEN 'resume' THEN 'resume' WHEN 'system' THEN 'system' ELSE 'other' END ELSE 'other' END AS kind,
    CASE j.state WHEN 'uncertain' THEN 'failed' WHEN 'cancelled' THEN 'failed' ELSE j.state END AS state,
    j.created_at AS createdAt, j.started_at AS startedAt, j.finished_at AS finishedAt, b.id AS botId
  FROM agent_jobs j JOIN bots b ON b.id=j.bot_id AND b.user_id=j.user_id
  WHERE j.user_id=? AND b.user_id=?
    AND NOT EXISTS (SELECT 1 FROM routine_executions r WHERE r.user_id=j.user_id AND r.job_id=j.id)
    AND NOT EXISTS (SELECT 1 FROM routine_execution_jobs rj JOIN routine_executions r ON r.id=rj.run_id
      WHERE rj.job_id=j.id AND r.user_id=j.user_id)
  UNION ALL
  SELECT r.id, b.name, CASE r.kind WHEN 'schedule' THEN 'schedule' WHEN 'manual' THEN 'manual' ELSE 'routine' END,
    CASE r.status WHEN 'waiting' THEN 'running' WHEN 'unknown' THEN 'failed' WHEN 'cancelled' THEN 'failed' ELSE r.status END,
    r.created_at, r.started_at, r.finished_at, b.id
  FROM routine_executions r JOIN bots b ON b.id=r.bot_id AND b.user_id=r.user_id
  WHERE r.user_id=? AND b.user_id=?
)`;

/** Called only with parsed params and a session user. Every SQL scope is account bound. */
export function resolveSource(id: string, userId: string, params: Params): SourceData {
  if (!userId) throw new SourceError('not_found', 'Account not found.');
  const scope = botScope(userId, params), limit = Number(params.limit ?? 25), now = Date.now();
  const range = (params.range ?? '7d') as UsageRange;
  // Scan tasks against one account-owned id set instead of looking up the Bot
  // separately for every task. The existing schema has no task Bot index.
  const taskWhere = 't.bot_id IN (SELECT b.id FROM bots b WHERE b.user_id=?)' + (params.botId ? ' AND t.bot_id=?' : '');
  if (id === 'tasks.counts' || id === 'tasks.list') {
    const where = taskWhere + (params.state ? ' AND t.state=?' : '');
    const args = [...scope.args, ...(params.state ? [params.state] : [])];
    const counts = one(`SELECT COUNT(*) AS total, COALESCE(SUM(t.state='working'),0) AS working,
      COALESCE(SUM(t.state='needs_input'),0) AS needs_input, COALESCE(SUM(t.state='done'),0) AS done
      FROM tasks t WHERE ${where}`, args);
    if (id === 'tasks.counts') return { value: counts, count: counts.total };
    return { count: counts.total, rows: all(`SELECT t.id, t.title, t.state, b.name AS botName, b.id AS botId, t.updated_at AS updatedAt
      FROM (SELECT t.id,t.title,t.state,t.bot_id,t.updated_at FROM tasks t WHERE ${where}
        ORDER BY t.updated_at DESC,t.id LIMIT ?) t JOIN bots b ON b.id=t.bot_id ORDER BY t.updated_at DESC,t.id`, [...args, limit]) };
  }
  if (id === 'tasks.series') {
    const timezone = usageTimezone(userId), { from, to, days } = rangeBounds(range, now, timezone);
    const firstDay = reportDay(from, timezone);
    const series = Array.from({ length: days }, (_, n) => ({ day: shiftDay(firstDay, n), created: 0, done: 0 }));
    // Resolve at most 31 calendar boundaries, not an Intl formatter call per task.
    // Timestamp comparisons retain the account's timezone and DST boundaries.
    const bounds = [...series].reverse().flatMap(({ day }) => [reportDayStart(day, timezone), day]);
    const dayCase = (column: 'created_at' | 'updated_at') => `CASE ${series.map(() => `WHEN t.${column}>=? THEN ?`).join(' ')} END`;
    const rows = all(`SELECT ${dayCase('created_at')} AS day, COUNT(*) AS created, 0 AS done
      FROM tasks t WHERE ${taskWhere} AND t.created_at BETWEEN ? AND ? GROUP BY day
      UNION ALL SELECT ${dayCase('updated_at')} AS day, 0, COUNT(*)
      FROM tasks t WHERE ${taskWhere} AND t.state='done' AND t.updated_at BETWEEN ? AND ? GROUP BY day`,
    [...bounds, ...scope.args, from, to, ...bounds, ...scope.args, from, to]);
    for (const row of rows) { const day = series.find(day => day.day === row.day); if (day) { day.created += row.created; day.done += row.done; } }
    return { rows: series, count: series.reduce((n, day) => n + day.created, 0) };
  }
  if (id === 'bots.list' || id === 'bots.status') {
    const count = one('SELECT COUNT(*) AS n FROM bots b WHERE b.user_id=?', [userId]).n;
    if (id === 'bots.list') return { count, rows: all(`SELECT b.id, b.name, b.avatar_shape AS avatarShape,
      b.avatar_color AS avatarColor, b.updated_at AS lastActiveAt FROM bots b WHERE b.user_id=? ORDER BY b.updated_at DESC,b.id LIMIT ?`, [userId, limit]) };
    const attention = new Set(needsYou(userId).map(item => item.botId));
    return { count, rows: all(`WITH selected AS (
        SELECT id,name,user_id,updated_at FROM bots WHERE user_id=? ORDER BY updated_at DESC,id LIMIT ?
      ), open AS (SELECT t.bot_id,COUNT(*) AS n FROM tasks t
        WHERE t.state<>'done' AND t.bot_id IN (SELECT id FROM selected) GROUP BY t.bot_id)
      SELECT b.id,b.name,COALESCE(o.n,0) AS openTasks,
        EXISTS(SELECT 1 FROM agent_jobs j WHERE j.user_id=b.user_id AND j.bot_id=b.id AND j.state='running') AS working
      FROM selected b LEFT JOIN open o ON o.bot_id=b.id ORDER BY b.updated_at DESC,b.id`, [userId, limit])
      .map(({ working, ...bot }) => ({ ...bot, status: attention.has(bot.id) ? 'needs_you' : working ? 'working' : 'ready' })) };
  }
  if (id === 'needsYou.list') { const rows = needsYou(userId); return { count: rows.length, rows: rows.slice(0, limit).map(({ id, type, botName, title, createdAt }) => ({ id, type, botName, title, createdAt })) }; }
  if (id === 'usage.summary' || id === 'usage.series') {
    const report = usageReport(userId, range);
    return id === 'usage.summary' ? { count: report.totals.requests, value: {
      costUsd: report.totals.costUsd, requests: report.totals.requests,
      tokens: report.totals.inputTokens + report.totals.outputTokens, computerHours: report.computer.runningHours,
    } } : { count: report.totals.requests, rows: report.days.map(day => ({ day: day.day,
      value: params.metric === 'requests' ? day.requests : params.metric === 'tokens' ? day.tokens : day.costUsd })) };
  }
  if (id === 'routines.list') {
    const count = one(`SELECT COUNT(*) AS n FROM routines r JOIN bots b ON b.id=r.bot_id WHERE ${scope.where}`, scope.args).n;
    return { count, rows: all(`SELECT r.id, r.name, r.schedule, r.enabled, r.last_run_at AS lastRunAt, b.name AS botName
      FROM routines r JOIN bots b ON b.id=r.bot_id WHERE ${scope.where} ORDER BY r.name,r.id LIMIT 25`, scope.args)
      .map(row => ({ ...row, enabled: !!row.enabled, schedule: row.schedule.startsWith('event:') ? 'When an event arrives' : describeCron(row.schedule) })) };
  }
  if (id === 'routines.upcoming') {
    const routines = all(`SELECT r.id, r.name, r.schedule, r.timezone, b.name AS botName FROM routines r
      JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.enabled=1 AND r.schedule NOT LIKE 'event:%'`, [userId]);
    const rows: Row[] = []; let count = 0;
    const end = now + Number(params.days) * 86400_000;
    for (const routine of routines) {
      try {
        const cron = new Cron(routine.schedule, { timezone: routine.timezone, paused: true });
        // No scheduled callbacks. The outer process deadline also bounds dense cron expressions.
        for (let next = cron.nextRun(new Date(now)); next && next.getTime() <= end; next = cron.nextRun(next)) {
          count++;
          if (rows.length < 25 || next.getTime() < rows[rows.length - 1].at) {
            rows.push({ routineId: routine.id, name: routine.name, at: next.getTime(), botName: routine.botName });
            rows.sort((a, b) => a.at - b.at || a.routineId.localeCompare(b.routineId));
            if (rows.length > 25) rows.pop();
          }
        }
      } catch { /* Invalid stored schedules have no upcoming runs. */ }
    }
    return { count, rows };
  }
  if (id.startsWith('runs.')) {
    const { from, to, days } = rangeBounds(range, now, usageTimezone(userId));
    const where = `${params.botId ? 'botId=? AND ' : ''}${id === 'runs.recent' ? '1=1' : 'createdAt BETWEEN ? AND ?'}`;
    const args = [userId, userId, userId, userId, ...(params.botId ? [params.botId] : []), ...(id === 'runs.recent' ? [] : [from, to])];
    const count = one(`${runsSql} SELECT COUNT(*) AS n FROM runs WHERE ${where}`, args).n;
    if (id === 'runs.recent') return { count, rows: all(`${runsSql} SELECT id, botName, kind, state, startedAt,
      CASE WHEN startedAt IS NULL THEN NULL ELSE MAX(0,COALESCE(finishedAt,?)-startedAt) END AS durationMs
      FROM runs WHERE ${where} ORDER BY COALESCE(startedAt,createdAt) DESC,id LIMIT ?`,
    [...args.slice(0, 4), now, ...args.slice(4), limit]) };
    if (id === 'runs.counts') return { count, value: one(`${runsSql} SELECT COALESCE(SUM(state='completed'),0) AS completed,
      COALESCE(SUM(state='failed'),0) AS failed, COALESCE(SUM(state='running'),0) AS running, COALESCE(SUM(state='queued'),0) AS queued FROM runs WHERE ${where}`, args) };
    if (params.group === 'state') {
      const totals = all(`${runsSql} SELECT state,COUNT(*) AS count FROM runs WHERE ${where} GROUP BY state`, args);
      return { count, rows: ['completed', 'failed', 'running', 'queued'].map(state => ({ state, value: totals.find(row => row.state === state)?.count ?? 0 })) };
    }
    const timezone = usageTimezone(userId);
    const totals = all(`${runsSql} SELECT usage_day(createdAt,?) AS day,COUNT(*) AS count FROM runs WHERE ${where} GROUP BY day`, [...args.slice(0, 4), timezone, ...args.slice(4)]);
    return { count, rows: Array.from({ length: days }, (_, n) => { const day = shiftDay(reportDay(from, timezone), n); return { day, value: totals.find(row => row.day === day)?.count ?? 0 }; }) };
  }
  throw new SourceError('not_found', 'Data source not found.');
}
