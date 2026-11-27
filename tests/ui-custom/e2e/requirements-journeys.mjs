import assert from 'node:assert/strict';
import { api, configAvailable, requireModules, open, button, until, untilPreviewRow, resetRequirements } from '../fixtures/harness.mjs';
import { REQUIREMENTS, requirementsPatch } from '../fixtures/matrix.mjs';
import { contracts } from '../fixtures/contracts.mjs';

async function chat(page, server, name, input, confirmation) {
  await open(page, server.base, `#bot/${server.fixture.bot.id}`);
  const composer = page.getByRole('textbox', { name: `Message ${server.fixture.bot.name}`, exact: true });
  const replies = () => server.withDb(db => db.prepare("SELECT generation || ':' || seq AS id FROM rows WHERE bot_id=? AND kind='message' AND json_extract(body,'$.role')='assistant' AND json_extract(body,'$.text')=? AND coalesce(json_extract(body,'$.streaming'),0)=0").all(server.fixture.bot.id, confirmation).map(row => row.id));
  const previous = new Set(replies());
  server.script(confirmation, `${name} ${JSON.stringify(input, null, 2)} | say ${confirmation}`);
  await composer.fill(confirmation);
  await composer.press('Enter');
  await until(() => replies().some(id => !previous.has(id)), `No new reply to ${confirmation}`);
  await page.locator('.bubble.is-agent').getByText(confirmation, { exact: true }).last().waitFor();
}
async function previewCommand(args, name, input, step) {
  const { page, context, server, capture = async () => {} } = args;
  const before = await configAvailable(context.request, server.base);
  const previous = server.withDb(db => db.prepare("SELECT generation || ':' || seq AS id FROM rows WHERE bot_id=? AND json_extract(body,'$.card')='ui_preview'").all(server.fixture.bot.id).map(row => row.id));
  await chat(page, server, name, input, `Prepare my ${step.replaceAll("-", " ")}`);
  const card = await untilPreviewRow(server, previous);
  await page.getByRole('status').filter({ hasText: /Previewing/ }).waitFor();
  assert.deepEqual((await configAvailable(context.request, server.base)).doc, before.doc);
  await capture(`${step}-preview`); await button(page, 'Apply');
  await until(async () => (await configAvailable(context.request, server.base)).revision > before.revision, `${step} Apply did not persist`);
  return api(context.request, server.base, `/previews/${card.previewId}`);
}
async function available(args) {
  requireModules('server/src/agent/ui-requirements-tools.ts', 'web/src/components/config/appearance/Requirements.tsx', 'web/src/components/AllSections.tsx', 'web/src/dashboards/DashboardGrid.tsx');
  await resetRequirements(args.context, args.server.base);
}
export async function rememberRequirements(args, useCase) {
  const { page, context, server } = args;
  const before = await configAvailable(context.request, server.base);
  await chat(page, server, 'update_requirements', { patch: requirementsPatch(REQUIREMENTS[useCase]) }, `I will remember my ${useCase} requirements`);
  const requirements = await api(context.request, server.base, '/requirements');
  assert.equal(requirements.profile.role, REQUIREMENTS[useCase].role);
  assert.deepEqual(requirements.profile.focus, REQUIREMENTS[useCase].focus);
  assert.deepEqual((await configAvailable(context.request, server.base)).doc, before.doc, 'Saving requirements alone cannot rearrange the app');
  return requirements;
}
export async function adapt(args, useCase) {
  const { page, context, server, capture = async () => {} } = args;
  const requirements = await rememberRequirements(args, useCase);
  await previewCommand(args, 'preview_adaptation', {}, `${useCase}-adaptation`);
  const saved = await configAvailable(context.request, server.base);
  assert.equal(saved.doc.layout.home.kind, 'dashboard');
  await open(page, server.base, '');
  await until(() => page.evaluate(() => location.hash.startsWith('#dash/')), 'Adapted home did not open');
  await capture(`${useCase}-home`);
  await open(page, server.base, '#settings/appearance/use');
  await page.getByLabel('Role', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Role', { exact: true }).inputValue(), REQUIREMENTS[useCase].role);
  for (const suggestion of requirements.suggestions.bots) await page.getByText(suggestion.name, { exact: true }).first().waitFor();
  await capture(`${useCase}-requirements`);
  await open(page, server.base, '#all');
  await page.getByRole('heading', { name: /All sections/ }).waitFor();
  await capture(`${useCase}-all-sections`);
  return { doc: saved.doc, requirements };
}
export async function requirementsUseCases(args) {
  await available(args);
  const sales = await adapt(args, 'sales');
  const operations = await adapt(args, 'operations');
  assert.notDeepEqual(sales.doc.layout.sidebar.order, operations.doc.layout.sidebar.order, 'Use cases must promote different sidebar sections');
  assert.notDeepEqual(sales.doc.layout.phoneTabs, operations.doc.layout.phoneTabs, 'Use cases must promote different navigation');
  assert.notDeepEqual(sales.requirements.suggestions, operations.requirements.suggestions);
  assert.notDeepEqual(sales.doc.dashboards, operations.doc.dashboards, 'Use cases must produce different widgets');
}
export async function requirementsChangeReset(args) {
  await available(args);
  const operations = await adapt(args, 'operations');
  const support = await adapt(args, 'support');
  assert.notDeepEqual(operations.doc.layout, support.doc.layout, 'Changed requirements must reshape navigation');
  assert.notDeepEqual(operations.doc.dashboards, support.doc.dashboards);
  await args.page.reload();
  assert.deepEqual((await configAvailable(args.context.request, args.server.base)).doc, support.doc);
  await previewCommand(args, 'reset_requirements', {}, 'requirements-reset');
  assert.equal((await api(args.context.request, args.server.base, '/requirements')).profile, null);
  const { DEFAULT_CONFIG } = await contracts();
  assert.deepEqual((await configAvailable(args.context.request, args.server.base)).doc.layout, DEFAULT_CONFIG.layout, 'Reset restores the default arrangement');
  await open(args.page, args.server.base, '#bots'); await args.capture?.('requirements-reset-defaults');
}
