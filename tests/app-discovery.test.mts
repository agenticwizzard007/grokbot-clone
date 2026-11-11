import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMetadataCache, rankAppTools, stem, tokens } from '../server/src/platform/app-discovery.js';

// Shapes recorded from the live Composio API (tools.list for the github toolkit, 2026-11-11):
// every tool carries slug, description, tags (readOnlyHint / createHint / updateHint / destructiveHint /
// idempotentHint / openWorldHint / important / category labels), toolkit.slug and isDeprecated.
const gh = (slug: string, description: string, tags: string[], extra: Record<string, unknown> = {}) =>
  ({ slug, description, tags, toolkit: { slug: 'github' }, isDeprecated: false, version: '20261104_00', ...extra });
const TOOLS = [
  gh('GITHUB_ABORT_REPOSITORY_MIGRATION', 'Aborts a repository migration in progress.', ['destructiveHint', 'openWorldHint', 'Migrations']),
  gh('GITHUB_ACCEPT_REPOSITORY_INVITATION', 'Accepts a pending repository invitation for the authenticated user.', ['updateHint', 'openWorldHint', 'Repositories']),
  gh('GITHUB_ADD_APP_ACCESS_RESTRICTIONS', 'Grants GitHub Apps push access to a protected branch.', ['updateHint', 'openWorldHint', 'Repositories']),
  gh('GITHUB_ADD_A_REPOSITORY_COLLABORATOR', 'Invites a user to collaborate on a repository.', ['important', 'updateHint', 'openWorldHint', 'Collaborators']),
  gh('GITHUB_ADD_ASSIGNEES_TO_AN_ISSUE', 'Adds assignees to an issue.', ['important', 'updateHint', 'openWorldHint', 'Issues']),
  gh('GITHUB_ADD_LABELS_TO_AN_ISSUE', 'Adds labels to an issue.', ['important', 'updateHint', 'openWorldHint', 'Issues']),
  gh('GITHUB_ADD_SELECTED_REPOSITORY_TO_ORGANIZATION_SECRET', 'Adds a repository to an organization secret.', ['idempotentHint', 'updateHint', 'openWorldHint', 'Code Spaces']),
  gh('GITHUB_CLOSE_ISSUE', 'Closes an issue.', ['important', 'updateHint', 'openWorldHint', 'Issues']),
  gh('GITHUB_CREATE_AN_ISSUE', 'Creates a new issue in a repository.', ['important', 'openWorldHint', 'Repository Management', 'createHint']),
  gh('GITHUB_CREATE_AN_ISSUE_COMMENT', 'Creates a comment on an issue.', ['important', 'openWorldHint', 'Issues', 'createHint']),
  gh('GITHUB_CREATE_A_PULL_REQUEST', 'Creates a pull request.', ['important', 'openWorldHint', 'Pull Requests', 'createHint']),
  gh('GITHUB_CREATE_REPOSITORY', 'Creates a repository for the authenticated user.', ['important', 'openWorldHint', 'Repositories', 'createHint']),
  gh('GITHUB_DELETE_A_REPOSITORY', 'Deletes a repository.', ['important', 'destructiveHint', 'openWorldHint', 'Repositories']),
  gh('GITHUB_FIND_REPOSITORIES', 'Searches repositories by query.', ['important', 'readOnlyHint', 'openWorldHint', 'Search']),
  gh('GITHUB_GET_A_PULL_REQUEST', 'Gets a pull request.', ['important', 'readOnlyHint', 'openWorldHint', 'Pull Requests']),
  gh('GITHUB_GET_THE_AUTHENTICATED_USER', 'Gets the authenticated user.', ['readOnlyHint', 'idempotentHint', 'openWorldHint', 'Users']),
  gh('GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER', 'Lists issues assigned to the authenticated user across all visible repositories.', ['readOnlyHint', 'openWorldHint', 'Issues']),
  gh('GITHUB_LIST_PULL_REQUESTS', 'Lists pull requests in a repository.', ['important', 'readOnlyHint', 'openWorldHint', 'Pull Requests']),
  gh('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', "Lists repositories for the authenticated user; using 'type' with 'visibility' or 'affiliation' API parameters (not in this model) can cause a 422 error.", ['openWorldHint', 'readOnlyHint', 'repos', 'important']),
  gh('GITHUB_LIST_REPOSITORY_ISSUES', 'Lists issues in a repository.', ['important', 'readOnlyHint', 'openWorldHint', 'Issues']),
  gh('GITHUB_LIST_REPOSITORIES_FOR_A_USER', 'Lists public repositories for a user.', ['readOnlyHint', 'openWorldHint', 'Repositories']),
  gh('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER_LEGACY', 'Deprecated legacy listing.', ['readOnlyHint'], { isDeprecated: true }),
  gh('GITHUB_REPOS_LIST', 'Lists repositories (alias).', ['readOnlyHint', 'openWorldHint'], { isDeprecated: true }),
];
// Pad with alphabetical write tools so the alphabetical first page never contains the wanted reads.
for (let i = 0; i < 40; i++) TOOLS.push(gh(`GITHUB_ADD_${String.fromCharCode(65 + (i % 26))}${i}_RESTRICTION`, 'Adds a restriction.', ['updateHint', 'openWorldHint']));
const top = (query: string, n = 3, preferReadOnly = false) => rankAppTools(TOOLS, query, { limit: n, preferReadOnly }).map((t) => t.slug);

