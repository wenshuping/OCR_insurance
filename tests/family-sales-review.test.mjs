import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFamilySalesReviewInput,
  buildFamilySalesReviewMessages,
  enforceVerifiedCashflowAmounts,
  reconcileVerifiedCashflowAmounts,
  generateFamilySalesReview,
  resolveFamilySalesReviewFreshness,
} from '../server/family-sales-review.service.mjs';
import {
  buildFamilySalesChatMessages,
  generateFamilySalesChatReply,
} from '../server/family-sales-chat.service.mjs';
import {
  buildFamilySalesMemoryContext,
  normalizeExtractedFamilySalesMemories,
  upsertFamilySalesMemories,
} from '../server/family-sales-memory.service.mjs';

test('sales review freshness follows active status, generatedAt, and current source timestamp', () => {
  const review = { status: 'active', generatedAt: '2026-07-11T00:00:00.000Z' };
  assert.equal(resolveFamilySalesReviewFreshness(review, { sourceUpdatedAt: '2026-07-10T00:00:00.000Z' }).status, 'fresh');
  assert.equal(resolveFamilySalesReviewFreshness(review, { sourceUpdatedAt: '2026-07-12T00:00:00.000Z' }).status, 'stale');
  assert.equal(resolveFamilySalesReviewFreshness(review, { sourceUpdatedAt: '2026-07-11T09:00:00+08:00' }).status, 'stale');
  assert.equal(resolveFamilySalesReviewFreshness({ status: 'archived', generatedAt: '2026-07-11T00:00:00.000Z' }).status, 'missing');
});

