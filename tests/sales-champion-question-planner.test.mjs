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
    'explicit_customer_request',
  ]);
  assert.equal(questions.reduce((sum, item) => sum + item.answerCost, 0), 3);
  assert.deepEqual(questions[0].affectedSkills, ['serve_orphan_policy_before_selling']);
});

test('question planner does not ask insurance KYC for an ordinary sales follow-up', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      missingInformation: ['existing_coverage', 'existing_policy_evidence', 'customer_goal'],
      insuranceNeeds: [],
    },
  });

  assert.deepEqual(questions.map((item) => item.slot), [
    'customer_relationship_origin',
    'customer_goal',
  ]);
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

  assert.deepEqual(questions.map((item) => item.slot), [
    'customer_relationship_origin',
    'conversation_end_state',
    'explicit_customer_request',
  ]);
});

test('question planner does not carry old questions into an advisor correction', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      turnRelation: { value: 'correction', confidence: 1 },
      missingInformation: ['customer_goal', 'objection_reason', 'budget'],
      insuranceNeeds: [],
    },
  });

  assert.deepEqual(questions, []);
});

test('contact-stage KYC asks customer source and marketing permission before sales discovery', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      turnRelation: { value: 'new_request', confidence: 0.9 },
      missingInformation: [
        'customer_goal',
        'contact_preference',
        'customer_relationship_origin',
        'explicit_customer_request',
      ],
      unknownInformation: [],
      insuranceNeeds: [],
    },
  });

  assert.deepEqual(questions.map((item) => item.slot), [
    'customer_relationship_origin',
    'explicit_customer_request',
    'contact_preference',
  ]);
  assert.match(questions[0].question, /自己开发、别人转介绍.*公司转交的老保单客户/u);
  assert.match(questions[1].question, /主动提过保险/u);
});

test('contact-stage KYC questions come from label dimensions even when the model reports no missing slots', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      turnRelation: { value: 'new_request', confidence: 0.9 },
      stage: { value: 'contact', confidence: 0.9 },
      missingInformation: [],
      unknownInformation: [],
      insuranceNeeds: [],
    },
  });

  assert.deepEqual(questions.map((item) => item.slot), [
    'customer_relationship_origin',
    'explicit_customer_request',
    'contact_preference',
  ]);
});

test('core customer KYC remains available after the contact stage', () => {
  const result = planSalesChampionQuestions({
    proposal: {
      stage: { value: 'objection' },
      missingInformation: ['objection_reason'],
      insuranceNeeds: [],
    },
  });

  assert.deepEqual(result.map((item) => item.slot), [
    'customer_relationship_origin',
    'objection_reason',
    'explicit_customer_request',
  ]);
});

test('stage KYC does not repeat dimensions already known or answered as unknown', () => {
  const questions = planSalesChampionQuestions({
    proposal: {
      turnRelation: { value: 'new_request', confidence: 0.9 },
      stage: { value: 'contact', confidence: 0.9 },
      missingInformation: [],
      unknownInformation: [],
      insuranceNeeds: [],
    },
    knownSlots: ['customer_relationship_origin', 'contact_preference'],
    unknownSlots: ['explicit_customer_request'],
  });

  assert.deepEqual(questions, []);
});
