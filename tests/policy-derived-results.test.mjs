import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPolicyDerivedResult,
  deriveIndicatorProductKeys,
  derivePolicyProductKeys,
  mergePolicyDerivedResult,
  productKeyFromParts,
} from '../server/policy-derived-results.service.mjs';

test('product key prefers canonical product id and normalizes company product fallback', () => {
  assert.equal(productKeyFromParts({ canonicalProductId: 'product_abc' }), 'canonical:product_abc');
  assert.equal(
    productKeyFromParts({ company: ' 新华保险 ', productName: ' 多倍保障重大疾病保险 ' }),
    'company_product:新华保险:多倍保障重大疾病保险',
  );
});

test('policy product keys include main policy and plan products', () => {
  const keys = derivePolicyProductKeys({
    company: '新华保险',
    name: '多倍保障重大疾病保险',
    canonicalProductId: 'product_main',
    plans: [
      { name: '附加住院医疗', company: '新华保险' },
      { matchedProductName: '附加重疾豁免', canonicalProductId: 'product_rider' },
    ],
  });

  assert.deepEqual(keys, [
    'canonical:product_main',
    'company_product:新华保险:多倍保障重大疾病保险',
    'company_product:新华保险:附加住院医疗',
    'canonical:product_rider',
    'company_product:新华保险:附加重疾豁免',
  ]);
});

test('indicator product keys mirror policy key priority', () => {
  assert.deepEqual(
    deriveIndicatorProductKeys({
      canonicalProductId: 'product_main',
      company: '新华保险',
      productName: '多倍保障重大疾病保险',
    }),
    [
      'canonical:product_main',
      'company_product:新华保险:多倍保障重大疾病保险',
    ],
  );
});

test('buildPolicyDerivedResult stores attached indicators and status metadata', () => {
  const policy = { id: 10, company: '新华保险', name: '多倍保障重大疾病保险', amount: 500000 };
  const indicator = {
    id: 'ind_1',
    company: '新华保险',
    productName: '多倍保障重大疾病保险',
    coverageType: '重疾',
    liability: '重大疾病保险金',
  };
  const row = buildPolicyDerivedResult({
    policy,
    indicatorRecords: [indicator],
    knowledgeRecords: [],
    optionalResponsibilityRecords: [],
    productIndicatorVersions: [{ productKey: 'company_product:新华保险:多倍保障重大疾病保险', version: 3 }],
    now: '2026-06-15T00:00:00.000Z',
  });

  assert.equal(row.policyId, 10);
  assert.equal(row.status, 'ready');
  assert.deepEqual(row.productKeys, ['company_product:新华保险:多倍保障重大疾病保险']);
  assert.equal(row.coverageIndicators.length, 1);
  assert.deepEqual(row.indicatorVersions, { 'company_product:新华保险:多倍保障重大疾病保险': 3 });
});

test('buildPolicyDerivedResult stores responsibility cards and verifies existing indicators', () => {
  const policy = {
    id: 10,
    company: '新华保险',
    name: '尊享人生年金保险（分红型）',
    amount: 100000,
    firstPremium: 12000,
  };
  const indicator = {
    id: 'ind_annuity_1',
    company: '新华保险',
    productName: '尊享人生年金保险（分红型）',
    coverageType: '现金流',
    liability: '关爱年金',
    value: 1,
    unit: '%',
    basis: '首次交纳的基本责任的保险费',
    formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
    condition: '生存',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
    sourceExcerpt: '关爱年金如被保险人生存，本公司按首次交纳的基本责任的保险费的1%给付。',
  };

  const row = buildPolicyDerivedResult({
    policy,
    indicatorRecords: [indicator],
    knowledgeRecords: [],
    optionalResponsibilityRecords: [],
    productIndicatorVersions: [],
    now: '2026-06-22T00:00:00.000Z',
  });

  assert.equal(row.responsibilityCards.length, 1);
  assert.equal(row.responsibilityCards[0].title, '关爱年金');
  assert.equal(row.responsibilityCards[0].indicators[0].calculationEligible, true);
  assert.equal(row.responsibilityCards[0].indicators[0].basisKey, 'first_basic_responsibility_premium');
});

