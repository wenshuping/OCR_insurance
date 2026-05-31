import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndicatorSourceRepairPlan } from '../scripts/repair-indicator-source-governance.mjs';

const now = '2026-05-31T12:00:00.000Z';

test('buildIndicatorSourceRepairPlan repairs missing source excerpt and source record id', () => {
  const plan = buildIndicatorSourceRepairPlan({
    now,
    indicatorRows: [
      {
        id: 'fix-anxin-nursing-1',
        company: '新华保险',
        product_name: '新华人寿保险股份有限公司安鑫优选终身护理保险',
        coverage_type: '护理保障',
        liability: '护理保险金(18-61岁)',
        payload: {
          coverageType: '护理保障',
          liability: '护理保险金(18-61岁)',
          value: 160,
          unit: '%',
          basis: '实际交纳保险费',
          condition: '18-61周岁',
          sourceExcerpt: '',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '151',
        company: '新华保险',
        product_name: '新华人寿保险股份有限公司安鑫优选终身护理保险',
        url: 'https://example.com/anxin',
        payload: {
          productName: '新华人寿保险股份有限公司安鑫优选终身护理保险',
          pageText: '护理保险金 被保险人于18周岁至61周岁之间达到护理状态，我们按实际交纳保险费的160%给付护理保险金。',
        },
      },
    ],
  });

  assert.equal(plan.summary.missingSourceRepairs, 1);
  const update = plan.indicatorUpdates[0];
  assert.equal(update.reason, 'repair_missing_source_excerpt');
  assert.equal(update.row.payload.sourceRecordId, '151');
  assert.equal(update.row.payload.sourceUrl, 'https://example.com/anxin');
  assert.match(update.row.payload.sourceExcerpt, /护理保险金/u);
});

test('buildIndicatorSourceRepairPlan repairs optional indicator and optional record source links', () => {
  const plan = buildIndicatorSourceRepairPlan({
    now,
    indicatorRows: [
      {
        id: 'ind_optional_light',
        company: '新华保险',
        product_name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        coverage_type: '疾病保障',
        liability: '轻度疾病保险金',
        payload: {
          coverageType: '疾病保障',
          liability: '轻度疾病保险金',
          value: 20,
          unit: '%',
          basis: '基本保险金额',
          responsibilityScope: 'optional',
          sourceExcerpt: '可选责任一 轻度疾病保险金 按基本保险金额的20%给付。',
        },
      },
    ],
    optionalRows: [
      {
        id: 'opt_xinhua_1',
        company: '新华保险',
        product_name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        liability: '可选责任一',
        payload: {
          sourceExcerpt: '可选责任一 轻度疾病保险金 按基本保险金额的20%给付。',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '902',
        company: '新华保险',
        product_name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        url: 'https://example.com/xinhua-optional',
        payload: {
          productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
          pageText: '保险责任 3.可选责任一 轻度疾病保险金 按基本保险金额的20%给付。',
        },
      },
    ],
  });

  assert.equal(plan.summary.optionalSourceRepairs, 1);
  assert.equal(plan.summary.optionalRecordUpdates, 1);
  assert.equal(plan.indicatorUpdates[0].reason, 'repair_optional_source_link');
  assert.equal(plan.indicatorUpdates[0].row.payload.sourceRecordId, '902');
  assert.equal(plan.optionalRecordUpdates[0].row.payload.sourceRecordId, '902');
});

test('buildIndicatorSourceRepairPlan reclassifies only clear waiting-period refund rows', () => {
  const plan = buildIndicatorSourceRepairPlan({
    now,
    indicatorRows: [
      {
        id: 'refund_waiting_period',
        company: '新华保险',
        product_name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        coverage_type: '疾病保障',
        liability: '重大疾病保险金',
        payload: {
          coverageType: '疾病保障',
          liability: '重大疾病保险金',
          value: 100,
          unit: '%',
          basis: '已交保费',
          sourceExcerpt: '等待期内因疾病原因确诊发生重度疾病，我们不承担给付重大疾病保险金责任，本合同终止，并退还累计已交保险费。',
        },
      },
      {
        id: 'valid_waiting_period_payout',
        company: '新华保险',
        product_name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        coverage_type: '身故保障',
        liability: '身故或全残保险金',
        payload: {
          coverageType: '身故保障',
          liability: '身故或全残保险金',
          value: 105,
          unit: '%',
          basis: '已交保费',
          sourceExcerpt: '等待期内因意外伤害以外的原因导致身故或全残，我们按已交保险费105%给付身故或全残保险金。',
        },
      },
      {
        id: 'valid_after_waiting_period',
        company: '新华保险',
        product_name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        coverage_type: '身故保障',
        liability: '身故保险金',
        payload: {
          coverageType: '身故保障',
          liability: '身故保险金',
          value: 160,
          unit: '%',
          basis: '已交保费',
          sourceExcerpt: '等待期后因疾病原因身故，我们按已交保险费的160%给付身故保险金。',
        },
      },
    ],
  });

  assert.equal(plan.summary.waitingRefundReclasses, 1);
  assert.deepEqual(plan.indicatorUpdates.map((item) => item.row.id), ['refund_waiting_period']);
  assert.equal(plan.indicatorUpdates[0].row.coverageType, '规则参数');
  assert.equal(plan.indicatorUpdates[0].row.liability, '等待期退费处理');
  assert.equal(plan.indicatorUpdates[0].row.payload.originalLiability, '重大疾病保险金');
});
