// R3-027: custom file control and roster-before-import-response race. No live API calls.
// UI_ORIGIN=http://127.0.0.1:<root-preview-port> node tests/qa-r3-work-import-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { fixturePage, gate, origin } from './qa-r3-work-fixture.mjs';

const evidence = new URL('../.context/qa-r3-work-import/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const manifest = {
  format: 'swarm.bot-setup', version: 2,
  bot: { name: 'Coordinator', mode: 'teammate', label: '', description: '', instructions: 'Summarize saved work.', avatarShape: 'blob', avatarColor: 'blue', model: null, effort: 'medium' },
  source: { messages: [] },
  brief: { purpose: 'Summarize saved work.', responsibilities: ['Verify source records'], out_of_scope: ['Sending messages'], success_criteria: ['Cite saved records'], context_summary: '', shared_resources: [], handoff_notes: [], communication_style: 'Direct', working_principles: [], action_boundaries: 'Read only', workflows: [], open_questions: [] },
};
const file = { name: 'bot-setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390]) {
    const { page, fixture, errors, writes } = await fixturePage(browser);
    const imported = { ...fixture.bots[1], id: 'imported-bot', name: 'Imported research Bot' };
    const responseGate = gate();
    let attempts = 0;
    fixture.respond = async ({ path, method }) => {
      if (path === '/api/bots/import' && method === 'POST') {
        if (++attempts === 1) return { status: 409, json: { error: 'A Bot with this name already exists.' } };
        await responseGate.wait;
        return { json: { bot: imported, computer: { status: 'ready', error: null } } };
      }
      if (path === '/api/bots/imported-bot/setup') return { json: {
        manifest: { ...manifest, bot: { ...manifest.bot, name: imported.name } },
        computer: { status: 'ready', error: null }, onboarding: { revision: 1, status: 'interviewing', confirmedAt: null, missing: [] },
        files: { 'AGENTS.md': '# Saved work', 'bot-setup.json': JSON.stringify(manifest) },
      } };
    };
    await page.goto(origin);
    await page.getByRole('button', { name: 'New Bot', exact: true }).click();
    await page.getByRole('button', { name: 'Import saved setup', exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    const form = page.getByRole('main', { name: 'Import a saved setup', exact: true });
    const input = form.getByLabel('Setup file', { exact: true });
    const choose = form.getByRole('button', { name: 'Choose setup file', exact: true });
    const submit = form.getByRole('button', { name: 'Import setup', exact: true });
    const name = form.getByRole('textbox', { name: 'Bot name' });
    const assertCustomPicker = async () => {
      assert.equal(await input.count(), 1, 'native input remains labelable for file selection');
      assert.equal(await input.isVisible(), false, 'native file presentation stays hidden');
      assert.doesNotMatch(await form.innerText(), /No file chosen/i);
    };
    await assertCustomPicker();
    await choose.waitFor({ state: 'visible' });
    assert.equal(await choose.isEnabled(), true);
    // Arm browser interception before focus checks, then activate the custom control by keyboard.
    const chooserEvent = page.waitForEvent('filechooser');
    await choose.focus();
    assert.equal(await choose.evaluate(element => element === document.activeElement), true);
    await choose.press('Enter');
    const chooser = await chooserEvent;
    await chooser.setFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('INVALID') });
    await form.getByRole('alert').filter({ hasText: 'This file is not valid JSON.' }).waitFor();
    await assertCustomPicker();
    assert.equal(await choose.isEnabled(), true, 'custom choose button survives invalid file errors');
    assert.equal(await submit.isDisabled(), true);

    // Hold File.text so the reading state can be checked without a timing assumption.
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        const file = this;
        return new Promise(resolve => {
          window.__releaseSetupFile = async () => {
            File.prototype.text = original;
            resolve(await original.call(file));
          };
        });
      };
    });
    await input.setInputFiles(file);
    await form.getByText('Reading setup file…', { exact: true }).waitFor();
    await assertCustomPicker();
    assert.equal(await choose.isEnabled(), true);
    assert.equal(await submit.isDisabled(), true);
    await page.evaluate(() => window.__releaseSetupFile());
    await form.getByText('Selected: bot-setup.json', { exact: true }).waitFor();
    await assertCustomPicker();
    await form.getByRole('button', { name: 'Choose another file', exact: true }).waitFor();

    // Local duplicate validation is immediate and blocks submission.
    await form.getByRole('alert').filter({ hasText: 'A Bot with this name already exists.' }).waitFor();
    assert.equal(await submit.isDisabled(), true);
    assert.deepEqual(writes, []);
    await name.fill('New research Bot');
    assert.equal(await form.getByRole('alert').count(), 0, 'renaming clears a local duplicate immediately');
    assert.equal(await submit.isEnabled(), true);
    await name.fill('  COORDINATOR  ');
    assert.equal(await submit.isDisabled(), true, 'duplicate validation normalizes case and whitespace');
    await name.fill('Server-conflict Bot');
    await submit.click();
    await form.getByRole('alert').filter({ hasText: 'A Bot with this name already exists.' }).waitFor();
    assert.equal(writes.length, 1, 'server conflict is still reported for a name missing from the roster');
    await name.fill(imported.name);
    assert.equal(await form.getByRole('alert').count(), 0, 'renaming clears the server conflict immediately');

    // Observe even transient inserted duplicate alerts while the valid import is pending.
    await page.evaluate(() => {
      window.__duplicateDuringImport = [];
      const inspect = node => {
        if (node.nodeType === Node.ELEMENT_NODE && /A Bot with this name already exists/.test(node.textContent ?? '')) {
          window.__duplicateDuringImport.push(node.textContent);
        }
      };
      window.__importObserver = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) inspect(node);
          if (record.type === 'characterData') inspect(record.target.parentElement);
        }
      });
      window.__importObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const started = page.waitForRequest(request => request.url().endsWith('/api/bots/import') && request.method() === 'POST');
    await submit.click();
    await started;
    await form.getByRole('button', { name: 'Importing…', exact: true }).waitFor();
    assert.equal(await form.getByRole('alert').count(), 0);
    assert.equal(await name.isDisabled(), true);
    // SSE advertises the successfully created Bot before the held POST response is released.
    fixture.bots.push(imported);
    await page.evaluate(bot => window.__emitFixture({ type: 'bot', bot }), imported);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await form.getByRole('alert').count(), 0, 'the pending import never calls its own roster entry a duplicate');
    assert.equal(await form.getByRole('button', { name: 'Importing…', exact: true }).isDisabled(), true);
    await assertCustomPicker();
    await page.screenshot({ path: new URL(`pending-import-${width}.png`, evidence).pathname });
    responseGate.release();
    await form.waitFor({ state: 'detached' });
    await page.getByRole('complementary', { name: 'Conversation details' }).getByRole('heading', { name: `${imported.name} · Setup`, exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__duplicateDuringImport), [], 'no duplicate error flashes through successful completion');
    await page.evaluate(() => window.__importObserver.disconnect());
    assert.equal(writes.length, 2, 'a successful import makes exactly one request after the failed attempt');
    assert.deepEqual(writes[1], { path: '/api/bots/import', method: 'POST', body: { manifest, name: imported.name, expectedUserId: 'fixture-owner' } });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS R3 import ${width}px: accessible custom picker, invalid/reading/selected states, duplicate rename, server conflict, roster race`);
  }
} finally { await browser.close(); }
