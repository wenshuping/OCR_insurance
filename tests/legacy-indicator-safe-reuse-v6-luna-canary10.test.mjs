import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v6-luna-canary10';
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readJsonl = (file) => fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);

test('v6 completes one direct Luna task per product with official-only evidence and formal dry-run gates', () => {
  const summary = readJson('summary.json');
  const terminals = readJsonl('terminal-results.jsonl');
  const approved = readJsonl('approved.jsonl');
  const sourceReview = readJsonl('source-review.jsonl');
  assert.equal(summary.selected, 10);
  assert.equal(summary.processed, 10);
  assert.equal(summary.actualLunaCalls, 10);
  assert.equal(summary.officialResponsibilityCount, 40);
  assert.equal(summary.retainedResponsibilityCount, 40);
  assert.equal(summary.removedIncorrectLegacyResponsibilities, 1);
  assert.equal(summary.newlyOmittedResponsibilities, 0);
  assert.deepEqual(summary.terminal, { source_review: 1, approved: 9 });
  assert.equal(summary.validatorPassProducts, 10);
  assert.equal(summary.importerDryRunPassProducts, 10);
  assert.equal(summary.materializedProducts, 0);
  assert.equal(summary.legacyPollutionLeakCount, 0);
  assert.equal(summary.sqlite.writes, 0);
  assert.equal(approved.length, 9);
  assert.equal(sourceReview.length, 1);

  for (const terminal of terminals) {
    const dir = path.join(root, 'products', String(terminal.selectionIndex).padStart(2, '0'));
    const receipt = readJson(path.join('products', String(terminal.selectionIndex).padStart(2, '0'), 'provider-receipt.json'));
    const validator = readJson(path.join('products', String(terminal.selectionIndex).padStart(2, '0'), 'validator.json'));
    const importer = readJson(path.join('products', String(terminal.selectionIndex).padStart(2, '0'), 'importer-dry-run.json'));
    assert.equal(receipt.provider, 'codex');
    assert.equal(receipt.modelId, 'gpt-5.6-luna');
    assert.equal(receipt.executionMode, 'direct_codex_thread');
    assert.equal(receipt.callCount, 1);
    assert.equal(receipt.repairRounds, 0);
    assert.equal(validator.ok, true);
    assert.equal(importer.result.materializedProducts, 0);
    assert.equal(importer.result.materializedCards, 0);
    assert.equal(importer.result.acceptedResponsibilities, terminal.officialResponsibilityCount);
    assert.equal(fs.existsSync(path.join(dir, 'result.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'artifact.json')), true);
    const modelInput = fs.readFileSync(path.join(dir, 'model-input.json'), 'utf8');
    assert.equal(modelInput.includes('legacyRecordId'), false);
    assert.equal(modelInput.includes('legacy-poison-99-percent'), false);
    assert.equal(modelInput.includes('错误比例99%'), false);
  }
  assert.ok(summary.estimatedInputCharactersSaved > 0);
  assert.ok(summary.estimatedInputTokensSaved > 0);
  assert.equal(fs.existsSync(path.join(root, 'SHA256SUMS')), true);
});
