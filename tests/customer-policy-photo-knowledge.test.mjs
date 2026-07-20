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

test('customer policy terms photos stay pending until operations review', () => {
  const record = buildCustomerPolicyPhotoKnowledgeRecord({
    company: '新华保险',
    productName: '测试重疾保险',
    pageText: '产品名称:测试重疾保险\n保险责任:可选责任一 轻度疾病保险金。',
    ownerUserId: 9,
    uploadItems: [{ name: 'photo.jpg' }],
  });

  assert.equal(record.sourceKind, 'customer_policy_photo');
  assert.equal(record.official, false);
  assert.equal(record.reviewStatus, 'pending');
  assert.equal(record.globalSearchable, false);
  assert.equal(record.responsibilityDeferred, true);
  assert.equal(record.evidenceLevel, 'customer_policy_photo_pending');
  assert.equal(record.verificationStatus, 'pending_review');
  assert.equal(record.referenceOnly, true);
  assert.equal(record.ownerUserId, 9);
  assert.equal(record.uploadImages.length, 0);
  assert.equal(record.originalCompany, '新华保险');
  assert.equal(record.originalProductName, '测试重疾保险');
  assert.equal(record.originalPageText, record.pageText);

  const approved = approveCustomerPolicyPhotoKnowledgeRecord(record, { approved: true, reviewedAt: '2026-07-03T00:00:00.000Z' });
  assert.equal(approved.reviewStatus, 'approved');
  assert.equal(approved.globalSearchable, true);
  assert.equal(approved.evidenceLevel, 'customer_policy_terms');

  const rolledBack = approveCustomerPolicyPhotoKnowledgeRecord(approved, {
    action: 'pending',
    updates: {
      company: '新华人寿',
      productName: '修改后的测试重疾保险',
      pageText: '修改后的保险责任文本',
    },
    reviewedAt: '2026-07-03T01:00:00.000Z',
  });
  assert.equal(rolledBack.reviewStatus, 'pending');
  assert.equal(rolledBack.globalSearchable, false);
  assert.equal(rolledBack.company, '新华人寿');
  assert.equal(rolledBack.productName, '修改后的测试重疾保险');
  assert.equal(rolledBack.pageText, '修改后的保险责任文本');
  assert.equal(rolledBack.originalCompany, '新华保险');
  assert.equal(rolledBack.originalProductName, '测试重疾保险');
  assert.equal(rolledBack.originalPageText, record.pageText);

  const republished = approveCustomerPolicyPhotoKnowledgeRecord(rolledBack, {
    action: 'approved',
    reviewedAt: '2026-07-03T02:00:00.000Z',
  });
  assert.equal(republished.reviewStatus, 'approved');
  assert.equal(republished.globalSearchable, true);
  assert.equal(republished.productName, '修改后的测试重疾保险');
  assert.match(republished.title, /修改后的测试重疾保险/);
  assert.equal(republished.originalPageText, record.pageText);
});

test('customer policy review record preserves uploaded images for operations only', () => {
  const record = buildCustomerPolicyPhotoKnowledgeRecord({
    company: '新华保险',
    productName: '测试附加险',
    pageText: '产品名称:测试附加险\n保险责任:住院医疗保险金。',
    uploadItems: [{ name: 'rider.jpg', type: 'image/jpeg', size: 123, dataUrl: 'data:image/jpeg;base64,AAAA' }],
  });

  assert.deepEqual(record.uploadImages, [{ name: 'rider.jpg', type: 'image/jpeg', size: 123, dataUrl: 'data:image/jpeg;base64,AAAA' }]);
  assert.equal(record.reviewStatus, 'pending');
  assert.equal(record.globalSearchable, false);

  const rolledBack = approveCustomerPolicyPhotoKnowledgeRecord(
    approveCustomerPolicyPhotoKnowledgeRecord(record, { action: 'approved' }),
    { action: 'pending' },
  );
  assert.deepEqual(rolledBack.uploadImages, record.uploadImages);
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
