import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateFamilyReportQualityIssues,
  isFamilyReportQualityConfigured,
} from '../server/family-report-quality.service.mjs';
import {
  buildFamilyReportPolicyEvidenceQueries,
  collectFamilyReportLlmWikiEvidence,
  generateFamilyReportQualityIssuesWithLlmWikiEvidence,
} from '../server/family-report-rag-quality.service.mjs';

function qualityInputFromRequestBody(body = {}) {
  const userMessage = (Array.isArray(body.messages) ? body.messages : []).find((message) => message?.role === 'user');
  const content = String(userMessage?.content || '');
  const marker = '输入 JSON：\n';
  const markerIndex = content.indexOf(marker);
  assert.notEqual(markerIndex, -1);
  return JSON.parse(content.slice(markerIndex + marker.length));
}

test('family report quality service skips DeepSeek when api key is not configured', async () => {
  assert.equal(isFamilyReportQualityConfigured({}), false);
  let called = false;
  const result = await generateFamilyReportQualityIssues({
    env: {},
    fetchImpl: async () => {
      called = true;
      throw new Error('should not call upstream');
    },
  });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test('family report quality service requests structured DeepSeek issues with redacted names', async () => {
  let requestBody = null;
  const result = await generateFamilyReportQualityIssues({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10 },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '福如东海A款终身寿险（分红型）',
      insuredMemberId: 10,
      insuredMemberName: '张三',
      amount: 60000,
      coverageIndicators: [{ coverageType: '身故', liability: '身故保险金', formulaText: '身故保险金=有效保险金额' }],
      responsibilityCards: [{
        id: 'card_death',
        title: '身故保险金',
        category: '人寿保障',
        calculationStatus: 'claim_contingent',
        cashflowTreatment: 'claim_contingent',
        calculationReason: '',
        sourceUrl: 'https://official.example-life.test/death.pdf',
        sourceTitle: '福如东海条款',
        sourceExcerpt: '身故保险金按有效保险金额给付。',
        indicators: [{
          id: 'ind_death',
          coverageType: '人寿保障',
          liability: '身故保险金',
          basis: '有效保险金额',
          formulaText: '身故保险金=有效保险金额',
          basisKey: 'basic_amount',
          calculationKey: 'basic_amount',
          calculationEligible: true,
          calculationReason: '',
          cashflowTreatment: 'claim_contingent',
          sourceUrl: 'https://official.example-life.test/death.pdf',
          sourceExcerpt: '身故保险金按有效保险金额给付。',
        }],
      }],
    }],
    report: {
      summary: { memberCount: 2, policyCount: 1 },
      criticalIllness: { members: [] },
      accident: { members: [] },
      radar: { members: [] },
    },
    knowledgeRecords: [{
      company: '新华保险',
      productName: '福如东海A款终身寿险（分红型）',
      productType: '终身寿险（分红型）',
      pageText: '本产品为终身寿险（分红型），不是增额终身寿险。',
    }],
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async (_url, options = {}) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          model: 'deepseek-v4-pro',
          choices: [{
            message: {
              content: JSON.stringify({
                issues: [{
                  severity: 'warning',
                  category: 'product_classification',
                  title: '产品类型需复核',
                  detail: '官网条款显示policy_1为终身寿险（分红型），不应直接写成增额终身寿险。',
                  suggestion: '后台修正产品类型标签。',
                  memberRef: 'member_1',
                  policyRef: 'policy_1',
                  dimension: 'wealth',
                  confidence: 0.9,
                }],
                corrections: [{
                  issueIndex: 0,
                  action: 'mark_unquantifiable',
                  targetPath: 'radar.medical.policyAmount',
                  originalValue: 60,
                  correctedValue: null,
                  reason: '住院费用医疗保险为报销型，不应展示为固定保额。',
                  evidence: '条款仅支持按实际费用报销。',
                  memberRef: 'member_1',
                  policyRef: 'policy_1',
                  dimension: 'medical',
                  riskLevel: 'low',
                  confidence: 0.92,
                }],
              }),
            },
          }],
        }),
      };
    },
  });

  assert.equal(requestBody.model, 'deepseek-v4-pro');
  assert.deepEqual(requestBody.thinking, { type: 'enabled' });
  assert.equal(requestBody.response_format.type, 'json_object');
  assert.doesNotMatch(JSON.stringify(requestBody), /张三|李四|张三家庭/u);
  const qualityInput = qualityInputFromRequestBody(requestBody);
  assert.equal(qualityInput.policies[0].responsibilityCards[0].title, '身故保险金');
  assert.equal(qualityInput.policies[0].responsibilityCards[0].category, '人寿保障');
  assert.equal(qualityInput.policies[0].responsibilityCards[0].calculationStatus, 'claim_contingent');
  assert.equal(qualityInput.policies[0].responsibilityCards[0].cashflowTreatment, 'claim_contingent');
  assert.equal(qualityInput.policies[0].responsibilityCards[0].sourceUrl, 'https://official.example-life.test/death.pdf');
  assert.equal(qualityInput.policies[0].responsibilityCards[0].sourceExcerpt, '身故保险金按有效保险金额给付。');
  assert.equal(qualityInput.policies[0].responsibilityCards[0].indicators[0].basisKey, 'basic_amount');
  assert.equal(qualityInput.policies[0].responsibilityCards[0].indicators[0].calculationKey, 'basic_amount');
  assert.equal(qualityInput.policies[0].responsibilityCards[0].indicators[0].calculationEligible, true);
  assert.equal(qualityInput.policies[0].responsibilityCards[0].indicators[0].cashflowTreatment, 'claim_contingent');
  assert.equal(
    qualityInput.officialEvidence[0].indicators.some((indicator) => (
      indicator.liability === '身故保险金'
      && indicator.basisKey === 'basic_amount'
      && indicator.calculationEligible === true
      && indicator.cashflowTreatment === 'claim_contingent'
    )),
    true,
  );
  const issues = result.issues;
  const corrections = result.corrections;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].source, 'deepseek');
  assert.equal(issues[0].memberId, 10);
  assert.equal(issues[0].memberName, '张三');
  assert.equal(issues[0].policyId, 101);
  assert.equal(issues[0].productName, '福如东海A款终身寿险（分红型）');
  assert.equal(issues[0].confidence, 0.9);
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].issueIndex, 0);
  assert.equal(corrections[0].action, 'mark_unquantifiable');
  assert.equal(corrections[0].riskLevel, 'low');
  assert.equal(corrections[0].policyId, 101);
  assert.equal(corrections[0].memberId, 10);
  assert.equal(corrections[0].confidence, 0.92);
});