test('buildPolicyDerivedResult filters knowledge fallback sources for responsibility cards', () => {
  const row = buildPolicyDerivedResult({
    policy: {
      id: 10,
      company: '测试保险',
      name: '安心一号',
      responsibilities: [
        {
          coverageType: '身故保险金',
          scenario: '',
          payout: '',
        },
      ],
    },
    indicatorRecords: [],
    knowledgeRecords: [
      {
        id: 1,
        company: '泄漏保险',
        productName: '泄漏产品',
        title: '泄漏产品条款',
        url: 'https://leak.example.test/leak.pdf',
        pageText: '泄漏产品责任正文。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
      {
        id: 2,
        company: '测试保险',
        productName: '安心一号',
        title: '安心一号条款',
        url: 'https://official.example-life.test/anxin-one.pdf',
        pageText: '安心一号责任正文。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
    officialDomainProfiles: [
      {
        id: 'leak-life',
        company: '泄漏保险',
        aliases: ['泄漏保险'],
        siteDomains: ['leak.example.test'],
        officialDomains: ['leak.example.test'],
      },
      {
        id: 'example-life',
        company: '测试保险',
        aliases: ['测试保险'],
        siteDomains: ['official.example-life.test'],
        officialDomains: ['official.example-life.test'],
      },
    ],
    optionalResponsibilityRecords: [],
    productIndicatorVersions: [],
    now: '2026-06-22T00:00:00.000Z',
  });

  assert.equal(row.responsibilityCards.length, 1);
  const card = row.responsibilityCards[0];
  assert.equal(card.sourceUrl, 'https://official.example-life.test/anxin-one.pdf');
  assert.equal(card.sourceTitle, '安心一号条款');
  assert.match(card.sourceExcerpt, /安心一号责任正文/u);
  assert.doesNotMatch(card.sourceUrl, /leak/u);
  assert.doesNotMatch(card.sourceExcerpt, /泄漏产品/u);
});

test('buildPolicyDerivedResult rejects exact product fallback records without usable official responsibility text', () => {
  const row = buildPolicyDerivedResult({
    policy: {
      id: 10,
      company: '测试保险',
      name: '安心一号',
      responsibilities: [
        {
          coverageType: '身故保险金',
          scenario: '',
          payout: '',
        },
      ],
    },
    indicatorRecords: [],
    knowledgeRecords: [
      {
        id: 1,
        company: '测试保险',
        productName: '安心一号',
        title: '安心一号错误来源',
        url: 'https://third-party.example.test/anxin-one.pdf',
        pageText: '第三方错误责任正文。',
        official: false,
        qualityStatus: 'invalid_responsibility',
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
    officialDomainProfiles: [
      {
        id: 'example-life',
        company: '测试保险',
        aliases: ['测试保险'],
        siteDomains: ['official.example-life.test'],
        officialDomains: ['official.example-life.test'],
      },
    ],
    optionalResponsibilityRecords: [],
    productIndicatorVersions: [],
    now: '2026-06-22T00:00:00.000Z',
  });

  assert.equal(row.responsibilityCards.length, 1);
  assert.equal(row.responsibilityCards[0].sourceUrl, '');
  assert.doesNotMatch(row.responsibilityCards[0].sourceExcerpt, /第三方错误责任正文/u);
});

test('buildPolicyDerivedResult does not emit unrelated optional responsibility records as cards', () => {
  const row = buildPolicyDerivedResult({
    policy: {
      id: 10,
      company: '新华保险',
      name: '尊享人生年金保险（分红型）',
    },
    indicatorRecords: [],
    knowledgeRecords: [],
    optionalResponsibilityRecords: [
      {
        id: 'opt_matching',
        company: '新华保险',
        productName: '尊享人生年金保险（分红型）',
        coverageType: '可选责任',
        liability: '附加关爱年金',
      },
      {
        id: 'opt_unrelated',
        company: '平安人寿',
        productName: '平安福',
        coverageType: '可选责任',
        liability: '无关住院津贴',
      },
    ],
    productIndicatorVersions: [],
    now: '2026-06-22T00:00:00.000Z',
  });

  const cardTitles = row.responsibilityCards.map((card) => card.title);
  assert.ok(cardTitles.includes('附加关爱年金'));
  assert.equal(cardTitles.includes('无关住院津贴'), false);
});

test('mergePolicyDerivedResult attaches persisted payload and derived status without recomputing', () => {
  const policy = { id: 10, company: '新华保险', name: '多倍保障重大疾病保险' };
  const merged = mergePolicyDerivedResult(policy, {
    policyId: 10,
    status: 'ready',
    staleReason: '',
    coverageIndicators: [{ id: 'ind_1' }],
    optionalResponsibilities: [{ id: 'opt_1' }],
    responsibilityCards: [{ id: 'card_1', title: '关爱年金', indicators: [] }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });

  assert.deepEqual(merged.coverageIndicators, [{ id: 'ind_1' }]);
  assert.deepEqual(merged.optionalResponsibilities, [{ id: 'opt_1' }]);
  assert.deepEqual(merged.responsibilityCards, [{ id: 'card_1', title: '关爱年金', indicators: [] }]);
  assert.equal(merged.derivedStatus, 'ready');
});

test('mergePolicyDerivedResult keeps existing responsibility cards when derived row is missing', () => {
  const cards = [{ id: 'card_1', title: '关爱年金', indicators: [] }];
  const withCards = mergePolicyDerivedResult({ id: 10, responsibilityCards: cards }, null);
  const withoutCards = mergePolicyDerivedResult({ id: 11 }, null);

  assert.deepEqual(withCards.responsibilityCards, cards);
  assert.deepEqual(withoutCards.responsibilityCards, []);
  assert.equal(withCards.derivedStatus, 'stale');
  assert.equal(withCards.derivedStaleReason, 'missing');
});
