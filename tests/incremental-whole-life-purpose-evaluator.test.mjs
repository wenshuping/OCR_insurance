import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  applyIncrementalWholeLifePurpose,
  evaluateIncrementalWholeLifePurpose,
} from '../server/incremental-whole-life-purpose-evaluator.mjs';
import { buildCustomerResponsibilitySummaryFromCards } from '../server/product-customer-responsibility-summary.service.mjs';

const company = '横琴人寿保险有限公司';
const digest = 'sha256:test-incremental-whole-life';
const productNames = {
  5: '横琴人寿传世恒福增额终身寿险（分红型）',
  6: '横琴人寿琴相伴增额终身寿险',
  7: '横琴传世久久增额终身寿险',
  8: '横琴传世壹号（尊享版）增额终身寿险',
  9: '横琴传世壹号（悦享版）增额终身寿险',
};

function recursiveGrowth(rate) {
  return {
    firstYear: '本合同第一个保单年度的有效保险金额等于本合同基本保险金额。',
    recurrence: `自第二个保单年度起，本合同当年度有效保险金额等于本合同上一个保单年度的有效保险金额×（1+${rate}%）。`,
  };
}

const benefit = '若被保险人身故或全残，按已交保险费、现金价值、当年度有效保险金额三者中的较大者给付。';

function chain({ productName, rate = 3.5, growthRole = 'artifact', artifactDigest = digest, cardDigest = digest, indicatorDigest = digest, includeFirstYear = true, includeRecurrence = true, includeBenefit = true } = {}) {
  const growth = recursiveGrowth(rate);
  const growthText = [includeFirstYear ? growth.firstYear : '', includeRecurrence ? growth.recurrence : '', includeFirstYear ? '第一个保单年度有效保险金额等于基本保险金额。' : '', includeRecurrence ? `自第二年起，当年度有效保险金额等于上一保单年度有效保险金额×(1+${rate}%)。` : ''].filter(Boolean).join('\n');
  const artifact = {
    company,
    productName,
    sourceDigest: artifactDigest,
    audit: { status: 'approved' },
    productIdentity: { productType: '终身寿险' },
    responsibilities: [{ liability: '身故或全残保险金', sourceExcerpt: includeBenefit ? benefit : '身故或全残保险金。' }],
    productRules: growthRole === 'artifact' ? [{ ruleId: 'effective_insured_amount', evidenceSegments: [{ sourceExcerpt: growthText }], calculation: { formulaText: growthText } }] : [],
  };
  const card = {
    id: `card:${productName}`,
    company,
    productName,
    sourceDigest: cardDigest,
    sourceExcerpt: growthRole === 'card' ? growthText : (includeBenefit ? benefit : '身故或全残保险金。'),
    indicators: [{ id: `indicator:${productName}`, sourceDigest: cardDigest, formulaText: growthRole === 'card' ? growthText : (includeBenefit ? benefit : '身故或全残保险金。') }],
  };
  const indicator = {
    id: `indicator:${productName}`,
    company,
    productName,
    sourceDigest: indicatorDigest,
    formulaText: growthRole === 'indicator' ? growthText : (includeBenefit ? benefit : '身故或全残保险金。'),
    sourceExcerpt: includeBenefit ? benefit : '身故或全残保险金。',
  };
  return { company, productName, cards: [card], indicators: [indicator], artifacts: [artifact] };
}

function mergeChains(...chains) {
  return {
    company,
    productName: chains[0].productName,
    cards: chains.flatMap((item) => item.cards),
    indicators: chains.flatMap((item) => item.indicators),
    artifacts: chains.flatMap((item) => item.artifacts),
  };
}

test('explicit expanded formula is a separate accepted path', () => {
  const evidence = chain({ productName: productNames[9], growthRole: 'artifact' });
  evidence.artifacts[0].productRules = [{
    ruleId: 'effective_insured_amount',
    calculation: { formulaText: '基本保险金额 × (1+3.5%)^(n-1)' },
  }];
  const result = evaluateIncrementalWholeLifePurpose(evidence);
  assert.equal(result.eligible, true);
  assert.equal(result.path, 'explicit_expanded');
  assert.equal(result.gates.explicitExpanded, true);
  assert.equal(result.gates.sourceDigestAligned, true);
});

for (const [order, productName] of Object.entries(productNames)) {
  test(`locked canary ${order} accepts the equivalent recurrence path`, () => {
    const result = evaluateIncrementalWholeLifePurpose(chain({ productName, rate: order === '5' ? 1.75 : order === '6' ? 2.5 : order === '7' ? 4 : 3.5, growthRole: order === '5' ? 'artifact' : order === '6' ? 'card' : 'indicator' }));
    assert.equal(result.eligible, true);
    assert.equal(result.path, 'equivalent_recurrence');
    assert.equal(result.gates.firstYear, true);
    assert.equal(result.gates.recurrence, true);
    assert.equal(result.gates.singleRate, true);
    assert.equal(result.gates.benefitAssociation, true);
    assert.equal(result.gates.paidCashComparison, true);
    assert.equal(result.sourceDigest, digest.replace(/^sha256:/u, ''));
  });
}

