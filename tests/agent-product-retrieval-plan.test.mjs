import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessProductEvidenceCompleteness,
  createProductRetrievalPlan,
  hasDetailedResponsibilityEvidence,
  validateProductRetrievalPlan,
} from '../server/agent-product-retrieval-plan.service.mjs';

const product = {
  canonicalProductId: 'product_anxin',
  company: '新华保险',
  officialName: '医药安欣（易核版）医疗保险',
};

test('retrieval plan preserves the customer question and adds the verified product context', () => {
  const plan = createProductRetrievalPlan({
    question: '他有什么优势？',
    product,
    queryAspects: ['product_advantages'],
  });

  assert.deepEqual(plan.queries, [
    '他有什么优势？',
    '新华保险《医药安欣（易核版）医疗保险》 他有什么优势？',
  ]);
  assert.match(plan.supplementalQuery, /产品优势 客户价值 适用场景/u);
  assert.equal(validateProductRetrievalPlan(plan, product), true);
});

test('retrieval drift validation rejects a changed canonical product', () => {
  const plan = createProductRetrievalPlan({ question: '有什么优势', product });
  assert.equal(validateProductRetrievalPlan(plan, {
    ...product,
    canonicalProductId: 'product_other',
    officialName: '其他产品',
  }), false);
});

test('completeness requests one material retry for an advantage query and then stops', () => {
  const first = assessProductEvidenceCompleteness({
    queryAspects: ['product_advantages'],
    officialEvidence: [{ content: '一般医疗费用保险金按条款约定给付。' }],
    verifiedSources: [{ verified: true, provenance: 'insurer_official' }],
    retrievalRound: 1,
  });
  assert.deepEqual(first, {
    status: 'incomplete',
    missingEvidence: ['approved_product_material'],
    shouldRetry: true,
  });

  const second = assessProductEvidenceCompleteness({
    queryAspects: ['product_advantages'],
    officialEvidence: [{ content: '一般医疗费用保险金按条款约定给付。' }],
    verifiedSources: [{ verified: true, provenance: 'insurer_official' }],
    retrievalRound: 2,
  });
  assert.equal(second.status, 'complete');
  assert.equal(second.shouldRetry, false);
});

test('completeness requires the requested official fact instead of accepting unrelated evidence', () => {
  const result = assessProductEvidenceCompleteness({
    queryAspects: ['waiting_period'],
    officialEvidence: [{ content: '本产品提供住院医疗费用保障。' }],
    verifiedSources: [{ verified: true, provenance: 'insurer_official' }],
    retrievalRound: 2,
  });
  assert.deepEqual(result.missingEvidence, ['official_waiting_period']);
  assert.equal(result.status, 'partial');
});

test('missing complete responsibilities triggers one official-document retry', () => {
  const first = assessProductEvidenceCompleteness({
    queryAspects: ['main_responsibilities'],
    officialEvidence: [{ content: '计划一承担第2款至第10款保险金责任。' }],
    verifiedSources: [{ verified: true, provenance: 'insurer_official' }],
    retrievalRound: 1,
  });
  assert.deepEqual(first, {
    status: 'incomplete',
    missingEvidence: ['complete_responsibility_summary'],
    shouldRetry: true,
  });

  const second = assessProductEvidenceCompleteness({
    queryAspects: ['main_responsibilities'],
    officialEvidence: [{ content: '一般住院医疗费用保险金和延伸医疗费用保险金按条款约定给付。' }],
    verifiedSources: [{ verified: true, provenance: 'insurer_official' }],
    retrievalRound: 2,
  });
  assert.equal(second.status, 'complete');
  assert.equal(second.shouldRetry, false);
});

test('responsibility evidence validator rejects clause ranges and accepts named responsibility details', () => {
  assert.equal(hasDetailedResponsibilityEvidence('计划一承担第2款至第10款保险金责任。'), false);
  assert.equal(hasDetailedResponsibilityEvidence(
    '2. 一般住院医疗费用保险金。3. 延伸医疗费用保险金。',
  ), true);
});

test('plan comparison skill requires official plan evidence', () => {
  const result = assessProductEvidenceCompleteness({
    queryAspects: ['main_responsibilities'],
    expertPlan: { skills: ['plan_comparison', 'evidence_validation'] },
    officialEvidence: [{ content: '一般住院医疗费用保险金和延伸医疗费用保险金按约定给付。' }],
    verifiedSources: [{ verified: true, provenance: 'insurer_official' }],
    retrievalRound: 1,
  });
  assert.deepEqual(result.missingEvidence, ['official_plan_comparison']);
  assert.equal(result.shouldRetry, true);
});

test('plan comparison rejects a clause-number outline even when semantic aspects are missing', () => {
  const result = assessProductEvidenceCompleteness({
    queryAspects: [],
    expertPlan: { skills: ['plan_comparison', 'official_terms_retrieval', 'evidence_validation'] },
    officialEvidence: [{
      content: '计划一承担第2款至第10款，计划二承担第2款至第9款，计划三承担第2款至第8款。',
    }],
    verifiedSources: [{ verified: true, provenance: 'insurer_official' }],
    retrievalRound: 1,
  });

  assert.deepEqual(result.missingEvidence, ['complete_responsibility_summary']);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.shouldRetry, true);
});

test('responsibility detail rejects a clause-number outline even when semantic aspects are missing', () => {
  const result = assessProductEvidenceCompleteness({
    queryAspects: [],
    expertPlan: {
      skills: ['product_overview', 'responsibility_detail', 'official_terms_retrieval', 'evidence_validation'],
    },
    officialEvidence: [{
      content: '计划一承担第2款至第10款，计划二承担第2款至第9款，计划三承担第2款至第8款。',
    }],
    verifiedSources: [{ verified: true, provenance: 'insurer_official' }],
    retrievalRound: 1,
  });

  assert.deepEqual(result.missingEvidence, ['complete_responsibility_summary']);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.shouldRetry, true);
});
