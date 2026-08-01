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
  const deathParent = chunks.find((chunk) => chunk.id === death.parentChunkId);
  assert.ok(deathParent);
  assert.equal(deathParent.chunkType, 'parent');
  assert.equal(deathParent.pageStart, 1);
  assert.equal(deathParent.pageEnd, 2);
  assert.match(deathParent.content, /被保险人身故/u);
  assert.match(deathParent.content, /给付后本合同终止/u);
  assert.equal(deathParent.payload.isSectionParent, true);
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

test('table pages keep narrative elements in a child chunk without duplicating structured table cells', () => {
  const chunks = chunkProductDocument({
    document: { id: 'doc_table_narrative', fileName: '医疗险课件.pptx', documentType: 'training_deck', sourceAuthority: 'company_material', payload: {} },
    product: { company: '测试保险公司', productName: '测试医疗险' },
    pages: [{
      pageNo: 17,
      rawText: '测试医疗险\n三档保障计划的3点区别\n年度免赔额不同\n计划一1万元',
      headings: [],
      layout: { elements: [
        { kind: 'text', text: '测试医疗险' },
        { kind: 'text', text: '三档保障计划的3点区别' },
        { kind: 'text', text: '年度免赔额不同' },
        { kind: 'text', text: '计划一1万元' },
      ] },
      tables: [{ rows: [['保障项目', '计划一'], ['年度免赔额不同', '计划一1万元']] }],
    }],
  });

  const child = chunks.find((chunk) => chunk.chunkType === 'child');
  const table = chunks.find((chunk) => chunk.chunkType === 'table');
  assert.ok(child);
  assert.match(child.content, /测试医疗险/u);
  assert.match(child.content, /三档保障计划的3点区别/u);
  assert.doesNotMatch(child.content, /年度免赔额不同/u);
  assert.match(table.content, /年度免赔额不同 \| 计划一1万元/u);
});

test('training deck chunks stay page-local and carry business topics', () => {
  const chunks = chunkProductDocument({
    document: {
      id: 'doc_training_1',
      fileName: '医疗险培训课件.pptx',
      documentType: 'training_deck',
      sourceAuthority: 'company_material',
      payload: {},
    },
    product: { company: '测试保险公司', productName: '安心医疗保险' },
    pages: [
      {
        pageNo: 1,
        sourceLabel: '幻灯片 1',
        headings: [],
        rawText: '产品特色：健康告知宽松，高龄客户也可投保。',
        tables: [],
      },
      {
        pageNo: 2,
        sourceLabel: '幻灯片 2',
        headings: [],
        rawText: '适合人群：关注大额医疗支出和就医品质的客户。',
        tables: [],
      },
      {
        pageNo: 3,
        sourceLabel: '幻灯片 3',
        headings: [],
        rawText: '健康管理服务适用人群',
        tables: [{
          rows: [
            ['服务项目', '适用人群'],
            ['高尿酸管理', '高尿酸血症或痛风患者'],
          ],
        }],
      },
    ],
  });

  const children = chunks.filter((chunk) => chunk.chunkType === 'child');
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((chunk) => [chunk.pageStart, chunk.pageEnd]), [[1, 1], [2, 2]]);
  assert.deepEqual(children[0].payload.businessTopics, ['product_advantage', 'underwriting']);
  assert.match(children[0].contextualPrefix, /切片主题：产品优势、投保规则/u);
  assert.deepEqual(children[1].payload.businessTopics, ['target_audience']);
  assert.match(children[1].contextualPrefix, /切片主题：适用人群/u);
  const serviceTable = chunks.find((chunk) => chunk.pageStart === 3 && chunk.chunkType === 'table');
  assert.ok(serviceTable);
  assert.deepEqual(serviceTable.payload.businessTopics, ['health_services']);
  assert.doesNotMatch(serviceTable.contextualPrefix, /切片主题：适用人群/u);
});

test('every chunk inherits document annotations without mixing notes into evidence content', () => {
  const chunks = chunkProductDocument({
    document: {
      id: 'doc_annotated_1',
      fileName: '康宁保培训.txt',
      documentType: 'training_deck',
      sourceAuthority: 'company_material',
      payload: {
        title: '康宁保产品培训',
        materialType: '产品培训课件',
        materialUsages: ['销售建议资料', '产品责任指标补充资料'],
        company: '测试保险公司',
        productNames: ['康宁保'],
        versionLabel: '2026版',
        focusTags: ['产品优势', '流动性'],
        specialInstructions: '重点核对流动性异议，备注不是条款证据。',
      },
    },
    product: { company: '测试保险公司', productName: '康宁保', versionLabel: '2026版' },
    pages: [{ pageNo: 1, sourceLabel: '第 1 页', headings: [], rawText: '等待期为90天。', tables: [] }],
  });

  assert.ok(chunks.length > 0);
  assert.equal(chunks.every((chunk) => chunk.payload.documentMetadata.title === '康宁保产品培训'), true);
  assert.deepEqual(chunks[0].payload.documentMetadata.materialUsages, ['销售建议资料', '产品责任指标补充资料']);
  assert.deepEqual(chunks[0].payload.documentMetadata.focusTags, ['产品优势', '流动性']);
  assert.equal(chunks[0].payload.documentMetadata.specialInstructions, '重点核对流动性异议，备注不是条款证据。');
  assert.match(chunks[0].contextualPrefix, /资料标题：康宁保产品培训/u);
  assert.match(chunks[0].contextualPrefix, /重点关注标签：产品优势、流动性/u);
  assert.match(chunks[0].contextualPrefix, /资料备注（非原文证据）：重点核对流动性异议/u);
  assert.equal(chunks.every((chunk) => !chunk.content.includes('重点核对流动性异议')), true);
});
