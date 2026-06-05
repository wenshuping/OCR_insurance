import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePolicyBasicInfoFromLayoutBoxes } from '../ocr-service/policy-basic-info-layout-parser.mjs';

const box = (text, x1, y1, x2, y2) => ({ text, box: [x1, y1, x2, y2], confidence: 0.98 });

test('parsePolicyBasicInfoFromLayoutBoxes extracts right-side basic information fields', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('NCI 新华保险', 60, 30, 220, 55),
    box('保险合同号', 70, 120, 170, 145),
    box('990171228067', 240, 120, 390, 145),
    box('投保人', 70, 165, 140, 190),
    box('冯力', 240, 165, 290, 190),
    box('被保险人', 70, 205, 160, 230),
    box('温舒萍', 240, 205, 320, 230),
    box('证件号码', 70, 245, 160, 270),
    box('330106198712072413', 240, 245, 430, 270),
    box('合同生效日期', 70, 285, 190, 310),
    box('2024年09月30日', 240, 285, 420, 310),
    box('身故保险金受益人', 70, 325, 210, 350),
    box('法定继承人', 240, 325, 340, 350),
  ]);

  assert.equal(result.fields.company, '新华保险');
  assert.equal(result.fields.policyNumber, '990171228067');
  assert.equal(result.fields.applicant, '冯力');
  assert.equal(result.fields.insured, '温舒萍');
  assert.equal(result.fields.insuredIdNumber, '330106198712072413');
  assert.equal(result.fields.insuredBirthday, '1987-12-07');
  assert.equal(result.fields.date, '2024-09-30');
  assert.equal(result.fields.beneficiary, '法定');
  assert.equal(result.fieldConfidence.applicant, 'high');
});

test('parsePolicyBasicInfoFromLayoutBoxes refuses to source core fields from rider table', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人', 70, 120, 140, 145),
    box('张三', 240, 120, 290, 145),
    box('被保险人', 70, 160, 160, 185),
    box('李四', 240, 160, 290, 185),
    box('保险利益表', 70, 260, 180, 285),
    box('险种名称', 70, 300, 160, 325),
    box('保险期间', 260, 300, 350, 325),
    box('附加住院医疗保险', 70, 340, 220, 365),
    box('至2026年12月23日', 260, 340, 430, 365),
    box('附加投保人豁免保险', 70, 380, 240, 405),
  ]);

  assert.equal(result.fields.applicant, '张三');
  assert.equal(result.fields.insured, '李四');
  assert.equal(result.fields.date, '');
  assert.ok(result.ocrWarnings.some((warning) => warning.includes('附加险')));
});
