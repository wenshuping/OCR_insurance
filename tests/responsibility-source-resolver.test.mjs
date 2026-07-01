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

test('resolveOfficialResponsibilitySources accepts insurer official evidence levels', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '平安人寿',
    productName: '盛世金越终身寿险',
    records: [
      {
        company: '平安人寿',
        productName: '平安盛世金越终身寿险',
        evidenceLevel: 'insurer_official',
        responsibilityText: '保险责任 身故保险金按约定给付。',
      },
      {
        company: '平安人寿',
        productName: '平安盛世金越终身寿险',
        evidence_level: 'insurer_official',
        responsibility_text: '保险责任 豁免保险费。',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 2);
});

test('resolveOfficialResponsibilitySources accepts official and source URL fields from official domains', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '中国人寿',
    productName: '鑫享未来年金保险',
    records: [
      {
        company: '中国人寿',
        product_name: '中国人寿鑫享未来年金保险',
        officialUrl: 'https://www.chinalife.com/product/terms.pdf',
        text: '保险责任 年金给付规则。',
      },
      {
        company: '中国人寿',
        product_name: '中国人寿鑫享未来年金保险',
        source_url: 'https://static.chinalife.com/source/manual.pdf',
        source_text: '保险责任 满期保险金给付规则。',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 2);
});

test('resolveOfficialResponsibilitySources accepts file URL fields from official domains', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '人保寿险',
    productName: '福寿年年专属商业养老保险',
    records: [
      {
        company: '人保寿险',
        productName: '人保寿险福寿年年专属商业养老保险',
        fileUrl: 'https://www.picc.com/terms/fushouniannian.pdf',
        pageText: '保险责任 年金给付规则。',
      },
      {
        company: '人保寿险',
        productName: '人保寿险福寿年年专属商业养老保险',
        file_url: 'https://static.picc.com/manual/fushouniannian.pdf',
        pageText: '保险责任 身故保险金给付规则。',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 2);
});

test('resolveOfficialResponsibilitySources retains official terms pdfs without extracted text', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '鑫荣耀终身寿险',
    records: [
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        title: '保险条款',
        materialType: 'terms',
        official: true,
        url: 'https://static-cdn.newchinalife.com/xinrongyao-terms.pdf',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].url, 'https://static-cdn.newchinalife.com/xinrongyao-terms.pdf');
});

test('resolveOfficialResponsibilitySources ranks official terms pdfs before manuals with extracted text', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '鑫荣耀终身寿险',
    records: [
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        title: '产品说明书',
        materialType: 'product_manual',
        official: true,
        url: 'https://static-cdn.newchinalife.com/xinrongyao-manual.pdf',
        pageText: '保险责任 产品说明书责任正文',
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        title: '保险条款',
        materialType: 'terms',
        official: true,
        url: 'https://static-cdn.newchinalife.com/xinrongyao-terms.pdf',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].materialType, 'terms');
  assert.equal(result.records[0].url, 'https://static-cdn.newchinalife.com/xinrongyao-terms.pdf');
});

test('resolveOfficialResponsibilitySources ranks sparse official pdf sources before manuals', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '鑫荣耀终身寿险',
    records: [
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        title: '产品说明书',
        materialType: 'product_manual',
        official: true,
        url: 'https://static-cdn.newchinalife.com/xinrongyao-manual.pdf',
        pageText: '保险责任 产品说明书责任正文',
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        official: true,
        url: 'https://static-cdn.newchinalife.com/xinrongyao-terms.pdf',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].url, 'https://static-cdn.newchinalife.com/xinrongyao-terms.pdf');
});

test('resolveOfficialResponsibilitySources combines project text fields when detecting responsibility text', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '太保寿险',
    productName: '金生无忧重大疾病保险',
    records: [
      {
        company: '太保寿险',
        productName: '太保金生无忧重大疾病保险',
        official: true,
        url: 'https://www.cpic.com/terms.pdf',
        source_excerpt: '保险责任',
        summary: '重大疾病保险金给付。',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 1);
});

test('resolveOfficialResponsibilitySources combines text fields instead of stopping at first truthy text', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '太保寿险',
    productName: '金生无忧重大疾病保险',
    records: [
      {
        company: '太保寿险',
        productName: '太保金生无忧重大疾病保险',
        official: true,
        url: 'https://www.cpic.com/jinshengwuyou.pdf',
        responsibilityText: '目录/投保规则/犹豫期说明。',
        pageText: '保险责任 重大疾病保险金给付。',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 1);
});

test('resolveOfficialResponsibilitySources avoids overmatching short generic product names', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '寿险',
    records: [
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        official: true,
        url: 'https://static-cdn.newchinalife.com/terms.pdf',
        pageText: '保险责任 身故保险金给付。',
      },
      {
        company: '新华保险',
        productName: '寿险',
        official: true,
        url: 'https://static-cdn.newchinalife.com/generic.pdf',
        pageText: '保险责任 通用责任。',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].productName, '寿险');
});

test('resolveOfficialResponsibilitySources does not match generic categories by contains', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '终身寿险',
    records: [
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        official: true,
        url: 'https://static-cdn.newchinalife.com/terms.pdf',
        pageText: '保险责任 身故保险金给付。',
      },
    ],
  });

  assert.equal(result.records.length, 0);
  assert.equal(result.status, 'needs_source_review');
});

test('resolveOfficialResponsibilitySources blocks broad category names from concrete contains matches', () => {
  const genericQueries = [
    '养老保险',
    '商业养老保险',
    '健康保险',
    '护理保险',
    '定期寿险',
    '终身保险',
    '终身寿险',
  ];

  for (const productName of genericQueries) {
    const result = resolveOfficialResponsibilitySources({
      company: '新华保险',
      productName,
      records: [
        {
          company: '新华保险',
          productName: `新华人寿保险股份有限公司鑫荣耀${productName}`,
          official: true,
          url: 'https://static-cdn.newchinalife.com/concrete-terms.pdf',
          pageText: '保险责任 身故保险金给付。',
        },
      ],
    });

    assert.equal(result.records.length, 0, productName);
    assert.equal(result.status, 'needs_source_review', productName);
  }
});

test('resolveOfficialResponsibilitySources allows concrete product queries with category suffixes', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '中国人寿',
    productName: '康宁终身保险',
    records: [
      {
        company: '中国人寿',
        productName: '国寿康宁终身保险',
        official: true,
        url: 'https://www.chinalife.com/kangning-terms.pdf',
        pageText: '保险责任 身故保险金给付。',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 1);
  assert.equal(result.productName, '国寿康宁终身保险');
});

test('resolveOfficialResponsibilitySources still accepts exact normalized generic matches', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '终身寿险',
    records: [
      {
        company: '新华保险',
        productName: '终身寿险',
        official: true,
        url: 'https://static-cdn.newchinalife.com/generic-terms.pdf',
        pageText: '保险责任 身故保险金给付。',
      },
    ],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.records.length, 1);
  assert.equal(result.productName, '终身寿险');
});
