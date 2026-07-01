import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
  buildCustomerResponsibilitySourceDigest,
  callDeepSeekForCustomerResponsibilitySummary,
  generateProductCustomerResponsibilitySummary,
  validateCustomerResponsibilitySummaryJson,
} from '../server/product-customer-responsibility-summary.service.mjs';

const company = '新华保险';
const productName = '盛世荣耀';
const productKey = `company_product:${company}:${productName}`;
const sourceUrl = 'https://example.test/terms.pdf';
const currentSummaryVersion = 'customer-summary-v22-structured-rag';

function baseState() {
  return {
    knowledgeRecords: [
      {
        id: 1,
        company,
        productName,
        title: '盛世荣耀终身寿险条款',
        url: sourceUrl,
        pageText: [
          '第五条 保险责任',
          '身故或身体全残保险金 被保险人身故或身体全残时，保险公司按合同约定给付身故或身体全残保险金。',
          '给付金额结合已交保险费、基本保险金额、出险年龄和保单年度计算。',
          '第六条 责任免除',
        ].join('\n'),
        official: true,
      },
    ],
    insuranceIndicatorRecords: [
      {
        id: 'ind_1',
        company,
        productName,
        coverageType: '人寿保障',
        liability: '身故或身体全残保险金',
        formulaText: '身故或身体全残保险金 = max(已交保险费给付比例, 基本保险金额对应金额)',
        basis: '官方条款',
        sourceUrl,
      },
    ],
  };
}

function structuredLifeSummary(overrides = {}) {
  return {
    productCategory: 'ordinary_whole_life',
    categoryLabel: '终身寿险',
    headline: '这是一份以身故或身体全残保障为主的终身寿险。',
    responsibilities: [
      {
        title: '身故或身体全残保险金',
        plainText: '发生身故或身体全残时，保险公司按条款约定给付保险金。',
        triggerCondition: '被保险人身故或身体全残。',
        paymentRule: '金额需要结合已交保险费、基本保险金额、出险年龄和保单年度计算。',
        calculationStatus: 'claim_contingent',
      },
    ],
    productFunctions: [],
    importantNotes: ['具体金额以正式保险合同和保单载明信息为准。'],
    missingOrUnclear: [],
    ...overrides,
  };
}

function structuredPromptPayload(prompt) {
  const marker = '输入资料 JSON：';
  const index = prompt.indexOf(marker);
  assert.notEqual(index, -1);
  return JSON.parse(prompt.slice(index + marker.length).trim());
}

function baseCard() {
  return {
    id: 'card_1',
    productKey,
    company,
    productName,
    title: '身故或身体全残保险金',
    category: '人寿保障',
    plainSummary: '发生身故或身体全残时给付保险金。',
    payoutSummary: '金额结合已交保险费、基本保险金额、出险年龄和保单年度计算。',
    sourceUrl,
    sourceTitle: '盛世荣耀终身寿险条款',
    sourceExcerpt: '保险责任包括身故或身体全残保险金。',
    indicators: [
      {
        id: 'ind_1',
        liability: '身故或身体全残保险金',
        formulaText: '身故或身体全残保险金 = max(已交保险费给付比例, 基本保险金额对应金额)',
        calculationStatus: 'calculable',
      },
    ],
  };
}

function dbWithCards(cards = [baseCard()]) {
  return {
    prepare(sql) {
      if (/product_responsibility_cards/u.test(sql)) {
        return { all: () => cards };
      }
      return { all: () => [] };
    },
  };
}

test('generateProductCustomerResponsibilitySummary returns an existing database summary without calling DeepSeek', async () => {
  let modelCalls = 0;
  const existing = {
    id: `customer_summary:${productKey}:${CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION}`,
    productKey,
    company,
    productName,
    summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
    status: 'ready',
    headline: '数据库已有摘要。',
    summaryJson: {
      company,
      productName,
      headline: '数据库已有摘要。',
      mainResponsibilities: [
        {
          title: '身故或身体全残保险金',
          plainText: '数据库中的客户摘要。',
          howItPays: '',
          requiredPolicyFields: [],
          calculationKey: 'death_or_disability',
        },
      ],
      notices: [],
      requiredPolicyFields: [],
      sourceUrls: [sourceUrl],
    },
    sourceUrls: [sourceUrl],
    sourceDigest: '',
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-pro',
    generatedAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    payload: {},
  };

  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => existing,
    persistSummary: async () => {
      throw new Error('persist should not be called for an existing summary');
    },
    generateWithDeepSeek: async () => {
      modelCalls += 1;
      return {};
    },
    nowIso: () => '2026-06-29T00:01:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'database');
  assert.equal(result.summary.headline, '数据库已有摘要。');
  assert.deepEqual(Object.keys(result.summary), [
    'company',
    'productName',
    'headline',
    'mainResponsibilities',
    'notices',
    'requiredPolicyFields',
    'sourceUrls',
  ]);
  assert.deepEqual(Object.keys(result.summary.mainResponsibilities[0]), [
    'title',
    'plainText',
    'howItPays',
    'requiredPolicyFields',
  ]);
  assert.equal(result.summary.mainResponsibilities[0].calculationKey, undefined);
  assert.equal(modelCalls, 0);
});

