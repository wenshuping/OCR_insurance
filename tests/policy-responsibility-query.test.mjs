import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLocalKnowledgeResponsibilityAnalysis,
  queryPolicyAndPlanResponsibilities,
  queryPolicyResponsibilities,
} from '../server/policy-responsibility-query.mjs';
import { findKnowledgeProductCandidates } from '../server/policy-knowledge.service.mjs';

test('responsibility query retries once when the first model response is empty', async () => {
  const calls = [];
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '新华保险 安鑫优选终身护理保险 护理保险金 疾病身故保险金',
      data: {
        company: '新华保险',
        name: '安鑫优选终身护理保险',
        coveragePeriod: '终身',
        amount: 60312,
        firstPremium: 2400,
      },
    },
    query: async (input) => {
      calls.push(input);
      if (calls.length === 1) return { coverageTable: [] };
      return {
        coverageTable: [
          {
            coverageType: '护理保险金',
            scenario: '被保险人达到护理保险金给付条件',
            payout: '按合同约定给付护理保险金',
            note: '给付后合同终止',
          },
        ],
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.coverageTable.length, 1);
  assert.equal(result.coverageTable[0].coverageType, '护理保险金');
});

test('responsibility query can limit retry attempts for manual online lookup', async () => {
  const calls = [];
  await assert.rejects(
    () =>
      queryPolicyResponsibilities({
        scan: {
          ocrText: '新华保险 尊享人生两全',
          data: {
            company: '新华保险',
            name: '尊享人生两全',
          },
        },
        maxAttempts: 1,
        query: async (input) => {
          calls.push(input);
          return { coverageTable: [] };
        },
      }),
    /保险责任查询未返回责任明细/u,
  );

  assert.equal(calls.length, 1);
});

test('responsibility query uses local knowledge before Feishu knowledge lookup', async () => {
  let feishuCalled = false;
  const calls = [];
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '中国平安 平安福 身故保险金',
      data: {
        company: '中国平安',
        name: '平安福',
      },
    },
    knowledgeRecords: [
      {
        company: '中国平安',
        productName: '平安福',
        title: '平安福保险条款',
        url: 'https://life.pingan.com/products/pinganfu-local.pdf',
        pageText: '平安福保险责任包括身故保险金。',
        official: true,
        sourceType: 'pdf',
      },
    ],
    resolveFeishuKnowledgeRecords: async () => {
      feishuCalled = true;
      return [];
    },
    query: async (input) => {
      calls.push(input);
      return {
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按合同约定给付',
          },
        ],
      };
    },
  });

  assert.equal(feishuCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].knowledgeRecords[0].url, 'https://life.pingan.com/products/pinganfu-local.pdf');
  assert.equal(result.coverageTable[0].coverageType, '身故保险金');
});

test('responsibility query uses Feishu knowledge before falling back to the current query path', async () => {
  const calls = [];
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '中国平安 平安福 重大疾病保险金',
      data: {
        company: '中国平安',
        name: '平安福',
      },
    },
    knowledgeRecords: [],
    resolveFeishuKnowledgeRecords: async ({ policy }) => {
      assert.equal(policy.company, '中国平安');
      assert.equal(policy.name, '平安福');
      return [
        {
          company: '中国平安',
          productName: '平安福',
          title: '平安福飞书条款',
          url: 'https://life.pingan.com/products/pinganfu-feishu.pdf',
          pageText: '平安福保险责任包括重大疾病保险金。',
          official: true,
          sourceType: 'pdf',
          evidenceLabel: '飞书知识库官方资料',
        },
      ];
    },
    query: async (input) => {
      calls.push(input);
      return {
        coverageTable: [
          {
            coverageType: '重大疾病保险金',
            scenario: '被保险人确诊合同约定重大疾病',
            payout: '按合同约定给付',
          },
        ],
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].knowledgeRecords[0].url, 'https://life.pingan.com/products/pinganfu-feishu.pdf');
  assert.equal(calls[0].knowledgeRecords[0].evidenceLabel, '飞书知识库官方资料');
  assert.equal(result.coverageTable[0].coverageType, '重大疾病保险金');
});

