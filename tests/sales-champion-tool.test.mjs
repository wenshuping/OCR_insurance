import assert from 'node:assert/strict';
import test from 'node:test';

import { createSalesChampionTool } from '../server/sales-champion-tool.service.mjs';

function result() {
  return {
    facts: { answer: '销售建议' },
    provenance: { source: 'family_sales_chat' },
    presentation: { message: '销售建议' },
    interaction: { type: 'answer', text: '销售建议' },
  };
}

test('sales champion invokes the existing sales domain service through its agent entry', async () => {
  const calls = [];
  const tool = createSalesChampionTool({ execute(action, context) {
    calls.push({ action, context });
    return result();
  } });
  const output = await tool.askSalesChampionTool({ context: {
    internalUserId: 7, familyId: 9, intent: 'sales_coaching', tool: 'sales_report', question: '怎么跟客户沟通',
  } });
  assert.equal(calls[0].action, 'sales_report');
  assert.equal(output.provenance.domainAgent, 'sales_champion');
  assert.equal(output.provenance.agentAsTool, true);
});

test('sales champion drops raw family facts and rejects insurance expert actions', async () => {
  let received;
  const tool = createSalesChampionTool({ execute(_action, context) { received = context; return result(); } });
  await tool.askSalesChampionTool({ context: {
    internalUserId: 7, familyId: 9, intent: 'sales_coaching', question: '继续', policies: [{ id: 1 }],
    history: [
      { role: 'user', content: '上一问' },
      { role: 'system', content: 'drop' },
      { role: 'assistant', content: '上一答', secret: true },
    ],
  } });
  assert.equal(received.policies, undefined);
  assert.deepEqual(received.history, [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
  ]);
  await assert.rejects(tool.askSalesChampionTool({ context: {
    internalUserId: 7, intent: 'insurance_product_knowledge', question: '产品责任',
  } }), /not allowed/u);
  await assert.rejects(tool.askSalesChampionTool({ context: {
    internalUserId: 7,
    intent: 'sales_report',
    tool: 'coverage_report',
    question: '报告',
  } }), /tool is not allowed/u);
});

test('sales champion keeps bounded product clues and verified expert evidence without internal product ids', async () => {
  let received;
  const tool = createSalesChampionTool({ execute(_action, context) { received = context; return result(); } });
  await tool.askSalesChampionTool({ context: {
    internalUserId: 7,
    intent: 'sales_coaching',
    question: '客户问续保时怎么沟通',
    productMentions: ['新华保险的康健华尊', '新华保险的康健华尊'],
    officialFactNeeds: ['renewal', 'unknown'],
    insuranceExpertEvidence: [{
      status: 'verified',
      products: [{
        canonicalProductId: 'internal-product-id',
        company: '新华保险',
        officialName: '新华人寿保险股份有限公司康健华尊医疗保险',
      }],
      answer: '续保结论以已核验条款为准。',
      rawChunks: ['drop'],
    }],
  } });

  assert.deepEqual(received.productMentions, ['新华保险的康健华尊']);
  assert.deepEqual(received.officialFactNeeds, ['renewal']);
  assert.deepEqual(received.insuranceExpertEvidence, [{
    status: 'verified',
    products: [{ company: '新华保险', officialName: '新华人寿保险股份有限公司康健华尊医疗保险' }],
    answer: '续保结论以已核验条款为准。',
  }]);
  assert.doesNotMatch(JSON.stringify(received), /internal-product-id|rawChunks/u);
});

function salesProposal(question, overrides = {}) {
  return {
    contractVersion: 1,
    customerStatements: [{ text: question, source: 'current_message' }],
    stage: { value: 'discovery', confidence: 0.9 },
    concerns: [{ type: 'product_fit', priority: 'primary', confidence: 0.88 }],
    signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
    missingInformation: ['customer_goal'],
    proposedCapabilities: ['needs_discovery'],
    insuranceNeeds: [],
    ...overrides,
  };
}

