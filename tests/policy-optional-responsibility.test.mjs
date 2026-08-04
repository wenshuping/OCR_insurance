import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachPolicyCoverageIndicators,
  buildOptionalResponsibilityReview,
  buildPolicyFromScan,
  createInitialState,
  findPolicyCoverageIndicators,
  normalizeBeneficiary,
  selectedCoverageIndicators,
} from '../server/policy-ocr.domain.mjs';
import { computePolicyResponsibilityCalculations } from '../server/cashflow-compute.mjs';

test('beneficiary normalization treats common legal-beneficiary OCR variants as legal', () => {
  assert.equal(normalizeBeneficiary('被保险人的法定继本人'), '法定');
  assert.equal(normalizeBeneficiary('身故保险金受益人：法定维承人'), '法定');
});

test('optional responsibility review preserves manual selection and excludes unselected indicators', () => {
  const optionalRecord = {
    company: '新华保险',
    productName: '测试产品',
    coverageType: '可选责任',
    liability: '航空意外额外给付',
    value: 10,
    unit: '倍',
    basis: '基本保额',
    sourceExcerpt: '可选责任：航空意外额外给付。',
  };
  const basicRecord = {
    company: '新华保险',
    productName: '测试产品',
    coverageType: '疾病保障',
    liability: '重疾首次给付',
    value: 100,
    unit: '%',
    basis: '基本保额',
  };
  const policy = {
    company: '新华保险',
    name: '测试产品',
    optionalResponsibilities: [
      {
        productName: '测试产品',
        coverageType: '可选责任',
        liability: '航空意外额外给付',
        selectionStatus: 'not_selected',
        selectionEvidence: 'manual',
      },
    ],
  };

  const indicators = findPolicyCoverageIndicators(policy, [optionalRecord, basicRecord]);
  const optionalIndicator = indicators.find((item) => item.liability === '航空意外额外给付');
  const selectedIndicators = selectedCoverageIndicators(indicators);
  const reviewItems = buildOptionalResponsibilityReview(policy, indicators);

  assert.equal(optionalIndicator.responsibilityScope, 'optional');
  assert.equal(optionalIndicator.selectionStatus, 'not_selected');
  assert.equal(selectedIndicators.some((item) => item.liability === '航空意外额外给付'), false);
  assert.equal(selectedIndicators.some((item) => item.liability === '重疾首次给付'), true);
  assert.equal(reviewItems.length, 1);
  assert.equal(reviewItems[0].selectionStatus, 'not_selected');
});

test('findPolicyCoverageIndicators matches legal insurer prefixes through the shared responsibility identity', () => {
  const indicators = findPolicyCoverageIndicators({
    company: '新华保险',
    name: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
    plans: [{
      company: '新华保险',
      name: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
      matchedProductName: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
      canonicalProductId: 'stale_ocr_match',
    }],
  }, [{
    id: 'maturity_indicator',
    company: '新华人寿保险股份有限公司',
    productName: '尊尚人生两全保险（分红型）',
    coverageType: '现金流',
    liability: '满期保险金',
    normalizedFormula: 'basic_insurance_amount',
    formulaText: '基本责任的保险金额',
    sourceEvidenceLevel: 'official_excerpt',
    sourceUrl: 'https://static-cdn.newchinalife.com/terms.pdf',
    sourceExcerpt: '按基本责任保险金额给付满期保险金。',
  }]);

  assert.deepEqual(indicators.map((item) => item.id), ['maturity_indicator']);
});

test('findPolicyCoverageIndicators removes a legacy disease-disability alias when the same official responsibility has a canonical indicator', () => {
  const sourceUrl = 'https://static-cdn.newchinalife.com/ncl/pdf/whole-life.pdf';
  const sourceExcerpt = [
    '身故或身体全残保险金',
    '被保险人于合同生效之日起180日内因疾病原因身故或身体全残，',
    '本公司按本保险实际交纳的保险费给付身故或身体全残保险金。',
  ].join('');
  const indicators = findPolicyCoverageIndicators({
    company: '新华保险',
    name: '测试终身寿险',
  }, [{
    id: 'legacy_disease_disability',
    company: '新华保险',
    productName: '测试终身寿险',
    coverageType: '人寿保障',
    liability: '疾病全残',
    formulaText: '疾病全残 = 现金价值',
    sourceUrl,
    sourceExcerpt,
  }, {
    id: 'canonical_death_disability',
    company: '新华保险',
    productName: '测试终身寿险',
    coverageType: '人寿保障',
    liability: '身故或身体全残保险金',
    formulaText: '身故或身体全残保险金 = max(已交保险费, 现金价值, 基本保险金额)',
    sourceUrl,
    sourceExcerpt,
  }]);

  assert.deepEqual(indicators.map((item) => item.id), ['canonical_death_disability']);
});

