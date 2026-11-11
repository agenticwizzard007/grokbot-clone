import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BROWSER_TOOLS, MAC_SCREEN_PROBE, macBackend, DesktopBrowser, findPlaywrightMcp, LocalMcpProcess, resolveBrowserCdp, validateBrowserCdp, validateDesktopOptions } from '../swarm-companion.mjs';
import { cancelChild, runCommand, serialCommand } from '../swarm-companion.mjs';

const fixture = new URL('./fixtures/mcp.mjs', import.meta.url).pathname;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  throw new Error('Timed out waiting for lifecycle condition');
}
function alive(pid) {
  // A reparented zombie has already stopped executing, even before init reaps it.
  try { if (process.platform === 'linux' && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')) return false; process.kill(pid, 0); return true; } catch { return false; }
}

test('only desktop can opt into the scoped local route or explicit CDP', () => {
  assert.equal(validateDesktopOptions({ desktop: true, localDevice: true }), null);
  for (const options of [{ localDevice: true }, { desktop: true, multi: true, localDevice: true }, { browserCdp: 'http://127.0.0.1:9222' }, { desktop: true, multi: true, browserCdp: 'http://127.0.0.1:9222' }]) assert.throws(() => validateDesktopOptions(options));
  assert.equal(validateDesktopOptions({ desktop: true, browserCdp: 'http://localhost:9222' }), 'http://127.0.0.1:9222/');
});

test('existing browser attachment accepts only explicit credential-free loopback endpoints', () => {
  for (const url of ['http://127.0.0.1:9222', 'https://localhost:9222', 'ws://[::1]:9222/devtools/browser/test']) assert.ok(validateBrowserCdp(url));
  for (const url of ['', 'http://example.com:9222', 'http://192.168.1.1:9222', 'http://0.0.0.0:9222', 'http://127.0.0.2:9222', 'http://localhost.example:9222', 'file:///tmp/browser', 'http://user:pass@127.0.0.1:9222', 'http://127.0.0.1:9222?secret=x', 'http://127.0.0.1:9222?', 'http://127.0.0.1:9222#', 'http://127.0.0.1:9222/#token', ' http://127.0.0.1:9222', 'http://localhost\\@example.com:9222']) assert.throws(() => validateBrowserCdp(url), /loopback/);
});

test('CDP discovery rejects off-loopback WebSockets and redirects', async t => {
  let payload = { webSocketDebuggerUrl: 'ws://example.com:9222/devtools/browser/test' }, redirect = false;
  const server = http.createServer((req, res) => { if (redirect) { res.writeHead(302, { location: 'http://example.com/' }); res.end(); } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(resolveBrowserCdp(url), /loopback/);
  redirect = true;
  await assert.rejects(resolveBrowserCdp(url));
  redirect = false;
  payload = { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test' };
  assert.equal(await resolveBrowserCdp(url), payload.webSocketDebuggerUrl);
});

test('bundled MCP resolution handles resources paths with spaces and explicit missing overrides', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm bundle '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'Resources/node_modules/@playwright/mcp/cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
  assert.equal(findPlaywrightMcp({ moduleUrl: pathToFileURL(path.join(root, 'Resources/companion/swarm-companion.mjs')).href, execPath: path.join(root, 'Resources/bin/node') }), cli);
  assert.equal(findPlaywrightMcp({ explicit: path.join(root, 'missing') }), null);
  assert.equal(findPlaywrightMcp({ explicit: cli }), cli);
});

test('supported tools match the hosted wire schemas and exclude browser close/code execution', () => {
  const source = fs.readFileSync(new URL('../../server/src/computers/browser-tools.ts', import.meta.url), 'utf8');
  const names = [...source.matchAll(/"name": "(browser_[^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...BROWSER_TOOLS].sort(), names.sort());
  assert.ok(!BROWSER_TOOLS.has('browser_close'));
  assert.ok(!BROWSER_TOOLS.has('browser_run_code_unsafe'));
});

test('revocation cancels actions already queued behind in-flight desktop work', async () => {
  const controller = new AbortController();
  let release, ran = false;
  const queue = new Promise(resolve => { release = resolve; });
  const queued = runCommand(controller.signal, () => serialCommand(queue, () => { ran = true; }));
  controller.abort(new Error('revoked')); release();
  await assert.rejects(queued, /revoked/);
  assert.equal(ran, false);
  let fresh = false;
  await runCommand(new AbortController().signal, () => serialCommand(queued, () => { fresh = true; }));
  assert.equal(fresh, true);
});

test('revocation kills an active shell group including its child', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-shell-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const child = runCommand(controller.signal, () => {
    const proc = spawn('/bin/sh', ['-c', 'sleep 30 & echo $! > "$1"; wait', 'test', path.join(root, 'child.pid')], { detached: true, stdio: 'ignore' });
    cancelChild(proc); return proc;
  });
  await until(() => fs.existsSync(path.join(root, 'child.pid')));
  const pid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'));
  controller.abort();
  await until(() => !alive(child.pid) && !alive(pid));
});

test('local MCP uses the running bundled Node, sanitizes attach env, and stops all waiters and descendants', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mcp-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
  process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = 'http://remote.invalid:9222';
  t.after(() => { if (old === undefined) delete process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT; else process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = old; });
  const mcp = await new LocalMcpProcess(fixture, ['--output-dir', root], root).init();
  t.after(() => mcp.close());
  const info = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
  assert.equal(info.execPath, process.execPath);
  assert.deepEqual(info.inheritedMcp, []);
  const pending = mcp.request('tools/call', { name: 'browser_wait_for', arguments: {} });
  const rejected = assert.rejects(pending, /control stopped/);
  await until(() => fs.existsSync(path.join(root, 'child.pid')));
  const pid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'));
  await mcp.close(); await rejected;
  await until(() => !alive(pid));
});

test('managed local sessions are headed, persistent, pipe-based, and keep profiles on reset', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-managed-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const browser = new DesktopBrowser({ cli: fixture, dataDir: root, chrome: () => '/test/Chrome' });
  t.after(() => browser.closeAll());
  assert.equal(browser.available, true);
  assert.equal(new DesktopBrowser({ dataDir: root }).available, false);
  await browser.call('bot', 'browser_snapshot');
  const args = JSON.parse(fs.readFileSync(path.join(root, 'playwright/bot/fixture.json'), 'utf8')).args;
  assert.ok(args.includes('--user-data-dir'));
  for (const flag of ['--headless', '--isolated', '--port', '--cdp-endpoint', '--extension']) assert.ok(!args.includes(flag));
  const profile = args[args.indexOf('--user-data-dir') + 1];
  fs.writeFileSync(path.join(profile, 'persistent-marker'), 'test');
  await browser.close('bot');
  assert.equal(fs.readFileSync(path.join(profile, 'persistent-marker'), 'utf8'), 'test');
  await assert.rejects(browser.call('bot', 'browser_close'), /Unknown browser tool/);
});

test('CDP relay blocks WebSocket redirects and refuses unauthenticated local paths', async t => {
  const { createCdpRelay } = await import('../swarm-companion.mjs');
  let redirected = false;
  const remote = http.createServer((_req, res) => { redirected = true; res.end(); });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => remote.close());
  const source = http.createServer((_req, res) => { res.writeHead(302, { location: `ws://127.0.0.1:${remote.address().port}/redirect` }); res.end(); });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(() => source.close());
  const relay = await createCdpRelay(`ws://127.0.0.1:${source.address().port}/devtools/browser/test`);
  t.after(() => relay.close());
  const badPath = new URL(relay.endpoint); badPath.protocol = 'http:'; badPath.pathname = '/';
  assert.equal((await fetch(badPath)).status, 403);
  const ws = new WebSocket(relay.endpoint);
  await new Promise(resolve => { ws.onerror = resolve; ws.onclose = resolve; });
  assert.equal(redirected, false);
});

test('simultaneous disconnect and shutdown both await an already closing browser', async () => {
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const browser = new DesktopBrowser({ dataDir: '/unused' });
  browser.sessions.set('bot', { mcp: { close: () => closed } });
  const first = browser.closeAll();
  let secondFinished = false;
  const second = browser.closeAll().then(() => { secondFinished = true; });
  await Promise.resolve();
  assert.equal(secondFinished, false);
  finish(); await first; await second;
  assert.equal(secondFinished, true);
});

test('bundled pinned Playwright MCP exposes every hosted browser tool over stdio', async t => {
  const cli = findPlaywrightMcp();
  if (!cli) return t.skip('Pinned @playwright/mcp is not installed in this checkout');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-tools-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mcp = await new LocalMcpProcess(cli, ['--cdp-endpoint', 'http://127.0.0.1:1'], root).init();
  t.after(() => mcp.close());
  const result = await mcp.request('tools/list', {});
  const tools = new Set(result.tools.map(tool => tool.name));
  for (const name of BROWSER_TOOLS) assert.ok(tools.has(name), name);
});


test('Mac screenshot fails closed for denied, missing, and unavailable screen permission probes', async () => {
  for (const value of [{ screen: false }, { screen: null }, {}, null]) {
    const calls = [];
    const execute = async (command, args) => {
      calls.push({ command, args });
      if (value === null) throw new Error('native symbol unavailable');
      return Buffer.from(JSON.stringify(value));
    };
    await assert.rejects(macBackend.capture(1280, 70, execute), /Screen Recording permission/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/osascript');
    assert.ok(calls[0].args.includes(MAC_SCREEN_PROBE));
  }
});

test('Mac startup tolerates failed permission probes without blocking desktop shell/browser startup', async t => {
  const warnings = [];
  t.mock.method(console, 'log', (...values) => warnings.push(values.join(' ')));
  await assert.doesNotReject(macBackend.checkPermissions(async () => { throw new Error('JXA bridge unavailable'); }));
  await assert.doesNotReject(macBackend.checkPermissions(async () => Buffer.from(JSON.stringify({ accessibility: false, screen: false, errors: {} }))));
  assert.ok(warnings.some(warning => /Shell\/browser can still start/.test(warning)));
  assert.ok(warnings.some(warning => /Accessibility.*Swarm/.test(warning)));
  assert.ok(warnings.some(warning => /Screen Recording.*Swarm/.test(warning)));
});
