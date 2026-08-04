import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundOfficialSourceIdentityForPolicy,
  refreshExistingResponsibilityCardProjection,
  selectResponsibilityCardProjection,
} from '../server/routes/responsibilities.routes.mjs';
import {
  derivedProjectionNeedsOfficialPayoutFactorRefresh,
  mergeProjectionKnowledgeRecordsForPolicy,
} from '../server/policy-knowledge-projection.mjs';

test('responsibility query replaces a stale card when rebuilt projection has official indicators', () => {
  const stale = [{
    title: '养老年金',
    calculationStatus: 'needs_review',
    indicators: [],
  }];
  const rebuilt = [{
    title: '养老年金',
    calculationStatus: 'calculable',
    indicators: [{
      liability: '养老年金',
      formulaText: '按年领取：基本保险金额；按月领取：基本保险金额 × 月领折算系数',
      branches: [{ branchKey: 'annual' }, { branchKey: 'monthly' }],
    }],
  }];

  assert.deepEqual(selectResponsibilityCardProjection(stale, rebuilt), rebuilt);
});

test('responsibility query keeps a richer existing projection when rebuild has no indicators', () => {
  const existing = [{
    title: '身故保险金',
    calculationStatus: 'claim_contingent',
    indicators: [{ liability: '身故保险金', formulaText: '按合同约定给付' }],
  }];
  const rebuilt = [{
    title: '身故保险金',
    calculationStatus: 'needs_review',
    indicators: [],
  }];

  assert.deepEqual(selectResponsibilityCardProjection(existing, rebuilt), existing);
});

test('policy refresh binds to the source used by current responsibilities instead of historical sources', () => {
  const boundUrl = 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=1050&versionNo=1050-4&attachmentType=1';
  assert.deepEqual(boundOfficialSourceIdentityForPolicy({
    responsibilities: [
      { coverageType: '年金', sourceUrl: boundUrl },
      { coverageType: '身故保险金', sourceUrl: boundUrl },
    ],
    sources: [
      { url: boundUrl },
      { url: boundUrl.replace('1050-4', '1050-7') },
    ],
  }), { sourceUrl: boundUrl });
});

test('policy refresh does not guess when current responsibilities bind different versions', () => {
  assert.equal(boundOfficialSourceIdentityForPolicy({
    responsibilities: [
      { sourceUrl: 'https://official.test/terms?planCode=1050&versionNo=1050-4' },
      { sourceUrl: 'https://official.test/terms?planCode=1050&versionNo=1050-7' },
    ],
    sources: [
      { url: 'https://official.test/terms?planCode=1050&versionNo=1050-4' },
      { url: 'https://official.test/terms?planCode=1050&versionNo=1050-7' },
    ],
  }), null);
});

test('existing legacy cards refresh official payment-period formulas before projection', () => {
  const card = refreshExistingResponsibilityCardProjection({
    title: '关爱金',
    payoutSummary: '条款载明基准',
    calculationStatus: 'needs_table',
    calculationReason: '依赖领取计划、比例表或保单载明金额',
    indicators: [{
      coverageType: '现金流',
      liability: '关爱金',
      basis: '条款载明基准',
      formulaText: '',
      sourceUrl: 'https://insurer.example/terms.pdf',
      sourceExcerpt: '关爱金=首次交纳保险费的金额×关爱金给付比例。如保险单上载明的交费方式为一次交清，则关爱金给付比例为20%。',
    }],
  }, {
    company: '测试保险公司',
    productName: '测试年金保险',
  });

  assert.equal(card.calculationStatus, 'calculable');
  assert.equal(card.payoutSummary, '关爱金 = 首次交纳保险费的金额 × 关爱金给付比例');
  assert.equal(card.indicators[0].calculationKey, 'policy_parameter_branches');
});

test('projection retains every official source for the resolved product when memory is partial', () => {
  const policy = {
    company: '测试保险公司',
    name: '测试养老年金保险',
    canonicalProductId: 'product-test-annuity',
  };
  const terms = {
    company: '测试保险公司',
    productName: '测试养老年金保险',
    url: 'https://insurer.example/terms.pdf',
    sourceDigest: 'terms-digest',
    pageText: '按年领取，每年领取金额为基本保险金额；按月领取，每月领取金额为基本保险金额×月领折算系数。',
    official: true,
    evidenceLevel: 'insurer_official',
  };
  const manual = {
    company: '测试保险公司',
    productName: '测试养老年金保险',
    url: 'https://insurer.example/manual.pdf',
    sourceDigest: 'manual-digest',
    pageText: '上述月领折算系数的数值为0.085。',
    official: true,
    evidenceLevel: 'insurer_official',
  };

  const records = mergeProjectionKnowledgeRecordsForPolicy({
    policy,
    recordGroups: [[terms], [terms, manual]],
  });

  assert.deepEqual(records.map((record) => record.sourceDigest), ['terms-digest', 'manual-digest']);
});

test('current derived projection refreshes when its monthly branch lacks an available official factor', () => {
  const knowledgeRecords = [{
    company: '测试保险公司',
    productName: '测试养老年金保险',
    sourceDigest: 'manual-digest',
    official: true,
    evidenceLevel: 'insurer_official',
    pageText: '上述月领折算系数的数值为0.085。',
  }];
  const incompleteDerivedResult = {
    coverageIndicators: [{
      branches: [{
        branchId: 'monthly',
        normalizedFormula: 'benefit_amount = basic_insured_amount * monthly_conversion_factor',
      }],
    }],
  };

  assert.equal(derivedProjectionNeedsOfficialPayoutFactorRefresh({
    derivedResult: incompleteDerivedResult,
    knowledgeRecords,
  }), true);
  assert.equal(derivedProjectionNeedsOfficialPayoutFactorRefresh({
    derivedResult: {
      coverageIndicators: [{
        branches: [{
          branchId: 'monthly',
          normalizedFormula: 'benefit_amount = basic_insured_amount * 0.085',
          sourceDigest: 'manual-digest',
        }],
      }],
    },
    knowledgeRecords,
  }), false);
});
