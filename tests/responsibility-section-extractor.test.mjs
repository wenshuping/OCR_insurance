import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractStructuredResponsibilitySections,
} from '../server/responsibility-section-extractor.mjs';

test('extractStructuredResponsibilitySections ignores inline 第六条 references', () => {
  const pageText = [
    '第一条 合同构成',
    '第五条 保险责任',
    '1.等待期 自合同生效起90日为等待期。',
    '轻度疾病、中度疾病或重度疾病（详见本合同利益条款第六条）。',
    '2.身故保险金 18周岁后按三者较大者给付。',
    '3.豁免保险费 累计给付达到基本保险金额时豁免。',
    '第六条 本合同保障的疾病列表',
    '轻度疾病共40项，中度疾病共20项，重度疾病共130项，所有疾病分为5组。',
    '以下疾病名称及定义如下：',
    '1.轻度疾病定义 长篇定义不应进入概览。',
  ].join('\n');

  const result = extractStructuredResponsibilitySections({
    productCategory: 'critical_illness',
    records: [{ title: '条款', url: 'https://example.test/terms.pdf', pageText }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /身故保险金/u);
  assert.match(result.mainResponsibilityText, /豁免保险费/u);
  assert.doesNotMatch(result.mainResponsibilityText, /疾病列表/u);
  assert.equal(result.sourceUrl, 'https://example.test/terms.pdf');
  assert.equal(result.sourceTitle, '条款');
  assert.equal(result.supplementSections[0].type, 'disease_list_overview');
  assert.match(result.supplementSections[0].text, /轻度疾病共40项/u);
  assert.match(result.supplementSections[0].text, /分为5组/u);
  assert.doesNotMatch(result.supplementSections[0].text, /长篇定义/u);
});

test('extractStructuredResponsibilitySections flags missing responsibility chapter', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'critical_illness',
    records: [{ title: '条款', pageText: '这是产品简介，没有保险责任正文。' }],
  });

  assert.equal(result.quality.status, 'needs_extraction_review');
  assert.equal(result.mainResponsibilityText, '');
  assert.deepEqual(result.quality.warnings, ['responsibility_chapter_missing']);
});

