import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.WORK_ORIGIN ?? 'http://127.0.0.1:5191';
const evidence = process.env.WORK_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const now = Date.now();
const bots = ['Quinn', 'Nia', 'Ellis'].map((name, index) => ({ id: name.toLowerCase(), name, label: index ? 'Teammate' : 'Chief of Staff', kind: 'agent', mode: 'personal', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue', isPrimary: index === 0, pinned: index === 0, effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: null, lastActivityAt: now, createdAt: now }));
const tasks = [
  { id: 'pending-nia', botId: 'nia', title: 'Choose source material', note: 'Which sources should I use?', state: 'needs_input', updatedAt: now - 2000 },
  { id: 'pending-quinn', botId: 'quinn', title: 'Review launch note', note: 'Needs your permission to post', state: 'needs_input', updatedAt: now - 1000 },
  { id: 'working-quinn', botId: 'quinn', title: 'Summarize customer feedback', note: 'Reading customer feedback', state: 'working', updatedAt: now },
  { id: 'done-quinn', botId: 'quinn', title: 'Draft launch brief', note: 'Ready to review', state: 'done', updatedAt: now },
];
const criteria = [{ id: 'result', kind: 'result', description: 'Check result' }];
const workflowTask = (id, title, extra = {}) => ({ id, key: id, title, instructions: title, status: 'ready', reason: '', dependsOn: [], assignedBotId: null, workerBotId: null, activeJobId: null, correctionCount: 0, result: null, resultValidated: false, criteria, evidence: [], ...extra });
const workflow = { id: 'workflow', userId: 'fixture-owner', botId: 'quinn', title: 'Launch brief workflow', status: 'draft', reason: '', goalId: null, tasks: [workflowTask('gather', 'Gather launch notes', { status: 'completed', assignedBotId: 'nia', result: { summary: 'Notes saved' }, resultValidated: true, evidence: [{ kind: 'result', taskId: 'gather' }] }), workflowTask('risks', 'Review risks'), workflowTask('draft', 'Draft brief')] };
const jobWorkflow = { id: 'job-workflow', botId: 'quinn', title: 'Assignment evidence workflow', status: 'active', reason: '', tasks: [
  workflowTask('verified', 'Verified source notes', { status: 'completed', resultValidated: true }),
  workflowTask('unverified', 'Unverified risk review', { status: 'completed', resultValidated: false }),
  workflowTask('job-draft', 'Draft verified brief', { status: 'running', assignedBotId: 'nia', workerBotId: 'nia', activeJobId: 'actual-quinn-job', dependsOn: ['verified', 'unverified', 'missing-prerequisite'] }),
] };
const actualJob = { id: 'actual-quinn-job', botId: 'quinn', state: 'running', createdAt: now, workflowId: jobWorkflow.id, taskId: 'job-draft', parentJobId: null, goalId: null };
const routine = { id: 'routine-1', botId: 'quinn', name: 'Morning check-in', prompt: 'Summarize work', schedule: '0 8 * * 1-5', timezone: 'UTC', enabled: true, nextRunAt: now + 7200000, lastRunAt: null, description: 'Weekdays at 08:00' };
const run = { id: 'run-1', botId: 'quinn', routineId: routine.id, routineName: routine.name, jobId: null, kind: 'manual', status: 'completed', error: null, createdAt: now, startedAt: now, finishedAt: now };
const sha = 'a'.repeat(64);
const file = { id: 'file-1', botId: 'quinn', runId: run.id, jobId: null, filename: 'Launch brief.md', mimeType: 'text/markdown', size: 4200, sha256: sha, createdAt: now, libraryPath: '/Launch brief.md', downloadUrl: '/api/deliverables/artifacts/file-1/download', deliveries: [] };
const unknownDelivery = { id: 'delivery-unknown', artifactId: file.id, channel: 'sms', status: 'unknown', error: null, createdAt: now, updatedAt: now, attempts: [{ id: 'attempt-1', number: 1, status: 'unknown', error: null, startedAt: now, finishedAt: now, externalId: null }] };
const fixtureSettings = { enabled: false, timezone: 'UTC', timezoneSource: 'utc_fallback', times: ['09:00'], quietHours: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });

async function harness(viewport, colorScheme) {
  const page = await browser.newPage({ viewport, colorScheme, reducedMotion: 'reduce' });
  page.setDefaultTimeout(9000);
  const errors = [], requests = [], traffic = [];
  const fixture = { goals: [], workflow: structuredClone(workflow), settings: structuredClone(fixtureSettings), routine: { ...routine }, artifact: structuredClone(file), enabled: true, taskError: false, failNextDelivery: true, withholdNia: null, jobPresent: true };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    assert.equal(url.origin, origin, `Unexpected non-fixture network request: ${url.origin}`);
    if (!path.startsWith('/api/')) return route.continue();
    if (path.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
    traffic.push(`${method} ${path}${url.search}`);
    const body = request.postData() ? request.postDataJSON() : null;
    if (method !== 'GET') requests.push({ path, method, body, key: request.headers()['idempotency-key'] });
    const userId = 'fixture-owner';
    const done = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === '/api/auth/me') return done({ user: { id: userId, name: 'Alex Rivera', email: 'alex@example.com', avatarUrl: null } });
    if (path === '/api/bots') return done({ bots, live: [] });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' });
    if (/\/rows$/.test(path)) return done({ rows: [], generation: 1 });
    if (/\/tasks$/.test(path)) {
      const botId = path.match(/\/bots\/([^/]+)\/tasks/)?.[1];
      if (botId === 'nia' && fixture.withholdNia) await fixture.withholdNia;
      return fixture.taskError ? done({ error: 'Fixture task read failed' }, 503) : done({ tasks: tasks.filter(task => !botId || task.botId === botId) });
    }
    if (/\/bots\/[^/]+\/routines$/.test(path)) return done({ routines: path.includes('/quinn/') && fixture.routine ? [fixture.routine] : [] });
    if (/\/coworker-setups$/.test(path)) return done({ setups: [] });
    if (path === '/api/computer') return done({ computer: { status: 'absent', screens: [] } });
    if (path === '/api/voice/options') return done({ voices: [], languages: [], speeds: [], configured: false });
    if (path === '/api/team/state') return done({ state: { userId, generatedAt: now, eventCursor: 9, primaryBotId: 'quinn', sourceVersions: { workflows: 'fixture' }, agents: bots.map(bot => ({ botId: bot.id, name: bot.name, isPrimary: bot.isPrimary, parentBotId: null, status: bot.id === 'ellis' ? 'idle' : 'waiting', pendingDecision: bot.id !== 'ellis', setupStatus: 'active', setupRevision: 1, activeJobIds: [], lastObservedAt: now, observation: 'observed' })), jobs: fixture.jobPresent ? [actualJob] : [], workflows: [fixture.workflow, jobWorkflow], goals: fixture.goals, artifacts: [{ id: file.id, botId: file.botId, title: file.filename, status: 'available' }], deliveries: [], requests: {}, coverage: {}, humanSources: { pending: 0 }, health: { runtime: fixture.enabled ? 'healthy' : 'disabled', lastTickAt: now, lastError: null, pendingWakes: 0 } } });
    if (path === '/api/team/settings' && method === 'PATCH') { fixture.enabled = body.enabled; return done({ enabled: fixture.enabled }); }
    if (path === '/api/team/records') return done({ records: [{ id: 'job-quinn', bot_id: 'quinn', state: 'completed', created_at: now }, { id: 'job-nia', bot_id: 'nia', state: 'queued', created_at: now }], nextCursor: 2, through: 2, hasMore: false });
    if (path === '/api/team/requests') return done({ requests: [{ seq: 1, id: 'req_fixture123456', fromBotId: 'quinn', toBotId: 'nia', text: 'Draft the launch note.', status: 'completed', kind: 'request', correlationId: 'req_fixturecorrelation1', parentRequestId: null, depth: 0, audience: 'internal', jobId: 'job_fixture123456', result: 'Draft saved.', reason: '', revision: 1, createdAt: now, updatedAt: now }], nextCursor: 1, hasMore: false });
    if (path === '/api/workflows' && method === 'GET') {
      const scope = url.searchParams.get('botId');
      return done({ goals: fixture.goals.filter(goal => !scope || goal.botId === scope), workflows: !scope || scope === fixture.workflow.botId ? [fixture.workflow] : [] });
    }
    if (path === '/api/workflows/goals' && method === 'POST') {
      const goal = { id: 'goal-1', userId, status: 'active', reason: '', turnsUsed: 0, tokensUsed: 0, spendUsd: 0, unknownTokenTurns: 0, unknownSpendTurns: 0, evidence: [], ...body };
      fixture.goals.push(goal); return done({ goal }, 201);
    }
    if (path === '/api/workflows/goals/goal-1/control') return done({ goal: fixture.goals[0] });
    if (path === '/api/workflows/workflow/dependencies') {
      if (body.taskId === 'risks') return done({ error: 'Dependency cycle detected.' }, 400);
      fixture.workflow.tasks.find(task => task.id === body.taskId).dependsOn.push(body.dependsOnId);
      return done({ workflow: fixture.workflow });
    }
    if (path === '/api/workflows/workflow/tasks/risks/delegate') {
      Object.assign(fixture.workflow.tasks[1], { assignedBotId: body.workerBotId, workerBotId: body.workerBotId });
      return done({ childBotId: body.workerBotId, workerBotId: body.workerBotId });
    }
    if (path === '/api/workflows/workflow/control') {
      Object.assign(fixture.workflow, { status: body.action === 'block' ? 'blocked' : 'active', reason: body.reason ?? '' });
      return done({ workflow: fixture.workflow });
    }
    if (path === '/api/checkins' && method === 'PUT') {
      fixture.settings = { ...fixture.settings, ...body, timezoneSource: body.timezone ? 'explicit' : fixture.settings.timezoneSource };
      return done(fixture.settings);
    }
    if (path === '/api/checkins') return done(fixture.settings);
    if (path === '/api/checkins/reports') return done({ reports: [], nextCursor: 0, hasMore: false });
    if (path === '/api/deliverables/bots/quinn') return done({ artifacts: [fixture.artifact] });
    if (path === '/api/deliverables/bots/nia') return done({ artifacts: [] });
    if (path === '/api/deliverables/artifacts/file-1/delivery-preview') return done({ destination: { target: { channel: body.channel, revision: 'fixture-1' }, recipient: body.channel === 'sms' ? 'SMS: +1 (202) 555-0146' : 'Library', artifact_sha256: sha, proof: 'fixture-proof' } });
    if (path === '/api/deliverables/artifacts/file-1/deliveries') {
      if (fixture.failNextDelivery) { fixture.failNextDelivery = false; return done({ error: 'Read response was lost' }, 503); }
      const delivery = { id: 'delivery-1', artifactId: file.id, channel: body.channel, status: 'delivered', error: null, createdAt: now, updatedAt: now, attempts: [] };
      fixture.artifact.deliveries = [...fixture.artifact.deliveries.filter(item => item.id !== delivery.id), delivery]; return done({ delivery });
    }
    if (path === '/api/deliverables/deliveries/delivery-unknown/reconcile') {
      const delivery = fixture.artifact.deliveries.find(item => item.id === 'delivery-unknown');
      delivery.status = 'failed'; delivery.reconciliations = [{ id: 'verification-1', attemptId: body.expectedAttemptId, outcome: body.outcome, evidence: body.evidence, createdAt: now }];
      return done({ delivery });
    }
    if (path === '/api/deliverables/bots/quinn/runs') return done({ runs: [run] });
    if (path === '/api/deliverables/runs/run-1') return done({ run, artifacts: [file] });
    if (path === '/api/routines/routine-1' && method === 'PATCH') { fixture.routine.enabled = body.enabled; return done({ routine: fixture.routine }); }
    if (path === '/api/routines/routine-1' && method === 'DELETE') { fixture.routine = null; return done({ ok: true }); }
    return done({});
  });
  const sidebar = page.locator('.sidebar').getByRole('button', { name: /^Tasks(?: \d|$)/ });
  const tab = name => page.getByRole('navigation', { name: 'Work sections' }).getByRole('button', { name, exact: true });
  const button = name => page.getByRole('button', { name, exact: true });
  const submit = name => button(name).click();
  const shot = name => evidence && page.screenshot({ path: join(evidence, `${name}.png`) });
  const checkFits = async () => {
    assert.equal(await page.locator('.tasks-view__scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    assert.deepEqual(await page.locator('.tasks-view button:visible, .tasks-view select:visible').evaluateAll(elements => elements.filter(element => {
      const bounds = element.getBoundingClientRect(); return bounds.left < -1 || bounds.right > innerWidth + 1;
    }).map(element => element.textContent)), []);
  };
  const open = async () => { await page.goto(origin); await sidebar.click(); await page.getByText('2 tasks need your input', { exact: true }).waitFor(); };
  return { page, fixture, errors, requests, traffic, sidebar, tab, button, submit, shot, checkFits, open };
}

