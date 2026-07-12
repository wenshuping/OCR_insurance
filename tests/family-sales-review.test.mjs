import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFamilySalesReviewInput,
  buildFamilySalesReviewMessages,
  generateFamilySalesReview,
} from '../server/family-sales-review.service.mjs';
import {
  buildFamilySalesChatMessages,
  generateFamilySalesChatReply,
} from '../server/family-sales-chat.service.mjs';
import {
  applyFamilySalesMemoryAction,
  buildFamilySalesMemoryTransitionBundle,
  buildFamilySalesMemoryContext,
  extractFamilySalesMemories,
  normalizeExtractedFamilySalesMemories,
  upsertFamilySalesMemories,
} from '../server/family-sales-memory.service.mjs';

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
  assert.match(prompt, /成员级保障缺口/);
  assert.match(prompt, /理财险\/财富传承销售机会/);
  assert.match(prompt, /销售方案展开/);
  assert.match(prompt, /邀约面谈与销售话术/);
  assert.match(prompt, /适合对象、客户痛点、推荐方向、预算\/保额口径、销售话术、需补资料、下一步动作/);
  assert.match(prompt, /见面开场、风险洞察提问、保障缺口切入、理财险\/养老教育金切入、促成面谈\/二次沟通/);
  assert.match(prompt, /已经买过很多保险/);
  assert.match(prompt, /暂时不想增加预算/);
  assert.match(prompt, /理财险收益不确定/);
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

