import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPolicyOcrVisionContext,
  enhancePolicyScanWithOcrMapping,
  repairPolicyScanDataFromOcrText,
} from '../server/policy-ocr-mapping.mjs';

test('OCR vision context scopes local product candidates by manual insurer hints', () => {
  const context = buildPolicyOcrVisionContext({
    state: {
      policies: [],
      knowledgeRecords: [
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
          productType: '增额终身寿险',
        },
        {
          company: '中国平安保险',
          productName: '平安福重大疾病保险',
          productType: '重疾险',
        },
      ],
    },
    body: {
      uploadItem: { name: 'policy.jpg' },
      manualData: { company: '新华保险', name: '盛世荣耀' },
    },
  });

  assert.deepEqual(context.companyHints, ['新华保险']);
  assert.ok(context.productCandidates.some((item) => item.productName === '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）'));
  assert.equal(context.productCandidates.some((item) => item.company === '中国平安保险'), false);
});

test('OCR vision context switches candidates for non-Xinhua insurer hints', () => {
  const context = buildPolicyOcrVisionContext({
    state: {
      policies: [],
      knowledgeRecords: [
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
          productType: '增额终身寿险',
        },
        {
          company: '中国平安保险',
          productName: '平安福重大疾病保险',
          productType: '重疾险',
        },
        {
          company: '中国人寿',
          productName: '国寿鑫享宝专属商业养老保险',
          productType: '养老年金保险',
        },
      ],
    },
    body: {
      uploadItem: { name: 'policy.jpg' },
      manualData: { company: '中国平安保险', name: '平安福' },
    },
  });

  assert.deepEqual(context.companyHints, ['中国平安保险']);
  assert.ok(context.productCandidates.some((item) => item.productName === '平安福重大疾病保险'));
  assert.equal(context.productCandidates.some((item) => item.company === '新华保险'), false);
  assert.equal(context.productCandidates.some((item) => item.company === '中国人寿'), false);
});

test('OCR mapping derives insured birthday from OCR identity number when scanner data omits it', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      knowledgeRecords: [
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
        },
      ],
    },
    scan: {
      ocrText: [
        'NCI 新华保险',
        '保险单',
        '投保人：冯力',
        '证件号码：330106198712072413',
        '被保险人：冯力',
        '证件号码：330106198712072413',
        '保险利益表',
        '险种名称',
        '畅行万里智赢版 两全保险',
        '交费方式 年交 /10年',
      ].join('\n'),
      data: {
        company: '新华保险',
        name: '畅行万里智赢版两全保险',
        applicant: '冯力',
        insured: '冯力',
        insuredIdNumber: '',
        insuredBirthday: '',
      },
    },
  });

  assert.equal(mapped.data.insuredIdNumber, '330106198712072413');
  assert.equal(mapped.data.insuredBirthday, '1987-12-07');
});

