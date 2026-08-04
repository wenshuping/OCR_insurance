import assert from 'node:assert/strict';
import test from 'node:test';

import { hydratePolicyCoverageIndicators } from '../server/policy-ocr.domain.mjs';

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
