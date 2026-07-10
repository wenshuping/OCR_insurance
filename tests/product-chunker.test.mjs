import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkProductDocument, estimateTokenCount } from '../server/product-chunker.service.mjs';

function baseInput(overrides = {}) {
  return {
    document: {
      id: 'pdoc_1',
      fileName: '康宁保培训.pptx',
      documentType: 'training_deck',
      sourceAuthority: 'company_material',
    },
    product: {
      company: '新华保险',
      productName: '康宁保终身重大疾病保险',
      versionLabel: '2026版',
    },
    pages: [{
      pageNo: 1,
      rawText: '产品亮点\n等待期为90天。\n保险责任以正式条款为准。',
      headings: ['产品亮点'],
      tables: [],
      sourceLabel: '幻灯片 1',
    }],
    ...overrides,
  };
}

test('creates a parent and cited child chunks with deterministic prefixes', () => {
  const chunks = chunkProductDocument(baseInput());
  const parent = chunks.find((chunk) => chunk.chunkType === 'parent');
  const child = chunks.find((chunk) => chunk.chunkType === 'child');
  assert.ok(parent);
  assert.equal(child.parentChunkId, parent.id);
  assert.equal(child.pageStart, 1);
  assert.match(child.contextualPrefix, /保险公司：新华保险/u);
  assert.match(child.contextualPrefix, /资料：康宁保培训\.pptx/u);
  assert.match(child.contextualPrefix, /页码：幻灯片 1/u);
  assert.deepEqual(child.headingPath, ['产品亮点']);
});

test('long content is split on natural sentence boundaries', () => {
  const sentence = '本责任在被保险人满足约定条件后给付保险金。';
  const input = baseInput({
    pages: [{ pageNo: 1, rawText: Array.from({ length: 90 }, () => sentence).join(''), headings: ['保险责任'], tables: [] }],
  });
  const children = chunkProductDocument(input).filter((chunk) => chunk.chunkType === 'child');
  assert.ok(children.length > 1);
  assert.ok(children.every((chunk) => chunk.content.endsWith('。')));
  assert.ok(children.every((chunk) => chunk.tokenCount <= 520));
});

test('numbered insurance clauses remain intact when below the clause ceiling', () => {
  const clause = `第十八条 续保\n${'本合同保险期间届满前，投保人可按约定申请续保。'.repeat(25)}`;
  const chunks = chunkProductDocument(baseInput({
    document: { id: 'pdoc_terms', fileName: '条款.pdf', documentType: 'terms', sourceAuthority: 'official_terms' },
    pages: [{ pageNo: 18, rawText: clause, headings: ['第十八条 续保'], tables: [] }],
  })).filter((chunk) => chunk.chunkType === 'child');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /^第十八条/u);
  assert.ok(chunks[0].tokenCount <= 800);
});

test('table chunks repeat the header and are never raw-character sliced', () => {
  const rows = [
    ['年龄', '保费'],
    ...Array.from({ length: 200 }, (_, index) => [`${index + 1}岁`, `${1000 + index}元`]),
  ];
  const chunks = chunkProductDocument(baseInput({
    document: { id: 'pdoc_rate', fileName: '费率.xlsx', documentType: 'rate_table', sourceAuthority: 'company_material' },
    pages: [{ pageNo: 1, rawText: '标准体费率', headings: ['标准体'], tables: [{ rows, text: '' }], sourceLabel: '工作表 标准体' }],
  })).filter((chunk) => chunk.chunkType === 'table');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.content.startsWith('年龄 | 保费')));
  assert.ok(chunks.every((chunk) => chunk.payload.isTable === true));
});

test('estimated token count treats Chinese and Latin text predictably', () => {
  assert.equal(estimateTokenCount('等待期90天'), 5);
  assert.ok(estimateTokenCount('waiting period is 90 days') >= 5);
});