test('OCR mapping infers insurer and matched products from recognized plan names', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '两全保险',
        },
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司i他男性特定疾病保险',
          productType: '重疾险',
        },
      ],
    },
    scan: {
      ocrText: [
        '保险单',
        '投保人：冯力',
        '险种名称 基本保险金额 保险期间 交费方式 保险费',
        '畅行万里智赢版 两全保险 60000.00元 至2068年9月30日零时 年交 /10年 每年3156.00元',
        'i他男性特定疾病 保险 50000.00元 至2025年09月29日 一次交清 140.00元',
      ].join('\n'),
      data: {
        company: '',
        name: '畅行万里智赢版两全保险',
        plans: [
          {
            role: 'main',
            name: '畅行万里智赢版两全保险',
            amount: '60000',
            premium: '3156',
          },
          {
            role: 'rider',
            name: 'i他男性特定疾病保险',
            amount: '50000',
            premium: '140',
          },
        ],
      },
    },
  });

  assert.equal(mapped.data.company, '新华保险');
  assert.equal(mapped.data.name, '新华人寿保险股份有限公司畅行万里智赢版两全保险');
  assert.equal(mapped.data.plans[0].company, '新华保险');
  assert.equal(mapped.data.plans[0].matchedProductName, '新华人寿保险股份有限公司畅行万里智赢版两全保险');
  assert.equal(mapped.data.plans[0].productType, '两全保险');
  assert.equal(mapped.data.plans[1].company, '新华保险');
  assert.equal(mapped.data.plans[1].matchedProductName, '新华人寿保险股份有限公司i他男性特定疾病保险');
  assert.equal(mapped.data.plans[1].productType, '重疾险');
  assert.match(mapped.data.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(mapped.data.canonicalProductId, mapped.data.plans[0].canonicalProductId);
  assert.match(mapped.data.plans[0].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.match(mapped.data.plans[1].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.notEqual(mapped.data.plans[0].canonicalProductId, mapped.data.plans[1].canonicalProductId);
});

test('OCR mapping does not infer insurer from short company alias inside product name', () => {
  const state = {
    policies: [],
    officialDomainProfiles: [],
    knowledgeRecords: [
      {
        company: '阳光人寿',
        productName: '阳光人寿金色阳光888少儿两全保险（分红型）',
        productType: '两全保险',
      },
      {
        company: '阳光人寿',
        productName: '阳光人寿金娃娃少儿两全保险B款（万能型）',
        productType: '两全保险',
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司福如东海A款终身寿险（分红型）',
        productType: '终身寿险',
      },
    ],
  };

  const mapped = enhancePolicyScanWithOcrMapping({
    state,
    scan: {
      ocrText: [
        '保险单',
        '险种名称:成长阳光少儿两全保险（A款）（分红型）',
        '基本保险金额:38760.00元',
        '保险费:每年5475.00元',
      ].join('\n'),
      data: {
        company: '',
        name: '成长阳光少儿两全保险（A款）（分红型）',
        plans: [
          {
            role: 'main',
            name: '成长阳光少儿两全保险（A款）（分红型）',
            amount: '38760',
            premium: '5475',
          },
        ],
      },
    },
  });

  assert.equal(mapped.data.company, '');
  assert.equal(mapped.data.plans[0].company, '');
  assert.equal(mapped.data.name, '成长阳光少儿两全保险（A款）（分红型）');
  assert.equal(mapped.data.plans[0].matchedProductName, '');
});

test('OCR mapping accepts short company alias when it appears in header company context', () => {
  const state = {
    policies: [],
    officialDomainProfiles: [],
    knowledgeRecords: [
      {
        company: '阳光人寿',
        productName: '阳光人寿金色阳光888少儿两全保险（分红型）',
        productType: '两全保险',
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司福如东海A款终身寿险（分红型）',
        productType: '终身寿险',
      },
    ],
  };

  const mapped = enhancePolicyScanWithOcrMapping({
    state,
    scan: {
      ocrText: [
        'NCI新华保险',
        '保险单',
        '险种名称:成长阳光少儿两全保险（A款）（分红型）',
        '基本保险金额:38760.00元',
        '保险费:每年5475.00元',
      ].join('\n'),
      data: {
        company: '',
        name: '成长阳光少儿两全保险（A款）（分红型）',
        plans: [
          {
            role: 'main',
            name: '成长阳光少儿两全保险（A款）（分红型）',
            amount: '38760',
            premium: '5475',
          },
        ],
      },
    },
  });

  assert.equal(mapped.data.company, '新华保险');
  assert.equal(mapped.data.plans[0].company, '新华保险');
  assert.equal(mapped.data.name, '成长阳光少儿两全保险（A款）（分红型）');
  assert.equal(mapped.data.plans[0].matchedProductName, '');
});

test('OCR mapping promotes official inline main plan before riders and removes optional responsibility rows', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司福如东海A款终身寿险（分红型）',
          productType: '终身寿险',
        },
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司附加安康提前给付重大疾病保险',
          productType: '重疾险',
        },
      ],
    },
    scan: {
      ocrText: [
        'NCI新华保险',
        '险种名称:福如东海A款终身寿险（分红型）',
        '保险费:每年5220.00元',
        '险种名称:附加安康提前给付重大疾病保险',
        '保险金额:60000.00元',
        '可选责任的约定:癌症特别关爱金',
        '保险费:每年1620.00元',
        '保险费合计:（大写）陆仟捌佰肆拾元整',
        '¥6840.00',
      ].join('\n'),
      data: {
        company: '',
        name: '附加安康提前给付重大疾病保险',
        firstPremium: '6840',
        plans: [
          {
            role: 'rider',
            name: '附加安康提前给付重大疾病保险',
            amount: '60000',
            premium: '1620',
          },
          {
            role: 'rider',
            name: '可选责任的约定:癌症特别关爱金',
          },
          {
            role: 'rider',
            name: '福如东海A款终身寿险（分红型）',
            premium: '5220',
          },
        ],
      },
    },
  });

  assert.equal(mapped.data.company, '新华保险');
  assert.equal(mapped.data.name, '新华人寿保险股份有限公司福如东海A款终身寿险（分红型）');
  assert.equal(mapped.data.firstPremium, '6840');
  assert.deepEqual(
    mapped.data.plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      matchedProductName: plan.matchedProductName,
      amount: plan.amount,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '福如东海A款终身寿险（分红型）',
        matchedProductName: '新华人寿保险股份有限公司福如东海A款终身寿险（分红型）',
        amount: '',
        premium: '5220',
      },
      {
        role: 'rider',
        name: '附加安康提前给付重大疾病保险',
        matchedProductName: '新华人寿保险股份有限公司附加安康提前给付重大疾病保险',
        amount: '60000',
        premium: '1620',
      },
    ],
  );
});

