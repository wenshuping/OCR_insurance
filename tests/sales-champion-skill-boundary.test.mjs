import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSalesChampionSkillBoundary,
  validateSalesChampionActionSignature,
  validateSalesChampionSkillBoundary,
} from '../server/sales-champion-skill-boundary.mjs';
import {
  SALES_CHAMPION_SKILL_DEFINITIONS,
} from '../server/sales-champion-skill-registry.mjs';
import {
  SALES_CHAMPION_TRAINING_PACKS,
  SALES_CHAMPION_TRAINING_SOURCES,
  validateSalesChampionTrainingCatalog,
} from '../server/sales-champion-training-catalog.mjs';
import {
  SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS,
} from '../server/sales-champion-external-skill-mappings.mjs';

test('every runtime sales skill declares a registered action and boundary', () => {
  for (const [key, definition] of Object.entries(SALES_CHAMPION_SKILL_DEFINITIONS)) {
    assert.equal(validateSalesChampionActionSignature(definition.actionSignature, key), true);
    assert.equal(validateSalesChampionSkillBoundary(definition.boundary, key), true);
    assert.equal(definition.boundary.excludedSignals.includes('explicit_refusal'), true);
    assert.equal(definition.boundary.excludedSignals.includes('stop_contact'), true);
  }
});

test('every active training skill declares a boundary aligned with its routing situations', () => {
  const activeSources = new Set(SALES_CHAMPION_TRAINING_SOURCES
    .filter((source) => source.status === 'active')
    .map((source) => source.id));
  const activePacks = SALES_CHAMPION_TRAINING_PACKS
    .filter((pack) => activeSources.has(pack.source));

  assert.equal(activePacks.length, 80);
  for (const pack of activePacks) {
    assert.equal(validateSalesChampionActionSignature(pack.actionSignature, pack.key), true);
    assert.equal(validateSalesChampionSkillBoundary(pack.boundary, pack.key), true);
    assert.deepEqual([...pack.boundary.confirmedSituations], [...pack.situations]);
  }
});

test('every production atomic sales skill has exactly one runtime mapping', () => {
  const expectedCounts = {
    chengjiye: 12,
    wenxian: 18,
    yeyunyan: 11,
    yirong: 10,
    daxiang: 6,
  };
  const counts = Object.fromEntries(Object.keys(expectedCounts).map((prefix) => [prefix, 0]));
  const sourceSkills = new Set();

  for (const mapping of SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS) {
    assert.equal(sourceSkills.has(mapping.sourceSkill), false, mapping.sourceSkill);
    sourceSkills.add(mapping.sourceSkill);
    const prefix = mapping.source.includes('cheng-jiye') ? 'chengjiye'
      : mapping.source.includes('wenxian') ? 'wenxian'
        : mapping.source.includes('ye-yunyan') ? 'yeyunyan'
          : mapping.source.includes('yi-rong') ? 'yirong' : 'daxiang';
    counts[prefix] += 1;
  }

  assert.deepEqual(counts, expectedCounts);
  assert.equal(sourceSkills.size, 57);
});

test('every active training mapping remains reachable through at least one runtime capability', () => {
  const activeSources = new Set(SALES_CHAMPION_TRAINING_SOURCES
    .filter((source) => source.status === 'active')
    .map((source) => source.id));
  const activePacks = SALES_CHAMPION_TRAINING_PACKS
    .filter((pack) => activeSources.has(pack.source));

  for (const pack of activePacks) {
    for (const stage of pack.stages) {
      for (const concern of pack.concerns) {
        const reachable = pack.capabilities.some((capability) => {
          const definition = SALES_CHAMPION_SKILL_DEFINITIONS[capability];
          return definition?.stages.includes(stage)
            && (!definition.concerns.length || definition.concerns.includes(concern));
        });
        assert.equal(reachable, true, `${pack.key} is unreachable for ${stage}:${concern}`);
      }
    }
  }
});

test('orphan-policy skill separates confirmed routing, boundary probe, and unknown fallback', () => {
  const pack = SALES_CHAMPION_TRAINING_PACKS
    .find((candidate) => candidate.key === 'serve_orphan_policy_before_selling');

  assert.deepEqual([...pack.boundary.confirmedSituations], ['orphan_policy']);
  assert.deepEqual([...pack.boundary.requiredSlots], ['customer_relationship_origin']);
  assert.equal(pack.boundary.probeSlots.includes('customer_relationship_origin'), true);
  assert.equal(pack.boundary.helpfulSlots.includes('explicit_customer_request'), true);
  assert.equal(pack.boundary.unknownFallback, 'generic_service_first');
  assert.equal(pack.actionSignature, 'service_first');
});

test('boundary registry rejects undeclared slots and action signatures', () => {
  assert.throws(() => createSalesChampionSkillBoundary({
    groups: ['customer_relationship'],
    probeSlots: ['made_up_customer_field'],
  }), /unregistered value/u);
  assert.throws(
    () => validateSalesChampionActionSignature('force_close'),
    /unregistered/u,
  );
});

test('training catalog rejects an active skill whose boundary is missing', () => {
  const orphanIndex = SALES_CHAMPION_TRAINING_PACKS
    .findIndex((pack) => pack.key === 'serve_orphan_policy_before_selling');
  const packs = SALES_CHAMPION_TRAINING_PACKS.map((pack, index) => (
    index === orphanIndex ? { ...pack, boundary: null } : pack
  ));

  assert.throws(
    () => validateSalesChampionTrainingCatalog({
      sources: SALES_CHAMPION_TRAINING_SOURCES,
      packs,
    }),
    /serve_orphan_policy_before_selling\.boundary must be an object/u,
  );
});
