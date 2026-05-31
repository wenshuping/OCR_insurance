import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRemainingIndicatorGovernancePlan } from '../scripts/repair-indicator-remaining-governance.mjs';

const now = '2026-05-31T13:00:00.000Z';

test('remaining governance marks payout method as non calculable', () => {
  const plan = buildRemainingIndicatorGovernancePlan({
    now,
    indicatorRows: [
      {
        id: 'ind_payout_method',
        company: 'A',
        product_name: '产品A',
        coverage_type: '规则参数',
        liability: '赔付方式',
        payload: { coverageType: '规则参数', liability: '赔付方式', unit: '方式', basis: '保险责任赔付机制' },
      },
    ],
  });

  assert.equal(plan.summary.reasonCounts.mark_payout_method_non_calculable, 1);
  assert.equal(plan.indicatorUpdates[0].row.payload.excludeFromCalculation, true);
  assert.equal(plan.indicatorUpdates[0].row.payload.quantificationStatus, 'not_quantifiable');
});

test('remaining governance fixes branch labels and non-accident disability labels', () => {
  const plan = buildRemainingIndicatorGovernancePlan({
    now,
    indicatorRows: [
      {
        id: 'branch',
        company: 'A',
        product_name: '产品A',
        coverage_type: '意外保障',
        liability: '特定意外身故/全残',
        payload: {
          coverageType: '意外保障',
          liability: '特定意外身故/全残',
          sourceExcerpt: '航空意外伤害身故保险金 若被保险人因发生航空意外伤害事故导致身故，按基本保险金额给付。',
        },
      },
      {
        id: 'non_accident',
        company: 'A',
        product_name: '产品B',
        coverage_type: '意外保障',
        liability: '意外全残',
        payload: {
          coverageType: '意外保障',
          liability: '意外全残',
          sourceExcerpt: '若被保险人身故或发生本合同所约定的全残项目之一，我们按基本保险金额给付。',
        },
      },
    ],
  });

  const branch = plan.indicatorUpdates.find((item) => item.row.id === 'branch').row;
  const nonAccident = plan.indicatorUpdates.find((item) => item.row.id === 'non_accident').row;
  assert.equal(branch.liability, '特定意外身故保险金');
  assert.equal(nonAccident.coverageType, '人寿保障');
  assert.equal(nonAccident.liability, '全残保险金');
});

test('remaining governance repairs suspicious numeric extraction', () => {
  const plan = buildRemainingIndicatorGovernancePlan({
    now,
    indicatorRows: [
      {
        id: 'zero_multiple',
        company: 'A',
        product_name: '产品A',
        coverage_type: '疾病保障',
        liability: '重大疾病保险金',
        payload: {
          coverageType: '疾病保障',
          liability: '重大疾病保险金',
          value: 0,
          unit: '倍',
          basis: '条款载明基准',
          sourceExcerpt: '我们按住院保险金日额的一百五十倍，给付重大疾病保险金。',
        },
      },
      {
        id: 'concat_percent',
        company: 'A',
        product_name: '产品A',
        coverage_type: '现金流',
        liability: '满期保险金',
        payload: {
          coverageType: '现金流',
          liability: '满期保险金',
          value: 5120,
          unit: '%',
          basis: '已交保费',
          sourceExcerpt: '我公司将按照本合同的已交保险费的5120%给付满期保险金。',
        },
      },
      {
        id: 'high_percent',
        company: 'A',
        product_name: '产品A',
        coverage_type: '意外保障',
        liability: '意外身故保险金',
        payload: {
          coverageType: '意外保障',
          liability: '意外身故保险金',
          value: 1500,
          unit: '%',
          basis: '基本保额',
          sourceExcerpt: '再按基本保险金额的1500%给付意外伤害身故保险金。',
        },
      },
    ],
  });

  const zero = plan.indicatorUpdates.find((item) => item.row.id === 'zero_multiple').row;
  const concat = plan.indicatorUpdates.find((item) => item.row.id === 'concat_percent').row;
  const high = plan.indicatorUpdates.find((item) => item.row.id === 'high_percent').row;
  assert.equal(zero.payload.value, 150);
  assert.equal(zero.payload.basis, '住院保险金日额');
  assert.equal(concat.payload.value, 120);
  assert.equal(high.payload.value, 15);
  assert.equal(high.payload.unit, '倍');
});

