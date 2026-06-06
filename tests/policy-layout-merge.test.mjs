import assert from 'node:assert/strict';
import test from 'node:test';

import { mergePolicyLayoutScanResult } from '../ocr-service/policy-layout-merge.mjs';

test('mergePolicyLayoutScanResult lets high-confidence layout core fields override rider-contaminated text fields', () => {
  const merged = mergePolicyLayoutScanResult({
    textData: {
      company: '新华保险',
      name: '附加住院医疗保险',
      applicant: '附加投保人豁免保险',
      insured: '李四',
      date: '2026-12-23',
    },
    layoutResult: {
      fields: {
        company: '新华保险',
        name: '主险终身寿险',
        applicant: '张三',
        insured: '李四',
        policyNumber: '990123456789',
        date: '2025-12-23',
      },
      fieldConfidence: {
        applicant: 'high',
        insured: 'high',
        policyNumber: 'high',
        date: 'high',
        name: 'high',
      },
      evidence: {
        applicant: {
          value: '张三',
          labelText: '投保人',
          rowText: '投保人 张三 被保险人 李四',
          relation: 'right',
        },
        policyNumber: {
          value: '990123456789',
          labelText: '保单号',
          relation: 'right',
        },
      },
      ocrWarnings: ['检测到附加险区域，基础字段已限制为从基本信息区读取'],
    },
  });

  assert.equal(merged.data.applicant, '张三');
  assert.equal(merged.data.policyNumber, '990123456789');
  assert.equal(merged.data.date, '2025-12-23');
  assert.equal(merged.data.name, '附加住院医疗保险');
  assert.equal(merged.fieldConfidence.applicant, 'high');
  assert.equal(merged.fieldConfidence.name, 'review');
  assert.equal(merged.fieldEvidence.applicant.rowText, '投保人 张三 被保险人 李四');
  assert.equal(merged.fieldEvidence.policyNumber.relation, 'right');
  assert.ok(merged.ocrWarnings.some((warning) => warning.includes('附加险')));
  assert.ok(merged.ocrWarnings.some((warning) => warning.includes('产品名称存在多个候选')));
});

test('mergePolicyLayoutScanResult preserves text fields when layout is missing', () => {
  const merged = mergePolicyLayoutScanResult({
    textData: { applicant: '张三', insured: '李四', name: '旧流程产品' },
    layoutResult: null,
  });

  assert.equal(merged.data.applicant, '张三');
  assert.equal(merged.data.name, '旧流程产品');
  assert.deepEqual(merged.fieldEvidence, {});
  assert.deepEqual(merged.ocrWarnings, []);
});

test('mergePolicyLayoutScanResult fills missing text name as review-only from layout', () => {
  const merged = mergePolicyLayoutScanResult({
    textData: { applicant: '张三' },
    layoutResult: {
      fields: { name: '主险终身寿险' },
      fieldConfidence: { name: 'high' },
    },
  });

  assert.equal(merged.data.name, '主险终身寿险');
  assert.equal(merged.fieldConfidence.name, 'review');
  assert.deepEqual(merged.ocrWarnings, []);
});

test('mergePolicyLayoutScanResult downgrades impossible high-confidence field values', () => {
  const merged = mergePolicyLayoutScanResult({
    textData: {},
    layoutResult: {
      fields: {
        applicant: '合同成立日期',
        insured: '姓名',
        policyNumber: '20241206',
      },
      fieldConfidence: {
        applicant: 'high',
        insured: 'high',
        policyNumber: 'high',
      },
      evidence: {
        applicant: { value: '合同成立日期', relation: 'right' },
        insured: { value: '姓名', relation: 'right' },
        policyNumber: { value: '20241206', relation: 'right' },
      },
    },
  });

  assert.equal(merged.data.applicant, undefined);
  assert.equal(merged.data.insured, undefined);
  assert.equal(merged.data.policyNumber, undefined);
  assert.equal(merged.fieldConfidence.applicant, 'review');
  assert.equal(merged.fieldEvidence.applicant, undefined);
  assert.equal(merged.fieldEvidence.insured, undefined);
  assert.equal(merged.fieldEvidence.policyNumber, undefined);
  assert.ok(merged.ocrWarnings.some((warning) => warning.includes('投保人识别结果')));
});

test('mergePolicyLayoutScanResult lets visual benefit-table fields override flattened text guesses', () => {
  const merged = mergePolicyLayoutScanResult({
    textData: {
      company: '新华保险',
      name: '保险责任名称',
      amount: '80000',
      coveragePeriod: '至2025年08月15日',
      paymentPeriod: '趸交',
      firstPremium: '298',
      plans: [
        { role: 'main', name: '保险责任名称' },
        { role: 'rider', name: '金额/份数' },
      ],
    },
    layoutResult: {
      fields: {
        name: '学生平安意外伤害保险',
        amount: '80000',
        coveragePeriod: '至2025年08月15日',
        paymentPeriod: '趸交',
        firstPremium: '298',
        plans: [
          { role: 'main', name: '学生平安意外伤害保险', amount: '80000' },
          { role: 'rider', name: '附加学生平安A款定期寿险', amount: '80000' },
        ],
      },
      fieldConfidence: {
        name: 'visual-table',
        amount: 'visual-table',
        coveragePeriod: 'visual-table',
        paymentPeriod: 'visual-table',
        firstPremium: 'visual-table',
        plans: 'visual-table',
      },
      evidence: {
        name: { value: '学生平安意外伤害保险', source: 'benefit-table-layout' },
      },
    },
  });

  assert.equal(merged.data.name, '学生平安意外伤害保险');
  assert.equal(merged.data.plans.length, 2);
  assert.equal(merged.data.plans[0].name, '学生平安意外伤害保险');
  assert.equal(merged.fieldConfidence.name, 'visual-table');
  assert.equal(merged.fieldEvidence.name.source, 'benefit-table-layout');
});
