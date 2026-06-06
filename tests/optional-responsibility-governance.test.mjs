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
      id: '902',
      company: '新华保险',
      productName,
      url: 'https://example.com/xinhua-optional',
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
  assert.equal(records[0].sourceRecordId, '902');
  assert.equal(records[0].sourceUrl, 'https://example.com/xinhua-optional');
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

test('buildOptionalResponsibilityRecords repairs generic optional sections into concrete benefit records', () => {
  const productName = '新华人寿保险股份有限公司附加学生平安A1款意外伤害医疗保险';
  const records = buildOptionalResponsibilityRecords({
    policy: { company: '新华保险', name: productName },
    knowledgeRecords: [
      {
        id: '278',
        company: '新华保险',
        productName,
        pageText: [
          '保险责任 本合同保险责任分为必选责任和可选责任。',
          '2.可选责任：',
          '（1）狂犬病疫苗接种医疗费用保险金 被保险人发生意外伤害并接受狂犬病疫苗接种，我们按约定给付狂犬病疫苗接种医疗费用保险金。',
          '（2）微创美容缝合医疗费用保险金 被保险人发生意外伤害并接受微创美容缝合治疗，我们按约定给付微创美容缝合医疗费用保险金。',
        ].join('\n'),
      },
    ],
    indicators: [
      {
        id: 'ind_rabies',
        company: '新华保险',
        productName,
        coverageType: '医疗保障',
        liability: '狂犬病疫苗接种医疗费用保险金',
        responsibilityScope: 'optional',
        optionalResponsibilityId: 'opt_old_generic',
        quantificationStatus: 'quantified',
        value: null,
        unit: '公式',
        basis: '合理医疗费用',
        formulaText: '医疗费用 × 赔付比例',
      },
    ],
    existingRecords: [
      {
        id: 'opt_old_generic',
        company: '新华保险',
        productName,
        liability: '可选责任',
        indicatorIds: ['ind_rabies'],
      },
    ],
  });

  assert.deepEqual(
    records.map((record) => record.liability),
    ['狂犬病疫苗接种医疗费用保险金', '微创美容缝合医疗费用保险金'],
  );
  assert.deepEqual(records[0].indicatorIds, ['ind_rabies']);
  assert.equal(records[0].quantificationStatus, 'quantified');
  assert.equal(records.some((record) => record.liability === '可选责任'), false);
});

test('buildOptionalResponsibilityRecords keeps optional sections when terms include conditional not-selected wording', () => {
  const records = buildOptionalResponsibilityRecords({
    policy: { company: '新华保险', name: productName },
    knowledgeRecords: [
      {
        company: '新华保险',
        productName,
        pageText: [
          '保险责任 本合同的保险责任分为基本责任和可选责任，您在投保时可以单独投保基本责任，也可以在投保基本责任的基础上投保一项或多项可选责任，但不能单独投保可选责任。',
          '如投保的保险责任不含可选责任一，被保险人在等待期内因疾病原因确诊发生重度疾病，本合同终止。',
          '如投保的保险责任含可选责任一，被保险人在等待期内因疾病原因确诊发生轻度疾病、中度疾病或重度疾病，本合同终止。',
          '3.可选责任一 （1）轻度疾病保险金 被保险人确诊轻度疾病，我们按基本保险金额的20%给付轻度疾病保险金。',
          '4.可选责任二 （1）重度疾病额外给付保险金 被保险人确诊重度疾病，我们按基本保险金额的50%给付重度疾病额外给付保险金。',
        ].join('\n'),
      },
    ],
    indicators: [],
  });

  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.liability === '可选责任一'));
  assert.ok(records.some((record) => record.liability === '可选责任二'));
});

test('buildOptionalResponsibilityRecords does not link optional indicators from other products', () => {
  const records = buildOptionalResponsibilityRecords({
    policy: { company: '新华保险', name: productName },
    knowledgeRecords: [
      {
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金。',
      },
    ],
    indicators: [
      {
        id: 'other_product_optional',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司其他重大疾病保险',
        coverageType: '疾病保障',
        liability: '轻度疾病保险金',
        value: 20,
        unit: '%',
        basis: '基本保险金额',
        formulaText: '基本保额 × 20%',
        responsibilityScope: 'optional',
        sourceExcerpt: '3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。',
      },
    ],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].liability, '可选责任一');
  assert.equal(records[0].quantificationStatus, 'pending_review');
  assert.deepEqual(records[0].indicatorIds, []);
});

