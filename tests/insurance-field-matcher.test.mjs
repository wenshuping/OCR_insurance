import assert from 'node:assert/strict';
import test from 'node:test';

import { getPolicyFieldAliases, POLICY_FIELD_SCHEMA } from '../ocr-service/insurance-field-schema.mjs';
import { extractPolicyPlansFromLines, matchPolicyFieldsFromLines } from '../ocr-service/insurance-field-matcher.mjs';

const PING_AN_VL16_INLINE_TABLE_LINES = [
  '中国平安人寿保险股份有限公司',
  '保险项目保险期间交费年限基本保险金额/份数/档次保险费保险对象保险费',
  '投保主险:平安福（1118） 终身 20年 200,000元 3,980.00元',
  '附加险:平安福重疾14（1131） 终身 20年 200,000元 2,240.00元',
  '长期意外13（1120） 34年 20年 200,000元 960.00元',
  '豁免重疾B14（1125） 20年 19年 --- 1,431.05元投保人',
  '附加一年期短险: 意外医疗A（527） 基本保险金额/份数/档次保险费保险对象',
  '意外医疗A（527） 10,000元 78.00元被保险人',
  '健享人生A（521） 2份含可选 390.00元被保险人',
  '首期保险费合计:（年交）人民币玖仟零柒拾玖元零角伍分整（RMB9079.05）',
];

test('PaddleOCR-VL-1.6 Ping An inline table keeps the labeled main plan and all riders', () => {
  const matched = matchPolicyFieldsFromLines(PING_AN_VL16_INLINE_TABLE_LINES, { company: '中国平安保险' });
  const plans = extractPolicyPlansFromLines(PING_AN_VL16_INLINE_TABLE_LINES, { company: '中国平安保险' });

  assert.equal(matched.fields.name, '平安福（1118）');
  assert.equal(plans.length, 6);
  assert.deepEqual(plans.map((plan) => plan.name), [
    '平安福（1118）',
    '平安福重疾14（1131）',
    '长期意外13（1120）',
    '豁免重疾B14（1125）',
    '意外医疗A（527）',
    '健享人生A（521）',
  ]);
  assert.deepEqual(plans[0], {
    company: '中国平安保险',
    role: 'main',
    name: '平安福（1118）',
    productType: plans[0].productType,
    coveragePeriod: '终身',
    paymentMode: '',
    paymentPeriod: '20年',
    amount: '200000',
    premium: '3980',
    premiumText: '3,980.00元',
  });
  assert.equal(plans[3].amount, '');
  assert.equal(plans[3].premium, '1431');
  assert.equal(plans[4].coveragePeriod, '1年');
  assert.equal(plans[4].premium, '78');
});
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

const NEW_CHINA_LINKED_ACCOUNT_REMARK_LINES = [
  'NCI新华保险',
  '保险利益表',
  '险种名称',
  '保险期间',
  '交费方式',
  '基本保险金额/保险金额',
  '保险费约定支付日',
  '保险费',
  '/交费期间（续期保险费交费日期）',
  '/保障计划/份数',
  '/交费期满日',
  '荣耀鑫享赢家版',
  '终身',
  '年交',
  '165020.00元',
  '每年06月07日',
  '每年20000.00元',
  '终身寿险',
  '/10年',
  '/2033年06月07日',
  '金利瑞享终身寿险',
  '终身',
  '一次交清',
  '10.00元',
  '（万能型）',
  '备注:1.',
  '《金利瑞享终身寿险（万能型）》最低保证利率为年利率2%。',
  '2.、《金利瑞享终身寿险（万能型）》初始费用收取比例:一次交清保险费的1%、每笔追加保险费（如',
  '有）的1%、每笔按相关约定转入的保险费（如有）的1%。',
  '首期保险费合计:（大写）贰万零壹拾元整',
  '￥20010.00',
];

