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
    salesTurn: needsDiscoveryTurn({
      trainingPacks: [{
        key: 'advance_relationship_by_stage',
        evidenceRefs: ['training:cheng-jiye:video-29-sales-like-dating'],
      }],
    }),
  });

  assert.match(result.interaction.text, /客户现在明确说到的是：客户五十多岁；比较在意养老/u);
  assert.match(result.interaction.text, /下一步只做一件事/u);
  assert.match(result.interaction.text, /可以直接这样发/u);
  assert.match(result.interaction.text, /客户希望解决的核心问题/u);
  assert.match(result.interaction.text, /现有保障和保单资料/u);
  assert.doesNotMatch(result.interaction.text, /顾问本轮提供|客户理解|当前阶段|优先确认/u);
  assert.equal(result.provenance.skill, 'needs_discovery');
  assert.deepEqual(result.provenance.trainingPacks, ['advance_relationship_by_stage']);
  assert.deepEqual(result.provenance.evidenceRefs, ['training:cheng-jiye:video-29-sales-like-dating']);
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

test('readiness clarification gives a follow-up method before requesting more information', () => {
  const result = executeSalesChampionAtomicSkill({
    context: {},
    salesTurn: needsDiscoveryTurn({
      readiness: { decision: 'clarify', reason: 'low_stage_confidence' },
      selection: null,
    }),
  });

  const answer = result.interaction.text;
  assert.match(answer, /不用等资料全了才跟进/u);
  assert.match(answer, /先轻轻碰一下/u);
  assert.match(answer, /可以直接这样发/u);
  assert.ok(answer.indexOf('先轻轻碰一下') < answer.indexOf('你再补我两点'));
  assert.doesNotMatch(answer, /补充完整信息后/u);
});

test('needs discovery limits optional information requests to two items', () => {
  const result = executeSalesChampionAtomicSkill({
    context: {},
    salesTurn: needsDiscoveryTurn({
      proposal: {
        customerStatements: [{ text: '客户想了解养老', source: 'current_message' }],
        missingInformation: ['customer_goal', 'budget', 'existing_coverage'],
      },
    }),
  });

  assert.match(result.interaction.text, /1\. 客户希望解决/u);
  assert.match(result.interaction.text, /2\. 不影响当前生活/u);
  assert.doesNotMatch(result.interaction.text, /3\. /u);
});