test('family sales review input keeps members without policies and official evidence', () => {
  const family = { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active', notes: '家庭年收入约80万，偏好稳健方案，张三身份证110101198606141234仅本地核验' };
  const members = [
    { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', idNumber: '110101198606141234', idNumberTail: '123456', notes: '做企业管理，喜欢先看现金流表', status: 'active' },
    { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', identityNumber: '110101198812016543', idNumberTail: '654321', notes: '关注孩子教育金，沟通偏好简短结论', status: 'active' },
  ];
  const productName = '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）';
  const policies = [
    {
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: productName,
      applicantMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberId: 10,
      insuredMemberName: '张三',
      insuredIdNumber: '110101198606141234',
      amount: 300000,
      firstPremium: 20000,
      coveragePeriod: '终身',
      paymentPeriod: '10年',
    },
  ];
  const input = buildFamilySalesReviewInput({
    family,
    members,
    policies,
    generatedAt: '2026-06-15T00:00:00.000Z',
    familyReport: {
      summary: { policyCount: 1 },
      policyInventory: { insuredGroups: [{ member: '张三', memberId: 10, policies: [] }] },
      criticalIllness: { memberScores: [{ member: '张三', gap: 300000 }] },
    },
    knowledgeRecords: [{
      id: 7,
      company: '新华保险',
      productName,
      productType: '终身寿险',
      official: true,
      sourceKind: 'insurer_official',
      evidenceLevel: 'insurer_official',
      url: 'https://official.example-life.test/ssry.pdf',
    }, {
      id: 8,
      company: '新华保险',
      productName,
      productType: '终身寿险',
      title: '第三方网页线索',
      official: false,
      sourceKind: 'open_web_reference',
      evidenceLevel: 'external_legacy_reference',
      url: 'https://reference.example.test/ssry',
    }],
    indicatorRecords: [{
      id: 'indicator-1',
      company: '新华保险',
      productName,
      coverageType: '身故或身体全残',
      liability: '身故或身体全残保险金',
      formulaText: '按现金价值、已交保费乘以比例、基本保额对应金额三者较大者给付',
    }],
  });

  assert.equal(input.members.length, 2);
  assert.equal(input.members.find((member) => member.relationLabel === '配偶')?.memberRef, '{{member_2}}');
  assert.equal(input.members.find((member) => member.relationLabel === '配偶')?.hasPolicy, false);
  assert.equal(input.members.find((member) => member.relationLabel === '本人')?.age, 40);
  assert.equal(input.family.topPillarMemberRef, '{{member_1}}');
  assert.equal(input.family.notes, family.notes);
  assert.equal(input.members.find((member) => member.relationLabel === '本人')?.notes, '做企业管理，喜欢先看现金流表');
  assert.equal(input.members.find((member) => member.relationLabel === '配偶')?.notes, '关注孩子教育金，沟通偏好简短结论');
  assert.deepEqual(input.dataQuality.membersWithoutPolicy.map((member) => member.memberRef), ['{{member_2}}']);
  assert.equal(input.policies[0].applicantMemberRef, '{{member_1}}');
  assert.equal(input.policies[0].applicantAge, 40);
  assert.equal(input.policies[0].insuredMemberRef, '{{member_1}}');
  assert.equal(input.policies[0].insuredAge, 40);
  assert.equal(input.officialEvidence.length, 1);
  assert.equal(input.officialEvidence[0].officialSources[0].url, 'https://official.example-life.test/ssry.pdf');
  assert.equal(input.officialEvidence[0].referenceSources[0].url, 'https://reference.example.test/ssry');
  assert.equal(input.officialEvidence[0].referenceSources[0].referenceOnly, true);
  assert.equal(input.officialEvidence[0].officialIndicators[0].coverageType, '身故或身体全残');

  const prompt = buildFamilySalesReviewMessages(input).map((message) => message.content).join('\n');
  assert.match(prompt, /必须先核实的数据/);
  assert.match(prompt, /最重要的保障问题/);
  assert.match(prompt, /优先销售机会/);
  assert.match(prompt, /本次面谈目标与一句核心话术/);
  assert.match(prompt, /最多 3 个/u);
  assert.match(prompt, /不得(?:编造|输出)成功概率/u);
  assert.doesNotMatch(prompt, /销售方案展开/u);
  assert.match(prompt, /不要直接输出输入 JSON 的英文内部字段名/);
  assert.match(prompt, /family\.notes 是整个家庭层面的备注，不属于某个具体成员/u);
  assert.match(prompt, /members\[\]\.notes 才是成员个人备注/u);
  assert.match(prompt, /family\.topPillarMemberRef 明确表示家庭顶梁柱/u);
  assert.match(prompt, /"topPillarMemberRef": "\{\{member_1\}\}"/u);
  assert.match(prompt, /家庭年收入约80万/);
  assert.match(prompt, /\{\{member_1\}\}身份证\{\{id_number_1\}\}仅本地核验/);
  assert.match(prompt, /\{\{id_number_1\}\}/);
  assert.match(prompt, /喜欢先看现金流表/);
  assert.match(prompt, /沟通偏好简短结论/);
  assert.match(prompt, /配偶/);
  assert.match(prompt, /\{\{member_1\}\}/);
  assert.match(prompt, /\{\{member_2\}\}/);
  assert.match(prompt, /"applicantAge": 40/);
  assert.doesNotMatch(prompt, /张三|李四|张三家庭|110101198606141234|110101198812016543|123456|654321/);
  assert.match(prompt, /https:\/\/official\.example-life\.test\/ssry\.pdf/);
  assert.match(prompt, /referenceOnly=true/u);
  assert.match(prompt, /待核实参考/u);
});

test('family sales review prompt focuses on a short evidence-led advisor workflow', () => {
  const input = buildFamilySalesReviewInput({
    family: {
      id: 1,
      familyName: '张三家庭',
      coreMemberId: 10,
      status: 'active',
      notes: '客户偏好先看结论，再看预算方案',
      planningProfile: {
        annualIncome: 800000,
        annualExpense: 360000,
        debt: 1200000,
        educationGoal: 500000,
        parentSupportGoal: 300000,
        availableAssets: 200000,
        premiumBudget: 60000,
      },
    },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '测试终身寿险',
      applicantMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberId: 10,
      insuredMemberName: '张三',
      amount: 300000,
      firstPremium: 20000,
      coveragePeriod: '终身',
      paymentPeriod: '10年',
    }],
    familyReport: {
      summary: { policyCount: 1, annualPremium: 20000 },
      radar: { family: { scores: [] }, members: [] },
      policyInventory: { insuredGroups: [] },
    },
    generatedAt: '2026-06-15T00:00:00.000Z',
  });

  const prompt = buildFamilySalesReviewMessages(input).map((message) => message.content).join('\n');
  assert.match(prompt, /优先销售机会/u);
  assert.match(prompt, /本次面谈目标/u);
  assert.match(prompt, /家庭财务规划视角/u);
  assert.match(prompt, /保险重整|保险重整建议|保单重整/u);
  assert.match(prompt, /P1|P2|P3/u);
  assert.match(prompt, /机会成熟度/u);
  assert.match(prompt, /不得(?:编造|输出)成功概率/u);
  assert.doesNotMatch(prompt, /基础方案.*标准方案.*完善方案/us);
  assert.match(prompt, /收入、支出、负债、现金储备和保费预算/u);
  assert.match(prompt, /不得承诺收益/u);
  assert.match(prompt, /"annualIncome": 800000/u);
  assert.match(prompt, /"premiumBudget": 60000/u);
});

test('family sales review requests DeepSeek pro by default with thinking enabled', async () => {
  let requestBody = null;
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', idNumber: '110101198606141234', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', identityNumber: '110101198812016543', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '测试保单',
      applicantMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberId: 11,
      insuredMemberName: '李四',
      insuredIdNumber: '110101198812016543',
    }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });
  const review = await generateFamilySalesReview({
    input,
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async (_url, options = {}) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          model: 'deepseek-v4-pro',
          choices: [{ message: { content: '## 一、销售结论摘要\n建议先联系{{member_1}}，再补充{{member_2}}资料。证件号{{id_number_1}}不应展示。' } }],
        }),
      };
    },
  });

  assert.equal(requestBody.model, 'deepseek-v4-pro');
  assert.deepEqual(requestBody.thinking, { type: 'enabled' });
  assert.equal(requestBody.reasoning_effort, 'high');
  assert.doesNotMatch(JSON.stringify(requestBody), /张三|李四|张三家庭|110101198606141234|110101198812016543/);
  assert.match(review.content, /销售结论摘要/);
  assert.match(review.content, /张三/);
  assert.match(review.content, /李四/);
  assert.match(review.content, /身份证号已脱敏/);
  assert.doesNotMatch(review.content, /110101198606141234|110101198812016543|\{\{id_number_1\}\}/);
  assert.equal(review.inputSummary.familyId, null);
});

