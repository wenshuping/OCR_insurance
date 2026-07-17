import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInsurancePlanMatrixEvidence } from '../server/insurance-plan-matrix-evidence.service.mjs';

test('extracts a generic insurance plan matrix without product-specific configuration', () => {
  const result = extractInsurancePlanMatrixEvidence(`
    <table>
      <tr><th colspan="2">保障计划类别</th><th>计划一</th><th>计划二</th><th>计划三</th></tr>
      <tr><td colspan="2">年度免赔额</td><td>0</td><td>0</td><td>1万</td></tr>
      <tr><td rowspan="2">普通门急诊医疗费用保险金</td><td>一般门急诊治疗费</td><td>全额保障</td><td>全额保障</td><td rowspan="2">不适用</td></tr>
      <tr><td>精神疾病门急诊治疗费</td><td>1万</td><td>1万</td></tr>
      <tr><td rowspan="2">牙科医疗费用保险金</td><td>基础牙科治疗费</td><td rowspan="2">8000 / 赔付比例80%</td><td rowspan="2">不适用</td><td rowspan="2">不适用</td></tr>
      <tr><td>重大牙科治疗费</td></tr>
    </table>
  `);

  assert.equal(result.tables.length, 1);
  assert.deepEqual(result.tables[0].rows[2], [
    '普通门急诊医疗费用保险金',
    '一般门急诊治疗费',
    '全额保障',
    '全额保障',
    '不适用',
  ]);
  assert.deepEqual(result.tables[0].rows[5], [
    '牙科医疗费用保险金',
    '重大牙科治疗费',
    '8000 / 赔付比例80%',
    '不适用',
    '不适用',
  ]);
});

test('keeps cell and row boundaries that flat HTML stripping would lose', () => {
  const result = extractInsurancePlanMatrixEvidence(`
    <table><tr><th>保障项目</th><th>方案A</th><th>方案B</th></tr>
      <tr><td>住院医疗保险金</td><td><strong>200万</strong><br>全额保障</td><td>100万</td></tr>
    </table>
  `);

  assert.equal(result.text, [
    '保障计划表 1',
    '保障项目 | 方案A | 方案B',
    '住院医疗保险金 | 200万 / 全额保障 | 100万',
  ].join('\n'));
});

test('ignores navigation and unrelated tables', () => {
  const result = extractInsurancePlanMatrixEvidence(`
    <script>const fake = '<table><tr><td>计划一 保险责任</td></tr></table>';</script>
    <table><tr><td>栏目</td><td>首页</td></tr></table>
    <table><tr><td>计划一</td><td>计划二</td></tr><tr><td>联系电话</td><td>地址</td></tr></table>
  `);

  assert.deepEqual(result, { tables: [], text: '' });
});
