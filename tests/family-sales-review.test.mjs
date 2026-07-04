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
                : '可以对{{member_1}}说：“我们先核实预算，再拆基础方案。” {{id_number_1}}',
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
  assert.match(JSON.stringify(requestBodies[1]), /DeepSeek skill router 选择/);
  assert.match(JSON.stringify(requestBodies[1]), /客户异议处理/);
  assert.doesNotMatch(JSON.stringify(requestBodies[1]), /张三|李四|张三家庭|110101198606141234|110101198812016543/);
  assert.match(reply.content, /张三/);
  assert.match(reply.content, /身份证号已脱敏/);
  assert.doesNotMatch(reply.content, /\{\{member_1\}\}|\{\{id_number_1\}\}|110101198606141234/);
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
