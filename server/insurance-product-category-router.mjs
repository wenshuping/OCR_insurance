function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function partsFromObject(value, fields) {
  if (!value || typeof value !== 'object') return [];
  return fields.map((field) => value[field]);
}

function sourceSectionText(sourceSections = {}) {
  return [
    sourceSections.mainResponsibilityText,
    ...normalizeArray(sourceSections.supplementSections).flatMap((section) => [
      section.type,
      section.title,
      section.text,
      section.content,
      section.summary,
    ]),
  ];
}

function identityText({
  productName = '',
  records = [],
  indicators = [],
} = {}) {
  return [
    productName,
    ...normalizeArray(records).flatMap((record) => partsFromObject(record, [
      'productType',
      'product_type',
      'insuranceType',
      'insurance_type',
    ])),
    ...normalizeArray(indicators).flatMap((indicator) => partsFromObject(indicator, [
      'productType',
      'product_type',
    ])),
  ].map(text).filter(Boolean).join(' ').normalize('NFKC');
}

function allText({
  productName = '',
  records = [],
  indicators = [],
  cards = [],
  sourceSections = {},
} = {}) {
  return [
    productName,
    ...normalizeArray(records).flatMap((record) => partsFromObject(record, [
      'productType',
      'product_type',
      'insuranceType',
      'insurance_type',
      'title',
      'pageText',
      'responsibilityText',
      'responsibility_text',
      'content',
      'text',
    ])),
    ...normalizeArray(indicators).flatMap((indicator) => partsFromObject(indicator, [
      'productType',
      'product_type',
      'coverageType',
      'coverage_type',
      'liability',
      'responsibilityName',
      'responsibility_name',
      'formulaText',
      'formula_text',
      'description',
      'text',
    ])),
    ...normalizeArray(cards).flatMap((card) => partsFromObject(card, [
      'title',
      'category',
      'responsibilityType',
      'responsibility_type',
      'sourceExcerpt',
      'source_excerpt',
      'summary',
      'text',
    ])),
    ...sourceSectionText(sourceSections),
  ].map(text).filter(Boolean).join(' ').normalize('NFKC');
}

function includes(content, pattern) {
  return pattern.test(content);
}

function addTag(tags, tag, enabled = true) {
  if (enabled && !tags.includes(tag)) tags.push(tag);
}

function hasCompoundGrowth(content) {
  return includes(content, /(?:基本保险金额|基本保额)\s*[×xX*]\s*[（(]\s*1\s*[+＋]\s*\d+(?:\.\d+)?\s*%\s*[）)]\s*(?:\^|的第?)?\s*(?:[（(]?\s*n\s*[-－]\s*1\s*[）)]?|n-1)?/u)
    || includes(content, /(?:基本保险金额|基本保额)\s*[×xX*]\s*1\.\d+\s*(?:\^|的第?)\s*(?:[（(]?\s*n\s*[-－]\s*1\s*[）)]?|n-1)/u)
    || includes(content, /有效保险金额/u);
}

function categoryLabelFor(category, participating) {
  const labels = {
    incremental_whole_life: participating ? '增额终身寿险（分红型）' : '增额终身寿险',
    ordinary_whole_life: participating ? '终身寿险（分红型）' : '终身寿险',
    term_life: participating ? '定期寿险（分红型）' : '定期寿险',
    annuity: participating ? '年金保险（分红型）' : '年金保险',
    endowment: participating ? '两全保险（分红型）' : '两全保险',
    critical_illness: '重大疾病保险',
    medical: '医疗保险',
    accident: '意外伤害保险',
    long_term_care: '长期护理保险',
    universal_life: '万能保险',
    investment_linked: '投资连结保险',
    participating_life: '人寿保险（分红型）',
    other: '其他',
  };
  return labels[category] || labels.other;
}

