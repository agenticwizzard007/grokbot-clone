import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { plural } from '../server/src/lib/plural.ts';

test('customer count labels use singular only for one', () => {
  for (const noun of ['user update', 'viewer', 'human conversation source revision']) {
    assert.equal(plural(0, noun), `0 ${noun}s`);
    assert.equal(plural(1, noun), `1 ${noun}`);
    assert.equal(plural(4, noun), `4 ${noun}s`);
  }
  assert.equal(plural(2, 'person', 'people'), '2 people');
});

test('UI and server-produced customer copy have no optional plural suffixes', () => {
  const paths = readdirSync('web/src', { recursive: true }).filter(p => /\.[jt]sx?$/.test(p)).map(p => `web/src/${p}`);
  paths.push('server/src/idle.ts', 'server/src/coordination/reports.ts');
  for (const path of paths) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node))
        assert.doesNotMatch(node.text, /\b\w+\(s\)(?=[ .,:!?'"`<]|$)/, path);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
