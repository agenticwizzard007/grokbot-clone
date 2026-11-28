import './schema.js';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { assertLegacyWorkOpen } from '../security/legacy-work.js';
import { getArtifact, readArtifact } from './artifacts.js';
import { DeliverableError, type ArtifactRole, type ArtifactMember, type ArtifactComment, type CollaborativeArtifact } from './types.js';

db.exec(`
CREATE TABLE IF NOT EXISTS artifact_members (
  artifact_id TEXT NOT NULL REFERENCES output_artifacts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('viewer','commenter')), created_at INTEGER NOT NULL,
  PRIMARY KEY(artifact_id,user_id)
);
CREATE INDEX IF NOT EXISTS artifact_members_user ON artifact_members(user_id,artifact_id);
CREATE TABLE IF NOT EXISTS artifact_comments (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES output_artifacts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL, created_at INTEGER NOT NULL, request_id TEXT NOT NULL,
  UNIQUE(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS artifact_comments_artifact ON artifact_comments(artifact_id,created_at);
`);

function access(userId: string, id: string): { ownerId: string; role: ArtifactRole } {
  assertTenant(userId);
  const row = db.prepare(`SELECT a.user_id AS ownerId, m.role FROM output_artifacts a
    LEFT JOIN artifact_members m ON m.artifact_id=a.id AND m.user_id=? WHERE a.id=?`).get(userId, id) as { ownerId: string; role: ArtifactRole | null } | undefined;
  if (!row || (row.ownerId !== userId && !row.role)) throw new DeliverableError('Artifact not found or access has been removed.', 404);
  // Preserve deployment fences even for explicitly shared artifacts.
  assertTenant(row.ownerId);
  return { ownerId: row.ownerId, role: row.ownerId === userId ? 'owner' : row.role! };
}
export function collaborationArtifact(userId: string, id: string): CollaborativeArtifact {
  const { ownerId, role } = access(userId, id);
  const a = getArtifact(ownerId, id);
  const owner = db.prepare('SELECT name FROM users WHERE id=?').get(ownerId) as { name: string };
  const bot = db.prepare('SELECT name FROM bots WHERE id=?').get(a.botId) as { name: string };
  const counts = db.prepare(`SELECT (SELECT count(*) FROM artifact_members WHERE artifact_id=?) memberCount,
    (SELECT count(*) FROM artifact_comments WHERE artifact_id=?) commentCount`).get(id, id) as { memberCount: number; commentCount: number };
  return { ...a, role, ownerName: owner.name, botName: bot.name, ...counts };
}
export function artifactLibrary(userId: string, offset = 0, botId?: string) {
  assertTenant(userId);
  const condition = `FROM output_artifacts a WHERE (a.user_id=? OR EXISTS
    (SELECT 1 FROM artifact_members m WHERE m.artifact_id=a.id AND m.user_id=?)) AND (? IS NULL OR a.bot_id=?)`;
  const args = [userId, userId, botId ?? null, botId ?? null];
  const { total } = db.prepare(`SELECT count(*) total ${condition}`).get(...args) as { total: number };
  const rows = db.prepare(`SELECT a.id ${condition} ORDER BY a.created_at DESC,a.id DESC LIMIT 60 OFFSET ?`).all(...args, offset) as { id: string }[];
  return { artifacts: rows.map(row => collaborationArtifact(userId, row.id)), total };
}
export function sharedArtifactContent(userId: string, id: string) {
  const { ownerId } = access(userId, id);
  return readArtifact(ownerId, id);
}
export function artifactMembers(userId: string, id: string): ArtifactMember[] {
  const { ownerId } = access(userId, id);
  const owner = db.prepare('SELECT id AS userId,name,email FROM users WHERE id=?').get(ownerId) as Omit<ArtifactMember, 'role'>;
  const members = db.prepare(`SELECT u.id AS userId,u.name,u.email,m.role FROM artifact_members m
    JOIN users u ON u.id=m.user_id WHERE m.artifact_id=? ORDER BY m.created_at,u.id`).all(id) as ArtifactMember[];
  // Email addresses are needed only by the owner managing access.
  return [{ ...owner, role: 'owner' as const }, ...members].map(member => ({ ...member, email: userId === ownerId ? member.email : '' }));
}
export function setArtifactMember(userId: string, id: string, email: string, role: 'viewer' | 'commenter' | 'remove') {
  getArtifact(userId, id); assertLegacyWorkOpen(userId);
  const member = db.prepare('SELECT id FROM users WHERE lower(email)=?').get(email.trim().toLowerCase()) as { id: string } | undefined;
  if (!member) throw new DeliverableError('No account with this email on this workspace. Ask your teammate to sign up here first.');
  try { assertTenant(member.id); } catch { throw new DeliverableError('This account is outside this workspace.'); }
  if (member.id === userId) throw new DeliverableError('The artifact owner always has full access.');
  if (role === 'remove') db.prepare('DELETE FROM artifact_members WHERE artifact_id=? AND user_id=?').run(id, member.id);
  else db.prepare(`INSERT INTO artifact_members(artifact_id,user_id,role,created_at) VALUES(?,?,?,?)
    ON CONFLICT(artifact_id,user_id) DO UPDATE SET role=excluded.role`).run(id, member.id, role, now());
  return artifactMembers(userId, id);
}
export function artifactComments(userId: string, id: string): ArtifactComment[] {
  access(userId, id);
  return db.prepare(`SELECT c.id,c.body,c.created_at AS createdAt,c.user_id AS userId,u.name AS authorName
    FROM artifact_comments c JOIN users u ON u.id=c.user_id WHERE c.artifact_id=? ORDER BY c.created_at,c.id`).all(id) as ArtifactComment[];
}
export function addArtifactComment(userId: string, id: string, body: string, requestId: string) {
  const { role } = access(userId, id); assertLegacyWorkOpen(userId);
  if (role === 'viewer') throw new DeliverableError('You have view-only access. Ask the owner for comment access.', 409);
  return db.transaction(() => {
    const prior = db.prepare('SELECT artifact_id,body FROM artifact_comments WHERE user_id=? AND request_id=?').get(userId, requestId) as { artifact_id: string; body: string } | undefined;
    if (prior && (prior.artifact_id !== id || prior.body !== body)) throw new DeliverableError('This comment request was already used.', 409);
    if (!prior) db.prepare('INSERT INTO artifact_comments(id,artifact_id,user_id,body,created_at,request_id) VALUES(?,?,?,?,?,?)')
      .run(newId('comment'), id, userId, body, now(), requestId);
    return artifactComments(userId, id);
  })();
}
