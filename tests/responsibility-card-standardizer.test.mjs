import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResponsibilityCardsForPolicy,
  buildResponsibilitySummaryReportFromCards,
  isGeneratedResponsibilityCountReport,
  mergeCoverageTableWithCheckedRows,
  responsibilityRowsFromCards,
  standardizeResponsibilityIndicator,
} from '../server/responsibility-card-standardizer.mjs';

const basePolicy = {
  company: '新华保险',
  name: '尊享人生年金保险（分红型）',
  amount: 100000,
  firstPremium: 12000,
  paymentPeriod: '10年交',
  coveragePeriod: '终身',
};

test('standardizeResponsibilityIndicator keeps first basic responsibility premium distinct and scheduled cashflow', () => {
  const indicator = {
    id: 'ind_annuity_1',
    company: '新华保险',
    productName: '尊享人生年金保险（分红型）',
    coverageType: '现金流',
    liability: '关爱年金',
    value: 1,
    valueText: '1',
    unit: '%',
    basis: '首次交纳的基本责任的保险费',
    formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
    condition: '犹豫期结束次日、每年保单生效对应日生存',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
    sourceExcerpt: '关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
  };

  const result = standardizeResponsibilityIndicator(indicator, { policy: basePolicy });

  assert.equal(result.liability, '关爱年金');
  assert.equal(result.basisKey, 'first_basic_responsibility_premium');
  assert.equal(result.calculationKey, 'percent_of_first_premium');
  assert.equal(result.calculationEligible, true);
  assert.equal(result.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(result.calculationReason, '');
});

test('standardizeResponsibilityIndicator blocks indicators without official source excerpt', () => {
  const result = standardizeResponsibilityIndicator({
    company: '新华保险',
    productName: '尊享人生年金保险（分红型）',
    coverageType: '现金流',
    liability: '满期保险金',
    basis: '基本保险金额',
    formulaText: '满期保险金 = 基本保险金额',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
    sourceExcerpt: '',
  }, { policy: basePolicy });

  assert.equal(result.calculationEligible, false);
  assert.equal(result.cashflowTreatment, 'not_cashflow');
  assert.match(result.calculationReason, /缺少官方来源片段/u);
});

test('standardizeResponsibilityIndicator classifies claim-trigger benefits as claim_contingent even when amount is calculable', () => {
  const result = standardizeResponsibilityIndicator({
    company: '新华保险',
    productName: '测试重大疾病保险',
    coverageType: '疾病保障',
    liability: '重大疾病保险金',
    value: 100,
    unit: '%',
    basis: '基本保险金额',
    formulaText: '重大疾病保险金 = 基本保险金额 × 100%',
    condition: '被保险人确诊合同约定重大疾病',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/ci.pdf',
    sourceExcerpt: '被保险人确诊本合同所指重大疾病，本公司按基本保险金额给付重大疾病保险金。',
  }, { policy: { ...basePolicy, name: '测试重大疾病保险' } });

  assert.equal(result.calculationEligible, true);
  assert.equal(result.cashflowTreatment, 'claim_contingent');
  assert.equal(result.calculationStatus, 'claim_contingent');
  assert.equal(result.calculationKey, 'percent_of_basic_amount');

  const disability = standardizeResponsibilityIndicator({
    company: '友邦人寿',
    productName: '友邦金钥匙抵押贷款定期寿险',
    coverageType: '人寿保障',
    liability: '残废保险金',
    value: 100,
    unit: '%',
    basis: '保险单年度保险金额',
    formulaText: '残废保险金 = 保险单年度保险金额 × 100%',
    condition: '被保险人发生本合同所约定的残废',
    sourceUrl: 'https://www.aia.com.cn/example/mortgage.pdf',
    sourceExcerpt: '在本合同有效期内，若被保险人在年满六十周岁以前发生本合同所约定的残废，本公司所应给付的残废保险金等值于残废发生时该保险单年度的保险金额。',
  }, { policy: { company: '友邦人寿', name: '友邦金钥匙抵押贷款定期寿险' } });
  assert.equal(disability.cashflowTreatment, 'claim_contingent');
  assert.equal(disability.calculationStatus, 'claim_contingent');
});

test('standardizeResponsibilityIndicator preserves embedded quoted disease liability names', () => {
  const productName = '友邦爱安康恶性肿瘤（重度）疾病保险';
  const indicator = {
    company: '友邦人寿',
    productName,
    coverageType: '疾病保障',
    liability: '“恶性肿瘤——重度”保险金',
    basis: '基本保险金额',
    formulaText: '“恶性肿瘤——重度”保险金 = 基本保险金额',
    condition: '被保险人首次确诊合同约定的“恶性肿瘤——重度”',
    sourceUrl: 'https://www.aia.com.cn/example/cancer.pdf',
    sourceExcerpt: '1.“恶性肿瘤——重度”保险金 若被保险人首次确诊患有本合同约定的“恶性肿瘤——重度”，则我们给付“恶性肿瘤——重度”保险金，其金额等于基本保险金额。',
  };

  const result = standardizeResponsibilityIndicator(indicator, {
    policy: { company: '友邦人寿', name: productName },
  });
  assert.equal(result.liability, '“恶性肿瘤——重度”保险金');

  const cards = buildResponsibilityCardsForPolicy({
    policy: { company: '友邦人寿', name: productName },
    coverageIndicators: [indicator],
  });
  assert.deepEqual(cards.map((card) => card.title), ['“恶性肿瘤——重度”保险金']);
});

test('standardizeResponsibilityIndicator does not let waiver text in source excerpt override benefit liability', () => {
  const result = standardizeResponsibilityIndicator({
    company: '复星联合健康保险',
    productName: '复星联合妈咪保贝（星耀版）少儿重大疾病保险',
    coverageType: '可选责任',
    liability: '轻度疾病保险金',
    value: 30,
    unit: '%',
    basis: '基本保险金额',
    formulaText: '轻度疾病保险金 = 基本保险金额 × 30%',
    sourceUrl: 'https://www.fosun-uhi.com/upload/pdf/mamibaby.pdf',
    sourceExcerpt: '轻度疾病保险金按基本保险金额的30%给付；中度疾病或轻度疾病豁免保险费责任可选。',
  }, { policy: { ...basePolicy, company: '复星联合健康保险', name: '复星联合妈咪保贝（星耀版）少儿重大疾病保险' } });

  assert.equal(result.category, '疾病保障');
  assert.equal(result.cashflowTreatment, 'claim_contingent');
  assert.equal(result.calculationStatus, 'claim_contingent');
});

test('standardizeResponsibilityIndicator does not let waiver formula override non-waiver benefit liability', () => {
  const result = standardizeResponsibilityIndicator({
    company: '复星联合健康保险',
    productName: '复星联合妈咪保贝（星耀版）少儿重大疾病保险',
    coverageType: '疾病保障',
    liability: '重大疾病多次给付保险金',
    basis: '后续保险费',
    formulaText: '豁免后续应交保险费',
    sourceUrl: 'https://www.fosun-uhi.com/upload/pdf/mamibaby.pdf',
    sourceExcerpt: '被保险人确诊本合同约定重大疾病，本公司按基本保险金额给付重大疾病多次给付保险金。',
  }, { policy: { ...basePolicy, company: '复星联合健康保险', name: '复星联合妈咪保贝（星耀版）少儿重大疾病保险' } });

  assert.equal(result.category, '疾病保障');
  assert.equal(result.cashflowTreatment, 'claim_contingent');
  assert.equal(result.calculationStatus, 'claim_contingent');
});

test('standardizeResponsibilityIndicator blocks table and expense dependent indicators from direct calculation', () => {
  const medical = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试医疗保险',
    coverageType: '医疗保障',
    liability: '住院医疗保险金',
    basis: '实际医疗费用',
    formulaText: '住院医疗保险金 = (实际合理医疗费用 - 免赔额) × 给付比例',
    sourceUrl: 'https://example.com/medical.pdf',
    sourceExcerpt: '本公司按实际合理医疗费用扣除免赔额后乘以约定给付比例给付住院医疗保险金。',
  }, { policy: basePolicy });

  assert.equal(medical.calculationEligible, false);
  assert.equal(medical.cashflowTreatment, 'claim_contingent');
  assert.equal(medical.calculationStatus, 'needs_table');
  assert.equal(medical.calculationKey, 'medical_formula');

  const cashValue = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试终身寿险',
    coverageType: '人寿保障',
    liability: '身故保险金',
    basis: '现金价值',
    formulaText: '身故保险金 = 现金价值、已交保险费、基本保险金额三者较大者',
    sourceUrl: 'https://example.com/life.pdf',
    sourceExcerpt: '身故保险金为现金价值、已交保险费、基本保险金额三者较大者。',
  }, { policy: basePolicy });

  assert.equal(cashValue.calculationEligible, false);
  assert.equal(cashValue.cashflowTreatment, 'claim_contingent');
  assert.equal(cashValue.calculationStatus, 'needs_table');
  assert.equal(cashValue.calculationKey, 'manual_formula');
});

test('standardizeResponsibilityIndicator does not classify waiting-period benefit clauses as rule parameters', () => {
  const result = standardizeResponsibilityIndicator({
    company: '众安保险',
    productName: '附加重大疾病异地转诊公共交通费用及住宿费用补偿',
    coverageType: '医疗保障',
    liability: '重大疾病异地转诊住宿费用',
    condition: '被保险人因意外伤害事故或等待期后初次确诊约定重大疾病，因病情需要异地转诊住院治疗。',
    basis: '实际合理住宿费用，扣除单次免赔额后按给付比例赔付，累计以保险金额为限。',
    formulaText: '住宿费用保险金 = min((实际合理住宿费用 - 单次免赔额) × 给付比例, 剩余保险金额)',
    sourceUrl: 'https://example.com/medical-transfer.pdf',
    sourceExcerpt: '重大疾病异地转诊住宿费用，指被保险人发生必需且合理的住宿费用。保险人在扣除约定的单次免赔额后，按照约定的给付比例进行赔付。',
  }, { policy: basePolicy });

  assert.equal(result.category, '医疗保障');
  assert.equal(result.cashflowTreatment, 'claim_contingent');
  assert.equal(result.calculationStatus, 'needs_table');
  assert.equal(result.calculationKey, 'medical_formula');
});

