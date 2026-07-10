import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProductDocument } from '../server/product-document-parser.service.mjs';

test('plain text is normalized into page-level evidence', async () => {
  const result = await parseProductDocument({
    bytes: Buffer.from('产品介绍\f第二页：保险责任'),
    extension: 'txt',
  });

  assert.equal(result.parser, 'plain-text');
  assert.equal(result.documentType, 'product_intro');
  assert.equal(result.pages.length, 2);
  assert.deepEqual(result.pages.map((page) => page.pageNo), [1, 2]);
  assert.match(result.pages[1].rawText, /保险责任/u);
});

test('structured AST keeps slide, heading, table and notes provenance', async () => {
  const parser = async () => ({
    type: 'pptx',
    metadata: { title: '培训材料' },
    warnings: [{ code: 'TEST_WARNING', message: 'warning' }],
    content: [
      {
        type: 'slide',
        text: '康宁保产品介绍',
        metadata: { slideNumber: 1 },
        children: [
          { type: 'heading', text: '产品亮点', metadata: { level: 1 } },
          {
            type: 'table',
            text: '责任 保额\n身故 100万',
            children: [
              { type: 'row', children: [{ type: 'cell', text: '责任' }, { type: 'cell', text: '保额' }] },
              { type: 'row', children: [{ type: 'cell', text: '身故' }, { type: 'cell', text: '100万' }] },
            ],
          },
        ],
        notes: [{ type: 'paragraph', text: '内部培训口径' }],
      },
    ],
  });

  const result = await parseProductDocument({
    bytes: Buffer.from('fake-pptx'),
    extension: 'pptx',
    parser,
  });

  assert.equal(result.parser, 'officeparser');
  assert.equal(result.documentType, 'training_deck');
  assert.equal(result.pages[0].sourceLabel, '幻灯片 1');
  assert.deepEqual(result.pages[0].headings, ['产品亮点']);
  assert.equal(result.pages[0].tables.length, 1);
  assert.match(result.pages[0].layout.notes[0], /内部培训口径/u);
  assert.equal(result.warnings[0].code, 'TEST_WARNING');
});

test('xlsx sheets become ordered source pages', async () => {
  const parser = async () => ({
    type: 'xlsx',
    content: [
      { type: 'sheet', text: '费率表一', metadata: { sheetName: '标准体' } },
      { type: 'sheet', text: '费率表二', metadata: { sheetName: '优选体' } },
    ],
  });
  const result = await parseProductDocument({
    bytes: Buffer.from('fake-xlsx'),
    extension: 'xlsx',
    parser,
  });
  assert.equal(result.pages[1].sourceLabel, '工作表 优选体');
  assert.equal(result.documentType, 'rate_table');
});

test('legacy binary office files fail with a conversion instruction', async () => {
  await assert.rejects(
    () => parseProductDocument({ bytes: Buffer.from('legacy'), extension: 'ppt' }),
    (error) => error.code === 'PRODUCT_DOCUMENT_CONVERSION_REQUIRED' && error.status === 422,
  );
});

test('images and textless PDFs request OCR instead of inventing text', async () => {
  await assert.rejects(
    () => parseProductDocument({ bytes: Buffer.from('image'), extension: 'png' }),
    (error) => error.code === 'PRODUCT_DOCUMENT_OCR_REQUIRED',
  );
  await assert.rejects(
    () => parseProductDocument({
      bytes: Buffer.from('pdf'),
      extension: 'pdf',
      parser: async () => ({ type: 'pdf', content: [{ type: 'page', text: '' }] }),
    }),
    (error) => error.code === 'PRODUCT_DOCUMENT_OCR_REQUIRED',
  );
});

test('parser failures are mapped to a stable domain error', async () => {
  await assert.rejects(
    () => parseProductDocument({
      bytes: Buffer.from('bad'),
      extension: 'docx',
      parser: async () => { throw new Error('zip corrupt'); },
    }),
    (error) => error.code === 'PRODUCT_DOCUMENT_PARSE_FAILED'
      && !String(error.message).includes('zip corrupt'),
  );
});
