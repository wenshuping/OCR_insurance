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
      ocrWarnings: ['检测到附加险区域，基础字段已限制为从基本信息区读取'],
    },
  });

  assert.equal(merged.data.applicant, '张三');
  assert.equal(merged.data.policyNumber, '990123456789');
  assert.equal(merged.data.date, '2025-12-23');
  assert.equal(merged.data.name, '附加住院医疗保险');
  assert.equal(merged.fieldConfidence.applicant, 'high');
  assert.equal(merged.fieldConfidence.name, 'review');
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
    },
  });

  assert.equal(merged.data.applicant, undefined);
  assert.equal(merged.data.insured, undefined);
  assert.equal(merged.data.policyNumber, undefined);
  assert.equal(merged.fieldConfidence.applicant, 'review');
  assert.ok(merged.ocrWarnings.some((warning) => warning.includes('投保人识别结果')));
});