test('family sales review keeps yearly deterministic cashflow amounts instead of model-rewritten units', async () => {
  const input = buildFamilySalesReviewInput({
    family: { id: 1, status: 'active' },
    members: [],
    policies: [{
      id: 101,
      company: '测试保险',
      name: '测试两全险',
      amount: 200000,
      cashflowEntries: [{ year: 2052, amount: 200000, liability: '满期保险金', calcText: '满期给付基本保险金额' }],
    }],
  });

  assert.deepEqual(input.policies[0].verifiedCashflow, [{
    year: 2052,
    amount: 200000,
    liability: '满期保险金',
    calcText: '满期给付基本保险金额',
  }]);
  assert.deepEqual(input.financialFacts, [{
    policyId: 101,
    productName: '测试两全险',
    entries: [{
      year: 2052,
      liability: '满期保险金',
      amount: 200000,
      amountText: '20万元',
      calculationText: '满期给付基本保险金额',
    }],
  }]);
  assert.match(buildFamilySalesReviewMessages(input).map((message) => message.content).join('\n'), /不得除以10/u);
  assert.match(enforceVerifiedCashflowAmounts('2052年确定给付 2 万元。', input), /2052年确定给付 20万元/u);
  assert.match(enforceVerifiedCashflowAmounts('2053年确定给付 2 万元。', input), /2053年确定给付 金额待核实/u);
  assert.match(
    enforceVerifiedCashflowAmounts('测试两全险的满期保险金就是2万元，不是20万元。', input),
    /满期保险金就是20万元/u,
  );
  assert.equal(reconcileVerifiedCashflowAmounts('2052年确定给付 2 万元。', input).changed, true);
  assert.equal(reconcileVerifiedCashflowAmounts('测试两全险的满期保险金就是2万元。', input).changed, true);

  let reportRequestCount = 0;
  const review = await generateFamilySalesReview({
    input,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async (_url, options = {}) => {
      reportRequestCount += 1;
      const body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          model: 'deepseek-v4-pro',
          choices: [{ message: { content: reportRequestCount === 1
            ? '## 一、本次销售结论\n- 测试两全险的满期保险金就是2万元，不是20万元，仅具象征性规划意义。'
            : '## 一、销售结论摘要\n- 现有两全险在2052年确定给付20万元，是否足以支持养老目标仍需结合家庭财务目标核实。' } }],
        }),
      };
    },
  });
  assert.equal(reportRequestCount, 2);
  assert.match(review.content, /2052年确定给付\s*20万元/u);
  assert.doesNotMatch(review.content, /2052年确定给付\s*2 万元/u);
  assert.doesNotMatch(review.content, /仅具象征性规划意义/u);
});

