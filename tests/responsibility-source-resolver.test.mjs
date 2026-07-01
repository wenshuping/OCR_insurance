import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOfficialResponsibilitySources,
} from '../server/responsibility-source-resolver.mjs';

test('resolveOfficialResponsibilitySources prefers official terms pdfs over manuals', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '鑫荣耀终身寿险',
    records: [
      {
        id: 2,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        title: '产品说明书',
        materialType: 'product_manual',
        official: true,
        url: 'https://static-cdn.newchinalife.com/manual.pdf',
        pageText: '保险责任 产品说明书责任正文',
      },
      {
        id: 1,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        title: '条款',
        materialType: 'terms',
        official: true,
        url: 'https://static-cdn.newchinalife.com/terms.pdf',
        pageText: '保险责任 条款责任正文',
      },
    ],
  });

  assert.equal(result.productKey, 'company_product:新华保险:新华人寿保险股份有限公司鑫荣耀终身寿险');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].materialType, 'terms');
  assert.equal(result.records[0].url, 'https://static-cdn.newchinalife.com/terms.pdf');
});

test('resolveOfficialResponsibilitySources rejects non-official records for ready summaries', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '测试产品',
    records: [
      {
        company: '新华保险',
        productName: '测试产品',
        official: false,
        url: 'https://example.test/article',
        pageText: '保险责任 来自第三方',
      },
    ],
  });

  assert.equal(result.records.length, 0);
  assert.equal(result.status, 'needs_source_review');
});
