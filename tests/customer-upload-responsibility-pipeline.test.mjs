import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPublishedCustomerUploadResponsibilityRows,
  parseCustomerUploadResponsibilityArtifact,
  validateCustomerUploadResponsibilityArtifact,
} from '../server/customer-upload-responsibility-pipeline.service.mjs';

const pages = [
  {
    pageNumber: 1,
    name: '责任1.jpg',
    ocrText: '保险责任\n轻度疾病保险金：被保险人初次确诊轻度疾病，按基本保险金额的20%给付。',
  },
  {
    pageNumber: 2,
    name: '责任2.jpg',
    ocrText: '可选责任一\n中度疾病保险金：被保险人初次确诊中度疾病，按基本保险金额的50%给付。',
  },
];

function validArtifact() {
  return {
    company: '测试保险',
    productName: '测试重疾保险',
    optionalGroups: [{
      groupId: 'optional_1',
      title: '可选责任一',
      selectionStatus: 'unknown',
      responsibilityIds: ['moderate_disease'],
      sourcePage: '2',
      sourceExcerpt: '可选责任一',
    }],
    responsibilities: [
      {
        responsibilityId: 'mild_disease',
        liability: '轻度疾病保险金',
        selectionStatus: 'included',
        triggerCondition: '被保险人初次确诊轻度疾病',
        insurerObligation: '按基本保险金额的20%给付',
        sourcePage: '1',
        sourceExcerpt: '轻度疾病保险金：被保险人初次确诊轻度疾病，按基本保险金额的20%给付。',
        card: { title: '轻度疾病保险金', customerSummary: '初次确诊轻度疾病可按约定领取保险金。' },
        indicators: [{
          indicatorName: '轻度疾病保险金金额',
          formulaText: '基本保险金额 × 20%',
          basisKey: 'insured_amount',
          calculationStatus: 'display_only',
          sourcePage: '1',
          sourceExcerpt: '按基本保险金额的20%给付',
        }],
      },
      {
        responsibilityId: 'moderate_disease',
        liability: '中度疾病保险金',
        groupId: 'optional_1',
        selectionStatus: 'unknown',
        triggerCondition: '被保险人初次确诊中度疾病',
        insurerObligation: '按基本保险金额的50%给付',
        sourcePage: '2',
        sourceExcerpt: '中度疾病保险金：被保险人初次确诊中度疾病，按基本保险金额的50%给付。',
        card: { title: '中度疾病保险金', customerSummary: '若已选该责任，初次确诊中度疾病可按约定领取保险金。' },
        indicators: [{
          indicatorName: '中度疾病保险金金额',
          formulaText: '基本保险金额 × 50%',
          basisKey: 'insured_amount',
          calculationStatus: 'display_only',
          sourcePage: '2',
          sourceExcerpt: '按基本保险金额的50%给付',
        }],
      },
    ],
  };
}

test('customer OCR responsibility pipeline preserves page evidence and waits for operations review', async () => {
  const result = await parseCustomerUploadResponsibilityArtifact({
    company: '测试保险',
    productName: '测试重疾保险',
    ocrPages: pages,
    generateWithDeepSeek: async () => validArtifact(),
  });

  assert.equal(result.status, 'pending_review');
  assert.equal(result.attempts, 1);
  assert.ok(result.normalizationPasses >= 1 && result.normalizationPasses <= 3);
  assert.equal(result.artifact.sourceMode, 'customer_ocr_upload');
  assert.equal(result.artifact.responsibilities.length, 2);
  assert.deepEqual(validateCustomerUploadResponsibilityArtifact(result.artifact, pages), { ok: true, issues: [] });
});

test('customer OCR responsibility pipeline passes validator issues to a repair attempt', async () => {
  const prompts = [];
  const result = await parseCustomerUploadResponsibilityArtifact({
    company: '测试保险',
    productName: '测试重疾保险',
    ocrPages: pages,
    generateWithDeepSeek: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        const invalid = validArtifact();
        invalid.responsibilities[0].sourceExcerpt = '模型编造的原文';
        return invalid;
      }
      return validArtifact();
    },
  });

  assert.equal(result.status, 'pending_review');
  assert.equal(result.attempts, 2);
  assert.match(prompts[1], /responsibility_evidence_not_exact:mild_disease/u);
});

test('customer OCR responsibility pipeline never auto-publishes after three invalid attempts', async () => {
  const invalid = validArtifact();
  invalid.responsibilities[0].sourceExcerpt = '不存在的责任原文';
  const result = await parseCustomerUploadResponsibilityArtifact({
    company: '测试保险',
    productName: '测试重疾保险',
    ocrPages: pages,
    generateWithDeepSeek: async () => invalid,
  });

  assert.equal(result.status, 'manual_review');
  assert.equal(result.attempts, 3);
  assert.ok(result.validationIssues.some((issue) => issue.startsWith('responsibility_evidence_not_exact:')));
});

test('operations publication builds namespaced cards and indicators without claiming official evidence', async () => {
  const result = await parseCustomerUploadResponsibilityArtifact({
    company: '测试保险',
    productName: '测试重疾保险',
    ocrPages: pages,
    generateWithDeepSeek: async () => validArtifact(),
  });
  const rows = buildPublishedCustomerUploadResponsibilityRows({
    id: 88,
    company: '测试保险',
    productName: '测试重疾保险',
    url: 'customer-policy-terms://knowledge/test',
    responsibilityPipelineStatus: result.status,
    responsibilityArtifact: result.artifact,
  }, '2026-07-22T00:00:00.000Z');

  assert.equal(rows.responsibilityCards.length, 2);
  assert.equal(rows.indicatorRecords.length, 2);
  assert.ok(rows.responsibilityCardIds.every((id) => id.startsWith('customer_upload:88:')));
  assert.equal(rows.responsibilityCards[0].payload.official, false);
  assert.equal(rows.indicatorRecords[0].sourceKind, 'customer_policy_terms');
  assert.equal(rows.indicatorRecords[1].selectionStatus, 'unknown');
});