test('standardizeResponsibilityIndicator blocks yuan values that depend on account, schedule, or daily data', () => {
  const accountValue = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试万能险',
    coverageType: '现金流',
    liability: '部分领取金额',
    value: 1000,
    unit: '元',
    basis: '账户价值',
    formulaText: '部分领取金额 = 账户价值中保单载明的可领取金额1000元',
    sourceUrl: 'https://example.com/account.pdf',
    sourceExcerpt: '部分领取金额以个人账户价值中保单载明的可领取金额为准。',
  }, { policy: basePolicy });

  assert.equal(accountValue.calculationEligible, false);
  assert.equal(accountValue.calculationStatus, 'needs_table');
  assert.equal(accountValue.calculationKey, 'account_value');

  const dailyAllowance = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试医疗保险',
    coverageType: '医疗保障',
    liability: '住院日津贴保险金',
    value: 100,
    unit: '元',
    basis: '日津贴额',
    formulaText: '住院日津贴保险金 = 日津贴额100元 × 给付天数',
    sourceUrl: 'https://example.com/daily.pdf',
    sourceExcerpt: '本公司按日津贴额100元乘以实际给付天数给付住院日津贴保险金。',
  }, { policy: basePolicy });

  assert.equal(dailyAllowance.calculationEligible, false);
  assert.equal(dailyAllowance.category, '医疗保障');
  assert.equal(dailyAllowance.calculationStatus, 'needs_table');
  assert.equal(dailyAllowance.calculationKey, 'daily_allowance');

  const scheduleAmount = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试年金保险',
    coverageType: '现金流',
    liability: '养老年金',
    value: 2000,
    unit: '元',
    basis: '保单载明金额',
    formulaText: '养老年金 = 保单载明金额2000元，按领取计划表给付',
    sourceUrl: 'https://example.com/schedule.pdf',
    sourceExcerpt: '养老年金金额以保险单载明金额和领取计划表为准。',
  }, { policy: basePolicy });

  assert.equal(scheduleAmount.calculationEligible, false);
  assert.equal(scheduleAmount.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(scheduleAmount.calculationStatus, 'needs_table');
  assert.equal(scheduleAmount.calculationKey, 'schedule_or_policy_table');
});

test('standardizeResponsibilityIndicator keeps truly fixed yuan benefits calculable', () => {
  const fixedBenefit = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试固定给付保险',
    coverageType: '其他',
    liability: '固定给付金',
    value: 500,
    unit: '元',
    basis: '固定金额',
    formulaText: '固定给付金 = 500元',
    sourceUrl: 'https://example.com/fixed.pdf',
    sourceExcerpt: '固定给付金为500元。',
  }, { policy: basePolicy });

  assert.equal(fixedBenefit.calculationEligible, true);
  assert.equal(fixedBenefit.calculationKey, 'fixed_amount');
  assert.notEqual(fixedBenefit.calculationStatus, 'needs_table');
});

test('standardizeResponsibilityIndicator does not rename slash claim liability to nearby cashflow title', () => {
  const result = standardizeResponsibilityIndicator({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
    coverageType: '人寿保障',
    liability: '疾病身故/全残(41-61岁)',
    triggerCondition: '被保险人因疾病身故或身体全残',
    payoutSummary: '本合同实际交纳的保险费的1.4倍',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/changxing.pdf',
    sourceExcerpt: '1. 满期生存保险金 被保险人生存至保险期间届满，我们按本合同实际交纳的保险费给付满期生存保险金。2. 疾病身故或身体全残保险金 被保险人因疾病身故或身体全残，我们按约定给付。',
  }, { policy: basePolicy });

  assert.equal(result.liability, '疾病身故/全残(41-61岁)');
  assert.equal(result.calculationStatus, 'claim_contingent');
});

test('buildResponsibilityCardsForPolicy writes readable cards and re-checks existing indicators', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: basePolicy,
    responsibilities: [{
      coverageType: '保险责任',
      scenario: '关爱年金 如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
      payout: '按首次交纳的基本责任的保险费的1%给付',
      note: '尊享人生年金保险（分红型）',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceTitle: '尊享人生年金保险（分红型）条款',
    }],
    coverageIndicators: [{
      id: 'ind_annuity_1',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '关爱年金',
      value: 1,
      unit: '%',
      basis: '首次交纳的基本责任的保险费',
      formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
      condition: '犹豫期结束次日、每年保单生效对应日生存',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceExcerpt: '关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
    }],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '关爱年金');
  assert.equal(cards[0].category, '现金流');
  assert.equal(cards[0].cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards[0].calculationStatus, 'calculable');
  assert.equal(cards[0].indicatorCheckStatus, 'verified_calculable');
  assert.deepEqual(cards[0].indicatorCheckIssues, []);
  assert.equal(cards[0].indicators.length, 1);
  assert.equal(cards[0].indicators[0].basisKey, 'first_basic_responsibility_premium');
});

test('buildResponsibilityCardsForPolicy ignores malformed rows and still builds valid cards', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: basePolicy,
    responsibilities: [
      null,
      'bad responsibility row',
      {
        coverageType: '保险责任',
        scenario: '关爱年金 如被保险人每年保单生效对应日生存，本公司给付关爱年金。',
        payout: '按首次交纳的基本责任的保险费的1%给付',
        sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
        sourceTitle: '尊享人生年金保险（分红型）条款',
      },
    ],
    optionalResponsibilityRecords: [undefined, 42],
    coverageIndicators: [
      null,
      'bad indicator row',
      {
        id: 'ind_annuity_1',
        company: '新华保险',
        productName: '尊享人生年金保险（分红型）',
        coverageType: '现金流',
        liability: '关爱年金',
        value: 1,
        unit: '%',
        basis: '首次交纳的基本责任的保险费',
        formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
        condition: '每年保单生效对应日生存',
        sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
        sourceExcerpt: '被保险人每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
      },
    ],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '关爱年金');
  assert.equal(cards[0].indicators.length, 1);
  assert.equal(cards[0].indicators[0].id, 'ind_annuity_1');
});

test('buildResponsibilityCardsForPolicy merges same product and responsibility indicators into one card', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: basePolicy,
    coverageIndicators: [{
      id: 'ind_annuity_first_premium',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '关爱年金',
      value: 1,
      unit: '%',
      basis: '首次交纳的基本责任的保险费',
      formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
      condition: '每年保单生效对应日生存',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceExcerpt: '被保险人每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
    }, {
      id: 'ind_annuity_basic_amount',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '关爱年金',
      value: 2,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '关爱年金 = 基本保险金额 × 2%',
      condition: '每年保单生效对应日生存',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceExcerpt: '被保险人每年保单生效对应日生存，本公司按基本保险金额的2%给付关爱年金。',
    }],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '关爱年金');
  assert.equal(cards[0].calculationStatus, 'calculable');
  assert.equal(cards[0].cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards[0].indicators.length, 2);
  assert.deepEqual(cards[0].indicators.map((indicator) => indicator.id), [
    'ind_annuity_first_premium',
    'ind_annuity_basic_amount',
  ]);
});

test('buildResponsibilityCardsForPolicy derives responsibility cards from official numbered clauses', () => {
  const productName = '新华人寿保险股份有限公司美利金生终身年金保险（分红型）';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    knowledgeRecords: [{
      company: '新华保险',
      productName,
      title: `${productName}产品说明书`,
      url: 'https://static-cdn.newchinalife.com/ncl/pdf/meilijinsheng.pdf',
      official: true,
      sourceType: 'pdf',
      materialType: 'product_manual',
      pageText: [
        '保险责任：',
        '1.关爱金 被保险人于本合同生效满一年的首个保单生效对应日零时生存，本公司按首次交纳的保险费的20%给付关爱金。',
        '2.生存保险金 被保险人于本合同生效满一年起至64周岁保单生效对应日期间，在每一保单生效对应日零时生存，本公司按基本保险金额的20%给付生存保险金。',
        '3.养老年金 被保险人于65周岁保单生效对应日起，在每一保单生效对应日零时生存，本公司按基本保险金额的25%给付养老年金。',
        '4.祝寿金 被保险人于65周岁保单生效对应日零时生存，本公司按基本保险金额给付祝寿金。',
        '5.长寿金 被保险人于85周岁保单生效对应日零时生存，本公司按本保险实际交纳的保险费给付长寿金。',
        '6.身故保险金 被保险人身故，本公司按本保险实际交纳的保险费与现金价值二者之较大者给付身故保险金。',
        '7.投保人意外伤害身故或意外伤害身体全残豁免保险费 除另有约定外，投保人因意外伤害身故或身体全残，本公司视同续期保险费已经交纳。',
      ].join('\n'),
    }],
    coverageIndicators: [{
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 20,
      unit: '%',
      basis: '条款载明基准',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/meilijinsheng.pdf',
      sourceExcerpt: '保险责任包括关爱金、生存保险金、养老年金、祝寿金、长寿金和身故保险金。',
    }, {
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '领取起始年龄',
      value: 65,
      unit: '周岁',
      basis: '年金/养老金领取年龄',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/meilijinsheng.pdf',
      sourceExcerpt: '养老年金被保险人于65周岁保单生效对应日起给付。',
    }, {
      company: '新华保险',
      productName,
      coverageType: '规则参数',
      liability: '赔付方式',
      valueText: '定额给付型',
      unit: '方式',
      basis: '保险责任赔付机制',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/meilijinsheng.pdf',
      sourceExcerpt: '保险责任按条款约定定额给付。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), [
    '关爱金',
    '生存保险金',
    '养老年金',
    '祝寿金',
    '长寿金',
    '身故保险金',
    '投保人意外伤害身故或意外伤害身体全残豁免保险费',
  ]);
  assert.equal(cards.some((card) => card.title === '教育/养老金/两全等返还'), false);
  assert.equal(cards.some((card) => card.title === '领取起始年龄'), false);
  assert.equal(cards.some((card) => card.title === '赔付方式'), false);
  assert.equal(cards.find((card) => card.title === '身故保险金').cashflowTreatment, 'claim_contingent');
  assert.equal(cards.find((card) => card.title.includes('豁免保险费')).cashflowTreatment, 'waiver_only');
});

test('buildResponsibilityCardsForPolicy derives cards from Chinese numbered clauses', () => {
  const productName = '国寿松鹤颐年年金保险（分红型）';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '中国人寿',
      name: productName,
    },
    knowledgeRecords: [{
      company: '中国人寿',
      productName,
      title: `${productName}条款`,
      url: 'https://official.example-life.test/chinese-numbered.pdf',
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
      pageText: [
        '第五条 保险责任 在本合同保险期间内，本公司承担以下保险责任：',
        '一、年金 自本合同约定的年金开始领取日起，若被保险人生存，本公司于本合同每年或每月的生效对应日按保险合同载明的领取金额给付年金。',
        '二、身故保险金 被保险人身故，本公司按被保险人身故当时下列两者的较大值给付身故保险金，本合同终止。',
        '1.本合同所交保险费。',
        '2.本合同的现金价值。',
      ].join('\n'),
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['年金', '身故保险金']);
  assert.equal(cards.find((card) => card.title === '年金')?.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards.find((card) => card.title === '身故保险金')?.cashflowTreatment, 'claim_contingent');
  assert.equal(cards.some((card) => card.title === '本合同的现金价值'), false);
});

test('buildResponsibilityCardsForPolicy derives responsibility cards from unnumbered titled official clauses', () => {
  const productName = '农银金管家年金保险（分红型）';
  const sourceUrl = 'https://www.abchinalife.com/images/xxpl/jbxx/bxcpxxpl/tsbxcpml/2023/06/20/9C618267C834A8411D7D3BC441F5E534.pdf';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '农银人寿',
      name: productName,
    },
    knowledgeRecords: [{
      company: '农银人寿',
      productName,
      title: `${productName}产品条款`,
      url: sourceUrl,
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
      pageText: [
        '保险责任 在保险期间内，我们承担下列保险责任：',
        '生存保险金 本主险合同的生存保险金包括以下两项： 生存金 若被保险人于本主险合同的第5个保单周年日生存，我们按您已经支付的所有保险费的20%给付一笔生存金；自本主险合同的第6个保单周年日起，若被保险人于每个保单周年日生存，我们每年按基本保险金额的33%给付一笔生存金。',
        '满期金 若被保险人生存至保险期间届满，我们将按您所支付的全部保险费给付满期金，本主险合同终止。',
        '身故保险金 若被保险人身故，我们将按您所支付的全部保险费与身故时本主险合同的现金价值相比较大者给付身故保险金，本主险合同终止。',
      ].join(' '),
    }],
    coverageIndicators: [{
      company: '农银人寿',
      productName,
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 20,
      unit: '%',
      basis: '条款载明基准',
      sourceUrl,
      sourceExcerpt: '保险责任在保险期间内，我们承担下列保险责任：生存保险金本主险合同的生存保险金包括以下两项：生存金若被保险人于本主险合同的第5个保单周年日生存，我们按您已经支付的所有保险费的20%给付一笔生存金',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['生存保险金', '满期金', '身故保险金']);
  assert.equal(cards.find((card) => card.title === '生存保险金')?.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards.find((card) => card.title === '满期金')?.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards.find((card) => card.title === '身故保险金')?.cashflowTreatment, 'claim_contingent');
  assert.equal(cards.some((card) => card.title === '教育/养老金/两全等返还'), false);
});

test('buildResponsibilityCardsForPolicy keeps Ping An Fu maturity title instead of payout sentence fragment', () => {
  const productName = '平安福满分两全保险';
  const sourceUrl = 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=1285&versionNo=1285-1&attachmentType=1';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '中国平安',
      name: productName,
    },
    knowledgeRecords: [{
      company: '中国平安',
      productName,
      title: `${productName}产品条款`,
      url: sourceUrl,
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
      pageText: [
        '保险责任 在本主险合同保险期间内，我们承担如下保险责任：',
        '满期生存保险金 被保险人于保险期满时仍生存，我们按本主险合同及平安附加福满分提前给付重大疾病保险合同所交保险费之和给付满期生存保险金，本主险合同终止。',
        '上述“所交保险费”按照期满当时的基本保险金额确定的年交保险费和交费年度数计算。',
        '身故保险金 被保险人身故，我们按身故时本主险合同的基本保险金额给付身故保险金，本主险合同终止。',
      ].join(' '),
    }],
    coverageIndicators: [{
      company: '中国平安',
      productName,
      coverageType: '规则参数',
      liability: '赔付方式',
      valueText: '给付型',
      sourceUrl,
      sourceExcerpt: '保险责任包括满期生存保险金和身故保险金。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['满期生存保险金', '身故保险金']);
  assert.equal(cards.some((card) => card.title.includes('给付重大疾病保险合同')), false);
  assert.equal(cards.find((card) => card.title === '满期生存保险金')?.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards.find((card) => card.title === '身故保险金')?.cashflowTreatment, 'claim_contingent');
});

test('buildResponsibilityCardsForPolicy keeps Xinhua high-end medical benefits and filters calculation clauses', () => {
  const productName = '新华人寿保险股份有限公司寰宇尊悦高端医疗保险';
  const sourceUrl = 'https://static-cdn.newchinalife.com/ncl/pdf/20240126/7f7c91b6-4017-443a-9603-ae29c853e1df.pdf';
  const cards = buildResponsibilityCardsForPolicy({
    policy: { company: '新华保险', name: productName },
    knowledgeRecords: [{
      company: '新华保险',
      productName,
      title: productName,
      url: sourceUrl,
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
      pageText: [
        '第十条 保险责任 在本合同保险期间内，本合同的保险责任根据投保时约定的保障计划类别确定：计划一承担第2款至第10款，计划二承担第2款至第9款，计划三承担第2款至第8款。',
        '1.等待期 除另有约定外，自本合同生效之日起30日为一般住院医疗费用保险金等待期。',
        '2.一般住院医疗费用保险金 被保险人因意外伤害原因或于本项保险责任等待期后因疾病原因，在本公司认可医院接受住院治疗的，本公司按保险金计算方法，计算并给付一般住院医疗费用保险金。',
        '3.延伸医疗费用保险金 被保险人因意外伤害原因或于本项保险责任等待期后因疾病原因，在本公司认可医院住院接受特定治疗的，本公司计算并给付延伸医疗费用保险金。',
        '4.恶性肿瘤院外特定医疗费用保险金 被保险人于本项保险责任等待期后确诊初次发生恶性肿瘤，因治疗需要实际发生医疗费用，本公司给付恶性肿瘤院外特定医疗费用保险金。',
        '5.特定门急诊医疗费用保险金 被保险人因意外伤害原因或于本项保险责任等待期后因疾病原因接受特定门急诊治疗的，本公司给付特定门急诊医疗费用保险金。',
        '6.保障区域外紧急医疗费用保险金 被保险人在本合同保险期间内离开约定保障区域后发生紧急医疗费用的，本公司给付保障区域外紧急医疗费用保险金。',
        '7.全球紧急救援费用保险金 被保险人因意外伤害原因或突发急性病处于生命危急状态，本公司通过合作救援机构提供救援服务实际发生费用的，本公司给付全球紧急救援费用保险金。',
        '8.无理赔住院津贴保险金 如被保险人在本公司认可医院接受住院治疗，但未就本次住院的任何费用申请理赔且未抵扣年度免赔额，本公司给付无理赔住院津贴保险金。',
        '9.普通门急诊医疗费用保险金 被保险人因意外伤害原因或于本项保险责任等待期后因疾病原因接受门急诊治疗的，本公司给付普通门急诊医疗费用保险金。',
        '10.牙科医疗费用保险金 被保险人于本项保险责任等待期后接受牙科治疗的，本公司给付牙科医疗费用保险金。',
        '11.保险金计算方法 对被保险人每次实际发生的属于本合同保险责任范围内的医疗必需且合理的各项医疗费用，本公司按公式计算保险金。',
        '12.在本合同保险期间内，本公司承担给付各项保险金责任需符合最高给付限额、最高给付天数规定。',
        '13.在本合同保险期间内，本公司累计给付的各项保险金之和以本合同保险金额为限。',
        '14.被保险人在保险期间内住院且当保险期间届满时仍未出院，本公司继续按第2、3款对住院医疗费用承担给付保险金责任至本次住院结束。',
      ].join(' '),
    }],
    coverageIndicators: [{
      company: '新华保险',
      productName,
      coverageType: '医疗保障',
      liability: '给付天数上限',
      value: 60,
      valueText: '60',
      unit: '日',
      basis: '条款天数限制',
      sourceUrl,
      sourceExcerpt: '本合同保险期间内，本公司因住院康复治疗累计给付住院医疗费用的天数以60日为限。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), [
    '一般住院医疗费用保险金',
    '延伸医疗费用保险金',
    '恶性肿瘤院外特定医疗费用保险金',
    '特定门急诊医疗费用保险金',
    '保障区域外紧急医疗费用保险金',
    '全球紧急救援费用保险金',
    '无理赔住院津贴保险金',
    '普通门急诊医疗费用保险金',
    '牙科医疗费用保险金',
  ]);
  assert.equal(cards.some((card) => /保险金计算方法|医疗费用保险金$/u.test(card.title) && card.title.length <= 8), false);
});

test('buildResponsibilityCardsForPolicy handles Xinhua Meiman Ankang spaced titles and scheduled survival benefits', () => {
  const productName = '美满安康两全保险(A款）（分红型）';
  const sourceUrl = 'https://static-cdn.newchinalife.com/ncl/pdf/meimanankang.pdf';
  const survivalExcerpt = '生存保险金 被保险人在本合同生效满一年起至被保险人身故之前，在每一保单生效对应日零时生存，本公司按基本保险金额的9%给付生存保险金。';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    knowledgeRecords: [{
      company: '新华保险',
      productName,
      title: `${productName}条款`,
      url: sourceUrl,
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
      pageText: [
        '保险责任',
        `1.生存保险金 ${survivalExcerpt}`,
        '2 . 祝 寿 金 被保险人在祝寿金领取日零时生存，本公司按本合同约定给付祝寿金。',
        '3.身故保险金 被保险人身故，本公司按本合同约定给付身故保险金。',
        '4.全残豁免 被保险人身体全残，本公司豁免后续保险费。',
      ].join('\n'),
    }],
    coverageIndicators: [{
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 9,
      unit: '%',
      basis: '保险金额',
      sourceUrl,
      sourceExcerpt: survivalExcerpt,
    }, {
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '增额/利率',
      value: 9,
      unit: '%',
      basis: '保险金额',
      sourceUrl,
      sourceExcerpt: survivalExcerpt,
    }, {
      company: '新华保险',
      productName,
      coverageType: '规则参数',
      liability: '赔付方式',
      valueText: '定额给付型',
      unit: '方式',
      basis: '保险责任赔付机制',
      sourceUrl,
      sourceExcerpt: '保险责任包括生存保险金、祝寿金、身故保险金和全残豁免。',
    }],
  });

  const survivalCard = cards.find((card) => card.title === '生存保险金');
  assert.equal(survivalCard?.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(survivalCard?.calculationStatus, 'calculable');
  assert.equal(survivalCard?.indicators.length, 2);
  assert.equal(cards.some((card) => card.title === '教育/养老金/两全等返还'), false);
  assert.equal(cards.some((card) => card.title === '增额/利率'), false);
  assert.equal(cards.find((card) => card.title === '祝寿金')?.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards.find((card) => card.title === '身故保险金')?.cashflowTreatment, 'claim_contingent');
  assert.equal(cards.find((card) => card.title === '全残豁免')?.cashflowTreatment, 'waiver_only');
  assert.equal(cards.some((card) => card.title === '赔付方式'), false);
});

test('buildResponsibilityCardsForPolicy suppresses aggregate display cards when concrete cashflows exist', () => {
  const productName = '成长阳光少儿两全保险(A款)（分红型）';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    coverageIndicators: [{
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '深造金',
      value: 60,
      unit: '%',
      basis: '有效保险金额',
      formulaText: '深造金 = 有效保险金额 × 60%',
      condition: '被保险人生存至二十二周岁生效对应日',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/chengzhang-yangguang.pdf',
      sourceExcerpt: '深造金 被保险人生存至二十二周岁生效对应日，本公司按该保单生效对应日有效保险金额的60%给付深造金。',
    }, {
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 20,
      unit: '%',
      basis: '保险金额',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/chengzhang-yangguang.pdf',
      sourceExcerpt: '保险责任包括大学教育金、深造金、立业金、婚嫁金。',
    }, {
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '增额/利率',
      value: 20,
      unit: '%',
      basis: '保险金额',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/chengzhang-yangguang.pdf',
      sourceExcerpt: '有效保险金额按条款约定递增。',
    }, {
      company: '新华保险',
      productName,
      coverageType: '规则参数',
      liability: '赔付方式',
      valueText: '定额给付型',
      unit: '方式',
      basis: '保险责任赔付机制',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/chengzhang-yangguang.pdf',
      sourceExcerpt: '保险责任按条款约定定额给付。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['深造金']);
  assert.equal(cards[0]?.calculationStatus, 'calculable');
});

test('buildResponsibilityCardsForPolicy keeps slash or pause-mark claim responsibilities when knowledge rows exist', () => {
  const productName = '中荷岁岁红团体年金保险（分红型）';
  const sourceUrl = 'http://www.bob-cardif.com/_upload/products_all/tiaokuan/GDAA.pdf';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '中荷人寿',
      name: productName,
    },
    knowledgeRecords: [{
      company: '中荷人寿',
      productName,
      title: `${productName}保险条款`,
      url: sourceUrl,
      official: true,
      pageText: '一、年金给付 被保险人于年金领取开始日仍生存的，本公司按照约定的方式给付年金。',
    }],
    coverageIndicators: [{
      company: '中荷人寿',
      productName,
      coverageType: '人寿保障',
      liability: '身故、全残保险金给付',
      basis: '个人缴费账户金额与单位缴费已归属账户金额之和',
      formulaText: '给付金额 = 个人缴费账户金额 + 单位缴费已归属账户金额',
      condition: '被保险人于年金领取开始日前身故或全残',
      sourceUrl,
      sourceExcerpt: '身故、全残保险金给付 被保险人于年金领取开始日前身故或全残，本公司按该被保险人个人帐户中个人缴费帐户金额与单位缴费已归属帐户金额之和一次性给付身故或全残保险金。',
      calculationEligible: false,
      calculationMetadataVersion: 'manual-review-20260623',
    }],
  });

  const claimCard = cards.find((card) => card.title === '身故、全残保险金给付');
  assert.equal(claimCard?.category, '人寿保障');
  assert.equal(claimCard?.cashflowTreatment, 'claim_contingent');
  assert.equal(claimCard?.calculationStatus, 'needs_table');
});

test('buildResponsibilityCardsForPolicy marks official optional clauses as unknown selection cards', () => {
  const productName = '尊享人生年金保险（分红型）';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    knowledgeRecords: [{
      company: '新华保险',
      productName,
      title: `${productName}产品说明书`,
      url: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      official: true,
      sourceType: 'pdf',
      materialType: 'product_manual',
      pageText: [
        '本保险提供的利益保障',
        '1.关爱年金 如被保险人生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
        '2.生存保险金 被保险人生存，本公司按基本责任的保险金额的9%给付生存保险金。',
        '3.身故或身体全残保险金 被保险人身故或身体全残，本公司按约定给付身故或身体全残保险金。',
        '4.投保人意外伤害身故或意外伤害身体全残豁免保险费 投保人因意外伤害身故或身体全残，本公司视同续期保险费已经交纳。',
        '5.祝寿金 被保险人于年满60周岁保单生效对应日生存，本公司按该保单生效对应日可选责任的保险金额给付祝寿金，本合同可选责任终止，其他保险责任继续有效。被保险人在领取祝寿金之前身故或身体全残，本公司按约定给付身故或身体全残保险金。上述1-4条为基本责任，第5条为可选责任，您可以选择该祝寿金作为本合同项下的保险责任。',
      ].join('\n'),
    }],
  });

  const birthdayCard = cards.find((card) => card.title === '祝寿金');
  assert.equal(birthdayCard?.responsibilityScope, 'optional');
  assert.equal(birthdayCard?.selectionStatus, 'unknown');
  assert.equal(birthdayCard?.selectionEvidence, 'official_terms');
  assert.equal(birthdayCard?.category, '现金流');
  assert.equal(birthdayCard?.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(birthdayCard?.calculationStatus, 'calculable');
  assert.equal(birthdayCard?.calculationReason, '');
  assert.equal(birthdayCard?.payoutSummary, '祝寿金 = 该保单生效对应日可选责任的保险金额');
});

test('responsibilityRowsFromCards feeds policy summary from visible checked cards only', () => {
  const cards = [
    {
      id: 'card_survival',
      productName: '尊享人生年金保险（分红型）',
      title: '生存保险金',
      category: '现金流',
      triggerCondition: '被保险人生存',
      payoutSummary: '生存保险金 = 基本责任保险金额 × 9%',
      calculationStatus: 'calculable',
      cashflowTreatment: 'scheduled_cashflow',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceTitle: '尊享人生年金保险（分红型）',
      indicators: [],
    },
    {
      id: 'card_birthday_unknown',
      productName: '尊享人生年金保险（分红型）',
      title: '祝寿金',
      category: '现金流',
      triggerCondition: '被保险人于年满60周岁保单生效对应日生存',
      payoutSummary: '祝寿金 = 该保单生效对应日可选责任的保险金额',
      calculationStatus: 'calculable',
      cashflowTreatment: 'scheduled_cashflow',
      responsibilityScope: 'optional',
      selectionStatus: 'unknown',
      indicators: [],
    },
    {
      id: 'card_parameter',
      productName: '尊享人生年金保险（分红型）',
      title: '赔付方式',
      category: '规则参数',
      calculationStatus: 'needs_review',
      cashflowTreatment: 'not_cashflow',
      indicators: [],
    },
    {
      id: 'card_metric',
      productName: '尊享人生年金保险（分红型）',
      title: '增额/利率',
      category: '现金流',
      calculationStatus: 'calculable',
      cashflowTreatment: 'scheduled_cashflow',
      payoutSummary: '有效保险金额按约定递增',
      indicators: [],
    },
    {
      id: 'card_aggregate_cashflow',
      productName: '尊享人生年金保险（分红型）',
      title: '教育/养老金/两全等返还',
      category: '现金流',
      calculationStatus: 'calculable',
      cashflowTreatment: 'scheduled_cashflow',
      payoutSummary: '基本保险金额',
      indicators: [],
    },
  ];

  assert.deepEqual(
    responsibilityRowsFromCards(cards).map((row) => row.coverageType),
    ['生存保险金'],
  );
  assert.equal(responsibilityRowsFromCards(cards)[0]?.productName, '尊享人生年金保险（分红型）');

  const selectedRows = responsibilityRowsFromCards(cards, {
    optionalResponsibilities: [{
      productName: '尊享人生年金保险（分红型）',
      liability: '祝寿金',
      selectionStatus: 'selected',
    }],
  });
  assert.deepEqual(selectedRows.map((row) => row.coverageType), ['生存保险金', '祝寿金']);
  assert.equal(selectedRows.find((row) => row.coverageType === '祝寿金')?.payout, '祝寿金 = 该保单生效对应日可选责任的保险金额');
});

test('buildResponsibilitySummaryReportFromCards summarizes responsibilities before indicator details', () => {
  const report = buildResponsibilitySummaryReportFromCards([
    {
      productName: '新华人寿保险股份有限公司畅行万里两全保险',
      title: '满期生存保险金',
      category: '现金流',
      cashflowTreatment: 'scheduled_cashflow',
      calculationStatus: 'calculable',
      payoutSummary: '满期生存保险金 = 实际交纳保险费',
    },
    {
      productName: '新华人寿保险股份有限公司畅行万里两全保险',
      title: '疾病身故或身体全残保险金',
      category: '人寿保障',
      cashflowTreatment: 'claim_contingent',
      calculationStatus: 'claim_contingent',
      payoutSummary: '实际交纳保险费 × 1.6/1.4/1.2',
      sourceExcerpt: '疾病身故或身体全残保险金 本公司按约定给付。上述保险金最多给付其中一项，且以一次为限。',
    },
    {
      productName: '新华人寿保险股份有限公司畅行万里两全保险',
      title: '客运列车及航空意外伤害身故或身体全残保险金',
      category: '意外保障',
      cashflowTreatment: 'claim_contingent',
      calculationStatus: 'claim_contingent',
      payoutSummary: '基本保险金额 × 60',
    },
  ]);

  assert.match(report, /主要提供满期\/生存等确定领取、身故或全残保障、意外保障/u);
  assert.match(report, /确定领取类责任包括：满期生存保险金/u);
  assert.match(report, /保障类责任包括：疾病身故或身体全残保险金/u);
  assert.match(report, /不能简单累加/u);
  assert.doesNotMatch(report, /指标核对|现金流测算/u);
});

test('isGeneratedResponsibilityCountReport detects placeholder responsibility reports', () => {
  assert.equal(isGeneratedResponsibilityCountReport('已按官网责任和指标核对生成 17 项保险责任。'), true);
  assert.equal(isGeneratedResponsibilityCountReport('已整理 17 项保险责任。'), true);
  assert.equal(isGeneratedResponsibilityCountReport('这款产品主要提供两全返还和意外保障。'), false);
});

test('mergeCoverageTableWithCheckedRows preserves existing policy summary wording', () => {
  const rows = mergeCoverageTableWithCheckedRows(
    [{
      coverageType: '重大疾病保险金',
      scenario: '确诊合同约定重大疾病',
      payout: '给付基本保险金额50万元',
      note: '保存时应复用这份解析结果',
    }],
    [{
      productName: '测试重大疾病保险',
      coverageType: '重大疾病保险金',
      scenario: '以条款约定为准',
      payout: '以正式条款为准',
      note: '发生条款约定情形后给付。',
      sourceUrl: 'https://example.com/terms.pdf',
      sourceTitle: '官方条款',
    }],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, '保存时应复用这份解析结果');
  assert.equal(rows[0].productName, '测试重大疾病保险');
  assert.equal(rows[0].sourceUrl, 'https://example.com/terms.pdf');
});

test('mergeCoverageTableWithCheckedRows replaces fallback wording with checked formula', () => {
  const rows = mergeCoverageTableWithCheckedRows(
    [{
      coverageType: '深造金',
      scenario: '深造金 被保险人生存至二十二周岁生效对应日，本公司按有效保险金额的60%给付深造金，后续串到其他责任。身故保险金 被保险人身故。',
      payout: '以正式条款为准',
      note: '未匹配到通过核对的结构化指标',
    }],
    [{
      productName: '成长阳光少儿两全保险(A款)（分红型）',
      coverageType: '深造金',
      scenario: '深造金 被保险人生存至二十二周岁生效对应日，本公司按有效保险金额的60%给付深造金，后续串到其他责任。',
      payout: '深造金 = 有效保险金额的60%',
      note: '按合同约定给付。',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/chengzhang-yangguang.pdf',
      sourceTitle: '官方条款',
    }],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].payout, '深造金 = 有效保险金额的60%');
  assert.equal(rows[0].note, '按合同约定给付。');
  assert.equal(rows[0].scenario, '深造金 被保险人生存至二十二周岁生效对应日，本公司按有效保险金额的60%给付深造金，后续串到其他责任。');
});

test('buildResponsibilityCardsForPolicy cleans spaced numbered clause prefixes', () => {
  const productName = '新华人寿保险股份有限公司学生平安意外伤害保险';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    knowledgeRecords: [{
      company: '新华保险',
      productName,
      title: `${productName}条款`,
      url: 'https://static-cdn.newchinalife.com/ncl/pdf/student.pdf',
      official: true,
      pageText: '3 .1 意外伤害残疾保险金 被保险人遭受意外伤害导致残疾，本公司按约定给付意外伤害残疾保险金。3 . 2 意外伤害身故保险金 被保险人遭受意外伤害身故，本公司按约定给付意外伤害身故保险金。',
    }],
  });

  assert.equal(cards.some((card) => /^3/u.test(card.title)), false);
  assert.equal(cards.some((card) => card.title === '意外伤害残疾保险金'), true);
  assert.equal(cards.some((card) => card.title === '意外伤害身故保险金'), true);
});

test('buildResponsibilityCardsForPolicy extracts child education payouts and cuts Chinese section boundaries', () => {
  const productName = '成长阳光少儿两全保险(A款)（分红型）';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    knowledgeRecords: [{
      company: '新华保险',
      productName,
      title: `${productName}条款`,
      url: 'https://static-cdn.newchinalife.com/ncl/pdf/chengzhang-yangguang.pdf',
      official: true,
      pageText: [
        '保险责任 在本合同保险期间内，本公司按下列规定承担保险责任：',
        '（一） 被保险人 生存保险金',
        '1、大学教育金 被保险人生存至十八——二十一周岁生效对应日，本公司分别按该保单在每一生效对应日有效保险金额的20%给付大学教育金，本项保险责任终止，其他保险责任继续有效；',
        '2、深造金 被保险人生存至二十二周岁生效对应日，本公司按该保单生效对应日有效保险金额的60%给付深造金，本项保险责任终止，其他保险责任继续有效；',
        '3、立业金 被保险人生存至二十五周岁生效对应日，本公司按该保单生效对应日有效保险金额的80%给付立业金，本项保险责任终止，其他保险责任继续有效；',
        '4、婚嫁金 被保险人生存至二十八周岁生效对应日，本公司按该保单生效对应日有效保险金额的80%给付婚嫁金，本合同效力即行终止。',
        '（二） 被保险人 身故保险金 被保险人于十八周岁生效对应日前身故，本公司按约定给付身故保险金。',
        '（三） 投保人豁免保险费 投保人因意外伤害身故或身体全残，可免交剩余的期交保险费。',
      ].join('\n'),
    }],
  });

  const deepStudy = cards.find((card) => card.title === '深造金');
  const career = cards.find((card) => card.title === '立业金');
  const marriage = cards.find((card) => card.title === '婚嫁金');

  assert.equal(deepStudy?.payoutSummary, '深造金 = 该保单生效对应日有效保险金额的60%');
  assert.equal(career?.payoutSummary, '立业金 = 该保单生效对应日有效保险金额的80%');
  assert.equal(marriage?.payoutSummary, '婚嫁金 = 该保单生效对应日有效保险金额的80%');
  assert.equal(marriage?.calculationStatus, 'calculable');
  assert.doesNotMatch(marriage?.triggerCondition || '', /身故保险金/u);
  assert.equal(cards.some((card) => card.title === '身故保险金'), true);
  assert.equal(cards.some((card) => card.title === '投保人豁免保险费'), true);
});

test('buildResponsibilityCardsForPolicy filters China Life waiver definition and aggregate fragments', () => {
  const productName = '国寿附加少儿国寿福豁免保险费疾病保险（2021版）';
  const sourceUrl = 'https://www.e-chinalife.com/upload/resources/file/productBasicInfo/terms.pdf';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '中国人寿',
      name: productName,
    },
    knowledgeRecords: [{
      company: '中国人寿',
      productName,
      title: `${productName}条款`,
      url: sourceUrl,
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
      pageText: [
        '保险责任 在本附加合同保险期间内，本公司承担以下保险责任：',
        '一、特定疾病豁免保险费 被保险人初次发生并经专科医生明确诊断患本附加合同所指的特定疾病，本公司豁免被保险人特定疾病确诊日以后主合同及本附加合同的保险费。',
        '二、少儿疾病豁免保险费 被保险人初次发生并经专科医生明确诊断患本附加合同所指的少儿疾病，本公司豁免被保险人少儿疾病确诊日以后主合同及本附加合同的保险费。',
        '三、主合同保险费已由本公司其他合同豁免 本公司不再承担本附加合同约定的豁免保险费责任。',
        '四、本附加合同的特定疾病豁免保险费和少儿疾病豁免保险费 累计给付以一次为限。',
        '严重慢性缩窄性心包炎：指因慢性炎症导致心包缩窄。国寿附加少儿国寿福豁免保险费疾病保险。',
        '五、本公司给付的保险金 应按合同约定申请。',
      ].join('\n'),
    }],
    coverageIndicators: [{
      company: '中国人寿',
      productName,
      coverageType: '豁免',
      liability: '特定疾病豁免保险费',
      basis: '后续应交保险费',
      formulaText: '豁免特定疾病确诊日以后主合同及本附加合同的保险费',
      sourceUrl,
      sourceExcerpt: '特定疾病豁免保险费 被保险人初次发生并经专科医生明确诊断患本附加合同所指的特定疾病，本公司豁免被保险人特定疾病确诊日以后主合同及本附加合同的保险费。',
    }, {
      company: '中国人寿',
      productName,
      coverageType: '豁免',
      liability: '少儿疾病豁免保险费',
      basis: '后续应交保险费',
      formulaText: '豁免少儿疾病确诊日以后主合同及本附加合同的保险费',
      sourceUrl,
      sourceExcerpt: '少儿疾病豁免保险费 被保险人初次发生并经专科医生明确诊断患本附加合同所指的少儿疾病，本公司豁免被保险人少儿疾病确诊日以后主合同及本附加合同的保险费。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), [
    '特定疾病豁免保险费',
    '少儿疾病豁免保险费',
  ]);
  assert.equal(cards.every((card) => card.indicatorCheckStatus === 'verified_waiver'), true);
});

test('mergeCoverageTableWithCheckedRows replaces generic responsibility summary with checked rows', () => {
  const rows = mergeCoverageTableWithCheckedRows(
    [{
      coverageType: '保险责任',
      scenario: '第五条 保险责任 在本合同保险期间内，我们按下列规定承担保险责任……',
      payout: '以正式条款为准',
      note: '旧的整段条款',
    }],
    [{
      coverageType: '身故保险金',
      scenario: '被保险人身故',
      payout: '按合同约定给付',
      note: '发生条款约定情形后给付。',
    }],
  );

  assert.deepEqual(rows.map((row) => row.coverageType), ['身故保险金']);
});

test('buildResponsibilityCardsForPolicy marks structured optional indicators as unknown until selected', () => {
  const productName = '新华人寿保险股份有限公司尊尚人生两全保险（分红型）';
  const optionalExcerpt = '投保人可以选择可选责任作为本合同项下的保险责任：（1）祝寿金 被保险人于年满60周岁保单生效对应日零时生存，本公司按该保单生效对应日可选责任的保险金额给付祝寿金。';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    optionalResponsibilityRecords: [{
      company: '新华保险',
      productName,
      coverageType: '可选责任',
      liability: '可选责任',
      responsibilityScope: 'optional',
      selectionStatus: 'unknown',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
      sourceExcerpt: optionalExcerpt,
    }],
    coverageIndicators: [{
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '祝寿金',
      value: 100,
      unit: '%',
      basis: '该保单生效对应日可选责任的保险金额',
      formulaText: '祝寿金 = 该保单生效对应日可选责任的保险金额 × 100%',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
      sourceExcerpt: optionalExcerpt,
    }, {
      company: '新华保险',
      productName,
      coverageType: '规则参数',
      liability: '赔付方式',
      valueText: '定额给付型',
      unit: '方式',
      basis: '保险责任赔付机制',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
      sourceExcerpt: optionalExcerpt,
    }],
  });

  const birthdayCard = cards.find((card) => card.title === '祝寿金');
  assert.equal(birthdayCard?.responsibilityScope, 'optional');
  assert.equal(birthdayCard?.selectionStatus, 'unknown');
  assert.equal(birthdayCard?.selectionEvidence, 'official_terms');
  assert.equal(birthdayCard?.indicators[0]?.selectionStatus, 'unknown');
  assert.equal(cards.some((card) => card.title === '赔付方式'), false);
  assert.equal(cards.some((card) => card.title === '可选责任'), false);
});

test('buildResponsibilityCardsForPolicy marks short optional responsibility excerpts even when liability wording differs', () => {
  const productName = '国寿绿舟综合意外伤害保险';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '中国人寿',
      name: productName,
    },
    coverageIndicators: [{
      company: '中国人寿',
      productName,
      coverageType: '意外保障',
      liability: '特定意外身故保险金',
      value: 100,
      unit: '%',
      basis: '特定意外身故保险金额',
      sourceUrl: 'https://www.e-chinalife.com/terms/lvzhou.pdf',
      sourceExcerpt: '三、特定意外身故保险责任(可选责任)被保险人乘坐公共交通工具遭受意外伤害，并在一百八十日内因该意外伤害身故的，本公司另按约定给付特定意外身故保险金。',
    }, {
      company: '中国人寿',
      productName,
      coverageType: '规则参数',
      liability: '赔付方式',
      valueText: '定额给付型',
      unit: '方式',
      basis: '保险责任赔付机制',
      sourceUrl: 'https://www.e-chinalife.com/terms/lvzhou.pdf',
      sourceExcerpt: '保险责任包括基本责任和可选责任，具体赔付方式按各项责任约定执行。',
    }],
  });

  assert.equal(cards.find((card) => card.title === '特定意外身故保险金')?.selectionStatus, 'unknown');
  assert.equal(cards.find((card) => card.title === '特定意外身故保险金')?.responsibilityScope, 'optional');
  assert.equal(cards.some((card) => card.title === '赔付方式'), false);
});

test('buildResponsibilityCardsForPolicy lets official choice wording override stale basic scope', () => {
  const productName = '复星保德信星无忧少儿版2024重大疾病保险';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '复星保德信人寿',
      name: productName,
    },
    coverageIndicators: [{
      company: '复星保德信人寿',
      productName,
      coverageType: '疾病保障',
      liability: '恶性肿瘤--重度额外保险金',
      responsibilityScope: 'basic',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
      sourceUrl: 'https://www.pflife.com.cn/terms/star.pdf',
      sourceExcerpt: '若您未选择恶性肿瘤--重度额外保险金，重大疾病多次给付保险金责任终止的同时，特定疾病保险金、罕见疾病保险金责任终止。若您选择恶性肿瘤--重度额外保险金，重大疾病多次给付保险金和恶性肿瘤--重度额外保险金责任均终止后，特定疾病保险金、罕见疾病保险金责任终止。',
    }],
  });

  const cancerCard = cards.find((card) => card.title === '恶性肿瘤--重度额外保险金');
  assert.equal(cancerCard?.responsibilityScope, 'optional');
  assert.equal(cancerCard?.selectionStatus, 'unknown');
  assert.equal(cancerCard?.selectionEvidence, 'official_terms');
});

test('buildResponsibilityCardsForPolicy does not treat payout-frequency choices as optional responsibility selection', () => {
  const productName = '测试养老年金保险';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '测试保险',
      name: productName,
    },
    coverageIndicators: [{
      company: '测试保险',
      productName,
      coverageType: '现金流',
      liability: '养老年金',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
      sourceUrl: 'https://official.example-life.test/annuity.pdf',
      sourceExcerpt: '若您选择年领方式，自养老年金开始领取日起，被保险人在每个保单周年日生存，本公司按基本保险金额给付养老年金。',
    }],
  });

  const annuityCard = cards.find((card) => card.title === '养老年金');
  assert.equal(annuityCard?.selectionStatus, '');
  assert.equal(annuityCard?.responsibilityScope, '');
});

test('buildResponsibilityCardsForPolicy does not treat mixed basic optional overview as optional selection', () => {
  const productName = '新华人寿保险股份有限公司尊尚人生两全保险（分红型）';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    coverageIndicators: [{
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 5,
      unit: '%',
      basis: '保险金额',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
      sourceExcerpt: '保险责任包括基本责任和可选责任：1.基本责任在本合同保险期间内，本公司承担下列基本责任的保险责任：(1)生存保险金被保险人生存，本公司按基本责任的保险金额的5%给付生存保险金。',
    }],
  });

  const returnCard = cards.find((card) => card.title === '生存保险金');
  assert.equal(returnCard?.selectionStatus, '');
  assert.equal(returnCard?.responsibilityScope, '');
});

test('buildResponsibilityCardsForPolicy normalizes duplicate maturity and death disability display names', () => {
  const productName = '新华人寿保险股份有限公司尊尚人生两全保险（分红型）';
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: productName,
    },
    coverageIndicators: [{
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '满期返还',
      value: 100,
      unit: '%',
      basis: '保险金额',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
      sourceExcerpt: '满期保险金 被保险人生存至年满80周岁保单生效对应日零时，本公司按基本责任的保险金额给付满期保险金。',
    }, {
      company: '新华保险',
      productName,
      coverageType: '现金流',
      liability: '满期保险金',
      value: 100,
      unit: '%',
      basis: '保险金额',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
      sourceExcerpt: '满期保险金 被保险人生存至年满80周岁保单生效对应日零时，本公司按基本责任的保险金额给付满期保险金。',
    }, {
      company: '新华保险',
      productName,
      coverageType: '人寿保障',
      liability: '疾病全残',
      value: 1.05,
      unit: '倍',
      basis: '现金价值',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
      sourceExcerpt: '身故或身体全残保险金 被保险人在祝寿金约定领取日之前身故或身体全残，本公司按约定给付身故或身体全残保险金，本合同可选责任终止。',
    }],
  });

  assert.equal(cards.filter((card) => card.title === '满期保险金').length, 1);
  assert.equal(cards.find((card) => card.title === '满期保险金')?.indicators.length, 2);
  assert.equal(cards.some((card) => card.title === '满期返还'), false);
  assert.equal(cards.some((card) => card.title === '疾病全残'), false);
  assert.equal(cards.find((card) => card.title === '身故或身体全残保险金')?.selectionStatus, 'unknown');
  assert.equal(cards.find((card) => card.title === '身故或身体全残保险金')?.responsibilityScope, 'optional');
});

test('buildResponsibilityCardsForPolicy does not over-derive clauses when structured indicators are already rich', () => {
  const productName = '复星联合妈咪保贝（星耀版）少儿重大疾病保险';
  const indicator = (liability) => ({
    company: '复星联合健康保险',
    productName,
    coverageType: '疾病保障',
    liability,
    value: 100,
    unit: '%',
    basis: '基本保险金额',
    formulaText: `${liability} = 基本保险金额 × 100%`,
    sourceUrl: 'https://www.fosun-uhi.com/upload/pdf/mamibaby.pdf',
    sourceExcerpt: `${liability}按基本保险金额给付；相邻责任可能包含豁免保险费。`,
  });
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '复星联合健康保险',
      name: productName,
    },
    knowledgeRecords: [{
      company: '复星联合健康保险',
      productName,
      title: `${productName}条款`,
      url: 'https://www.fosun-uhi.com/upload/pdf/mamibaby.pdf',
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
      pageText: [
        '3.2.1 首次重大疾病保险金 被保险人确诊本合同约定重大疾病，本公司按基本保险金额给付首次重大疾病保险金。',
        '3.3.4 轻度疾病保险金 被保险人确诊本合同约定轻度疾病，本公司按基本保险金额的30%给付轻度疾病保险金。',
        '首次重大疾病豁免保险费 本公司视同后续保险费已经交纳。',
      ].join('\n'),
    }],
    coverageIndicators: [
      indicator('首次重大疾病保险金'),
      indicator('轻度疾病保险金'),
      indicator('中度疾病保险金'),
      indicator('少儿特定疾病保险金'),
      indicator('身故保险金'),
      indicator('新生儿暖箱津贴'),
    ],
  });

  assert.equal(cards.length, 6);
  assert.equal(cards.some((card) => /^3[.．]/u.test(card.title)), false);
  assert.equal(cards.find((card) => card.title === '轻度疾病保险金').cashflowTreatment, 'claim_contingent');
});

test('buildResponsibilityCardsForPolicy filters exclusion and waiting-period fragments from responsibility cards', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '测试保险',
      name: '测试重疾险',
    },
    optionalResponsibilityRecords: [{
      company: '测试保险',
      productName: '测试重疾险',
      coverageType: '可选责任',
      liability: '本公司不承担且不再承担给付该种中度疾病的中度疾病保险金',
      sourceUrl: 'https://official.example-life.test/ci.pdf',
      sourceExcerpt: '等待期内本公司不承担且不再承担给付该种中度疾病的中度疾病保险金。',
    }, {
      company: '测试保险',
      productName: '测试重疾险',
      coverageType: '可选责任',
      liability: '轻度疾病保险金',
      scenario: '被保险人确诊轻度疾病，本公司按基本保险金额给付轻度疾病保险金。',
      sourceUrl: 'https://official.example-life.test/ci.pdf',
      sourceExcerpt: '被保险人确诊轻度疾病，本公司按基本保险金额给付轻度疾病保险金。',
    }],
    coverageIndicators: [{
      company: '测试保险',
      productName: '测试重疾险',
      coverageType: '疾病保障',
      liability: '本公司不承担给付该种轻度疾病的轻度疾病保险金',
      basis: '基本保险金额',
      sourceUrl: 'https://official.example-life.test/ci.pdf',
      sourceExcerpt: '等待期内本公司不承担给付该种轻度疾病的轻度疾病保险金。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['轻度疾病保险金']);
});

test('buildResponsibilityCardsForPolicy keeps waiting-period premium refund obligations', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '长生人寿',
      name: '长生彩虹桥国际医疗保险',
    },
    coverageIndicators: [{
      company: '长生人寿',
      productName: '长生彩虹桥国际医疗保险',
      coverageType: '医疗保障',
      liability: '等待期内恶性肿瘤退还所交保险费',
      triggerCondition: '等待期内经认可医院专科医生确诊初次罹患合同定义恶性肿瘤。',
      basis: '所交保险费',
      formulaText: '退还金额 = 所交保险费',
      sourceUrl: 'https://official.example-life.test/rainbow-medical.pdf',
      sourceExcerpt: '被保险人在等待期内，经我们认可的医院专科医生确诊初次罹患本合同所定义的恶性肿瘤，我们不承担给付医疗保险金的责任，但我们将无息退还所交保险费，本合同终止。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['等待期内恶性肿瘤退还所交保险费']);
  assert.equal(cards[0].cashflowTreatment, 'claim_contingent');
});

test('buildResponsibilityCardsForPolicy keeps waiting-period paid-premium benefit obligations', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '大都会人寿',
      name: '恶性肿瘤短期疾病保险',
    },
    coverageIndicators: [{
      company: '大都会人寿',
      productName: '恶性肿瘤短期疾病保险',
      coverageType: '疾病保障',
      liability: '等待期内恶性肿瘤已交保费给付',
      triggerCondition: '等待期内被保险人初次确诊患有恶性肿瘤。',
      basis: '已交保费',
      formulaText: '给付金额 = 已交保费',
      sourceUrl: 'https://official.example-life.test/cancer-short-term.pdf',
      sourceExcerpt: '若被保险人在等待期内初次确诊患有恶性肿瘤，本公司按已交保费给付，本合同终止。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['等待期内恶性肿瘤已交保费给付']);
  assert.equal(cards[0].cashflowTreatment, 'claim_contingent');
});

test('buildResponsibilityCardsForPolicy keeps waiting-period risk-premium refund obligations', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '信泰人寿',
      name: '信泰附加智富宝提前给付重大疾病保险',
    },
    coverageIndicators: [{
      company: '信泰人寿',
      productName: '信泰附加智富宝提前给付重大疾病保险',
      coverageType: '疾病保障',
      liability: '等待期内重大疾病退还风险保险费',
      triggerCondition: '被保险人在一百八十日内因疾病首次确诊重大疾病。',
      basis: '本附加合同已交风险保险费',
      formulaText: '等待期内重大疾病退还风险保险费 = 本附加合同已交风险保险费',
      sourceUrl: 'https://official.example-life.test/critical-illness.pdf',
      sourceExcerpt: '被保险人于本附加合同生效日或最后复效日起一百八十日内，因疾病首次被确诊发生重大疾病，本公司无息退还本附加合同的已交风险保险费，本附加合同效力终止。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['等待期内重大疾病退还风险保险费']);
  assert.equal(cards[0].cashflowTreatment, 'claim_contingent');
});

test('buildResponsibilityCardsForPolicy keeps higher education insurance cashflow', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '大都会人寿',
      name: '少儿高等教育年金保险',
    },
    coverageIndicators: [{
      company: '大都会人寿',
      productName: '少儿高等教育年金保险',
      coverageType: '现金流',
      liability: '高等教育保险金',
      condition: '被保险人生存至约定高等教育保险金领取日。',
      basis: '基本保险金额',
      formulaText: '按基本保险金额给付高等教育保险金',
      sourceUrl: 'https://official.example-life.test/education-annuity.pdf',
      sourceExcerpt: '若被保险人生存至约定的高等教育保险金领取日，本公司按基本保险金额给付高等教育保险金。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['高等教育保险金']);
  assert.equal(cards[0].category, '现金流');
});

test('buildResponsibilityCardsForPolicy filters sentence fragments without dropping valid long titles', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '新华保险',
      name: '测试终身寿险',
    },
    optionalResponsibilityRecords: [{
      company: '新华保险',
      productName: '测试终身寿险',
      coverageType: '保险责任',
      liability: '若身故或身体全残时被保险人处于18周岁保单周年日之后，则其身故或身体全残保险金',
      scenario: '若身故或身体全残时被保险人处于18周岁保单周年日之后，则其身故或身体全残保险金按约定给付。',
      sourceUrl: 'https://official.example-life.test/life.pdf',
      sourceExcerpt: '若身故或身体全残时被保险人处于18周岁保单周年日之后，则其身故或身体全残保险金按约定给付。',
    }, {
      company: '新华保险',
      productName: '测试终身寿险',
      coverageType: '保险责任',
      liability: '投保人意外伤害身故或意外伤害身体全残豁免保险费',
      scenario: '投保人意外伤害身故或身体全残，本公司视同续期保险费已经交纳。',
      sourceUrl: 'https://official.example-life.test/life.pdf',
      sourceExcerpt: '投保人意外伤害身故或身体全残，本公司视同续期保险费已经交纳。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['投保人意外伤害身故或意外伤害身体全残豁免保险费']);
});

test('buildResponsibilityCardsForPolicy keeps attached covers whose names include limit wording', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '众安保险',
      name: '机动车商业保险示范',
    },
    coverageIndicators: [{
      company: '众安保险',
      productName: '机动车商业保险示范',
      coverageType: '意外保障',
      liability: '附加法定节假日限额翻倍险',
      basis: '责任限额',
      formulaText: '附加法定节假日限额翻倍险：法定节假日期间按合同约定提高赔偿限额',
      sourceUrl: 'https://static.zhongan.com/upload/online/material/motor.pdf',
      sourceExcerpt: '附加法定节假日限额翻倍险，在法定节假日期间发生主险约定事故的，保险人按合同约定提高赔偿限额。',
    }],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '附加法定节假日限额翻倍险');
});

test('buildResponsibilityCardsForPolicy keeps disability limit adjustment responsibilities', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '众安保险',
      name: '附加伤残等级赔偿限额比例调整',
    },
    coverageIndicators: [{
      company: '众安保险',
      productName: '附加伤残等级赔偿限额比例调整',
      coverageType: '意外保障',
      liability: '伤残等级赔偿限额比例调整',
      basis: '附加条款表列比例',
      formulaText: '伤残赔偿比例 = 附加条款表列比例',
      condition: '主保险合同保险责任范围内事故导致雇员或从业人员伤残',
      sourceUrl: 'https://static.zhongan.com/upload/online/material/disability-limit.pdf',
      sourceExcerpt: '在保险期间内，发生主保险合同保险责任范围内保险事故导致被保险人的雇员/从业人员出现伤残时，保险人对主合同中约定的伤残赔偿比例进行调整，具体如下表。',
      basisKey: 'schedule_or_policy_table',
      calculationKey: 'schedule_or_policy_table',
      calculationEligible: false,
      calculationMetadataVersion: 'manual-review-20260623',
    }],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.title, '伤残等级赔偿限额比例调整');
  assert.equal(cards[0]?.category, '意外保障');
  assert.equal(cards[0]?.calculationStatus, 'needs_table');
});