test('missing any equivalent-path gate refuses incremental whole-life purpose', () => {
  const missingFirstYear = evaluateIncrementalWholeLifePurpose(chain({ productName: productNames[6], includeFirstYear: false }));
  const missingRecurrence = evaluateIncrementalWholeLifePurpose(chain({ productName: productNames[6], includeRecurrence: false }));
  const missingBenefit = evaluateIncrementalWholeLifePurpose(chain({ productName: productNames[6], includeBenefit: false }));
  const mismatchedDigest = evaluateIncrementalWholeLifePurpose(chain({ productName: productNames[6], cardDigest: 'sha256:other' }));
  for (const result of [missingFirstYear, missingRecurrence, missingBenefit, mismatchedDigest]) {
    assert.equal(result.eligible, false);
    assert.equal(result.path, 'none');
  }
});

test('product name or “复利递增” alone cannot produce the incremental purpose', () => {
  const evidence = chain({ productName: productNames[7], includeFirstYear: false, includeRecurrence: false, includeBenefit: false });
  evidence.artifacts[0].productOverview = { primaryPurpose: '有效保险金额复利递增' };
  const result = evaluateIncrementalWholeLifePurpose(evidence);
  assert.equal(result.eligible, false);
  const summary = applyIncrementalWholeLifePurpose({
    headline: '本产品是增额终身寿险。',
    contentBlocks: [{ blockKey: 'productPurpose', content: '本产品是增额终身寿险。' }],
  }, evidence);
  assert.doesNotMatch(summary.contentBlocks[0].content, /增额终身寿险/u);
});

test('evaluates every source digest and selects the sole renderable chain', () => {
  const productName = productNames[6];
  const first = chain({ productName, artifactDigest: 'sha256:old-invalid', cardDigest: 'sha256:old-invalid', indicatorDigest: 'sha256:old-invalid', includeFirstYear: false });
  const second = chain({ productName, rate: 2.5, artifactDigest: 'sha256:current-valid', cardDigest: 'sha256:current-valid', indicatorDigest: 'sha256:current-valid' });
  const result = evaluateIncrementalWholeLifePurpose(mergeChains(first, second));
  assert.equal(result.eligible, true);
  assert.equal(result.status, 'eligible');
  assert.equal(result.sourceDigest, 'current-valid');
  assert.equal(result.rate, 2.5);
  assert.equal(result.candidateChains.length, 2);
  assert.equal(result.candidateChains[0].eligible, false);
  assert.equal(result.candidateChains[1].eligible, true);
});

test('rejects two renderable source versions even when only the rate differs', () => {
  const productName = productNames[7];
  const first = chain({ productName, rate: 2.5, artifactDigest: 'sha256:version-a', cardDigest: 'sha256:version-a', indicatorDigest: 'sha256:version-a' });
  const second = chain({ productName, rate: 4, artifactDigest: 'sha256:version-b', cardDigest: 'sha256:version-b', indicatorDigest: 'sha256:version-b' });
  const result = evaluateIncrementalWholeLifePurpose(mergeChains(first, second));
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'version_conflict');
  assert.equal(result.holdReason, 'version_conflict');
  assert.equal(result.path, 'none');
  assert.equal(result.sourceDigest, '');
  assert.deepEqual(result.candidateChains.map((candidate) => candidate.rate), [2.5, 4]);
});