test('family sales review excludes conflicting cached cashflow data before analysis', () => {
  const input = buildFamilySalesReviewInput({
    family: { id: 1, status: 'active' },
    policies: [{
      id: 102,
      name: '金额待核实两全险',
      amount: 200000,
      cashflowEntries: [{
        year: 2052,
        amount: 20000,
        liability: '满期保险金',
        calcText: '基本保险金额200,000元 × 100% = 200,000元',
      }],
    }],
  });

  assert.deepEqual(input.policies[0].verifiedCashflow, []);
  assert.match(input.dataQuality.financialDataWarnings[0], /金额与计算公式不一致/u);
  assert.deepEqual(input.financialFacts, []);
  const prompt = buildFamilySalesReviewMessages(input).map((message) => message.content).join('\n');
  assert.match(prompt, /金额异常/u);
  assert.match(prompt, /不能据此判断产品价值/u);
});

test('family sales chat prompt uses privacy-safe context and restores display names', async () => {
  const requestBodies = [];
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active', notes: '张三身份证110101198606141234仅本地核验' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', idNumber: '110101198606141234', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', identityNumber: '110101198812016543', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '测试保单',
      applicantMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberId: 11,
      insuredMemberName: '李四',
      insuredIdNumber: '110101198812016543',
    }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });
  const context = {
    sourceUpdated: true,
    familyInput: input,
    latestSalesReview: {
      id: 9,
      content: '建议先联系{{member_1}}，再补充{{member_2}}资料。',
    },
  };
  const prompt = buildFamilySalesChatMessages({
    context,
    history: [{ role: 'user', content: '客户说预算不够怎么办？', createdAt: '2026-06-15T00:01:00.000Z' }],
    question: '帮我改成微信话术',
  }).map((message) => message.content).join('\n');

  assert.match(prompt, /你是一名保险营销专家/u);
  assert.match(prompt, /只能回答“我是保险营销专家/u);
  assert.match(prompt, /sourceUpdated=true/);
  assert.match(prompt, /客户说预算不够怎么办/);
  assert.match(prompt, /帮我改成微信话术/);
  assert.doesNotMatch(prompt, /张三|李四|张三家庭|110101198606141234|110101198812016543/);
  assert.match(prompt, /\{\{member_1\}\}/);
  assert.match(prompt, /\{\{id_number_1\}\}/);

  const reply = await generateFamilySalesChatReply({
    context,
    history: [{ role: 'user', content: '客户说预算不够怎么办？', createdAt: '2026-06-15T00:01:00.000Z' }],
    question: '帮我改成微信话术',
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      requestBodies.push(body);
      return {
        ok: true,
        json: async () => ({
          model: body.max_tokens === 300 ? 'deepseek-v4-flash' : 'deepseek-v4-pro',
          choices: [{
            message: {
              content: body.max_tokens === 300
                ? JSON.stringify({ intent: 'sales_script', skills: ['sales_script', 'objection_handling'], reason: '微信话术' })
                : '我是DeepSeek大模型，可以对{{member_1}}说：“我们先核实预算，再拆基础方案。” {{id_number_1}}',
            },
          }],
        }),
      };
    },
  });

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].model, 'deepseek-v4-flash');
  assert.match(JSON.stringify(requestBodies[0]), /sales_script/);
  assert.equal(requestBodies[1].model, 'deepseek-v4-pro');
  assert.deepEqual(requestBodies[1].thinking, { type: 'enabled' });
  assert.match(JSON.stringify(requestBodies[1]), /智能 skill router 选择/);
  assert.match(JSON.stringify(requestBodies[1]), /客户异议处理/);
  assert.doesNotMatch(JSON.stringify(requestBodies[1]), /张三|李四|张三家庭|110101198606141234|110101198812016543/);
  assert.match(reply.content, /保险营销专家/);
  assert.match(reply.content, /张三/);
  assert.match(reply.content, /身份证号已脱敏/);
  assert.doesNotMatch(reply.content, /DeepSeek|deepseek|大模型/u);
  assert.doesNotMatch(reply.content, /\{\{member_1\}\}|\{\{id_number_1\}\}|110101198606141234/);
});

