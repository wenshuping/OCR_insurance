import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { importReviewedResponsibilityArtifacts } from '../scripts/import-reviewed-responsibility-artifacts.mjs';

test('keeps structured formula fields through legacy importer and card materialization', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-structure-roundtrip-'));
  try {
    const artifactPath = path.join(dir, 'artifact.json');
    const dbPath = path.join(dir, 'responsibilities.sqlite');
    const branches = [{
      conditionText: '被保险人于18周岁后身故',
      formulaText: '给付金额 = max(基本保险金额，事故时累计已交保险费)',
      normalizedFormula: 'max(policy.amount, cumulativePaidPremiumAtEvent)',
      requiredInputs: ['policy.amount', 'manualFormulaInputs'],
    }];
    const operands = [{
      operandName: '事故时累计已交保险费',
      requiredInputs: ['manualFormulaInputs'],
    }];
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '示例人寿',
      productName: '结构化公式测试产品',
      productIdentity: { sourceUrl: 'https://example.com/structured-formula.pdf' },
      responsibilities: [{
        responsibilityId: 'death-benefit',
        liability: '身故保险金',
        triggerCondition: '被保险人身故',
        insurerObligation: '按基本保险金额与事故时累计已交保险费的较大者给付身故保险金。',
        sourceExcerpt: '被保险人身故时，本公司按基本保险金额与事故时累计已交保险费的较大者给付身故保险金。',
        card: {
          title: '身故保险金',
          customerSummary: '被保险人身故时，保险公司按约定给付。',
        },
        indicators: [{
          indicatorName: '身故保险金给付金额',
          formulaText: '给付金额 = max(基本保险金额，事故时累计已交保险费)',
          normalizedFormula: 'max(policy.amount, cumulativePaidPremiumAtEvent)',
          requiredInputs: ['policy.amount', 'manualFormulaInputs'],
          branches,
          operands,
          basisKey: 'basic_amount',
          calculationKey: 'manual_formula',
          calculationEligible: false,
          calculationStatus: 'needs_claim_facts',
          calculationReason: '需要事故时累计已交保险费。',
        }],
      }],
    }));

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
    });
    assert.equal(result.ok, true);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const indicator = JSON.parse(db.prepare(`
        SELECT payload FROM insurance_indicator_records
         WHERE company = ? AND product_name = ?
      `).get('示例人寿', '结构化公式测试产品').payload);
      const card = JSON.parse(db.prepare(`
        SELECT payload FROM product_responsibility_cards
         WHERE company = ? AND product_name = ?
      `).get('示例人寿', '结构化公式测试产品').payload);

      assert.equal(indicator.normalizedFormula, 'max(policy.amount, cumulativePaidPremiumAtEvent)');
      assert.deepEqual(indicator.branches, branches);
      assert.deepEqual(indicator.operands, operands);
      assert.equal(card.indicators[0].normalizedFormula, 'max(policy.amount, cumulativePaidPremiumAtEvent)');
      assert.deepEqual(card.indicators[0].branches, branches);
      assert.deepEqual(card.indicators[0].operands, operands);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('imports every structured indicator attached to one unified responsibility', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiple-structured-indicators-'));
  try {
    const artifactPath = path.join(dir, 'artifact.json');
    const dbPath = path.join(dir, 'responsibilities.sqlite');
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '示例人寿',
      productName: '多指标测试产品',
      productIdentity: { sourceUrl: 'https://example.com/multiple-indicators.pdf' },
      responsibilities: [{
        responsibilityId: 'death-benefit',
        liability: '身故保险金',
        triggerCondition: '被保险人身故',
        insurerObligation: '按约定给付身故保险金。',
        sourceExcerpt: '被保险人身故时，本公司按合同约定给付身故保险金。',
        card: { title: '身故保险金', customerSummary: '被保险人身故时按约定给付。' },
        indicators: [{
          indicatorName: '基本保险金额给付',
          formulaText: '给付金额 = 基本保险金额',
          normalizedFormula: 'policy.amount',
          basisKey: 'basic_amount',
          calculationKey: 'basic_amount',
          calculationEligible: true,
          calculationStatus: 'calculable',
          calculationReason: '按基本保险金额给付。',
        }, {
          indicatorName: '累计保费给付',
          formulaText: '给付金额 = 事故时累计已交保险费',
          normalizedFormula: 'cumulativePaidPremiumAtEvent',
          requiredInputs: ['manualFormulaInputs'],
          basisKey: 'total_paid_premium',
          calculationKey: 'manual_formula',
          calculationEligible: false,
          calculationStatus: 'needs_claim_facts',
          calculationReason: '需要事故时累计已交保险费。',
          branches: [{
            conditionText: '事故发生时',
            formulaText: '给付事故时累计已交保险费',
          }],
        }],
      }],
    }));

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.acceptedResponsibilities, 2);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const indicators = db.prepare(`
        SELECT payload FROM insurance_indicator_records
         WHERE company = ? AND product_name = ?
         ORDER BY id
      `).all('示例人寿', '多指标测试产品').map((row) => JSON.parse(row.payload));
      const card = JSON.parse(db.prepare(`
        SELECT payload FROM product_responsibility_cards
         WHERE company = ? AND product_name = ?
      `).get('示例人寿', '多指标测试产品').payload);

      assert.equal(indicators.length, 2);
      assert.deepEqual(indicators.map((indicator) => indicator.normalizedFormula).sort(), [
        'cumulativePaidPremiumAtEvent',
        'policy.amount',
      ]);
      assert.equal(card.indicators.length, 2);
      assert.equal(card.indicators.some((indicator) => indicator.branches.length === 1), true);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
