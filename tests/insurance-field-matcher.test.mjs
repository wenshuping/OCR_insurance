import assert from 'node:assert/strict';
import test from 'node:test';

import { POLICY_FIELD_SCHEMA } from '../ocr-service/insurance-field-schema.mjs';
import { extractPolicyPlansFromLines, matchPolicyFieldsFromLines } from '../ocr-service/insurance-field-matcher.mjs';
import { isPremiumAmountLine, normalizeAmountText } from '../ocr-service/insurance-field-rules.mjs';

const NEW_CHINA_POLICY_LINES = [
  '心I新华保险',
  '保险单',
  '合同',
  '生效日期:2026年04月01日',
  '投保人:张三',
  '被保险人:张三',
  '保险利益表',
  '险种名称',
  '基本',
  '保险金额/',
  '保险金额',
  '保险期间',
  '交费方式',
  '保险费约定支付日',
  '保险费',
  '/保障计划/份数',
  '/',
  '交费期间（续期',
  '保险费交费日期）',
  '/交费期满日',
  '盛世荣耀臻享版',
  '24441.00元',
  '终身',
  '年交',
  '每年04月01日',
  '每年3000.00元',
  '终身寿险（分红型）',
  '/10年',
  '/2035年04月01日',
  '首期',
  '保险费合计:',
  '￥3000.00',
];

const NOISY_NEW_CHINA_POLICY_LINES = [
  '心I新华保险',
  '保险单',
  '合同',
  '生效日期:2026年04月01日',
  '投保人:张三',
  '被保险人:张三',
  '保险利益表',
  '险种名稼',
  '基本',
  '保险金颔/',
  '保险金颔',
  '保险期问',
  '交费方武',
  '保险费约定支付日',
  '保险费',
  '/保障计划/份数',
  '/',
  '交费期问（续期',
  '保险费交费日期）',
  '/交费期满日',
  '盛世荣耀臻享版',
  '24441.00元',
  '终身',
  '年交',
  '每年04月01日',
  '每年3000.00元',
  '终身寿险（分红型）',
  '/10年',
  '/2035年04月01日',
  '首期',
  '保险费合汁:',
  '￥3000.00',
];

const NOISY_PING_AN_POLICY_LINES = [
  'PING AN 中国平安保险',
  '保险单',
  '合同',
  '生效日期:2026年04月01日',
  '投保人:李四',
  '被保险人:李四',
  '保险利益表',
  '险种名稼',
  '基本',
  '保险金颔/',
  '保险金颔',
  '保险期问',
  '交费方武',
  '保险费约定支付日',
  '保险费',
  '/保障计划/份数',
  '/',
  '交费期问（续期',
  '保险费交费日期）',
  '/交费期满日',
  '平安福',
  '500000.00元',
  '终身',
  '年交',
  '每年04月01日',
  '每年12000.00元',
  '重大疾病保险',
  '/20年',
  '/2045年04月01日',
  '首期',
  '保险费合汁:',
  '￥12000.00',
];

const NEW_CHINA_POLICY_WITH_LINKED_ACCOUNT_LINES = [
  'NCI 新华保险',
  '保险单',
  '个人养老金',
  '保险合同号:990197554618',
  '基本内容',
  '合同成立日期:2025年12月22日',
  '合同生效日期:2025年12月23日',
  '投保人:温舒萍',
  '被保险人:温舒萍',
  '保险利益表',
  '险种名称',
  '基本保险金额/保险金额',
  '/保障计划/份数',
  '保险期间',
  '交费方式',
  '/交费期间',
  '保险费约定支付日',
  '/交费期满日',
  '保险费',
  '盛世恒盈年金保险',
  '（分红型）',
  '1465.20元',
  '至2073年12月22日',
  '年交',
  '/10年',
  '每年12月23日',
  '/2034年12月23日',
  '每年11000.00元',
  '鑫天利卓越版养老年金',
  '保险（万能型）',
  '--',
  '终身',
  '一次交清',
  '--',
  '--',
  '10.00元',
  '首期保险费合计:',
  '￥11010.00',
  '特别约定:',
  '在鑫天利卓越版养老年金保险（万能型）合同有效的情况下',
];

const NEW_CHINA_LINKED_ACCOUNT_MACOS_VISION_LINES = [
  'NCI新华保险',
  '关爱人生每一天',
  '保险单',
  '个人养老金',
  '保险合同号:990197554618',
  '币值单位:人民币元',
  '基本内容',
  '合同成立日期:2025年12月22日',
  '投保人:温舒萍',
  '被保险人:温舒萍',
  '保险利益表',
  '保险期间',
  '险种名称',
  '基本保险金额/保险金额',
  '/保障计划/份数',
  '盛世恒盈年金保险',
  '1465.20元',
  '至2073年12月22日',
  '（分红型）',
  '交费方式',
  '保险费约定支付日',
  '/交费期间（续期保险费交费日期）',
  '/交费期满日',
  '每年12月23日',
  '/2034年12月23日',
  '保险费',
  '鑫天利卓越版养老年金',
  '终身',
  '年交',
  '/10年',
  '一次交清',
  '每年11000.00元',
  '10.00元',
  '保险（万能型）',
  '备注:1.《盛世恒盈年金保险（分红型）》的保险责任包含基本责任，不含可选责任。',
  '2.《鑫天利卓越版养老年金保险（万能型）》领取信息:（1）养老年金领取频率:年领',
  '3.《鑫天利卓越版养老年金保险（万能型）》最低保证利率为年利率1%。',
  '4.《鑫天利卓越版养老年金保险（万能型）》初始费用收取比例:一次交清保险费的1%',
  '首期保险费合计:（大写）壹万壹仟零壹拾元整 ¥11010.00',
  '特别约定:',
];

const NEW_CHINA_RIDER_COLUMN_ORDERED_LINES = [
  'NCI 新华保险',
  '保险单',
  '保险合同号:990171228067',
  '合同成立日期:2024年09月29日',
  '投保人:冯力',
  '被保险人:冯力',
  '保险利益表',
  '险种名称',
  '基本保险金额/保险金额',
  '保险期间',
  '交费方式',
  '/交费期间',
  '保险费约定支付日',
  '/交费期满日',
  '保险费',
  '畅行万里智赢版',
  '两全保险',
  'i他男性特定疾病',
  '保险',
  '60000.00元',
  '50000.00元',
  '至2068年9月30日零时',
  '至2025年09月29日',
  '年交',
  '一次交清',
  '/10年',
  '—',
  '每年09月30日',
  '—',
  '/2033年09月30日',
  '每年3156.00元',
  '140.00元',
  '首期保险费合计:',
  '￥3296.00',
];

const NEW_CHINA_RIDER_VALUE_FIRST_LINES = [
  'NCI 新华保险',
  '保险单',
  '保险合同号:990171228067',
  '合同成立日期:2024年09月29日',
  '投保人:冯力',
  '被保险人:冯力',
  '合同生效日期:2024年09月30日',
  '保险利益表',
  '险种名称',
  '基本保险金额/保险金额',
  '/保障计划/份数',
  '60000.00元',
  '50000.00元',
  '畅行万里智赢版',
  '两全保险',
  'i他男性特定疾病',
  '保险',
  '特别约定:',
  '本栏空白',
  '保险利益表',
  '保险期间',
  '交费方式',
  '保险费约定支付日',
  '/交费期间（续期保险费交费日期）',
  '/交费期满日',
  '至2068年9月30日零时',
  '年交',
  '每年09月30日',
  '/10年',
  '/2033年09月30日',
  '至2025年09月29日一次交清',
  '首期',
  '保险费合计:（大写）叁仟贰佰玖拾陆元整',
  '保险费',
  '每年3156.00元',
  '140.00元',
  '¥3296.00',
  '业务员编号:40364278',
  '服务电话:95567',
];

test('policy field schema defines canonical insurance fields', () => {
  assert.equal(POLICY_FIELD_SCHEMA.name.label, '产品名称');
  assert.equal(POLICY_FIELD_SCHEMA.paymentMode.label, '交费方式');
  assert.equal(POLICY_FIELD_SCHEMA.paymentPeriod.label, '交费期间');
  assert.equal(POLICY_FIELD_SCHEMA.amount.label, '基本保险金额');
  assert.equal(POLICY_FIELD_SCHEMA.firstPremium.label, '首期保险费');
});

test('amount normalization rejects identifier and contact-number noise', () => {
  assert.equal(normalizeAmountText('业务员编号:40364278'), '');
  assert.equal(normalizeAmountText('服务电话:95567'), '');
  assert.equal(isPremiumAmountLine('业务员编号:40364278'), false);
  assert.equal(isPremiumAmountLine('服务电话:95567'), false);
  assert.equal(isPremiumAmountLine('每年3156.00元'), true);
  assert.equal(isPremiumAmountLine('140.00元'), true);
});

