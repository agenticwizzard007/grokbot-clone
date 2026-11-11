import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sha256 } from './policy.mjs';

// Serialized into the actual desktop image as a controlled adversarial workload.
// Nothing from the host's Node environment or credentials is inherited.
export async function desktopProbe(config) {
  const fs = require('node:fs'), net = require('node:net'), http = require('node:http');
  const { execFileSync, spawnSync } = require('node:child_process');
  const assert = require('node:assert/strict');
  const out = { status: 'failed', blockedTargets: [], checks: {} };
  const absent = file => { try { fs.readFileSync(file); throw Error('Boundary allowed a forbidden read.'); } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(error.code)) throw error; } };
  try {
    assert.equal(process.getuid(), 10001);
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const field = name => status.match(new RegExp('^' + name + ':\\s*(.+)$', 'm'))?.[1];
    assert.match(field('CapEff'), /^0+$/); assert.equal(field('NoNewPrivs'), '1'); assert.equal(field('Seccomp'), '2');
    for (const [file, value] of Object.entries({ 'pids.max': '512', 'memory.max': '1610612736', 'memory.swap.max': '0', 'cpu.max': '200000 100000' })) assert.equal(fs.readFileSync('/sys/fs/cgroup/' + file, 'utf8').trim(), value);
    assert.throws(() => fs.writeFileSync('/etc/escape', 'probe'), { code: 'EROFS' });
    for (const file of config.forbiddenFiles) {
      absent(file); absent('/proc/1/root' + file);
      const link = '/home/agent/escape-link'; fs.symlinkSync(file, link); try { absent(link); } finally { fs.unlinkSync(link); }
    }
    absent('/proc/' + config.hostPid + '/cmdline');
    assert.equal(fs.readFileSync('/run/desktop-token', 'utf8'), config.desktopToken);
    assert.throws(() => fs.writeFileSync('/run/desktop-token', 'changed'));
    fs.mkdirSync('/tmp/mount-probe');
    const mount = spawnSync('mount', ['-t', 'tmpfs', 'none', '/tmp/mount-probe'], { timeout: 5000 });
    assert.ok(!mount.error && mount.status !== 0, 'Mount probe must execute and be denied.');
    const chroot = spawnSync('chroot', ['/proc/1/root', '/bin/true'], { timeout: 5000 });
    assert.ok(!chroot.error && chroot.status !== 0, 'Unnamespaced chroot must be denied.');
    // The scoped profile intentionally allows a user namespace. If one is
    // created, its root must still see only the container filesystem.
    const code = `const fs=require('node:fs');for(const p of ${JSON.stringify(config.forbiddenFiles)}){try{fs.readFileSync(p);console.log('leak');process.exit(99)}catch(e){if(!['ENOENT','EACCES','EPERM','EISDIR'].includes(e.code))throw e}}console.log('namespace-contained')`;
    const namespace = spawnSync('unshare', ['--user', '--map-root-user', 'node', '-e', code], { timeout: 5000, encoding: 'utf8' });
    assert.ok(!namespace.error, 'unshare must exist for the adversarial namespace probe.');
    assert.ok(namespace.status === 0 && namespace.stdout.trim() === 'namespace-contained', 'Allowed user namespace did not remain contained.');
    out.checks.namespaceContained = true;
    function connect(target) {
      return new Promise(resolve => {
        const socket = net.connect({ host: target.host, port: target.port });
        const finish = value => { socket.destroy(); resolve(value); };
        socket.setTimeout(1000); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
      });
    }
    for (const target of config.blockedTargets) {
      assert.equal(await connect(target), false, 'Desktop reached forbidden target: ' + target.name);
      out.blockedTargets.push(target.name);
    }
    // An authenticated companion channel is the sole intended cross-container
    // exception. Both its positive route and its token rejection are required.
    const request = token => new Promise((resolve, reject) => {
      const req = http.get({ host: '172.30.0.2', port: 8787, path: '/', headers: { authorization: 'Bearer ' + token }, timeout: 3000 }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('Intended companion path unavailable.')));
    });
    assert.equal(await request(config.desktopToken), 200); assert.equal(await request('invalid-fixture-token'), 401);
    out.checks.companionRoute = true; out.checks.invalidCompanionTokenRejected = true;
    const html = execFileSync('google-chrome-stable', ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=/home/agent/qualification-chrome', '--dump-dom', 'chrome://sandbox'], { timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const label of ['Namespace sandbox', 'Seccomp-BPF sandbox']) assert.match(html, new RegExp(label + '</td>\\s*<td[^>]*>Yes</td>', 'i'));
    out.checks.chromeNamespaceSandbox = true; out.checks.chromeSeccompSandbox = true;
    out.checks.filesystem = true; out.checks.kernel = true; out.status = 'passed';
  } catch (error) { out.error = String(error.message).slice(0, 1000); }
  fs.writeFileSync('/home/agent/qualification-result.json', JSON.stringify(out) + '\n', { mode: 0o600 });
  process.exitCode = out.status === 'passed' ? 0 : 1;
}

