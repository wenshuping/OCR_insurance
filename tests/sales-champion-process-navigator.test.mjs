import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSalesChampionProcessNavigation } from '../server/sales-champion-process-navigator.service.mjs';

function proposal(overrides = {}) {
  return {
    customerStatements: [{ text: '客户说十年交费太长', source: 'current_message' }],
    kycFacts: [{
      key: 'occupation', value: '公务员', source: 'advisor_fact', evidence: '客户是公务员',
    }],
    customerLabels: [{
      dimension: 'current_concern', value: '缴费持续性顾虑', status: 'confirmed',
      source: 'customer_statement', evidence: '客户说十年交费太长', confidence: 0.96,
    }],
    stage: { value: 'objection', confidence: 0.95 },
    situations: ['long_payment_commitment'],
    missingInformation: ['objection_reason'],
    insuranceNeeds: [],
    ...overrides,
  };
}

test('process navigator recognizes KYC labels and keeps a narrow objection out of orphan questions', () => {
  const navigation = buildSalesChampionProcessNavigation({
    proposal: proposal(),
    selection: { primary: { key: 'tradeoff_disclosure' }, supporting: [] },
    boundaryCandidates: [],
  });

  assert.equal(navigation.processLane, 'decision');
  assert.equal(navigation.confirmedLabels[0].value, '缴费持续性顾虑');
  assert.deepEqual(navigation.questionPlan.map((item) => item.slot), ['objection_reason']);
  assert.ok(!navigation.questionPlan.some((item) => item.slot === 'customer_relationship_origin'));
});

test('process navigator asks one shared relationship question for a possible orphan policy', () => {
  const navigation = buildSalesChampionProcessNavigation({
    proposal: proposal({
      customerStatements: [{ text: '这是一个老保单客户，我第一次接触', source: 'current_message' }],
      kycFacts: [],
      customerLabels: [],
      stage: { value: 'post_sale', confidence: 0.9 },
      situations: [],
      missingInformation: ['customer_relationship_origin'],
    }),
    selection: { primary: { key: 'needs_discovery' }, supporting: [] },
    boundaryCandidates: [{
      key: 'serve_orphan_policy_before_selling',
      confirmationSlots: ['customer_relationship_origin'],
      unknownFallback: 'generic_service_first',
    }],
  });

  assert.equal(navigation.processLane, 'retention');
  assert.deepEqual(navigation.candidateSkills, [
    'needs_discovery',
    'serve_orphan_policy_before_selling',
  ]);
  assert.equal(navigation.questionPlan.length, 1);
  assert.equal(navigation.unknownFallback, 'generic_service_first');
});

test('process navigator does not repeat KYC facts or information the advisor cannot provide', () => {
  const navigation = buildSalesChampionProcessNavigation({
    proposal: proposal({
      customerStatements: [{ text: '公司转给我的客户，但我不知道他这次要办什么', source: 'current_message' }],
      kycFacts: [{
        key: 'relationship_origin', value: '公司转交', source: 'advisor_fact', evidence: '公司转给我的客户',
      }],
      customerLabels: [],
      stage: { value: 'post_sale', confidence: 0.9 },
      situations: [],
      missingInformation: ['customer_relationship_origin'],
      unknownInformation: ['current_service_task'],
    }),
    selection: { primary: { key: 'needs_discovery' }, supporting: [] },
    boundaryCandidates: [{
      key: 'serve_orphan_policy_before_selling',
      confirmationSlots: ['customer_relationship_origin', 'current_service_task'],
      unknownFallback: 'generic_service_first',
    }],
  });

  assert.deepEqual(navigation.questionPlan, []);
  assert.equal(navigation.unknownFallback, 'generic_service_first');
});