test('customer fast path uses the same evaluator and approved source digest chain', () => {
  const productName = productNames[6];
  const rate = 2.5;
  const growth = recursiveGrowth(rate);
  const sourceExcerpt = `${growth.firstYear}${growth.recurrence}${benefit}`;
  const cardPayload = {
    id: 'card:琴相伴',
    company,
    productName,
    title: '身故或全残保险金',
    plainSummary: benefit,
    payoutSummary: '按约定给付，合同终止。',
    sourceUrl: 'https://example.test/qinxiangban.pdf',
    sourceDigest: digest,
    sourceExcerpt,
    indicators: [{
      id: 'indicator:琴相伴',
      sourceDigest: digest,
      formulaText: sourceExcerpt,
      normalizedFormula: 'effective_insured_amount_n = effective_insured_amount_{n-1} * (1+0.025)',
      sourceExcerpt,
    }],
  };
  const artifactPayload = {
    company,
    productName,
    sourceDigest: digest,
    audit: { status: 'approved' },
    productIdentity: { productType: '终身寿险' },
    productRules: [],
    responsibilities: [{ liability: '身故或全残保险金', sourceExcerpt }],
  };
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE product_responsibility_cards (
      id TEXT PRIMARY KEY, product_key TEXT, company TEXT, product_name TEXT, title TEXT,
      category TEXT, cashflow_treatment TEXT, calculation_status TEXT, calculation_reason TEXT,
      responsibility_scope TEXT, selection_status TEXT, source_url TEXT, generated_at TEXT,
      updated_at TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE product_responsibility_artifacts (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, product_name TEXT NOT NULL, source_digest TEXT NOT NULL,
      source_url TEXT, published_at TEXT NOT NULL, publisher_version TEXT NOT NULL, payload TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT INTO product_responsibility_cards
    (id, product_key, company, product_name, title, source_url, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(cardPayload.id, `company_product:${company}:${productName}`, company, productName, cardPayload.title, cardPayload.sourceUrl, JSON.stringify(cardPayload));
  db.prepare(`INSERT INTO product_responsibility_artifacts
    (id, company, product_name, source_digest, source_url, published_at, publisher_version, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('artifact:琴相伴', company, productName, digest, cardPayload.sourceUrl, '2026-01-01T00:00:00.000Z', 'test', JSON.stringify(artifactPayload));

  const result = buildCustomerResponsibilitySummaryFromCards({ db, company, productName });
  const purpose = result?.contentBlocks?.find((block) => block.blockKey === 'productPurpose')?.content || '';
  assert.match(purpose, /增额终身寿险/u);
  assert.match(purpose, /2\.5%/u);
  assert.match(purpose, /已交保险费/u);
  assert.match(purpose, /现金价值/u);
  db.close();
});

test('buildCustomerResponsibilitySummaryFromCards adds verified universal-account functions without model generation', () => {
  const universalCompany = '示例人寿保险有限公司';
  const universalProductName = '示例两全保险（万能型）';
  const universalDigest = 'sha256:test-universal-account';
  const accountText = [
    '第十条 本合同设置万能账户，个人账户价值按本条款计算。',
    '第十一条 最低保证利率为年利率2%，结算利率按月公布并按日复利结算。',
    '第十二条 一次交清保险费的初始费用为3%，追加保险费的初始费用为3%。',
    '第十三条 保单管理费为每月0元。',
    '第十四条 部分领取手续费率第一至第五个保单年度分别为5%、4%、3%、2%、1%，每个保险年度累计部分领取的个人账户价值不超过实际交纳保险费的20%。',
  ].join('\n');
  const productKey = `company_product:${universalCompany}:${universalProductName}`;
  const cardPayload = {
    id: 'card:universal-account', company: universalCompany, productName: universalProductName, productKey,
    sourceDigest: universalDigest, title: '满期保险金', plainSummary: '合同期满时按个人账户价值给付满期保险金。',
    sourceExcerpt: accountText,
    indicators: [{ sourceDigest: universalDigest, formulaText: '满期保险金等于个人账户价值。', sourceExcerpt: accountText }],
  };
  const artifactPayload = {
    company: universalCompany, productName: universalProductName, sourceDigest: universalDigest,
    audit: { status: 'approved' }, productRules: [{ sourceExcerpt: accountText }],
    responsibilities: [{ liability: '满期保险金', sourceExcerpt: accountText }],
  };
  const indicatorPayload = {
    company: universalCompany, productName: universalProductName, sourceDigest: universalDigest,
    liability: '满期保险金', formulaText: '满期保险金等于个人账户价值。', sourceExcerpt: accountText,
  };
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE product_responsibility_cards (id TEXT PRIMARY KEY, product_key TEXT, company TEXT, product_name TEXT, title TEXT, source_url TEXT, payload TEXT NOT NULL);
    CREATE TABLE product_responsibility_artifacts (id TEXT PRIMARY KEY, company TEXT NOT NULL, product_name TEXT NOT NULL, source_digest TEXT NOT NULL, source_url TEXT, published_at TEXT NOT NULL, publisher_version TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE insurance_indicator_records (id TEXT PRIMARY KEY, company TEXT, product_name TEXT, product_key TEXT, source_digest TEXT, source_url TEXT, payload TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO product_responsibility_cards (id, product_key, company, product_name, title, payload) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(cardPayload.id, productKey, universalCompany, universalProductName, cardPayload.title, JSON.stringify(cardPayload));
  db.prepare(`INSERT INTO product_responsibility_artifacts (id, company, product_name, source_digest, source_url, published_at, publisher_version, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('artifact:universal-account', universalCompany, universalProductName, universalDigest, '', '2026-01-01T00:00:00.000Z', 'test', JSON.stringify(artifactPayload));
  db.prepare(`INSERT INTO insurance_indicator_records (id, company, product_name, product_key, source_digest, payload) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('indicator:universal-account', universalCompany, universalProductName, productKey, universalDigest, JSON.stringify(indicatorPayload));

  const result = buildCustomerResponsibilitySummaryFromCards({ db, company: universalCompany, productName: universalProductName });
  const functions = result?.contentBlocks?.find((block) => block.blockKey === 'productFunctions')?.content || '';
  assert.match(functions, /最低保证利率：2%/u);
  assert.match(functions, /一次交清初始费用/u);
  assert.match(functions, /部分领取\/退保手续费/u);
  db.close();
});
