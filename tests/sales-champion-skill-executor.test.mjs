import assert from 'node:assert/strict';
import test from 'node:test';

import { executeSalesChampionAtomicSkill } from '../server/sales-champion-skill-executor.service.mjs';

function needsDiscoveryTurn(overrides = {}) {
  return {
    proposal: {
      customerStatements: [
        { text: '客户五十多岁', source: 'current_message' },
        { text: '比较在意养老', source: 'current_message' },
      ],
      missingInformation: ['customer_goal', 'existing_coverage'],
    },
    selection: { primary: { key: 'needs_discovery', version: 1 }, supporting: [] },
    insuranceNeedResults: [],
    ...overrides,
  };
}

test('ordinary needs discovery yields to the sales champion final responder', () => {
  const result = executeSalesChampionAtomicSkill({
    context: { question: '这里即使出现比较，也不能触发产品比较。' },
    salesTurn: needsDiscoveryTurn(),
  });
  assert.equal(result, null);
});

test('specific training pack runs before the generic needs discovery shortcut', () => {
  const result = executeSalesChampionAtomicSkill({
    context: {},
    salesTurn: needsDiscoveryTurn({
      trainingPacks: [{
        key: 'handle_age_based_delay_without_scare',
        evidenceRefs: ['local:yirong-66-tips:3'],
        promptRules: ['先确认客户为什么想晚点办。'],
      }],
      executionPlan: {
        primary: { key: 'handle_age_based_delay_without_scare' },
        supporting: [],
        fallbackUsed: false,
      },
    }),
  });

  assert.equal(result, null);
});

test('atomic skill yields to family workflows and other selected skills', () => {
  assert.equal(executeSalesChampionAtomicSkill({
    context: { familyId: 9 },
    salesTurn: needsDiscoveryTurn(),
  }), null);
  assert.equal(executeSalesChampionAtomicSkill({
    context: {},
    salesTurn: needsDiscoveryTurn({ selection: { primary: { key: 'plain_language_explanation' } } }),
  }), null);
});

test('readiness gate stops promotion before any selected skill runs', () => {
  const result = executeSalesChampionAtomicSkill({
    context: { familyId: 9 },
    salesTurn: needsDiscoveryTurn({
      readiness: { decision: 'stop_contact', reason: 'stop_contact_requested' },
      selection: null,
    }),
  });
  assert.match(result.interaction.text, /不要继续促成、追问或安排跟进/u);
  assert.equal(result.provenance.source, 'sales_champion_readiness_gate');
});

test('readiness clarification yields to the sales champion final responder', () => {
  const result = executeSalesChampionAtomicSkill({
    context: {},
    salesTurn: needsDiscoveryTurn({
      readiness: { decision: 'clarify', reason: 'low_stage_confidence' },
      selection: null,
    }),
  });

  assert.equal(result, null);
});

test('needs discovery with multiple missing slots still yields to the final responder', () => {
  const result = executeSalesChampionAtomicSkill({
    context: {},
    salesTurn: needsDiscoveryTurn({
      proposal: {
        customerStatements: [{ text: '客户想了解养老', source: 'current_message' }],
        missingInformation: ['customer_goal', 'budget', 'existing_coverage'],
      },
    }),
  });

  assert.equal(result, null);
});

test('needs discovery question plans remain input for the final responder', () => {
  const result = executeSalesChampionAtomicSkill({
    context: {},
    salesTurn: needsDiscoveryTurn({
      informationFollowUp: {
        maxQuestions: 2,
        questions: [{
          key: 'customer_goal',
          askAdvisor: '这个客户这次最想解决什么？',
          askCustomerIfUnknown: '您这次最想先解决哪件事？',
          impact: '决定下一步沟通目标。',
          owner: 'sales_champion',
        }],
      },
    }),
  });

  assert.equal(result, null);
});
