// Runs as an unprivileged process INSIDE a disposable container. No Docker access.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let started = false, child, login;
const controller = new AbortController();
const executable = (pkg, command) => {
  const manifest = require.resolve(`${pkg}/package.json`);
  return resolve(dirname(manifest), require(manifest).bin[command]);
};
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/runner', USERPROFILE: '/home/runner', LANG: 'C.UTF-8',
  CODEX_HOME: '/home/runner/.codex', CLAUDE_CONFIG_DIR: '/home/runner/.claude',
  XDG_CONFIG_HOME: '/home/runner/.config', XDG_CACHE_HOME: '/tmp/cache', XDG_STATE_HOME: '/home/runner/.state' };
input.on('line', async line => {
  try {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('Input limit exceeded.');
    const message = JSON.parse(line);
    if (started) {
      if (child) { if (!child.stdin.write(line + '\n')) input.pause(), child.stdin.once('drain', () => input.resume()); return; }
      if (message.type === 'input') login?.write(message.data);
      else if (message.type === 'resize') login?.resize(message.cols, message.rows);
      else if (message.type === 'cancel') controller.abort(), login?.cancel();
      return;
    }
    started = true;
    if (process.argv[2] === 'mcp') {
      const c = message.config;
      if (!c || typeof c.command !== 'string' || !Array.isArray(c.args)) throw new Error('Invalid MCP configuration.');
      child = spawn(c.command, c.args, { cwd: '/workspace', env: { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG, ...c.env }, stdio: ['pipe', 'pipe', 'ignore'] });
      child.on('error', () => process.exit(1));
      child.on('exit', code => process.exit(code ?? 1));
      child.once('spawn', () => { send({ type: 'ready' }); child.stdout.pipe(process.stdout); });
      return;
    }
    if (!['claude', 'codex'].includes(message.provider)) throw new Error('Invalid provider.');
    const runner = await import('../../companion/cli-bridge.mjs');
    let loginReady = message.operation !== 'login';
    const initialOutput = [];
    const options = { env, fileCredentials: true, signal: controller.signal,
      // The other executable is deliberately absent, even if it is installed in the image.
      codexPath: message.provider === 'codex' ? executable('@openai/codex', 'codex') : '/disabled/codex',
      claudePath: message.provider === 'claude' ? executable('@anthropic-ai/claude-code', 'claude') : '/disabled/claude',
      cols: message.cols, rows: message.rows, onData: data => { if (loginReady) send({ type: 'data', data }); else initialOutput.push(data); } };
    if (message.operation !== 'login') send({ type: 'ready' });
    let result;
    if (message.operation === 'status') result = (await runner.checkProviders(options))[message.provider];
    else if (message.operation === 'catalog') result = await runner.readCatalog({ provider: message.provider }, options);
    else if (message.operation === 'generate') {
      if (message.params?.provider !== message.provider) throw new Error('Provider mismatch.');
      result = await runner.runGeneration(message.params, options);
    } else if (message.operation === 'login') {
      login = await runner.startLogin(message.provider, options);
      loginReady = true; send({ type: 'ready' });
      for (const data of initialOutput) send({ type: 'data', data });
      result = await login.done;
    } else throw new Error('Invalid operation.');
    send({ type: 'result', result }); process.exit(0);
  } catch {
    send({ type: 'error', error: 'Isolated runner failed. Reconnect your subscription or check the selected MCP command.' });
    process.exit(1);
  }
});
input.on('close', () => { controller.abort(); login?.cancel(); child?.kill(); process.exit(0); });
