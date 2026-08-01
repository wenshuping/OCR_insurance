import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_REQUIRED_INPUTS,
  normalizeRequiredInput,
  quarantineCardPayload,
  quarantineIndicatorPayload,
  repairDeepSeekArtifact,
} from '../server/deepseek-responsibility-repair.mjs';

function artifact(overrides = {}) {
  return {
    company: '示例人寿',
    productName: '示例保险',
    productIdentity: {
      sourceDigest: 'sha256:source',
      sourceUrl: 'https://example.com/terms.pdf',
    },
    productRules: [],
    responsibilities: [{
      responsibilityId: 'death',
      liability: '身故保险金',
      sourceExcerpt: '被保险人身故，按基本保险金额与累计已交保险费的较大者给付。',
      indicators: [{
        indicatorName: '身故保险金金额',
        formulaText: '基本保险金额与累计已交保险费的较大者',
        calculationKey: 'maximum_of_bases',
        calculationEligible: false,
        requiredInputs: ['insured_amount', 'actual_paid_premium'],
        ruleRefs: [],
        branches: [],
      }],
    }],
    ...overrides,
  };
}

test('maps lossless aliases and preserves unresolved business inputs', () => {
  const result = repairDeepSeekArtifact({
    legacyArtifact: artifact(),
    authoritativeArtifact: artifact(),
    legacyArtifactId: 'legacy-1',
    authority: 'current_approved_same_source',
    now: '2026-07-26T00:00:00.000Z',
  });
  const indicator = result.artifact.responsibilities[0].indicators[0];

  assert.deepEqual(indicator.requiredInputs, ['policy.amount']);
  assert.deepEqual(indicator.unresolvedRequiredInputs, [{
    value: 'actual_paid_premium',
    location: 'responsibilities[0].indicators[0].requiredInputs',
    reason: 'no_lossless_canonical_mapping',
  }]);
  assert.equal(indicator.calculationEligible, false);
  assert.equal(result.receipt.route, 'deterministic_pass');
});

test('does not replace unresolved inputs only with manualFormulaInputs', () => {
  const result = repairDeepSeekArtifact({
    legacyArtifact: artifact(),
    authoritativeArtifact: artifact(),
    legacyArtifactId: 'legacy-2',
    authority: 'current_approved_same_source',
  });
  const indicator = result.artifact.responsibilities[0].indicators[0];

  assert.equal(indicator.requiredInputs.includes('manualFormulaInputs'), false);
  assert.equal(indicator.unresolvedRequiredInputs[0].value, 'actual_paid_premium');
});

test('unions branch and applicable shared-rule inputs into the parent', () => {
  const source = artifact({
    productRules: [{
      ruleId: 'cash-value-rule',
      affectedResponsibilityIds: ['death'],
      evidenceSegments: [{ sourceExcerpt: '给付时同时比较现金价值。' }],
      calculation: {
        formulaText: '比较现金价值',
        requiredInputs: ['cash_value'],
        branches: [],
      },
    }],
    responsibilities: [{
      responsibilityId: 'death',
      liability: '身故保险金',
      sourceExcerpt: '被保险人身故，18周岁后按基本保险金额给付，并比较现金价值。',
      indicators: [{
        indicatorName: '身故保险金金额',
        formulaText: '18周岁后按基本保险金额给付',
        calculationKey: 'piecewise',
        calculationEligible: false,
        requiredInputs: [],
        ruleRefs: ['cash-value-rule'],
        branches: [{
          branchId: 'adult',
          formulaText: '18周岁后按基本保险金额给付',
          requiredInputs: ['insured_amount'],
          evidenceTokens: ['18周岁后', '基本保险金额'],
        }],
      }],
    }],
  });
  const result = repairDeepSeekArtifact({
    legacyArtifact: source,
    authoritativeArtifact: source,
    legacyArtifactId: 'legacy-3',
    authority: 'current_approved_same_source',
  });
  const indicator = result.artifact.responsibilities[0].indicators[0];

  assert.deepEqual(indicator.requiredInputs, ['policy.amount', 'cashValue']);
  assert.equal(result.receipt.invalidRuleRefs.length, 0);
});

test('repairs nested operand inputs and unions them into the parent', () => {
  const source = artifact({
    responsibilities: [{
      responsibilityId: 'medical',
      liability: '医疗保险金',
      sourceExcerpt: '按实际医疗费用扣除免赔额后的约定比例给付。',
      indicators: [{
        indicatorName: '医疗保险金金额',
        formulaText: '实际医疗费用扣除免赔额',
        calculationKey: 'reimbursement',
        calculationEligible: false,
        requiredInputs: [],
        ruleRefs: [],
        branches: [],
        operands: [{
          operandId: 'expense',
          requiredInputs: ['actual_medical_expense', 'deductible_amount'],
        }],
      }],
    }],
  });
  const result = repairDeepSeekArtifact({
    legacyArtifact: source,
    authoritativeArtifact: source,
    legacyArtifactId: 'legacy-operands',
    authority: 'current_approved_same_source',
  });
  const indicator = result.artifact.responsibilities[0].indicators[0];

  assert.deepEqual(indicator.operands[0].requiredInputs, ['actualMedicalExpense', 'deductible']);
  assert.deepEqual(indicator.requiredInputs, ['actualMedicalExpense', 'deductible']);
});