test('findPolicyCoverageIndicators preserves disease-disability rows from a different source version', () => {
  const sourceExcerpt = '身故或身体全残保险金 被保险人因疾病身故或身体全残时，按合同约定给付保险金。';
  const indicators = findPolicyCoverageIndicators({
    company: '新华保险',
    name: '测试终身寿险',
  }, [{
    id: 'legacy_other_version',
    company: '新华保险',
    productName: '测试终身寿险',
    coverageType: '人寿保障',
    liability: '疾病全残',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/version-a.pdf',
    sourceExcerpt,
  }, {
    id: 'canonical_current_version',
    company: '新华保险',
    productName: '测试终身寿险',
    coverageType: '人寿保障',
    liability: '身故或身体全残保险金',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/version-b.pdf',
    sourceExcerpt,
  }]);

  assert.deepEqual(indicators.map((item) => item.id), ['legacy_other_version', 'canonical_current_version']);
});

test('policy optional responsibility state overrides a legacy indicator that omitted its optional scope', () => {
  const indicators = findPolicyCoverageIndicators({
    company: '新华保险',
    name: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
    optionalResponsibilities: [{
      id: 'optional_longevity',
      company: '新华人寿保险股份有限公司',
      productName: '尊尚人生两全保险（分红型）',
      liability: '祝寿金',
      responsibilityScope: 'optional',
      selectionStatus: 'unknown',
      selectionEvidence: 'official_terms',
      quantificationStatus: 'pending_review',
    }],
  }, [{
    id: 'longevity_indicator',
    company: '新华人寿保险股份有限公司',
    productName: '尊尚人生两全保险（分红型）',
    coverageType: '现金流',
    liability: '祝寿金',
    responsibilityScope: 'basic_or_unspecified',
    selectionStatus: 'unknown',
    quantificationStatus: 'quantified',
    formulaText: '可选责任的保险金额',
    sourceEvidenceLevel: 'official_excerpt',
    sourceUrl: 'https://static-cdn.newchinalife.com/terms.pdf',
    sourceExcerpt: '按可选责任的保险金额给付祝寿金。',
  }]);

  assert.equal(indicators[0].responsibilityScope, 'optional');
  assert.equal(indicators[0].selectionStatus, 'unknown');
  assert.equal(indicators[0].quantificationStatus, 'pending_review');
  assert.equal(selectedCoverageIndicators(indicators).length, 0);
});

test('optional responsibility calculations use only the responsibility coverage amount across every selection state', () => {
  const indicator = {
    id: 'optional_birthday_benefit',
    company: '测试保险',
    productName: '测试两全保险',
    coverageType: '现金流',
    liability: '祝寿金',
    responsibilityScope: 'optional',
    optionalResponsibilityId: 'optional_birthday',
    selectionStatus: 'selected',
    quantificationStatus: 'quantified',
    value: 50,
    unit: '%',
    basis: '可选责任保险金额',
    formulaText: '可选责任保险金额 × 50%',
  };
  const basePolicy = {
    company: '测试保险',
    name: '测试两全保险',
    amount: 100000,
  };
  const selectedPolicy = {
    ...basePolicy,
    optionalResponsibilities: [{
      id: 'optional_birthday',
      liability: '祝寿金',
      selectionStatus: 'selected',
      quantificationStatus: 'quantified',
      coverageAmount: 30000,
    }],
  };
  const selectedCalculation = computePolicyResponsibilityCalculations(selectedPolicy, [indicator]);
  assert.equal(selectedCalculation.length, 1);
  assert.equal(selectedCalculation[0].amount, 15000);
  assert.match(selectedCalculation[0].calculationText, /可选责任保险金额30,000元 × 50%/u);
  assert.doesNotMatch(selectedCalculation[0].calculationText, /100,000/u);

  const selectedWithoutAmount = computePolicyResponsibilityCalculations({
    ...basePolicy,
    optionalResponsibilities: [{
      id: 'optional_birthday',
      liability: '祝寿金',
      selectionStatus: 'selected',
      quantificationStatus: 'quantified',
    }],
  }, [indicator]);
  assert.equal(selectedWithoutAmount.length, 1);
  assert.equal(selectedWithoutAmount[0].isPending, true);
  assert.match(selectedWithoutAmount[0].calculationText, /可选责任保险金额（待补充）/u);

  const withoutOptionalResponsibilityRecord = computePolicyResponsibilityCalculations(basePolicy, [indicator]);
  assert.equal(withoutOptionalResponsibilityRecord.length, 1);
  assert.equal(withoutOptionalResponsibilityRecord[0].isPending, true);
  assert.doesNotMatch(withoutOptionalResponsibilityRecord[0].calculationText, /100,000/u);

  for (const selectionStatus of ['not_selected', 'unknown']) {
    const calculations = computePolicyResponsibilityCalculations({
      ...basePolicy,
      optionalResponsibilities: [{
        id: 'optional_birthday',
        liability: '祝寿金',
        selectionStatus,
        quantificationStatus: 'quantified',
        coverageAmount: 30000,
      }],
    }, [{ ...indicator, selectionStatus }]);
    assert.deepEqual(calculations, [], `${selectionStatus} optional responsibility must not be calculated`);
  }
});