test('remaining governance relabels cancer and maturity false positives and fills formulas', () => {
  const plan = buildRemainingIndicatorGovernancePlan({
    now,
    indicatorRows: [
      {
        id: 'cancer',
        company: 'A',
        product_name: '产品A',
        coverage_type: '疾病保障',
        liability: '防癌/恶性肿瘤(首次给付)',
        payload: {
          coverageType: '疾病保障',
          liability: '防癌/恶性肿瘤(首次给付)',
          value: 180,
          unit: '%',
          basis: '基本保额',
          sourceExcerpt: '重大疾病保险金=本合同基本保险金额×重大疾病保险金给付比例。',
        },
      },
      {
        id: 'maturity',
        company: 'A',
        product_name: '产品B',
        coverage_type: '现金流',
        liability: '满期返还',
        payload: {
          coverageType: '现金流',
          liability: '满期返还',
          value: 100,
          unit: '%',
          basis: '基本保额',
          sourceExcerpt: '自养老年金开始领取日起，若被保险人在养老年金领取日生存，按基本保险金额给付养老年金。',
        },
      },
      {
        id: 'formula',
        company: 'A',
        product_name: '产品C',
        coverage_type: '人寿保障',
        liability: '疾病身故',
        payload: {
          coverageType: '人寿保障',
          liability: '疾病身故',
          unit: '公式',
          basis: '已交保费',
          sourceExcerpt: '本公司给付身故保险金，其金额为本保险实际交纳的保险费，本合同终止。',
        },
      },
    ],
  });

  const cancer = plan.indicatorUpdates.find((item) => item.row.id === 'cancer').row;
  const maturity = plan.indicatorUpdates.find((item) => item.row.id === 'maturity').row;
  const formula = plan.indicatorUpdates.find((item) => item.row.id === 'formula').row;
  assert.equal(cancer.liability, '重大疾病保险金');
  assert.equal(maturity.liability, '养老年金');
  assert.equal(formula.payload.formulaText, '实际交纳保险费');
});

test('remaining governance deletes optional section summary and repairs optional references', () => {
  const plan = buildRemainingIndicatorGovernancePlan({
    now,
    indicatorRows: [
      {
        id: 'summary',
        company: 'A',
        product_name: '产品A',
        coverage_type: '疾病保障',
        liability: '本合同可选责任一包含轻度疾病保险金',
        payload: {
          responsibilityScope: 'optional',
          optionalResponsibilityId: 'opt_1',
          liability: '本合同可选责任一包含轻度疾病保险金',
          sourceExcerpt: '可选责任一 本合同可选责任一包含轻度疾病保险金、中度疾病保险金和轻中度疾病豁免保险费',
        },
      },
      {
        id: 'real',
        company: 'A',
        product_name: '产品A',
        coverage_type: '疾病保障',
        liability: '轻度疾病保险金',
        payload: {
          responsibilityScope: 'optional',
          optionalResponsibilityId: 'opt_1',
          liability: '轻度疾病保险金',
          value: 30,
          unit: '%',
          basis: '基本保险金额',
          formulaText: '基本保险金额 × 30%',
          sourceExcerpt: '轻度疾病保险金 按基本保险金额的30%给付。',
        },
      },
    ],
    optionalRows: [
      {
        id: 'opt_1',
        company: 'A',
        product_name: '产品A',
        liability: '可选责任一',
        payload: { indicatorIds: ['summary'], quantificationStatus: 'quantified' },
      },
    ],
  });

  assert.deepEqual(plan.indicatorDeletes, ['summary']);
  const optional = plan.optionalRecordUpdates[0].row;
  assert.deepEqual(optional.payload.indicatorIds, ['real']);
});
