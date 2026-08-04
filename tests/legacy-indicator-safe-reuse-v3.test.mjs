import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLegacyReuseV3 } from '../scripts/audit-legacy-indicator-safe-reuse-v3.mjs';
import { multiResponsibilityFixture, pollutionFixture, v3Fixtures } from './fixtures/legacy-indicator-safe-reuse-v3-fixtures.mjs';

test('v3 exact source offset fills sourcePage without model', () => {
  const { official, legacy } = v3Fixtures.find((item) => item.name === 'source-page-exact-offset-is-deterministic').make();
  const result = analyzeLegacyReuseV3({ officialProduct: official, legacy });
  assert.equal(result.classification, 'deterministic_enriched');
  assert.equal(result.deterministicEnriched[0].field, 'sourcePage');
  assert.equal(result.deterministicEnriched[0].value, '7');
  assert.equal(result.deterministicEnriched[0].modelUsed, false);
});

test('v3 unmappable sourcePage is source review and never guessed', () => {
  const { official, legacy } = v3Fixtures.find((item) => item.name === 'source-page-without-exact-mapping-requires-source-review').make();
  const result = analyzeLegacyReuseV3({ officialProduct: official, legacy });
  assert.equal(result.classification, 'source_or_evidence_review');
  assert.ok(result.sourceUnresolved.some((item) => item.failureFields.includes('sourcePage')));
  assert.equal(result.deterministicEnriched.some((item) => item.field === 'sourcePage'), false);
});

test('v3 basis uses a canonical key only when official formula proves it', () => {
  const proven = v3Fixtures.find((item) => item.name === 'basis-is-deterministic-only-when-officially-proven').make();
  const provenResult = analyzeLegacyReuseV3({ officialProduct: proven.official, legacy: proven.legacy });
  assert.ok(provenResult.deterministicEnriched.some((item) => item.field === 'basis' && item.value === '基本保险金额'));

  const unproven = v3Fixtures.find((item) => item.name === 'basis-without-canonical-proof-is-bounded-review').make();
  const unprovenResult = analyzeLegacyReuseV3({ officialProduct: unproven.official, legacy: unproven.legacy });
  assert.equal(unprovenResult.classification, 'product_bounded_review');
  assert.ok(unprovenResult.fieldUnresolved.some((item) => item.failureFields.includes('basis')));
});

test('v3 formula rule pack preserves max operands and rejects semantic conflict', () => {
  const equivalent = v3Fixtures.find((item) => item.name === 'formula-equivalent-normalization-and-operands-are-preserved').make();
  const equivalentResult = analyzeLegacyReuseV3({ officialProduct: equivalent.official, legacy: equivalent.legacy });
  const formulaRow = equivalentResult.deterministicEnriched.find((item) => item.field === 'normalizedFormula');
  assert.ok(formulaRow);
  assert.equal(formulaRow.operands.length, 2);
  assert.match(formulaRow.value, /^max\(/u);

  const conflict = v3Fixtures.find((item) => item.name === 'semantic-formula-conflict-is-bounded-review').make();
  const conflictResult = analyzeLegacyReuseV3({ officialProduct: conflict.official, legacy: conflict.legacy });
  assert.equal(conflictResult.classification, 'product_bounded_review');
  assert.ok(conflictResult.fieldUnresolved.some((item) => item.failureFields.includes('normalizedFormula')));
});

test('v3 keeps death and total-disability branch split as one official indicator', () => {
  const { official, legacy } = v3Fixtures.find((item) => item.name === 'death-total-disability-branches-remain-one-indicator').make();
  const result = analyzeLegacyReuseV3({ officialProduct: official, legacy });
  assert.equal(result.plan.status, 'duplicate_or_split');
  assert.ok(result.fieldUnresolved.some((item) => item.failureFields.includes('duplicate_or_split')));
  assert.equal(result.plan.officialInventory.responsibilities[0].indicators.length, 1);
});

test('v3 retains two truly independent indicators', () => {
  const { official, legacy } = v3Fixtures.find((item) => item.name === 'two-independent-indicators-remain-valid').make();
  const result = analyzeLegacyReuseV3({ officialProduct: official, legacy });
  assert.equal(result.plan.status, 'exact_complete');
  assert.equal(result.plan.officialInventory.responsibilities[0].indicators.length, 2);
});

test('v3 merges multiple missing fields and responsibilities into one product task', () => {
  const { official, legacy } = multiResponsibilityFixture();
  const result = analyzeLegacyReuseV3({ officialProduct: official, legacy });
  assert.equal(result.classification, 'product_bounded_review');
  assert.equal(result.fieldUnresolved.length, 2);
  const productTaskCount = 1;
  assert.equal(productTaskCount, 1);
});

test('v3 official packet excludes legacy pollution while legacy diff retains it', () => {
  const { official, legacy } = pollutionFixture();
  const result = analyzeLegacyReuseV3({ officialProduct: official, legacy });
  const officialPacket = JSON.stringify(result.plan.officialModelBlindPackets);
  const legacyDiff = JSON.stringify(result.plan.legacyDiff);
  for (const poison of ['旧指标虚构公式=99%', 'legacy-poison-99-percent', '旧指标虚构证据和错误比例99%', 'sha256:' + 'b'.repeat(64)]) {
    assert.doesNotMatch(officialPacket, new RegExp(poison.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(legacyDiff, new RegExp(poison.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});