test('OCR evidence resolves a previously unknown optional responsibility draft', () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）';
  const policy = {
    company: '新华保险',
    name: productName,
    ocrText: '备注：本保单的保险责任包含基本责任和可选责任一、可选责任二。',
    optionalResponsibilities: [{
      id: 'opt_one',
      company: '新华保险',
      productName,
      coverageType: '可选责任',
      liability: '可选责任一',
      selectionStatus: 'unknown',
      selectionEvidence: 'manual',
    }],
  };
  const optionalResponsibilityRecords = [{
    id: 'opt_one',
    company: '新华保险',
    productName,
    coverageType: '可选责任',
    liability: '可选责任一',
    responsibilityScope: 'optional',
    quantificationStatus: 'quantified',
    indicatorIds: ['ind_light'],
  }];
  const indicatorRecords = [{
    id: 'ind_light',
    company: '新华保险',
    productName,
    coverageType: '疾病保障',
    liability: '轻度疾病保险金',
    value: 20,
    unit: '%',
    basis: '基本保险金额',
    responsibilityScope: 'optional',
    optionalResponsibilityId: 'opt_one',
    quantificationStatus: 'quantified',
  }];

  const attached = attachPolicyCoverageIndicators(policy, indicatorRecords, [], optionalResponsibilityRecords);
  const optionalOne = attached.optionalResponsibilities.find((item) => item.liability === '可选责任一');

  assert.equal(optionalOne.selectionStatus, 'selected');
  assert.equal(optionalOne.selectionEvidence, 'policy_ocr');
  assert.equal(selectedCoverageIndicators(attached.coverageIndicators).length, 1);
});

test('policy indicators preserve explicit optional scope and optional responsibility id', () => {
  const policy = {
    company: '新华保险',
    name: '测试重疾',
    optionalResponsibilities: [
      {
        id: 'opt_test_1',
        company: '新华保险',
        productName: '测试重疾',
        coverageType: '可选责任',
        liability: '可选责任一',
        selectionStatus: 'selected',
        selectionEvidence: 'manual',
        quantificationStatus: 'quantified',
        indicatorIds: ['ind_optional'],
      },
    ],
  };
  const indicatorRecords = [
    {
      id: 'ind_optional',
      company: '新华保险',
      productName: '测试重疾',
      coverageType: '疾病保障',
      liability: '轻度疾病保险金',
      value: 20,
      unit: '%',
      basis: '基本保险金额',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_test_1',
      quantificationStatus: 'quantified',
      sourceExcerpt: '轻度疾病保险金按基本保险金额的20%给付。',
    },
  ];

  const indicators = findPolicyCoverageIndicators(policy, indicatorRecords);

  assert.equal(indicators.length, 1);
  assert.equal(indicators[0].responsibilityScope, 'optional');
  assert.equal(indicators[0].optionalResponsibilityId, 'opt_test_1');
  assert.equal(indicators[0].selectionStatus, 'selected');
  assert.equal(selectedCoverageIndicators(indicators).length, 1);
});

