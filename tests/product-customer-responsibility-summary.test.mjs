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

function baseState() {
  return {
    knowledgeRecords: [
      {
        id: 1,
        company,
        productName,
        title: '盛世荣耀终身寿险条款',
        url: sourceUrl,
        pageText: '保险责任包括身故或身体全残保险金。金额结合已交保险费、基本保险金额、出险年龄和保单年度计算。',
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
    modelName: 'deepseek-v4-flash',
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
      assert.match(prompt, /客户可读的保险责任摘要/u);
      assert.match(prompt, /身故或身体全残保险金/u);
      assert.doesNotMatch(prompt, /整库/u);
      return {
        company,
        productName,
        headline: '这是一份以身故或身体全残保障为主的终身寿险。',
        mainResponsibilities: [
          {
            title: '身故或身体全残保险金',
            plainText: '发生身故或身体全残时，保险公司按条款约定给付保险金。',
            howItPays: '金额需要结合已交保险费、基本保险金额、出险年龄和保单年度计算。',
            requiredPolicyFields: ['已交保险费', '基本保险金额', '出险年龄', '保单年度'],
          },
        ],
        notices: ['具体金额需要结合保单信息计算。'],
        requiredPolicyFields: ['已交保险费', '基本保险金额', '出险年龄', '保单年度'],
        sourceUrls: [sourceUrl],
      };
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
    generateWithDeepSeek: async () => ({
      company,
      productName: officialProductName,
      headline: '官方产品名摘要。',
      mainResponsibilities: [
        {
          title: '身故或身体全残保险金',
          plainText: '发生身故或身体全残时给付保险金。',
          howItPays: '按条款约定。',
          requiredPolicyFields: [],
        },
      ],
      notices: [],
      requiredPolicyFields: [],
      sourceUrls: [sourceUrl],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(findArgs?.productKey, officialProductKey);
  assert.equal(saved?.productKey, officialProductKey);
  assert.equal(saved?.productName, officialProductName);
  assert.equal(result.summary.productName, officialProductName);
});

test('validateCustomerResponsibilitySummaryJson rejects internal metadata fields', () => {
  assert.throws(
    () =>
      validateCustomerResponsibilitySummaryJson({
        company,
        productName,
        headline: '内部字段不应出现。',
        mainResponsibilities: [
          {
            title: '身故保险金',
            plainText: '按条款给付。',
            howItPays: '按基本保险金额。',
            requiredPolicyFields: [],
            calculationKey: 'death_basic_amount',
          },
        ],
        notices: [],
        requiredPolicyFields: [],
        sourceUrls: [sourceUrl],
      }, { allowedTitles: new Set(['身故保险金']), allowedSourceUrls: new Set([sourceUrl]) }),
    /内部字段/u,
  );
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
      return {
        company,
        productName,
        headline: '官方资料摘要。',
        mainResponsibilities: [
          {
            title: '身故或身体全残保险金',
            plainText: '根据官方资料给付。',
            howItPays: '按条款约定。',
            requiredPolicyFields: [],
          },
        ],
        notices: [],
        requiredPolicyFields: [],
        sourceUrls: [sourceUrl],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(modelCalls, 1);
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
