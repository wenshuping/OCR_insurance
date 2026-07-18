import assert from 'node:assert/strict';
import test from 'node:test';

import { routeInsuranceProductCategory } from '../server/insurance-product-category-router.mjs';

test('惠民医疗险责任中提到特定疾病时仍按医疗保险路由', () => {
  const result = routeInsuranceProductCategory({
    productName: '城市惠民保',
    cards: [
      { title: '国内特定高额药品医疗保障', sourceExcerpt: '确诊特定疾病后，按约定比例报销药品医疗费用。' },
      { title: '住院医疗费用保障', sourceExcerpt: '医保目录内合规自付费用超过免赔额后报销。' },
    ],
  });

  assert.equal(result.productCategory, 'medical');
});

test('routeInsuranceProductCategory identifies Xinrongyao incremental whole life with compound formula', () => {
  const result = routeInsuranceProductCategory({
    productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
    records: [{ productType: '寿险' }],
    indicators: [{ productType: '增额终身寿险' }],
    sourceSections: {
      mainResponsibilityText: '基本保险金额×(1+3.5%)^(n-1)，特定公共交通工具意外额外赔',
    },
  });

  assert.equal(result.productCategory, 'incremental_whole_life');
  assert.equal(result.categoryLabel, '增额终身寿险');
  assert.equal(result.modelTier, 'flash');
  assert.deepEqual(result.featureTags, ['compound_growth', 'traffic_accident_extra']);
});

test('routeInsuranceProductCategory routes child multi-pay grouped critical illness to pro', () => {
  const result = routeInsuranceProductCategory({
    productName: '多倍保障少儿重大疾病保险（超越版）',
    records: [{ productType: '重疾险' }],
    cards: [{ title: '少儿前10年关爱保险金' }],
    sourceSections: {
      mainResponsibilityText: '等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 疾病分组 第二次重大疾病保险金 累计给付限额',
    },
  });

  assert.equal(result.productCategory, 'critical_illness');
  assert.equal(result.categoryLabel, '重大疾病保险');
  assert.equal(result.modelTier, 'pro');
  assert.ok(result.featureTags.includes('disease_grouping'));
  assert.ok(result.featureTags.includes('children'));
  assert.ok(result.featureTags.includes('multi_pay'));
});

test('routeInsuranceProductCategory routes participating annuity to pro', () => {
  const result = routeInsuranceProductCategory({
    productName: '尊贵人生年金保险(分红型)',
    records: [{ productType: '年金险' }],
    sourceSections: { mainResponsibilityText: '关爱年金 生存保险金 身故保险金 累积红利保险金额' },
  });

  assert.equal(result.productCategory, 'annuity');
  assert.equal(result.categoryLabel, '年金保险（分红型）');
  assert.equal(result.modelTier, 'pro');
  assert.ok(result.featureTags.includes('participating'));
});

test('routeInsuranceProductCategory keeps participating incremental whole life on incremental template', () => {
  const result = routeInsuranceProductCategory({
    productName: '荣耀终身寿险（分红型）',
    indicators: [{ productType: '增额终身寿险' }],
    sourceSections: {
      mainResponsibilityText: '有效保险金额按年复利递增，累积红利保险金额用于增加身故保险金。',
    },
  });

  assert.equal(result.productCategory, 'incremental_whole_life');
  assert.equal(result.categoryLabel, '增额终身寿险（分红型）');
  assert.equal(result.modelTier, 'pro');
  assert.ok(result.featureTags.includes('compound_growth'));
  assert.ok(result.featureTags.includes('participating'));
});

test('routeInsuranceProductCategory routes ordinary participating whole life as ordinary whole life', () => {
  const result = routeInsuranceProductCategory({
    productName: '福禄终身寿险（分红型）',
    records: [{ productType: '终身寿险' }],
    sourceSections: {
      mainResponsibilityText: '本合同为分红保险，红利分配是不确定的。本公司承担身故保险金责任。',
    },
  });

  assert.equal(result.productCategory, 'ordinary_whole_life');
  assert.equal(result.categoryLabel, '终身寿险（分红型）');
  assert.equal(result.modelTier, 'pro');
  assert.deepEqual(result.featureTags, ['participating']);
});

test('routeInsuranceProductCategory keeps participating life generic only when specific life identity is unclear', () => {
  const result = routeInsuranceProductCategory({
    productName: '福满人生寿险（分红型）',
    records: [{ productType: '寿险' }],
    sourceSections: {
      mainResponsibilityText: '本合同为分红保险，红利分配是不确定的。本公司承担身故保险金责任。',
    },
  });

  assert.equal(result.productCategory, 'participating_life');
  assert.equal(result.categoryLabel, '人寿保险（分红型）');
  assert.equal(result.modelTier, 'pro');
});

test('routeInsuranceProductCategory routes medical and accident examples correctly', () => {
  const medical = routeInsuranceProductCategory({
    productName: '百万医疗保险',
    sourceSections: { mainResponsibilityText: '住院医疗保险金 门诊医疗费用 免赔额后按比例报销。' },
  });
  const accident = routeInsuranceProductCategory({
    productName: '综合意外伤害保险',
    records: [{ productType: '意外险' }],
    cards: [{ title: '意外身故保险金' }, { title: '意外伤残保险金' }],
  });

  assert.equal(medical.productCategory, 'medical');
  assert.equal(medical.categoryLabel, '医疗保险');
  assert.equal(medical.modelTier, 'flash');
  assert.equal(accident.productCategory, 'accident');
  assert.equal(accident.categoryLabel, '意外伤害保险');
  assert.equal(accident.modelTier, 'flash');
});

test('routeInsuranceProductCategory routes universal and investment-linked examples to pro with account or risk tags', () => {
  const universal = routeInsuranceProductCategory({
    productName: '金账户万能保险',
    sourceSections: { mainResponsibilityText: '保单账户价值按结算利率累积，最低保证利率为2%。' },
  });
  const investmentLinked = routeInsuranceProductCategory({
    productName: '稳健投资连结保险',
    sourceSections: { mainResponsibilityText: '投资账户单位价格每日公布，投资风险由投保人承担，不保证收益。' },
  });

  assert.equal(universal.productCategory, 'universal_life');
  assert.equal(universal.modelTier, 'pro');
  assert.ok(universal.featureTags.includes('account_value'));
  assert.equal(investmentLinked.productCategory, 'investment_linked');
  assert.equal(investmentLinked.modelTier, 'pro');
  assert.ok(investmentLinked.featureTags.includes('investment_risk'));
});

test('routeInsuranceProductCategory distinguishes term life from ordinary whole life', () => {
  const term = routeInsuranceProductCategory({
    productName: '守护定期寿险',
    sourceSections: { mainResponsibilityText: '保险期间为30年，本公司承担身故保险金和全残保险金。' },
  });
  const whole = routeInsuranceProductCategory({
    productName: '传家终身寿险',
    sourceSections: { mainResponsibilityText: '保险期间为终身，本公司承担身故保险金和全残保险金。' },
  });

  assert.equal(term.productCategory, 'term_life');
  assert.equal(term.categoryLabel, '定期寿险');
  assert.equal(whole.productCategory, 'ordinary_whole_life');
  assert.equal(whole.categoryLabel, '终身寿险');
});

test('routeInsuranceProductCategory does not classify whole life as accident because of traffic extra', () => {
  const result = routeInsuranceProductCategory({
    productName: '稳盈终身寿险',
    records: [{ productType: '终身寿险' }],
    sourceSections: {
      mainResponsibilityText: '本公司承担身故保险金和全残保险金，另含航空意外身故额外给付责任。',
    },
  });

  assert.equal(result.productCategory, 'ordinary_whole_life');
  assert.equal(result.categoryLabel, '终身寿险');
  assert.ok(result.featureTags.includes('traffic_accident_extra'));
});

test('routeInsuranceProductCategory routes long-term care and endowment complex products to pro', () => {
  const care = routeInsuranceProductCategory({
    productName: '长期护理保险',
    sourceSections: { mainResponsibilityText: '被保险人达到约定长期护理状态，本公司给付护理保险金。' },
  });
  const endowment = routeInsuranceProductCategory({
    productName: '如意两全保险',
    sourceSections: { mainResponsibilityText: '满期保险金按以下二者较大者给付，另承担身故保险金。' },
  });

  assert.equal(care.productCategory, 'long_term_care');
  assert.equal(care.modelTier, 'pro');
  assert.equal(endowment.productCategory, 'endowment');
  assert.equal(endowment.modelTier, 'pro');
});

test('routeInsuranceProductCategory keeps tags unique across repeated signals', () => {
  const result = routeInsuranceProductCategory({
    productName: '尊贵人生年金保险（分红型）',
    records: [{ productType: '年金保险（分红型）' }],
    indicators: [{ productType: '分红年金' }],
    sourceSections: {
      mainResponsibilityText: '分红型 年金 红利 累积红利保险金额 红利分配。',
      supplementSections: [{ text: '保单红利是不确定的。' }],
    },
  });

  assert.equal(result.featureTags.filter((tag) => tag === 'participating').length, 1);
});

test('routeInsuranceProductCategory lets whole-life identity outrank incidental annuity conversion wording', () => {
  const result = routeInsuranceProductCategory({
    productName: '传世荣耀终身寿险',
    records: [{ productType: '终身寿险' }],
    indicators: [{ productType: '增额终身寿险' }],
    sourceSections: {
      mainResponsibilityText: '本合同承担身故保险金，可申请年金转换权益。',
    },
  });

  assert.equal(result.productCategory, 'incremental_whole_life');
  assert.equal(result.categoryLabel, '增额终身寿险');
});

test('routeInsuranceProductCategory lets medical identity outrank critical illness medical wording', () => {
  const result = routeInsuranceProductCategory({
    productName: '安心百万医疗保险',
    records: [{ productType: '医疗险' }],
    sourceSections: {
      mainResponsibilityText: '重大疾病医疗保险金按约定补偿住院医疗费用。',
    },
  });

  assert.equal(result.productCategory, 'medical');
  assert.equal(result.categoryLabel, '医疗保险');
});

test('routeInsuranceProductCategory lets accident identity outrank generic medical expense wording', () => {
  const result = routeInsuranceProductCategory({
    productName: '综合意外伤害保险',
    records: [{ productType: '意外险' }],
    sourceSections: {
      mainResponsibilityText: '住院津贴 医疗费用补偿 身故保险金。',
    },
  });

  assert.equal(result.productCategory, 'accident');
  assert.equal(result.categoryLabel, '意外伤害保险');
});

test('routeInsuranceProductCategory detects scalar compound-growth formulas', () => {
  const result = routeInsuranceProductCategory({
    productName: '鑫未来终身寿险',
    records: [{ productType: '终身寿险' }],
    sourceSections: {
      mainResponsibilityText: '第n个保单年度的保险金额为基本保险金额×1.035^(n-1)。',
    },
  });

  assert.equal(result.productCategory, 'ordinary_whole_life');
  assert.equal(result.categoryLabel, '终身寿险');
  assert.ok(result.featureTags.includes('compound_growth'));
});

test('routeInsuranceProductCategory does not treat compound loan interest as increasing coverage', () => {
  const result = routeInsuranceProductCategory({
    productName: '新华人寿保险股份有限公司康健无忧两全保险',
    sourceSections: {
      mainResponsibilityText: '贷款利息根据贷款利率按年复利计算。本合同承担满期生存保险金和身故保险金。',
    },
  });

  assert.equal(result.productCategory, 'endowment');
  assert.equal(result.categoryLabel, '两全保险');
  assert.equal(result.featureTags.includes('compound_growth'), false);
});
