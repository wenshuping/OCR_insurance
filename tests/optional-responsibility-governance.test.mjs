import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOptionalResponsibilityId,
  buildOptionalResponsibilityRecords,
  extractOptionalIndicatorsFromSection,
  isSelectedQuantifiedIndicator,
  normalizeOptionalResponsibilityRecord,
  rebuildOptionalResponsibilityGovernance,
} from '../server/optional-responsibility-governance.mjs';

const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';

test('buildOptionalResponsibilityRecords extracts optional sections and links quantified indicators', () => {
  const policy = {
    company: '新华保险',
    name: productName,
    ocrText: '保险责任包含基本责任和可选责任一。',
  };
  const knowledgeRecords = [
    {
      company: '新华保险',
      productName,
      pageText: '保险责任 本合同分为基本责任和可选责任。3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。（2）中度疾病保险金 按基本保险金额的50%给付。',
    },
  ];
  const optionalId = buildOptionalResponsibilityId({
    company: '新华保险',
    productName,
    liability: '可选责任一',
  });
  const indicators = [
    {
      id: 'ind_light',
      company: '新华保险',
      productName,
      coverageType: '疾病保障',
      liability: '轻度疾病保险金',
      value: 20,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '基本保额 × 20%',
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalId,
      quantificationStatus: 'quantified',
    },
  ];

  const records = buildOptionalResponsibilityRecords({
    policy,
    knowledgeRecords,
    indicators,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].id, optionalId);
  assert.equal(records[0].liability, '可选责任一');
  assert.equal(records[0].selectionStatus, 'selected');
  assert.equal(records[0].quantificationStatus, 'quantified');
  assert.deepEqual(records[0].indicatorIds, ['ind_light']);
  assert.match(records[0].sourceExcerpt, /轻度疾病保险金/u);
});

test('buildOptionalResponsibilityRecords marks unlinked optional sections as pending review', () => {
  const records = buildOptionalResponsibilityRecords({
    policy: { company: '新华保险', name: productName },
    knowledgeRecords: [
      {
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。',
      },
    ],
    indicators: [],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].quantificationStatus, 'pending_review');
  assert.equal(records[0].quantificationReason, '缺少可计算结构化指标');
});

test('normalizeOptionalResponsibilityRecord preserves manual not quantifiable state', () => {
  const normalized = normalizeOptionalResponsibilityRecord({
    company: '新华保险',
    productName,
    liability: '可选责任二',
    quantificationStatus: 'not_quantifiable',
    quantificationReason: '条款仅提示权益，不进入金额计算',
    selectionStatus: 'selected',
    indicatorIds: [''],
  });

  assert.equal(normalized.quantificationStatus, 'not_quantifiable');
  assert.equal(normalized.quantificationReason, '条款仅提示权益，不进入金额计算');
  assert.deepEqual(normalized.indicatorIds, []);
});

test('isSelectedQuantifiedIndicator requires selected optional status and quantified status', () => {
  assert.equal(isSelectedQuantifiedIndicator({ responsibilityScope: 'basic' }), true);
  assert.equal(isSelectedQuantifiedIndicator({
    responsibilityScope: 'optional',
    selectionStatus: 'selected',
    quantificationStatus: 'quantified',
  }), true);
  assert.equal(isSelectedQuantifiedIndicator({
    responsibilityScope: 'optional',
    selectionStatus: 'selected',
    quantificationStatus: 'pending_review',
  }), false);
  assert.equal(isSelectedQuantifiedIndicator({
    responsibilityScope: 'optional',
    selectionStatus: 'unknown',
    quantificationStatus: 'quantified',
  }), false);
});

test('extractOptionalIndicatorsFromSection builds quantified disease indicators', () => {
  const section = {
    company: '新华保险',
    productName,
    liability: '可选责任一',
    sourceExcerpt: '3.可选责任一 （1）轻度疾病保险金 被保险人确诊轻度疾病，我们按基本保险金额的20%给付轻度疾病保险金。（2）中度疾病保险金 按基本保险金额的50%给付。',
  };

  const indicators = extractOptionalIndicatorsFromSection(section);

  assert.deepEqual(
    indicators.map((row) => ({
      coverageType: row.coverageType,
      liability: row.liability,
      value: row.value,
      unit: row.unit,
      basis: row.basis,
      responsibilityScope: row.responsibilityScope,
      quantificationStatus: row.quantificationStatus,
    })),
    [
      {
        coverageType: '疾病保障',
        liability: '轻度疾病保险金',
        value: 20,
        unit: '%',
        basis: '基本保险金额',
        responsibilityScope: 'optional',
        quantificationStatus: 'quantified',
      },
      {
        coverageType: '疾病保障',
        liability: '中度疾病保险金',
        value: 50,
        unit: '%',
        basis: '基本保险金额',
        responsibilityScope: 'optional',
        quantificationStatus: 'quantified',
      },
    ],
  );
});

test('rebuildOptionalResponsibilityGovernance produces records and indicators from knowledge records', () => {
  const state = {
    knowledgeRecords: [
      {
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
  };

  const next = rebuildOptionalResponsibilityGovernance(state);

  assert.equal(next.optionalResponsibilityRecords.length, 1);
  assert.equal(next.optionalResponsibilityRecords[0].quantificationStatus, 'quantified');
  assert.equal(next.insuranceIndicatorRecords.some((row) => row.responsibilityScope === 'optional'), true);
});
