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

test('process navigator recognizes KYC labels and keeps core customer KYC across sales stages', () => {
  const navigation = buildSalesChampionProcessNavigation({
    proposal: proposal(),
    selection: { primary: { key: 'tradeoff_disclosure' }, supporting: [] },
    boundaryCandidates: [],
  });

  assert.equal(navigation.processLane, 'decision');
  assert.equal(navigation.confirmedLabels[0].value, '缴费持续性顾虑');
  assert.deepEqual(navigation.questionPlan.map((item) => item.slot), [
    'customer_relationship_origin',
    'objection_reason',
    'explicit_customer_request',
  ]);
});

test('process navigator asks only whether an ambiguous description belongs to another customer', () => {
  const navigation = buildSalesChampionProcessNavigation({
    proposal: proposal({
      customerCase: { relation: 'uncertain', confidence: 0.6 },
    }),
    selection: { primary: { key: 'needs_discovery' }, supporting: [] },
    hasActiveCustomerContext: true,
  });

  assert.deepEqual(navigation.questionPlan.map((item) => item.question), [
    '这是刚才那位客户，还是另一位客户？',
  ]);
});

test('process navigator combines an orphan boundary with the relevant post-sale KYC dimensions', () => {
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
  assert.deepEqual(navigation.questionPlan.map((item) => item.slot), [
    'customer_relationship_origin',
    'contact_preference',
    'current_service_task',
  ]);
  assert.equal(navigation.unknownFallback, 'generic_service_first');
});

test('process navigator does not repeat known or unknown KYC dimensions', () => {
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

  assert.deepEqual(navigation.questionPlan.map((item) => item.slot), [
    'contact_preference',
    'explicit_customer_request',
  ]);
  assert.equal(navigation.unknownFallback, 'generic_service_first');
});

test('process navigator treats a confirmed source label as an answered customer-origin question', () => {
  const navigation = buildSalesChampionProcessNavigation({
    proposal: proposal({
      kycFacts: [],
      customerLabels: [{
        dimension: 'source', value: 'SRC2', status: 'confirmed',
        source: 'advisor_fact', evidence: '老客户转介绍', confidence: 0.95,
      }],
      missingInformation: ['customer_relationship_origin'],
    }),
    selection: { primary: { key: 'needs_discovery' }, supporting: [] },
  });

  assert.ok(!navigation.questionPlan.some((item) => item.slot === 'customer_relationship_origin'));
  assert.ok(navigation.confirmedLabels.some((label) => label.dimension === 'source' && label.value === 'SRC2'));
});

test('process navigator does not repeat customer source after the advisor says it is unknown', () => {
  const navigation = buildSalesChampionProcessNavigation({
    proposal: proposal({
      kycFacts: [],
      customerLabels: [{
        dimension: 'source', value: 'SRC0', status: 'confirmed',
        source: 'advisor_fact', evidence: '来源不知道', confidence: 0.95,
      }],
      missingInformation: ['customer_relationship_origin'],
    }),
    selection: { primary: { key: 'needs_discovery' }, supporting: [] },
  });

  assert.ok(!navigation.questionPlan.some((item) => item.slot === 'customer_relationship_origin'));
});

test('process navigator does not repeat semantically answered KYC slots from prior questions', () => {
  const navigation = buildSalesChampionProcessNavigation({
    proposal: proposal({
      kycFacts: [],
      customerLabels: [],
      answeredInformation: ['explicit_customer_request', 'meeting_trigger'],
      missingInformation: ['contact_preference', 'conversation_end_state'],
    }),
    selection: { primary: { key: 'follow_up_consent' }, supporting: [] },
  });

  assert.ok(!navigation.questionPlan.some((item) => item.slot === 'explicit_customer_request'));
  assert.ok(!navigation.questionPlan.some((item) => item.slot === 'meeting_trigger'));
  assert.ok(navigation.questionPlan.some((item) => item.slot === 'customer_relationship_origin'));
});
