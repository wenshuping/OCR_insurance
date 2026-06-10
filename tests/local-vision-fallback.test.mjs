import assert from 'node:assert/strict';
import test from 'node:test';

import {
  maybeEnhancePolicyScanWithLocalVision,
  needsLocalVisionFallback,
} from '../ocr-service/insurance-ocr.service.mjs';

const IMAGE_UPLOAD = {
  name: 'policy.jpg',
  type: 'image/jpeg',
  size: 4,
  dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
};

test('local vision fallback repairs low-confidence benefit-table plans only for images', async () => {
  const lowConfidenceData = {
    company: '新华保险',
    name: '畅行万里智赢版两全保险',
    paymentPeriod: '趸交',
    coveragePeriod: '至2068年9月30日零时',
    amount: '60000',
    firstPremium: '3296',
    plans: [
      {
        role: 'main',
        name: '畅行万里智赢版两全保险',
      },
      {
        role: 'rider',
        name: 'i他男性特定疾病保险',
      },
    ],
  };
  const ocrText = [
    '保险利益表',
    '险种名称',
    '畅行万里智赢版 两全保险',
    'i他男性特定疾病 保险',
    '一次交清',
    '首期保险费合计 ￥3296.00',
  ].join('\n');

  assert.equal(needsLocalVisionFallback(lowConfidenceData, ocrText), true);

  let calls = 0;
  const enhanced = await maybeEnhancePolicyScanWithLocalVision(
    {
      uploadItem: IMAGE_UPLOAD,
      data: lowConfidenceData,
      ocrText,
    },
    async () => {
      calls += 1;
      return {
        data: {
          company: '新华保险',
          name: '畅行万里智赢版两全保险',
          paymentPeriod: '10年交',
          coveragePeriod: '至2068年9月30日零时',
          amount: '60000',
          firstPremium: '3296',
          plans: [
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
        },
        ocrText: '',
      };
    },
    { POLICY_OCR_LOCAL_VISION_FALLBACK: 'true' },
  );

  assert.equal(calls, 1);
  assert.equal(enhanced.data.paymentPeriod, '10年交');
  assert.equal(enhanced.data.plans.length, 2);
  assert.equal(enhanced.data.plans[1].amount, '50000');
  assert.equal(enhanced.data.plans[1].premium, '140');

  const completeData = {
    ...enhanced.data,
    plans: enhanced.data.plans,
  };
  assert.equal(needsLocalVisionFallback(completeData, ocrText), false);

  const skippedPdf = await maybeEnhancePolicyScanWithLocalVision(
    {
      uploadItem: {
        name: 'policy.pdf',
        type: 'application/pdf',
        size: 4,
        dataUrl: 'data:application/pdf;base64,ZmFrZQ==',
      },
      data: lowConfidenceData,
      ocrText,
    },
    async () => {
      throw new Error('local vision should not run for PDFs');
    },
    { POLICY_OCR_LOCAL_VISION_FALLBACK: 'true' },
  );
  assert.equal(skippedPdf.data, lowConfidenceData);
});

test('local vision merge keeps explicit first premium when model plan premiums are noisy', async () => {
  const baseData = {
    company: '新华保险',
    name: '学生平安意外伤害保险',
    paymentPeriod: '趸交',
    coveragePeriod: '至2025年08月15日',
    amount: '80000',
    firstPremium: '298',
    fieldEvidence: {
      firstPremium: {
        rawValue: '保险费合计:（大写）贰佰玖拾捌元整 ¥298.00',
      },
    },
    plans: [
      {
        role: 'main',
        name: '学生平安意外伤害保险',
        amount: '80000',
      },
    ],
  };
  const ocrText = [
    '保险利益表',
    '险种名称',
    '学生平安意外伤害保险',
    '附加学生平安A款定期寿险',
    '保险责任名称',
    '金额/份数',
    '80000.00元',
    '保险费合计:￥298.00',
  ].join('\n');

  const enhanced = await maybeEnhancePolicyScanWithLocalVision(
    {
      uploadItem: IMAGE_UPLOAD,
      data: baseData,
      ocrText,
    },
    async () => ({
      data: {
        company: '新华保险',
        name: '学生平安意外伤害保险',
        paymentPeriod: '趸交',
        coveragePeriod: '至2025年08月15日',
        amount: '80000',
        firstPremium: '80100',
        plans: [
          { role: 'main', name: '学生平安意外伤害保险', amount: '80000', premium: '80000' },
          { role: 'rider', name: '金额/份数', amount: '80000', premium: '80000' },
          { role: 'rider', name: '免赔额赔付比例', premium: '100' },
        ],
      },
      ocrText: '',
    }),
    { POLICY_OCR_LOCAL_VISION_FALLBACK: 'true' },
  );

  assert.equal(enhanced.data.firstPremium, '298');
  assert.equal(enhanced.data.plans.length, 1);
  assert.equal(enhanced.data.plans[0].name, '学生平安意外伤害保险');
});
