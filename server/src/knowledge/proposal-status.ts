import { db } from '../db.js';

/** Derive supersession for legacy rows too, without rewriting customer history.
 * Only a proposal for this Bot and the same skill/name can replace a candidate.
 * An edit based on the current revision remains pending while that skill is active.
 */
export function skillProposalStatus(proposal: {
  id: string; bot_id: string; skill_id: string; base_revision: number; snapshot: string; status: string;
}): string {
  if (proposal.status !== 'pending') return proposal.status;
  const name = JSON.parse(proposal.snapshot).name;
  const active = db.prepare(`SELECT 1 FROM skills WHERE bot_id=? AND (
    (id=? AND (revision!=? OR deleted_at IS NOT NULL)) OR
    (deleted_at IS NULL AND lifecycle='active' AND lower(trim(name))=lower(trim(?)) AND
      (?=0 OR (id!=? AND created_at >= (SELECT created_at FROM knowledge_skill_proposals WHERE id=?))))
  )`).get(proposal.bot_id, proposal.skill_id, proposal.base_revision, name, proposal.base_revision, proposal.skill_id, proposal.id);
  if (active) return 'superseded';
  // A later activation still supersedes the old proposal after a rename or
  // archive. Immutable revisions prevent stale rows from reappearing then.
  const activated = db.prepare(`SELECT 1 FROM knowledge_skill_revisions r
    JOIN knowledge_skill_proposals p ON p.id=?
    WHERE r.bot_id=p.bot_id AND r.skill_id!=p.skill_id AND r.created_at>=p.created_at
    AND lower(trim(json_extract(r.snapshot,'$.name')))=lower(trim(?)) LIMIT 1`).get(proposal.id, name);
  if (activated) return 'superseded';
  const newer = db.prepare(`SELECT 1 FROM knowledge_skill_proposals p
    JOIN knowledge_skill_proposals old ON old.id=?
    WHERE p.bot_id=old.bot_id AND (p.skill_id=old.skill_id OR
      lower(trim(json_extract(p.snapshot,'$.name')))=lower(trim(json_extract(old.snapshot,'$.name'))))
    AND (p.created_at>old.created_at OR (p.created_at=old.created_at AND p.rowid>old.rowid)) LIMIT 1`).get(proposal.id);
  return newer ? 'superseded' : 'pending';
}
