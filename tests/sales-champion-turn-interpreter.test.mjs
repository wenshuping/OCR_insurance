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
    turnRelation: { value: 'new_request', confidence: 0.9 },
    customerStatements: [{ text: question, source: 'current_message' }],
    stage: { value: 'discovery', confidence: 0.9 },
    concerns: [{ type: 'follow_up', priority: 'primary', confidence: 0.9 }],
    signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
    missingInformation: ['customer_goal', 'existing_coverage'],
    proposedCapabilities: ['needs_discovery'],
    insuranceNeeds: [],
    situations: [],
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
  assert.match(JSON.stringify(requestBody), /situations 按业务事实语义判断/u);
  assert.match(JSON.stringify(requestBody), /原业务员离职、公司转交保单、刚接手别人的老保单客户/u);
  assert.match(JSON.stringify(requestBody), /只有年龄、职业、收入或资产背景不算/u);
  assert.match(JSON.stringify(requestBody), /缴费期限太长、坚持不住或退休前交不完/u);
  assert.match(JSON.stringify(requestBody), /工作、家庭、收入、居住、房产和已有保单要进入 KYC/u);
  assert.match(JSON.stringify(requestBody), /advisor_estimate 和 advisor_inference 只能 candidate/u);
});

test('sales champion interpreter preserves grounded KYC facts and evidence-based labels', async () => {
  const question = '客户是公务员，客户说十年交费太长，我感觉他意向还可以。';
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      kycFacts: [
        { key: 'occupation', value: '公务员', source: 'advisor_fact', evidence: '客户是公务员' },
        { key: 'insurance_attitude', value: '意向还可以', source: 'advisor_inference', evidence: '我感觉他意向还可以' },
      ],
      customerLabels: [
        { dimension: 'current_concern', value: '缴费持续性顾虑', status: 'confirmed', source: 'customer_statement', evidence: '客户说十年交费太长', confidence: 0.96 },
        { dimension: 'purchase_intent', value: 'I2', status: 'candidate', source: 'advisor_inference', evidence: '我感觉他意向还可以', confidence: 0.58 },
      ],
    })),
  });

  assert.equal(interpreted.kycFacts.length, 2);
  assert.equal(interpreted.customerLabels[0].value, '缴费持续性顾虑');
  assert.equal(interpreted.customerLabels[1].status, 'candidate');
});

test('sales champion interpreter accepts boundary confirmation slots without forcing a situation', async () => {
  const question = '这是一个老保单客户，我第一次接触，不清楚之前是谁服务的。';
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      stage: { value: 'post_sale', confidence: 0.93 },
      concerns: [{ type: 'unknown', priority: 'primary', confidence: 0.9 }],
      proposedCapabilities: ['needs_discovery'],
      missingInformation: ['customer_relationship_origin'],
      situations: [],
    })),
  });

  assert.deepEqual(interpreted.situations, []);
  assert.deepEqual(interpreted.missingInformation, ['customer_relationship_origin']);
});

test('sales champion interpreter preserves an explicit controlled situation', async () => {
  const question = '客户已有百万医疗，问还有没有必要了解重疾险。';
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      stage: { value: 'objection', confidence: 0.92 },
      concerns: [{ type: 'claims', priority: 'primary', confidence: 0.91 }],
      proposedCapabilities: ['plain_language_explanation', 'fact_sensitive_routing'],
      insuranceNeeds: [{ type: 'product_facts', queryAspects: ['main_responsibilities'] }],
      situations: ['medical_critical_illness_overlap'],
    })),
  });

  assert.deepEqual(interpreted.situations, ['medical_critical_illness_overlap']);
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