test('family report RAG service builds policy evidence queries without touching DeepSeek', () => {
  const queries = buildFamilyReportPolicyEvidenceQueries({
    company: '新华保险',
    name: '成长阳光少儿两全保险(A款)（分红型）',
    plans: [{ name: '附加安康提前给付重大疾病保险' }],
  });

  assert.equal(queries.some((item) => item.dimension === 'life' && /身故|全残/u.test(item.query)), true);
  assert.equal(queries.some((item) => item.dimension === 'wealth' && /生存金|满期金|领取/u.test(item.query)), true);
  assert.equal(queries.some((item) => /附加安康提前给付重大疾病保险/u.test(item.query)), true);
});

test('family report RAG service collects LLM Wiki evidence as knowledge records', async () => {
  const requests = [];
  const result = await collectFamilyReportLlmWikiEvidence({
    policies: [{
      id: 101,
      company: '新华保险',
      name: '成长阳光少儿两全保险(A款)（分红型）',
    }],
    env: {
      FAMILY_REPORT_RAG_PROJECT_ID: 'insurance-products',
      FAMILY_REPORT_RAG_TOP_K: '2',
      FAMILY_REPORT_RAG_MAX_QUERIES_PER_POLICY: '1',
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return {
        ok: true,
        text: async () => JSON.stringify({
          results: [{
            path: 'wiki/成长阳光少儿两全保险.md',
            title: '成长阳光少儿两全保险',
            snippet: '身故保险金按有效保险金额三倍给付。',
            content: '身故保险金：18周岁后按有效保险金额的三倍给付。',
            score: 123,
          }],
        }),
      };
    },
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/v1\/projects\/insurance-products\/search/u);
  assert.equal(requests[0].body.includeContent, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.policyEvidence.length, 1);
  assert.equal(result.policyEvidence[0].evidence.length, 1);
  assert.equal(result.knowledgeRecords.length, 1);
  assert.match(result.knowledgeRecords[0].pageText, /LLM Wiki 检索证据/u);
  assert.match(result.knowledgeRecords[0].pageText, /有效保险金额的三倍/u);
});

test('family report RAG DeepSeek method augments quality input with LLM Wiki evidence', async () => {
  const deepseekBodies = [];
  const result = await generateFamilyReportQualityIssuesWithLlmWikiEvidence({
    family: { id: 1, familyName: '张三家庭' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', status: 'active' },
    ],
    policies: [{
      id: 101,
      company: '新华保险',
      name: '成长阳光少儿两全保险(A款)（分红型）',
      insuredMemberId: 10,
      insuredMemberName: '张三',
      amount: 38760,
    }],
    report: {
      summary: { memberCount: 1, policyCount: 1 },
      criticalIllness: { members: [] },
      accident: { members: [] },
      radar: { members: [] },
    },
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
      FAMILY_REPORT_RAG_MAX_QUERIES_PER_POLICY: '1',
    },
    fetchImpl: async (url, options = {}) => {
      const textUrl = String(url);
      if (textUrl.includes('127.0.0.1:19828')) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            results: [{
              path: 'wiki/成长阳光少儿两全保险.md',
              title: '成长阳光少儿两全保险',
              snippet: '身故保险金按有效保险金额三倍给付。',
              content: '身故保险金：18周岁后按有效保险金额的三倍给付。',
              score: 99,
            }],
          }),
        };
      }
      deepseekBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          model: 'deepseek-v4-pro',
          choices: [{
            message: {
              content: JSON.stringify({
                issues: [{
                  severity: 'warning',
                  category: 'amount_calculation',
                  title: '寿险金额需复核',
                  detail: 'LLM Wiki证据显示policy_1存在三倍给付条款。',
                  suggestion: '后台复核寿险参考下限。',
                  memberRef: 'member_1',
                  policyRef: 'policy_1',
                  dimension: 'life',
                  confidence: 0.88,
                }],
                corrections: [],
              }),
            },
          }],
        }),
      };
    },
  });

  assert.equal(deepseekBodies.length, 1);
  assert.match(JSON.stringify(deepseekBodies[0]), /LLM Wiki 检索证据/u);
  assert.match(JSON.stringify(deepseekBodies[0]), /有效保险金额的三倍/u);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].policyId, 101);
  assert.equal(result.issues[0].source, 'deepseek');
});
