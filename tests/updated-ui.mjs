// Run the integrated Paper browser checks against one immutable built frontend.
// Model component suites additionally use their isolated Vite harnesses.
// Each suite isolates API fixtures and browser state; this runner never contacts providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';

await fs.access(new URL('../web/dist/index.html', import.meta.url));
const port = await new Promise(resolve => {
  const socket = http.createServer().listen(0, '127.0.0.1', () => {
    const port = socket.address().port; socket.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', active;
preview.stdout.on('data', chunk => { log += chunk; }); preview.stderr.on('data', chunk => { log += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (preview.exitCode !== null) throw new Error(log);
    if (await fetch(origin).then(response => response.ok, () => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Built preview did not become ready: ${log}`);
  for (const file of ['updated-ui-core.mjs', 'work-paper-ui.mjs', 'knowledge-paper-ui.mjs', 'access-settings-ui.mjs', 'working-avatar-ui.mjs', 'new-chat-processing-ui.mjs', 'bird-avatars-ui.mjs', 'bot-details-ui.mjs', 'usage-mode-ui.mjs', 'model-selector-ui.mjs', 'chat-shell-ui.mjs', 'create-bot-ui.mjs', 'routines-ui.mjs', 'suggested-integrations-ui.mjs', 'qa-r3-chat-ui.mjs', 'qa-r3-work-ui.mjs', 'qa-r3-work-import-ui.mjs', 'qa-r3-settings-ui.mjs', 'search-viewer-ui.mjs']) {
    console.log(`Running ${file}`);
    const code = await new Promise((resolve, reject) => {
      active = spawn(process.execPath, [`tests/${file}`], { cwd: new URL('..', import.meta.url), env: { ...process.env, UI_ORIGIN: origin, WORK_ORIGIN: origin, ACCESS_UI_BASE: origin }, stdio: 'inherit' });
      active.on('error', reject); active.on('exit', resolve);
    });
    assert.equal(code, 0, `${file} failed`);
  }
} finally { active?.kill(); preview.kill(); }
