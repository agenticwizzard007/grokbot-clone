import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { polishFixture, screens } from './polish-fixture.mjs';

// Kept outside the shared route table: these states need the recorded handoff
// and loop responses, while the existing routes use the ordinary layout seed.
export const HO_ROUTES = screens;
export async function auditHandoffRoutes(inspectAlignment) {
  const fixture = await polishFixture(), report = [];
  try {
    for (const width of [320,390,500,1280]) for (const theme of ['light','dark']) for (const name of HO_ROUTES) {
      const state = await fixture.open(name,width,theme);
      try {
        const issues = await state.page.evaluate(inspectAlignment, { selector: state.selector, requirePage: !name.startsWith('receipt') && !name.startsWith('settings-agents') && !['message-actions','output-card','output-linked','sidebar-loops','flow-tab','flow-compact','flow-suggestions','flow-long','flow-empty','flow-error','flow-loading'].includes(name) });
        report.push({name,width,theme,issues}); console.log(`${issues.length ? 'FAIL' : 'PASS'} HO-P ${name} ${width} ${theme}: ${issues.length} issues`);
      } finally { await state.close(); }
    }
  } finally { await fixture.close(); const out = path.resolve('.context/ho-p/alignment.json'); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out, JSON.stringify(report,null,2)); }
  assert.equal(report.filter(x=>x.issues.length).length,0,'Handoff routes follow Paper layout');
  console.log(`HO-P ALIGNMENT ${report.length} route views audited, 0 issues`);
}
