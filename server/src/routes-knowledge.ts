import { Hono } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { KnowledgeError } from './knowledge/common.js';
import { listSkills, listSkillHistory, listSkillProposals, resolveSkillProposal, rollbackSkill } from './knowledge/skills.js';
import { correctMemory, forgetMemory, listMemories, memoryHistory } from './knowledge/memory.js';
import { readMessageWindow, searchMessages } from './knowledge/sessions.js';
import { hub } from './lib/hub.js';

export const knowledgeApi = new Hono<AuthVars>();
// This router mounts before the legacy API. Scope middleware to knowledge
// resource paths so it cannot intercept public sign-in/OAuth endpoints.
for (const path of ['/bots/*', '/skills/*', '/skill-proposals/*', '/memories/*']) {
  knowledgeApi.use(path, requireUser);
  knowledgeApi.use(path, async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
}
knowledgeApi.onError((e, c) => c.json({ error: e instanceof KnowledgeError ? e.message : 'Knowledge operation failed' }, e instanceof KnowledgeError ? e.status : 500));
const body = async (c: { req: { json: () => Promise<any> } }) => { try { const b = await c.req.json(); if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(); return b; } catch { throw new KnowledgeError('Invalid JSON body'); } };
knowledgeApi.get('/bots/:id/skill-proposals', c => c.json({ proposals: listSkillProposals(c.get('user').id, c.req.param('id')) }));
knowledgeApi.get('/bots/:id/skill-archive', c => c.json({ skills: listSkills(c.get('user').id, c.req.param('id'), true).filter(s => s.deleted) }));
knowledgeApi.post('/skill-proposals/:id/review', async c => { const p = await body(c); return c.json(resolveSkillProposal(c.get('user').id, c.req.param('id'), p.decision, p.expectedBaseRevision)); });
knowledgeApi.get('/skills/:id/history', c => c.json({ revisions: listSkillHistory(c.get('user').id, c.req.param('id')) }));
knowledgeApi.post('/skills/:id/rollback', async c => { const p = await body(c); return c.json({ skill: rollbackSkill(c.get('user').id, c.req.param('id'), p.targetRevision, p.expectedRevision) }); });
knowledgeApi.get('/bots/:id/memories', c => c.json({ memories: listMemories(c.get('user').id, c.req.param('id'), c.req.query('history') === '1') }));
knowledgeApi.get('/memories/:id/history', c => c.json({ events: memoryHistory(c.get('user').id, c.req.param('id')) }));
knowledgeApi.patch('/memories/:id', async c => {
  const p = await body(c); const memory = correctMemory(c.get('user').id, c.req.param('id'), p);
  hub.emit(c.get('user').id, { type: 'memories', botId: memory.botId }); return c.json({ memory });
});
knowledgeApi.delete('/memories/:id', c => {
  const expected = c.req.query('expectedRevision');
  forgetMemory(c.get('user').id, c.req.param('id'), expected === undefined ? undefined : Number(expected));
  return c.json({ ok: true });
});
knowledgeApi.get('/bots/:id/conversation-search', c => c.json(searchMessages(c.get('user').id, c.req.param('id'), c.req.query('q') ?? '', { limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined, offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined, generation: c.req.query('generation') ? Number(c.req.query('generation')) : undefined, role: c.req.query('role') })));
knowledgeApi.get('/bots/:id/messages/:generation/:seq', c => c.json({ messages: readMessageWindow(c.get('user').id, c.req.param('id'), { botId: c.req.param('id'), generation: Number(c.req.param('generation')), seq: Number(c.req.param('seq')), contentHash: c.req.query('contentHash') }, 3) }));