test('stems and tokenizes queries and slugs deterministically', () => {
  assert.equal(stem('repositories'), 'repositori');
  assert.equal(stem('issues'), 'issu');
  assert.deepEqual(tokens('List my repositories, please!'), ['list', 'my', 'repositori']);
  assert.deepEqual(tokens('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER'), ['github', 'list', 'repositori', 'authenticat', 'user']);
});

test('"list repositories" surfaces the authenticated-user listing instead of the alphabetical ADD_* page', () => {
  const result = top('list repositories', 4);
  assert.ok(result.includes('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER'), result.join(','));
  assert.ok(result.includes('GITHUB_LIST_REPOSITORIES_FOR_A_USER'), result.join(','));
  assert.ok(result.every((s) => s.includes('LIST') || s.includes('FIND')), result.join(','));
  assert.ok(!rankAppTools(TOOLS, 'list repositories', { limit: 6 }).some((t) => t.slug.startsWith('GITHUB_ADD_')), 'first page is not the alphabetical ADD_* noise');
});

test('natural phrasings reach the right tools through synonyms and descriptions', () => {
  assert.equal(top('my repos')[0], 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER');
  assert.equal(top('create issue')[0], 'GITHUB_CREATE_AN_ISSUE');
  assert.equal(top('open a pull request')[0], 'GITHUB_CREATE_A_PULL_REQUEST');
  assert.equal(top('who am I authenticated user')[0], 'GITHUB_GET_THE_AUTHENTICATED_USER');
  assert.ok(top('issues assigned to me', 2).includes('GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER'));
});

test('read-only preference reorders ties toward attested reads and never admits write tools as reads', () => {
  const reads = rankAppTools(TOOLS, 'repository', { limit: 5, preferReadOnly: true });
  assert.ok(reads.slice(0, 3).every((t) => t.tags!.includes('readOnlyHint')), reads.map((t) => t.slug).join(','));
  // Preference only orders; a write tool keeps its own tags for the policy layer.
  const create = rankAppTools(TOOLS, 'create repository', { limit: 1, preferReadOnly: true })[0];
  assert.equal(create.slug, 'GITHUB_CREATE_REPOSITORY');
  assert.ok(create.tags!.includes('createHint'));
});

test('empty query returns provider-important tools first; deprecated tools are never returned; results are bounded', () => {
  const empty = rankAppTools(TOOLS, '', { limit: 10 });
  assert.equal(empty.length, 10);
  assert.ok(empty.every((t) => t.tags!.includes('important')));
  assert.ok(!rankAppTools(TOOLS, 'repositories', { limit: 100 }).some((t) => t.isDeprecated));
  assert.equal(rankAppTools(TOOLS, 'repositories', { limit: 1000 }).length <= 100, true);
  // A query matching nothing still yields the toolkit's default page (important first), never an empty page.
  const none = rankAppTools(TOOLS, 'zzzz qqqq', { limit: 5 });
  assert.equal(none.length, 5);
  assert.ok(none.every((t) => t.tags!.includes('important')));
  // A partial match is completed with default tools after the matches.
  const partial = rankAppTools(TOOLS, 'authenticated user', { limit: 8 });
  assert.equal(partial.length, 8);
  assert.equal(partial[0].slug, 'GITHUB_GET_THE_AUTHENTICATED_USER');
});

test('ranking is stable and pure: same input yields the same order and does not mutate tools', () => {
  const snapshot = JSON.stringify(TOOLS);
  const a = top('list repositories', 10), b = top('list repositories', 10);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(TOOLS), snapshot);
});

test('metadata cache de-duplicates in-flight loads, expires by TTL and forgets failures', async () => {
  let loads = 0;
  const cache = createMetadataCache<number>(50);
  const load = async () => { loads++; await new Promise((r) => setTimeout(r, 5)); return loads; };
  const [x, y] = await Promise.all([cache.get('github', load), cache.get('github', load)]);
  assert.equal(x, 1); assert.equal(y, 1); assert.equal(loads, 1);
  assert.equal(await cache.get('github', load), 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await cache.get('github', load), 2);
  await assert.rejects(cache.get('slack', async () => { throw new Error('provider down'); }));
  assert.equal(await cache.get('slack', async () => 7), 7);
});