test('OCR mapping repairs OCR-garbled main plan from official product mention without duplicating it as rider', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          company: '新华保险',
          productName: '福如东海A款终身寿险（分红型）',
          productType: '寿险',
        },
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司住院费用医疗保险（2007）',
          productType: '医疗险',
        },
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司附加安康提前给付重大疾病保险',
          productType: '重疾险',
        },
      ],
    },
    scan: {
      ocrText: [
        'NCI新华保险',
        '酸种名称:福如东海A救终具寿险（分红提）',
        '基本保险金额:100000.00元',
        '保险费:每年3000.00元',
        '险种名称:',
        '住院费用医疗保险（2007）',
        '保险金额:',
        '10000.00元',
        '保险费:234.00元',
        '险种名称:附加安康提前给付重大疾病保险',
        '保险金额:100000.00元',
        '保险费:每年1100.00元',
        '保险费合计:（大写）肆仟叁佰叁拾肆元整',
        '可选责任的约定:癌症特别关爱金',
        '保险期间:2014年01月01日零时起至被保险人终身',
        '交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日',
        '￥4334.00',
        '特别约定:',
        '本保险单的险种《福如东海A款终身寿险（分红型）》的效力因发生保险责任、责任免除、合同解除等事项终止时，险种《住院费用医疗保险（2007）》的效力终止。',
        '本保险单的附加险种《附加安康提前给付重大疾病保险》仅为险种《福如东海A款终身寿险（分红型）》的附加险。',
      ].join('\n'),
      data: {
        company: '新华保险',
        name: '福如东海A救终具寿险（分红提）',
        firstPremium: '4334',
        plans: [
          {
            role: 'main',
            name: '福如东海A救终具寿险（分红提）',
            amount: '100000',
            premium: '3000',
          },
          {
            role: 'rider',
            name: '住院费用医疗保险（2007）',
            amount: '10000',
            premium: '234',
          },
          {
            role: 'rider',
            name: '附加安康提前给付重大疾病保险',
            amount: '100000',
            premium: '1100',
          },
        ],
      },
      fieldEvidence: {
        coveragePeriod: {
          value: '至2014年12月31日',
          rowText: '保险期间:2014年01月01日零时起至2014年12月31日二十四时止',
        },
        firstPremium: {
          value: '4334',
          rowText: '￥4334.00',
        },
      },
      fieldConfidence: {
        coveragePeriod: 'text-high',
        firstPremium: 'text-high',
      },
    },
  });

  assert.equal(mapped.data.name, '福如东海A款终身寿险（分红型）');
  assert.equal(mapped.data.paymentPeriod, '20年交');
  assert.equal(mapped.data.coveragePeriod, '终身');
  assert.equal(mapped.data.firstPremium, '4334');
  assert.equal(mapped.fieldEvidence.coveragePeriod, undefined);
  assert.equal(mapped.fieldEvidence.firstPremium.value, '4334');
  assert.deepEqual(
    mapped.data.plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      matchedProductName: plan.matchedProductName,
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
        name: '福如东海A款终身寿险（分红型）',
        matchedProductName: '福如东海A款终身寿险（分红型）',
        productType: '寿险',
        amount: '100000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '20年交',
        premium: '3000',
      },
      {
        role: 'rider',
        name: '住院费用医疗保险（2007）',
        matchedProductName: '新华人寿保险股份有限公司住院费用医疗保险（2007）',
        productType: '医疗险',
        amount: '10000',
        coveragePeriod: '',
        paymentMode: '',
        paymentPeriod: '',
        premium: '234',
      },
      {
        role: 'rider',
        name: '附加安康提前给付重大疾病保险',
        matchedProductName: '新华人寿保险股份有限公司附加安康提前给付重大疾病保险',
        productType: '重疾险',
        amount: '100000',
        coveragePeriod: '',
        paymentMode: '',
        paymentPeriod: '',
        premium: '1100',
      },
    ],
  );
});

test('OCR mapping replaces stale missing plan values with complete OCR text extraction before product matching', () => {
  const state = {
    policies: [],
    officialDomainProfiles: [],
    knowledgeRecords: [
      {
        company: '新华保险',
        productName: '福如东海A款终身寿险（分红型）',
        productType: '寿险',
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司住院费用医疗保险（2007）',
        productType: '医疗险',
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司附加安康提前给付重大疾病保险',
        productType: '重疾险',
      },
    ],
  };
  const ocrText = [
    'NCI新华保险',
    '险种名称:福如东海A款终身寿险（分红型）',
    '基本保险金额:100000.00元',
    '保险期间:2014年01月01日零时起至被保险人终身',
    '保险费:每年3000.00元',
    '交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日',
    '险种名称:住院费用医疗保险（2007）',
    '保险金额:10000.00元',
    '保险期间:2014年01月01日零时起至2014年12月31日二十四时止',
    '保险费:234.00元',
    '交费方式:一次交清',
    '险种名称:附加安康提前给付重大疾病保险可选责任的约定:癌症特别关爱金',
    '保险金额:100000.00元',
    '保险期间:2014年01月01日零时起至被保险人终身',
    '保险费:每年1100.00元',
    '交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日',
    '￥4334.00',
  ].join('\n');
  const staleScan = {
    ocrText,
    data: {
      company: '',
      name: '福如东海A款终身寿险（分红型）',
      firstPremium: '6107',
      plans: [
        {
          role: 'main',
          name: '福如东海A款终身寿险（分红型）',
          amount: '100000',
          premium: '2007',
          premiumText: '险种名称:住院费用医疗保险（2007）',
        },
        {
          role: 'main',
          name: '福如东海A款终身寿险（分红型）',
          amount: '100000',
          premium: '3000',
        },
        {
          role: 'rider',
          name: '住院费用医疗保险（2007）',
          amount: '',
          premium: '',
        },
        {
          role: 'rider',
          name: '附加安康提前给付重大疾病保险',
          amount: '',
          coveragePeriod: '终身',
          paymentPeriod: '20年交',
          premium: '',
        },
        {
          role: 'rider',
          name: '附加安康提前给付重大疾病保险可选责任的约定:癌症特别关爱金',
          amount: '100000',
          premium: '1100',
        },
      ],
    },
  };

  const repaired = repairPolicyScanDataFromOcrText(staleScan);
  assert.equal(repaired.data.plans.length, 3);
  assert.deepEqual(
    repaired.data.plans.map((plan) => ({
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
        amount: '100000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '20年交',
        premium: '3000',
      },
      {
        role: 'rider',
        name: '住院费用医疗保险（2007）',
        amount: '10000',
        coveragePeriod: '至2014年12月31日',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '234',
      },
      {
        role: 'rider',
        name: '附加安康提前给付重大疾病保险可选责任的约定:癌症特别关爱金',
        amount: '100000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '20年交',
        premium: '1100',
      },
    ],
  );

  const mapped = enhancePolicyScanWithOcrMapping({ state, scan: repaired });
  const hospital = mapped.data.plans.find((plan) => plan.name === '住院费用医疗保险（2007）');
  const criticalIllness = mapped.data.plans.find((plan) => plan.name === '附加安康提前给付重大疾病保险');
  assert.equal(mapped.data.company, '新华保险');
  assert.equal(mapped.data.firstPremium, '4334');
  assert.equal(hospital.amount, '10000');
  assert.equal(hospital.premium, '234');
  assert.equal(criticalIllness.amount, '100000');
  assert.equal(criticalIllness.premium, '1100');
});

test('OCR text repair cleans same-line identity labels and corrects insured identity', () => {
  const ocrText = [
    '币值单位:人民币元保险合同号:886622461458',
    '投保人:翟卿身份证:330106198411101516',
    '被保险人:顾晨妍身份证:330184198610271824 性别:男',
    '受益人身份证:330106201311261218 受益顺序受益份额',
    '翟宸彬身份证:330106198411101516 1 50.00％',
    '翟卿 1 50.00％',
    '险种名称:福如东海A款终身寿险（分红型）',
    '基本保险金额:100000.00元保险期间:2014年01月01日零时起至被保险人终身',
    '保险费:每年3000.00元交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日',
    '险种名称:住院费用医疗保险（2007）',
    '保险金额:10000.00元保险期间:2014年01月01日零时起至2014年12月31日二十四时止',
    '保险费:234.00元交费方式:一次交清',
    '险种名称:附加安康提前给付重大疾病保险可选责任的约定:癌症特别关爱金',
    '保险金额:100000.00元保险期间:2014年01月01日零时起至被保险人终身',
    '保险费:每年1100.00元交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日',
    '保险费合计:（大写）肆仟叁佰叁拾肆元整 ¥4334.00',
  ].join('\n');

  const repaired = repairPolicyScanDataFromOcrText({
    ocrText,
    data: {
      applicant: '翟卿身份证',
      insured: '顾晨妍身份证',
      beneficiary: '身份证',
      insuredIdNumber: '330106198411101516',
      insuredBirthday: '1984-11-10',
      plans: [{ name: '住院费用医疗保险（2007）' }],
    },
  });

  assert.equal(repaired.data.applicant, '翟卿');
  assert.equal(repaired.data.insured, '顾晨妍');
  assert.equal(repaired.data.beneficiary, '翟宸彬');
  assert.equal(repaired.data.insuredIdNumber, '330184198610271824');
  assert.equal(repaired.data.insuredBirthday, '1986-10-27');
  assert.equal(repaired.data.plans.length, 3);
  assert.equal(repaired.data.plans[1].amount, '10000');
  assert.equal(repaired.data.plans[1].premium, '234');
});

test('OCR mapping gives similar New China product editions different canonical ids', () => {
  const state = {
    policies: [],
    knowledgeRecords: [
      { company: '新华保险', productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）' },
      { company: '新华保险', productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）' },
      { company: '新华保险', productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（庆典版）' },
    ],
  };
  const xiang = enhancePolicyScanWithOcrMapping({
    state,
    scan: {
      ocrText: '新华保险 多倍保障重大疾病保险（智享版） 基本责任和可选责任',
      data: {
        company: '新华保险',
        name: '多倍保障重大疾病保险（智享版）',
        plans: [{ role: 'main', name: '多倍保障重大疾病保险（智享版）' }],
      },
    },
  });
  const ying = enhancePolicyScanWithOcrMapping({
    state,
    scan: {
      ocrText: '新华保险 多倍保障重大疾病保险（智赢版） 基本责任和可选责任',
      data: {
        company: '新华保险',
        name: '多倍保障重大疾病保险（智赢版）',
        plans: [{ role: 'main', name: '多倍保障重大疾病保险（智赢版）' }],
      },
    },
  });

  assert.equal(xiang.data.name, '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）');
  assert.equal(ying.data.name, '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）');
  assert.match(xiang.data.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.match(ying.data.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.notEqual(xiang.data.canonicalProductId, ying.data.canonicalProductId);
});

test('OCR mapping uses product-adjacent numeric codes to resolve official product variants', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      knowledgeRecords: [
        {
          company: '中国平安',
          productName: '平安尊御人生两全保险（分红型）',
          productType: '两全保险',
          url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=1140&versionNo=1140-1&attachmentType=1',
        },
        {
          company: '中国平安',
          productName: '平安附加聚财宝两全保险（万能型）',
          productType: '万能账户',
          url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=844&versionNo=844-1&attachmentType=1',
        },
        {
          company: '中国平安',
          productName: '平安附加聚财宝两全保险（万能型，2015）',
          productType: '万能账户',
          url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=848&versionNo=848-1&attachmentType=1',
        },
      ],
    },
    scan: {
      ocrText: [
        '中国平安人寿保险股份有限公司',
        '保险项目',
        '投保主险:尊御人生（1140）',
        '附加长险:聚财宝（844）',
      ].join('\n'),
      data: {
        company: '中国平安',
        name: '尊御人生（1140）',
        plans: [
          { role: 'main', name: '尊御人生（1140）' },
          { role: 'linked_account', name: '聚财宝（844）' },
        ],
      },
    },
  });

  assert.equal(mapped.data.name, '平安尊御人生两全保险（分红型）');
  assert.equal(mapped.data.plans[0].matchedProductName, '平安尊御人生两全保险（分红型）');
  assert.equal(mapped.data.plans[0].matchReason, '产品代码 1140');
  assert.equal(mapped.data.plans[0].productCode, '1140');
  assert.equal(mapped.data.plans[1].matchedProductName, '平安附加聚财宝两全保险（万能型）');
  assert.equal(mapped.data.plans[1].matchReason, '产品代码 844');
  assert.equal(mapped.data.plans[1].productCode, '844');
  assert.match(mapped.data.plans[0].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.match(mapped.data.plans[1].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.notEqual(mapped.data.plans[0].canonicalProductId, mapped.data.plans[1].canonicalProductId);
});

test('OCR mapping treats year edition parentheses as product name versions, not product codes', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      knowledgeRecords: [
        {
          company: '中国人寿',
          productName: '国寿鑫颐宝两全保险（2024版）',
          productType: '两全保险',
        },
        {
          company: '中国人寿',
          productName: '国寿鑫颐宝两全保险（2025版）',
          productType: '两全保险',
        },
      ],
    },
    scan: {
      ocrText: '中国人寿 险种名称:国寿鑫颐宝两全保险（2024版） 单证代码:9996',
      data: {
        company: '中国人寿',
        name: '国寿鑫颐宝两全保险（2024版）',
        plans: [
          { role: 'main', name: '国寿鑫颐宝两全保险（2024版）' },
        ],
      },
    },
  });

  assert.equal(mapped.data.name, '国寿鑫颐宝两全保险（2024版）');
  assert.equal(mapped.data.plans[0].matchedProductName, '国寿鑫颐宝两全保险（2024版）');
  assert.equal(mapped.data.plans[0].matchReason, '本地产品名称匹配');
  assert.notEqual(mapped.data.plans[0].matchedProductName, '国寿鑫颐宝两全保险（2025版）');
});

test('OCR mapping does not match clause fragments as rider products from full page text', () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      knowledgeRecords: [
        { company: '新华保险', productName },
      ],
    },
    scan: {
      ocrText: [
        'NCI 新华保险',
        '保险单',
        `险种名称 ${productName}`,
        '备注：《多倍保障重大疾病保险（智享版）》的保险责任包含基本责任和可选责任一。',
        '可选责任一经确定，在本合同保险期间内不得变更。',
      ].join('\n'),
      data: {
        company: '新华保险',
        name: productName,
        plans: [
          { role: 'main', name: productName },
          { role: 'rider', name: '确定，在本合同' },
        ],
      },
    },
  });

  assert.equal(mapped.data.plans.length, 1);
  assert.equal(mapped.data.plans[0].matchedProductName, productName);
  assert.equal(mapped.data.plans.some((plan) => plan.name === '确定，在本合同'), false);
});

test('OCR mapping recovers missing rider plans from official product names in OCR text', () => {
  const mainProductName = '新华人寿保险股份有限公司学生平安意外伤害保险';
  const riderProductName = '新华人寿保险股份有限公司附加学生平安A款疾病住院医疗保险';
  const splitRiderProductName = '新华人寿保险股份有限公司附加学生平安A1款意外伤害医疗保险';
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      knowledgeRecords: [
        {
          company: '新华保险',
          productName: '保险责任名称（接第2页）',
          productType: '寿险',
        },
        {
          company: '新华保险',
          productName: mainProductName,
          productType: '意外险',
        },
        {
          company: '新华保险',
          productName: riderProductName,
          productType: '医疗险',
        },
        {
          company: '新华保险',
          productName: splitRiderProductName,
          productType: '医疗险',
        },
      ],
    },
    scan: {
      ocrText: [
        'NCI 新华保险',
        '保险利益表',
        `险种名称 ${mainProductName}`,
        '意外伤害身故和残疾保险金 80000.00元',
        `险种名称 ${riderProductName}`,
        '疾病住院医疗保险金 800000.00元',
        '保险责任名称（接第2页）',
        '附加学生平安A1款意外伤害医疗保 意外伤害医疗费用保险金 20000.00元',
        '险',
        '保险费合计：￥298.00',
      ].join('\n'),
      data: {
        company: '新华保险',
        name: '学生平安意外伤害保险',
        amount: '80000',
        firstPremium: '298',
        plans: [
          {
            company: '新华保险',
            role: 'main',
            name: '学生平安意外伤害保险',
            amount: '80000',
            premium: '298',
          },
        ],
      },
    },
  });

  assert.equal(mapped.data.plans.length, 3);
  assert.equal(mapped.data.plans[0].role, 'main');
  assert.equal(mapped.data.plans[0].matchedProductName, mainProductName);
  assert.equal(mapped.data.plans[1].role, 'rider');
  assert.equal(mapped.data.plans[1].matchedProductName, riderProductName);
  assert.equal(mapped.data.plans[1].productType, '医疗险');
  assert.match(mapped.data.plans[1].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(mapped.data.plans[2].role, 'rider');
  assert.equal(mapped.data.plans[2].matchedProductName, splitRiderProductName);
  assert.equal(mapped.data.plans.some((plan) => plan.name === '保险责任名称（接第2页）'), false);
});