test('family sales review prompt combines sales skills into executable advisor workflow', () => {
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
  assert.match(prompt, /交叉销售机会/u);
  assert.match(prompt, /客户复盘会议策略/u);
  assert.match(prompt, /年金、寿险、养老\/教育金机会/u);
  assert.match(prompt, /家庭财务规划视角/u);
  assert.match(prompt, /保险重整|保险重整建议|保单重整/u);
  assert.match(prompt, /会前.*会中.*会后|会前准备|会后跟进/u);
  assert.match(prompt, /P1|P2|P3/u);
  assert.match(prompt, /成功概率|机会优先级/u);
  assert.match(prompt, /基础方案.*标准方案.*完善方案/us);
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

test('family sales memory context is sanitized, deduplicated, and available to chat and review prompts', () => {
  const normalized = normalizeExtractedFamilySalesMemories({
    memories: [
      { kind: 'objection', content: '客户担心预算压力，手机号 13800138000 不要保存', confidence: 0.91 },
      { kind: 'objection', content: '客户担心预算压力，手机号 13800138000 不要保存', confidence: 0.9 },
      { kind: 'strategy', content: '先讲基础方案，再约二次面谈', confidence: 0.83 },
      { kind: 'preference', content: '微信联系时先看简短结论', confidence: 0.88 },
      { kind: 'noise', content: '无效类型', confidence: 1 },
      { kind: 'todo', content: '置信度太低的不保存', confidence: 0.3 },
    ],
  });
  assert.deepEqual(normalized.map((memory) => memory.kind), ['objection', 'strategy', 'preference']);
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
  assert.equal(state.familySalesMemories.length, 3);
  assert.deepEqual(state.familySalesMemories[0].evidenceMessageIds, [31]);
  assert.deepEqual(state.familySalesMemories.map((memory) => memory.status), ['candidate', 'candidate', 'confirmed']);

  const salesMemoryContext = buildFamilySalesMemoryContext(state.familySalesMemories);
  const chatPrompt = buildFamilySalesChatMessages({
    context: {
      familyInput: {},
      salesMemoryContext,
    },
    question: '继续生成微信话术',
  }).map((message) => message.content).join('\n');
  assert.match(chatPrompt, /salesMemoryContext/u);
  assert.match(chatPrompt, /微信联系时先看简短结论/u);
  assert.doesNotMatch(chatPrompt, /客户担心预算压力|先讲基础方案/u);
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

test('family sales memory actions govern temporal transitions without mutating input', () => {
  const actor = { type: 'advisor', id: 7 };
  const candidate = Object.freeze({ id: 41, kind: 'todo', content: '补充资料', status: 'candidate', version: 1, createdAt: '2026-07-11T00:00:00.000Z' });
  const confirmed = applyFamilySalesMemoryAction({
    memory: candidate,
    action: 'confirm',
    actor,
    reasonCode: 'user_confirmation',
    expectedVersion: 1,
    now: '2026-07-12T08:00:00.000Z',
  });
  assert.equal(candidate.status, 'candidate');
  assert.equal(confirmed.memory.status, 'confirmed');
  assert.equal(confirmed.memory.version, 2);
  assert.equal(confirmed.memory.validFrom, '2026-07-12T08:00:00.000Z');
  assert.deepEqual(confirmed.event.previous, { status: 'candidate', version: 1 });
  assert.deepEqual(confirmed.event.next, { status: 'confirmed', version: 2 });

  const completed = applyFamilySalesMemoryAction({ memory: confirmed.memory, action: 'complete', actor, reasonCode: 'todo_completed', expectedVersion: 2, now: '2026-07-12T09:00:00.000Z' });
  assert.equal(completed.memory.status, 'completed');
  assert.equal(completed.memory.validTo, '2026-07-12T09:00:00.000Z');
  assert.equal(completed.memory.invalidatedAt, '2026-07-12T09:00:00.000Z');

  const restored = applyFamilySalesMemoryAction({ memory: completed.memory, action: 'restore', actor, reasonCode: 'restored_after_review', expectedVersion: 3, now: '2026-07-12T10:00:00.000Z' });
  assert.equal(restored.memory.status, 'candidate');
  assert.equal(restored.memory.validTo, null);
  assert.equal(restored.memory.invalidatedAt, null);

  const rejected = applyFamilySalesMemoryAction({ memory: candidate, action: 'reject', actor, reasonCode: 'advisor_rejection', expectedVersion: 1, now: '2026-07-12T08:00:00.000Z' });
  const expired = applyFamilySalesMemoryAction({ memory: candidate, action: 'expire', actor, reasonCode: 'expired_by_date', expectedVersion: 1, now: '2026-07-12T08:00:00.000Z' });
  assert.equal(rejected.memory.status, 'rejected');
  assert.equal(expired.memory.status, 'expired');
});

test('supersede returns a confirmed replacement and privacy-safe chain event', () => {
  const memory = { id: 51, familyId: 8, ownerUserId: 9, kind: 'preference', content: '旧手机号 13800138000', status: 'active', version: 4, validFrom: '2026-07-01T00:00:00.000Z' };
  const result = applyFamilySalesMemoryAction({
    memory,
    action: 'supersede',
    actor: { type: 'system', id: 1 },
    reasonCode: 'advisor_correction',
    note: '王先生住西湖区，护照 ABC123456789，微信 client@example.com，手机号 13800138000',
    replacement: { id: 52, content: '微信联系时使用简短文字', familyId: 999, ownerUserId: 999, kind: 'preference', validFrom: '2026-07-12T16:00:00+08:00' },
    expectedVersion: 4,
    now: '2026-07-12T08:00:00.000Z',
  });
  assert.equal(result.memory.status, 'superseded');
  assert.equal(result.memory.validTo, result.replacement.validFrom);
  assert.equal(result.replacement.status, 'confirmed');
  assert.equal(result.replacement.supersedesMemoryId, 51);
  assert.equal(result.memory.supersededByMemoryId, 52);
  assert.equal(result.replacement.familyId, 8);
  assert.equal(result.replacement.ownerUserId, 9);
  assert.equal(result.replacement.version, 1);
  assert.deepEqual(result.events.map((event) => event.memoryId), [51, 52]);
  assert.deepEqual(Object.keys(result.event).sort(), ['action', 'actor', 'memoryId', 'next', 'previous', 'reason', 'source', 'time', 'version']);
  assert.doesNotMatch(JSON.stringify(result.event), /110101198606141234|13800138000|ABC123456789|client@example\.com|旧手机号|微信联系/u);
  assert.equal(result.event.reason, 'advisor_correction');
});

test('supersede enforces canonical acyclic ids and monotonic valid intervals', () => {
  const actor = { type: 'advisor', id: 7 };
  const memory = { id: 'mem_old', kind: 'preference', content: '旧偏好', status: 'confirmed', version: 2, validFrom: '2026-07-12T08:00:00.000Z' };
  const base = { memory, action: 'supersede', actor, reasonCode: 'advisor_correction', expectedVersion: 2, now: '2026-07-12T09:00:00.000Z', existingMemories: [memory] };
  assert.throws(() => applyFamilySalesMemoryAction({ ...base, replacement: { id: 'mem_old', content: '新偏好' } }), /must differ/u);
  assert.throws(() => applyFamilySalesMemoryAction({ ...base, replacement: { id: 'bad id with spaces', content: '新偏好' } }), /bounded opaque/u);
  assert.throws(() => applyFamilySalesMemoryAction({ ...base, replacement: { id: 'mem_new', content: '新偏好', validFrom: '2026-07-12T07:59:59.999Z' } }), /cannot precede/u);
  assert.throws(() => applyFamilySalesMemoryAction({
    ...base,
    memory: { ...memory, supersedesMemoryId: 'mem_new' },
    replacement: { id: 'mem_new', content: '新偏好' },
  }), /cycle/u);

  const equalBoundary = applyFamilySalesMemoryAction({
    ...base,
    replacement: { id: 'mem_new', content: '新偏好', supersedesMemoryId: 'mem_old', validFrom: memory.validFrom },
  });
  assert.equal(equalBoundary.memory.validTo, memory.validFrom);
  assert.equal(equalBoundary.memory.supersededByMemoryId, 'mem_new');
  assert.equal(equalBoundary.replacement.supersedesMemoryId, 'mem_old');
  assert.throws(() => applyFamilySalesMemoryAction({
    ...base,
    replacement: { id: 'mem_future', content: '未来偏好', validFrom: '2026-07-12T09:00:00.001Z' },
  }), (error) => error.code === 'SCHEDULED_SUPERSEDE_UNSUPPORTED');
});

test('supersede validates the bounded authoritative graph and exposes a transaction bundle', () => {
  const scope = { familyId: 8, ownerUserId: 7 };
  const first = { id: 101, ...scope, kind: 'preference', content: '一', status: 'superseded', version: 2, supersededByMemoryId: 102 };
  const second = { id: 102, ...scope, kind: 'preference', content: '二', status: 'superseded', version: 2, supersedesMemoryId: 101, supersededByMemoryId: 103 };
  const third = { id: 103, ...scope, kind: 'preference', content: '三', status: 'confirmed', version: 2, supersedesMemoryId: 102, validFrom: '2026-07-12T08:00:00.000Z' };
  const base = { memory: third, action: 'supersede', actor: { type: 'advisor', id: 7 }, reasonCode: 'advisor_correction', expectedVersion: 2, now: '2026-07-12T09:00:00.000Z' };
  assert.throws(() => applyFamilySalesMemoryAction({ ...base, replacement: { id: 104, content: '四' }, existingMemories: [first, second, { ...third, supersededByMemoryId: 101 }] }), /cycle/u);
  assert.throws(() => applyFamilySalesMemoryAction({ ...base, replacement: { id: 105, content: '重复' }, existingMemories: [first, second, third, { id: 105, ...scope }] }), /already exists/u);
  assert.throws(() => applyFamilySalesMemoryAction({ ...base, replacement: { id: 104, content: '四' }, existingMemories: [first, { ...second, familyId: 9 }, third] }), /cross-scope/u);
  assert.throws(() => applyFamilySalesMemoryAction({ ...base, replacement: { id: 104, content: '四' }, existingMemories: Array.from({ length: 1_001 }, (_, id) => ({ id: id + 1 })) }), /exceeds limit/u);

  const bundle = buildFamilySalesMemoryTransitionBundle({ ...base, replacement: { id: 104, content: '四' }, existingMemories: [first, second, third] });
  assert.deepEqual(bundle.memories.map((memory) => memory.id), [103, 104]);
  assert.deepEqual(bundle.events.map((event) => event.memoryId), [103, 104]);
});

test('legacy active versionless memory transitions as confirmed version one', () => {
  const legacy = { id: 81, kind: 'todo', content: '旧待办', status: 'active' };
  const result = applyFamilySalesMemoryAction({ memory: legacy, action: 'complete', actor: { type: 'service', id: 3 }, reasonCode: 'todo_completed', expectedVersion: 1, now: '2026-07-12' });
  assert.equal(result.event.previous.status, 'confirmed');
  assert.equal(result.event.previous.version, 1);
  assert.equal(result.memory.version, 2);
  assert.equal(result.memory.status, 'completed');
});

test('memory actions reject illegal and stale changes without mutation', () => {
  const memory = { id: 61, kind: 'preference', content: '偏好文字', status: 'confirmed', version: 2 };
  const snapshot = structuredClone(memory);
  const actor = { type: 'advisor', id: 7 };
  assert.throws(() => applyFamilySalesMemoryAction({ memory, action: 'complete', actor, reasonCode: 'todo_completed', expectedVersion: 2, now: '2026-07-12T08:00:00.000Z' }), /only todo/u);
  assert.throws(() => applyFamilySalesMemoryAction({ memory, action: 'reject', actor, reasonCode: 'advisor_rejection', expectedVersion: 2, now: '2026-07-12T08:00:00.000Z' }), /illegal/u);
  assert.throws(() => applyFamilySalesMemoryAction({ memory, action: 'expire', actor, reasonCode: 'expired_by_date', expectedVersion: 1, now: '2026-07-12T08:00:00.000Z' }), /stale/u);
  assert.throws(() => applyFamilySalesMemoryAction({ memory, action: 'expire', actor, reasonCode: 'free form reason', expectedVersion: 2, now: '2026-07-12T08:00:00.000Z' }), /reasonCode/u);
  assert.throws(() => applyFamilySalesMemoryAction({ memory, action: 'expire', actor: { type: 'advisor', id: 'raw-advisor-id' }, reasonCode: 'expired_by_date', expectedVersion: 2, now: '2026-07-12T08:00:00.000Z' }), /server-owned/u);
  assert.throws(() => applyFamilySalesMemoryAction({ memory, action: 'expire', actor, reasonCode: 'expired_by_date', expectedVersion: 2, now: '2026-07-12T08:00:00' }), /zoned ISO/u);
  assert.throws(() => applyFamilySalesMemoryAction({ memory, action: 'expire', actor, reasonCode: 'expired_by_date', expectedVersion: 2, now: 'not-a-date' }), /zoned ISO/u);
  assert.deepEqual(memory, snapshot);
});

test('memory actions normalize equivalent timezone instants and date-only UTC', () => {
  const memory = { id: 71, kind: 'todo', content: '补资料', status: 'confirmed', version: 1 };
  const base = { memory, action: 'complete', actor: { type: 'service', id: 3 }, reasonCode: 'todo_completed', expectedVersion: 1 };
  const utc = applyFamilySalesMemoryAction({ ...base, now: '2026-07-12T08:00:00.000Z' });
  const offset = applyFamilySalesMemoryAction({ ...base, now: '2026-07-12T16:00:00+08:00' });
  const dateOnly = applyFamilySalesMemoryAction({ ...base, now: '2026-07-12' });
  assert.equal(offset.event.time, utc.event.time);
  assert.equal(dateOnly.event.time, '2026-07-12T00:00:00.000Z');
});

test('memory extraction treats only the user message as a fact source', async () => {
  let requestBody;
  const extracted = await extractFamilySalesMemories({
    userMessage: { content: '客户偏好微信文字联系' },
    assistantMessage: { content: '客户预算100万元，身份证110101198606141234' },
    existingMemories: [{ kind: 'strategy', content: '推荐高预算方案', status: 'confirmed' }],
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"memories":[]}' } }] }) };
    },
  });
  assert.deepEqual(extracted, []);
  const prompt = JSON.stringify(requestBody.messages);
  assert.match(prompt, /客户偏好微信文字联系/u);
  assert.doesNotMatch(prompt, /预算100万元|110101198606141234|推荐高预算方案/u);
});

test('memory extraction fails closed on excessive inputs and model responses', async () => {
  assert.deepEqual(normalizeExtractedFamilySalesMemories(Array.from({ length: 33 }, () => ({ kind: 'preference', content: '文字联系', confidence: 1 }))), []);
  let requestBody;
  const extracted = await extractFamilySalesMemories({
    userMessage: { content: '偏好文字联系' },
    env: { DEEPSEEK_API_KEY: 'test-key', FAMILY_SALES_MEMORY_MAX_TOKENS: '999999', FAMILY_SALES_MEMORY_TIMEOUT_MS: '999999' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, text: async () => 'x'.repeat(100_001) };
    },
  });
  assert.equal(requestBody.max_tokens, 4_000);
  assert.deepEqual(extracted, []);
});

test('family sales review appends expanded plans and scripts when the model compresses them', async () => {
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

  assert.match(review.content, /销售方案展开/);
  assert.match(review.content, /适合对象/);
  assert.match(review.content, /客户痛点/);
  assert.match(review.content, /预算\/保额口径/);
  assert.match(review.content, /需补资料/);
  assert.match(review.content, /邀约面谈与销售话术/);
  assert.match(review.content, /“我这次不是来推某一款产品/);
  assert.match(review.content, /已经买过很多保险/);
  assert.match(review.content, /暂时不想增加预算/);
  assert.match(review.content, /理财险收益不确定/);
  assert.match(review.content, /张三/);
  assert.match(review.content, /李四/);
  assert.doesNotMatch(review.content, /\{\{member_1\}\}|\{\{member_2\}\}/);
});

test('family sales review backfills empty member gap and product sections', async () => {
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
              '## 三、成员级保障缺口',
              '-',
              '## 五、已有产品逐项切入建议',
              '暂无明确结论',
            ].join('\n'),
          },
        }],
      }),
    }),
  });

  assert.match(review.content, /成员级保障缺口/);
  assert.match(review.content, /李四（配偶）.*系统内暂未关联保单/u);
  assert.match(review.content, /已有产品逐项切入建议/);
  assert.match(review.content, /新华保险 重疾险示例/);
  assert.match(review.content, /重大疾病/);
  assert.doesNotMatch(review.content, /\{\{member_1\}\}|\{\{member_2\}\}/);
});
