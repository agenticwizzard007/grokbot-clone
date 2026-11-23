// P-12: measure the emitted static entry graph, not source size or live download time.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

export const dist = new URL('../web/dist/', import.meta.url);
export const manifest = JSON.parse(await fs.readFile(new URL('.vite/manifest.json', dist), 'utf8'));

export function staticAssets(root) {
  const visited = new Set(), assets = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    assert.ok(chunk, `Manifest contains ${key}`);
    assets.add(chunk.file);
    chunk.css?.forEach(file => assets.add(file));
    chunk.imports?.forEach(visit);
  }
  visit(root);
  return assets;
}

export const entryAssets = staticAssets('index.html');
// Include every asset linked by HTML as well as transitive static imports and CSS.
// Images, fonts and dynamic imports are excluded, matching the original audit scope.
const html = await fs.readFile(new URL('index.html', dist), 'utf8');
for (const match of html.matchAll(/(?:src|href)="\/([^"?#]+\.(?:js|css))"/g)) {
  entryAssets.add(match[1]);
  const key = Object.keys(manifest).find(key => manifest[key].file === match[1]);
  if (key) for (const asset of staticAssets(key)) entryAssets.add(asset);
}

export const deferredEntries = [
  'src/AuthenticatedShell.tsx', 'src/components/ChatView.tsx',
  'src/components/DetailsPanel.tsx', 'src/components/config/TasksView.tsx',
];

for (const key of deferredEntries) {
  assert.ok(manifest[key]?.isDynamicEntry, `${key} remains a lazy entry`);
  assert.ok(!entryAssets.has(manifest[key].file), `${key} stays outside the authentication graph`);
}
const shellAssets = staticAssets(deferredEntries[0]);
for (const key of deferredEntries.slice(1)) {
  assert.ok(!shellAssets.has(manifest[key].file), `${key} is requested when its panel renders`);
}

assert.ok(!staticAssets(deferredEntries[2]).has(manifest[deferredEntries[3]].file), 'Details task summaries do not load the work workspace');

const budgets = {
  js: { requests: 12, bytes: 230_000, gzip: 78_000 },
  css: { requests: 4, bytes: 36_000, gzip: 9_500 },
};
export const entryMeasurements = {};
for (const [extension, budget] of Object.entries(budgets)) {
  const files = [...entryAssets].filter(file => file.endsWith(`.${extension}`));
  const contents = await Promise.all(files.map(file => fs.readFile(new URL(file, dist))));
  const measured = {
    requests: files.length,
    bytes: contents.reduce((total, content) => total + content.length, 0),
    gzip: contents.reduce((total, content) => total + gzipSync(content).length, 0),
  };
  assert.ok(measured.requests > 0, `${extension} assets are measured`);
  for (const [metric, limit] of Object.entries(budget)) {
    assert.ok(measured[metric] <= limit, `Entry ${extension} ${metric}: ${measured[metric]} exceeds ${limit}`);
  }
  entryMeasurements[extension] = measured;
}
console.log('PASS P-12 entry asset budgets:', JSON.stringify(entryMeasurements));