function routeCategory(content, identity, participating, compoundGrowth) {
  const incrementalIdentity = includes(identity, /增额终身寿|增额寿/u);
  const wholeLifeIdentity = includes(identity, /终身寿|终身保险/u);
  const termLifeIdentity = includes(identity, /定期寿|定期人寿/u);
  const accidentIdentity = includes(identity, /意外险|意外伤害保险/u);
  const medicalIdentity = includes(identity, /医疗险|医疗保险/u);
  const criticalIllnessIdentity = includes(identity, /重大疾病|重疾/u);
  const annuityIdentity = includes(identity, /年金|养老金|养老保险/u);
  const endowmentIdentity = includes(identity, /两全/u);
  const universalIdentity = includes(identity, /万能/u);
  const investmentLinkedIdentity = includes(identity, /投资连结|投连/u);
  const longTermCareIdentity = includes(identity, /长期护理|护理保险/u);
  const lifeProductSignal = includes(identity, /终身寿|寿险|定期寿|增额|人寿保险/u)
    || includes(content, /终身寿险|终身寿|增额终身|定期寿险|定期人寿|普通寿险/u);
  const wholeLifeSignal = includes(content, /终身寿|终身保险|身故保险金|全残保险金/u);

  if (incrementalIdentity) return 'incremental_whole_life';
  if (investmentLinkedIdentity) return 'investment_linked';
  if (universalIdentity) return 'universal_life';
  if (longTermCareIdentity) return 'long_term_care';
  if (accidentIdentity) return 'accident';
  if (medicalIdentity) return 'medical';
  if (criticalIllnessIdentity) return 'critical_illness';
  if (termLifeIdentity) return 'term_life';
  if (wholeLifeIdentity) return 'ordinary_whole_life';
  if (annuityIdentity) return 'annuity';
  if (endowmentIdentity) return 'endowment';

  if (includes(content, /(?:医疗保险金|住院|门诊|免赔额|报销|医疗费用|医保目录|药品医疗保障)/u)
    && !includes(content, /意外医疗/u)) return 'medical';
  if (includes(content, /重大疾病|重疾|轻度疾病|中度疾病|重度疾病|特定疾病/u)) return 'critical_illness';
  if (includes(content, /(?:投资连结|投连险|投资账户|单位价格|买入价|卖出价)/u)) return 'investment_linked';
  if (includes(content, /(?:万能保险|万能型|个人账户价值|保单账户价值|结算利率|最低保证利率)/u)) return 'universal_life';
  if (includes(content, /(?:长期护理|护理保险金|护理状态|失能护理|长期照护)/u)) return 'long_term_care';
  if (includes(content, /(?:年金|养老金|养老年金|生存保险金|祝寿金|教育金)/u)) return 'annuity';
  if (includes(content, /(?:两全|满期保险金|满期生存保险金)/u)) return 'endowment';
  if (includes(content, /增额终身寿|增额寿|保额递增/u)) return 'incremental_whole_life';
  if (includes(content, /(?:定期寿险|定期人寿|保险期间.{0,20}(?:年|岁).*身故|身故.{0,20}保险期间.{0,20}(?:年|岁))/u)) return 'term_life';
  if (includes(content, /(?:意外伤害保险|意外身故|意外伤残|意外医疗|交通意外)/u) && !lifeProductSignal) return 'accident';
  if (participating && includes(identity, /寿险|人寿保险/u)) return 'participating_life';
  if (lifeProductSignal || wholeLifeSignal) return 'ordinary_whole_life';
  if (includes(content, /(?:医疗保险|医疗险)/u)) return 'medical';
  return 'other';
}

function modelTierFor(category, content, participating) {
  if ([
    'critical_illness',
    'annuity',
    'endowment',
    'long_term_care',
    'universal_life',
    'investment_linked',
    'participating_life',
  ].includes(category)) return 'pro';

  if (participating) return 'pro';
  if (includes(content, /(?:可选责任|以下二者|以下三者|较大者|账户价值|累计给付限额|疾病分组)/u)) return 'pro';
  if (content.length > 5000) return 'pro';
  return 'flash';
}

export function routeInsuranceProductCategory(input = {}) {
  const content = allText(input);
  const identity = identityText(input);
  const featureTags = [];

  const participating = includes(content, /(?:分红型|分红保险|红利|累积红利保险金额|保单红利|红利分配)/u);
  const compoundGrowth = hasCompoundGrowth(content);
  const category = routeCategory(content, identity, participating, compoundGrowth);

  addTag(featureTags, 'compound_growth', compoundGrowth);
  addTag(featureTags, 'traffic_accident_extra', includes(content, /(?:交通工具意外|交通意外|公共交通|航空意外|驾乘意外|自驾车意外)/u));
  addTag(featureTags, 'participating', participating);
  addTag(featureTags, 'disease_grouping', includes(content, /(?:疾病分组|分组给付|分为\d+组|单组给付限额|同组疾病)/u));
  addTag(featureTags, 'children', includes(content, /(?:少儿|儿童|未成年|前10年关爱|前十年关爱)/u));
  addTag(featureTags, 'multi_pay', includes(content, /(?:多次给付|多倍给付|第二次|第三次|再次给付|累计给付限额)/u));
  addTag(featureTags, 'optional_responsibility', includes(content, /(?:可选责任|选择责任|附加责任|可附加)/u));
  addTag(featureTags, 'account_value', includes(content, /(?:账户价值|结算利率|最低保证利率|保单账户|个人账户)/u));
  addTag(featureTags, 'investment_risk', includes(content, /(?:投资风险|投资账户|投资连结|账户单位|单位价格|不保证收益)/u));
  addTag(featureTags, 'long_term_care', category === 'long_term_care');

  return {
    productCategory: category,
    categoryLabel: categoryLabelFor(category, participating),
    featureTags,
    modelTier: modelTierFor(category, content, participating),
  };
}
