import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v5-canary10';
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readJsonl = (file) => fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);

test('v5 canary is selected, official-first, bounded, and non-materializing', () => {
  const selection = readJson('selection/selected-products.json');
  const summary = readJson('summary.json');
  const inventory = readJsonl('official-inventory.jsonl');
  const diff = readJsonl('legacy-diff.jsonl');
  const packets = readJsonl('bounded-packets.jsonl');
  const providers = readJsonl('provider-receipts.jsonl');
  const terminal = readJsonl('terminal.jsonl');

  assert.equal(selection.length, 10);
  assert.deepEqual(summary.categories, { accident: 1, annuity: 1, critical_illness: 3, life: 4, medical: 1 });
  assert.equal(summary.retrieval.sourceReady, 10);
  assert.equal(summary.officialResponsibilityCount, 40);
  assert.equal(summary.trueMissingResponsibilityCount, 0);
  assert.equal(summary.trueMissingIndicatorCount, 0);
  assert.equal(summary.lunaProductCalls, 0);
  assert.equal(summary.lunaResponsibilityCalls, 0);
  assert.equal(summary.wholeProductModelCallsSaved, 10);
  assert.equal(summary.sqlite.writes, 0);
  assert.equal(summary.importerDryRun.materializedProducts, 0);
  assert.equal(summary.importerDryRun.materializedCards, 0);
  assert.equal(summary.legacyPollutionLeakCount, 0);
  assert.equal(inventory.length, 40);
  assert.equal(packets.length, 10);
  assert.equal(new Set(packets.map((row) => row.productName)).size, 10);
  assert.equal(providers.reduce((sum, row) => sum + row.calls, 0), 0);
  assert.equal(terminal.filter((row) => row.terminal === 'model_retry').length, 10);

  const accident = inventory.filter((row) => row.productName.includes('交通工具意外伤害保险'));
  assert.equal(accident.length, 12);
  assert.ok(!inventory.some((row) => /等待期|责任免除|理赔/u.test(row.officialTitle)));
  assert.equal(diff.filter((row) => row.diffTypes?.includes('missing_responsibility')).length, 0);
  assert.equal(diff.filter((row) => row.diffTypes?.includes('missing_indicator')).length, 0);

  for (const row of inventory) {
    for (const range of row.officialRanges) {
      const pageMap = readJson(`page-map/${String(selection.find((p) => p.productName === row.productName).selectionIndex).padStart(2, '0')}/page-map.json`);
      const raw = fs.readFileSync(path.join(root, `page-map/${String(selection.find((p) => p.productName === row.productName).selectionIndex).padStart(2, '0')}/canonical-raw.txt`), 'utf8');
      assert.equal(raw.slice(range.absoluteStart, range.absoluteEnd), range.exactText);
      assert.equal(pageMap.sourceDigest, row.sourceDigest);
    }
  }

  const forbidden = ['legacy-poison-99-percent', '错误比例99%', '旧指标虚构公式=99%', 'legacy-fake-responsibility'];
  for (const file of ['official-inventory.jsonl', 'bounded-packets.jsonl', 'deterministic-reuse.jsonl', 'artifacts/candidate-artifacts.jsonl']) {
    const value = fs.readFileSync(path.join(root, file), 'utf8');
    for (const marker of forbidden) assert.equal(value.includes(marker), false, `${file} leaked ${marker}`);
  }
  assert.ok(fs.existsSync(path.join(root, 'SHA256SUMS')));
});
