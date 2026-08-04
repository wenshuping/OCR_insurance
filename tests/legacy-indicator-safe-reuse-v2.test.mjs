import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCT_CLASSIFICATIONS,
  buildOfficialModelBlindPacketsV2,
  buildMissingOnlyManifestV2,
  planLegacyReuseV2,
  reconstructExactReuseArtifactV2,
} from '../scripts/audit-legacy-indicator-safe-reuse-v2.mjs';
import { materializeV2Fixture, v2Fixtures } from './fixtures/legacy-indicator-safe-reuse-v2-fixtures.mjs';

for (const fixture of v2Fixtures) {
  test(`safe reuse v2 fixture: ${fixture.name}`, () => {
    const { official, legacy } = materializeV2Fixture(fixture);
    const plan = planLegacyReuseV2({ officialProduct: official, legacy });
    assert.equal(plan.status, fixture.expected.status);
    if (fixture.expected.missingIndicatorCount !== undefined) assert.equal(plan.counts.missingIndicatorCount, fixture.expected.missingIndicatorCount);
    if (fixture.expected.incompleteIndicatorCount !== undefined) assert.equal(plan.counts.incompleteIndicatorCount, fixture.expected.incompleteIndicatorCount);
    assert.ok(PRODUCT_CLASSIFICATIONS.includes(plan.status));
    assert.equal(plan.mutuallyExclusive, true);
  });
}

test('v2 missing-only packet is official-only and bounded', () => {
  const fixture = v2Fixtures[0];
  const { official, legacy } = materializeV2Fixture(fixture);
  legacy.indicators[0] = undefined;
  const plan = planLegacyReuseV2({ officialProduct: official, legacy: { cards: legacy.cards, indicators: [] } });
  const manifest = buildMissingOnlyManifestV2([plan]);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].classifications[0], 'missing_indicator');
  assert.ok(manifest.entries[0].evidencePacket.serializedLength <= 12000);
  assert.doesNotMatch(JSON.stringify(manifest), /legacy猜测|insurance_indicator_records|product_responsibility_cards/u);
});

test('v2 exact reconstruction still requires all deterministic gates', () => {
  const fixture = v2Fixtures.find((item) => item.name === 'two-truly-independent-indicators-are-valid');
  const { official, legacy } = materializeV2Fixture(fixture);
  const plan = planLegacyReuseV2({ officialProduct: official, legacy });
  assert.equal(reconstructExactReuseArtifactV2({ plan, officialProduct: official }).status, 'blocked');
  const ready = reconstructExactReuseArtifactV2({
    plan,
    officialProduct: official,
    gateReceipts: Object.fromEntries(['canonicalizer', 'validator', 'actualTargetImporterDryRun', 'cloneSemanticReadback'].map((name) => [name, { ok: true, issueCount: 0, validationIssueCount: 0, semanticMismatchCount: 0 }])),
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.modelUsed, false);
  assert.equal(ready.artifact.responsibilities[0].indicators.length, 2);
});

test('v2 missing responsibility is not inferred from missing indicator fields', () => {
  const fixture = v2Fixtures[0];
  const { official } = materializeV2Fixture(fixture);
  const plan = planLegacyReuseV2({ officialProduct: official, legacy: { cards: [], indicators: [] } });
  assert.equal(plan.status, 'missing_responsibility');
  assert.equal(plan.counts.missingResponsibilityCount, 1);
  assert.equal(plan.counts.missingIndicatorCount, 1);
});

test('v2 one-sided projection is incomplete, never missing', () => {
  const fixture = v2Fixtures.find((item) => item.name === 'two-truly-independent-indicators-are-valid');
  const { official, legacy } = materializeV2Fixture(fixture);
  const plan = planLegacyReuseV2({ officialProduct: official, legacy: { cards: legacy.cards, indicators: [] } });
  assert.equal(plan.status, 'indicator_incomplete');
  assert.equal(plan.counts.missingIndicatorCount, 0);
  assert.ok(plan.counts.incompleteIndicatorCount > 0);
});

test('v2 differing non-empty digest is isolated as version conflict', () => {
  const fixture = v2Fixtures.find((item) => item.name === 'two-truly-independent-indicators-are-valid');
  const { official, legacy } = materializeV2Fixture(fixture);
  legacy.indicators[0].payload.sourceDigest = `sha256:${'b'.repeat(64)}`;
  const plan = planLegacyReuseV2({ officialProduct: official, legacy });
  assert.equal(plan.status, 'version_conflict');
  assert.equal(plan.sourceIdentity.conflict, true);
  assert.equal(plan.modelAllowed, false);
});

test('v2 exact structure reuses IDs and saves one whole-product model call', () => {
  const fixture = v2Fixtures.find((item) => item.name === 'two-truly-independent-indicators-are-valid');
  const { official, legacy } = materializeV2Fixture(fixture);
  const plan = planLegacyReuseV2({ officialProduct: official, legacy });
  assert.equal(plan.status, 'exact_complete');
  assert.equal(plan.reuseCapabilities.fullArtifactReusable, true);
  assert.equal(plan.modelRouting.route, 'none');
  assert.equal(plan.estimatedModelCallsSaved, 1);
  assert.equal(plan.modelRouting.estimatedWholeProductModelCallsSaved, 1);
  assert.deepEqual(plan.reuseCapabilities.reusableCardIds, ['card-r1']);
  assert.deepEqual(plan.reuseCapabilities.reusableIndicatorIds.sort(), ['i1', 'i2']);
});

test('v2 formula or evidence mismatch emits only bounded official packet', () => {
  const fixture = v2Fixtures.find((item) => item.name === 'indicator-present-evidence-fields-missing');
  const { official, legacy } = materializeV2Fixture(fixture);
  legacy.indicators[0].payload.formulaText = 'legacy wrong ratio 99%';
  legacy.cards[0].payload.indicators[0].formulaText = 'legacy wrong ratio 99%';
  const plan = planLegacyReuseV2({ officialProduct: official, legacy });
  assert.equal(plan.reuseCapabilities.structureReusable, true);
  assert.equal(plan.modelRouting.route, 'bounded_fields');
  assert.equal(plan.modelRouting.fullProductRerun, false);
  assert.equal(plan.evidencePackets.length, 1);
  assert.equal(plan.modelRouting.estimatedWholeProductModelCallsSaved, 1);
  assert.equal(plan.modelRouting.estimatedBoundedModelCalls, 1);
});

test('v2 legacy pollution is absent from official packet and missing-only manifest but present in diff', () => {
  const fixture = v2Fixtures.find((item) => item.name === 'legacy-pollution-stays-in-diff-only');
  const { official, legacy } = materializeV2Fixture(fixture);
  const officialStage = buildOfficialModelBlindPacketsV2({ officialProduct: official });
  const plan = planLegacyReuseV2({ officialProduct: official, legacy });
  const manifest = buildMissingOnlyManifestV2([plan]);
  const modelOnly = JSON.stringify({ packets: officialStage.packets, manifest });
  const legacyDiff = JSON.stringify(plan.legacyDiff);
  for (const poison of fixture.expected.poison) {
    assert.doesNotMatch(modelOnly, new RegExp(poison.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(legacyDiff, new RegExp(poison.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});
