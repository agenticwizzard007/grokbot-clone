// Test-only Vite server: retain the pre-177 settings caller while loading the current shared recovery guard.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createServer } from '../../web/node_modules/vite/dist/node/index.js';
let mode = 'current';
const old = Object.fromEntries(['SubscriptionSettings', 'CliLoginTerminal', 'ReauthPrompt'].map(name => [name, execFileSync('git', ['show', `f6446de:web/src/components/config/${name}.tsx`], { encoding: 'utf8' })]));
const server = await createServer({ root: path.resolve('web'), server: { host: '127.0.0.1', port: Number(process.env.STALE_UI_PORT), strictPort: true },
  plugins: [{ name: 'retained-settings-fixture', enforce: 'pre',
    load(id) {
      for (const [name, source] of Object.entries(old)) if ((mode === 'all-stale' || mode === 'stale' && name === 'SubscriptionSettings') && id.endsWith(`/web/src/components/config/${name}.tsx`)) return source;
    },
    configureServer(vite) { vite.middlewares.use('/__fixture/settings', (req, res) => {
      mode = req.url.includes('all-stale') ? 'all-stale' : req.url.includes('stale') ? 'stale' : 'current'; vite.moduleGraph.invalidateAll(); res.end('ok');
    }); },
  }],
});
await server.listen();
