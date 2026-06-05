import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyPolicyLayoutRegions } from '../ocr-service/policy-layout-regions.mjs';

const box = (text, x1, y1, x2, y2) => ({ text, box: [x1, y1, x2, y2], confidence: 0.98 });

test('classifyPolicyLayoutRegions separates header, basic info, benefit table, rider table, and footer', () => {
  const result = classifyPolicyLayoutRegions([
    box('NCI 新华保险', 60, 30, 220, 55),
    box('保险单', 430, 65, 500, 90),
    box('保险合同号', 70, 120, 170, 145),
    box('990171228067', 240, 120, 390, 145),
    box('投保人', 70, 165, 140, 190),
    box('冯力', 240, 165, 290, 190),
    box('被保险人', 70, 205, 160, 230),
    box('冯力', 240, 205, 290, 230),
    box('合同生效日期', 70, 245, 190, 270),
    box('2024年09月30日', 240, 245, 420, 270),
    box('保险利益表', 70, 330, 180, 355),
    box('险种名称', 70, 370, 160, 395),
    box('基本保险金额', 260, 370, 390, 395),
    box('畅行万里智赢版两全保险', 70, 410, 250, 435),
    box('60000.00元', 260, 410, 380, 435),
    box('附加i他男性特定疾病保险', 70, 450, 260, 475),
    box('50000.00元', 260, 450, 380, 475),
    box('特别约定', 70, 540, 160, 565),
  ]);

  assert.deepEqual(result.regions.header.map((item) => item.text), ['NCI 新华保险', '保险单']);
  assert.ok(result.regions.basicInfo.some((item) => item.text === '投保人'));
  assert.ok(result.regions.benefitTable.some((item) => item.text === '畅行万里智赢版两全保险'));
  assert.ok(result.regions.riderTable.some((item) => item.text === '附加i他男性特定疾病保险'));
  assert.ok(!result.regions.benefitTable.some((item) => item.text === '附加i他男性特定疾病保险'));
  assert.ok(result.regions.footer.some((item) => item.text === '特别约定'));
});

test('classifyPolicyLayoutRegions keeps ambiguous product labels in basic info until explicit benefit table', () => {
  const result = classifyPolicyLayoutRegions([
    box('NCI 新华保险', 60, 30, 220, 55),
    box('保险单', 430, 65, 500, 90),
    box('产品名称', 70, 120, 160, 145),
    box('惠鑫宝年金保险', 240, 120, 390, 145),
    box('保险合同号', 70, 165, 170, 190),
    box('P990171228067', 240, 165, 410, 190),
    box('投保人', 70, 205, 140, 230),
    box('张三', 240, 205, 290, 230),
    box('保险利益表', 70, 310, 180, 335),
    box('险种名称', 70, 350, 160, 375),
    box('基本保险金额', 260, 350, 390, 375),
    box('惠鑫宝年金保险', 70, 390, 250, 415),
    box('100000.00元', 260, 390, 390, 415),
  ]);

  for (const text of ['产品名称', '保险合同号', '投保人']) {
    assert.ok(result.regions.basicInfo.some((item) => item.text === text));
    assert.ok(!result.regions.benefitTable.some((item) => item.text === text));
  }
  assert.ok(result.regions.benefitTable.some((item) => item.text === '保险利益表'));
  assert.ok(result.regions.benefitTable.some((item) => item.text === '100000.00元'));
});
