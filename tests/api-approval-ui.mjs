import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'api-approval-ui-'));
const evidence = path.join(root, '.context/api-approval-ui'); await fs.mkdir(evidence, { recursive: true });
async function port() { const server = http.createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, DIRECT_API_KEY: 'fixture', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', b => logs.push(String(b))); return child; }
async function until(fn) { for (let n = 0; n < 300; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/api-approval-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email: `fixture-${width}-${theme}@example.test`, name: 'Fixture account' } })).status(), 200);
    const { bots } = await (await context.request.get(`${origin}/api/bots`)).json();
    const bot = bots.find(b => b.isPrimary);
    await context.request.post(`${origin}/api/bots/${bot.id}/setup/skip`);
    page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.detailsOpen', '0'); localStorage.setItem('swarm.theme', theme); }, { id: bot.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.goto(`${origin}/#bot/${bot.id}`);
    const settings = async section => { await page.evaluate(async section => (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings(section), section); if (section === 'subscriptions') await page.locator('.subscription-settings__context > summary').click(); await page.getByRole('radiogroup', { name: 'API approval level', exact: true }).waitFor(); };
    const closeSettings = async () => {
      // Navigate directly to this Bot. Closing via history and immediately
      // opening a chat lets the delayed popstate overwrite the fixture route.
      await page.evaluate(async id => (await import('/src/configStore.ts')).openConversation(id), bot.id);
      await page.locator('.app-settings').waitFor({ state: 'detached' });
      await page.locator('.chat__header').waitFor();
    };
    const state = async () => (await context.request.get(`${origin}/api/fixture/state`)).json();
    const send = async text => assert.equal((await context.request.post(`${origin}/api/bots/${bot.id}/messages`, { data: { text } })).status(), 200);
    const select = () => page.getByRole('radio', { name: 'Ask before every action', exact: true });
    await settings('permissions'); await until(() => select().isEnabled());
    assert.equal(await select().isChecked(), false);
    await select().click(); await until(async () => (await (await context.request.get(`${origin}/api/account/preferences`)).json()).apiApprovalLevel === 'every_action');
    await page.getByRole('button', {name:'About approvals',exact:true}).focus();
    await page.getByRole('tooltip').filter({hasText:'Every action asks first'}).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, `permissions-${width}-${theme}.png`), fullPage: true });
    await settings('subscriptions'); await until(async () => await select().isChecked());
    await page.getByRole('button', {name:'About approvals',exact:true}).focus();
    await page.getByRole('tooltip').filter({hasText:'Every action asks first'}).waitFor();
    assert.doesNotMatch(await page.getByRole('region',{name:'API approval settings'}).innerText(), /[\u2013\u2014\u2019]/);
    await select().scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, `models-${width}-${theme}.png`), fullPage: true });
    await closeSettings();
    await context.request.post(`${origin}/api/fixture/cli-history`, { data: { botId: bot.id } });
    const diagnostics = async () => (await context.request.get(`${origin}/api/cli`)).json();
    const oldCli = (await diagnostics()).lastRun;
    const panels = async (result, screenshot) => {
      await settings('subscriptions');
      const details = page.locator('.subscription-settings__context');
      if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
      await page.getByText('Last model run', { exact: true }).waitFor();
      await page.getByText('Last tool run', { exact: true }).waitFor();
      await until(async () => (await details.innerText()).includes(result));
      assert.equal(await page.getByText('Last CLI run', { exact: true }).count(), 0);
      assert.doesNotMatch(await details.innerText(), /create_task/);
      assert.match(await details.innerText(), /SWARM_APPS_EXECUTE/);
      if (result === 'Not allowed') {
        const runs = (await diagnostics()).apiRuns;
        for (const run of [runs.latest, runs.lastToolRun]) {
          assert.equal(run.result, 'denied'); assert.equal(run.errorCode, null);
        }
        assert.doesNotMatch(await details.innerText(), /policy_denied/);
        const codes = details.locator('dt').filter({ hasText: /^Error code$/ });
        assert.equal(await codes.count(), 2);
        for (const code of await codes.all()) assert.equal(await code.locator('..').locator('dd').innerText(), 'None');
      }
      await page.getByText('Last model run', { exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await details.screenshot({ path: path.join(evidence, `${screenshot}-${width}-${theme}.png`) });
      assert.deepEqual((await diagnostics()).lastRun, oldCli, 'API records preserve CLI history');
      await closeSettings();
    };
    const before = await state();
    for (const text of ['Create a skill called api-perm-test-r18', 'YY create a skill named Fixture checklist. Check the result and report it.', 'YY create a task named Fixture review.', 'YY remember: The fixture color preference is teal.', 'YY search past chats: checklist: weekly review', `YY search past chats: ${'Checklist details '.repeat(25)}`, 'JJ memory: My fixture color preference is green.', 'JJ file', 'JJ app', 'JJ wrapped file', 'WW draft']) {
      const cardCount = await page.locator('.approval-card').count();
      await send(text);
      const pending = page.locator('.approval-card').filter({ has: page.getByRole('button', { name: "Don't allow", exact: true }) });
      await pending.waitFor();
      assert.equal(await page.locator('.approval-card').count(), cardCount + 1);
      if (text.startsWith('YY search past chats:')) {
        assert.match(await pending.innerText(), /search your past chats for/);
        assert.doesNotMatch(await pending.innerText(), /to session search/);
        if (text.length < 120) assert.match(await pending.innerText(), /search your past chats for checklist: weekly review\?/);
      } else if (text.startsWith('YY') || text.startsWith('Create a skill')) {
        assert.doesNotMatch(await pending.innerText(), /session search|search your past chats/i);
        assert.match(await pending.innerText(), text.includes('skill') ? /propose skill/i : text.includes('task') ? /create task/i : /remember/i);
      }
      if (text === 'JJ wrapped file') {
        assert.match(await pending.innerText(), /save file/i);
        assert.doesNotMatch(await pending.innerText(), /tool call/i);
      }
      assert.equal((await state()).files, before.files); assert.equal((await state()).memories, before.memories); assert.equal((await state()).executions, before.executions);
      assert.equal((await state()).tasks, before.tasks); assert.equal((await state()).skills, before.skills);
      await pending.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(evidence, `card-${text.split(' ')[1].replace(':', '')}-${width}-${theme}.png`), fullPage: true });
      if (text === 'WW draft') {
        assert.match(await pending.innerText(), /create email draft/i);
        assert.equal((await diagnostics()).apiRuns.lastToolRun.result, 'pending_approval');
        await panels('Approval requested', 'api-pending-runs');
      }
      await pending.getByRole('button', { name: "Don't allow", exact: true }).click();
      await until(async () => (await state()).pending === 0);
      if (text === 'WW draft') {
        await panels('Not allowed', 'api-denied-runs');
        await page.reload();
        await panels('Not allowed', 'api-denied-reload-runs');
        await send('WW draft'); await pending.waitFor();
        await pending.getByRole('button', { name: 'Allow', exact: true }).click();
        await until(async () => (await state()).executions === before.executions + 1);
        await panels('Allowed', 'api-allowed-runs');
        before.executions++;
      }
    }
    await context.request.post(`${origin}/api/fixture/helper`, { data: { botId: bot.id } });
    const helperCard = page.locator('.approval-card').filter({ has: page.getByRole('button', { name: "Don't allow", exact: true }) });
    await helperCard.waitFor(); assert.match(await helperCard.innerText(), /Fixture helper/);
    await helperCard.getByRole('button', { name: "Don't allow", exact: true }).click();
    await until(async () => (await state()).pending === 0);
    const finished = await page.getByText('Fixture turn finished.', { exact: true }).count();
    await send('JJ search the web');
    await until(async () => await page.getByText('Fixture turn finished.', { exact: true }).count() > finished);
    assert.equal(await page.getByText('Provider search is unavailable', { exact: false }).count(), 0);
    assert.deepEqual(await state(), before, 'all denied actions remain undone');
    for (const [text, key] of [
      ['Create a skill called api-perm-test-r18', 'skills'],
      ['YY create a skill named Fixture checklist. Check the result and report it.', 'skills'],
      ['YY create a task named Fixture review.', 'tasks'],
      ['YY remember: The fixture color preference is teal.', 'memories'],
    ]) {
      await send(text);
      const createCard = page.locator('.approval-card').filter({ has: page.getByRole('button', { name: "Don't allow", exact: true }) });
      await createCard.waitFor();
      assert.doesNotMatch(await createCard.innerText(), /session search|search your past chats/i);
      await createCard.getByRole('button', { name: 'Allow', exact: true }).click();
      await until(async () => (await state())[key] === before[key] + 1);
      before[key]++;
    }
    const cards = await page.locator('.approval-card').count();
    await send('JJ wrapped file');
    const saveCard = page.locator('.approval-card').filter({ has: page.getByRole('button', { name: "Don't allow", exact: true }) });
    await saveCard.waitFor(); assert.match(await saveCard.innerText(), /save file/i);
    assert.equal((await state()).files, before.files);
    await saveCard.getByRole('button', { name: 'Allow', exact: true }).click();
    await until(async () => (await state()).files === before.files + 1);
    assert.equal(await page.locator('.approval-card').count(), cards + 1);
    assert.equal((await state()).pending, 0);
    await settings('permissions'); await page.getByRole('radio',{name:'External actions',exact:true}).click(); await until(async () => (await (await context.request.get(`${origin}/api/account/preferences`)).json()).apiApprovalLevel === 'standard'); await closeSettings();
    await send('JJ memory: My fixture breakfast preference is oats.'); await until(async () => (await state()).memories > before.memories);
    await send('JJ file'); await until(async () => (await state()).files > before.files + 1);
    await send('JJ app'); await until(async () => (await state()).executions > before.executions);
    assert.equal((await state()).pending, 0);
    await context.request.post(`${origin}/api/fixture/cli`, { data: { botId: bot.id, provider: theme === 'light' ? 'codex' : 'claude' } });
    for (const section of ['permissions', 'subscriptions']) {
      await settings(section); await page.getByRole('button',{name:'About approvals',exact:true}).focus(); await page.getByRole('tooltip').filter({hasText:'Plan permissions apply'}).waitFor(); assert.equal(await select().isDisabled(), true); await closeSettings();
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${width} ${theme}: both settings, named cards, API pending/denied/allowed panels and reload, CLI history retained, deny unchanged, allow saves, Standard automatic, CLI disabled`);
    await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-6000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }
