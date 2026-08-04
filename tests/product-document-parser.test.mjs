import assert from 'node:assert/strict';
import test from 'node:test';

import { strToU8, zipSync } from 'fflate';

import { parseProductDocument } from '../server/product-document-parser.service.mjs';

function parserAst(rawText) {
  return {
    type: 'pptx',
    content: [{
      type: 'slide',
      text: rawText,
      children: [],
      metadata: { slideNumber: 17 },
    }],
    warnings: [],
  };
}

function slideArchive(fragments) {
  const runs = fragments.map((fragment) => `<a:r><a:t>${fragment}</a:t></a:r>`).join('');
  return Buffer.from(zipSync({
    'ppt/slides/slide17.xml': strToU8(`<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p>${runs}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
  }));
}

test('PPTX parser recovers grouped comparison text and plan table from slide XML', async () => {
  const bytes = slideArchive([
    '医药安欣（易核版）医疗保险', '三档保障计划的3点区别',
    '1.', '年度免赔额不同：', '计划一：', '1', '万元', '计划二：', '2', '万元', '计划三：', '3', '万元',
    '3.', '小额医疗（可选责任）年度给付限额不同：', '计划一：', '0.5', '万元', '计划二：', '1', '万元', '计划三：', '1.5', '万元', '对应年度免赔额，', '50%', '赔付',
    '2.', '康护责任年度给付限额不同：', '计划一：', '10', '万元', '计划二：', '5', '万元', '计划三：', '2', '万元',
    '其余责任内容完全一致',
  ]);
  const parsed = await parseProductDocument({
    bytes,
    extension: 'pptx',
    parser: async () => parserAst('医药安欣（易核版）医疗保险\n三档保障计划的\n3\n点区别\n其余责任内容完全一致'),
  });

  const page = parsed.pages[0];
  assert.match(page.rawText, /计划一：\n1\n万元/u);
  assert.equal(page.layout.extraction.method, 'officeparser+pptx_xml');
  assert.equal(page.layout.extraction.incomplete, false);
  assert.deepEqual(page.tables[0].rows, [
    ['保障项目', '计划一', '计划二', '计划三'],
    ['年度免赔额', '计划一 1万元', '计划二 2万元', '计划三 3万元'],
    ['小额医疗（可选责任）年度给付限额', '计划一 0.5万元', '计划二 1万元', '计划三 1.5万元'],
    ['康护责任年度给付限额', '计划一 10万元', '计划二 5万元', '计划三 2万元'],
    ['小额医疗对应年度免赔额后50%赔付', '', '', ''],
  ]);
});

test('PPTX parser marks a comparison page incomplete when grouped content cannot be recovered', async () => {
  const parsed = await parseProductDocument({
    bytes: Buffer.from('not-a-zip'),
    extension: 'pptx',
    parser: async () => parserAst('三档保障计划的3点区别'),
  });

  assert.equal(parsed.pages[0].layout.extraction.incomplete, true);
  assert.equal(parsed.pages[0].layout.extraction.needsVisualOcr, true);
});

test('PPTX parser falls back to slide XML when officeparser fails', async () => {
  const bytes = slideArchive(['产品介绍', '等待期为90天']);
  const parsed = await parseProductDocument({
    bytes,
    extension: 'pptx',
    parser: async () => { throw new Error('officeparser failed'); },
  });

  assert.equal(parsed.parser, 'pptx-xml-fallback');
  assert.match(parsed.pages[0].rawText, /等待期为90天/u);
  assert.equal(parsed.pages[0].layout.extraction.incomplete, false);
});

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
    content: [{
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
    }],
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