test('family sales chat answers identity questions as insurance marketing expert without upstream model', async () => {
  let fetchCalled = false;
  const reply = await generateFamilySalesChatReply({
    question: '你是谁？你是什么大模型，是DeepSeek吗？',
    env: {},
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(reply.model, 'identity_guard');
  assert.match(reply.content, /^我是保险营销专家/u);
  assert.doesNotMatch(reply.content, /DeepSeek|deepseek|大模型/u);
});

test('family sales chat corrects a product comparison cashflow amount from the verified ledger', async () => {
  const familyInput = buildFamilySalesReviewInput({
    family: { id: 1, status: 'active' },
    policies: [{
      id: 101,
      name: '测试两全险',
      cashflowEntries: [{ year: 2052, amount: 200000, liability: '满期保险金' }],
    }],
  });
  let callCount = 0;
  const reply = await generateFamilySalesChatReply({
    context: { familyInput },
    question: '帮我对比这份计划书和现有保单',
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({
          model: callCount === 1 ? 'deepseek-v4-flash' : 'deepseek-v4-pro',
          choices: [{ message: { content: callCount === 1
            ? JSON.stringify({ intent: 'product_comparison', skills: ['product_comparison', 'policy_evidence'], reason: '产品对比' })
            : '现有保单在2052年确定给付 2 万元。' } }],
        }),
      };
    },
  });

  assert.match(reply.content, /2052年确定给付 20万元/u);
  assert.doesNotMatch(reply.content, /2052年确定给付 2 万元/u);
});

test('family sales memory context is sanitized, deduplicated, and available to chat and review prompts', () => {
  const normalized = normalizeExtractedFamilySalesMemories({
    memories: [
      { kind: 'objection', memoryKey: 'budget_objection', content: '客户担心预算压力，手机号 13800138000 不要保存', confidence: 0.91 },
      { kind: 'objection', memoryKey: 'budget_objection', content: '客户担心预算压力，手机号 13800138000 不要保存', confidence: 0.9 },
      { kind: 'strategy', content: '先讲基础方案，再约二次面谈', confidence: 0.83 },
      { kind: 'noise', content: '无效类型', confidence: 1 },
      { kind: 'todo', content: '置信度太低的不保存', confidence: 0.3 },
    ],
  });
  assert.deepEqual(normalized.map((memory) => memory.kind), ['objection', 'strategy']);
  assert.match(normalized[0].content, /手机号已脱敏/u);
  assert.doesNotMatch(normalized[0].content, /13800138000/u);

  const state = { familySalesMemories: [], nextId: 100 };
  const result = upsertFamilySalesMemories({
    state,
    familyId: 8,
    owner: { ownerGuestId: 'guest-memory' },
    sourceThreadId: 30,
    userMessage: { id: 31 },
    assistantMessage: { id: 32 },
    extractedMemories: normalized,
    allocateId: (target) => {
      const id = target.nextId;
      target.nextId += 1;
      return id;
    },
    nowIso: () => '2026-06-15T08:00:00.000Z',
  });
  assert.equal(result.changed, true);
  assert.equal(state.familySalesMemories.length, 2);
  assert.deepEqual(state.familySalesMemories[0].evidenceMessageIds, [31]);
  assert.equal(state.familySalesMemories[0].status, 'confirmed');
  assert.equal(state.familySalesMemories[1].status, 'candidate');

  const salesMemoryContext = buildFamilySalesMemoryContext(state.familySalesMemories);
  const chatPrompt = buildFamilySalesChatMessages({
    context: {
      familyInput: {},
      salesMemoryContext,
    },
    question: '继续生成微信话术',
  }).map((message) => message.content).join('\n');
  assert.match(chatPrompt, /salesMemoryContext/u);
  assert.match(chatPrompt, /客户担心预算压力/u);
  assert.match(chatPrompt, /保单事实、责任条款、金额、收益仍以当前家庭数据和官网证据为准/u);

  const reviewPrompt = buildFamilySalesReviewMessages({
    family: {},
    members: [],
    policies: [],
    report: {},
    officialEvidence: [],
    dataQuality: {},
    salesMemoryContext,
    salesChatContext: { selectedMessageCount: 1, recentMessages: [{ role: 'user', content: '本次勾选优先' }] },
  }).map((message) => message.content).join('\n');
  assert.match(reviewPrompt, /salesMemoryContext/u);
  assert.match(reviewPrompt, /salesChatContext 与 salesMemoryContext 同时存在，顾问本次勾选的 salesChatContext 优先/u);
});