test('official terms wording does not mark unrecognized optional responsibility as not selected', () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const policy = {
    company: '新华保险',
    name: productName,
    ocrText: 'NCI新华保险 保险单 险种名称 多倍保障重大疾病保险（智享版） 170000.00元 终身 20年交',
    responsibilities: [
      {
        coverageType: '保险责任',
        scenario: '本合同的保险责任分为基本责任和可选责任。'
          + '如投保的保险责任不含可选责任一，本合同终止。'
          + '如投保的保险责任含可选责任一，我们按条款承担保险责任。'
          + '3.可选责任一 （1）轻度疾病保险金。',
      },
    ],
  };
  const optionalResponsibilityRecords = [
    {
      id: 'opt_test_1',
      company: '新华保险',
      productName,
      liability: '可选责任一',
      responsibilityScope: 'optional',
      selectionStatus: 'unknown',
      quantificationStatus: 'quantified',
      indicatorIds: ['ind_optional', 'ind_optional_mid'],
    },
  ];
  const indicatorRecords = [
    {
      id: 'ind_optional',
      company: '新华保险',
      productName,
      coverageType: '疾病保障',
      liability: '轻度疾病保险金',
      value: 20,
      unit: '%',
      basis: '基本保险金额',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_test_1',
      quantificationStatus: 'quantified',
    },
    {
      id: 'ind_optional_mid',
      company: '新华保险',
      productName,
      coverageType: '疾病保障',
      liability: '中度疾病保险金',
      value: 50,
      unit: '%',
      basis: '基本保险金额',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_test_1',
      quantificationStatus: 'quantified',
    },
  ];

  const attached = attachPolicyCoverageIndicators(policy, indicatorRecords, [], optionalResponsibilityRecords);
  const optionalOne = attached.optionalResponsibilities.find((item) => item.liability === '可选责任一');
  const optionalIndicator = attached.coverageIndicators.find((item) => item.id === 'ind_optional');

  assert.equal(optionalOne.selectionStatus, 'unknown');
  assert.equal(optionalOne.quantificationStatus, 'quantified');
  assert.deepEqual(optionalOne.indicatorIds, ['ind_optional', 'ind_optional_mid']);
  assert.equal(optionalIndicator.selectionStatus, 'unknown');
  assert.equal(selectedCoverageIndicators(attached.coverageIndicators).some((item) => item.id === 'ind_optional'), false);
});

test('generic optional section displays one selectable package instead of one choice per child benefit', () => {
  const productName = '新华人寿保险股份有限公司附加学生平安A1款意外伤害医疗保险';
  const policy = {
    company: '新华保险',
    name: productName,
    ocrText: '险种名称 附加学生平安A1款意外伤害医疗保险',
  };
  const knowledgeRecords = [
    {
      id: '278',
      company: '新华保险',
      productName,
      pageText: [
        '保险责任 本合同保险责任分为必选责任和可选责任。',
        '2.可选责任：',
        '（1）狂犬病疫苗接种医疗费用保险金 被保险人发生意外伤害并因该意外伤害接受狂犬病疫苗接种，我们按约定给付狂犬病疫苗接种医疗费用保险金。',
        '（2）微创美容缝合医疗费用保险金 被保险人发生意外伤害并接受微创美容缝合治疗，我们按约定给付微创美容缝合医疗费用保险金。',
      ].join('\n'),
    },
  ];

  const reviewItems = buildOptionalResponsibilityReview(policy, [], knowledgeRecords, []);

  assert.deepEqual(reviewItems.map((item) => item.liability), ['可选责任']);
});

