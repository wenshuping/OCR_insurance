import assert from 'node:assert/strict';
import test from 'node:test';

import { hydratePolicyCoverageIndicators } from '../server/policy-ocr.domain.mjs';
import { resolveIndicatorAmountFromCalculation } from '../src/indicator-calculation.mjs';

test('hydratePolicyCoverageIndicators restores the current compound basis without replacing policy selection', () => {
  const [indicator] = hydratePolicyCoverageIndicators([
    {
      id: 'death-benefit',
      responsibilityScope: 'basic',
      selectionStatus: 'selected',
      calculationEligible: false,
    },
  ], [
    {
      id: 'death-benefit',
      responsibilityScope: 'basic_or_unspecified',
      selectionStatus: 'selected',
      payload: JSON.stringify({
        id: 'death-benefit',
        formulaText: '身故时有效保险金额 × 6',
        basisDefinition: {
          formulaText: '基本保险金额 + 累计红利保险金额',
        },
      }),
    },
  ]);

  assert.equal(indicator.responsibilityScope, 'basic');
  assert.equal(indicator.formulaText, '身故时有效保险金额 × 6');
  assert.equal(indicator.basisDefinition.formulaText, '基本保险金额 + 累计红利保险金额');
});

test('hydratePolicyCoverageIndicators reprojects an old generic return indicator into official payment-period branches', () => {
  const [indicator] = hydratePolicyCoverageIndicators([
    {
      id: 'care-benefit',
      liability: '教育/养老金/两全等返还',
      selectionStatus: 'selected',
      calculationKey: 'schedule_or_policy_table',
      calculationEligible: false,
    },
  ], [
    {
      id: 'care-benefit',
      payload: JSON.stringify({
        id: 'care-benefit',
        liability: '教育/养老金/两全等返还',
        sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/20231030/271a2202-8c51-4d10-97f3-dcec19959f6f.pdf',
        sourceExcerpt: '关爱金=首次交纳保险费的金额×关爱金给付比例(1)如保险单上载明的交费方式为一次交清，则关爱金给付比例为20%；(2)如保险单上载明的交费期间为3年，则关爱金给付比例为60%；(3)如保险单上载明的交费期间为5年，则关爱金给付比例为100%。',
      }),
    },
  ], [{
    title: '关爱金',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/20231030/271a2202-8c51-4d10-97f3-dcec19959f6f.pdf',
    scenario: '关爱金=首次交纳保险费的金额×关爱金给付比例；如保险单上载明的交费方式为一次交清，则关爱金给付比例为20%；如保险单上载明的交费期间为3年，则关爱金给付比例为60%；如保险单上载明的交费期间为5年，则关爱金给付比例为100%。',
  }]);

  assert.equal(indicator.branchSemanticContract, 'official-policy-parameter-branches');
  assert.equal(indicator.branches.length, 3);
  const result = resolveIndicatorAmountFromCalculation(indicator, {
    firstPremium: 10000,
    paymentPeriod: '3年交',
    coveragePeriod: '终身',
  });
  assert.equal(result.resolved, true);
  assert.equal(result.amount, 6000);
  assert.match(result.calculationText, /60%/u);
});