test('customer responsibility summary version skips previously cached v1 summaries', async () => {
  let findArgs = null;
  await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async (args) => {
      findArgs = args;
      return null;
    },
    persistSummary: async (row) => row,
    generateWithDeepSeek: async () => structuredLifeSummary(),
  });

  assert.equal(CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION, currentSummaryVersion);
  assert.equal(findArgs?.summaryVersion, currentSummaryVersion);
});

test('generateProductCustomerResponsibilitySummary generates, validates, saves, and returns a new summary', async () => {
  let saved = null;
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async ({ prompt }) => {
      assert.match(prompt, /中国保险责任摘要助手/u);
      assert.match(prompt, /统一 JSON Schema/u);
      assert.match(prompt, /保险责任和产品功能分开/u);
      assert.match(prompt, /身故或身体全残保险金/u);
      assert.doesNotMatch(prompt, /整库/u);
      return structuredLifeSummary();
    },
    modelName: 'deepseek-v4-flash',
    nowIso: () => '2026-06-29T00:01:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(saved?.status, 'ready');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.equal(saved?.modelName, 'deepseek-v4-flash');
  assert.equal(saved?.summaryJson?.mainResponsibilities?.[0]?.title, '身故或身体全残保险金');
  assert.equal(saved?.payload?.summaryContext?.productKey, productKey);
  assert.equal(result.summary.headline, saved.summaryJson.headline);
});

test('generateProductCustomerResponsibilitySummary explains compound growth formulas from official sources', async () => {
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '身故或身体全残保险金 若身故或身体全残时被保险人处于18周岁保单生效对应日之后，',
      '则其身故或身体全残保险金金额为以下三者之最大者：',
      '①本保险实际交纳的保险费×给付系数；②现金价值；',
      '③基本保险金额×（1+3.5%）（n-1），其中n为保单年度数。',
    ].join(' '),
  }];

  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async () => structuredLifeSummary({
      headline: '终身寿险，提供身故或身体全残保障。',
      responsibilities: [{
        title: '身故或身体全残保险金',
        plainText: '18周岁后按已交保费×给付系数、现金价值、基本保险金额×(1+3.5%)^(n-1)三者最大者给付，其中基本保险金额按每年3.5%复利递增。',
        triggerCondition: '被保险人身故或身体全残。',
        paymentRule: '基本保险金额按每年3.5%复利递增形成给付基准。',
        calculationStatus: 'claim_contingent',
      }],
    }),
  });

  assert.equal(result.ok, true);
  assert.match(result.summary.mainResponsibilities[0].plainText, /每年3\.5%复利递增/u);
});

test('generateProductCustomerResponsibilitySummary reuses the official product name for short-name queries', async () => {
  let findArgs = null;
  let saved = null;
  const officialProductName = '新华盛世荣耀终身寿险';
  const officialProductKey = `company_product:${company}:${officialProductName}`;
  const officialCard = {
    ...baseCard(),
    productKey: officialProductKey,
    productName: officialProductName,
  };
  const state = baseState();
  state.knowledgeRecords = state.knowledgeRecords.map((record) => ({
    ...record,
    productName: officialProductName,
  }));
  state.insuranceIndicatorRecords = state.insuranceIndicatorRecords.map((record) => ({
    ...record,
    productName: officialProductName,
  }));

  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([officialCard]),
    input: { company, name: '盛世荣耀' },
    findSummary: async (args) => {
      findArgs = args;
      return null;
    },
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => structuredLifeSummary({ headline: '官方产品名摘要。' }),
  });

  assert.equal(result.ok, true);
  assert.equal(findArgs?.productKey, officialProductKey);
  assert.equal(saved?.productKey, officialProductKey);
  assert.equal(saved?.productName, officialProductName);
  assert.equal(result.summary.productName, officialProductName);
});

test('generateProductCustomerResponsibilitySummary does not cache incomplete DeepSeek summaries', async () => {
  let saved = null;
  const runs = [];
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '1.身故或身体全残保险金 被保险人于本合同生效之日起 180 日（含）内因疾病原因身故或身体全残，本公司按本保险实际交纳的保险费给付身故或身体全残保险金，本合同终止。',
    ].join(' '),
  }];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    persistGenerationRun: async (run) => {
      runs.push(run);
      return run;
    },
    generateWithDeepSeek: async () => ({
      company,
      productName,
      headline: '模型输出不完整。',
      mainResponsibilities: [{ title: '', plainText: '' }],
      notices: [],
      requiredPolicyFields: [],
      sourceUrls: [sourceUrl],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_model_review');
  assert.equal(saved, null);
  assert.equal(runs.at(-1)?.status, 'needs_model_review');
});

