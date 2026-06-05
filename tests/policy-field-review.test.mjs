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
  });

  assert.equal(reviewed.data.applicant, undefined);
  assert.equal(reviewed.data.insured, undefined);
  assert.equal(reviewed.data.policyNumber, undefined);
  assert.equal(reviewed.data.name, '国寿鑫颐宝两全保险');
  assert.equal(reviewed.fieldConfidence.applicant, 'review');
  assert.equal(reviewed.fieldConfidence.insured, 'review');
  assert.equal(reviewed.fieldConfidence.policyNumber, 'review');
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
  });

  assert.equal(reviewed.data.applicant, '翟卿');
  assert.equal(reviewed.data.insured, '翟卿');
  assert.equal(reviewed.data.policyNumber, '2024330133SCW500032558');
  assert.deepEqual(reviewed.warnings, []);
});
