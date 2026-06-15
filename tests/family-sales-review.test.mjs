import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFamilySalesReviewInput,
  buildFamilySalesReviewMessages,
  generateFamilySalesReview,
} from '../server/family-sales-review.service.mjs';

test('family sales review input keeps members without policies and official evidence', () => {
  const family = { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' };
  const members = [
    { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', idNumberTail: '123456', status: 'active' },
    { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', idNumberTail: '654321', status: 'active' },
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
      url: 'https://official.example-life.test/ssry.pdf',
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
  assert.deepEqual(input.dataQuality.membersWithoutPolicy.map((member) => member.memberRef), ['{{member_2}}']);
  assert.equal(input.policies[0].applicantMemberRef, '{{member_1}}');
  assert.equal(input.policies[0].applicantAge, 40);
  assert.equal(input.policies[0].insuredMemberRef, '{{member_1}}');
  assert.equal(input.policies[0].insuredAge, 40);
  assert.equal(input.officialEvidence.length, 1);
  assert.equal(input.officialEvidence[0].officialSources[0].url, 'https://official.example-life.test/ssry.pdf');
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
  assert.match(prompt, /配偶/);
  assert.match(prompt, /\{\{member_1\}\}/);
  assert.match(prompt, /\{\{member_2\}\}/);
  assert.match(prompt, /"applicantAge": 40/);
  assert.doesNotMatch(prompt, /张三|李四|张三家庭|123456|654321/);
  assert.match(prompt, /https:\/\/official\.example-life\.test\/ssry\.pdf/);
});

test('family sales review requests DeepSeek pro by default with thinking enabled', async () => {
  let requestBody = null;
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', status: 'active' },
    ],
    policies: [],
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
          choices: [{ message: { content: '## 一、销售结论摘要\n建议先联系{{member_1}}，再补充{{member_2}}资料。' } }],
        }),
      };
    },
  });

  assert.equal(requestBody.model, 'deepseek-v4-pro');
  assert.deepEqual(requestBody.thinking, { type: 'enabled' });
  assert.equal(requestBody.reasoning_effort, 'high');
  assert.doesNotMatch(JSON.stringify(requestBody), /张三|李四|张三家庭/);
  assert.match(review.content, /销售结论摘要/);
  assert.match(review.content, /张三/);
  assert.match(review.content, /李四/);
  assert.equal(review.inputSummary.familyId, null);
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