test.skip('generateProductCustomerResponsibilitySummary accepts Chinese section JSON from DeepSeek', async () => {
  let saved = null;
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => ({
      产品定位: '这是一款年金保险，主要提供生存领取和身故保障。',
      主要保险责任: [
        {
          责任名称: '关爱年金',
          内容: '被保险人生存至约定日期时，保险公司按条款给付关爱年金。',
          给付方式: '首次按基本责任保险费的 10% 给付，之后按 1% 给付。',
        },
        {
          名称: '生存保险金',
          说明: '被保险人生存至约定日期时，保险公司按基本责任保险金额的 9% 给付。',
        },
      ],
      主要功能: ['提供长期生存领取'],
      适合解决的问题: ['养老现金流规划'],
      不适合解决的问题: ['医疗费用报销'],
      免责或风险提示: ['分红不保证'],
      来源链接: [sourceUrl],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.equal(result.summary.headline, '这是一款年金保险，主要提供生存领取和身故保障。');
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['关爱年金', '生存保险金']);
  assert.match(result.summary.mainResponsibilities[0].howItPays, /10%/u);
  assert.match(result.summary.notices.join('\n'), /分红不保证/u);
});

test.skip('generateProductCustomerResponsibilitySummary flattens nested Chinese responsibility sections from DeepSeek', async () => {
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async () => ({
      产品定位: '这是一款分红型年金保险，主要提供长期生存领取。',
      主要保险责任: {
        基本责任: {
          关爱年金: '犹豫期结束次日给付首次保费的10%；之后每年给付首次保费的1%。',
          生存保险金: '约定期间按基本责任保险金额的9%给付。',
        },
        可选责任: {
          祝寿金: '60岁生存时给付可选责任保险金额。',
        },
      },
      免责或风险提示: '分红是不确定利益，可能为零。',
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['关爱年金', '生存保险金', '祝寿金']);
  assert.match(result.summary.mainResponsibilities[0].plainText, /10%/u);
  assert.match(result.summary.notices.join('\n'), /分红/u);
});

test.skip('generateProductCustomerResponsibilitySummary extracts titles from grouped Chinese responsibility text', async () => {
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async () => ({
      产品定位: '这是一款分红型年金保险，主要提供长期生存领取。',
      主要保险责任: {
        基本责任: [
          '关爱年金：犹豫期结束次日给付首次保费的10%；之后每年给付首次保费的1%。',
          '生存保险金：约定期间按基本责任保险金额的9%给付。',
        ],
        可选责任: [
          '祝寿金：60岁生存时给付可选责任保险金额。',
        ],
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['关爱年金', '生存保险金', '祝寿金']);
  assert.match(result.summary.mainResponsibilities[0].plainText, /10%/u);
});

test.skip('generateProductCustomerResponsibilitySummary extracts titles when DeepSeek uses category as item title', async () => {
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async () => ({
      产品定位: '这是一款分红型年金保险，主要提供长期生存领取。',
      主要保险责任: [
        { 标题: '基本责任', 内容: '关爱年金：犹豫期结束次日给付首次保费的10%；之后每年给付首次保费的1%。' },
        { 标题: '基本责任', 内容: '生存保险金：约定期间按基本责任保险金额的9%给付。' },
        { 标题: '可选责任', 内容: '祝寿金：60岁生存时给付可选责任保险金额。' },
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['关爱年金', '生存保险金', '祝寿金']);
  assert.match(result.summary.mainResponsibilities[0].plainText, /10%/u);
});

test.skip('generateProductCustomerResponsibilitySummary extracts titles from main responsibility category items', async () => {
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async () => ({
      产品定位: '终身寿险，提供身故或身体全残保障。',
      主要保险责任: [
        { 标题: '主要保险责任', 内容: '身故或身体全残保险金：按条款约定给付。' },
        { 标题: '主要保险责任', 内容: '特定公共交通工具意外伤害身故或身体全残保险金：额外给付基本保额。' },
      ],
    }),
  });

  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), [
    '身故或身体全残保险金',
    '特定公共交通工具意外伤害身故或身体全残保险金',
  ]);
});

test('generateProductCustomerResponsibilitySummary returns model review when DeepSeek returns empty', async () => {
  let modelCalls = 0;
  let saved = null;
  const runs = [];
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '1.身故或身体全残保险金 被保险人身故或身体全残，本公司按合同约定给付身故或身体全残保险金。',
    ].join(' '),
  }];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    persistGenerationRun: async (run) => {
      runs.push(run);
      return run;
    },
    generateWithDeepSeek: async () => {
      modelCalls += 1;
      return {
        summary: '',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_model_review');
  assert.equal(modelCalls, 1);
  assert.equal(saved, null);
  assert.equal(runs.at(-1)?.status, 'needs_model_review');
});

test('generateProductCustomerResponsibilitySummary returns model review when DeepSeek returns headline only', async () => {
  let saved = null;
  const runs = [];
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '1.身故或身体全残保险金 被保险人身故或身体全残，本公司按合同约定给付身故或身体全残保险金。',
    ].join(' '),
  }];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    persistGenerationRun: async (run) => {
      runs.push(run);
      return run;
    },
    generateWithDeepSeek: async () => ({
      产品定位: '终身寿险，主要提供身故或全残保障，保额随时间增长。',
      主要保险责任: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_model_review');
  assert.equal(saved, null);
  assert.equal(runs.at(-1)?.status, 'needs_model_review');
});

test.skip('generateProductCustomerResponsibilitySummary preserves DeepSeek age condition titles', async () => {
  let saved = null;
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '1.身故保险金 18周岁前返还已交保险费；18周岁后给付基本保险金额。',
      '2.身体全残保险金 18周岁前返还已交保险费；18周岁后给付基本保险金额。',
    ].join(' '),
  }];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => ({
      产品定位: '终身寿险，主要提供身故或身体全残保障。',
      主要保险责任: [
        { 标题: '18周岁前', 内容: '返还已交保险费' },
        { 标题: '18周岁后', 内容: '基本保险金额' },
        { 标题: '不确定利益', 内容: '分红不保证，可能为零。' },
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['18周岁前', '18周岁后', '不确定利益']);
});

