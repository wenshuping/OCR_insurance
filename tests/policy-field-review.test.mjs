import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewPolicyFieldValues } from '../ocr-service/policy-field-review.mjs';

test('reviewPolicyFieldValues rejects label-like person values and date-like policy numbers', () => {
  const reviewed = reviewPolicyFieldValues({
    data: {
      applicant: '合同成立日期',
      insured: '姓名',
      policyNumber: '20241206',
      name: '国寿鑫颐宝两全保险',
    },
    fieldConfidence: {
      applicant: 'high',
      insured: 'high',
      policyNumber: 'high',
    },
    fieldEvidence: {
      applicant: { value: '合同成立日期', rowText: '投保人姓名 合同成立日期' },
      insured: { value: '姓名', rowText: '被保险人 姓名' },
      policyNumber: { value: '20241206', rowText: '保单生效日 20241206' },
    },
  });

  assert.equal(reviewed.data.applicant, undefined);
  assert.equal(reviewed.data.insured, undefined);
  assert.equal(reviewed.data.policyNumber, undefined);
  assert.equal(reviewed.data.name, '国寿鑫颐宝两全保险');
  assert.equal(reviewed.fieldConfidence.applicant, 'review');
  assert.equal(reviewed.fieldConfidence.insured, 'review');
  assert.equal(reviewed.fieldConfidence.policyNumber, 'review');
  assert.equal(reviewed.fieldEvidence.applicant, undefined);
  assert.equal(reviewed.fieldEvidence.insured, undefined);
  assert.equal(reviewed.fieldEvidence.policyNumber, undefined);
  assert.ok(reviewed.warnings.some((warning) => warning.includes('投保人识别结果')));
});

test('reviewPolicyFieldValues keeps plausible China Life person and policy number values', () => {
  const reviewed = reviewPolicyFieldValues({
    data: {
      applicant: '翟卿',
      insured: '翟卿',
      policyNumber: '2024330133SCW500032558',
    },
    fieldConfidence: {
      applicant: 'high',
      insured: 'high',
      policyNumber: 'high',
    },
    fieldEvidence: {
      applicant: { value: '翟卿', relation: 'inline' },
      policyNumber: { value: '2024330133SCW500032558', relation: 'inline' },
    },
  });

  assert.equal(reviewed.data.applicant, '翟卿');
  assert.equal(reviewed.data.insured, '翟卿');
  assert.equal(reviewed.data.policyNumber, '2024330133SCW500032558');
  assert.equal(reviewed.fieldEvidence.applicant.relation, 'inline');
  assert.equal(reviewed.fieldEvidence.policyNumber.relation, 'inline');
  assert.deepEqual(reviewed.warnings, []);
});
