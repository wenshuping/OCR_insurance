import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPendingOptionalResponsibilityRepairPlan } from '../scripts/repair-pending-optional-responsibility-indicators.mjs';

const now = '2026-05-31T14:00:00.000Z';

test('pending optional repair quantifies cumulative basic amount limits', () => {
  const plan = buildPendingOptionalResponsibilityRepairPlan({
    now,
    optionalRows: [
      {
        id: 'opt_ankang_middle_medical',
        company: '中华人寿',
        productName: '中华安康团体中端医疗保险',
        liability: '可选责任',
        payload: {
          sourceRecordId: '25792',
          sourceExcerpt: '可选责任为牙科医疗保险金责任和健康检查医疗保险金责任。',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '25792',
        company: '中华人寿',
        productName: '中华安康团体中端医疗保险',
        url: 'https://example.com/ankang-middle-medical.pdf',
        title: '中华安康团体中端医疗保险产品说明',
        payload: {
          pageText: [
            '1.1 保险责任 本合同的保险责任分为必选责任和可选责任。',
            '必选责任为住院及特定门诊医疗保险金责任。',
            '可选责任为牙科医疗保险金责任和健康检查医疗保险金责任。',
            '可选保险责任 牙科医疗保险金 被保险人在其保险期间内，在本公司指定或认可的口腔科医疗机构发生牙科医疗保险责任范围内的费用，本公司依照约定给付牙科医疗保险金。',
            '本公司在保险期间内对每一被保险人累计给付的牙科医疗保险金以该被保险人所对应的该项责任的基本保险金额为限。',
            '本公司向该被保险人累计给付的牙科医疗保险金达到该被保险人所对应的该项责任的基本保险金额时，本公司对该被保险人的牙科医疗保险金责任终止。',
            '健康检查医疗保险金 被保险人在其保险期间内，在本公司指定或认可的健康检查医疗机构发生的健康检查医疗费用，本公司按约定给付健康检查医疗保险金。',
            '本公司在保险期间内对每一被保险人累计给付的健康检查医疗保险金以该被保险人所对应的该项责任的基本保险金额为限。',
            '本公司向该被保险人累计给付的健康检查医疗保险金达到该被保险人所对应的该项责任的基本保险金额时，本公司对该被保险人的健康检查医疗保险金责任终止。',
            '1.2 责任免除',
          ].join('\n'),
        },
      },
    ],
  });

  assert.equal(plan.summary.optionalRecordUpdates, 1);
  const limitIndicators = plan.indicatorUpserts.filter((row) => row.condition === '累计给付上限');
  assert.deepEqual(
    limitIndicators.map((row) => ({
      liability: row.liability,
      value: row.value,
      unit: row.unit,
      basis: row.basis,
      formulaText: row.formulaText,
      sourceRecordId: row.sourceRecordId,
    })),
    [
      {
        liability: '牙科医疗保险金',
        value: 100,
        unit: '%',
        basis: '该被保险人所对应的该项责任的基本保险金额',
        formulaText: '牙科医疗保险金累计给付上限 = 该被保险人所对应的该项责任的基本保险金额',
        sourceRecordId: '25792',
      },
      {
        liability: '健康检查医疗保险金',
        value: 100,
        unit: '%',
        basis: '该被保险人所对应的该项责任的基本保险金额',
        formulaText: '健康检查医疗保险金累计给付上限 = 该被保险人所对应的该项责任的基本保险金额',
        sourceRecordId: '25792',
      },
    ],
  );
});

test('pending optional repair quantifies rescue service expense limits', () => {
  const plan = buildPendingOptionalResponsibilityRepairPlan({
    now,
    optionalRows: [
      {
        id: 'opt_newchina_belt_rescue',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司附加一带一路意外伤害团体医疗保险',
        liability: '可选责任',
        payload: {
          sourceRecordId: '260',
          sourceExcerpt: '可选责任：紧急救援服务保险金',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '260',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司附加一带一路意外伤害团体医疗保险',
        url: 'https://example.com/newchina-belt-road-medical.pdf',
        title: '新华人寿保险股份有限公司附加一带一路意外伤害团体医疗保险',
        payload: {
          pageText: [
            '保险责任 本合同保险责任分为必选责任和可选责任。',
            '2.可选责任：紧急救援服务保险金',
            '本公司对被保险人累计给付的紧急医疗转运费用达到该被保险人约定的紧急医疗转运保险金额时，本公司对该被保险人的该项保险责任终止。',
            '本公司对被保险人累计给付的安排子女回常住地或国籍所在居住地费用达到该被保险人约定的安排子女回常住地或国籍所在居住地保险金额时，本公司对该被保险人的该项保险责任终止。',
            '本公司承担因此发生的灵柩费和运送灵柩的费用。除另有约定外，灵柩费以10,000元人民币为限。',
            '本公司承担火化费用、骨灰运送费用和骨灰盒费用。除另有约定外，骨灰盒费用以6,000元人民币为限。',
            '本公司对被保险人给付的后事处理费用达到该被保险人约定的后事处理保险金额时，本公司对该被保险人的该项保险责任终止。',
          ].join('\n'),
        },
      },
    ],
  });

  assert.equal(plan.summary.optionalRecordUpdates, 1);
  const actual = plan.indicatorUpserts.map((row) => ({
      liability: row.liability,
      value: row.value,
      unit: row.unit,
      basis: row.basis,
      formulaText: row.formulaText,
      condition: row.condition,
      coverageType: row.coverageType,
    })).sort((a, b) => a.liability.localeCompare(b.liability, 'zh-Hans-CN'));
  assert.deepEqual(
    actual,
    [
      {
        liability: '后事处理费用',
        value: 100,
        unit: '%',
        basis: '该被保险人约定的后事处理保险金额',
        formulaText: '后事处理费用累计给付上限 = 该被保险人约定的后事处理保险金额',
        condition: '累计给付上限',
        coverageType: '救援服务',
      },
      {
        liability: '骨灰盒费用上限',
        value: 6000,
        unit: '元',
        basis: '人民币',
        formulaText: '骨灰盒费用上限 = 6000元',
        condition: '费用上限',
        coverageType: '救援服务',
      },
      {
        liability: '紧急医疗转运费用',
        value: 100,
        unit: '%',
        basis: '该被保险人约定的紧急医疗转运保险金额',
        formulaText: '紧急医疗转运费用累计给付上限 = 该被保险人约定的紧急医疗转运保险金额',
        condition: '累计给付上限',
        coverageType: '救援服务',
      },
      {
        liability: '灵柩费上限',
        value: 10000,
        unit: '元',
        basis: '人民币',
        formulaText: '灵柩费上限 = 10000元',
        condition: '费用上限',
        coverageType: '救援服务',
      },
      {
        liability: '安排子女回常住地或国籍所在居住地费用',
        value: 100,
        unit: '%',
        basis: '该被保险人约定的安排子女回常住地或国籍所在居住地保险金额',
        formulaText: '安排子女回常住地或国籍所在居住地费用累计给付上限 = 该被保险人约定的安排子女回常住地或国籍所在居住地保险金额',
        condition: '累计给付上限',
        coverageType: '救援服务',
      },
    ].sort((a, b) => a.liability.localeCompare(b.liability, 'zh-Hans-CN')),
  );
});

test('pending optional repair quantifies optional medical plan table limits and ratios', () => {
  const plan = buildPendingOptionalResponsibilityRepairPlan({
    now,
    optionalRows: [
      {
        id: 'opt_taikang_yuexuan_2024',
        company: '泰康人寿',
        productName: '泰康悦选健康2024医疗保险（费率可调）',
        liability: '可选责任',
        payload: {
          sourceRecordId: '5064',
          sourceExcerpt: '可选责任 恶性肿瘤海外医疗保险金、齿科医疗保险金',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '5064',
        company: '泰康人寿',
        productName: '泰康悦选健康2024医疗保险（费率可调）',
        url: 'https://example.com/taikang-yuexuan-2024.pdf',
        title: '泰康悦选健康2024医疗保险（费率可调）产品说明书',
        payload: {
          pageText: [
            '泰康悦选健康 2024 医疗保险（费率可调）保障表',
            '保险责任 给付限额及给付比例',
            '必选责任',
            '五、紧急费用保险金 全球紧急救援费 年限额 100 万元',
            '六、无理赔住院手术津贴保险金（津贴金额 600 元/日） 以 30 日为限',
            '可选责任',
            '一、恶性肿瘤海外医疗保险金 年限额 300 万元 70％',
            '二、 齿科医疗保险金',
            '保险金年限额 5,000 元',
            '预防齿科医疗费 不设单项最高限额 100％',
            '基础齿科医疗费 不设单项最高限额 80％',
            '复杂齿科医疗费 不设单项最高限额 50％',
            '注：上表各项保险责任以本合同正文描述为准。',
          ].join('\n'),
        },
      },
    ],
  });

  assert.equal(plan.summary.optionalRecordUpdates, 1);
  const actual = plan.indicatorUpserts.map((row) => ({
    liability: row.liability,
    value: row.value,
    unit: row.unit,
    basis: row.basis,
    condition: row.condition,
    coverageType: row.coverageType,
  })).sort((a, b) => `${a.liability}${a.condition}`.localeCompare(`${b.liability}${b.condition}`, 'zh-Hans-CN'));

  assert.deepEqual(
    actual,
    [
      {
        liability: '恶性肿瘤海外医疗保险金',
        value: 70,
        unit: '%',
        basis: '条款载明给付比例',
        condition: '给付比例',
        coverageType: '医疗保障',
      },
      {
        liability: '恶性肿瘤海外医疗保险金',
        value: 3000000,
        unit: '元',
        basis: '条款载明年限额',
        condition: '年限额',
        coverageType: '医疗保障',
      },
      {
        liability: '复杂齿科医疗费',
        value: 50,
        unit: '%',
        basis: '条款载明给付比例',
        condition: '给付比例',
        coverageType: '医疗保障',
      },
      {
        liability: '基础齿科医疗费',
        value: 80,
        unit: '%',
        basis: '条款载明给付比例',
        condition: '给付比例',
        coverageType: '医疗保障',
      },
      {
        liability: '齿科医疗保险金',
        value: 5000,
        unit: '元',
        basis: '条款载明年限额',
        condition: '年限额',
        coverageType: '医疗保障',
      },
      {
        liability: '预防齿科医疗费',
        value: 100,
        unit: '%',
        basis: '条款载明给付比例',
        condition: '给付比例',
        coverageType: '医疗保障',
      },
    ].sort((a, b) => `${a.liability}${a.condition}`.localeCompare(`${b.liability}${b.condition}`, 'zh-Hans-CN')),
  );
});

test('pending optional repair quantifies optional participating annuity responsibilities', () => {
  const plan = buildPendingOptionalResponsibilityRepairPlan({
    now,
    optionalRows: [
      {
        id: 'opt_newchina_rongxiang_annuity',
        company: '新华保险',
        productName: '荣享人生养老年金保险（分红型）',
        liability: '可选责任',
        payload: {
          sourceRecordId: '1333',
          sourceExcerpt: '可选责任 祝寿金 身故或身体全残保险金',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '1333',
        company: '新华保险',
        productName: '荣享人生养老年金保险（分红型）',
        url: 'https://example.com/newchina-rongxiang-annuity.pdf',
        title: '荣享人生养老年金保险（分红型）产品说明书',
        payload: {
          pageText: [
            '合同保险责任分为基本责任和可选责任:',
            '1.基本责任',
            '（5）投保人意外伤害身故或意外伤害身体全残豁免保险费',
            '投保人在保险期间内变更的，本公司不予豁免保险费。',
            '2.可选责任',
            '合同生效后，投保人可以选择本可选责任作为合同项下的保险责任：',
            '（1）祝寿金',
            '被保险人于年满60周岁保单生效对应日生存，本公司按该保单生效对应日可选责任的保险金额给付祝寿金，合同可选责任终止，其他保险责任继续有效。',
            '（2）身故或身体全残保险金',
            '被保险人在领取祝寿金之前身故或身体全残，本公司按以下二者之较大者与可选责任的累积红利保险金额对应的现金价值二者之和给付身故或身体全残保险金，合同可选责任终止。',
            '（1）在该可选责任有效期内本保险实际交纳的可选责任的保险费；',
            '（2）在该可选责任有效期内可选责任的基本保险金额对应的现金价值的1.05倍。',
            '选择可选责任的，须符合本公司相关规定。',
            '3.您享有的其他重要权益',
            '四、保险利益演示 基本责任 可选责任 身故保险金 祝寿金',
          ].join('\n'),
        },
      },
    ],
  });

  assert.equal(plan.summary.optionalRecordUpdates, 1);
  assert.deepEqual(
    plan.indicatorUpserts.map((row) => ({
      liability: row.liability,
      value: row.value,
      unit: row.unit,
      basis: row.basis,
      condition: row.condition,
      coverageType: row.coverageType,
      formulaText: row.formulaText,
    })),
    [
      {
        liability: '祝寿金',
        value: 100,
        unit: '%',
        basis: '该保单生效对应日可选责任的保险金额',
        condition: '年满60周岁保单生效对应日',
        coverageType: '现金流',
        formulaText: '祝寿金 = 该保单生效对应日可选责任的保险金额 × 100%',
      },
      {
        liability: '身故或身体全残保险金',
        value: null,
        unit: '公式',
        basis: '在该可选责任有效期内本保险实际交纳的可选责任的保险费、在该可选责任有效期内可选责任的基本保险金额对应的现金价值、可选责任的累积红利保险金额对应的现金价值',
        condition: '领取祝寿金之前身故或身体全残',
        coverageType: '人寿保障',
        formulaText: '身故或身体全残保险金 = max(在该可选责任有效期内本保险实际交纳的可选责任的保险费, 在该可选责任有效期内可选责任的基本保险金额对应的现金价值 × 1.05倍) + 可选责任的累积红利保险金额对应的现金价值',
      },
    ],
  );
});

test('pending optional repair quantifies equal amount and max optional formulas', () => {
  const plan = buildPendingOptionalResponsibilityRepairPlan({
    now,
    optionalRows: [
      {
        id: 'opt_xintai_holiday_care',
        company: '信泰人寿',
        productName: '信泰景福意外伤害保险A款',
        liability: '可选责任',
        payload: {
          sourceRecordId: '16686',
          sourceExcerpt: '可选责任 法定节假日关爱保险金',
        },
      },
      {
        id: 'opt_cpic_nursing_death',
        company: '太保寿险',
        productName: '太保附加护身福终身护理保险',
        liability: '可选责任',
        payload: {
          sourceRecordId: '8561',
          sourceExcerpt: '可选责任 疾病身故保险金',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '16686',
        company: '信泰人寿',
        productName: '信泰景福意外伤害保险A款',
        url: 'https://example.com/xintai-holiday.pdf',
        title: '信泰景福意外伤害保险A款',
        payload: {
          pageText: [
            '保险责任',
            '可选责任 法定节假日关爱保险金',
            '被保险人在法定节假日以乘客身份乘坐合法商业运营的交通工具期间遭受意外伤害事故，且该意外伤害事故属于本合同基本保险责任所约定的保险事故的，我们按本合同基本责任约定所确定的保险金金额，另行等额给付法定节假日关爱保险金。',
            '责任免除',
          ].join('\n'),
        },
      },
      {
        id: '8561',
        company: '太保寿险',
        productName: '太保附加护身福终身护理保险',
        url: 'https://example.com/cpic-nursing.pdf',
        title: '太保附加护身福终身护理保险',
        payload: {
          pageText: [
            '保险责任',
            '可选责任。疾病身故保险金',
            '若被保险人于达到长期护理保险金的给付条件前因疾病导致身故，本公司按照以下两项中金额较大者给付疾病身故保险金，附加险合同终止：',
            '（1）被保险人身故时根据附加险合同约定已支付的保险费；',
            '（2）被保险人身故时附加险合同的现金价值。',
            '责任免除',
          ].join('\n'),
        },
      },
    ],
  });

  assert.equal(plan.summary.optionalRecordUpdates, 2);
  assert.deepEqual(
    plan.indicatorUpserts.map((row) => ({
      productName: row.productName,
      liability: row.liability,
      value: row.value,
      unit: row.unit,
      basis: row.basis,
      formulaText: row.formulaText,
    })),
    [
      {
        productName: '信泰景福意外伤害保险A款',
        liability: '法定节假日关爱保险金',
        value: 100,
        unit: '%',
        basis: '本合同基本责任约定所确定的保险金金额',
        formulaText: '法定节假日关爱保险金 = 本合同基本责任约定所确定的保险金金额 × 100%',
      },
      {
        productName: '太保附加护身福终身护理保险',
        liability: '疾病身故保险金',
        value: null,
        unit: '公式',
        basis: '被保险人身故时根据附加险合同约定已支付的保险费、被保险人身故时附加险合同的现金价值',
        formulaText: '疾病身故保险金 = max(被保险人身故时根据附加险合同约定已支付的保险费, 被保险人身故时附加险合同的现金价值)',
      },
    ],
  );
});

test('pending optional repair quantifies disability ratio and highest limit formulas', () => {
  const plan = buildPendingOptionalResponsibilityRepairPlan({
    now,
    optionalRows: [
      {
        id: 'opt_ccb_construction_disability',
        company: '建信人寿',
        productName: '建信人寿建筑工程人员团体意外伤害保险B款',
        liability: '可选责任',
        payload: {
          sourceRecordId: '22438',
          sourceExcerpt: '可选责任 意外伤害残疾保险金',
        },
      },
      {
        id: 'opt_aia_global_medical_limit',
        company: '友邦人寿',
        productName: '友邦智选逸生医疗保险',
        liability: '可选责任4',
        payload: {
          sourceRecordId: '11225',
          sourceExcerpt: '可选责任4最高给付限额',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '22438',
        company: '建信人寿',
        productName: '建信人寿建筑工程人员团体意外伤害保险B款',
        url: 'https://example.com/ccb-construction.pdf',
        title: '建信人寿建筑工程人员团体意外伤害保险B款',
        payload: {
          pageText: [
            '保险责任',
            '可选责任：意外伤害残疾保险金',
            '若被保险人自该次意外伤害事故发生之日起180日内因该次事故造成身体伤残的，则我方根据《人身保险伤残评定标准及代码》确定的伤残程度等级，以该被保险人的保险金额为基数，按该伤残程度等级对应的保险金给付比例给付意外伤害残疾保险金。',
            '责任免除',
          ].join('\n'),
        },
      },
      {
        id: '11225',
        company: '友邦人寿',
        productName: '友邦智选逸生医疗保险',
        url: 'https://example.com/aia-global-medical.pdf',
        title: '友邦智选逸生医疗保险',
        payload: {
          pageText: [
            '保险责任',
            '可选责任4的保障区域为除中华人民共和国以外的国家或地区，在保险合同保险期间内，该项保险责任的最高给付限额为400万。',
            '责任免除',
          ].join('\n'),
        },
      },
    ],
  });

  assert.equal(plan.summary.optionalRecordUpdates, 2);
  assert.deepEqual(
    plan.indicatorUpserts.map((row) => ({
      productName: row.productName,
      liability: row.liability,
      value: row.value,
      unit: row.unit,
      basis: row.basis,
      formulaText: row.formulaText,
      condition: row.condition,
    })),
    [
      {
        productName: '建信人寿建筑工程人员团体意外伤害保险B款',
        liability: '意外伤害残疾保险金',
        value: null,
        unit: '公式',
        basis: '该被保险人的保险金额',
        formulaText: '该被保险人的保险金额 × 伤残等级对应给付比例',
        condition: '',
      },
      {
        productName: '友邦智选逸生医疗保险',
        liability: '可选责任4给付限额',
        value: 4000000,
        unit: '元',
        basis: '条款载明最高给付限额',
        formulaText: '可选责任4给付限额 = 4000000元',
        condition: '最高给付限额',
      },
    ],
  );
});

test('pending optional repair extracts multiple named optional disease amount formulas', () => {
  const plan = buildPendingOptionalResponsibilityRepairPlan({
    now,
    optionalRows: [
      {
        id: 'opt_taikang_group_critical',
        company: '泰康人寿',
        productName: '泰康守护A款团体重大疾病保险',
        liability: '可选责任',
        payload: {
          sourceRecordId: '4896',
          sourceExcerpt: '可选保险责任 轻度疾病保险金 中度疾病保险金',
        },
      },
    ],
    knowledgeRows: [
      {
        id: '4896',
        company: '泰康人寿',
        productName: '泰康守护A款团体重大疾病保险',
        url: 'https://example.com/taikang-group-critical.pdf',
        title: '泰康守护A款团体重大疾病保险',
        payload: {
          pageText: [
            '保险责任',
            '可选保险责任 投保人在投保基本保险责任的基础上，可选择可选保险责任中的轻度疾病保险金进行投保，也可同时选择轻度疾病保险金和中度疾病保险金进行投保。',
            '轻度疾病保险金 被保险人在等待期后经医院及专科医生初次确诊罹患本合同所定义的轻度疾病，本公司按本合同项下该被保险人名下的轻度疾病基本保险金额向该被保险人的保险金受益人给付轻度疾病保险金。',
            '中度疾病保险金 被保险人在等待期后经医院及专科医生初次确诊罹患本合同所定义的中度疾病，本公司按本合同项下该被保险人名下的中度疾病基本保险金额向该被保险人的保险金受益人给付中度疾病保险金。',
            '责任免除',
          ].join('\n'),
        },
      },
    ],
  });

  assert.equal(plan.summary.optionalRecordUpdates, 1);
  assert.deepEqual(
    plan.indicatorUpserts.map((row) => ({
      liability: row.liability,
      value: row.value,
      unit: row.unit,
      basis: row.basis,
      formulaText: row.formulaText,
    })),
    [
      {
        liability: '轻度疾病保险金',
        value: 100,
        unit: '%',
        basis: '本合同项下该被保险人名下的轻度疾病基本保险金额',
        formulaText: '轻度疾病保险金 = 本合同项下该被保险人名下的轻度疾病基本保险金额 × 100%',
      },
      {
        liability: '中度疾病保险金',
        value: 100,
        unit: '%',
        basis: '本合同项下该被保险人名下的中度疾病基本保险金额',
        formulaText: '中度疾病保险金 = 本合同项下该被保险人名下的中度疾病基本保险金额 × 100%',
      },
    ],
  );
});
