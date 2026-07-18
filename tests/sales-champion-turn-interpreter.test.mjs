import assert from 'node:assert/strict';
import test from 'node:test';

import { interpretSalesChampionTurn } from '../server/sales-champion-turn-interpreter.service.mjs';

function response(content) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
  };
}

function proposal(question, overrides = {}) {
  return {
    contractVersion: 1,
    customerStatements: [{ text: question, source: 'current_message' }],
    stage: { value: 'discovery', confidence: 0.9 },
    concerns: [{ type: 'follow_up', priority: 'primary', confidence: 0.9 }],
    signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
    missingInformation: ['customer_goal', 'existing_coverage'],
    proposedCapabilities: ['needs_discovery'],
    insuranceNeeds: [],
    ...overrides,
  };
}

test('sales champion interpreter keeps degree language out of product comparison routing', async () => {
  const question = '客户五十多岁，买过几份保险，比较在意养老，我怎么跟进？';
  let requestBody;
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response(proposal(question));
    },
  });

  assert.equal(interpreted.concerns[0].type, 'follow_up');
  assert.deepEqual(interpreted.insuranceNeeds, []);
  assert.match(JSON.stringify(requestBody), /产品名称只是客户背景/u);
  assert.doesNotMatch(JSON.stringify(requestBody), /\/比较\//u);
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  assert.deepEqual(requestBody.thinking, { type: 'disabled' });
  assert.equal(requestBody.max_tokens, 2_000);
});

test('sales champion interpreter can request insurance expert coverage-gap evidence', async () => {
  const question = '结合这个家庭现有保单，我该先跟客户聊哪个保障缺口？';
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      concerns: [{ type: 'product_fit', priority: 'primary', confidence: 0.91 }],
      proposedCapabilities: ['five_question_diagnosis'],
      insuranceNeeds: [{ type: 'coverage_gap', queryAspects: ['coverage_gap'] }],
    })),
  });

  assert.deepEqual(interpreted.insuranceNeeds, [{ type: 'coverage_gap', queryAspects: ['coverage_gap'] }]);
});

test('sales champion interpreter rejects ungrounded customer statements', async () => {
  const question = '客户想了解养老安排。';
  await assert.rejects(
    interpretSalesChampionTurn({
      question,
      env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
      fetchImpl: async () => response(proposal('客户明确拒绝继续联系。')),
    }),
    (error) => error.code === 'SALES_CHAMPION_INTERPRETER_INVALID_RESPONSE',
  );
});

test('sales champion interpreter drops one ungrounded statement when grounded statements remain', async () => {
  const question = '客户五十多岁，买过几份保险，比较在意养老，我怎么跟进？';
  let calls = 0;
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => {
      calls += 1;
      return response(proposal(question, {
        customerStatements: [
          { text: '客户五十多岁', source: 'current_message' },
          { text: '客户已经做好养老规划', source: 'current_message' },
        ],
      }));
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(interpreted.customerStatements, [
    { text: '客户五十多岁', source: 'current_message' },
  ]);
});
