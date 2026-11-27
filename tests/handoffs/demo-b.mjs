import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (!process.env.HO_B_DEMO_CHILD) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1]], { stdio: 'inherit', env: { ...process.env, HO_B_DEMO_CHILD: '1' } });
    process.exit(child.status ?? 1);
}
const { serve } = await import('@hono/node-server');
const { fixture, spec, runLoop, loops, app, cleanup } = await import('./server-fixture.test.mts');
const out = path.resolve('.context/handoffs/demo-b');
fs.mkdirSync(out, { recursive: true });
let server;
try {
    const ready = new Promise(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, resolve); });
    const address = await ready, base = `http://127.0.0.1:${address.port}/api`, runs = [];
    for (const mode of ['converge', 'cap']) {
        const f = fixture();
        const response = await fetch(`${base}/loops`, { method: 'POST', headers: f.headers, body: JSON.stringify({ spec: spec(f), idempotencyKey: `demo-${mode}`, start: true }) });
        assert.equal(response.status, 201);
        const created = await response.json();
        await runLoop(f, created.id, mode);
        const detail = await (await fetch(`${base}/loops/${created.id}`, { headers: f.headers })).json();
        assert.equal(detail.status, mode === 'converge' ? 'succeeded' : 'capped');
        assert.equal(detail.iteration, 3);
        assert.equal(detail.steps.length, 6);
        assert.equal(detail.resultText, mode === 'converge' ? 'Done in 3 passes: all checks passed.' : 'Stopped after 3 passes (limit). 2 of 3 checks still fail.');
        const timeline = await (await fetch(`${base}/loops/${created.id}/events`, { headers: f.headers })).json();
        const record = { mode, status: detail.status, iteration: detail.iteration, resultText: detail.resultText, bestOutput: detail.bestOutput, steps: detail.steps, verdicts: detail.verdicts, events: timeline.events };
        fs.writeFileSync(path.join(out, `${mode}.json`), JSON.stringify(record, null, 2) + '\n');
        runs.push(record);
        console.log(`PASS ${mode}: ${detail.resultText}`);
        for (const event of timeline.events)
            console.log(`${event.seq} ${event.type} ${JSON.stringify(event.data)}`);
    }
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ passed: 2, failed: 0, provider: 'Scripted local coordination runtime; no provider calls', runs: runs.map(r => ({ mode: r.mode, status: r.status, passes: r.iteration, result: r.resultText, events: r.events.length })) }, null, 2) + '\n');
    console.log(`PASS 2/2 headless two Bot demonstrations. Output: ${out}`);
}
finally {
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    cleanup();
}
