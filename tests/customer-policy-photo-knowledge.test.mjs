import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveCustomerPolicyPhotoKnowledgeRecord,
  buildCustomerPolicyPhotoKnowledgeRecord,
  mergeCustomerPolicyPhotoScans,
  normalizeCustomerPolicyPhotoUploadItems,
  sanitizeCustomerPolicyPhotoKnowledgeText,
} from '../server/customer-policy-photo-knowledge.service.mjs';

test('customer policy photo knowledge sanitizer removes private fields and selected optional choices', () => {
  const safeText = sanitizeCustomerPolicyPhotoKnowledgeText({
    ocrText: [
      '投保人姓名:张三',
      '被保险人证件号码:330106198712072413',
      '保单号:P123456789',
      '产品名称:测试多倍保障重大疾病保险',
      '保险责任分为基本责任和可选责任一。',
      '本保单载明已选择可选责任一。',
      '可选责任一 轻度疾病保险金按基本保险金额20%给付。',
    ].join('\n'),
    scan: {
      data: {
        applicant: '张三',
        insuredIdNumber: '330106198712072413',
      },
    },
  });

  assert.match(safeText, /测试多倍保障重大疾病保险/u);
  assert.match(safeText, /可选责任一 轻度疾病保险金/u);
  assert.doesNotMatch(safeText, /张三/u);
  assert.doesNotMatch(safeText, /330106198712072413/u);
  assert.doesNotMatch(safeText, /P123456789/u);
  assert.doesNotMatch(safeText, /已选择可选责任一/u);
});

test('customer policy terms photos become trusted customer policy terms evidence', () => {
  const record = buildCustomerPolicyPhotoKnowledgeRecord({
    company: '新华保险',
    productName: '测试重疾保险',
    pageText: '产品名称:测试重疾保险\n保险责任:可选责任一 轻度疾病保险金。',
    ownerUserId: 9,
    uploadItems: [{ name: 'photo.jpg' }],
  });

  assert.equal(record.sourceKind, 'customer_policy_terms');
  assert.equal(record.official, true);
  assert.equal(record.reviewStatus, 'approved');
  assert.equal(record.globalSearchable, true);
  assert.equal(record.responsibilityDeferred, false);
  assert.equal(record.evidenceLevel, 'customer_policy_terms');
  assert.equal(record.verificationStatus, 'verified');
  assert.equal(record.referenceOnly, false);
  assert.equal(record.ownerUserId, 9);

  const approved = approveCustomerPolicyPhotoKnowledgeRecord(record, { approved: true, reviewedAt: '2026-07-03T00:00:00.000Z' });
  assert.equal(approved.reviewStatus, 'approved');
  assert.equal(approved.globalSearchable, true);
  assert.equal(approved.evidenceLevel, 'customer_policy_terms');
});

test('customer policy non-terms photos stay pending until review', () => {
  const record = buildCustomerPolicyPhotoKnowledgeRecord({
    company: '新华保险',
    productName: '测试重疾保险',
    pageText: '产品名称:测试重疾保险\n新品上市，保障全面，具体以合同为准。',
  });

  assert.equal(record.sourceKind, 'customer_policy_photo');
  assert.equal(record.official, false);
  assert.equal(record.reviewStatus, 'pending');
  assert.equal(record.globalSearchable, false);
  assert.equal(record.referenceOnly, true);
});

test('merged supplement scans keep optional responsibility choices on the policy scan only', () => {
  const merged = mergeCustomerPolicyPhotoScans({
    baseScan: {
      ocrText: '原保单',
      data: { company: '新华保险', name: '旧产品名', applicant: '张三' },
    },
    supplementScans: [
      {
        ocrText: '产品名称:测试重疾保险\n本保单载明已选择可选责任一。',
        data: { company: '新华保险', name: '测试重疾保险' },
      },
    ],
    manualData: { applicant: '张三' },
  });

  assert.equal(merged.data.name, '测试重疾保险');
  assert.match(merged.ocrText, /本保单载明已选择可选责任一/u);
  assert.ok(merged.ocrWarnings.some((warning) => /当前保单证据/u.test(warning)));
});

test('customer policy photo upload limit accepts five product pages and rejects six', () => {
  const uploadItems = Array.from({ length: 5 }, (_, index) => ({
    name: `product-page-${index + 1}.jpg`,
    dataUrl: `data:image/jpeg;base64,${index}`,
  }));

  assert.equal(normalizeCustomerPolicyPhotoUploadItems(uploadItems).length, 5);
  assert.throws(
    () => normalizeCustomerPolicyPhotoUploadItems([...uploadItems, { name: 'extra.jpg', dataUrl: 'data:image/jpeg;base64,extra' }]),
    /最多上传 5 张保险产品页面/u,
  );
});
