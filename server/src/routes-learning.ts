import { Hono } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { KnowledgeError } from './knowledge/common.js';
import { learningSettings, patchLearningSettings } from './knowledge/settings.js';
import { listMemoryChanges, resolveMemoryChange, setMemoryScope } from './knowledge/memory.js';
import { getSkill, listSkills, updateSkill, deleteSkill, setSkillScope, resources } from './knowledge/skills.js';
import { curateSkills } from './knowledge/curator.js';
import { listLearningReviews, refineLearning, cancelLearningReview, learningContext, curateLearning } from './agent/learning.js';
export const learningApi = new Hono<AuthVars>();
learningApi.use('*', requireUser);
learningApi.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
learningApi.onError((e, c) => c.json({ error: e instanceof KnowledgeError ? e.message : 'Learning operation failed' }, e instanceof KnowledgeError ? e.status : 500));
async function body(c: {
    req: {
        json: () => Promise<any>;
    };
}) { try {
    const value = await c.req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
    return value;
}
catch {
    throw new KnowledgeError('Invalid JSON body');
} }
learningApi.get('/settings', c => c.json(learningSettings(c.get('user').id, c.req.query('botId'))));
learningApi.patch('/settings', async (c) => c.json(patchLearningSettings(c.get('user').id, await body(c))));
learningApi.get('/reviews', c => c.json(listLearningReviews(c.get('user').id, { botId: c.req.query('botId'), before: c.req.query('before') ? Number(c.req.query('before')) : undefined, limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined })));
learningApi.post('/bots/:botId/refine', async (c) => { await body(c); return c.json({ review: refineLearning(c.get('user').id, c.req.param('botId')) }, 202); });
learningApi.post('/reviews/:id/cancel', async (c) => { await body(c); return c.json({ review: cancelLearningReview(c.get('user').id, c.req.param('id')) }); });
learningApi.get('/bots/:botId/memory-changes', c => c.json({ changes: listMemoryChanges(c.get('user').id, c.req.param('botId')) }));
learningApi.post('/memory-changes/:id/review', async (c) => { const b = await body(c); return c.json(resolveMemoryChange(c.get('user').id, c.req.param('id'), b.decision, b.expectedBaseRevision)); });
learningApi.get('/bots/:botId/skills', c => c.json({ skills: listSkills(c.get('user').id, c.req.param('botId'), c.req.query('archive') === '1') }));
learningApi.get('/skills/:id', c => c.json({ skill: getSkill(c.get('user').id, c.req.param('id')) }));
learningApi.patch('/skills/:id', async (c) => { const b = await body(c); const allowed = ['expectedRevision', 'name', 'description', 'body', 'resources', 'locked', 'pinned', 'managed']; if (Object.keys(b).some(k => !allowed.includes(k)))
    throw new KnowledgeError('Unknown skill field'); for (const key of ['locked', 'pinned', 'managed'])
    if (b[key] !== undefined && typeof b[key] !== 'boolean')
        throw new KnowledgeError(`${key} must be boolean`); if (b.resources !== undefined)
    resources(b.resources); return c.json({ skill: updateSkill(c.get('user').id, c.req.param('id'), b, b.expectedRevision) }); });
learningApi.post('/skills/:id/archive', async (c) => { const b = await body(c); return c.json({ skill: deleteSkill(c.get('user').id, c.req.param('id'), b.expectedRevision) }); });
learningApi.patch('/:kind/:id/scope', async (c) => { const b = await body(c); const kind = c.req.param('kind'); if (!['skills', 'memories'].includes(kind))
    throw new KnowledgeError('Not found', 404); return c.json({ item: kind === 'skills' ? setSkillScope(c.get('user').id, c.req.param('id'), b) : setMemoryScope(c.get('user').id, c.req.param('id'), b) }); });
learningApi.get('/bots/:botId/context', c => c.json({ context: learningContext(c.get('user').id, c.req.param('botId')) }));
learningApi.post('/bots/:botId/curate', async (c) => { await body(c); return c.json(curateLearning(c.get('user').id, c.req.param('botId'))); });