test('OCR mapping hydrates recovered main plan from top-level scan fields', () => {
  const productName = '平安福耀人生年金保险（分红型）';
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      knowledgeRecords: [
        {
          company: '中国平安',
          productName,
          productType: '年金险',
          official: true,
        },
      ],
    },
    scan: {
      ocrText: 'PINGAN中国平安保单信息平安福耀人生年金保险分红型基本保险金额50万 10年交保障期间终身',
      data: {
        company: '中国平安',
        name: productName,
        amount: '500000',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
      },
    },
  });

  assert.equal(mapped.data.plans.length, 1);
  assert.equal(mapped.data.plans[0].role, 'main');
  assert.equal(mapped.data.plans[0].name, productName);
  assert.equal(mapped.data.plans[0].amount, '500000');
  assert.equal(mapped.data.plans[0].coveragePeriod, '终身');
  assert.equal(mapped.data.plans[0].paymentMode, '年交');
  assert.equal(mapped.data.plans[0].paymentPeriod, '10年交');
  assert.equal(mapped.data.plans[0].premium, '');
});

test('OCR mapping preserves existing plan canonical product id when rematching product name', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      knowledgeRecords: [
        { company: '新华保险', productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险' },
      ],
    },
    scan: {
      ocrText: '新华保险 畅行万里智赢版 两全保险',
      data: {
        company: '新华保险',
        name: '畅行万里智赢版两全保险',
        plans: [
          {
            role: 'main',
            name: '畅行万里智赢版两全保险',
            canonicalProductId: 'product_existing_plan',
          },
        ],
      },
    },
  });

  assert.equal(mapped.data.plans[0].canonicalProductId, 'product_existing_plan');
  assert.equal(mapped.data.canonicalProductId, 'product_existing_plan');
});

