import './schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { ownBot, writeOwner } from './ownership.js';
import { getRoutineRun, runIdForJob } from './runs.js';
import { DeliverableError, type Artifact } from './types.js';

const MAX_BYTES = 10 * 1024 * 1024;
interface ArtifactRow { id: string; user_id: string; bot_id: string; run_id: string | null; job_id: string | null;
  filename: string; mime_type: string; size: number; sha256: string; created_at: number }
const libraryPath = (a: ArtifactRow) => `Deliverables/${a.id}/${a.filename}`;
const view = (a: ArtifactRow): Artifact => ({ id: a.id, botId: a.bot_id, runId: a.run_id, jobId: a.job_id,
  filename: a.filename, mimeType: a.mime_type, size: a.size, sha256: a.sha256, createdAt: a.created_at,
  libraryPath: libraryPath(a), downloadUrl: `/api/deliverables/artifacts/${a.id}/download` });
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const validSegment = (s: string) => /^[A-Za-z0-9_-]{1,120}$/.test(s);

function filename(name: string) {
  if (!name || Buffer.byteLength(name) > 180 || /[\x00-\x1f\x7f/\\]/.test(name) || name === '.' || name === '..' || /^[A-Za-z]:/.test(name)) {
    throw new DeliverableError('Use a filename without directories or control characters.');
  }
  return name;
}
function mime(name: string) {
  return ({ '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf', '.html': 'text/html' } as Record<string, string>)[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Directory descriptors + O_NOFOLLOW prevent a changed parent/symlink from crossing Bot storage. */
function artifactDirectory(botId: string, artifactId: string, create: boolean): number {
  if (!validSegment(botId) || !validSegment(artifactId)) throw new DeliverableError('Invalid storage identity.');
  if (create) fs.mkdirSync(env.filesDir, { recursive: true, mode: 0o700 });
  let fd = fs.openSync(env.filesDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const part of [botId, 'Deliverables', artifactId]) {
      const next = `/proc/self/fd/${fd}/${part}`;
      if (create) {
        try { fs.mkdirSync(next, { mode: 0o700 }); } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
      }
      const child = fs.openSync(next, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd = child;
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function getArtifact(userId: string, artifactId: string): Artifact {
  const a = db.prepare('SELECT * FROM output_artifacts WHERE id=? AND user_id=?').get(artifactId, userId) as ArtifactRow | undefined;
  if (!a) throw new DeliverableError('Not found.', 404);
  ownBot(userId, a.bot_id);
  return view(a);
}
export function listArtifacts(userId: string, botId: string, runId?: string, limit = 100): Artifact[] {
  ownBot(userId, botId);
  if (runId && getRoutineRun(userId, runId).botId !== botId) throw new DeliverableError('Not found.', 404);
  return (db.prepare('SELECT * FROM output_artifacts WHERE user_id=? AND bot_id=? AND (? IS NULL OR run_id=?) ORDER BY created_at DESC,id DESC LIMIT ?')
    .all(userId, botId, runId ?? null, runId ?? null, Math.max(1, Math.min(limit, 100))) as ArtifactRow[]).map(view);
}

/** Receives actual save_file bytes, never a caller-selected filesystem path. No provider/model calls. */
export function recordArtifact(input: { userId: string; botId: string; jobId?: string; filename: string; content: string | Buffer; mimeType?: string }): Artifact {
  writeOwner(input.userId, input.botId);
  const name = filename(input.filename), content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
  if (content.length > MAX_BYTES) throw new DeliverableError('Report exceeds the 10 MB artifact limit.', 413);
  if (input.jobId && !db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(input.jobId, input.userId, input.botId)) throw new DeliverableError('Job not found.', 404);
  const sha = hash(content), source = JSON.stringify([input.jobId ?? null, name, sha]);
  return db.transaction(() => {
    const previous = db.prepare('SELECT * FROM output_artifacts WHERE bot_id=? AND source_key=?').get(input.botId, source) as ArtifactRow | undefined;
    if (previous) return view(previous);
    const id = newId('artifact'), directory = artifactDirectory(input.botId, id, true);
    try {
      const fd = fs.openSync(`/proc/self/fd/${directory}/${name}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o400);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.fsyncSync(directory);
      const runId = input.jobId ? runIdForJob(input.jobId) : null;
      db.prepare('INSERT INTO output_artifacts(id,user_id,bot_id,run_id,job_id,filename,mime_type,size,sha256,source_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.userId, input.botId, runId, input.jobId ?? null, name, input.mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ? input.mimeType : mime(name), content.length, sha, source, now());
      return getArtifact(input.userId, id);
    } finally { fs.closeSync(directory); }
  })();
}

export function readArtifact(userId: string, artifactId: string): { artifact: Artifact; content: Buffer } {
  const a = getArtifact(userId, artifactId);
  let dir: number | undefined, fd: number | undefined;
  try {
    filename(a.filename);
    dir = artifactDirectory(a.botId, a.id, false);
    fd = fs.openSync(`/proc/self/fd/${dir}/${a.filename}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== a.size || stat.size > MAX_BYTES) throw new Error('Invalid artifact size.');
    const content = fs.readFileSync(fd);
    if (content.length !== a.size || hash(content) !== a.sha256) throw new Error('Artifact content changed.');
    return { artifact: a, content };
  } catch { throw new DeliverableError('Saved report is unavailable or failed its integrity check.', 409); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (dir !== undefined) fs.closeSync(dir); }
}