test('extractStructuredResponsibilitySections accepts official bare responsibility title on same line', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'incremental_whole_life',
    records: [{
      title: '官方终身寿险条款',
      pageText: [
        '保险责任 在本合同保险期间内，我们按下列规定承担保险责任： 身故或身体全残保险金',
        '被保险人身故或身体全残时，按已交保险费×给付系数、现金价值、基本保险金额×（1+3%）（n-1）三者最大者给付。',
        '上述给付系数为18-41周岁1.6，41-61周岁1.4，61周岁以上1.2。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /保险责任|身故或身体全残保险金/u);
  assert.match(result.mainResponsibilityText, /1\+3%/u);
  assert.match(result.mainResponsibilityText, /给付系数/u);
});

test('extractStructuredResponsibilitySections accepts official responsibility title before responsibility groups', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'annuity',
    records: [{
      title: '官方分层责任条款',
      pageText: [
        '保险责任 本合同的保险责任分为基本责任和可选责任。',
        '在本合同保险期间内，我们根据您的选择承担下列保险责任：',
        '1.基本责任',
        '关爱金 被保险人于约定保单周年日生存，我们按基本保险金额给付关爱金。',
        '身故保险金 被保险人身故，我们按约定给付身故保险金。',
        '2.可选责任',
        '祝寿金 被保险人于约定年龄生存，我们按约定给付祝寿金。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /基本责任/u);
  assert.match(result.mainResponsibilityText, /可选责任/u);
  assert.match(result.mainResponsibilityText, /关爱金/u);
  assert.match(result.mainResponsibilityText, /祝寿金/u);
});

test('extractStructuredResponsibilitySections accepts spaced official article heading', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'medical',
    records: [{
      title: '官方医疗险条款',
      pageText: [
        '第五条 保险金额',
        '保险责任的保险金额按约定计算。',
        '第 六 条 保险责任',
        '本合同保险责任分为基本责任和可选责任。',
        '在本合同保险期间内，我们根据您的选择按下列规定承担相应保险责任：',
        '（一）等待期 首次投保时设有等待期。',
        '（二）医疗费用保险金 按约定给付医疗费用保险金。',
        '第七条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /第六条 保险责任/u);
  assert.match(result.mainResponsibilityText, /医疗费用保险金/u);
  assert.doesNotMatch(result.mainResponsibilityText, /责任免除/u);
});

test('extractStructuredResponsibilitySections accepts inline responsibility title before selectable duties', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'nursing',
    records: [{
      title: '官方护理险条款',
      pageText: [
        '保险责任 投保人可选择投保一项或多项保险责任。',
        '在本合同保险期间内，本公司根据投保人的选择，按下列规定承担相应保险责任：',
        '1.护理津贴保险金 被保险人达到护理状态，本公司按护理天数给付护理津贴保险金。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /护理津贴保险金/u);
});

test('extractStructuredResponsibilitySections accepts inline responsibility title before numbered duties', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'medical',
    records: [{
      title: '官方专项医疗险条款',
      pageText: [
        '保险责任 1.等待期 自本合同生效之日起30日为等待期。',
        '2.特定医疗保险金 被保险人在等待期后确诊并接受治疗，本公司按约定给付特定医疗保险金。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /等待期/u);
  assert.match(result.mainResponsibilityText, /特定医疗保险金/u);
});

test('extractStructuredResponsibilitySections accepts inline responsibility title before insurance contract period', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'medical',
    records: [{
      title: '官方医疗费用条款',
      pageText: [
        '保险责任 在保险合同保险期间内，被保险人在定点医疗机构诊疗，保险公司可依下列约定承担保险责任：',
        '1.住院医疗保险责任 对合规住院医疗费用按约定给付。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /住院医疗保险责任/u);
});

test('extractStructuredResponsibilitySections accepts glued inline responsibility title', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'annuity',
    records: [{
      title: '官方年金险条款',
      pageText: [
        '保险责任在本合同有效期内，我们承担如下保险责任：',
        '年金 若被保险人在约定保单周年日生存，我们按基本保险金额给付年金。',
        '身故保险金 被保险人身故，我们按现金价值给付身故保险金。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /年金/u);
  assert.match(result.mainResponsibilityText, /身故保险金/u);
});

test('extractStructuredResponsibilitySections does not treat responsibility start date as responsibility chapter', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'endowment',
    records: [{
      title: '官方两全险条款',
      pageText: [
        '第六条 保险责任的开始',
        '本公司对本合同应负的保险责任自投保人缴付首期保险费后开始。',
        '第七条 保险费的缴付',
        '投保人应按约定缴费。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'needs_extraction_review');
  assert.deepEqual(result.quality.warnings, ['responsibility_chapter_missing']);
});

test('extractStructuredResponsibilitySections bounds decimal responsibility chapter', () => {
  const result = extractStructuredResponsibilitySections({
    records: [{
      title: '条款',
      pageText: [
        '2.2 投保范围',
        '2.3 保险责任',
        '在本合同保险期间内，本公司承担身故保险金责任。',
        '2.4 责任免除',
        '因下列情形导致的保险事故，本公司不承担给付责任。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /身故保险金/u);
  assert.doesNotMatch(result.mainResponsibilityText, /责任免除/u);
});

test('extractStructuredResponsibilitySections keeps decimal subclauses inside parent responsibility chapter', () => {
  const result = extractStructuredResponsibilitySections({
    records: [{
      title: '条款',
      pageText: [
        '2.2 投保范围',
        '2.3 保险责任',
        '2.3.1 身故保险金',
        '本公司按约定给付身故保险金。',
        '2.3.2 满期保险金',
        '本公司按约定给付满期保险金。',
        '2.4 责任免除',
        '因下列情形导致的保险事故，本公司不承担给付责任。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /2\.3\.1 身故保险金/u);
  assert.match(result.mainResponsibilityText, /按约定给付身故保险金/u);
  assert.match(result.mainResponsibilityText, /2\.3\.2 满期保险金/u);
  assert.doesNotMatch(result.mainResponsibilityText, /2\.4 责任免除/u);
});

test('extractStructuredResponsibilitySections combines useful text fields after full text', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'critical_illness',
    records: [{
      title: '官方条款',
      source_url: 'https://example.test/full.pdf',
      fullText: [
        '第五条 保险责任',
        '本公司按约定给付重大疾病保险金。',
        '第六条 责任免除',
      ].join('\n'),
      source_excerpt: [
        '第七条 本合同保障的疾病列表',
        '本合同保障重度疾病120项，轻度疾病40项，疾病分为6组。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /重大疾病保险金/u);
  assert.equal(result.sourceUrl, 'https://example.test/full.pdf');
  assert.equal(result.supplementSections[0].type, 'disease_list_overview');
  assert.match(result.supplementSections[0].text, /重度疾病120项/u);
});

test('extractStructuredResponsibilitySections keeps annuity optional responsibility supplement', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'annuity',
    records: [{
      title: '年金条款',
      pageText: [
        '第五条 保险责任',
        '本合同基本责任包括养老年金和身故保险金。',
        '第六条 可选责任',
        '投保人可以选择附加护理年金责任。',
        '第七条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.equal(result.supplementSections[0].type, 'optional_responsibility');
  assert.match(result.supplementSections[0].text, /可选责任/u);
  assert.match(result.supplementSections[0].text, /护理年金/u);
});

test('extractStructuredResponsibilitySections keeps participating dividend supplement', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'participating_life',
    records: [{
      title: '分红险条款',
      pageText: [
        '第五条 保险责任',
        '本公司承担身故保险金责任。',
        '第六条 保单分红',
        '本合同为分红保险，红利分配是不确定的。',
        '累积红利保险金额用于增加保险金额，红利不保证。',
        '第七条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.equal(result.supplementSections[0].type, 'dividend');
  assert.match(result.supplementSections[0].text, /红利分配是不确定/u);
  assert.match(result.supplementSections[0].text, /红利不保证/u);
});

test('extractStructuredResponsibilitySections seed product keeps Xinrongyao formula and traffic extra', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'incremental_whole_life',
    records: [{
      title: '鑫荣耀条款',
      pageText: [
        '第五条 保险责任',
        '身故或身体全残保险金 基本保险金额×(1+3.5%)^(n-1)，其中n为被保险人身故或身体全残时的保单年度数。',
        '特定公共交通工具意外伤害身故或身体全残保险金，额外给付基本保险金额的1.5倍。',
        '第六条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /3\.5%/u);
  assert.match(result.mainResponsibilityText, /基本保险金额×\(1\+3\.5%\)\^\(n-1\)/u);
  assert.match(result.mainResponsibilityText, /特定公共交通工具/u);
  assert.match(result.mainResponsibilityText, /1\.5倍/u);
});

test('extractStructuredResponsibilitySections seed product keeps 尊贵人生 annuity optional and dividend text', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'annuity',
    records: [{
      title: '尊贵人生条款',
      pageText: [
        '第五条 保险责任',
        '关爱年金 生存保险金 身故保险金。',
        '第六条 可选责任',
        '投保人可以选择祝寿金责任。',
        '第七条 保单分红',
        '本合同为分红保险，年度分红以增加保险金额的方式进行分配，红利分配是不确定的，红利不保证。',
        '第八条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /关爱年金/u);
  const optionalSupplement = result.supplementSections.find((section) => section.type === 'optional_responsibility');
  assert.ok(optionalSupplement);
  assert.match(optionalSupplement.text, /可选责任/u);
  assert.match(optionalSupplement.text, /祝寿金/u);
  const dividendSupplement = result.supplementSections.find((section) => section.type === 'dividend');
  assert.ok(dividendSupplement);
  assert.match(dividendSupplement.text, /年度分红/u);
  assert.match(dividendSupplement.text, /红利不保证/u);
});

test('extractStructuredResponsibilitySections keeps universal account rate fee risk supplement', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'universal_life',
    records: [{
      title: '万能险条款',
      pageText: [
        '第五条 保险责任',
        '本公司承担身故保险金责任。',
        '第六条 账户价值',
        '个人账户价值按结算利率累积，最低保证利率为2%。',
        '本公司收取初始费用和保单管理费，投资收益存在风险。',
        '第七条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.equal(result.supplementSections[0].type, 'account_value');
  assert.match(result.supplementSections[0].text, /账户价值/u);
  assert.match(result.supplementSections[0].text, /结算利率/u);
  assert.match(result.supplementSections[0].text, /费用/u);
  assert.match(result.supplementSections[0].text, /风险/u);
});

test('extractStructuredResponsibilitySections supports inline loose responsibility clause', () => {
  const result = extractStructuredResponsibilitySections({
    records: [{
      title: '产品简介',
      pageText: '产品简介。保险责任：本公司承担身故保险金责任。责任免除：既往症不承担责任。',
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /身故保险金/u);
  assert.doesNotMatch(result.mainResponsibilityText, /既往症/u);
});

test('extractStructuredResponsibilitySections rejects prose references to article responsibility', () => {
  const result = extractStructuredResponsibilitySections({
    records: [{
      pageText: '产品简介。本产品保障详见本合同第五条保险责任约定，具体以条款为准。',
    }],
  });

  assert.equal(result.quality.status, 'needs_extraction_review');
  assert.equal(result.mainResponsibilityText, '');
  assert.deepEqual(result.quality.warnings, ['responsibility_chapter_missing']);
});

test('extractStructuredResponsibilitySections stops at unknown article headings', () => {
  const result = extractStructuredResponsibilitySections({
    records: [{
      pageText: [
        '第五条 保险责任',
        '本公司承担身故保险金责任。',
        '第六条 保险期间',
        '本合同保险期间为终身。',
        '第七条 责任免除',
        '免责内容。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /身故保险金/u);
  assert.doesNotMatch(result.mainResponsibilityText, /保险期间/u);
});

test('extractStructuredResponsibilitySections supports bare and punctuated OCR headings', () => {
  const bare = extractStructuredResponsibilitySections({
    records: [{
      pageText: [
        '保险责任',
        '本公司承担满期保险金责任。',
        '责任免除：免责内容。',
      ].join('\n'),
    }],
  });
  const punctuated = extractStructuredResponsibilitySections({
    records: [{
      pageText: [
        '第六条、保险责任',
        '本公司承担年金给付责任。',
        '第七条：责任免除',
      ].join('\n'),
    }],
  });
  const colon = extractStructuredResponsibilitySections({
    records: [{
      pageText: [
        '第六条：保险责任',
        '本公司承担住院津贴保险金责任。',
        '第七条：责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(bare.quality.status, 'complete');
  assert.match(bare.mainResponsibilityText, /满期保险金/u);
  assert.doesNotMatch(bare.mainResponsibilityText, /免责内容/u);
  assert.equal(punctuated.quality.status, 'complete');
  assert.match(punctuated.mainResponsibilityText, /年金给付/u);
  assert.doesNotMatch(punctuated.mainResponsibilityText, /责任免除/u);
  assert.equal(colon.quality.status, 'complete');
  assert.match(colon.mainResponsibilityText, /住院津贴保险金/u);
  assert.doesNotMatch(colon.mainResponsibilityText, /责任免除/u);
});

test('extractStructuredResponsibilitySections combines separate universal fee and risk chapters', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'investment_linked',
    records: [{
      pageText: [
        '第五条 保险责任',
        '本公司承担身故保险金责任。',
        '第六条 账户价值',
        '投资账户价值按资产评估结果计算。',
        '第七条 结算利率',
        '本产品不承诺最低保证利率。',
        '第八条 费用',
        '本公司收取初始费用、保单管理费和退保费用。',
        '第九条 投资风险',
        '投资账户收益存在波动风险，投保人承担投资风险。',
        '第十条 责任免除',
      ].join('\n'),
    }],
  });

  const accountSupplement = result.supplementSections.find((section) => section.type === 'account_value');
  assert.ok(accountSupplement);
  assert.match(accountSupplement.text, /账户价值/u);
  assert.match(accountSupplement.text, /结算利率/u);
  assert.match(accountSupplement.text, /初始费用/u);
  assert.match(accountSupplement.text, /投资风险/u);
});

test('extractStructuredResponsibilitySections skips annuity optional supplement without optional sections', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'annuity',
    records: [{
      pageText: [
        '第五条 保险责任',
        '本合同基本责任包括养老年金和身故保险金。',
        '第六条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.equal(result.supplementSections.some((section) => section.type === 'optional_responsibility'), false);
});

test('extractStructuredResponsibilitySections returns deterministic source digest', () => {
  const input = {
    productCategory: 'participating_life',
    records: [{
      title: '分红险条款',
      url: 'https://example.test/terms.pdf',
      pageText: [
        '第五条 保险责任',
        '本公司承担身故保险金责任。',
        '第六条 保单分红',
        '红利分配是不确定的，红利不保证。',
      ].join('\n'),
    }],
  };

  const first = extractStructuredResponsibilitySections(input);
  const second = extractStructuredResponsibilitySections(input);

  assert.equal(first.sourceSectionsDigest, second.sourceSectionsDigest);
});
