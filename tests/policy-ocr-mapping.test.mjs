import assert from 'node:assert/strict';
import test from 'node:test';

import { enhancePolicyScanWithOcrMapping } from '../server/policy-ocr-mapping.mjs';

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
        },
        {
          company: '新华保险',
          productName: '新华人寿保险股份有限公司i他男性特定疾病保险',
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
  assert.equal(mapped.data.plans[1].company, '新华保险');
  assert.equal(mapped.data.plans[1].matchedProductName, '新华人寿保险股份有限公司i他男性特定疾病保险');
  assert.match(mapped.data.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(mapped.data.canonicalProductId, mapped.data.plans[0].canonicalProductId);
  assert.match(mapped.data.plans[0].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.match(mapped.data.plans[1].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.notEqual(mapped.data.plans[0].canonicalProductId, mapped.data.plans[1].canonicalProductId);
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
