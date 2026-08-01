import assert from 'node:assert/strict';
import test from 'node:test';

import { planSalesChampionQuestions } from '../server/sales-champion-question-planner.service.mjs';

test('question planner prioritizes missing skill boundaries and stays within the burden budget', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      missingInformation: ['customer_goal', 'customer_relationship_origin', 'conversation_end_state'],
      insuranceNeeds: [],
    },
    boundaryCandidates: [{
      key: 'serve_orphan_policy_before_selling',
      confirmationSlots: ['customer_relationship_origin'],
    }],
  });

  assert.deepEqual(questions.map((item) => item.slot), [
    'customer_relationship_origin',
    'conversation_end_state',
  ]);
  assert.equal(questions.reduce((sum, item) => sum + item.answerCost, 0), 2);
  assert.deepEqual(questions[0].affectedSkills, ['serve_orphan_policy_before_selling']);
});

test('question planner does not ask insurance KYC for an ordinary sales follow-up', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      missingInformation: ['existing_coverage', 'existing_policy_evidence', 'customer_goal'],
      insuranceNeeds: [],
    },
  });

  assert.deepEqual(questions.map((item) => item.slot), ['customer_goal']);
});

test('question planner can request one high-cost insurance item when expert analysis is requested', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      missingInformation: ['existing_coverage', 'existing_policy_evidence', 'health_information'],
      insuranceNeeds: [{ type: 'coverage_gap', queryAspects: ['coverage_gap'] }],
    },
  });

  assert.equal(questions.length, 1);
  assert.equal(questions[0].answerCost, 3);
});

test('question planner does not repeat slots already known or answered as unknown', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      missingInformation: ['customer_goal', 'objection_reason', 'conversation_end_state'],
      insuranceNeeds: [],
    },
    knownSlots: ['customer_goal'],
    unknownSlots: ['objection_reason'],
  });

  assert.deepEqual(questions.map((item) => item.slot), ['conversation_end_state']);
});