const NEW_CHINA_SINGLE_PLAN_VALUE_BEFORE_NAME_LINES = [
  '保险利益表',
  '险种名称',
  '保险期间',
  '保险费',
  '基本保险金额/保险金额',
  '/保障计划/份数',
  '127100.00元',
  '盛世荣耀庆典版',
  '終身寿险（分红型）',
  '终身',
  '交费方式',
  '保险费约定支付日',
  '/交费期间（续期保险费交费日期）',
  '/交费期满日',
  '年交',
  '每年01月01日',
  '/3年',
  '/2028年01月01日',
  '首期保险费合计:（大写）伍万元整',
  '每年50000.00元',
  '¥50000.00',
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

const NEW_CHINA_INLINE_MAIN_RIDER_LINES = [
  'NCI新华保险',
  '保险单',
  '投保人:吴连英',
  '被保险人:吴连英',
  '合同生效日期:2014年01月29日',
  '险种名称:福如东海A款终身寿险（分红型）',
  '保险费:每年5220.00元',
  '保险期间:2014年01月29日零时起至被保险人终身',
  '险种名称:附加安康提前给付重大疾病保险',
  '交费方式:年交交费期间:10年续期保险费交费日期:每年01月29日',
  '保险金额:60000.00元',
  '可选责任的约定:癌症特别关爱金',
  '保险费:每年1620.00元',
  '保险期间:2014年01月29日零时起至被保险人终身',
  '交费方式:年交交费期间:10年',
  '续期保险费交费日期:每年01月29日',
  '保险费合计:（大写）陆仟捌佰肆拾元整',
  '¥6840.00',
  '特别约定:',
];

const NEW_CHINA_INLINE_MEDICAL_RIDER_LINES = [
  'NCI新华保险',
  '币值单位:人民币元保险合同号:886622470947',
  '投保人:翟卿被保险人:翟宸彬',
  '合同成立日期:2013年12月31日合同生效日期:2014年01月01日',
  '险种名称:祥瑞一生终身寿险（分红型）',
  '基本保险金额:100000.00元保险期间:2014年01月01日零时起至被保险人终身',
  '保险费:每年1580.00元交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日',
  '险种名称:住院费用医疗保险（2007）',
  '保险金额:10000.00元保险期间:2014年01月01日零时起至2014年12月31日二十四时止',
  '保险费:330.00元交费方式:一次交清',
  '险种名称:附加祥瑞提前给付重大疾病保险可选责任的约定:癌症特别关爱金',
  '保险金额:100000.00元保险期间:2014年01月01日零时起至被保险人终身',
  '保险费:每年770.00元交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日',
  '保险费合计:（大写）贰仟陆佰捌拾元整¥2680.00',
  '特别约定:',
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

const NEW_CHINA_RIDER_PRE_NAME_VALUE_LINES = [
  'NCI 新华保险',
  '保险单',
  '保险合同号:990171228067',
  '合同成立日期:2024年09月29日',
  '设保人:冯力',
  '披保险人:冯力',
  '保险利益表',
  '险种名称',
  '基本保险金额/保险金额',
  '保险期间',
  '交费方式',
  '保险费约定支付日',
  '保险费',
  '/保障计划/份数',
  '/交费期间（续期保险费交费日期）',
  '/交费期满日',
  '每年09月30日',
  '每年3156.00元',
  '畅行万里智赢版',
  '60000.00元',
  '至2068年9月30日零时',
  '年交',
  '两全保险',
  '/10年',
  '/2033年09月30日',
  '一次交清',
  '140.00元',
  'i他男性特定疾病',
  '50000.00元',
  '至2025年09月29日',
  '保险',
  '（大写）叁仟贰佰玖拾陆元整',
  '￥3296.00',
  '首期保险费合计:',
  '特别约定:',
  '本栏空白',
];

const NEW_CHINA_RECEIPT_PRODUCT_LINES = [
  '保险业务收据',
  'NCI新华保险',
  '开具日期:',
  '2024年09月29日',
  '收款单位:新华人寿保险股份有限公司浙江分公司',
  '投保人名称（付款单位/个人）:冯力',
  '交费日期:2024年09月29日',
  '交费方式:详见各险种显示',
  '保单合同号:990171228067',
  '交费次数:首次',
  '产品名称:畅行万里智赢版两全保险',
  '产品名称:i他男性特定疾病保险',
  '金额 ¥3156.00',
  '金额 ¥140.00',
  '合计（大写）人民币叁仟贰佰玖拾陆元整',
  '服务人员编号:40364278',
  '服务人员姓名:温舒萍',
  '保险业务',
  '收据专用章',
  '收据说明:',
];

const CHINA_LIFE_SINGLE_PLAN_LINES = [
  'MAWAWAVAVAV',
  '单证代码:9996',
  '中国日！',
  '/笛证',
  '保险单',
  '本公司根据保险条款和投保人的申请，签发本保险单',
  '保险资料',
  '（个人养老金）',
  '投保人姓名:翟卿',
  '合同成立日期:2024年12月05日',
  '产品首期保费（元）:12000.00',
  '币种:人民币',
  '主险明细',
  '险种名称:国寿鑫颐宝两全保险（2024版）',
  '保单号:2024330133SCW500032558',
  '保单生效日:2024年12月06日',
  '交费方式:年交',
  '每期交费日:每年的12月06日',
  '险种性质:主险',
  '被保险人姓名:翟卿',
  '保单期满日:2044年12月05日',
  '保险期间:至60周岁',
  '交费期满日:2034年12月05日',
  '交费期间:10年',
  '加费（元）',
  '子险种名称',
  '保险金额(元）',
  '标准保费（元）',
  '国寿鑫颐宝两全保险（2024版）',
  '159948.00',
  '12000.00',
  '身故保险金受益人列表',
  '证件号码',
  '被保险人受益顺序',
  '受益人',
  '性别',
  '出生日期',
  '与被保险人关系受益份额',
  '证件名称',
  '特别约定',
  '无',
];

const CHINA_LIFE_MULTI_SECTION_LINES = [
  '保险资料',
  '产品名称:',
  '投保人姓名:陈家明',
  '合同成立日期:2015年12月31日',
  '产品期文保费:100000.00元/年',
  '■主险明细',
  '险种名称:国寿鑫福年年养老年金保险',
  '保单号:201534240053301511974',
  '披保险人姓名:陈家明',
  '玲种性质:主险',
  '保险期间:4年',
  '文费方式:年交',
  '文费期间:5年',
  '每期文费日:每年的01月01日',
  '子险种名称',
  '保险金额（元）',
  '标准保费（元）',
  '加费（元）',
  '国寿鑫福年年并老年金保险',
  '00192.13',
  '29491.41',
  '险种名称:国寿鑫福年年年金保险',
  '保单号:2015342400534015115980',
  '披保险人姓名:陈家明',
  '检种性质:主险',
  '保险期间:24年',
  '文费方式:年交',
  '文费期间:5年',
  '子险种名称',
  '保险金额（元）',
  '标准保费（元)',
  '加费（元）',
  '国寿鑫招年年年金保险',
  '56621.88',
  '70505.56',
  '险种名称:国寿鑫账户两全保险（万能型）（钻石版）',
  '保单号:2015342423272000380206',
  '技保险人姓名:陈家明',
  '险种性质:主险',
  '保险期问:终身',
  '文费方式:不定期文',
  '文费期间:',
  '子险种名称',
  '保险金额（元）',
  '标准保费（元）',
  '加费（元）',
  '寿鑫账户两全保险（万能型）（钻石版）',
  '10000.00',
  '身故保险金受益人列表',
];

const STUDENT_RESPONSIBILITY_TABLE_LINES = [
  'NCI新华保险',
  '保险单',
  '残疾保险金、意外医疗保险金受益人',
  '被保险人本人',
  '身故保险金受益人',
  '被保险人的法定继承人',
  '保险利益表',
  '险种名称',
  '学生平安意外伤害保险',
  '附加学生平安A款定期寿险',
  '保险责任名称',
  '意外伤害身故和残疾保险金',
  '疾病身故或全残保险金',
  '金额/份数',
  '80000.00元',
  '80000.00元',
  '给付标准',
  '免赔额赔付比例',
  '经社保赔付',
  '未经社保赔付',
  '疾病特定门诊医疗保险金',
  '附加学生平安A1款意外伤害医疗保意外伤害医疗费用保险金',
  '20000.00元',
  '险',
  '保险期间:2024年08月16日零时起至2025年08月15日二十四时止，一年交费方式:一次交清',
  '保险费合计:（大写）贰佰玖拾捌元整',
  '¥298.00',
];

test('policy field schema defines canonical insurance fields', () => {
  assert.equal(POLICY_FIELD_SCHEMA.name.label, '产品名称');
  assert.equal(POLICY_FIELD_SCHEMA.paymentMode.label, '交费方式');
  assert.equal(POLICY_FIELD_SCHEMA.paymentPeriod.label, '交费期间');
  assert.equal(POLICY_FIELD_SCHEMA.amount.label, '基本保险金额');
  assert.equal(POLICY_FIELD_SCHEMA.firstPremium.label, '首期保险费');
});

test('policy field schema includes OCR parser aliases used by field matching', () => {
  assert.ok(getPolicyFieldAliases('applicant').includes('设保人'));
  assert.ok(getPolicyFieldAliases('insured').includes('披保险人'));
  assert.ok(getPolicyFieldAliases('effectiveDate').includes('投保日期'));
  assert.ok(getPolicyFieldAliases('firstPremium').includes('首期保险费合计'));
  assert.ok(getPolicyFieldAliases('amount').includes('基本保险金额/份数/档次'));
  assert.ok(getPolicyFieldAliases('firstPremium').includes('应交保费'));
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
  assert.equal(result.fieldConfidence.name, 'matcher-high');
  assert.equal(result.fieldConfidence.amount, 'matcher');
  assert.equal(result.fieldEvidence.name.source, 'match-policy-ocr-fields');
  assert.equal(result.fieldEvidence.name.relation, 'benefit-table-combined');
  assert.match(result.fieldEvidence.amount.rowText, /24441\.00元/u);
  assert.match(result.fieldEvidence.firstPremium.rowText, /每年3000\.00元/u);
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

test('field matcher maps app policy summary columns by meaning', () => {
  const plans = extractPolicyPlansFromLines([
    '保单详情',
    '保单生效日期 2017-09-22',
    '险种信息',
    '险种名称标准保费基本保额交费期间保险期间',
    '915 附加随意领年金保险（万能型） 0.00 元 0.00 元一次交清终身',
    '694 V2.5 美利金生终身年金保险（分红型） 40,320.00 元 30000.00 元 10 年终身',
    '847 附加住院安心医疗保险（费率可调） 263.00 元 10000.00 元一次交清 1 年',
    '投保人详细信息',
  ], {
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
        role: 'linked_account',
        name: '附加随意领年金保险（万能型）',
        amount: '0',
        coveragePeriod: '终身',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '0',
      },
      {
        role: 'main',
        name: '美利金生终身年金保险（分红型）',
        amount: '30000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '40320',
      },
      {
        role: 'rider',
        name: '附加住院安心医疗保险（费率可调）',
        amount: '10000',
        coveragePeriod: '1年',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '263',
      },
    ],
  );
});

test('field matcher maps app policy summary rows split across OCR lines', () => {
  const plans = extractPolicyPlansFromLines([
    '保单详情',
    '保单生效日期 2017-09-22',
    '险种信息',
    '险种名称',
    '标准保费',
    '基本保额',
    '交费期间',
    '保险期间',
    '915 附加随意',
    '领年金保险',
    '（万能型）',
    '0.00元',
    '0.00元',
    '一次交',
    '清',
    '终身',
    '694 V2.5 美利',
    '金生终身年金',
    '保险（分红',
    '型）',
    '40,32',
    '0.00元',
    '3000',
    '0.00元',
    '10年',
    '终身',
    '847 附加住院',
    '安心医疗保险',
    '（费率可调）',
    '263.0',
    '0元',
    '10000.',
    '00元',
    '一次交清',
    '1年',
    '投保人详细信息',
  ], {
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
        role: 'linked_account',
        name: '附加随意领年金保险（万能型）',
        amount: '0',
        coveragePeriod: '终身',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '0',
      },
      {
        role: 'main',
        name: '美利金生终身年金保险（分红型）',
        amount: '30000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '40320',
      },
      {
        role: 'rider',
        name: '附加住院安心医疗保险（费率可调）',
        amount: '10000',
        coveragePeriod: '1年',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '263',
      },
    ],
  );
});

test('field matcher stops linked-account benefit table before remark product mentions', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_LINKED_ACCOUNT_REMARK_LINES, {
    company: '新华保险',
  });

  assert.deepEqual(
    plans.map((plan) => ({
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
        role: 'main',
        name: '荣耀鑫享赢家版终身寿险',
        productType: '增额终身寿险',
        amount: '165020',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '20000',
      },
      {
        role: 'linked_account',
        name: '金利瑞享终身寿险（万能型）',
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

test('field matcher hydrates single plan amount when value appears before split name', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_SINGLE_PLAN_VALUE_BEFORE_NAME_LINES, {
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
        name: '盛世荣耀庆典版终身寿险（分红型）',
        amount: '127100',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '3年交',
        premium: '50000',
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

test('field matcher keeps inline main plan before rider and skips optional responsibility clauses', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_INLINE_MAIN_RIDER_LINES, {
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
        name: '福如东海A款终身寿险（分红型）',
        amount: '',
        coveragePeriod: '终身',
        paymentMode: '',
        paymentPeriod: '',
        premium: '5220',
      },
      {
        role: 'rider',
        name: '附加安康提前给付重大疾病保险',
        amount: '60000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '1620',
      },
    ],
  );
  assert.ok(!plans.some((plan) => /可选责任|基本责任/u.test(plan.name || '')));
});

test('field matcher splits inline labeled rider name before parenthetical year and mixed amount period line', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_INLINE_MEDICAL_RIDER_LINES, {
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
        name: '祥瑞一生终身寿险（分红型）',
        amount: '100000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '20年交',
        premium: '1580',
      },
      {
        role: 'rider',
        name: '住院费用医疗保险（2007）',
        amount: '10000',
        coveragePeriod: '至2014年12月31日',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '330',
      },
      {
        role: 'rider',
        name: '附加祥瑞提前给付重大疾病保险可选责任的约定:癌症特别关爱金',
        amount: '100000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '20年交',
        premium: '770',
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

test('field matcher reconstructs riders when rider payment values appear before rider name', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_RIDER_PRE_NAME_VALUE_LINES, {
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

test('field matcher pairs receipt product names with following amount rows', () => {
  const plans = extractPolicyPlansFromLines(NEW_CHINA_RECEIPT_PRODUCT_LINES, {
    company: '新华保险',
  });

  assert.deepEqual(
    plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      premium: plan.premium,
      premiumText: plan.premiumText,
    })),
    [
      {
        role: 'main',
        name: '畅行万里智赢版两全保险',
        premium: '3156',
        premiumText: '金额¥3156.00',
      },
      {
        role: 'rider',
        name: 'i他男性特定疾病保险',
        premium: '140',
        premiumText: '金额¥140.00',
      },
    ],
  );
});

test('field matcher ignores China Life metadata rows inside a single-plan section', () => {
  const plans = extractPolicyPlansFromLines(CHINA_LIFE_SINGLE_PLAN_LINES, {
    company: '中国人寿',
  });

  assert.deepEqual(
    plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '国寿鑫颐宝两全保险（2024版）',
        amount: '159948',
        paymentPeriod: '10年交',
        premium: '12000',
      },
    ],
  );

  const fields = matchPolicyFieldsFromLines(CHINA_LIFE_SINGLE_PLAN_LINES, {
    company: '中国人寿',
  });
  assert.equal(fields.fields.name, '国寿鑫颐宝两全保险（2024版）');
  assert.equal(fields.fields.coveragePeriod, '至60岁');
});

test('field matcher rebuilds China Life multi-section plans without metadata rows', () => {
  const plans = extractPolicyPlansFromLines(CHINA_LIFE_MULTI_SECTION_LINES, {
    company: '中国人寿',
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
        name: '国寿鑫福年年养老年金保险',
        amount: '192',
        coveragePeriod: '4年',
        paymentMode: '年交',
        paymentPeriod: '5年交',
        premium: '29491',
      },
      {
        role: 'rider',
        name: '国寿鑫福年年年金保险',
        amount: '56622',
        coveragePeriod: '24年',
        paymentMode: '年交',
        paymentPeriod: '5年交',
        premium: '70506',
      },
      {
        role: 'linked_account',
        name: '国寿鑫账户两全保险（万能型）（钻石版）',
        amount: '10000',
        coveragePeriod: '终身',
        paymentMode: '不定期交',
        paymentPeriod: '不定期交',
        premium: '',
      },
    ],
  );
});

test('field matcher keeps responsibility-table details out of policy plans', () => {
  const plans = extractPolicyPlansFromLines(STUDENT_RESPONSIBILITY_TABLE_LINES, {
    company: '新华保险',
  });

  const planNames = plans.map((plan) => plan.name);
  assert.ok(planNames.includes('学生平安意外伤害保险'));
  assert.ok(planNames.includes('附加学生平安A款定期寿险'));
  assert.ok(!planNames.some((name) => /保险责任名称|金额\/份数|给付标准|免赔额|赔付比例|社保赔付/u.test(name)));
  assert.ok(!plans.some((plan) => ['80000', '100'].includes(String(plan.premium || ''))));
});