test('manual optional selection preserves quantified product indicators', () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const policy = {
    company: '新华保险',
    name: productName,
    optionalResponsibilities: [
      {
        id: 'opt_test_1',
        company: '新华保险',
        productName,
        coverageType: '可选责任',
        liability: '可选责任一',
        selectionStatus: 'selected',
        selectionEvidence: 'manual',
      },
    ],
  };
  const optionalResponsibilityRecords = [
    {
      id: 'opt_test_1',
      company: '新华保险',
      productName,
      liability: '可选责任一',
      responsibilityScope: 'optional',
      selectionStatus: 'unknown',
      quantificationStatus: 'quantified',
      indicatorIds: ['ind_optional', 'ind_optional_mid'],
    },
  ];
  const indicatorRecords = [
    {
      id: 'ind_optional',
      company: '新华保险',
      productName,
      coverageType: '疾病保障',
      liability: '轻度疾病保险金',
      value: 20,
      unit: '%',
      basis: '基本保险金额',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_test_1',
      quantificationStatus: 'quantified',
    },
    {
      id: 'ind_optional_mid',
      company: '新华保险',
      productName,
      coverageType: '疾病保障',
      liability: '中度疾病保险金',
      value: 50,
      unit: '%',
      basis: '基本保险金额',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_test_1',
      quantificationStatus: 'quantified',
    },
  ];

  const attached = attachPolicyCoverageIndicators(policy, indicatorRecords, [], optionalResponsibilityRecords);
  const optionalOne = attached.optionalResponsibilities.find((item) => item.liability === '可选责任一');

  assert.equal(optionalOne.selectionStatus, 'selected');
  assert.equal(optionalOne.selectionEvidence, 'manual');
  assert.equal(optionalOne.quantificationStatus, 'quantified');
  assert.deepEqual(optionalOne.indicatorIds, ['ind_optional', 'ind_optional_mid']);
  assert.equal(selectedCoverageIndicators(attached.coverageIndicators).some((item) => item.id === 'ind_optional'), true);
  assert.equal(selectedCoverageIndicators(attached.coverageIndicators).some((item) => item.id === 'ind_optional_mid'), true);
});

test('optional responsibility review falls back to official terms when structured indicators omit optional sections', () => {
  const policy = {
    company: '新华保险',
    name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
    ocrText: '备注:《多倍保障重大疾病保险（智赢版）》的保险责任包含基本责任和可选责任一。可选责任一经确定，在本合同保险期间内不得变更。',
  };
  const indicators = [
    {
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      coverageType: '疾病保障',
      liability: '重疾(首次给付)',
      sourceExcerpt: '第一次重度疾病保险金。',
    },
    {
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      coverageType: '规则参数',
      liability: '等待期',
      sourceExcerpt: '在本合同保险期间内，我们根据您的选择按下列规定承担相应保险责任：1.等待期。',
    },
  ];
  const knowledgeRecords = [
    {
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      pageText: '保险责任 本合同的保险责任分为基本责任和可选责任。如投保的保险责任不含可选责任一，本合同终止。3.可选责任一 （1）轻度疾病保险金 被保险人发生轻度疾病的，我们按基本保险金额的20%给付轻度疾病保险金。（2）中度疾病保险金。4.可选责任二 身故保险金。',
    },
  ];

  const reviewItems = buildOptionalResponsibilityReview(policy, indicators, knowledgeRecords);
  const optionalOne = reviewItems.find((item) => item.liability === '可选责任一');
  const optionalTwo = reviewItems.find((item) => item.liability === '可选责任二');

  assert.equal(reviewItems.length, 2);
  assert.equal(optionalOne.productName, '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）');
  assert.equal(optionalOne.coverageType, '可选责任');
  assert.equal(optionalOne.selectionStatus, 'selected');
  assert.equal(optionalOne.selectionEvidence, 'policy_ocr');
  assert.match(optionalOne.sourceExcerpt, /轻度疾病保险金/u);
  assert.equal(optionalTwo.selectionStatus, 'not_selected');
  assert.equal(optionalTwo.selectionEvidence, 'policy_ocr');
});

test('optional responsibility review dedupes governance records and official-term fallback records', () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const policy = {
    company: '新华保险',
    name: productName,
    ocrText: '保险责任包含基本责任和可选责任一。',
  };
  const knowledgeRecords = [
    {
      company: '新华保险',
      productName,
      pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金。',
    },
  ];
  const optionalResponsibilityRecords = [
    {
      company: '新华保险',
      productName,
      coverageType: '可选责任',
      liability: '可选责任一',
      selectionStatus: 'unknown',
      selectionEvidence: 'official_terms',
      quantificationStatus: 'pending_review',
    },
  ];

  const reviewItems = buildOptionalResponsibilityReview(policy, [], knowledgeRecords, optionalResponsibilityRecords);

  assert.equal(reviewItems.length, 1);
  assert.equal(reviewItems[0].company, '新华保险');
  assert.equal(reviewItems[0].liability, '可选责任一');
  assert.equal(reviewItems[0].selectionStatus, 'selected');
});

