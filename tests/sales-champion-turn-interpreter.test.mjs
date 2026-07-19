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
  assert.equal(requestBody.max_tokens, 4_000);
  assert.match(JSON.stringify(requestBody), /situations 只标记当前问题明确出现的具体业务场景/u);
  assert.match(JSON.stringify(requestBody), /计划书.*silent_after_proposal/u);
  assert.match(JSON.stringify(requestBody), /不要把场景写死为某个利率数字/u);
  assert.match(JSON.stringify(requestBody), /缴费期限太长.*long_payment_commitment.*不得限定为十年/u);
  assert.match(JSON.stringify(requestBody), /退休生活.*retirement_planning/u);
  assert.match(JSON.stringify(requestBody), /过去被强推、无人服务.*service_trust_recovery/u);
  assert.match(JSON.stringify(requestBody), /年数、金额、年龄、利率和称呼都只按本轮原话理解/u);
  assert.match(JSON.stringify(requestBody), /历史里已经回答过的目标、用途、预算、保单、家庭决策或联系偏好不得重复列入/u);
  assert.match(JSON.stringify(requestBody), /answeredInformation.*问题与顾问后续回答做语义对应/u);
  assert.match(JSON.stringify(requestBody), /表面异议.*objection_reason.*不得用模型猜测的原因/u);
});

test('sales champion interpreter preserves KYC slots answered across turns', async () => {
  const question = '1.客户让我整理保单 2.他关心高端医疗 3.是我主动找客户的';
  const interpreted = await interpretSalesChampionTurn({
    question,
    history: [{
      role: 'assistant',
      content: '1.客户有没有明确让你处理什么？ 2.客户希望什么时间联系？ 3.这次是谁主动找谁？',
    }],
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      turnRelation: { value: 'follow_up_answer', confidence: 0.98 },
      kycFacts: [{
        key: 'service_request', value: '整理保单', source: 'advisor_fact', evidence: '客户让我整理保单',
      }],
      answeredInformation: ['explicit_customer_request', 'meeting_trigger'],
      missingInformation: ['customer_relationship_origin', 'contact_preference'],
    })),
  });

  assert.deepEqual(interpreted.answeredInformation, ['explicit_customer_request', 'meeting_trigger']);
  assert.ok(!interpreted.missingInformation.includes('explicit_customer_request'));
});

test('sales champion interpreter accepts the generic low-rate situation', async () => {
  const question = '客户觉得现在利率太低，而且担心以后还会继续下调，我怎么聊？';
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      customerStatements: [{ text: '客户觉得现在利率太低，而且担心以后还会继续下调', source: 'current_message' }],
      stage: { value: 'objection', confidence: 0.95 },
      concerns: [{ type: 'benefits', priority: 'primary', confidence: 0.94 }],
      missingInformation: ['customer_goal', 'product_contract'],
      proposedCapabilities: ['tradeoff_disclosure', 'plain_language_explanation', 'fact_sensitive_routing'],
      insuranceNeeds: [{ type: 'product_facts', queryAspects: ['product_advantages'] }],
      situations: ['low_rate_objection'],
    })),
  });

  assert.deepEqual(interpreted.situations, ['low_rate_objection']);
  assert.equal(interpreted.customerStatements[0].text.includes('1.75'), false);
});

test('sales champion interpreter accepts the silent-after-proposal situation', async () => {
  const question = '计划书发给客户以后，他不接电话也不回消息，我下一步怎么跟？';
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => response(proposal(question, {
      customerStatements: [{ text: '他不接电话也不回消息', source: 'current_message' }],
      stage: { value: 'objection', confidence: 0.94 },
      concerns: [{ type: 'follow_up', priority: 'primary', confidence: 0.93 }],
      missingInformation: ['contact_preference'],
      proposedCapabilities: ['follow_up_consent'],
      situations: ['silent_after_proposal'],
    })),
  });

  assert.deepEqual(interpreted.situations, ['silent_after_proposal']);
  assert.deepEqual(interpreted.proposedCapabilities, ['follow_up_consent']);
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

test('sales champion interpreter accepts Yirong objection situations', async () => {
  const cases = [
    {
      question: '客户说单位已经有团险，不需要再买个人保险。',
      concern: 'product_fit', capabilities: ['needs_discovery', 'fact_sensitive_routing'],
      situation: 'third_party_cover_overlap', insuranceNeeds: [{ type: 'product_facts', queryAspects: ['main_responsibilities'] }],
    },
    {
      question: '客户说有房贷车贷，现在没有余钱买保险。',
      concern: 'affordability', capabilities: ['five_question_diagnosis', 'tradeoff_disclosure'],
      situation: 'debt_budget_constraint', insuranceNeeds: [],
    },
    {
      question: '客户说等明年有时间再看，没有约具体时间。',
      concern: 'follow_up', capabilities: ['follow_up_consent', 'five_question_diagnosis'],
      situation: 'postpone_without_date', insuranceNeeds: [],
    },
  ];

  for (const item of cases) {
    const interpreted = await interpretSalesChampionTurn({
      question: item.question,
      env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
      fetchImpl: async () => response(proposal(item.question, {
        customerStatements: [{ text: item.question.replace(/[。]$/u, ''), source: 'current_message' }],
        stage: { value: 'objection', confidence: 0.95 },
        concerns: [{ type: item.concern, priority: 'primary', confidence: 0.94 }],
        proposedCapabilities: item.capabilities,
        insuranceNeeds: item.insuranceNeeds,
        situations: [item.situation],
      })),
    });
    assert.deepEqual(interpreted.situations, [item.situation]);
  }
});

test('sales champion interpreter maps an explicit orphan policy service request to the reachable capability', async () => {
  const question = '接手一份孤儿保单，原业务员离职了，客户明确只要服务，第一次怎么聊？';
  let requestBody;
  const interpreted = await interpretSalesChampionTurn({
    question,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response(proposal(question, {
        customerStatements: [{ text: '客户明确只要服务', source: 'current_message' }],
        stage: { value: 'post_sale', confidence: 0.95 },
        concerns: [{ type: 'follow_up', priority: 'primary', confidence: 0.94 }],
        missingInformation: ['contact_preference'],
        proposedCapabilities: ['follow_up_consent'],
        situations: ['orphan_policy'],
      }));
    },
  });

  assert.deepEqual(interpreted.situations, ['orphan_policy']);
  assert.deepEqual(interpreted.proposedCapabilities, ['follow_up_consent']);
  assert.match(JSON.stringify(requestBody), /孤儿保单、孤儿单、接手保单.*原业务员离职、失联.*contact\/appointment\/post_sale.*orphan_policy/u);
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