test('knowledge product candidates fuzzy match similar local official products', () => {
  const matches = findKnowledgeProductCandidates({
    policy: { company: '新华保险', name: '尊享人生两全' },
    officialDomainProfiles: [
      {
        company: '新华保险',
        aliases: ['新华保险', '新华人寿'],
        siteDomains: ['static-cdn.newchinalife.com'],
        officialDomains: ['static-cdn.newchinalife.com'],
      },
    ],
    records: [
      {
        company: '新华保险',
        productName: '尊享人生年金保险（分红型）',
        title: '尊享人生年金保险（分红型）',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
        pageText: '保险责任包括关爱年金、生存保险金、身故或身体全残保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
        title: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
        pageText: '保险责任包括生存保险金、满期保险金、身故保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
      {
        company: '新华保险',
        productName: '健康无忧重大疾病保险',
        title: '健康无忧重大疾病保险',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/health.pdf',
        pageText: '保险责任包括重大疾病保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
  });

  assert.ok(matches.length >= 2);
  assert.ok(matches.some((match) => match.productName === '尊享人生年金保险（分红型）'));
  assert.ok(matches.some((match) => match.productName === '新华人寿保险股份有限公司尊尚人生两全保险（分红型）'));
  assert.equal(matches.some((match) => match.productName === '健康无忧重大疾病保险'), false);
});

test('responsibility assistant returns local responsibility text as one raw row without model call', async () => {
  let modelCalled = false;
  const responsibilityText =
    '保险责任 在本合同保险期间内，本公司承担下列保险责任：1.生存保险金 被保险人生存至约定日期，本公司按基本保险金额给付生存保险金。2.身故保险金 被保险人身故，本公司按合同约定给付身故保险金。';
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '新华保险 尊尚人生两全保险',
      data: {
        company: '新华保险',
        name: '尊尚人生两全保险',
      },
    },
    preferLocalKnowledgeAnswer: true,
    officialDomainProfiles: [
      {
        company: '新华保险',
        aliases: ['新华保险', '新华人寿'],
        siteDomains: ['static-cdn.newchinalife.com'],
        officialDomains: ['static-cdn.newchinalife.com'],
      },
    ],
    knowledgeRecords: [
      {
        company: '新华保险',
        productName: '尊尚人生两全保险',
        title: '尊尚人生两全保险条款',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
        pageText: responsibilityText,
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
    query: async () => {
      modelCalled = true;
      return { coverageTable: [] };
    },
  });

  assert.equal(modelCalled, false);
  assert.equal(result.coverageTable.length, 1);
  assert.equal(result.coverageTable[0].coverageType, '保险责任');
  assert.match(result.coverageTable[0].scenario, /保险责任\n\n在本合同保险期间内/u);
  assert.match(result.coverageTable[0].scenario, /1\. 生存保险金\n被保险人生存至约定日期/u);
  assert.match(result.coverageTable[0].scenario, /2\. 身故保险金\n被保险人身故/u);
  assert.equal(result.coverageTable[0].payout, '');
  assert.equal(result.coverageTable[0].sourceUrl, 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf');
  assert.equal(result.coverageTable[0].sourceTitle, '尊尚人生两全保险条款');
  assert.equal(result.sources[0].url, 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf');
  assert.equal(result.rawAnalysis.generatedBy, 'local_knowledge_fast_path');
});

test('multi-plan responsibility query tags local knowledge sources with each plan product', async () => {
  let modelCalled = false;
  const mainProductName = '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）';
  const linkedProductName = '新华人寿保险股份有限公司鑫天利卓越版养老年金保险（万能型）';
  const result = await queryPolicyAndPlanResponsibilities({
    scan: {
      ocrText: '新华保险 盛世恒盈年金保险 鑫天利卓越版养老年金保险',
      data: {
        company: '新华保险',
        name: mainProductName,
        plans: [
          {
            role: 'main',
            name: '盛世恒盈年金保险（分红型）',
            matchedProductName: mainProductName,
          },
          {
            role: 'linked_account',
            name: '鑫天利卓越版养老年金保险（万能型）',
            matchedProductName: linkedProductName,
          },
        ],
      },
    },
    preferLocalKnowledgeAnswer: true,
    knowledgeRecords: [
      {
        company: '新华保险',
        productName: mainProductName,
        title: `${mainProductName}条款`,
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/main.pdf',
        pageText: '保险责任 在本合同保险期间内，我们承担生存保险金责任。',
        official: true,
        sourceType: 'pdf',
      },
      {
        company: '新华保险',
        productName: linkedProductName,
        title: `${linkedProductName}条款`,
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/linked.pdf',
        pageText: '保险责任 在本合同保险期间内，我们承担养老年金和身故保险金责任。',
        official: true,
        sourceType: 'pdf',
      },
    ],
    query: async () => {
      modelCalled = true;
      return { coverageTable: [] };
    },
  });

  assert.equal(modelCalled, false);
  assert.equal(result.coverageTable.length, 2);
  assert.deepEqual(
    result.sources.map((source) => source.productName),
    [mainProductName, linkedProductName],
  );
});

test('local knowledge responsibility analysis falls back to a single row for unsegmented text', () => {
  const result = buildLocalKnowledgeResponsibilityAnalysis([
    {
      productName: '测试产品',
      title: '测试产品条款',
      url: 'https://official.example.test/policy.pdf',
      pageText: '保险责任 在本合同保险期间内，本公司按照合同约定承担保险责任并给付保险金。',
      official: true,
    },
  ]);

  assert.equal(result.coverageTable.length, 1);
  assert.equal(result.coverageTable[0].coverageType, '保险责任');
  assert.equal(result.coverageTable[0].scenario, '保险责任\n\n在本合同保险期间内，本公司按照合同约定承担保险责任并给付保险金。');
  assert.equal(result.coverageTable[0].payout, '');
  assert.equal(result.coverageTable[0].sourceUrl, 'https://official.example.test/policy.pdf');
  assert.equal(result.coverageTable[0].sourceTitle, '测试产品条款');
});