test('buildOptionalResponsibilityRecords prefers canonical product id when linking optional indicators', () => {
  const xiangId = 'product_xiang';
  const yingId = 'product_ying';
  const optionalId = buildOptionalResponsibilityId({
    company: '新华保险',
    productName: 'OCR短名',
    canonicalProductId: xiangId,
    liability: '可选责任一',
  });
  const records = buildOptionalResponsibilityRecords({
    policy: {
      company: '新华保险',
      name: 'OCR短名',
      canonicalProductId: xiangId,
    },
    knowledgeRecords: [
      {
        id: 'xiang_terms',
        company: '新华保险',
        productName: 'OCR短名',
        canonicalProductId: xiangId,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金。',
      },
    ],
    indicators: [
      {
        id: 'ind_xiang',
        company: '新华保险',
        productName: 'OCR短名',
        canonicalProductId: xiangId,
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
      {
        id: 'ind_ying',
        company: '新华保险',
        productName: 'OCR短名',
        canonicalProductId: yingId,
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
    ],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].canonicalProductId, xiangId);
  assert.deepEqual(records[0].indicatorIds, ['ind_xiang']);
});

test('buildOptionalResponsibilityRecords does not link mismatched optional responsibility ids by liability fallback', () => {
  const records = buildOptionalResponsibilityRecords({
    policy: {
      company: '新华保险',
      name: productName,
    },
    knowledgeRecords: [
      {
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金。',
      },
    ],
    indicators: [
      {
        id: 'ind_mismatch',
        company: '新华保险',
        productName,
        coverageType: '疾病保障',
        liability: '轻度疾病保险金',
        value: 20,
        unit: '%',
        basis: '基本保险金额',
        formulaText: '基本保额 × 20%',
        responsibilityScope: 'optional',
        optionalResponsibilityId: 'opt_other',
        quantificationStatus: 'quantified',
        sourceExcerpt: '3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。',
      },
    ],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].quantificationStatus, 'pending_review');
  assert.deepEqual(records[0].indicatorIds, []);
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
    sourceRecordId: '902',
    sourceUrl: 'https://example.com/xinhua-optional',
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
      sourceRecordId: row.sourceRecordId,
      sourceUrl: row.sourceUrl,
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
        sourceRecordId: '902',
        sourceUrl: 'https://example.com/xinhua-optional',
      },
      {
        coverageType: '疾病保障',
        liability: '中度疾病保险金',
        value: 50,
        unit: '%',
        basis: '基本保险金额',
        responsibilityScope: 'optional',
        quantificationStatus: 'quantified',
        sourceRecordId: '902',
        sourceUrl: 'https://example.com/xinhua-optional',
      },
    ],
  );
});

test('extractOptionalIndicatorsFromSection quantifies base amount and daily allowance formulas', () => {
  const section = {
    company: '农银人寿',
    productName: '农银人寿金穗住院医疗保险',
    liability: '可选责任三',
    sourceExcerpt: [
      '可选责任三：意外伤害住院津贴保险金',
      '我们按意外伤害住院津贴日额与住院日数相乘的金额给付意外伤害住院津贴保险金。',
      '可选责任四 特定失能疾病额外给付保险金 被保险人确诊特定失能疾病，我们按基本保险金额给付特定失能疾病额外给付保险金。',
    ].join(' '),
  };

  const indicators = extractOptionalIndicatorsFromSection(section);

  assert.ok(indicators.some((row) =>
    row.liability.includes('意外伤害住院津贴')
      && row.basis === '住院津贴日额'
      && row.formulaText === '住院津贴日额 × 住院日数'
  ));
  assert.ok(indicators.some((row) =>
    row.liability.includes('特定失能疾病额外给付')
      && row.value === 100
      && row.unit === '%'
      && row.formulaText.includes('100%')
  ));
});