test('optional responsibility review dedupes same product liability across different ids', () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const reviewItems = buildOptionalResponsibilityReview({ company: '新华保险', name: productName }, [], [], [
    {
      id: 'legacy_optional_one',
      company: '新华保险',
      productName,
      coverageType: '可选责任',
      liability: '可选责任一',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
    },
    {
      id: 'rebuilt_optional_one',
      company: '新华保险',
      productName,
      coverageType: '可选责任',
      liability: '可选责任一',
      selectionStatus: 'selected',
      quantificationStatus: 'quantified',
      indicatorIds: ['ind_optional_one'],
    },
    {
      id: 'optional_two',
      company: '新华保险',
      productName,
      coverageType: '可选责任',
      liability: '可选责任二',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
    },
  ]);

  assert.equal(reviewItems.length, 2);
  assert.deepEqual(reviewItems.map((item) => item.liability).sort(), ['可选责任一', '可选责任二']);
  assert.equal(reviewItems.find((item) => item.liability === '可选责任一').quantificationStatus, 'quantified');
  assert.deepEqual(reviewItems.find((item) => item.liability === '可选责任一').indicatorIds, ['ind_optional_one']);
});

test('optional responsibility review uses matched official product identity for short OCR names', () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）';
  const policy = {
    company: '新华保险',
    name: '多倍保障重大疾病保险（智赢版）',
    plans: [
      {
        role: 'main',
        company: '新华保险',
        name: '多倍保障重大疾病保险（智赢版）',
        matchedProductName: productName,
      },
    ],
  };
  const knowledgeRecords = [
    {
      id: '796',
      company: '新华保险',
      productName,
      title: productName,
      pageText: '保险责任。3.可选责任一 轻度疾病保险金。4.可选责任二 重度恶性肿瘤多次给付保险金。',
    },
  ];
  const optionalResponsibilityRecords = [
    {
      id: 'opt_legacy_one',
      company: '新华保险',
      productName,
      liability: '可选责任一',
      selectionStatus: 'selected',
      quantificationStatus: 'quantified',
      indicatorIds: ['ind_one'],
    },
    {
      id: 'opt_legacy_two',
      company: '新华保险',
      productName,
      liability: '可选责任二',
      selectionStatus: 'selected',
      quantificationStatus: 'quantified',
      indicatorIds: ['ind_two'],
    },
    {
      id: 'opt_short_one',
      company: '新华保险',
      productName: policy.name,
      liability: '可选责任一',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
    },
    {
      id: 'opt_short_two',
      company: '新华保险',
      productName: policy.name,
      liability: '可选责任二',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
    },
  ];

  const reviewItems = buildOptionalResponsibilityReview(policy, [], knowledgeRecords, optionalResponsibilityRecords);

  assert.equal(reviewItems.length, 2);
  assert.deepEqual(reviewItems.map((item) => item.productName), [productName, productName]);
  assert.deepEqual(reviewItems.map((item) => item.liability).sort(), ['可选责任一', '可选责任二']);
  assert.equal(reviewItems.some((item) => item.productName === policy.name), false);
});

test('canonical product id prevents similar product editions from sharing optional indicators', () => {
  const xiangId = 'product_xiang';
  const yingId = 'product_ying';
  const policy = {
    company: '新华保险',
    name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
    canonicalProductId: xiangId,
    plans: [
      {
        role: 'main',
        company: '新华保险',
        name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        matchedProductName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        canonicalProductId: xiangId,
      },
    ],
    optionalResponsibilities: [
      {
        id: 'opt_xiang_2',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        canonicalProductId: xiangId,
        liability: '可选责任二',
        selectionStatus: 'selected',
        quantificationStatus: 'quantified',
        indicatorIds: ['ind_xiang_cancer'],
      },
    ],
  };
  const indicators = findPolicyCoverageIndicators(policy, [
    {
      id: 'ind_xiang_cancer',
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      canonicalProductId: xiangId,
      coverageType: '重大疾病保障',
      liability: '重度恶性肿瘤多次给付保险金',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_xiang_2',
      quantificationStatus: 'quantified',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
    },
    {
      id: 'ind_ying_cancer',
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
      canonicalProductId: yingId,
      coverageType: '重大疾病保障',
      liability: '重度恶性肿瘤多次给付保险金',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_ying_2',
      quantificationStatus: 'quantified',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
    },
  ]);

  assert.deepEqual(indicators.map((item) => item.id), ['ind_xiang_cancer']);
  assert.deepEqual(selectedCoverageIndicators(indicators).map((item) => item.id), ['ind_xiang_cancer']);
});

