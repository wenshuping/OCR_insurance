import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('responsibility card visibility reads card-level selection status', () => {
  const source = readFileSync(new URL('../src/shared/policy-report-ui.tsx', import.meta.url), 'utf8');

  assert.match(source, /matched\?\.selectionStatus/u);
  assert.match(source, /\(card as CardSelectionStatusSource\)\.selectionStatus/u);
});
