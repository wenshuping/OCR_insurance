import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductDocumentPreviewService } from '../server/product-document-preview.service.mjs';

test('product document preview renders once and caches all pages by document content', async () => {
  let renderCount = 0;
  const service = createProductDocumentPreviewService({
    async renderPages(document) {
      renderCount += 1;
      assert.equal(document.id, 'document-1');
      return [Buffer.from('page-1'), Buffer.from('page-2')];
    },
  });
  const document = { id: 'document-1', contentHash: 'hash-1', bytes: Buffer.from('source') };
  assert.equal((await service.getPagePreview({ document, pageNo: 1 })).toString(), 'page-1');
  assert.equal((await service.getPagePreview({ document, pageNo: 2 })).toString(), 'page-2');
  assert.equal(renderCount, 1);
});

test('product document preview rejects a page outside the rendered document', async () => {
  const service = createProductDocumentPreviewService({ renderPages: async () => [Buffer.from('page-1')] });
  await assert.rejects(
    service.getPagePreview({ document: { id: 'document-1', contentHash: 'hash-1' }, pageNo: 2 }),
    (error) => error?.code === 'PRODUCT_DOCUMENT_PAGE_NOT_FOUND',
  );
});