test('family sales memory marks same-slot changes as conflicts and excludes them from context', () => {
  const state = { familySalesMemories: [], nextId: 200 };
  const allocateId = (target) => target.nextId++;
  upsertFamilySalesMemories({
    state,
    familyId: 8,
    owner: { ownerGuestId: 'guest-memory' },
    sourceThreadId: 30,
    userMessage: { id: 41 },
    assistantMessage: { id: 42 },
    extractedMemories: [{
      kind: 'preference',
      memoryKey: 'plan_display_order',
      content: '客户希望先看基础方案',
      normalizedValue: '基础方案优先',
      confidence: 0.92,
    }],
    allocateId,
    nowIso: () => '2026-07-10T08:00:00.000Z',
  });
  upsertFamilySalesMemories({
    state,
    familyId: 8,
    owner: { ownerGuestId: 'guest-memory' },
    sourceThreadId: 30,
    userMessage: { id: 43 },
    assistantMessage: { id: 44 },
    extractedMemories: [{
      kind: 'preference',
      memoryKey: 'plan_display_order',
      content: '客户改为先比较标准方案和完善方案',
      normalizedValue: '标准与完善方案优先',
      confidence: 0.95,
    }],
    allocateId,
    nowIso: () => '2026-07-11T08:00:00.000Z',
  });

  assert.deepEqual(state.familySalesMemories.map((memory) => memory.status), ['conflicted', 'conflicted']);
  assert.deepEqual(state.familySalesMemories.map((memory) => memory.evidenceMessageIds), [[41], [43]]);
  assert.equal(buildFamilySalesMemoryContext(state.familySalesMemories), null);
});

test('family sales memory context accepts legacy active rows but filters invalidated and future memories', () => {
  const context = buildFamilySalesMemoryContext([
    { id: 1, kind: 'objection', content: '旧数据仍可使用', status: 'active', createdAt: '2026-07-01T00:00:00.000Z' },
    { id: 2, kind: 'todo', content: '已经失效', status: 'confirmed', invalidatedAt: '2026-07-05T00:00:00.000Z' },
    { id: 3, kind: 'preference', content: '未来才生效', status: 'confirmed', validFrom: '2026-08-01T00:00:00.000Z' },
  ], { asOf: '2026-07-11T00:00:00.000Z' });

  assert.equal(context.memoryCount, 1);
  assert.equal(context.memories[0].content, '旧数据仍可使用');
});

test('family sales review keeps compressed output concise instead of appending generic plans and scripts', async () => {
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '增额终身寿示例',
      applicantMemberId: 10,
      insuredMemberId: 10,
      amount: 300000,
      firstPremium: 20000,
      coveragePeriod: '终身',
      paymentPeriod: '10年',
    }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });
  const review = await generateFamilySalesReview({
    input,
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        model: 'deepseek-v4-pro',
        choices: [{
          message: {
            content: [
              '## 六、下一步销售动作清单',
              '- 方案一：先做百万医疗险。',
              '- 方案二：给{{member_1}}补重疾险。',
              '- 3.【邀约面谈 - 切入点顺序】',
              '- 见面开场：总结已有保单。',
            ].join('\n'),
          },
        }],
      }),
    }),
  });

  assert.doesNotMatch(review.content, /销售方案展开/);
  assert.doesNotMatch(review.content, /邀约面谈与销售话术/);
  assert.doesNotMatch(review.content, /已经买过很多保险/);
  assert.match(review.content, /张三/);
  assert.match(review.content, /李四/);
  assert.doesNotMatch(review.content, /\{\{member_1\}\}|\{\{member_2\}\}/);
});

test('family sales review backfills empty priority problem and opportunity sections', async () => {
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '重疾险示例',
      applicantMemberId: 10,
      insuredMemberId: 10,
      amount: 300000,
      firstPremium: 12000,
      coveragePeriod: '终身',
      coverageIndicators: [{ coverageType: '重大疾病', liability: '重大疾病保险金' }],
    }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });

  const review = await generateFamilySalesReview({
    input,
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        model: 'deepseek-v4-pro',
        choices: [{
          message: {
            content: [
              '## 一、销售结论摘要',
              '- 先核实家庭资料。',
              '## 三、最重要的保障问题',
              '-',
              '## 四、优先销售机会',
              '暂无明确结论',
            ].join('\n'),
          },
        }],
      }),
    }),
  });

  assert.match(review.content, /最重要的保障问题/);
  assert.match(review.content, /李四（配偶）.*系统内暂未关联保单/u);
  assert.match(review.content, /优先销售机会/);
  assert.match(review.content, /新华保险 重疾险示例/);
  assert.match(review.content, /重大疾病/);
  assert.doesNotMatch(review.content, /\{\{member_1\}\}|\{\{member_2\}\}/);
});