try {
  const desktop = await harness({ width: 1440, height: 1026 }, 'light');
  const { page, fixture, errors, requests, traffic, sidebar, tab, submit, shot, checkFits, open } = desktop;
  const work = page.locator('.tasks-view');
  await open(); await checkFits(); await shot('work-tasks-desktop-light');
  const columns = await page.locator('.task-column').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
  assert.equal(new Set(columns).size, 1);
  await tab('Team').click(); await page.getByText('Team snapshot', { exact: true }).waitFor(); await shot('work-team-desktop-light');
  // R2F-002 (WS3 Team board): internal request ids stay out of the visible text.
  await submit('Internal team activity');
  await page.locator('.tasks-view details summary').filter({ hasText: 'request · completed' }).first().click();
  await page.getByText('Draft the launch note.', { exact: true }).first().waitFor();
  assert.doesNotMatch(await page.locator('.tasks-view').innerText(), /\b(ca|req|apr)_[A-Za-z0-9_-]{6,}/, 'no raw request ids on screen');
  await submit('Internal team activity');
  await submit('Current job');
  const currentJob = page.getByRole('region', { name: 'Current job for Draft verified brief', exact: true });
  await currentJob.getByText('Assignee: Quinn', { exact: true }).waitFor();
  assert.equal(await currentJob.getByText('Assignee: Nia', { exact: true }).count(), 0, 'job assignee comes from the actual job, not the planned worker');
  await currentJob.getByText('Status: Running', { exact: true }).waitFor();
  await currentJob.getByText('Verified source notes · Completed · Verified result', { exact: true }).waitFor();
  await currentJob.getByText('Unverified risk review · Completed · No validated result recorded', { exact: true }).waitFor();
  await currentJob.getByText('missing-prerequisite · Not present in this snapshot', { exact: true }).waitFor();
  await currentJob.getByText('Result: No validated result recorded.', { exact: true }).waitFor();
  await shot('work-current-job-desktop-light');
  fixture.jobPresent = false; await submit('Refresh board');
  await currentJob.getByText('Not present in this snapshot. Assignee and status are unavailable.', { exact: true }).waitFor();
  assert.equal(await currentJob.getByText('Assignee: Quinn', { exact: true }).count(), 0, 'missing job does not infer an assignee');
  fixture.jobPresent = true; await submit('Refresh board');
  await currentJob.getByText('Assignee: Quinn', { exact: true }).waitFor();
  await submit('Complete team work history'); await page.getByText('Quinn · Completed', { exact: true }).waitFor();
  const coordination = page.getByRole('switch', { name: 'Account coordination' });
  await coordination.click(); await page.getByText(/Runtime disabled/).waitFor();
  assert.deepEqual(requests.at(-1).body, { enabled: false });
  assert.equal(await page.getByText('Quinn · Completed', { exact: true }).count(), 1);
  await page.reload(); await sidebar.click(); await tab('Team').click(); await page.getByText(/Runtime disabled/).waitFor();
  assert.equal(await coordination.isChecked(), false);
  await coordination.click(); await page.getByText(/Runtime healthy/).waitFor();
  assert.deepEqual(requests.at(-1).body, { enabled: true });

  await tab('Tasks').click(); await submit('Show pending');
  let release; fixture.withholdNia = new Promise(resolve => { release = resolve; });
  const scope = page.getByRole('combobox', { name: 'Filter tasks by bot' });
  const niaGet = page.waitForRequest('**/api/bots/nia/tasks');
  await scope.selectOption('nia'); await niaGet; await page.getByText('Loading tasks…', { exact: true }).waitFor();
  assert.equal(await page.getByText('No tasks yet', { exact: true }).count(), 0);
  await scope.selectOption('quinn'); await page.getByText('Review launch note', { exact: true }).waitFor(); release(); fixture.withholdNia = null;
  assert.equal(await page.getByText('Choose source material', { exact: true }).count(), 0);
  await scope.selectOption('nia'); await page.getByText('Choose source material', { exact: true }).waitFor();
  await shot('work-tasks-filtered-desktop-light');
  assert.equal(Math.round(await work.locator('.task-card').evaluate(element => element.getBoundingClientRect().width)), 720);
  await tab('Team').click(); await submit('Complete team work history'); await page.getByText('Nia · Queued', { exact: true }).waitFor();
  assert.equal(await page.getByText('Quinn · Completed', { exact: true }).count(), 0);
  await page.getByRole('checkbox', { name: 'Show all Bots in work history' }).check();
  await page.getByText('Quinn · Completed', { exact: true }).waitFor();
  await submit('Open Nia chat'); await page.locator('.chat__pill-name').getByText('Nia', { exact: true }).waitFor();
  await sidebar.click(); await tab('Tasks').click(); assert.equal(await scope.inputValue(), 'nia');
  assert.equal(await work.locator('.task-filter.is-needs_input').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: /Account & settings$/ }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await work.waitFor({ state: 'hidden' });
  await sidebar.click(); await work.waitFor();
  assert.equal(await scope.inputValue(), 'nia');
  assert.equal(await work.locator('.task-filter.is-needs_input').getAttribute('aria-pressed'), 'true');
  await page.getByText('Choose source material', { exact: true }).waitFor();
  fixture.taskError = true; await page.evaluate(() => window.dispatchEvent(new CustomEvent('swarm:event', { detail: { type: 'tasks', botId: 'nia' } })));
  await work.getByRole('alert').waitFor(); assert.equal(await work.locator('.task-card').count(), 1);
  fixture.taskError = false; await submit('Retry'); await work.getByRole('alert').waitFor({ state: 'hidden' });
  await tab('Goals').click(); await page.getByText(/No goals yet/).waitFor();
  assert.ok(traffic.includes('GET /api/workflows?botId=nia'));
  await tab('Files').click(); await page.getByText('No files yet', { exact: true }).waitFor();
  assert.ok(traffic.includes('GET /api/deliverables/bots/nia'));
  assert.equal(await page.getByText('Launch brief.md', { exact: true }).count(), 0);

  await tab('Tasks').click(); await scope.selectOption('quinn'); await tab('Goals').click();
  await submit('New goal'); await page.getByRole('textbox', { name: /^Goal/ }).fill('Prepare project handoff');
  await page.getByRole('textbox', { name: /Acceptance checks/ }).fill('Each item has an owner');
  await page.getByRole('spinbutton', { name: /Maximum turns/ }).fill('12');
  await page.getByText('Advanced budgets and start', { exact: true }).click();
  await page.getByRole('spinbutton', { name: /Maximum tokens/ }).fill('4000');
  await page.getByRole('spinbutton', { name: /Maximum spend/ }).fill('2.50');
  await page.getByRole('checkbox', { name: 'Start immediately' }).uncheck();
  await submit('Create without starting');
  await page.getByText('Goal status · Not started', { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1).body, { botId: 'quinn', title: 'Prepare project handoff', start: false, maxTurns: 12, maxTokens: 4000, maxSpendUsd: 2.5, criteria: [{ id: 'criterion-1', description: 'Each item has an owner', kind: 'row', contains: 'Each item has an owner' }] });
  await page.getByText('0 of 4,000 tokens', { exact: true }).waitFor();
  await submit('Resume'); assert.deepEqual(requests.at(-1).body, { action: 'resume' });
  await submit('Back to goals'); await submit('Open workflow');
  const draft = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Draft brief', exact: true }) });
  await draft.getByText('Edit saved task', { exact: true }).click();
  await draft.getByRole('combobox', { name: /Add prerequisite/ }).selectOption('risks');
  await draft.getByRole('button', { name: 'Add prerequisite', exact: true }).click();
  await draft.getByText(/Waits for Review risks/).waitFor();
  assert.deepEqual(requests.at(-1).body, { taskId: 'draft', dependsOnId: 'risks' });
  const risks = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Review risks', exact: true }) });
  await risks.getByText('Edit saved task', { exact: true }).click();
  await risks.getByRole('combobox', { name: /Add prerequisite/ }).selectOption('draft');
  await risks.getByRole('button', { name: 'Add prerequisite', exact: true }).click();
  await work.getByRole('alert').getByText('Dependency cycle detected.', { exact: true }).waitFor();
  await risks.getByRole('combobox', { name: /Assign worker/ }).selectOption('nia');
  await risks.getByRole('button', { name: 'Assign worker', exact: true }).click();
  await risks.getByText('Nia · No prerequisites', { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1).body, { workerBotId: 'nia' });
  await submit('Block workflow'); await page.getByRole('textbox', { name: /Blocking reason/ }).fill('Waiting for sign-off');
  await submit('Mark workflow blocked'); await page.getByRole('heading', { name: 'Launch brief workflow · Blocked' }).waitFor();
  assert.deepEqual(requests.at(-1).body, { action: 'block', reason: 'Waiting for sign-off' });
  await submit('Resume'); await page.getByRole('heading', { name: 'Launch brief workflow · In progress' }).waitFor();
  assert.equal(fixture.workflow.tasks[0].status, 'completed');

  await tab('Files').click(); await submit('Daily synopses');
  await page.getByText(/UTC fallback/).waitFor(); await submit('Edit schedule');
  await page.getByLabel('Schedule time 1', { exact: true }).fill('08:30'); await submit('Add schedule time'); await page.getByLabel('Schedule time 2', { exact: true }).fill('17:00');
  const zone = page.getByRole('textbox', { name: /Timezone/ });
  await zone.fill('not/a-zone'); await submit('Save schedule'); await work.getByRole('alert').waitFor();
  assert.equal(requests.some(request => request.path === '/api/checkins'), false);
  await zone.fill('America/Los_Angeles'); await submit('Add quiet hours'); await page.getByLabel('Quiet hours 1 start').fill('22:00'); await page.getByLabel('Quiet hours 1 end').fill('07:00');
  await submit('Save schedule'); await page.getByText('Synopsis schedule saved.', { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1).body, { times: ['08:30', '17:00'], timezone: 'America/Los_Angeles', quietHours: [{ start: '22:00', end: '07:00' }] });
  const toggle = page.getByRole('checkbox', { name: 'Scheduled daily synopsis' });
  await toggle.click(); await page.getByText(/Scheduled · 08:30/).waitFor(); await toggle.click(); await page.getByText(/Paused · 08:30/).waitFor();
  assert.deepEqual(requests.slice(-2).map(request => request.body), [{ enabled: true }, { enabled: false }]);
  fixture.artifact.deliveries.push(structuredClone(unknownDelivery), { ...unknownDelivery, id: 'delivery-sms-failed', status: 'failed', attempts: [] }, { ...unknownDelivery, id: 'delivery-whatsapp-sending', channel: 'whatsapp', status: 'sending', attempts: [] });
  await submit('Back to Files');
  await page.getByText('SMS: Unverified outcome', { exact: true }).waitFor();
  const destination = page.getByRole('combobox', { name: 'Delivery destination for Launch brief.md', exact: true });
  const reviewDestination = desktop.button('Review delivery destination');
  const deliveryTraffic = requests.length;
  await destination.selectOption('sms');
  await page.getByText('Verify the uncertain SMS attempt before sending again on this channel.', { exact: true }).waitFor();
  assert.equal(await reviewDestination.isDisabled(), true);
  await destination.selectOption('whatsapp');
  await page.getByText('A WhatsApp delivery is in progress. Refresh to check its status.', { exact: true }).waitFor();
  assert.equal(await reviewDestination.isDisabled(), true);
  await destination.selectOption('library');
  await submit('Delivery attempts and verification');
  assert.equal(await desktop.button('Review retry destination').isDisabled(), true, 'an SMS retry is blocked by SMS uncertainty even with Library selected');
  assert.equal(await reviewDestination.isEnabled(), true, 'an independent Library delivery remains available');
  assert.equal(requests.length, deliveryTraffic, 'blocked channels do not preview, retry, or send');
  await submit('Review delivery destination'); await page.getByRole('heading', { name: 'Save in Files', exact: true }).waitFor();
  await submit('Confirm delivery'); await page.getByText('Unresolved delivery requests', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review delivery destination' }).isDisabled(), true);
  const firstSend = requests.find(request => request.path.endsWith('/deliveries'));
  assert.equal(firstSend.body.channel, 'library'); assert.equal(firstSend.body.destination.proof, 'fixture-proof'); assert.ok(firstSend.key);
  await page.reload(); await sidebar.click(); await tab('Files').click();
  await submit('Resume saved request'); await page.getByText('Files: Saved in Files', { exact: true }).waitFor();
  assert.deepEqual(requests.filter(request => request.path.endsWith('/deliveries')), [firstSend, firstSend]);
  await submit('Daily synopses'); await page.getByText(/08:30, 17:00.*America\/Los_Angeles.*22:00–07:00/).waitFor();
  assert.equal(await toggle.isChecked(), false);
  await submit('Back to Files'); await shot('work-reports-desktop-light');
  await submit('Verify uncertain outcome');
  await page.getByRole('heading', { name: 'Verify an uncertain outcome', exact: true }).waitFor();
  await page.getByLabel('Verified outcome', { exact: true }).selectOption('not_sent');
  assert.equal(await desktop.button('Record verification (does not send)').isDisabled(), true);
  await page.getByLabel('Verification evidence', { exact: true }).fill('Fixture provider audit showed no send.');
  await work.locator('.work-verify-form button[type="submit"]:enabled').waitFor();
  assert.equal(await desktop.button('Record verification (does not send)').isEnabled(), true);
  await shot('work-verify-desktop-light');
  await submit('Record verification (does not send)');
  await page.getByText('SMS: Not sent', { exact: true }).nth(1).waitFor();
  assert.equal(await page.getByText('SMS: Unverified outcome', { exact: true }).count(), 0);
  assert.equal(await page.getByText('SMS: Not sent', { exact: true }).count(), 2);
  assert.deepEqual(requests.at(-1).body, { outcome: 'not_sent', evidence: 'Fixture provider audit showed no send.', expectedAttemptId: 'attempt-1' });
  assert.ok(requests.at(-1).key); assert.equal(requests.filter(request => request.path.endsWith('/deliveries')).length, 2);
  await submit('Routines'); await page.getByRole('switch', { name: 'Schedule on: Morning check-in' }).click();
  await page.getByText('Paused · No next run until you resume.', { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1).body, { enabled: false });
  await submit('Delete Morning check-in…'); await submit('Delete routine');
  await page.getByText('Routine deleted. Previous runs remain in history.', { exact: true }).waitFor();
  await submit('Run history'); await submit('Run details'); await page.getByRole('link', { name: 'Launch brief.md', exact: true }).waitFor();
  await tab('Tasks').click();
  // Reload now preserves the scoped route; explicitly return to all Bots for this check.
  await scope.selectOption('all');
  await work.getByRole('button', { name: /^Pending/ }).click();
  await tab('Team').click(); await submit('Open Nia chat');
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  const details = page.getByRole('complementary', { name: 'Conversation details', exact: true });
  await details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Tasks', exact: true }).click();
  await details.getByRole('button', { name: 'Goals and workflows', exact: true }).click();
  await page.getByRole('heading', { name: 'Goals', exact: true }).waitFor();
  assert.ok(traffic.includes('GET /api/workflows?botId=nia'));
  await submit('New goal');
  assert.equal(await work.getByRole('combobox', { name: /^Agent/ }).count(), 0, 'bot Details Goals keeps the same bot');
  await submit('Cancel');
  await tab('Tasks').click();
  assert.equal(await scope.inputValue(), 'nia');
  await work.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.locator('.chat__pill-name').getByText('Nia', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Tasks', exact: true }).click();
  await details.getByRole('button', { name: 'See all tasks', exact: true }).click();
  // R2F-010: See all tasks keeps this Bot's filter, with a chip that clears it.
  assert.equal(await scope.inputValue(), 'nia', 'See all tasks opens Tasks filtered to this Bot');
  await work.getByText('Showing tasks for Nia', { exact: true }).waitFor();
  await work.getByRole('button', { name: 'Show all Bots: clear the Nia filter', exact: true }).click();
  assert.equal(await scope.inputValue(), 'all', 'clearing the chip shows the entire workspace');
  assert.equal(await work.locator('.task-filter.is-all').getAttribute('aria-pressed'), 'true');
  await scope.selectOption('quinn'); await page.getByText('Review launch note', { exact: true }).waitFor();
  await work.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.locator('.chat__pill-name').getByText('Nia', { exact: true }).waitFor();
  await sidebar.click(); assert.equal(await scope.inputValue(), 'quinn');
  assert.deepEqual(errors, []); await page.close();

  for (const width of [390, 320]) {
    const phone = await harness({ width, height: 844 }, 'dark'); await phone.open(); await phone.checkFits();
    assert.equal(await phone.page.locator('html').getAttribute('data-theme'), 'dark');
    const positions = await phone.page.locator('.task-column').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
    assert.equal(new Set(positions).size, 1);
    if (width === 390) await phone.shot('work-tasks-phone-night');
    await phone.tab('Team').click(); await phone.page.getByText('Team snapshot', { exact: true }).waitFor(); await phone.checkFits();
    if (width === 390) await phone.shot('work-team-phone-night');
    await phone.submit('Current job');
    const phoneJob = phone.page.getByRole('region', { name: 'Current job for Draft verified brief', exact: true });
    await phoneJob.getByText('Assignee: Quinn', { exact: true }).waitFor();
    await phoneJob.getByText('Verified source notes · Completed · Verified result', { exact: true }).waitFor();
    await phone.checkFits();
    if (width === 390) await phone.shot('work-current-job-phone-night');
    await phone.submit('Open Nia chat');
    await phone.submit('Show details');
    const phoneDetails = phone.page.getByRole('complementary', { name: 'Conversation details', exact: true });
    await phoneDetails.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Tasks', exact: true }).click();
    await phoneDetails.getByRole('button', { name: 'Goals and workflows', exact: true }).click();
    await phone.submit('New goal');
    assert.equal(await phone.page.getByRole('combobox', { name: /^Agent/ }).count(), 0);
    await phone.submit('Cancel'); await phone.tab('Tasks').click();
    assert.equal(await phone.page.getByRole('combobox', { name: 'Filter tasks by bot' }).inputValue(), 'nia');
    await phone.submit('Back to chat');
    await phone.page.locator('.chat__pill-name').getByText('Nia', { exact: true }).waitFor();
    await phone.submit('Show details');
    await phoneDetails.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Tasks', exact: true }).click();
    await phoneDetails.getByRole('button', { name: 'See all tasks', exact: true }).click();
    assert.equal(await phone.page.getByRole('combobox', { name: 'Filter tasks by bot' }).inputValue(), 'nia', 'R2F-010: filtered to this Bot');
    await phone.submit('Show all Bots: clear the Nia filter');
    assert.equal(await phone.page.getByRole('combobox', { name: 'Filter tasks by bot' }).inputValue(), 'all');
    await phone.page.getByText('2 tasks need your input', { exact: true }).waitFor();

    await phone.tab('Goals').click(); await phone.submit('New goal'); await phone.page.getByRole('heading', { name: 'New persistent goal', exact: true }).waitFor(); await phone.checkFits();
    if (width === 390) await phone.shot('work-goal-phone-night');
    await phone.tab('Files').click(); await phone.submit('Daily synopses'); await phone.submit('Edit schedule'); await phone.checkFits();
    if (width === 390) await phone.shot('work-schedule-phone-night');
    await phone.submit('Back to Files');
    await phone.page.getByLabel('Delivery destination for Launch brief.md', { exact: true }).selectOption('sms');
    await phone.submit('Review delivery destination');
    await phone.page.getByRole('heading', { name: 'Confirm delivery', exact: true }).waitFor(); await phone.checkFits();
    assert.deepEqual(phone.requests.at(-1).body, { channel: 'sms' });
    if (width === 390) await phone.shot('work-confirm-phone-night');
    await phone.page.getByText('Delivery details', { exact: true }).click(); await phone.page.getByText(sha, { exact: true }).waitFor();
    await phone.submit('Cancel'); await phone.page.getByRole('heading', { name: 'Files', exact: true }).waitFor();
    assert.equal(phone.requests.filter(request => request.path.endsWith('/deliveries')).length, 0);
    if (width === 390) {
      phone.fixture.taskError = true; await phone.page.reload(); await phone.tab('Tasks').click();
      await phone.page.getByRole('alert').getByText('Tasks couldn’t load.', { exact: true }).waitFor();
      assert.equal(await phone.page.locator('.tasks-toolbar + .tasks-error').count(), 1);
      await phone.shot('work-tasks-error-phone-night');
      phone.fixture.taskError = false; await phone.submit('Retry'); await phone.page.getByText('2 tasks need your input', { exact: true }).waitFor();
    }
    assert.deepEqual(phone.errors, []); await phone.page.close();
  }
  console.log('PASS Paper work: desktop and two phone widths, exact scoped navigation, settings persistence, goal budgets/start, workflow edit and cycle rejection, delivery replay, routine history');
} finally {
  await browser.close();
}
