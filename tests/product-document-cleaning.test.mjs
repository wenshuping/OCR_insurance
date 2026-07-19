import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanProductDocumentPages } from '../server/product-document-cleaning.service.mjs';

test('cleaning excludes repeated page edges and standalone page numbers with an audit trail', () => {
  const pages = [1, 2, 3].map((pageNo) => ({
    pageNo,
    rawText: `某保险公司内部资料\n第${pageNo}页正文\n${pageNo}`,
    headings: [],
    layout: { elements: [
      { id: `header-${pageNo}`, kind: 'text', text: '某保险公司内部资料' },
      { id: `body-${pageNo}`, kind: 'text', text: `第${pageNo}页正文。` },
      { id: `page-${pageNo}`, kind: 'text', text: String(pageNo) },
    ] },
  }));

  const result = cleanProductDocumentPages(pages);

  assert.equal(result.cleaningVersion, 'product-document-cleaning-v1');
  assert.equal(result.pages[0].cleanedText, '第1页正文。');
  assert.deepEqual(result.pages[0].excludedElementIds, ['header-1', 'page-1']);
  assert.equal(result.operations.filter((item) => item.rule === 'classify_repeated_header_footer_v1').length, 3);
  assert.equal(result.operations.filter((item) => item.rule === 'exclude_standalone_page_number_v1').length, 3);
  assert.equal(result.operations.every((item) => item.beforeHash && item.afterHash), true);
});

test('cleaning merges obvious broken lines but preserves headings, clauses, lists, and tables', () => {
  const result = cleanProductDocumentPages([{
    pageNo: 8,
    rawText: '保险责任\n未经基本医疗保险结算的，\n给付比例为60%。\n第一条 责任范围\n（一）住院医疗\n保障项目 | 计划一',
    headings: ['保险责任'],
    layout: { elements: [
      { id: 'heading', kind: 'heading', text: '保险责任' },
      { id: 'condition', kind: 'text', text: '未经基本医疗保险结算的，\u0000  ' },
      { id: 'ratio', kind: 'text', text: '给付比例为60%。' },
      { id: 'clause', kind: 'text', text: '第一条 责任范围' },
      { id: 'list', kind: 'text', text: '（一）住院医疗' },
      { id: 'table', kind: 'table', text: '保障项目 | 计划一' },
    ] },
  }]);

  assert.equal(result.pages[0].cleanedText, '保险责任\n未经基本医疗保险结算的，给付比例为60%。\n第一条 责任范围\n（一）住院医疗\n保障项目 | 计划一');
  assert.equal(result.operations.some((item) => item.rule === 'merge_broken_lines_v1'), true);
  assert.equal(result.operations.some((item) => item.rule === 'normalize_control_characters_v1'), true);
  assert.equal(result.pages[0].rawText.includes('\n'), true);
});

test('cleaning keeps standalone PPT business numbers and excludes only proven footer page numbers', () => {
  const businessValues = ['60', '10', '105', '45192', '120', '6000'];
  const result = cleanProductDocumentPages([{
    pageNo: 8,
    rawText: [...businessValues, '8'].join('\n'),
    headings: [],
    layout: { sourceType: 'pptx', elements: [
      ...businessValues.map((value, index) => ({ id: `value-${index}`, kind: 'text', text: value })),
      { id: 'footer-page-8', kind: 'footer', text: '8' },
    ] },
  }]);

  assert.equal(result.pages[0].cleanedText, businessValues.join('\n'));
  assert.deepEqual(result.pages[0].includedElementIds, businessValues.map((_, index) => `value-${index}`));
  assert.deepEqual(result.pages[0].excludedElementIds, ['footer-page-8']);
  const pageNumberOperations = result.operations.filter((item) => item.rule === 'exclude_standalone_page_number_v1');
  assert.deepEqual(pageNumberOperations.map((item) => item.elementIds), [['footer-page-8']]);
});