test('OCR mapping does not create canonical product id from historical policy-only product names', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      knowledgeRecords: [],
      policies: [
        { company: '新华保险', name: '用户录入的多倍保障重大疾病保险（智享版）' },
      ],
    },
    scan: {
      ocrText: '新华保险 用户录入的多倍保障重大疾病保险（智享版）',
      data: {
        company: '新华保险',
        name: '用户录入的多倍保障重大疾病保险（智享版）',
        plans: [{ role: 'main', name: '用户录入的多倍保障重大疾病保险（智享版）' }],
      },
    },
  });

  assert.equal(mapped.data.canonicalProductId, undefined);
  assert.equal(mapped.data.plans[0].canonicalProductId, '');
});

test('OCR mapping removes satisfied Paddle repair warning fields after final mapping', () => {
  const mapped = enhancePolicyScanWithOcrMapping({
    state: {
      policies: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '两全保险',
        },
      ],
    },
    scan: {
      ocrText: [
        '保险单',
        '设保人:冯力',
        '披保险人:冯力',
        '证件号码:330106198712072413',
        '保险利益表',
        '险种名称',
        '畅行万里智赢版 两全保险',
      ].join('\n'),
      data: {
        company: '',
        name: '畅行万里智赢版两全保险',
        applicant: '冯力',
        insured: '冯力',
        beneficiary: '法定',
        insuredBirthday: '1987-12-07',
        date: '2024-09-30',
        firstPremium: '3000',
        plans: [
          {
            role: 'main',
            name: '畅行万里智赢版两全保险',
          },
        ],
      },
      ocrWarnings: [
        'Ollama 视觉结果缺少：保险公司、投保人、受益人、被保险人、被保险人生日、投保/生效日期、首期保费；已使用 Paddle OCR 补强，仍需确认：保险公司、投保人、被保险人',
      ],
    },
  });

  assert.equal(mapped.data.company, '新华保险');
  assert.deepEqual(mapped.ocrWarnings, []);
});
