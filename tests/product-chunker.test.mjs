import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkProductDocument } from '../server/product-chunker.service.mjs';

function chunkTerms(pages) {
  return chunkProductDocument({
    document: {
      id: 'doc_terms_1',
      fileName: '测试保险条款.pdf',
      documentType: 'terms',
      sourceAuthority: 'insurer_official',
      payload: {},
    },
    product: {
      company: '测试保险公司',
      productName: '测试终身寿险',
      versionLabel: '1.0',
    },
    pages,
  });
}

test('product chunker keeps numbered sections and cross-page continuation together', () => {
  const chunks = chunkTerms([
    {
      pageNo: 1,
      sourceLabel: '第 1 页',
      headings: ['第二条 保险责任'],
      rawText: `第二条 保险责任
一、身故保险金
被保险人身故，我们按保险金额给付身故保险金。`,
      tables: [],
    },
    {
      pageNo: 2,
      sourceLabel: '第 2 页',
      headings: ['二、重大疾病保险金', '第三条 保单红利'],
      rawText: `给付后本合同终止。
二、重大疾病保险金
根据第二条规定，被保险人首次确诊重大疾病时给付保险金。
第三条 保单红利
本公司每年确定红利分配。`,
      tables: [],
    },
  ]);

  const sections = chunks.filter((chunk) => chunk.chunkType === 'child');
  const death = sections.find((chunk) => chunk.headingPath.at(-1) === '一、身故保险金');
  assert.ok(death);
  assert.equal(death.pageStart, 1);
  assert.equal(death.pageEnd, 2);
  assert.match(death.content, /给付后本合同终止/u);
  assert.ok(death.payload.boundaryConfidence >= 0.8);
  assert.ok(death.payload.boundaryReasons.includes('中文序号标题'));

  const criticalIllness = sections.find((chunk) => chunk.headingPath.at(-1) === '二、重大疾病保险金');
  assert.ok(criticalIllness);
  assert.match(criticalIllness.content, /根据第二条规定/u);
  assert.equal(sections.some((chunk) => chunk.headingPath.at(-1) === '根据第二条规定'), false);
  assert.equal(criticalIllness.payload.previousChunkId, death.id);
  assert.ok(criticalIllness.payload.nextChunkId);
});

test('product chunker marks unheaded content for review without discarding it', () => {
  const chunks = chunkTerms([
    {
      pageNo: 1,
      sourceLabel: '第 1 页',
      headings: [],
      rawText: '本资料为历史扫描件，以下内容接续上一页。',
      tables: [],
    },
  ]);

  const section = chunks.find((chunk) => chunk.chunkType === 'child');
  assert.ok(section);
  assert.equal(section.payload.reviewRequired, true);
  assert.ok(section.payload.boundaryConfidence < 0.6);
  assert.deepEqual(section.payload.sourceUnitIds, ['p1-l1']);
});

test('product chunker keeps table rows structured without indexing flattened page text', () => {
  const chunks = chunkTerms([{
    pageNo: 1,
    sourceLabel: '第 1 页',
    headings: [],
    rawText: '服务类别\n服务项目\n服务次数\n计划一\n电话咨询\n1\n次\n年\n√',
    tables: [{
      rows: [
        ['服务类别', '服务项目', '服务次数', '计划一'],
        ['就医服务', '电话咨询', '1次/年', '√'],
      ],
    }],
  }]);

  const parent = chunks.find((chunk) => chunk.chunkType === 'parent');
  const table = chunks.find((chunk) => chunk.chunkType === 'table');
  assert.equal(chunks.some((chunk) => chunk.chunkType === 'child'), false);
  assert.match(parent.content, /服务类别 \| 服务项目 \| 服务次数 \| 计划一/u);
  assert.match(table.content, /就医服务 \| 电话咨询 \| 1次\/年 \| √/u);
  assert.doesNotMatch(parent.content, /服务类别\n服务项目\n服务次数/u);
});