test('sales champion interpreter deduplicates and prioritizes evidence within a bounded budget', async () => {
  const statements = Array.from({ length: 21 }, (_, index) => `已确认背景${index + 1}`);
  statements.push('客户希望先解决养老安排');
  const question = `${statements.join('，')}，我怎么跟进？`;
  let calls = 0;
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => {
      calls += 1;
      return response(proposal(question, {
        customerStatements: [...statements, statements[0]].map((statement) => ({
          text: statement,
          source: 'current_message',
        })),
        kycFacts: [{
          key: 'customer_goal', value: '先解决养老安排', source: 'advisor_fact',
          evidence: '客户希望先解决养老安排',
        }],
      }));
    },
  });

  assert.equal(calls, 1);
  assert.equal(interpreted.customerStatements.length, 20);
  assert.equal(interpreted.customerStatements[0].text, '客户希望先解决养老安排');
  assert.equal(new Set(interpreted.customerStatements.map((item) => item.text)).size, 20);
});

test('sales champion interpreter drops optional KYC evidence that paraphrases the advisor', async () => {
  const question = '客户五十多岁，在工厂上班，比较在意养老，我怎么跟进？';
  let calls = 0;
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => {
      calls += 1;
      return response(proposal(question, {
        kycFacts: [
          { key: 'age_life_stage', value: '50多岁', source: 'advisor_fact', evidence: '客户五十多岁' },
          { key: 'occupation', value: '工厂职员', source: 'advisor_fact', evidence: '客户是普通工厂职员' },
        ],
        customerLabels: [{
          dimension: 'family_stage',
          value: '养老准备期',
          status: 'candidate',
          source: 'advisor_inference',
          evidence: '客户已进入养老准备阶段',
          confidence: 0.7,
        }],
      }));
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(interpreted.kycFacts, [
    { key: 'age_life_stage', value: '50多岁', source: 'advisor_fact', evidence: '客户五十多岁' },
  ]);
  assert.deepEqual(interpreted.customerLabels, []);
});

test('sales champion interpreter marks an advisor correction as overriding prior context', async () => {
  const question = '前面的方向是我自己判断的，客户没有说想了解这件事。我补充一下新的情况。';
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      stage: { value: 'contact', confidence: 0.9 },
      concerns: [{ type: 'follow_up', priority: 'primary', confidence: 0.9 }],
      missingInformation: ['customer_goal'],
      proposedCapabilities: ['appointment_scope', 'follow_up_consent'],
      situations: [],
    })),
  });

  assert.deepEqual(interpreted.turnRelation, { value: 'correction', confidence: 1 });
  assert.deepEqual(interpreted.concerns.map((item) => item.type), ['unknown']);
  assert.deepEqual(interpreted.missingInformation, []);
  assert.deepEqual(interpreted.proposedCapabilities, ['general_sales_clarification']);
  assert.deepEqual(interpreted.situations, []);
});

test('sales champion interpreter recognizes a rhetorical reminder as a correction', async () => {
  const question = '人家不是已经有一项安排吗';
  const interpreted = await interpretSalesChampionTurn({
    question,
    history: [{ role: 'assistant', content: '可以继续了解客户有没有这项需求。' }],
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      turnRelation: { value: 'context_update', confidence: 0.9 },
      customerStatements: [],
      kycFacts: [{
        key: 'existing_insurance', value: '已有一项安排',
        source: 'advisor_fact', evidence: question,
      }],
      concerns: [{ type: 'affordability', priority: 'primary', confidence: 0.8 }],
      missingInformation: ['budget', 'objection_reason'],
      proposedCapabilities: ['five_question_diagnosis', 'needs_discovery'],
      situations: ['retirement_planning', 'investment_comparison'],
    })),
  });

  assert.deepEqual(interpreted.turnRelation, { value: 'correction', confidence: 1 });
  assert.deepEqual(interpreted.concerns, [{
    type: 'unknown', priority: 'primary', confidence: 1,
  }]);
  assert.deepEqual(interpreted.missingInformation, []);
  assert.deepEqual(interpreted.proposedCapabilities, ['general_sales_clarification']);
  assert.deepEqual(interpreted.situations, []);
});