test('buildResponsibilityCardsForPolicy cleans indicator title prefixes and filters cumulative-payment fragments', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '测试保险',
      name: '测试医疗险',
    },
    coverageIndicators: [{
      company: '测试保险',
      productName: '测试医疗险',
      coverageType: '医疗保障',
      liability: '对于特定疾病住院医疗保险金',
      value: 100,
      unit: '%',
      basis: '医疗费用',
      sourceUrl: 'https://official.example-life.test/medical.pdf',
      sourceExcerpt: '对于特定疾病住院医疗保险金，被保险人发生约定医疗费用，本公司按约定给付特定疾病住院医疗保险金。',
    }, {
      company: '测试保险',
      productName: '测试医疗险',
      coverageType: '意外保障',
      liability: '如果累计给付的公共交通意外身故保险金和公共交通意外伤残保险金',
      value: 100,
      unit: '%',
      basis: '保险金额',
      sourceUrl: 'https://official.example-life.test/accident.pdf',
      sourceExcerpt: '如果累计给付的公共交通意外身故保险金和公共交通意外伤残保险金达到限额，本项责任终止。',
    }, {
      company: '测试保险',
      productName: '测试医疗险',
      coverageType: '豁免',
      liability: '保险费少儿疾病豁免保险费',
      basis: '后续应交保险费',
      sourceUrl: 'https://official.example-life.test/waiver.pdf',
      sourceExcerpt: '少儿疾病豁免保险费 被保险人确诊合同约定少儿疾病，本公司豁免后续保险费。',
    }, {
      company: '测试保险',
      productName: '测试医疗险',
      coverageType: '豁免',
      liability: '白血病国寿附加豁免保险费',
      basis: '页眉粘连片段',
      sourceUrl: 'https://official.example-life.test/waiver-header.pdf',
      sourceExcerpt: '白血病 国寿附加豁免保险费疾病保险利益条款 第一条 保险合同构成。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['特定疾病住院医疗保险金', '少儿疾病豁免保险费']);
});

test('buildResponsibilityCardsForPolicy keeps rider responsibility-only cards separate by product', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '测试保险',
      name: '主险产品',
    },
    optionalResponsibilityRecords: [{
      company: '测试保险',
      productName: '主险产品',
      coverageType: '可选责任',
      liability: '可选责任一',
      scenario: '主险可选责任一按主险条款给付。',
      sourceUrl: 'https://official.example-life.test/main.pdf',
      sourceExcerpt: '主险可选责任一按主险条款给付。',
    }, {
      company: '测试保险',
      productName: '附加险产品',
      coverageType: '可选责任',
      liability: '可选责任一',
      scenario: '附加险可选责任一按附加险条款给付。',
      sourceUrl: 'https://official.example-life.test/rider.pdf',
      sourceExcerpt: '附加险可选责任一按附加险条款给付。',
    }],
  });

  assert.equal(cards.length, 2);
  assert.deepEqual(
    cards.map((card) => [card.productName, card.title, card.sourceUrl]),
    [
      ['主险产品', '可选责任一', 'https://official.example-life.test/main.pdf'],
      ['附加险产品', '可选责任一', 'https://official.example-life.test/rider.pdf'],
    ],
  );
});

test('buildResponsibilityCardsForPolicy filters beneficiary and table fragments from card titles', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '测试保险',
      name: '测试责任清洗产品',
    },
    coverageIndicators: [{
      company: '测试保险',
      productName: '测试责任清洗产品',
      coverageType: '人寿保障',
      liability: '受益人您或者被保险人可以指定一人或多人为身故保险金',
      basis: '保险金额',
      formulaText: '身故保险金 = 保险金额',
      sourceUrl: 'https://official.example-life.test/beneficiary.pdf',
      sourceExcerpt: '受益人您或者被保险人可以指定一人或多人为身故保险金受益人。',
    }, {
      company: '测试保险',
      productName: '测试责任清洗产品',
      coverageType: '医疗保障',
      liability: '补偿原则我们在向受益人给付医疗保险金',
      basis: '实际合理医疗费用',
      formulaText: '医疗保险金 = 医疗费用 × 给付比例',
      sourceUrl: 'https://official.example-life.test/medical.pdf',
      sourceExcerpt: '补偿原则我们在向受益人给付医疗保险金时适用补偿原则。',
    }, {
      company: '测试保险',
      productName: '测试责任清洗产品',
      coverageType: '医疗保障',
      liability: '人民币(元)保险单年度被保人年龄当年度保险费累计保险费补偿金',
      basis: '实际合理医疗费用',
      formulaText: '补偿金 = 医疗费用 × 给付比例',
      sourceUrl: 'https://official.example-life.test/table.pdf',
      sourceExcerpt: '人民币(元)保险单年度被保人年龄当年度保险费累计保险费补偿金。',
    }, {
      company: '测试保险',
      productName: '测试责任清洗产品',
      coverageType: '医疗保障',
      liability: '补偿金',
      basis: '住院日数',
      formulaText: '补偿金 = 住院日数 × 每日给付金额',
      sourceUrl: 'https://official.example-life.test/allowance.pdf',
      sourceExcerpt: '本公司按投保单上所载金额乘以住院日数给付补偿金予被保险人。',
    }, {
      company: '测试保险',
      productName: '测试责任清洗产品',
      coverageType: '人寿保障',
      liability: '申请人向本公司请求给付保险金',
      basis: '保险金额',
      formulaText: '保险金 = 保险金额',
      sourceUrl: 'https://official.example-life.test/claim.pdf',
      sourceExcerpt: '申请人向本公司请求给付保险金的诉讼时效期间为二年。',
    }, {
      company: '测试保险',
      productName: '测试责任清洗产品',
      coverageType: '人寿保障',
      liability: '被保险人对本公司请求给付保险金',
      basis: '保险金额',
      formulaText: '保险金 = 保险金额',
      sourceUrl: 'https://official.example-life.test/claim.pdf',
      sourceExcerpt: '被保险人对本公司请求给付保险金的权利，自其知道或应当知道保险事故发生之日起二年不行使即告丧失。',
    }, {
      company: '测试保险',
      productName: '测试责任清洗产品',
      coverageType: '人寿保障',
      liability: '本公司收到申请人的保险金',
      basis: '保险金额',
      formulaText: '保险金 = 保险金额',
      sourceUrl: 'https://official.example-life.test/claim.pdf',
      sourceExcerpt: '本公司收到申请人的保险金给付申请书后及时核定。',
    }, {
      company: '测试保险',
      productName: '测试责任清洗产品',
      coverageType: '医疗保障',
      liability: '住院医疗保险金',
      basis: '实际合理医疗费用',
      formulaText: '住院医疗保险金 = 医疗费用 × 给付比例',
      sourceUrl: 'https://official.example-life.test/terms.pdf',
      sourceExcerpt: '被保险人住院治疗发生合理医疗费用，本公司按约定给付住院医疗保险金。',
    }],
    knowledgeRecords: [{
      company: '测试保险',
      productName: '测试责任清洗产品',
      url: 'https://official.example-life.test/terms.pdf',
      title: '测试责任清洗产品条款',
      pageText: '诉讼时效 受益人向我们请求给付保险金。保险责任 住院医疗保险金 被保险人住院治疗发生合理医疗费用，本公司按约定给付住院医疗保险金。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), ['住院医疗保险金']);
});

test('buildResponsibilityCardsForPolicy ignores AIA claim application and beneficiary fragments', () => {
  const productName = '友邦宝安个人意外伤害保险';
  const sourceUrl = 'https://www.aia.com.cn/content/dam/cn/zh-cn/docs/public-disclosure/B0311-2_ESPA.pdf';
  const common = {
    company: '友邦人寿',
    productName,
    sourceUrl,
  };
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '友邦人寿',
      name: productName,
    },
    knowledgeRecords: [{
      company: '友邦人寿',
      productName,
      title: `${productName}条款`,
      url: sourceUrl,
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
      pageText: [
        '第二章 保险责任 第二条 意外身故、烧伤及残疾保险金给付',
        '一、意外身故保险金:在本合同有效期内,若被保险人因遭受本合同所定义的意外事故,且自该事故发生之日起一百八十天内身故的,则本公司给付等值于本合同的基本保险金额的意外身故保险金予健在的身故保险金受益人。',
        '二、意外残疾保险金:在本合同有效期内,若被保险人因遭受本合同所定义的意外事故,且自该事故发生之日起一百八十天内导致残疾,则本公司给付意外残疾保险金予被保险人。',
        '三、意外烧伤保险金:在本合同有效期内,若被保险人因遭受本合同所定义的意外事故烧伤,则本公司给付意外烧伤保险金予被保险人。',
        '一、若被保险人身故,索赔申请人应填写索赔申请书,并提供以下证明和资料原件予本公司,以申请意外身故保险金: (3)身故保险金受益人的户籍证明、身份证件。',
        '权益转让及身故保险金受益人的指定与变更 投保人经被保险人同意,可提出本合同权益转让并书面通知本公司。',
        '身故保险金的受领人:指本合同的身故保险金受益人或被保险人的法定继承人。',
        '给付表一 人身保险残疾程度与保险金给付比例表。',
      ].join(' '),
    }],
    coverageIndicators: [{
      ...common,
      coverageType: '意外身故保障',
      liability: '意外身故保险金',
      basis: '基本保险金额',
      formulaText: '意外身故保险金 = 基本保险金额',
      sourceExcerpt: '意外身故保险金:在本合同有效期内,若被保险人因遭受本合同所定义的意外事故,本公司给付等值于本合同的基本保险金额的意外身故保险金。',
    }, {
      ...common,
      coverageType: '意外伤残保障',
      liability: '意外残疾保险金',
      basis: '基本保险金额',
      formulaText: '意外残疾保险金 = 基本保险金额',
      sourceExcerpt: '意外残疾保险金:在本合同有效期内,若被保险人因遭受本合同所定义的意外事故导致残疾,本公司给付意外残疾保险金。',
    }, {
      ...common,
      coverageType: '意外伤残保障',
      liability: '意外烧伤保险金',
      basis: '基本保险金额',
      formulaText: '意外烧伤保险金 = 基本保险金额',
      sourceExcerpt: '意外烧伤保险金:在本合同有效期内,若被保险人因遭受本合同所定义的意外事故烧伤,本公司给付意外烧伤保险金。',
    }, {
      ...common,
      coverageType: '规则参数',
      liability: '赔付方式',
      basis: '保险责任赔付机制',
      sourceExcerpt: '条款包含意外身故保险金、意外残疾保险金和意外烧伤保险金。',
    }],
  });

  assert.deepEqual(cards.map((card) => card.title), [
    '意外身故保险金',
    '意外残疾保险金',
    '意外烧伤保险金',
  ]);
  assert.equal(cards.every((card) => card.indicatorCheckStatus === 'verified_claim_contingent'), true);
});
