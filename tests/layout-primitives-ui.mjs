import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';
import { readableWords } from './paper-label-geometry.mjs';
import { inspectAlignment } from './layout-alignment-ui.mjs';
const out = path.resolve('.context/layout-alignment'); fs.mkdirSync(out, { recursive: true });
const evidence = path.resolve('docs/design/paper/build/pb-c'); fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(out, 'harness.html'), `<div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; await import('./harness.tsx');</script>`);
fs.writeFileSync(path.join(out, 'harness.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Page, Section, Card, Row, ButtonGroup } from '${path.resolve('web/src/components/layout/index.tsx')}';
import '${path.resolve('web/src/styles/tokens.css')}';
import '${path.resolve('web/src/styles/base.css')}';
const theme = new URLSearchParams(location.search).get('theme'); document.documentElement.dataset.theme = theme;
createRoot(document.getElementById('root')).render(<Page type="form" title="Layout primitives" helper="Shared spacing and aligned controls.">
<Section title="Connections"><Card variant="list"><Row title="Provider connection" subtitle="Not connected" trailing={<button>Connect</button>} /><Row title="Default model" trailing={<button>Change</button>} /></Card><Card><Row title="A complete label that wraps at spaces" trailing={<button>Manage</button>} /></Card></Section>
<Section title="Actions"><ButtonGroup><button>Cancel</button><button>Save changes</button></ButtonGroup><ButtonGroup stack><button>First action</button><button>Second action</button></ButtonGroup></Section>
</Page>);
`);
const server = await layoutServer();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of [320, 390, 500, 768, 1280]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on('pageerror', error => console.error(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.goto(`${server.base}/@fs${out}/harness.html?theme=${theme}`);
    await page.locator('[data-layout="card"]').first().waitFor();
    assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '#root' }), [], `${width} ${theme}`);
    await readableWords(page.locator('[data-layout="page"]'));
    const geometry = await page.locator('[data-layout="card"]').first().evaluate(el => { const s = getComputedStyle(el); return { radius: s.borderRadius, padding: s.padding, border: s.borderTopWidth }; });
    assert.deepEqual(geometry, { radius: '12px', padding: '0px 16px', border: '1px' });
    assert.equal(await page.locator('[data-layout="page"]').evaluate(el => getComputedStyle(el).paddingLeft), width <= 760 ? '16px' : '32px');
    if ([320, 390, 1280].includes(width)) await page.screenshot({ path: path.join(evidence, `layout-${width}-${theme}.png`) });
    // Prove the audit rejects unequal buttons, off-center padding and short rows.
    await page.addStyleTag({ content: '[data-layout="button-group"] > :first-child { flex: none; width: 40px; } [data-layout="page"] { padding-left: 3px; } [data-layout="row"] { min-height: 10px; height: 10px; padding: 0; }' });
    const broken = await page.evaluate(inspectAlignment, { selector: '#root' });
    assert.ok(broken.some(issue => issue.includes('Unequal ButtonGroup')));
    assert.ok(broken.some(issue => issue.includes('Unequal Page padding')));
    assert.ok(broken.some(issue => issue.includes('Below 44px')));
    await page.close(); console.log(`PASS primitives ${width} ${theme}`);
  }
} finally { await browser.close(); await server.close(); }
