import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isArtifactOutput } from '../../web/src/handoffs/presentation.ts';
import type { RunOutput, OutputPart } from '../../web/src/handoffs/api.ts';

const output = (parts: OutputPart[] = [], declaredBy = 'auto', status = 'final') => ({
  status, parts, provenance: { declaredBy },
}) as RunOutput;

test('D3 auto-saved replies and incidental source links are not artifacts', () => {
  assert.equal(isArtifactOutput(null), false);
  assert.equal(isArtifactOutput(undefined), false);
  assert.equal(isArtifactOutput(output()), false);
  assert.equal(isArtifactOutput(output([{ id: 'body', kind: 'text', name: 'body', chars: 5000, sha256: 'fixture' }])), false);
  for (const relation of ['source', 'reference'] as const) {
    assert.equal(isArtifactOutput(output([{ id: 'url', kind: 'link', url: 'https://example.test', title: 'See this', relation }])), false);
  }
});
test('D3 completed files, structured data, result links and declared documents retain cards', () => {
  const parts: OutputPart[] = [
    { id: 'file', kind: 'file', artifactId: 'artifact', filename: 'report.md', mime: 'text/markdown', size: 10, sha256: 'fixture' },
    { id: 'data', kind: 'data', name: 'Results', bytes: 10, sha256: 'fixture' },
    { id: 'url', kind: 'link', url: 'https://example.test/report', title: 'Report', relation: 'result' },
  ];
  for (const part of parts) {
    assert.equal(isArtifactOutput(output([part])), true);
    assert.equal(isArtifactOutput(output([part], 'auto', 'draft')), false);
    assert.equal(isArtifactOutput(output([part], 'auto', 'superseded')), false);
  }
  assert.equal(isArtifactOutput(output([], 'agent')), true);
});