test('sales champion starts a clean KYC case when semantic context identifies a new customer', async () => {
  const question = '我前天见了一个63岁的电子仪器企业主，她平时很忙';
  let received;
  const tool = createSalesChampionTool({
    interpretTurn: async ({ activeCustomerKyc }) => {
      assert.equal(activeCustomerKyc.facts[0].value, '公务员');
      return salesProposal(question, {
        customerCase: { relation: 'new_customer', confidence: 0.96 },
        kycFacts: [
          { key: 'age_life_stage', value: '63岁', source: 'advisor_fact', evidence: '63岁' },
          { key: 'occupation', value: '电子仪器企业主', source: 'advisor_fact', evidence: '电子仪器企业主' },
        ],
        customerLabels: [],
      });
    },
    execute(_action, context) { received = context; return result(); },
  });

  const output = await tool.askSalesChampionTool({ context: {
    internalUserId: 7,
    intent: 'sales_coaching',
    question,
    salesKycState: {
      caseVersion: 3,
      knownSlots: ['customer_relationship_origin'],
      unknownSlots: [],
      facts: [{ key: 'occupation', value: '公务员', source: 'advisor_fact' }],
      labels: [{ dimension: 'source', value: 'SRC5', status: 'confirmed' }],
    },
  } });

  assert.equal(output.agentContextUpdate.salesKyc.caseVersion, 4);
  assert.deepEqual(output.agentContextUpdate.salesKyc.facts, [
    { key: 'age_life_stage', value: '63岁', source: 'advisor_fact' },
    { key: 'occupation', value: '电子仪器企业主', source: 'advisor_fact' },
  ]);
  assert.equal(output.agentContextUpdate.salesKyc.labels.length, 0);
  assert.deepEqual(received.history, []);
});

test('sales champion still answers from the full conversation when semantic interpretation fails', async () => {
  const question = '我有个客户以前是老师，现在约不到了，怎么跟进？';
  let received;
  const tool = createSalesChampionTool({
    interpretTurn: async () => {
      throw Object.assign(new Error('invalid structured response'), {
        code: 'SALES_CHAMPION_INTERPRETER_INVALID_RESPONSE',
      });
    },
    execute(_action, context) {
      received = context;
      return result();
    },
  });

  const output = await tool.askSalesChampionTool({ context: {
    internalUserId: 7,
    intent: 'sales_coaching',
    question,
    history: [{ role: 'user', content: '这是另一个客户。' }],
    salesKycState: {
      caseVersion: 2,
      knownSlots: ['customer_relationship_origin'],
      unknownSlots: [],
      facts: [{ key: 'relationship_origin', value: '公司转交', source: 'advisor_fact' }],
      labels: [],
    },
  } });

  assert.equal(output.interaction.text, '销售建议');
  assert.match(received.question, /现在约不到了，怎么跟进/u);
  assert.deepEqual(received.history, [{ role: 'user', content: '这是另一个客户。' }]);
  assert.equal(received.salesTurn, undefined);
  assert.deepEqual(output.agentContextUpdate.salesKyc, {
    caseVersion: 2,
    knownSlots: ['customer_relationship_origin'],
    unknownSlots: [],
    facts: [{ key: 'relationship_origin', value: '公司转交', source: 'advisor_fact' }],
    labels: [],
  });
});

