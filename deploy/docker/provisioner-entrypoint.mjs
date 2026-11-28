import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Local hold is a non-working state, never release evidence or permission to provision. */
export async function startDockerProvisioner({ env = process.env, connect, start, port = 8788 } = {}) {
  if (env.SWARM_ROLE !== 'provisioner') throw new Error('Docker provisioner requires SWARM_ROLE=provisioner.');
  const hold = env.SWARM_LOCAL_PROVISIONER_HOLD ?? '0';
  if (!['0', '1'].includes(hold)) throw new Error('Invalid SWARM_LOCAL_PROVISIONER_HOLD.');
  if (hold === '1' && env.SWARM_ALLOW_LOCAL_CLOUD !== '1') throw new Error('Local provisioner hold requires SWARM_ALLOW_LOCAL_CLOUD=1.');
  const directory = await (connect ?? (async () => new (await import('../../server/dist/platform/directory.js')).Directory()))();
  let worker;
  try {
    if (hold === '0') {
      // The real worker still requires driver credentials, a pinned image and every release gate.
      worker = await (start ?? (async () => (await import('../../server/dist/platform/provisioner.js')).startProvisioner()))();
    }
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404).end('{}'); return; }
      try {
        await directory.pool.query('SELECT 1 FROM tenants LIMIT 0');
        res.end(JSON.stringify({ ok: true, role: 'provisioner', provisioning: hold === '1' ? 'held' : 'enabled' }));
      } catch { res.writeHead(503).end(JSON.stringify({ ok: false, role: 'provisioner' })); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return { server, close: async () => {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await worker?.close();
      await worker?.directory.pool.end();
      await directory.pool.end();
    } };
  } catch (error) { await worker?.close(); await worker?.directory.pool.end(); await directory.pool.end(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = await startDockerProvisioner();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
    if (process.env.SWARM_LOCAL_PROVISIONER_HOLD === '1') console.log('Provisioning held locally. No lifecycle worker or release-gate evidence created.');
  } catch { console.error('Provisioner startup refused. Check configuration and qualified image evidence.'); process.exitCode = 1; }
}