test('extractOptionalIndicatorsFromSection prefers the actual insurance benefit name over lead-in wording', () => {
  const section = {
    company: '利安人寿',
    productName: '利安利利爱家守护终身寿险',
    liability: '可选责任一',
    sourceExcerpt: [
      '可选责任一：意外身故保险金',
      '若被保险人遭受意外伤害，并自意外伤害发生之日起180日内以该意外伤害为直接原因导致身故，',
      '我们除按本合同的约定给付身故保险金之外，还将按被保险人身故时本合同基本保险金额的50%给付意外身故保险金。',
    ].join(' '),
  };

  const indicators = extractOptionalIndicatorsFromSection(section);

  assert.ok(indicators.some((row) => row.liability === '意外身故保险金'));
  assert.equal(indicators.some((row) => row.liability === '我们除按本合同的约定给付'), false);
});

test('extractOptionalIndicatorsFromSection reads optional heading benefit names without numbered clauses', () => {
  const section = {
    company: '新华保险',
    productName,
    liability: '可选责任二',
    sourceExcerpt: [
      '可选责任二重度恶性肿瘤多次给付保险金',
      '被保险人于等待期后由本公司认可医院的专科医生确诊初次发生本合同所指的“恶性肿瘤——重度”后，',
      '于85周岁保单周年日之前再次确诊发生本合同所指的“恶性肿瘤——重度”，',
      '且满足间隔期条件，我们按基本保险金额给付重度恶性肿瘤多次给付保险金。',
    ].join(''),
  };

  const indicators = extractOptionalIndicatorsFromSection(section);

  assert.ok(indicators.some((row) =>
    row.liability === '重度恶性肿瘤多次给付保险金'
      && row.value === 100
      && row.unit === '%'
      && row.basis === '基本保险金额'
  ));
  assert.equal(indicators.some((row) => /基本保险金额给付/u.test(row.liability)), false);
});

