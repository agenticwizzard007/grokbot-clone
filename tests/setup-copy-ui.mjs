// QA SO B-01: real setup greetings and navigation with isolated data and mocked backends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-'));
const evidence = path.join(root, '.context/setup-copy');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser;
async function port() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const apiPort = await port(), uiPort = await port(), modelPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
// Deliberately exclude inherited provider credentials and deployment settings.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  SESSION_SECRET: 'setup-copy-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
  DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `${modelBase}/v1`, LLM_PROVIDER: 'direct',
  OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: `${modelBase}/api/v1`,
  COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', SWARM_API: apiBase,
};
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
const healthy = url => fetch(url).then(response => response.ok, () => false);
const assertSetupCopy = text => {
  assert.match(text, /Details > Setup/);
  assert.doesNotMatch(text, /Configuration|on the right/i);
};

try {
  start(['tests/mock-provider.mjs', String(modelPort)]);
  await until(() => healthy(`${modelBase}/v1/models`), 'mock model');
  start(['--import', 'tsx', 'server/src/index.ts']);
  await until(() => healthy(`${apiBase}/api/health`), 'isolated API');
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await until(() => healthy(base), 'local dev frontend');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
    // No toolkit discovery, account connections, or external artwork are needed for copy checks.
    await context.route('**/api/bots/*/suggested-apps', route => route.fulfill({ json: { suggestions: [], status: 'ready' } }));
    await context.route('**/api/apps**', route => route.fulfill({ json: { apps: [], connected: [], connectedApps: [], connections: [], categories: [] } }));
    await context.route('**/api/toolkits/**', route => route.fulfill({ json: { items: [] } }));
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `setup-copy-${width}@example.test` } });
    assert.equal(login.status(), 200);
    const api = async (url, method = 'GET', data) => {
      const response = await context.request.fetch(`${base}/api${url}`, { method, data });
      assert.ok(response.ok(), `${method} ${url}: ${response.status()}`);
      return response.json();
    };
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.getByRole('button', { name: 'New Bot', exact: true }).click();
    const create = page.getByRole('main', { name: 'Create a Bot', exact: true });
    await create.getByRole('textbox', { name: 'Bot name' }).fill(`Copy Bot ${width}`);
    const creation = page.waitForResponse(response => response.url().endsWith('/api/bots') && response.request().method() === 'POST');
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    const { bot } = await (await creation).json();
    const opening = page.getByText('I’ll ask about any important gaps and save the role in Details > Setup.', { exact: true });
    await opening.waitFor();
    const firstGreeting = (await api(`/bots/${bot.id}/rows`)).rows.find(row => row.body.greeting);
    assertSetupCopy(firstGreeting.body.text);
    await page.screenshot({ path: path.join(evidence, `new-bot-${width}.png`), fullPage: true });

    // The mock model saves a complete brief through the real setup tool before UI activation.
    const setup = await api(`/bots/${bot.id}/setup`);
    const draft = {
      ...setup.manifest.brief, revision: setup.onboarding.revision, stage: 'review', instructions: 'Summarize supplied notes.',
      purpose: 'Summarize supplied notes.', responsibilities: ['Summarize notes in three bullets.'],
      success_criteria: ['Three factual bullets.'], context_summary: 'Use only supplied notes.',
      action_boundaries: 'Return summaries in chat. Ask before taking external actions.',
      workflows: [{ name: 'Notes summary', trigger: 'The user supplies notes.', steps: ['Read notes.', 'Summarize three key points.'], output: 'Three factual bullets.' }],
      open_questions: [], source_message_seqs: [],
    };
    await api(`/bots/${bot.id}/messages`, 'POST', { text: `mock: save_agent_setup ${JSON.stringify(draft)} | say Ready for review.` });
    await until(async () => (await api(`/bots/${bot.id}/setup`)).onboarding.status === 'review', 'saved review');
    await page.getByRole('paragraph').filter({ hasText: /^Ready for review\.$/ }).waitFor();
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    if (!await details.isVisible()) await page.getByRole('button', { name: 'Show details', exact: true }).click();
    await details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Setup', exact: true }).click();
    await details.getByRole('button', { name: 'Review and activate', exact: true }).click();
    await details.getByRole('button', { name: /^Activate agent · revision / }).click();
    await details.getByRole('button', { name: 'Refine setup', exact: true }).waitFor();
    assert.equal((await api(`/bots/${bot.id}/setup`)).onboarding.status, 'active');

    // Follow the same labels the import instructions give to reach the downloadable setup.
    await details.getByRole('tab', { name: 'Files', exact: true }).click();
    await details.getByRole('button', { name: /^bot-setup\.json/ }).click();
    const download = page.waitForEvent('download');
    await details.getByRole('button', { name: 'Download', exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'bot-setup.json');
    await details.getByRole('tab', { name: 'Responsibilities', exact: true }).click();

    const refining = page.waitForResponse(response => response.url().endsWith(`/bots/${bot.id}/setup/interview`) && response.request().method() === 'POST');
    await details.getByRole('button', { name: 'Refine setup', exact: true }).click();
    assert.equal((await refining).status(), 200);
    await details.getByRole('button', { name: 'Close details', exact: true }).click();
    const refinement = page.getByText('Your saved role is visible in Details > Setup.', { exact: true });
    await refinement.waitFor();
    await refinement.scrollIntoViewIfNeeded();
    const greetings = (await api(`/bots/${bot.id}/rows`)).rows.filter(row => row.body.greeting);
    assert.equal(greetings.length, 2);
    assertSetupCopy(greetings.at(-1).body.text);
    await page.screenshot({ path: path.join(evidence, `refine-${width}.png`), fullPage: true });

    // Phone navigation returns to the Bot list before offering New Bot.
    if (width <= 760) await page.getByRole('button', { name: 'All Bots', exact: true }).click();
    await page.getByRole('button', { name: 'New Bot', exact: true }).click();
    await create.getByRole('button', { name: 'Import saved setup', exact: true }).click();
    const upload = page.getByRole('main', { name: 'Import a saved setup', exact: true });
    const instruction = upload.locator('.setup-paper__subtitle').first();
    assert.equal(await instruction.innerText(), 'Choose a bot-setup.json exported from Details > Setup > Files.');
    assertSetupCopy(await instruction.innerText());
    await upload.getByRole('button', { name: 'Choose setup file', exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, `import-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS QA SO B-01 at ${width}px: new greeting, review, activation, Files download, refine greeting, import instructions`);
  }
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  const page = browser?.contexts().flatMap(context => context.pages()).at(-1);
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