test.skip('generateProductCustomerResponsibilitySummary preserves DeepSeek policy-anniversary condition titles', async () => {
  let saved = null;
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '身故或身体全残保险金 被保险人身故或身体全残，我们按合同约定给付身故或身体全残保险金。',
    ].join(' '),
  }];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => ({
      产品定位: '终身寿险，提供身故或身体全残保障。',
      主要保险责任: [
        { 标题: '180日内因疾病', 内容: '给付已交保险费。' },
        { 标题: '18周岁保单周年日前', 内容: '已交保险费与现金价值二者较大者。' },
        { 标题: '18周岁保单周年日后且交费期间届满后', 内容: '三者较大者。' },
        { 标题: '给付系数', 内容: '按年龄确定。' },
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), [
    '180日内因疾病',
    '18周岁保单周年日前',
    '18周岁保单周年日后且交费期间届满后',
    '给付系数',
  ]);
});

test.skip('generateProductCustomerResponsibilitySummary preserves DeepSeek generic responsibility labels', async () => {
  let saved = null;
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '身故或身体全残保险金 被保险人身故或身体全残，我们按合同约定给付身故或身体全残保险金。',
    ].join(' '),
  }];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => ({
      产品定位: '终身寿险，提供身故或身体全残保障。',
      主要保险责任: [
        { 标题: '描述', 内容: '被保险人在保险期间内身故或身体全残，按约定给付保险金。' },
        { 标题: '说明', 内容: '分红不保证。' },
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['描述', '说明']);
});

test.skip('generateProductCustomerResponsibilitySummary preserves DeepSeek responsibility string', async () => {
  let saved = null;
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '身故或身体全残保险金 被保险人身故或身体全残，我们按合同约定给付身故或身体全残保险金。',
    ].join(' '),
  }];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => ({
      产品定位: '终身寿险，提供身故或身体全残保障。',
      主要保险责任: '被保险人身故或身体全残时，保险公司按合同约定给付身故或身体全残保险金。',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['主要保险责任']);
  assert.match(result.summary.mainResponsibilities[0].plainText, /身故或身体全残/u);
});

test.skip('generateProductCustomerResponsibilitySummary preserves DeepSeek condition titles', async () => {
  let saved = null;
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '身故或身体全残保险金 被保险人身故或身体全残，我们按合同约定给付身故或身体全残保险金。',
    ].join(' '),
  }];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => ({
      产品定位: '终身寿险，提供身故或身体全残保障。',
      主要保险责任: [
        { 标题: '条件', 内容: '合同生效180天内因疾病身故或全残：退已交保费，合同终止。' },
        { 标题: '条件2', 内容: '合同生效180天内因意外，或180天后因任何原因身故或全残：按以下分情形给付，合同终止。' },
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['条件', '条件2']);
});

test.skip('generateProductCustomerResponsibilitySummary preserves DeepSeek titles without semantic filtering', async () => {
  let saved = null;
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => ({
      产品定位: '终身寿险。',
      主要保险责任: [
        { 标题: '产品定位', 内容: 'DeepSeek 若把这个作为责任标题，解析层也只负责展示。' },
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.deepEqual(result.summary.mainResponsibilities.map((item) => item.title), ['产品定位']);
});

test('customer summary records model review when DeepSeek throws', async () => {
  let saved = null;
  const runs = [];
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '第五条 保险责任',
      '1.身故保险金 被保险人身故，本公司按保险责任正文约定给付身故保险金。',
    ].join(' '),
    responsibilitySummary: '短摘要不应使用。',
  }];
  const card = {
    ...baseCard(),
    title: '错误卡片责任',
    sourceExcerpt: '错误卡片责任 按卡片兜底。',
  };

  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([card]),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    persistGenerationRun: async (run) => {
      runs.push(run);
      return run;
    },
    generateWithDeepSeek: async () => {
      const error = new Error('DeepSeek unavailable');
      error.code = 'DEEPSEEK_REQUEST_FAILED';
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_model_review');
  assert.equal(saved, null);
  assert.equal(runs.at(-1)?.status, 'needs_model_review');
  assert.match(runs.at(-1)?.qualityIssues?.[0]?.code || '', /DEEPSEEK_REQUEST_FAILED/u);
});

test('fallback customer summary does not use responsibility cards when DeepSeek throws and official summary is missing', async () => {
  let persisted = false;
  const result = await generateProductCustomerResponsibilitySummary({
    state: { knowledgeRecords: [], insuranceIndicatorRecords: [] },
    db: dbWithCards([baseCard()]),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async () => {
      persisted = true;
      throw new Error('persist should not be called for card-only fallback');
    },
    generateWithDeepSeek: async () => {
      const error = new Error('DeepSeek unavailable');
      error.code = 'DEEPSEEK_REQUEST_FAILED';
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_source_review');
  assert.equal(result.message, '这个产品还缺少可用于客户摘要的官网保险责任资料。');
  assert.equal(persisted, false);
});

test('generateProductCustomerResponsibilitySummary sends product guidance and official responsibility text to DeepSeek', async () => {
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    productName: `${productName}（分红型）`,
    responsibilitySummary: '官网保险责任摘要：主要提供身故或身体全残保险金。',
    pageText: '第五条 保险责任\n身故或身体全残保险金 被保险人身故或身体全残时给付。基本保险金额×（1+1.75%）（n-1）。\n第六条 责任免除',
  }];
  let promptContext = null;
  let promptText = '';

  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([baseCard()]),
    input: { company, name: `${productName}（分红型）` },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async ({ prompt }) => {
      promptText = prompt;
      promptContext = structuredPromptPayload(prompt);
      return structuredLifeSummary({
        headline: '这是一款分红型终身寿险，基本保险金额按合同约定递增，主要提供身故或身体全残保障。',
        importantNotes: ['具体金额以正式保险合同和保单载明信息为准。'],
      });
    },
  });

  assert.equal(result.ok, true);
  assert.match(promptText, /统一 JSON Schema/u);
  assert.match(promptText, /productFunctions/u);
  assert.match(promptText, /importantNotes/u);
  assert.match(promptText, /只使用输入 sourceSections/u);
  assert.equal(promptContext?.officialResponsibilitySummaries, undefined);
  assert.doesNotMatch(promptText, /官网保险责任摘要：主要提供/u);
  assert.equal(promptContext?.validationRules, undefined);
  assert.equal(promptContext?.responsibilityCards, undefined);
  assert.match(promptContext?.sourceSections?.mainResponsibilityText || '', /身故或身体全残保险金/u);
  assert.equal(result.summary.headline, '这是一款分红型终身寿险，基本保险金额按合同约定递增，主要提供身故或身体全残保障。');
});