test('field matcher scores OCR lines into canonical insurance fields', () => {
  const result = matchPolicyFieldsFromLines(NEW_CHINA_POLICY_LINES, {
    company: '新华保险',
  });

  assert.equal(result.fields.name, '盛世荣耀臻享版终身寿险（分红型）');
  assert.equal(result.fields.coveragePeriod, '终身');
  assert.equal(result.fields.paymentMode, '年交');
  assert.equal(result.fields.paymentPeriod, '10年');
  assert.equal(result.fields.amount, '24441');
  assert.equal(result.fields.firstPremium, '3000');
  assert.ok(result.candidates.name.some((candidate) => candidate.value === '心I新华保险' && candidate.rejected));
});

test('field matcher tolerates noisy OCR labels with fuzzy matching', () => {
  const result = matchPolicyFieldsFromLines(NOISY_NEW_CHINA_POLICY_LINES, {
    company: '新华保险',
  });

  assert.equal(result.fields.name, '盛世荣耀臻享版终身寿险（分红型）');
  assert.equal(result.fields.coveragePeriod, '终身');
  assert.equal(result.fields.paymentMode, '年交');
  assert.equal(result.fields.paymentPeriod, '10年');
  assert.equal(result.fields.amount, '24441');
  assert.equal(result.fields.firstPremium, '3000');
});

test('field matcher handles noisy labels for non-Xinhua insurers', () => {
  const result = matchPolicyFieldsFromLines(NOISY_PING_AN_POLICY_LINES, {
    company: '中国平安保险',
  });

  assert.equal(result.fields.name, '平安福重大疾病保险');
  assert.equal(result.fields.coveragePeriod, '终身');
  assert.equal(result.fields.paymentMode, '年交');
  assert.equal(result.fields.paymentPeriod, '20年');
  assert.equal(result.fields.amount, '500000');
  assert.equal(result.fields.firstPremium, '12000');
  assert.ok(result.candidates.name.some((candidate) => candidate.value === 'PINGAN中国平安保险' && candidate.rejected));
});

test('field matcher extracts main plan and linked universal account from policy benefit table', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_POLICY_WITH_LINKED_ACCOUNT_LINES, {
    company: '新华保险',
  });

  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((plan) => ({
      company: plan.company,
      role: plan.role,
      name: plan.name,
      productType: plan.productType,
      amount: plan.amount,
      coveragePeriod: plan.coveragePeriod,
      paymentMode: plan.paymentMode,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        company: '新华保险',
        role: 'main',
        name: '盛世恒盈年金保险（分红型）',
        productType: '年金险',
        amount: '1465',
        coveragePeriod: '至2073年12月22日',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '11000',
      },
      {
        company: '新华保险',
        role: 'linked_account',
        name: '鑫天利卓越版养老年金保险（万能型）',
        productType: '万能账户',
        amount: '',
        coveragePeriod: '终身',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '10',
      },
    ],
  );
});

test('field matcher repairs macOS Vision unordered benefit-table rows into main and linked plans', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_LINKED_ACCOUNT_MACOS_VISION_LINES, {
    company: '新华保险',
  });

  assert.deepEqual(
    plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      coveragePeriod: plan.coveragePeriod,
      paymentMode: plan.paymentMode,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '盛世恒盈年金保险（分红型）',
        amount: '1465',
        coveragePeriod: '至2073年12月22日',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '11000',
      },
      {
        role: 'linked_account',
        name: '鑫天利卓越版养老年金保险（万能型）',
        amount: '',
        coveragePeriod: '终身',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '10',
      },
    ],
  );
});

test('field matcher reconstructs column-ordered benefit-table riders', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_RIDER_COLUMN_ORDERED_LINES, {
    company: '新华保险',
  });

  assert.deepEqual(
    plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      coveragePeriod: plan.coveragePeriod,
      paymentMode: plan.paymentMode,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '畅行万里智赢版两全保险',
        amount: '60000',
        coveragePeriod: '至2068年9月30日零时',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '3156',
      },
      {
        role: 'rider',
        name: 'i他男性特定疾病保险',
        amount: '50000',
        coveragePeriod: '至2025年09月29日',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '140',
      },
    ],
  );
});

test('field matcher reconstructs value-first benefit-table riders from real image OCR order', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_RIDER_VALUE_FIRST_LINES, {
    company: '新华保险',
  });

  assert.deepEqual(
    plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      coveragePeriod: plan.coveragePeriod,
      paymentMode: plan.paymentMode,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '畅行万里智赢版两全保险',
        amount: '60000',
        coveragePeriod: '至2068年9月30日零时',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '3156',
      },
      {
        role: 'rider',
        name: 'i他男性特定疾病保险',
        amount: '50000',
        coveragePeriod: '至2025年09月29日',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '140',
      },
    ],
  );
});
