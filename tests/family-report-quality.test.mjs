import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateFamilyReportQualityIssues,
  isFamilyReportQualityConfigured,
} from '../server/family-report-quality.service.mjs';

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
