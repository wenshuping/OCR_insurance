import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createProductIngestionService } from '../server/product-ingestion.service.mjs';
import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';

test('product ingestion binds each page range to its uploaded product master', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const upload = store.createDocumentUpload({
      tenantId: 'default',
      createdBy: 'admin',
      sourceAuthority: 'company_material',
      contentHash: 'test-multi-product-upload',
      fileName: '多产品培训课件.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('placeholder'),
      payload: {
        company: '新华保险',
        productNames: ['安心医疗保险', '康护护理保险'],
      },
    });
    const service = createProductIngestionService({
      store,
      async parseDocument() {
        return {
          documentType: 'training_deck',
          parser: 'test',
          warnings: [],
          metadata: {},
          pages: [
            {
              pageNo: 1,
              sourceLabel: '第 1 页',
              headings: [],
              rawText: '新华保险 安心医疗保险 产品介绍',
              tables: [{ rows: [['项目', '内容'], ['等待期', '60日']] }],
            },
            {
              pageNo: 2,
              sourceLabel: '第 2 页',
              headings: [],
              rawText: '新华保险 康护护理保险 产品介绍',
              tables: [{ rows: [['项目', '内容'], ['护理责任', '按约定给付']] }],
            },
          ],
        };
      },
    });

    await service.ingestDocument({ tenantId: 'default', documentId: upload.document.id });

    const products = store.listProducts({ tenantId: 'default' });
    assert.deepEqual(products.map((product) => product.officialName), ['安心医疗保险', '康护护理保险']);
    const productIds = new Map(products.map((product) => [product.officialName, product.canonicalProductId]));
    const pageOneChunks = store.listDocumentChunks({ tenantId: 'default', documentId: upload.document.id })
      .filter((chunk) => chunk.pageStart === 1);
    const pageTwoChunks = store.listDocumentChunks({ tenantId: 'default', documentId: upload.document.id })
      .filter((chunk) => chunk.pageStart === 2);

    assert.ok(pageOneChunks.length > 0);
    assert.ok(pageTwoChunks.length > 0);
    assert.equal(pageOneChunks.every((chunk) => chunk.canonicalProductId === productIds.get('安心医疗保险')), true);
    assert.equal(pageTwoChunks.every((chunk) => chunk.canonicalProductId === productIds.get('康护护理保险')), true);
    assert.equal(pageOneChunks.every((chunk) => /产品：安心医疗保险/u.test(chunk.contextualPrefix)), true);
    assert.equal(pageOneChunks.every((chunk) => !/康护护理保险/u.test(chunk.contextualPrefix)), true);
    assert.equal(pageTwoChunks.every((chunk) => /产品：康护护理保险/u.test(chunk.contextualPrefix)), true);
    assert.equal(pageTwoChunks.every((chunk) => !/安心医疗保险/u.test(chunk.contextualPrefix)), true);
    assert.equal(pageOneChunks.filter((chunk) => chunk.chunkType !== 'parent')
      .every((chunk) => chunk.payload?.semantic?.classifierVersion === 'product-chunk-semantic-v1'), true);
    assert.equal(pageTwoChunks.find((chunk) => chunk.chunkType === 'table')?.payload?.semantic?.topics.includes('coverage'), true);
    const facts = store.listProductFacts({
      tenantId: 'default',
      canonicalProductId: productIds.get('安心医疗保险'),
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].fieldKey, 'waiting_period');
    assert.deepEqual(facts[0].normalizedValue, { value: 60, unit: 'DAY' });
    assert.equal(facts[0].status, 'candidate');
    assert.equal(store.searchChunks({
      tenantId: 'default',
      canonicalProductId: productIds.get('安心医疗保险'),
      query: '护理责任',
      includeQuarantined: true,
    }).length, 0);
    assert.equal(store.searchChunks({
      tenantId: 'default',
      canonicalProductId: productIds.get('康护护理保险'),
      query: '护理责任',
      includeQuarantined: true,
    }).length > 0, true);
  } finally {
    db.close();
  }
});

test('product ingestion preserves raw evidence while cleaning, gating confidence, and binding a formal version', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const upload = store.createDocumentUpload({
      tenantId: 'default',
      createdBy: 'admin',
      sourceAuthority: 'insurer_official',
      contentHash: 'test-cleaning-confidence-version',
      fileName: '安心医疗保险2026版条款.pdf',
      mediaType: 'application/pdf',
      bytes: Buffer.from('placeholder'),
      payload: {
        company: '新华保险',
        productNames: ['安心医疗保险'],
        versionLabel: '2026版',
      },
    });
    const service = createProductIngestionService({
      store,
      async parseDocument() {
        return {
          documentType: 'terms',
          parser: 'test-ocr-v1',
          warnings: [],
          metadata: {},
          pages: [1, 2].map((pageNo) => ({
            pageNo,
            sourceLabel: `第 ${pageNo} 页`,
            headings: ['第一条 保险责任'],
            rawText: `新华保险内部资料\n第一条 保险责任\n等待期为90天。\n第 ${pageNo} 页`,
            tables: [],
            layout: {
              sourceType: 'ocr',
              elements: [
                { kind: 'header', text: '新华保险内部资料', confidence: 0.99 },
                { kind: 'heading', text: '第一条 保险责任', confidence: 0.99 },
                { kind: 'text', text: '等待期为90天。', confidence: 0.8 },
                { kind: 'footer', text: `第 ${pageNo} 页`, confidence: 0.99 },
              ],
            },
          })),
        };
      },
    });

    const result = await service.ingestDocument({ tenantId: 'default', documentId: upload.document.id });
    const storedDocument = store.getDocument({ tenantId: 'default', documentId: upload.document.id });
    const storedPages = store.listDocumentPages({ tenantId: 'default', documentId: upload.document.id });
    const children = store.listDocumentChunks({ tenantId: 'default', documentId: upload.document.id })
      .filter((chunk) => chunk.chunkType !== 'parent');
    const versions = store.listProductVersions({
      tenantId: 'default',
      canonicalProductId: children[0].canonicalProductId,
    });
    const cleaningRuns = store.listDocumentCleaningRuns({ tenantId: 'default', documentId: upload.document.id });
    const cleaningOperations = store.listDocumentCleaningOperations({
      tenantId: 'default',
      documentId: upload.document.id,
      runId: cleaningRuns[0].id,
    });

    assert.match(storedPages[0].rawText, /新华保险内部资料/u);
    assert.doesNotMatch(storedPages[0].layout.cleaning.cleanedText, /内部资料/u);
    assert.equal(cleaningRuns.length, 1);
    assert.equal(cleaningRuns[0].cleaningVersion, 'product-document-cleaning-v1');
    assert.ok(cleaningOperations.some((operation) => operation.rule === 'classify_repeated_header_footer_v1'));
    assert.equal(versions.length, 1);
    assert.equal(versions[0].versionLabel, '2026版');
    assert.equal(storedDocument.payload.productVersionId, versions[0].id);
    assert.equal(children.every((chunk) => chunk.productVersionId === versions[0].id), true);
    assert.ok(children.some((chunk) => chunk.payload?.confidence?.decision === 'blocked'));
    assert.ok(children.some((chunk) => chunk.indexStatus === 'blocked'));
    assert.equal(result.job.status, 'match_required');
  } finally {
    db.close();
  }
});
