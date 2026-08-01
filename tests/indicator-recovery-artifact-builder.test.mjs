import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndicatorRecoveryArtifact } from '../scripts/build-indicator-recovery-artifacts.mjs';

test('builds one approved deterministic responsibility per unique indicator liability', () => {
  const artifact = buildIndicatorRecoveryArtifact({
    company: '测试保险公司',
    productName: '测试产品',
    sourceUrl: 'https://insurer.example.com/test.pdf',
    sourceDigest: 'sha256:' + 'a'.repeat(64),
    indicators: [{
      id: 'indicator-1',
      liability: '身故保险金',
      coverageType: '人寿保障',
      condition: '被保险人身故',
      formulaText: '身故保险金 = 基本保险金额',
      basis: '基本保险金额',
      basisKey: 'insured_amount',
      calculationKey: 'fixed_amount',
      requiredInputs: ['basicSumInsured'],
      calculationEligible: false,
      calculationReason: '需要保单基本保险金额',
      sourceUrl: 'https://insurer.example.com/test.pdf',
      sourceExcerpt: '被保险人身故，按基本保险金额给付身故保险金。',
      sourceTitle: '测试产品条款',
    }],
  });

  assert.equal(artifact.audit.status, 'pending_validation');
  assert.equal(artifact.responsibilities.length, 1);
  assert.equal(artifact.responsibilities[0].indicators.length, 1);
  assert.equal(artifact.responsibilities[0].indicators[0].id, 'indicator-1');
  assert.deepEqual(artifact.responsibilities[0].indicators[0].requiredInputs, ['basicSumInsured']);
  assert.equal(artifact.responsibilities[0].indicators[0].formulaText, '身故保险金 = 基本保险金额');
  assert.deepEqual(artifact.responsibilities[0].indicators[0].evidenceTokens, ['身故保险金', '基本保险金额']);
});
