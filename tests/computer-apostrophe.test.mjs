import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// L-08 / QA R2: include messaging copy and old test expectations in the scan.
test('Bot computer, screen and browser phrases use ASCII apostrophes', () => {
  for (const root of ['web/src', 'server/src/messaging', 'tests']) {
    for (const file of readdirSync(root, { recursive: true })) {
      if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) continue;
      const filename = path.join(root, file);
      assert.doesNotMatch(readFileSync(filename, 'utf8'), /\bBots?\u2019s?\s+(?:computer|screen|browser)\b/, filename);
    }
  }
  const settings = readFileSync('web/src/components/config/AppSettings.tsx', 'utf8');
  assert.ok(settings.includes('Cloud computer'), 'Cloud computer label is plain and complete');
  assert.ok(settings.includes('Computer'), 'Computer controls stay reachable');
  assert.ok(readFileSync('web/src/components/config/MessagingSettings.tsx', 'utf8').includes("Your Bots' computer"), 'Messaging command label uses ASCII');
});