test('sales champion decides when to call the insurance expert for product facts', async () => {
  const question = '客户问这份产品怎么续保，我应该怎么沟通？';
  const expertCalls = [];
  let received;
  const tool = createSalesChampionTool({
    interpretTurn: async () => salesProposal(question, {
      stage: { value: 'proposal', confidence: 0.92 },
      concerns: [{ type: 'benefits', priority: 'primary', confidence: 0.91 }],
      signals: { explicitRefusal: false, stopContact: false, factSensitive: true },
      missingInformation: ['product_contract'],
      proposedCapabilities: ['plain_language_explanation'],
      insuranceNeeds: [{ type: 'product_facts', queryAspects: ['renewal'] }],
    }),
    askInsuranceExpert: async (input) => {
      expertCalls.push(input);
      return {
        provenance: { domainAgent: 'insurance_expert' },
        interaction: { type: 'answer', text: '已核验续保事实。' },
      };
    },
    execute(_action, context) { received = context; return result(); },
  });

  await tool.askSalesChampionTool({ context: {
    internalUserId: 7,
    intent: 'sales_coaching',
    question,
    resolvedProducts: [{
      canonicalProductId: 'product-1', company: '测试保险', officialName: '测试保险产品',
    }],
  } });

  assert.equal(expertCalls.length, 1);
  assert.equal(expertCalls[0].context.intent, 'insurance_product_knowledge');
  assert.deepEqual(expertCalls[0].context.queryAspects, ['renewal']);
  assert.equal(received.salesTurn.selection.primary.key, 'plain_language_explanation');
  assert.equal(Array.isArray(received.salesTurn.trainingPacks), true);
  assert.deepEqual(received.salesTurn.informationFollowUp.questions.map((item) => item.key), [
    'product_contract',
  ]);
  assert.equal(received.salesTurn.informationFollowUp.questions[0].owner, 'insurance_expert');
  assert.deepEqual(received.salesTurn.insuranceNeedResults, [{ type: 'product_facts', status: 'verified' }]);
  assert.deepEqual(received.insuranceExpertEvidence, [{
    status: 'verified',
    products: [{ company: '测试保险', officialName: '测试保险产品' }],
    answer: '已核验续保事实。',
  }]);
});

test('sales champion calls the insurance expert for an authorized family coverage gap', async () => {
  const question = '结合这个家庭现有保单，我该先跟客户聊哪个保障缺口？';
  const expertCalls = [];
  let received;
  const tool = createSalesChampionTool({
    interpretTurn: async () => salesProposal(question, {
      insuranceNeeds: [{ type: 'coverage_gap', queryAspects: ['coverage_gap'] }],
    }),
    askInsuranceExpert: async (input) => {
      expertCalls.push(input);
      return {
        provenance: { domainAgent: 'insurance_expert' },
        interaction: { type: 'answer', text: '已核验家庭保障缺口。' },
      };
    },
    execute(_action, context) { received = context; return result(); },
  });

  await tool.askSalesChampionTool({ context: {
    internalUserId: 7, familyId: 9, intent: 'sales_coaching', question,
  } });

  assert.equal(expertCalls.length, 1);
  assert.deepEqual(expertCalls[0].context, {
    internalUserId: 7,
    intent: 'coverage_report',
    tool: 'coverage_report',
    familyId: 9,
    question,
  });
  assert.deepEqual(received.salesTurn.insuranceNeedResults, [{ type: 'coverage_gap', status: 'verified' }]);
  assert.equal(received.insuranceExpertEvidence[0].answer, '已核验家庭保障缺口。');
});

test('sales champion sends specific training packs to the generator without calling insurance expert for background products', async () => {
  const question = '客户五十多岁，提到买过几份保险，比较在意养老，我怎么跟进？';
  let expertCalled = false;
  let executeCalled = false;
  let received;
  const tool = createSalesChampionTool({
    interpretTurn: async () => salesProposal(question),
    askInsuranceExpert: async () => { expertCalled = true; return null; },
    execute(_action, context) { executeCalled = true; received = context; return result(); },
  });

  const output = await tool.askSalesChampionTool({ context: {
    internalUserId: 7, intent: 'sales_coaching', question, productMentions: ['某保险产品'],
  } });

  assert.equal(expertCalled, false);
  assert.equal(executeCalled, true);
  assert.equal(output.interaction.text, '销售建议');
  assert.equal(received.salesTurn.trainingPacks[0].key, 'advance_relationship_by_stage');
  assert.equal(received.salesTurn.executionPlan.primary.key, 'advance_relationship_by_stage');
  assert.deepEqual(received.salesTurn.executionPlan.supporting.map((pack) => pack.key), [
    'diagnose_problem_before_product',
  ]);
  assert.equal(received.salesTurn.executionPlan.fallbackUsed, false);
  assert.equal(received.salesTurn.trainingPacks.some((pack) => pack.key === 'discover_goal_with_golden_circle'), false);
  assert.equal(received.salesTurn.trainingPacks.every((pack) => [
    'advance_relationship_by_stage',
    'diagnose_problem_before_product',
  ].includes(pack.key)), true);
  assert.deepEqual(received.salesTurn.trainingPacks.flatMap((pack) => pack.evidenceRefs), [
    'douyin:cheng-jiye:7617439313277553955',
    'douyin:cheng-jiye:7630848003833711872',
    'douyin:cheng-jiye:7621478600243432739',
    'douyin:cheng-jiye:7630847723284991247',
  ]);
});

