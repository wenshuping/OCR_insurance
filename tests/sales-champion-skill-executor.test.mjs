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

test('needs discovery skill consumes structured facts without classifying raw keywords', () => {
  const result = executeSalesChampionAtomicSkill({
    context: { question: '这里即使出现比较，也不能触发产品比较。' },
    salesTurn: needsDiscoveryTurn(),
  });

  assert.match(result.interaction.text, /顾问本轮提供：客户五十多岁/u);
  assert.match(result.interaction.text, /顾问本轮提供：比较在意养老/u);
  assert.match(result.interaction.text, /客户希望解决的核心问题/u);
  assert.match(result.interaction.text, /现有保障和保单资料/u);
  assert.equal(result.provenance.skill, 'needs_discovery');
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
