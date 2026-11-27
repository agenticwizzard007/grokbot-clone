export const agentsSettingsScreens = ['settings-agents', ...[
  'limits', 'help', 'loading', 'error', 'disabled', 'empty', 'links-loading',
  'links-error', 'save-error', 'saving', 'saved', 'long', 'no-agents',
].map(state => `settings-agents-${state}`)];

/** Real Settings route with isolated policy/link responses for each UI state. */
export async function agentsSettingsState(page, fixture, name) {
  const state = name.replace(/^settings-agents-?/, '') || 'ready';
  let settings = { enabled: state !== 'disabled', agentHandoffs: 'team' };
  const target = state === 'long' ? 'Release documentation and accessibility review team' : 'Research';
  const link = { id: 'link_polish', fromBotId: fixture.bot.id, toBotId: fixture.checker,
    mode: 'suggest', trigger: 'any_run', template: 'Review {title}.', autoApproveLoops: false, createdAt: 0, updatedAt: 0 };
  await page.route('**/api/handoff-settings', async route => {
    if (route.request().method() === 'PUT') {
      if (state === 'saving') return new Promise(() => {});
      if (state === 'save-error') return route.fulfill({ status: 503, json: { error: 'Could not save handoff settings. Try again.' } });
      settings = route.request().postDataJSON();
    } else {
      if (state === 'loading') return new Promise(() => {});
      if (state === 'error') return route.fulfill({ status: 503, json: { error: 'Could not load handoff settings. Try again.' } });
    }
    return route.fulfill({ json: { settings } });
  });
  await page.route('**/api/handoff-links?*', route => {
    if (state === 'links-loading') return new Promise(() => {});
    if (state === 'links-error') return route.fulfill({ status: 503, json: { error: 'Could not load standing links. Try again.' } });
    return route.fulfill({ json: { links: state === 'empty' ? [] : [link] } });
  });
  if (state === 'long' || state === 'no-agents') await page.route(/\/api\/bots$/, async route => {
    const response = await route.fetch(), data = await response.json();
    return route.fulfill({ response, json: { ...data, bots: state === 'no-agents' ? [] : data.bots.map(bot => bot.id === fixture.checker ? { ...bot, name: target } : bot) } });
  });
  return {
    hash: '#settings/agents', selector: '.agents-settings',
    async ready() {
      await page.locator('.agents-settings').waitFor();
      if (state === 'loading') { await page.getByText('Loading', { exact: true }).waitFor(); return; }
      if (state === 'error') { await page.locator('.agents-settings [role="alert"]').waitFor(); return; }
      await page.getByRole('combobox', { name: 'Agent handoffs', exact: true }).waitFor();
      if (state === 'disabled') return;
      if (state === 'empty' || state === 'no-agents') await page.getByText('No links', { exact: true }).waitFor();
      else if (state === 'links-loading') await page.getByText('Loading', { exact: true }).waitFor();
      else if (state === 'links-error') await page.locator('.agents-settings [role="alert"]').waitFor();
      else await page.getByRole('combobox', { name: `Handoff mode for ${target}`, exact: true }).waitFor();
      if (state === 'limits') await page.locator('.agents-settings summary').click();
      if (state === 'help') { await page.getByRole('button', { name: 'About handoffs', exact: true }).focus(); await page.getByRole('tooltip').waitFor(); }
      if (['save-error', 'saving', 'saved'].includes(state)) {
        const write = page.waitForRequest(request => request.url().endsWith('/api/handoff-settings') && request.method() === 'PUT');
        await page.getByRole('combobox', { name: 'Agent handoffs', exact: true }).selectOption('links_only'); await write;
        if (state === 'save-error') await page.getByText('Not saved', { exact: true }).waitFor();
        else if (state === 'saved') await page.getByText('Saved', { exact: true }).waitFor();
        else await page.locator('.agents-settings[aria-busy="true"]').waitFor();
      }
    },
  };
}
