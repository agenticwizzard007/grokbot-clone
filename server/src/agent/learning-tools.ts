import type { ToolDef, ToolCtx } from './tools.js';
import { KnowledgeError } from '../knowledge/common.js';
import { toolManagement, withManagement } from '../knowledge/access.js';
import { manageSkill } from '../knowledge/skills.js';
import { listMemories, manageMemory, type MemoryMutation } from '../knowledge/memory.js';
import { db } from '../db.js';
const str = { type: 'string' };
const ref = { type: 'object', properties: { botId: str, generation: { type: 'integer', minimum: 1 }, seq: { type: 'integer', minimum: 1 }, contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, kind: { type: 'string', enum: ['tool'] } }, required: ['botId', 'generation', 'seq'], additionalProperties: false };
const evidence = { type: 'array', items: ref, maxItems: 12 };
const revision = { type: 'integer', minimum: 0 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
function tool(name: string, description: string, parameters: Record<string, unknown>, fn: (a: any, ctx: ToolCtx) => unknown): ToolDef {
    return { name, description, parameters, activity: 'remembering', label: description.split('.')[0], impl: async (a, ctx) => {
            try {
                return withManagement(toolManagement(ctx), () => ({ output: JSON.stringify({ ok: true, ...fn(a, ctx) as object }) }));
            }
            catch (e) {
                return { output: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : 'Knowledge operation failed', status: e instanceof KnowledgeError ? e.status : 500 }), isError: true };
            }
        } };
}
const memoryProperties = { action: { type: 'string', enum: ['add', 'replace', 'patch', 'remove'] }, memory_id: str, expected_revision: revision, text: { type: 'string', maxLength: 1000 }, old_text: str, new_text: str, target: { type: 'string', enum: ['user', 'environment'] }, evidence };
function memoryInput(a: any, ctx: ToolCtx): MemoryMutation {
    if (a.action === 'patch') {
        const cur = listMemories(ctx.userId, ctx.botId).find(m => m.id === a.memory_id);
        if (!cur || typeof a.old_text !== 'string' || !a.old_text || typeof a.new_text !== 'string' || cur.text.split(a.old_text).length !== 2)
            throw new KnowledgeError('Memory patch must match exactly once', 409);
        a = { ...a, action: 'replace', text: cur.text.replace(a.old_text, a.new_text) };
    }
    return { action: a.action, memoryId: a.memory_id, expectedRevision: a.expected_revision, text: a.text, target: a.target, evidence: a.evidence ?? [], runId: ctx.jobId };
}
export const LEARNING_TOOLS: ToolDef[] = [
    tool('manage_skill', 'Create or improve a skill package. With skill approval off guarded writes activate immediately; with approval on they stage. Read the current skill before editing; read each existing support file before replacing/removing it. Prefer improving an existing relevant skill. Locked skills cannot be changed. Scripts are stored resources, not executable permissions.', object({ action: { type: 'string', enum: ['create', 'update', 'patch', 'write_file', 'remove_file', 'delete', 'archive'] }, skill_id: str, expected_revision: revision, name: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 300 }, body: { type: 'string', maxLength: 20000 }, resources: { type: 'object', additionalProperties: { type: 'string' } }, file_path: str, file_content: str, old_text: str, new_text: str, reason: { type: 'string', maxLength: 1000 }, evidence }, ['action', 'expected_revision', 'reason', 'evidence']), (a, ctx) => manageSkill(ctx.userId, ctx.botId, { action: a.action, skillId: a.skill_id, expectedRevision: a.expected_revision, name: a.name, description: a.description, body: a.body, resources: a.resources, filePath: a.file_path, fileContent: a.file_content, oldText: a.old_text, newText: a.new_text, reason: a.reason, evidence: a.evidence, runId: ctx.jobId })),
    tool('manage_memory', 'Manage sourced facts in user or environment memory. User preferences require human evidence; tool observations belong in environment. Unattended replacements, patches and removals ALWAYS stage for review, including batch operations. A batch is atomic. Never save guesses as durable preferences.', object({ ...memoryProperties, action: { type: 'string', enum: ['add', 'replace', 'patch', 'remove', 'batch'] }, operations: { type: 'array', minItems: 1, maxItems: 20, items: object(memoryProperties, ['action', 'expected_revision']) } }, ['action']), (a, ctx) => {
        if (a.action === 'batch') {
            if (!Array.isArray(a.operations) || !a.operations.length || a.operations.length > 20)
                throw new KnowledgeError('Batch must contain 1–20 operations');
            return db.transaction(() => {
                    const current=toolManagement(ctx);
                    // Fence once inside the synchronous transaction. Subsequent
                    // operations must see this batch's own writes; no model or
                    // external callback can interleave before commit.
                    current.guard?.();
                    return withManagement({...current,guard:undefined},()=>({results:a.operations.map((op:any)=>manageMemory(ctx.userId,ctx.botId,memoryInput(op,ctx)))}));
                })();
        }
        return manageMemory(ctx.userId, ctx.botId, memoryInput(a, ctx));
    }),
];