test('generateProductCustomerResponsibilitySummary uses official analysis when local sources are missing', async () => {
  let officialAnalysisCalls = 0;
  let modelCalls = 0;
  let saved = null;

  const result = await generateProductCustomerResponsibilitySummary({
    state: { knowledgeRecords: [], insuranceIndicatorRecords: [] },
    db: dbWithCards([]),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateOfficialAnalysis: async (request) => {
      officialAnalysisCalls += 1;
      assert.equal(request.company, company);
      assert.equal(request.productName, productName);
      return {
        coverageTable: [{
          coverageType: '身故或身体全残保险金',
          scenario: '官网条款显示：被保险人身故或身体全残时承担保险责任。',
          payout: '按合同实际交纳的保险费给付身故或身体全残保险金。',
          note: '本合同终止。',
        }],
        sources: [{
          title: '官网条款PDF',
          url: sourceUrl,
          evidenceLabel: '保险公司官网',
          official: true,
        }],
      };
    },
    generateWithDeepSeek: async ({ prompt, cards, records, indicators }) => {
      modelCalls += 1;
      assert.equal(cards.length, 1);
      assert.equal(records.length, 1);
      assert.equal(indicators.length, 0);
      assert.equal(cards[0].sourceUrl, sourceUrl);
      assert.match(prompt, /官网条款显示/u);
      assert.doesNotMatch(prompt, /formulaText|疾病全残 =/u);
      return structuredLifeSummary({
        headline: '这是一款主要提供身故或身体全残保障的保险。',
        importantNotes: ['具体金额以正式保险合同和保单载明信息为准。'],
      });
    },
    nowIso: () => '2026-06-29T00:03:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(officialAnalysisCalls, 1);
  assert.equal(modelCalls, 1);
  assert.equal(saved?.status, 'ready');
  assert.equal(saved?.modelProvider, 'deepseek');
  assert.equal(saved?.summaryJson?.mainResponsibilities?.[0]?.title, '身故或身体全残保险金');
});

test('generateProductCustomerResponsibilitySummary sends only official responsibility excerpts to DeepSeek', async () => {
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    pageText: [
      '投保须知 这部分不属于保险责任。',
      '第五条 保险责任',
      '身故或身体全残保险金 被保险人身故或身体全残，我们按合同约定给付身故或身体全残保险金。',
      '第六条 责任免除',
      '因下列情形之一导致被保险人身故的，我们不承担保险责任。',
      '第七条 现金价值权益 投保人可以申请保单贷款。',
    ].join('\n'),
  }];
  let promptText = '';
  let promptContext = null;

  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([baseCard()]),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async ({ prompt }) => {
      promptText = prompt;
      promptContext = structuredPromptPayload(prompt);
      return structuredLifeSummary({
        headline: '这是一款主要提供身故或身体全残保障的保险。',
        responsibilities: [{
          title: '身故或身体全残保险金',
          plainText: '被保险人身故或身体全残时，保险公司按官网责任正文承担给付责任。',
          triggerCondition: '被保险人身故或身体全残。',
          paymentRule: '按合同约定给付身故或身体全残保险金。',
          calculationStatus: 'claim_contingent',
        }],
      });
    },
  });

  assert.equal(result.ok, true);
  assert.match(promptText, /保险责任/u);
  assert.match(promptText, /身故或身体全残保险金/u);
  assert.doesNotMatch(promptContext?.sourceSections?.mainResponsibilityText || '', /投保须知/u);
  assert.doesNotMatch(promptContext?.sourceSections?.mainResponsibilityText || '', /因下列情形之一/u);
  assert.doesNotMatch(promptContext?.sourceSections?.mainResponsibilityText || '', /保单贷款/u);
});

