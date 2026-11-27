import fs from 'node:fs';
// UC-P removes resolved entries. No route-wide exemptions or forbidden-text waivers.
export const knownIssues = JSON.parse(fs.readFileSync(new URL('./uc-p-known-issues.json', import.meta.url), 'utf8'));
export function compareKnownIssues(key, issues, inventory = knownIssues, strict = process.env.UC_REQUIRE_FULL === '1') {
  const expected = (inventory.views[key] || []).map(issue => {
    if (typeof issue !== 'string') return issue;
    const finding = inventory.findings?.[issue];
    if (!finding) throw new Error(`Unknown UC-P finding: ${issue}`);
    return finding;
  });
  const encode = value => JSON.stringify(value);
  const remaining = expected.map(encode), unexpected = [];
  for (const issue of issues) {
    const index = remaining.indexOf(encode(issue));
    if (strict || issue.rule === 'forbidden-visible-text' || index < 0) unexpected.push(issue);
    else remaining.splice(index, 1);
  }
  return { unexpected, stale: strict ? [] : remaining.map(JSON.parse), known: issues.length - unexpected.length };
}