test('rejects out-of-scope rule references and pauses calculation', () => {
  const source = artifact({
    productRules: [{
      ruleId: 'other-rule',
      affectedResponsibilityIds: ['maturity'],
      calculation: { requiredInputs: ['policy_year'], branches: [] },
    }],
    responsibilities: [{
      responsibilityId: 'death',
      liability: '身故保险金',
      sourceExcerpt: '被保险人身故，按基本保险金额给付。',
      indicators: [{
        indicatorName: '身故保险金金额',
        formulaText: '基本保险金额',
        calculationKey: 'basic_amount',
        calculationEligible: true,
        requiredInputs: ['insured_amount'],
        ruleRefs: ['other-rule'],
        branches: [],
      }],
    }],
  });
  const result = repairDeepSeekArtifact({
    legacyArtifact: source,
    authoritativeArtifact: source,
    legacyArtifactId: 'legacy-4',
    authority: 'current_approved_same_source',
  });

  assert.equal(result.receipt.invalidRuleRefs.length, 1);
  assert.equal(result.receipt.route, 'gemini_required');
  assert.equal(result.artifact.responsibilities[0].indicators[0].calculationEligible, false);
});

test('removes constants from required inputs and pauses old enabled indicators', () => {
  const source = artifact({
    responsibilities: [{
      responsibilityId: 'fixed',
      liability: '固定给付',
      sourceExcerpt: '发生约定事故时给付5000元。',
      indicators: [{
        indicatorName: '固定给付金额',
        formulaText: '5000元',
        calculationKey: 'fixed_amount',
        calculationEligible: true,
        requiredInputs: ['fixed_amount', 'zero'],
        ruleRefs: [],
        branches: [],
      }],
    }],
  });
  const result = repairDeepSeekArtifact({
    legacyArtifact: source,
    authoritativeArtifact: source,
    legacyArtifactId: 'legacy-5',
    authority: 'current_approved_same_source',
  });
  const indicator = result.artifact.responsibilities[0].indicators[0];

  assert.deepEqual(indicator.requiredInputs, []);
  assert.equal(indicator.calculationEligible, false);
  assert.match(indicator.calculationReason, /旧 DeepSeek 可计算状态已暂停/u);
});

test('normalizes equivalent amount, age, and Chinese count evidence before routing', () => {
  const source = artifact({
    responsibilities: [{
      responsibilityId: 'benefit',
      liability: '保险金',
      sourceExcerpt: '限额为600万元，18周岁起给付，累计给付四次。',
      indicators: [{
        indicatorName: '保险金金额',
        formulaText: '限额6000000，18岁起给付4次',
        calculationKey: 'piecewise',
        calculationEligible: false,
        requiredInputs: ['attained_age'],
        ruleRefs: [],
        branches: [],
      }],
    }],
  });
  const result = repairDeepSeekArtifact({
    legacyArtifact: source,
    authoritativeArtifact: source,
    legacyArtifactId: 'legacy-6',
    authority: 'current_approved_same_source',
  });

  assert.equal(result.receipt.unsupportedNumericClaims.length, 0);
  assert.equal(result.receipt.route, 'deterministic_pass');
});

test('canonical dictionary remains closed', () => {
  assert.equal(normalizeRequiredInput('policy.amount').status, 'canonical');
  assert.equal(normalizeRequiredInput('insured.ageAtClaim').status, 'unresolved');
  assert.equal(CANONICAL_REQUIRED_INPUTS.has('insured.ageAtClaim'), false);
});

test('quarantines only enabled indicator and card payloads', () => {
  const disabled = quarantineIndicatorPayload({ calculationEligible: false });
  assert.equal(disabled.changed, false);

  const indicator = quarantineIndicatorPayload({
    calculationEligible: true,
    calculationStatus: 'calculable',
    calculationReason: '旧原因',
  });
  assert.equal(indicator.changed, true);
  assert.equal(indicator.payload.calculationEligible, false);
  assert.equal(indicator.payload.calculationStatus, 'manual_review');
  assert.match(indicator.payload.calculationReason, /旧原因/u);

  const card = quarantineCardPayload({
    calculationStatus: 'calculable',
    indicators: [
      { calculationEligible: false },
      { calculationEligible: true, calculationStatus: 'calculable' },
    ],
  });
  assert.equal(card.changed, true);
  assert.equal(card.payload.calculationStatus, 'manual_review');
  assert.deepEqual(card.payload.indicators.map((item) => item.calculationEligible), [false, false]);
});