function connected(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}

export async function checkDesktop({ docker, exec, manifest, release, output }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-desktop-qualification-'));
  fs.chmodSync(root, 0o755);
  const containers = [], networks = [];
  const token = randomUUID(); // Disposable synthetic companion credential.
  let hostServer, saved4, saved6, restored = false;
  const restore = () => {
    if (restored || !saved4 || !saved6) return;
    execFileSync('iptables-restore', [], { input: saved4, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('ip6tables-restore', [], { input: saved6, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    restored = true;
  };
  const exitRestore = () => { try { restore(); } catch {} };
  process.once('exit', exitRestore); // Watchdog process.exit must restore SSH too.
  try {
    assert.equal(sha256(fs.readFileSync('/opt/swarm/chromium-seccomp.json')), manifest.desktopSeccompSha256);
    const profile = JSON.parse(fs.readFileSync('/opt/swarm/chromium-seccomp.json'));
    assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
    for (const part of ['app', 'desktop', 'subscriptions/claude', 'subscriptions/codex']) {
      const folder = path.join(root, part); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      fs.chownSync(folder, 10001, 10001);
      fs.writeFileSync(path.join(folder, 'credential'), 'synthetic-private-fixture', { mode: 0o600 });
      fs.chownSync(path.join(folder, 'credential'), 10001, 10001);
    }
    const tokenFile = path.join(root, 'desktop-token');
    fs.writeFileSync(tokenFile, token, { mode: 0o440 }); fs.chownSync(tokenFile, 0, 10001);
    await docker(['load', '--input', '/opt/swarm/images/DESKTOP_IMAGE.tar'], 120000);
    const desktopId = release.imageIds.desktopImage;
    const desktopInfo = JSON.parse((await docker(['image', 'inspect', desktopId])).stdout)[0];
    assert.equal(desktopInfo.Id, desktopId); assert.equal((desktopInfo.Config.Entrypoint ?? []).length, 0);
    if (release.imageIds.appImage !== release.imageIds.mcpImage) await docker(['load', '--input', '/opt/swarm/images/APP_IMAGE.tar'], 120000);
    const appId = release.imageIds.appImage;
    await docker(['image', 'inspect', appId]);
    const networkPlans = [...manifest.networkArguments,
      ['--subnet', '169.254.169.0/24', 'swarm-metadata-probe'], ['--subnet', '10.250.0.0/24', 'swarm-private-probe']];
    for (const args of networkPlans) { await docker(['network', 'create', ...args]); networks.push(args.at(-1)); }
    hostServer = net.createServer(socket => socket.end('synthetic-host-listener'));
    await new Promise((resolve, reject) => { hostServer.once('error', reject); hostServer.listen(18080, '::', resolve); });
    const privateIp = process.env.FLY_PRIVATE_IP;
    assert.ok(privateIp && /^f[cd][a-f0-9:]+$/i.test(privateIp), 'Require Fly private IPv6 for a real private-host negative probe.');
    const targets = [
      { name: 'app-other-port', network: 'swarm-app', host: '172.30.0.2', port: 18081, app: true },
      { name: 'other-container', network: 'swarm-app', host: '172.30.0.3', port: 18080 },
      { name: 'mcp-container', network: 'swarm-public', host: '172.29.0.2', port: 18080 },
      { name: 'metadata-fixture', network: 'swarm-metadata-probe', host: '169.254.169.254', port: 18080 },
      { name: 'private-network-fixture', network: 'swarm-private-probe', host: '10.250.0.2', port: 18080 },
    ];
    for (const target of targets) {
      const name = `swarm-${randomUUID()}`; containers.push(name);
      const code = `const net=require('node:net'),http=require('node:http');net.createServer(s=>s.end('fixture')).listen(${target.port},'0.0.0.0');` +
        (target.app ? `require('node:fs').readFileSync('/data/credential');http.createServer((q,s)=>{s.statusCode=q.headers.authorization===${JSON.stringify('Bearer ' + token)}?200:401;s.end('fixture')}).listen(8787,'0.0.0.0');` : '');
      if (target.name === 'mcp-container') {
        const args = [...manifest.mcpArguments];
        args[args.indexOf('--name') + 1] = name;
        const imageIndex = args.indexOf(manifest.imageProvenance.components.app);
        assert.ok(imageIndex > 0);
        args.splice(imageIndex, 4, release.imageIds.mcpImage, 'node', '-e', code);
        // Only management additions: keep a sentinel alive at a known address.
        args.splice(1, 0, '--detach', `--ip=${target.host}`);
        await docker(args);
      } else {
        await docker([...manifest.hostBasicArguments, `--name=${name}`, `--network=${target.network}`, `--ip=${target.host}`,
          `--mount=type=bind,src=${root}/app,dst=/data`, appId, 'node', '-e', code]);
      }
      const inspect = JSON.parse((await docker(['inspect', name])).stdout)[0];
      assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
      assert.ok(!(inspect.HostConfig.CapAdd ?? []).length && !inspect.HostConfig.Privileged);
      assert.equal(inspect.Config.User, '10001:10001'); assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
      assert.ok(!(inspect.HostConfig.SecurityOpt ?? []).some(option => option.startsWith('seccomp=')), 'Non-desktop workload must retain Docker default seccomp.');
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await connected(target.host, target.port)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, `Positive-control listener unavailable: ${target.name}`);
    }
    assert.ok(await connected('172.30.0.2', 8787));
    assert.ok(await connected('172.31.0.1', 18080)); assert.ok(await connected(privateIp, 18080));
    const name = `swarm-desktop-${randomUUID()}`; containers.push(name);
    const config = { desktopToken: token, hostPid: process.pid,
      forbiddenFiles: ['/data/swarm.db', '/files/private', '/subscriptions/claude/credential', '/subscriptions/codex/credential',
        '/run/docker.sock', '/var/run/docker.sock', '/run/swarm/data-key', '/run/swarm/runtime-token', '/run/swarm-host/host-token',
        ...['app', 'subscriptions/claude', 'subscriptions/codex'].map(part => path.join(root, part, 'credential'))],
      blockedTargets: [...targets.map(({ name, host, port }) => ({ name, host, port })),
        { name: 'host-bridge-listener', host: '172.31.0.1', port: 18080 }, { name: 'fly-private-host', host: privateIp, port: 18080 }],
    };
    // Bring up Docker's network rules before saving them. The controlled Node
    // process stays inert until the production firewall is installed.
    const probe = `(async()=>{const fs=require('node:fs');for(let i=0;!fs.existsSync('/home/agent/start-probe');i++){if(i>120)throw Error('Firewall barrier timed out');await new Promise(r=>setTimeout(r,250));}await (${desktopProbe.toString()})(${JSON.stringify(config)});})().catch(()=>process.exit(1));`;
    await docker([...manifest.hostBasicArguments, ...manifest.desktopArguments, `--name=${name}`, '--network=swarm-desktop', '--ip=172.31.0.2',
      `--mount=type=bind,src=${root}/desktop,dst=/home/agent`, `--mount=type=bind,src=${tokenFile},dst=/run/desktop-token,readonly`, desktopId, 'node', '-e', probe]);
    const inspected = JSON.parse((await docker(['inspect', name])).stdout)[0];
    assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
    assert.ok(!(inspected.HostConfig.CapAdd ?? []).length && !inspected.HostConfig.Privileged);
    assert.ok(inspected.HostConfig.SecurityOpt.some(option => option.startsWith('seccomp=') && !option.includes('unconfined')));
    saved4 = (await exec('iptables-save', [])).stdout; saved6 = (await exec('ip6tables-save', [])).stdout;
    await exec('/opt/swarm/firewall.sh', []);
    fs.writeFileSync(path.join(root, 'desktop/start-probe'), '', { mode: 0o644 });
    let stopped = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = JSON.parse((await docker(['inspect', name])).stdout)[0].State;
      if (!state.Running) { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(stopped, 'Desktop probe timed out.');
    const bytes = fs.readFileSync(path.join(root, 'desktop/qualification-result.json'));
    fs.writeFileSync(path.join(output, 'desktop.json'), bytes);
    const result = JSON.parse(bytes);
    assert.equal(result.status, 'passed', result.error);
    assert.equal(result.blockedTargets.length, 7);
    return { ...result, profileSha256: manifest.desktopSeccompSha256,
      image: release.desktopImage, config: desktopId, nonDesktopDefaultSeccomp: true, positiveControlListeners: 8 };
  } finally {
    // Restore before cleanup: production IPv6 egress restrictions can prevent
    // private Fly SSH responses. Restoration failure must invalidate the run.
    try { restore(); } finally {
      process.removeListener('exit', exitRestore);
      const cleanup = [];
      for (const name of [...containers].reverse()) try { await docker(['rm', '-f', '--volumes', name]); } catch (error) { cleanup.push(error); }
      for (const name of [...networks].reverse()) try { await docker(['network', 'rm', name]); } catch (error) { cleanup.push(error); }
      if (hostServer) await new Promise(resolve => hostServer.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(cleanup.length, 0, 'Desktop fixture cleanup failed.');
    }
  }
}
