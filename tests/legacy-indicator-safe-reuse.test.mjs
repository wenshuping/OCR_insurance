import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_EVIDENCE_PACKET_CHARS,
  buildMissingOnlyManifest,
  normalizeOfficialProduct,
  planLegacyReuse,
  reconstructExactReuseArtifact,
} from '../scripts/audit-legacy-indicator-safe-reuse.mjs';
import { fixtures, materializeFixture } from './fixtures/legacy-indicator-safe-reuse-fixtures.mjs';

for (const fixture of fixtures) {
  test(`safe reuse fixture: ${fixture.name}`, () => {
    const { official, legacy } = materializeFixture(fixture);
    const plan = planLegacyReuse({ officialProduct: official, legacy });
    for (const expected of fixture.expected) {
      assert.ok(
        plan.status === expected || plan.classifications.includes(expected) || plan.responsibilities.some((item) => item.classifications.includes(expected)),
        `${fixture.name} expected ${expected}; got ${JSON.stringify({ status: plan.status, classifications: plan.classifications, responsibilities: plan.responsibilities }, null, 2)}`,
      );
    }
    if (fixture.name === 'legal-multi-indicator') {
      assert.equal(plan.status, 'reuse');
      assert.equal(plan.estimatedModelCallsSaved, 1);
      assert.equal(plan.estimatedModelCalls, 0);
      assert.deepEqual(plan.legacyDiff.nestedIndicators.ids.sort(), ['i1', 'i2']);
      assert.deepEqual(plan.legacyDiff.indicatorRecords.ids.sort(), ['i1', 'i2']);
    }
  });
}

test('official inventory stays model-blind to poisoned legacy business values', () => {
  const { official, legacy } = materializeFixture(fixtures.find((fixture) => fixture.name === 'formula-field-lost'));
  legacy.indicators[0].payload.formulaText = '旧指标猜测值';
  legacy.indicators[0].payload.sourceExcerpt = '旧证据猜测值';
  const plan = planLegacyReuse({ officialProduct: official, legacy });
  const manifest = buildMissingOnlyManifest([plan]);
  const serialized = JSON.stringify(manifest);
  assert.match(serialized, /身故保险金官方条款证据/u);
  assert.doesNotMatch(serialized, /旧指标猜测值|旧证据猜测值/u);
  assert.doesNotMatch(serialized, /insurance_indicator_records|product_responsibility_cards|payload/u);
  assert.ok(manifest.entries[0].evidencePacket.serializedLength <= MAX_EVIDENCE_PACKET_CHARS);
  assert.equal(manifest.legacyBusinessValuesExcluded, true);
});

test('official sourceDigest is required when the official packet has a digest', () => {
  const { official, legacy } = materializeFixture(fixtures.find((fixture) => fixture.name === 'legal-multi-indicator'));
  for (const card of legacy.cards) delete card.payload.sourceDigest;
  for (const indicator of legacy.indicators) delete indicator.payload.sourceDigest;
  const plan = planLegacyReuse({ officialProduct: official, legacy });
  assert.equal(plan.status, 'needs_follow_up');
  assert.equal(plan.sourceIdentity.method, 'unproven');
  assert.ok(plan.classifications.includes('source_identity_unproven'));
});

test('official inventory defects block deterministic reuse and model packet creation', () => {
  const invalid = normalizeOfficialProduct({
    company: '测试保险公司',
    productName: '无完整库存',
    sourceUrl: 'https://official.example.test/terms/incomplete.pdf',
    responsibilities: [{ responsibilityId: 'r1', title: '身故保险金', sourceExcerpt: '' }],
  });
  const plan = planLegacyReuse({ officialProduct: invalid, legacy: { cards: [], indicators: [] } });
  assert.equal(plan.status, 'needs_follow_up');
  assert.ok(plan.classifications.includes('insufficient_official_inventory'));
  const manifest = buildMissingOnlyManifest([plan]);
  assert.equal(manifest.entries[0].evidencePacket, null);
  assert.equal(manifest.counts.blockedWithoutOfficialPacket, 1);
});

test('deterministic reconstruction requires canonicalizer, validator, importer dry-run, and clone readback', () => {
  const { official, legacy } = materializeFixture(fixtures.find((fixture) => fixture.name === 'legal-multi-indicator'));
  const plan = planLegacyReuse({ officialProduct: official, legacy });
  const blocked = reconstructExactReuseArtifact({ plan, officialProduct: official });
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.missingGates, [
    'canonicalizer',
    'validator',
    'actualTargetImporterDryRun',
    'cloneSemanticReadback',
  ]);
  const ready = reconstructExactReuseArtifact({
    plan,
    officialProduct: official,
    gateReceipts: {
      canonicalizer: { ok: true, issueCount: 0 },
      validator: { ok: true, issueCount: 0 },
      actualTargetImporterDryRun: { ok: true, issueCount: 0, validationIssueCount: 0 },
      cloneSemanticReadback: { ok: true, issueCount: 0, semanticMismatchCount: 0 },
    },
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.modelUsed, false);
  assert.equal(ready.artifact.responsibilities.length, 1);
  assert.equal(ready.artifact.audit.legacyDiffUsedOnlyForReuseEligibility, true);
});