test('missing insurance evidence keeps a specific training pack and calls only available expert work', async () => {
  const question = '客户说孩子还小，已有保单但以后再买，我怎么跟？';
  const expertCalls = [];
  let received;
  const tool = createSalesChampionTool({
    interpretTurn: async () => salesProposal(question, {
      stage: { value: 'objection', confidence: 0.94 },
      concerns: [{ type: 'underwriting', priority: 'primary', confidence: 0.92 }],
      signals: { explicitRefusal: false, stopContact: false, factSensitive: true },
      proposedCapabilities: ['needs_discovery', 'fact_sensitive_routing'],
      insuranceNeeds: [
        { type: 'coverage_gap', queryAspects: ['coverage_gap'] },
        { type: 'product_facts', queryAspects: ['main_responsibilities'] },
      ],
      situations: ['age_based_purchase_delay'],
    }),
    askInsuranceExpert: async (input) => {
      expertCalls.push(input);
      return null;
    },
    execute(_action, context) { received = context; return result(); },
  });

  await tool.askSalesChampionTool({ context: {
    internalUserId: 7,
    intent: 'sales_coaching',
    question,
    resolvedProducts: [{
      canonicalProductId: 'product-1', company: '测试保险', officialName: '测试保险产品',
    }],
  } });

  assert.equal(expertCalls.length, 1);
  assert.equal(received.salesTurn.executionPlan.primary.key, 'handle_age_based_delay_without_scare');
  assert.equal(received.salesTurn.executionPlan.fallbackUsed, false);
  assert.deepEqual(received.salesTurn.insuranceNeedResults, [
    { type: 'coverage_gap', status: 'needs_family_or_policy_evidence' },
    { type: 'product_facts', status: 'unavailable' },
  ]);
});

test('sales champion readiness gate blocks expert and generator calls after contact refusal', async () => {
  const question = '客户明确说不要再联系了。';
  let expertCalled = false;
  let executeCalled = false;
  const tool = createSalesChampionTool({
    interpretTurn: async () => salesProposal(question, {
      stage: { value: 'contact', confidence: 0.95 },
      concerns: [{ type: 'follow_up', priority: 'primary', confidence: 0.95 }],
      signals: { explicitRefusal: true, stopContact: true, factSensitive: false },
      proposedCapabilities: ['follow_up_consent'],
    }),
    askInsuranceExpert: async () => { expertCalled = true; return null; },
    execute() { executeCalled = true; return result(); },
  });

  const output = await tool.askSalesChampionTool({ context: {
    internalUserId: 7, intent: 'sales_coaching', question,
  } });

  assert.equal(expertCalled, false);
  assert.equal(executeCalled, false);
  assert.match(output.interaction.text, /停止联系/u);
  assert.equal(output.provenance.source, 'sales_champion_readiness_gate');
});

test('sales champion returns a structured timeout error', async () => {
  const tool = createSalesChampionTool({ timeoutMs: 5, execute: () => new Promise(() => {}) });
  await assert.rejects(
    tool.askSalesChampionTool({ context: {
      internalUserId: 7, familyId: 9, intent: 'sales_report', question: '销售报告',
    } }),
    (error) => error.code === 'AGENT_TIMEOUT' && error.status === 504,
  );
});

test('sales champion accepts the domain generator maximum timeout', () => {
  assert.doesNotThrow(() => createSalesChampionTool({
    timeoutMs: 600_000,
    execute: async () => result(),
  }));
});
