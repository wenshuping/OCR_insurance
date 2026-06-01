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