test('rebuildOptionalResponsibilityGovernance produces records and indicators from knowledge records', () => {
  const state = {
    knowledgeRecords: [
      {
        id: '902',
        company: '新华保险',
        productName,
        url: 'https://example.com/xinhua-optional',
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
  assert.equal(next.optionalResponsibilityRecords[0].sourceRecordId, '902');
  assert.equal(next.insuranceIndicatorRecords.find((row) => row.responsibilityScope === 'optional')?.sourceRecordId, '902');
});

test('rebuildOptionalResponsibilityGovernance keeps canonical products with colliding legacy optional ids separate', () => {
  const state = {
    knowledgeRecords: [
      {
        id: 'terms_a',
        company: '新华保险',
        productName,
        canonicalProductId: 'product_a',
        pageText: '保险责任。3.可选责任一 轻度疾病保险金按基本保险金额20%给付。',
      },
      {
        id: 'terms_b',
        company: '新华保险',
        productName,
        canonicalProductId: 'product_b',
        pageText: '保险责任。3.可选责任一 轻度疾病保险金按基本保险金额20%给付。',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
  };

  const next = rebuildOptionalResponsibilityGovernance(state);
  const optionalRecords = next.optionalResponsibilityRecords;

  assert.equal(optionalRecords.length, 2);
  assert.equal(new Set(optionalRecords.map((record) => record.id)).size, 2);
  assert.deepEqual(
    optionalRecords.map((record) => record.canonicalProductId).sort(),
    ['product_a', 'product_b'],
  );
});

test('rebuildOptionalResponsibilityGovernance adds missing optional records without dropping repaired existing records', () => {
  const optionalOneId = buildOptionalResponsibilityId({
    company: '新华保险',
    productName,
    liability: '可选责任一',
  });
  const optionalTwoId = buildOptionalResponsibilityId({
    company: '新华保险',
    productName,
    liability: '可选责任二',
  });
  const unrelatedExistingId = buildOptionalResponsibilityId({
    company: '测试保险',
    productName: '测试可选产品',
    liability: '可选责任',
  });
  const state = {
    knowledgeRecords: [
      {
        id: '902',
        company: '新华保险',
        productName,
        url: 'https://example.com/xinhua-optional',
        pageText: [
          '保险责任 本合同分为基本责任和可选责任。',
          '3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。',
          '4.可选责任二重度恶性肿瘤多次给付保险金 被保险人再次确诊恶性肿瘤重度，我们按基本保险金额给付重度恶性肿瘤多次给付保险金。',
        ].join('\n'),
      },
    ],
    insuranceIndicatorRecords: [
      {
        id: 'repaired_light',
        company: '新华保险',
        productName,
        coverageType: '疾病保障',
        liability: '轻度疾病保险金',
        value: 20,
        unit: '%',
        basis: '基本保险金额',
        formulaText: '基本保险金额 × 20%',
        responsibilityScope: 'optional',
        optionalResponsibilityId: optionalOneId,
        quantificationStatus: 'quantified',
      },
      {
        id: 'unrelated_repaired',
        company: '测试保险',
        productName: '测试可选产品',
        coverageType: '疾病保障',
        liability: '测试保险金',
        value: 100,
        unit: '%',
        basis: '基本保险金额',
        formulaText: '基本保险金额 × 100%',
        responsibilityScope: 'optional',
        optionalResponsibilityId: unrelatedExistingId,
        quantificationStatus: 'quantified',
      },
    ],
    optionalResponsibilityRecords: [
      {
        id: optionalOneId,
        company: '新华保险',
        productName,
        liability: '可选责任一',
        quantificationStatus: 'quantified',
        indicatorIds: ['repaired_light'],
      },
      {
        id: unrelatedExistingId,
        company: '测试保险',
        productName: '测试可选产品',
        liability: '可选责任',
        quantificationStatus: 'quantified',
        indicatorIds: ['unrelated_repaired'],
      },
    ],
  };

  const next = rebuildOptionalResponsibilityGovernance(state);
  const optionalOne = next.optionalResponsibilityRecords.find((row) => row.id === optionalOneId);
  const optionalTwo = next.optionalResponsibilityRecords.find((row) => row.liability === '可选责任二');
  const unrelated = next.optionalResponsibilityRecords.find((row) => row.id === unrelatedExistingId);

  assert.deepEqual(optionalOne.indicatorIds, ['repaired_light']);
  assert.equal(next.insuranceIndicatorRecords.some((row) => row.id === 'repaired_light'), true);
  assert.equal(optionalTwo.quantificationStatus, 'quantified');
  assert.equal(optionalTwo.indicatorIds.length, 1);
  assert.equal(next.insuranceIndicatorRecords.some((row) => row.optionalResponsibilityId === optionalTwo.id), true);
  assert.equal(unrelated.quantificationStatus, 'quantified');
  assert.deepEqual(unrelated.indicatorIds, ['unrelated_repaired']);
  assert.equal(next.insuranceIndicatorRecords.some((row) => row.id === 'unrelated_repaired'), true);
});

test('rebuildOptionalResponsibilityGovernance preserves same-product linked optional indicators only', () => {
  const optionalId = buildOptionalResponsibilityId({
    company: '新华保险',
    productName,
    liability: '可选责任一',
  });
  const state = {
    knowledgeRecords: [
      {
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 按条款约定给付。',
      },
    ],
    insuranceIndicatorRecords: [
      {
        id: 'same_product_optional',
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
      {
        id: 'other_product_optional',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司其他重大疾病保险',
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
    ],
    optionalResponsibilityRecords: [
      {
        id: optionalId,
        company: '新华保险',
        productName,
        liability: '可选责任一',
        quantificationStatus: 'quantified',
        indicatorIds: ['same_product_optional', 'other_product_optional'],
      },
    ],
  };

  const next = rebuildOptionalResponsibilityGovernance(state);
  const record = next.optionalResponsibilityRecords[0];

  assert.equal(record.quantificationStatus, 'quantified');
  assert.deepEqual(record.indicatorIds, ['same_product_optional']);
  assert.equal(next.insuranceIndicatorRecords.some((row) => row.id === 'same_product_optional'), true);
  assert.equal(next.insuranceIndicatorRecords.some((row) => row.id === 'other_product_optional'), false);
});
