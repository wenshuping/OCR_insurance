import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SALES_CHAMPION_CUSTOMER_LABEL_DIMENSIONS,
  validateSalesChampionCustomerLabelApplicability,
} from '../server/sales-champion-customer-labels.mjs';
import { SALES_CHAMPION_SKILL_DEFINITIONS } from '../server/sales-champion-skill-registry.mjs';
import {
  SALES_CHAMPION_TRAINING_PACKS,
  SALES_CHAMPION_TRAINING_SOURCES,
  getSalesChampionTrainingPacks,
} from '../server/sales-champion-training-catalog.mjs';

test('customer label taxonomy keeps the complete 19-dimension design', () => {
  assert.equal(SALES_CHAMPION_CUSTOMER_LABEL_DIMENSIONS.length, 19);
  assert.deepEqual(SALES_CHAMPION_CUSTOMER_LABEL_DIMENSIONS, [
    'source', 'customer_status', 'family_stage', 'income_type', 'economic_capacity',
    'relationship_maturity', 'demand_maturity', 'purchase_intent', 'resistance',
    'decision_maturity', 'customer_journey', 'policy_relationship', 'service_status',
    'marketing_grade', 'service_priority', 'contact_permission',
    'communication_preference', 'current_concern', 'next_action',
  ]);
});

test('all runtime sales capabilities have valid customer label applicability', () => {
  assert.equal(Object.keys(SALES_CHAMPION_SKILL_DEFINITIONS).length, 15);
  for (const [key, definition] of Object.entries(SALES_CHAMPION_SKILL_DEFINITIONS)) {
    assert.equal(
      validateSalesChampionCustomerLabelApplicability(
        definition.labelApplicability,
        `${key}.labelApplicability`,
      ),
      true,
    );
  }
});

test('all active registered training skills have valid customer label applicability', () => {
  const activeSources = new Set(SALES_CHAMPION_TRAINING_SOURCES
    .filter((source) => source.status === 'active')
    .map((source) => source.id));
  const activePacks = SALES_CHAMPION_TRAINING_PACKS
    .filter((pack) => activeSources.has(pack.source));

  assert.equal(activePacks.length, 80);
  for (const pack of activePacks) {
    assert.equal(
      validateSalesChampionCustomerLabelApplicability(
        pack.labelApplicability,
        `${pack.key}.labelApplicability`,
      ),
      true,
    );
  }
});

test('orphan policy labels narrow the candidate but cannot confirm the skill alone', () => {
  const pack = SALES_CHAMPION_TRAINING_PACKS
    .find((entry) => entry.key === 'serve_orphan_policy_before_selling');
  assert.deepEqual(pack.labelApplicability.preferredLabels.source, ['SRC7', 'SRC8']);
  assert.deepEqual(pack.labelApplicability.notTriggeredBy.source, ['SRC7', 'SRC8']);
  assert.deepEqual(pack.boundary.requiredSlots, ['customer_relationship_origin']);
});

test('income and economic labels do not independently trigger payment or high-value skills', () => {
  const payment = SALES_CHAMPION_TRAINING_PACKS
    .find((entry) => entry.key === 'clarify_long_payment_commitment');
  const highValue = SALES_CHAMPION_TRAINING_PACKS
    .find((entry) => entry.key === 'interview_high_value_client_journey');

  assert.deepEqual(payment.labelApplicability.requiredLabels.current_concern, ['缴费持续性顾虑']);
  assert.deepEqual(payment.labelApplicability.notTriggeredBy.economic_capacity, ['E1', 'E2', 'E3', 'E4', 'E5']);
  assert.deepEqual(highValue.labelApplicability.notTriggeredBy.economic_capacity, ['E3', 'E4', 'E5']);
  assert.ok(highValue.labelApplicability.notTriggeredBy.income_type.includes('固定工资'));
});

test('selected training skills expose label applicability to the executor', () => {
  const [pack] = getSalesChampionTrainingPacks(['tradeoff_disclosure'], {
    stage: 'objection',
    concerns: ['duration'],
    situations: ['long_payment_commitment'],
  });

  assert.equal(pack.key, 'clarify_long_payment_commitment');
  assert.deepEqual(pack.labelApplicability.requiredLabels.current_concern, ['缴费持续性顾虑']);
});

test('label validation rejects unknown and contradictory mappings', () => {
  assert.throws(() => validateSalesChampionCustomerLabelApplicability({
    readsLabels: ['purchase_intent'],
    requiredLabels: { purchase_intent: ['I3'] },
    preferredLabels: {},
    probeLabels: {},
    excludedLabels: { purchase_intent: ['I3'] },
    notTriggeredBy: {},
  }), /requires and excludes/u);

  assert.throws(() => validateSalesChampionCustomerLabelApplicability({
    readsLabels: ['purchase_intent'],
    requiredLabels: {},
    preferredLabels: { purchase_intent: ['I9'] },
    probeLabels: {},
    excludedLabels: {},
    notTriggeredBy: {},
  }), /unregistered label/u);
});
