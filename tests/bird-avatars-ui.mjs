// Built frontend with isolated API fixtures. No live accounts or Bot writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/bird-avatars/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
let server, origin = process.env.UI_ORIGIN, logs = '';
if (!origin) {
  const port = await new Promise(resolve => { const socket = http.createServer().listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
}
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const wait = async predicate => { for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out'); };
const names = ['Flock', 'Solo', 'Soar', 'Glide', 'Pair', 'Rise', 'Arc', 'Vee', 'Diamond', 'Cascade'];
const ids = names.map(name => `bird-${name.toLowerCase()}`);
const colors = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];
const legacy = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];
const aliases = { bean: 'teardrop', squircle: 'square', capsule: 'tablet', cylinder: 'tablet', gem: 'hex', crystal: 'hex', shield: 'house', dome: 'house', arch: 'house', leaf: 'teardrop' };
const shapeSource = await fs.readFile(new URL('../web/src/avatar/shapes.gen.ts', import.meta.url), 'utf8');
const shapes = JSON.parse(shapeSource.match(/= (\{.*\});/s)[1]);
const base = { kind: 'agent', mode: 'personal', pinned: false, generation: 1, unread: 0, lastActivityAt: 0, createdAt: 0, description: '', label: '', instructions: '', model: null, effort: 'medium', onboarding: { status: 'active' }, avatarColor: 'black' };
let browser;
try {
  await wait(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, reducedMotion: 'no-preference' });
    page.setDefaultTimeout(10000);
    const errors = [], posts = [], patches = [];
    let bots = [{ ...base, id: 'primary', name: 'Primary', isPrimary: true, avatarShape: 'blob' }, ...legacy.map(shape => ({ ...base, id: `legacy-${shape}`, name: `Legacy ${shape}`, avatarShape: shape, isPrimary: false }))];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => {
      localStorage.setItem('swarm.theme', theme);
      localStorage.setItem('swarm.selectedBot', 'primary');
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { window.emitBird = event => this.onmessage?.({ data: JSON.stringify(event) }); setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
    }, theme);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) { errors.push(`External request ${url.origin}`); return route.abort(); }
      if (!path.startsWith('/api/')) return route.continue();
      if (path.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
      if (request.method() === 'POST' && path === '/api/bots') {
        const body = request.postDataJSON(); posts.push(body);
        const bot = { ...base, ...body, id: 'created', isPrimary: false };
        bots.push(bot); return route.fulfill({ json: { bot } });
      }
      if (request.method() === 'PATCH' && path.startsWith('/api/bots/')) {
        const patch = request.postDataJSON(); patches.push(patch);
        const id = path.split('/')[3]; bots = bots.map(bot => bot.id === id ? { ...bot, ...patch } : bot);
        return route.fulfill({ json: { bot: bots.find(bot => bot.id === id) } });
      }
      if (request.method() !== 'GET') { errors.push(`Unexpected ${request.method()} ${path}`); return route.abort(); }
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' } };
      else if (path === '/api/bots') body = { bots, live: [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (path === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [], favourites: [], canFast: false };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (path.endsWith('/settings')) body = { memories: [], skills: [], routines: [], tasks: [], memory: { historyChars: 0 } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      return route.fulfill({ json: body });
    });
    await page.goto(origin);
    await page.locator('.chat__header .flock-mark').waitFor();
    assert.equal(await page.locator('.chat__header svg[data-bird]').count(), 0, 'primary keeps the official mark');
    for (const shape of legacy) {
      const avatar = page.locator(`.bot-row .bot-avatar[aria-label="Legacy ${shape}"]`);
      assert.equal(await avatar.locator('svg > path').last().getAttribute('d'), (shapes[shape] ?? shapes[aliases[shape]]).d, `${shape} retains its original silhouette`);
    }

    await page.getByRole('button', { name: 'New Bot', exact: true }).click();
    const form = page.getByRole('main', { name: 'Create a Bot', exact: true });
    const picker = form.getByRole('radiogroup', { name: 'Character shape' });
    await picker.waitFor();
    assert.deepEqual(await picker.getByRole('radio').evaluateAll(elements => elements.map(el => el.getAttribute('aria-label'))), names);
    assert.deepEqual(await picker.getByRole('radio').evaluateAll(elements => elements.map(el => el.value)), ids, 'only birds are suggested, in design order');
    assert.equal(await picker.getByRole('radio', { name: 'Flock', exact: true }).isChecked(), true);
    await picker.getByRole('radio', { name: 'Flock', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await picker.getByRole('radio', { name: 'Solo', exact: true }).isChecked(), true);
    await page.keyboard.press('ArrowLeft');

    // Rasterize the rendered SVGs with their computed theme/palette colors at actual small sizes.
    for (const color of colors) {
      await form.getByRole('combobox', { name: 'Color' }).selectOption(color);
      const pixels = await picker.locator('svg[data-bird]').evaluateAll(async (elements, theme) => {
        const stats = [];
        for (const element of elements) for (const size of [24, 32]) {
          const svg = element.cloneNode(true);
          const color = getComputedStyle(element).color;
          svg.removeAttribute('style'); svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('color', color);
          svg.setAttribute('width', size); svg.setAttribute('height', size);
          const image = new Image(); image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, size, size);
          const data = context.getImageData(0, 0, size, size).data;
          let count = 0, border = 0;
          const background = theme === 'dark' ? 24 : 255;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            const difference = Math.max(...[0, 1, 2].map(channel => Math.abs(data[i + channel] - background)));
            if (difference < 55) continue;
            count++;
            const pixel = i / 4, x = pixel % size, y = Math.floor(pixel / size);
            if (x === 0 || y === 0 || x === size - 1 || y === size - 1) border++;
          }
          stats.push({ id: element.dataset.bird, size, count, border });
        }
        return stats;
      }, theme);
      for (const pixel of pixels) {
        assert.ok(pixel.count > 35, `${theme} ${color} ${pixel.id} at ${pixel.size}px has visible contrasting wings: ${pixel.count}`);
        assert.equal(pixel.border, 0, `${pixel.id} is not clipped`);
      }
    }
    await form.getByRole('combobox', { name: 'Color' }).selectOption('blue');
    await form.screenshot({ path: new URL(`create-${theme}.png`, evidence).pathname });
    await page.setViewportSize({ width: 320, height: 760 });
    await page.locator('.app.is-mobile').waitFor();
    const bounds = await picker.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
    for (const choice of await picker.locator('.bird-picker__choice').all()) {
      const box = await choice.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, 'phone label touch target');
    }
    await form.screenshot({ path: new URL(`phone-${theme}.png`, evidence).pathname });
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.locator('.app:not(.is-mobile)').waitFor();
    await form.getByRole('textbox', { name: 'Bot name' }).fill('New bird');
    await form.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('.chat__header svg[data-bird="bird-flock"]').waitFor();
    assert.equal(posts[0].avatarShape, 'bird-flock');
    assert.equal(posts[0].avatarColor, 'blue');
    const createdAvatar = page.locator('.chat__header .bot-avatar[aria-label="New bird"]');
    const original = await createdAvatar.locator('svg').innerHTML();
    await page.evaluate(() => window.emitBird({ type: 'live', state: { botId: 'created', audience: 'user', isRunning: true, awaiting: null, startedAt: Date.now(), activity: null } }));
    await createdAvatar.locator('.flock-mark__moving:visible').waitFor();
    assert.equal(await createdAvatar.locator('svg').innerHTML(), original, 'working keeps the chosen bird');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await createdAvatar.locator('.flock-mark__moving:visible').count(), 0);
    assert.equal(await createdAvatar.locator('svg').evaluate(el => getComputedStyle(el).animationName), 'none');

    await page.goto(`${origin}/#bot/legacy-heart/settings/general`);
    await page.getByRole('button', { name: 'Change look', exact: true }).click();
    const settingsPicker = page.getByRole('radiogroup', { name: 'Character shape' });
    assert.deepEqual(await settingsPicker.getByRole('radio').evaluateAll(elements => elements.map(el => el.value)), ids);
    assert.equal(await settingsPicker.locator('input:checked').count(), 0, 'opening a legacy Bot does not select a bird');
    await page.setViewportSize({ width: 320, height: 760 });
    await page.locator('.app.is-mobile').waitFor();
    const settingsBounds = await settingsPicker.boundingBox();
    assert.ok(settingsBounds.x >= 0 && settingsBounds.x + settingsBounds.width <= 320, 'settings picker fits phone width');
    for (const choice of await settingsPicker.locator('.bird-picker__choice').all()) {
      const box = await choice.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, 'settings phone label touch target');
    }
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.locator('.app:not(.is-mobile)').waitFor();
    const preview = page.locator('.cfg-look .bot-avatar > svg');
    const legacyPath = await preview.locator('path').last().getAttribute('d');
    assert.equal(legacyPath, shapes.heart.d);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Legacy renamed');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await wait(() => patches.length === 1);
    assert.deepEqual(patches[0], { name: 'Legacy renamed' });
    await page.getByRole('radiogroup', { name: 'Character color' }).getByRole('radio', { name: 'violet', exact: true }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await wait(() => patches.length === 2);
    assert.deepEqual(patches[1], { avatarColor: 'violet' });
    assert.equal(await preview.locator('path').last().getAttribute('d'), legacyPath);
    await settingsPicker.getByText('Diamond', { exact: true }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await wait(() => patches.length === 3);
    assert.deepEqual(patches[2], { avatarShape: 'bird-diamond' });
    await preview.locator('g > path').first().waitFor();
    const savedBird = page.locator('.bot-row .bot-avatar[aria-label="Legacy renamed"] > svg[data-bird="bird-diamond"]');
    await savedBird.waitFor();
    const rendered = await savedBird.evaluate(svg => {
      const rect = svg.getBoundingClientRect(), slot = svg.parentElement.getBoundingClientRect();
      return { width: rect.width, height: rect.height, x: rect.x, y: rect.y, slotWidth: slot.width, slotHeight: slot.height, slotX: slot.x, slotY: slot.y, color: getComputedStyle(svg).color };
    });
    assert.equal(rendered.width, rendered.slotWidth, 'saved bird drops legacy overdraw width');
    assert.equal(rendered.height, rendered.slotHeight, 'saved bird drops legacy overdraw height');
    assert.equal(rendered.x, rendered.slotX); assert.equal(rendered.y, rendered.slotY);
    assert.equal(rendered.color, await preview.evaluate(svg => getComputedStyle(svg).color), 'saved bird keeps preview color in both themes');
    await page.screenshot({ path: new URL(`settings-${theme}.png`, evidence).pathname });

    // Exported assets also render real pixels, independent of the React renderer.
    const exports = await page.evaluate(async ({ ids, theme }) => {
      const result = [];
      for (const id of ids) for (const size of [24, 32]) {
        const image = new Image(); image.src = `/assets/swarms/avatars/${id}${theme === 'dark' ? '-night' : ''}.svg`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, size, size);
        const data = context.getImageData(0, 0, size, size).data;
        let count = 0; for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) count++;
        result.push({ id, size, count });
      }
      return result;
    }, { ids, theme });
    for (const item of exports) assert.ok(item.count > 35, `${theme} exported ${item.id} at ${item.size}px`);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${theme}: bird-only pickers, default creation, 25 legacy silhouettes, name/color preservation, keyboard, phone, working/reduced motion, all colors and exports at 24/32px`);
  }
} catch (error) { console.error(logs); throw error; }
finally { await browser?.close(); server?.kill(); }

// Include the local dev-server hit-target regression in the existing CI bird suite.
await import('./bird-picker-ui.mjs');