test('generateProductCustomerResponsibilitySummary preserves long official responsibility excerpts', async () => {
  const filler = '轻度疾病保险金 被保险人确诊轻度疾病时，保险公司按基本保险金额的20%给付。'.repeat(45);
  const state = baseState();
  state.knowledgeRecords = [{
    ...state.knowledgeRecords[0],
    productName: '新华人寿保险股份有限公司多倍保障少儿重大疾病保险（超越版）',
    pageText: [
      '第五条 保险责任',
      filler,
      '身故保险金 被保险人因意外伤害原因或于等待期后因疾病原因身故，本公司按合同约定给付身故保险金，本合同终止。',
      '第六条 责任免除',
      '因下列情形之一导致被保险人身故的，我们不承担保险责任。',
    ].join(' '),
  }];
  let promptContext = null;

  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([]),
    input: { company, name: '新华人寿保险股份有限公司多倍保障少儿重大疾病保险（超越版）' },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async ({ prompt }) => {
      promptContext = structuredPromptPayload(prompt);
      return {
        productCategory: 'critical_illness',
        categoryLabel: '重大疾病保险',
        headline: '这是一款少儿重大疾病保险，主要提供疾病和身故保障。',
        responsibilities: [{
          title: '等待期',
          plainText: '等待期内出险按条款约定处理。',
          triggerCondition: '合同约定等待期内。',
          paymentRule: '以条款约定为准。',
          calculationStatus: 'not_calculable',
        }, {
          title: '轻度疾病保险金',
          plainText: '被保险人确诊合同约定轻度疾病时，保险公司按条款给付轻度疾病保险金。',
          triggerCondition: '确诊合同约定轻度疾病。',
          paymentRule: '按基本保险金额的20%给付。',
          calculationStatus: 'claim_contingent',
        }, {
          title: '身故保险金',
          plainText: '被保险人身故时按合同约定给付身故保险金。',
          triggerCondition: '被保险人身故。',
          paymentRule: '按合同约定给付。',
          calculationStatus: 'claim_contingent',
        }],
        productFunctions: [],
        importantNotes: ['等待期和给付次数以合同约定为准。'],
        missingOrUnclear: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.match(promptContext?.sourceSections?.mainResponsibilityText || '', /身故保险金/u);
  assert.doesNotMatch(promptContext?.sourceSections?.mainResponsibilityText || '', /责任免除/u);
});

test('validateCustomerResponsibilitySummaryJson does not reject DeepSeek internal metadata fields', () => {
  const result = validateCustomerResponsibilitySummaryJson({
    company,
    productName,
    headline: '内部字段不应导致摘要失败。',
    mainResponsibilities: [
      {
        coverageType: '身故保险金',
        scenario: '被保险人身故时给付。',
        payout: '按基本保险金额给付。',
        calculationKey: 'death_basic_amount',
        calculationStatus: 'claim_contingent',
      },
    ],
    notices: [],
    requiredPolicyFields: [],
    sourceUrls: [sourceUrl],
  }, { allowedTitles: new Set(['身故保险金']), allowedSourceUrls: new Set([sourceUrl]) });

  assert.equal(result.headline, '内部字段不应导致摘要失败。');
  assert.equal(result.mainResponsibilities[0].title, '身故保险金');
  assert.equal(result.mainResponsibilities[0].plainText, '被保险人身故时给付。');
});

test('validateCustomerResponsibilitySummaryJson allows DeepSeek to summarize responsibility wording freely', () => {
  const result = validateCustomerResponsibilitySummaryJson({
    company,
    productName,
    headline: '这是一份身故或身体全残保障总结。',
    mainResponsibilities: [
      {
        title: '保证责任',
        plainText: '18周岁后按已交保费×给付系数、现金价值和基本保险金额×(1+2.5%)^(保单年度-1)三者较大者给付。',
        howItPays: '',
        requiredPolicyFields: [],
      },
    ],
    notices: [],
    requiredPolicyFields: [],
    sourceUrls: ['https://model.example/free-summary'],
  }, {
    allowedTitles: new Set(['身故或身体全残保险金']),
    allowedSourceUrls: new Set([sourceUrl]),
  });

  assert.equal(result.mainResponsibilities[0].title, '保证责任');
  assert.match(result.mainResponsibilities[0].plainText, /已交保费×给付系数/u);
  assert.deepEqual(result.sourceUrls, ['https://model.example/free-summary']);
});

test('validateCustomerResponsibilitySummaryJson accepts productSummary as headline', () => {
  const result = validateCustomerResponsibilitySummaryJson({
    company,
    productName,
    productSummary: '这是一款年金保险，主要提供生存领取和身故保障。',
    mainResponsibilities: [
      {
        title: '生存保险金',
        plainText: '被保险人生存至约定日期时，保险公司按合同约定给付生存保险金。',
        howItPays: '',
        requiredPolicyFields: [],
      },
    ],
    notices: [],
    requiredPolicyFields: [],
    sourceUrls: [sourceUrl],
  });

  assert.equal(result.headline, '这是一款年金保险，主要提供生存领取和身故保障。');
});

test('validateCustomerResponsibilitySummaryJson accepts wrapped DeepSeek summary payloads', () => {
  const result = validateCustomerResponsibilitySummaryJson({
    result: {
      company,
      productName,
      headline: '这是一款少儿重大疾病保险，主要提供轻症、中症和重疾保障。',
      mainResponsibilities: [
        {
          title: '重大疾病保险金',
          plainText: '被保险人确诊合同约定重大疾病时，保险公司按合同约定给付重大疾病保险金。',
          howItPays: '',
          requiredPolicyFields: ['基本保险金额'],
        },
      ],
      notices: '等待期以合同约定为准。',
      requiredPolicyFields: ['基本保险金额'],
      sourceUrls: [sourceUrl],
    },
  });

  assert.equal(result.headline, '这是一款少儿重大疾病保险，主要提供轻症、中症和重疾保障。');
  assert.deepEqual(result.notices, ['等待期以合同约定为准。']);
});

test('generateProductCustomerResponsibilitySummary requires company and product name', async () => {
  await assert.rejects(
    () => generateProductCustomerResponsibilitySummary({ input: { company } }),
    (error) => {
      assert.equal(error.code, 'POLICY_RESPONSIBILITY_QUERY_INPUT_REQUIRED');
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('callDeepSeekForCustomerResponsibilitySummary normalizes timeout and network errors', async () => {
  await assert.rejects(
    () => callDeepSeekForCustomerResponsibilitySummary({
      prompt: '摘要',
      env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_TIMEOUT_MS: '1000' },
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    }),
    (error) => {
      assert.equal(error.code, 'DEEPSEEK_REQUEST_TIMEOUT');
      assert.equal(error.status, 502);
      return true;
    },
  );

  await assert.rejects(
    () => callDeepSeekForCustomerResponsibilitySummary({
      prompt: '摘要',
      env: { DEEPSEEK_API_KEY: 'test-key' },
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    }),
    (error) => {
      assert.equal(error.code, 'DEEPSEEK_REQUEST_FAILED');
      assert.equal(error.status, 502);
      return true;
    },
  );
});

test('callDeepSeekForCustomerResponsibilitySummary logs raw response shape without API key', async () => {
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => {
    logs.push(args);
  };
  try {
    const result = await callDeepSeekForCustomerResponsibilitySummary({
      prompt: '摘要',
      company,
      productName,
      env: {
        DEEPSEEK_API_KEY: 'test-secret-key',
        DEEPSEEK_MODEL: 'deepseek-test-model',
      },
      fetchImpl: async () => new Response(JSON.stringify({
        id: 'chatcmpl_test',
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              headline: '终身寿险摘要。',
              mainResponsibilities: [
                {
                  title: '主要保险责任',
                  plainText: '身故或身体全残保险金。',
                },
              ],
            }),
          },
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });

    assert.equal(result.headline, '终身寿险摘要。');
  } finally {
    console.info = originalInfo;
  }

  const serializedLogs = JSON.stringify(logs);
  assert.match(serializedLogs, /DeepSeek raw response/u);
  assert.match(serializedLogs, /DeepSeek parsed response shape/u);
  assert.match(serializedLogs, /主要保险责任/u);
  assert.doesNotMatch(serializedLogs, /test-secret-key/u);
});

test('generateProductCustomerResponsibilitySummary returns needs_source_review when source cards are missing', async () => {
  const result = await generateProductCustomerResponsibilitySummary({
    state: { knowledgeRecords: [], insuranceIndicatorRecords: [] },
    db: dbWithCards([]),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async () => {
      throw new Error('persist should not be called without source context');
    },
    generateWithDeepSeek: async () => {
      throw new Error('model should not be called without source context');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_source_review');
  assert.equal(result.message, '这个产品还缺少可用于客户摘要的保险责任来源。');
});

test('generateProductCustomerResponsibilitySummary tolerates card table query failures when official records exist', async () => {
  let modelCalls = 0;
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: {
      prepare() {
        throw new Error('no such table: product_responsibility_cards');
      },
    },
    input: { company, productName },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async () => {
      modelCalls += 1;
      return structuredLifeSummary({ headline: '官方资料摘要。' });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(modelCalls, 1);
});

test('structured critical illness context produces prompt, ready v22 metadata, and passed run', async () => {
  const product = '新华人寿保险股份有限公司多倍保障少儿重大疾病保险（超越版）';
  const state = {
    knowledgeRecords: [
      {
        company,
        productName: product,
        productType: '重疾险',
        title: '条款',
        official: true,
        url: sourceUrl,
        pageText: [
          '第五条 保险责任',
          '等待期 90日。',
          '轻度疾病保险金 按基本保险金额20%给付。',
          '中度疾病保险金 按基本保险金额50%给付。',
          '重度疾病保险金 按基本保险金额、已交保险费较大者给付，疾病分组并有累计给付限额。',
          '身故保险金 18周岁前后分情形。',
          '少儿前10年关爱保险金 按基本保险金额给付。',
          '成人意外伤害特定疾病或身故关爱保险金 按基本保险金额的50%给付。',
          '豁免保险费 累计给付达到基本保险金额时豁免。',
          '第六条 本合同保障的疾病列表',
          '轻度疾病共40项，中度疾病共20项，重度疾病共130项，所有疾病分为5组。',
        ].join('\n'),
      },
    ],
    insuranceIndicatorRecords: [],
  };
  const savedRows = [];
  const runRows = [];

  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([]),
    input: { company, name: product },
    findSummary: async () => null,
    persistSummary: async (row) => {
      savedRows.push(row);
      return row;
    },
    persistGenerationRun: async (run) => {
      runRows.push(run);
      return run;
    },
    generateWithDeepSeek: async ({ prompt }) => {
      assert.match(prompt, /重大疾病保险模板/u);
      assert.match(prompt, /少儿前10年关爱保险金/u);
      return {
        productCategory: 'critical_illness',
        categoryLabel: '重大疾病保险',
        headline: '少儿重疾保障。',
        responsibilities: [
          { title: '等待期', plainText: '90日', triggerCondition: '等待期内', paymentRule: '按条款约定', calculationStatus: 'not_calculable' },
          { title: '轻度疾病保险金', plainText: '轻度疾病给付，受累计给付限额约束。', triggerCondition: '确诊轻度疾病', paymentRule: '基本保险金额20%', calculationStatus: 'claim_contingent' },
          { title: '中度疾病保险金', plainText: '中度疾病给付。', triggerCondition: '确诊中度疾病', paymentRule: '基本保险金额50%', calculationStatus: 'claim_contingent' },
          { title: '重度疾病保险金', plainText: '重度疾病给付，疾病分组并有累计给付限额。', triggerCondition: '确诊重度疾病', paymentRule: '基本保险金额或已交保险费较大者', calculationStatus: 'claim_contingent' },
          { title: '身故保险金', plainText: '18周岁前后分情形。', triggerCondition: '身故', paymentRule: '按条款约定', calculationStatus: 'claim_contingent' },
          { title: '少儿前10年关爱保险金', plainText: '前10年符合条件额外关爱给付。', triggerCondition: '符合少儿前10年关爱条件', paymentRule: '基本保险金额', calculationStatus: 'claim_contingent' },
          { title: '成人意外伤害特定疾病或身故关爱保险金', plainText: '成人意外特定疾病或身故关爱给付。', triggerCondition: '符合成人意外关爱条件', paymentRule: '基本保险金额50%', calculationStatus: 'claim_contingent' },
          { title: '豁免保险费', plainText: '达到约定条件后豁免后续保费。', triggerCondition: '累计给付达到基本保险金额', paymentRule: '豁免后续保险费', calculationStatus: 'waiver_only' },
        ],
        productFunctions: [],
        importantNotes: ['疾病定义以条款为准。'],
        missingOrUnclear: [],
      };
    },
    nowIso: () => '2026-07-01T00:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(savedRows[0]?.summaryVersion, currentSummaryVersion);
  assert.equal(savedRows[0]?.payload?.productCategory, 'critical_illness');
  assert.equal(savedRows[0]?.payload?.qualityGate?.status, 'passed');
  assert.equal(runRows.at(-1)?.status, 'passed');
  assert.ok(result.summary.mainResponsibilities.some((item) => item.title === '少儿前10年关爱保险金'));
  assert.equal(result.summary.company, company);
  assert.equal(result.summary.productName, product);
  assert.equal(result.summary.productCategory, undefined);
});

test('quality gate failure persists needs_model_review run without ready summary', async () => {
  const savedRows = [];
  const runRows = [];
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards([]),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async (row) => {
      savedRows.push(row);
      return row;
    },
    persistGenerationRun: async (run) => {
      runRows.push(run);
      return run;
    },
    generateWithDeepSeek: async () => ({
      productCategory: 'ordinary_whole_life',
      categoryLabel: '终身寿险',
      headline: '缺少责任。',
      responsibilities: [],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_model_review');
  assert.equal(savedRows.length, 0);
  assert.equal(runRows.at(-1)?.status, 'needs_model_review');
  assert.ok(runRows.at(-1)?.qualityIssues?.length > 0);
});

test('source failure returns review status and persists needs_source_review run', async () => {
  const runRows = [];
  const result = await generateProductCustomerResponsibilitySummary({
    state: {
      knowledgeRecords: [{
        company,
        productName,
        title: '第三方介绍',
        official: false,
        url: sourceUrl,
        pageText: '第五条 保险责任\n身故保险金。',
      }],
      insuranceIndicatorRecords: [],
    },
    db: dbWithCards([]),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async () => {
      throw new Error('source failure should not persist ready summary');
    },
    persistGenerationRun: async (run) => {
      runRows.push(run);
      return run;
    },
    generateWithDeepSeek: async () => {
      throw new Error('model should not run for source failure');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_source_review');
  assert.equal(runRows.at(-1)?.status, 'needs_source_review');
});

test('extraction failure returns review status and persists needs_extraction_review run', async () => {
  const runRows = [];
  const result = await generateProductCustomerResponsibilitySummary({
    state: {
      knowledgeRecords: [{
        company,
        productName,
        title: '官方条款',
        official: true,
        url: sourceUrl,
        pageText: '产品介绍 身故保险金和基本保险金额说明，但缺少保险责任章节。',
      }],
      insuranceIndicatorRecords: [],
    },
    db: dbWithCards([]),
    input: { company, name: productName },
    findSummary: async () => null,
    persistSummary: async () => {
      throw new Error('extraction failure should not persist ready summary');
    },
    persistGenerationRun: async (run) => {
      runRows.push(run);
      return run;
    },
    generateWithDeepSeek: async () => {
      throw new Error('model should not run for extraction failure');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_extraction_review');
  assert.equal(runRows.at(-1)?.status, 'needs_extraction_review');
  assert.deepEqual(runRows.at(-1)?.qualityIssues, [{ code: 'responsibility_chapter_missing' }]);
});

test('buildCustomerResponsibilitySourceDigest changes when source context changes', () => {
  const first = buildCustomerResponsibilitySourceDigest({
    cards: [baseCard()],
    indicators: baseState().insuranceIndicatorRecords,
    records: baseState().knowledgeRecords,
  });
  const second = buildCustomerResponsibilitySourceDigest({
    cards: [{ ...baseCard(), sourceExcerpt: '新的条款摘录' }],
    indicators: baseState().insuranceIndicatorRecords,
    records: baseState().knowledgeRecords,
  });

  assert.notEqual(first, second);
});