test('optional indicator with mismatched optional responsibility id is not selected by key fallback', () => {
  const canonicalProductId = 'product_selected';
  const policy = {
    company: '新华保险',
    name: '测试重疾',
    canonicalProductId,
    optionalResponsibilities: [
      {
        id: 'opt_selected',
        company: '新华保险',
        productName: '测试重疾',
        canonicalProductId,
        coverageType: '重大疾病保障',
        liability: '重度恶性肿瘤多次给付保险金',
        selectionStatus: 'selected',
        quantificationStatus: 'quantified',
      },
    ],
  };
  const indicators = findPolicyCoverageIndicators(policy, [
    {
      id: 'ind_mismatch',
      company: '新华保险',
      productName: '测试重疾',
      canonicalProductId,
      coverageType: '重大疾病保障',
      liability: '重度恶性肿瘤多次给付保险金',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_other',
      quantificationStatus: 'quantified',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
    },
  ]);

  assert.equal(indicators[0].optionalResponsibilityId, 'opt_other');
  assert.notEqual(indicators[0].selectionStatus, 'selected');
  assert.equal(selectedCoverageIndicators(indicators).some((item) => item.id === 'ind_mismatch'), false);
});

test('optional responsibility review matches canonical product id before name fallback', () => {
  const xiangId = 'product_xiang';
  const yingId = 'product_ying';
  const policy = {
    company: '新华保险',
    name: 'OCR短名',
    canonicalProductId: xiangId,
    plans: [
      {
        role: 'main',
        company: '新华保险',
        name: 'OCR短名',
        matchedProductName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        canonicalProductId: xiangId,
      },
    ],
  };
  const records = buildOptionalResponsibilityReview(policy, [], [], [
    {
      id: 'opt_xiang_1',
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      canonicalProductId: xiangId,
      liability: '可选责任一',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
    },
    {
      id: 'opt_ying_1',
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
      canonicalProductId: yingId,
      liability: '可选责任一',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
    },
  ]);

  assert.deepEqual(records.map((record) => record.id), ['opt_xiang_1']);
  assert.equal(records[0].canonicalProductId, xiangId);
});

test('buildPolicyFromScan stores selected optional responsibilities from analysis draft', () => {
  const state = createInitialState();
  const policy = buildPolicyFromScan({
    state,
    scan: {
      ocrText: '保单载明已投保航空意外额外给付。',
      data: {
        company: '新华保险',
        name: '测试产品',
        applicant: '张三',
        insured: '张三',
        date: '2026-05-31',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: 100000,
        firstPremium: 3000,
      },
    },
    analysis: {
      report: '已识别保险责任。',
      coverageTable: [],
      optionalResponsibilities: [
        {
          id: 'opt_selected_test',
          productName: '测试产品',
          coverageType: '可选责任',
          liability: '航空意外额外给付',
          selectionStatus: 'selected',
          selectionEvidence: 'manual',
        },
      ],
    },
  });

  assert.equal(policy.optionalResponsibilities.length, 1);
  assert.equal(policy.optionalResponsibilities[0].selectionStatus, 'selected');
  assert.equal(policy.optionalResponsibilities[0].selectionEvidence, 'manual');
});

test('policy attachment uses product optional records and filters unquantified optional indicators', () => {
  const policy = {
    company: '新华保险',
    name: '测试重疾',
    ocrText: '保险责任包含基本责任和可选责任一。',
  };
  const optionalResponsibilityRecords = [
    {
      id: 'opt_test_1',
      company: '新华保险',
      productName: '测试重疾',
      liability: '可选责任一',
      responsibilityScope: 'optional',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
      quantificationReason: '缺少可计算结构化指标',
      indicatorIds: [],
    },
  ];
  const indicatorRecords = [
    {
      id: 'ind_basic',
      company: '新华保险',
      productName: '测试重疾',
      coverageType: '疾病保障',
      liability: '重疾首次给付',
      value: 100,
      unit: '%',
      basis: '基本保额',
    },
  ];

  const attached = attachPolicyCoverageIndicators(policy, indicatorRecords, [], optionalResponsibilityRecords);

  assert.equal(attached.optionalResponsibilities.length, 1);
  assert.equal(attached.optionalResponsibilities[0].quantificationStatus, 'pending_review');
  assert.equal(attached.coverageIndicators.length, 1);
  assert.equal(selectedCoverageIndicators(attached.coverageIndicators).length, 1);
});
