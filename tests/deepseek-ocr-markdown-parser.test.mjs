import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDeepSeekOcrMarkdown,
  parseHtmlTablesFromDeepSeekOcrMarkdown,
} from '../ocr-service/deepseek-ocr-markdown-parser.mjs';
import { parsePolicyBasicInfoFromLayoutBoxes } from '../ocr-service/policy-basic-info-layout-parser.mjs';

test('parseDeepSeekOcrMarkdown extracts lines, HTML tables, and coordinate boxes', () => {
  const markdown = `
<|ref|>title<|/ref|><|det|>[[150, 78, 784, 106]]<|/det|>
# 中国平安人寿保险股份有限公司

<|ref|>text<|/ref|><|det|>[[29, 165, 884, 195]]<|/det|>
保险合同号码：P123456789 保险合同成立及生效日：2010年12月20日 00:00

<|ref|>text<|/ref|><|det|>[[28, 190, 904, 219]]<|/det|>
投保人：张三 性别：女 生日：1970年01月06日 证件号码：330000197001010000

<|ref|>table<|/ref|><|det|>[[19, 350, 950, 404]]<|/det|>
<table><tr><td>保险项目</td><td>保险期间</td><td>交费年限</td><td>基本保险金额／份数／档次</td><td>保险费</td></tr><tr><td>投保主险：逸享人生（825）</td><td>42年</td><td>10年</td><td>120,000元</td><td>12,000.00元</td></tr></table>
`;

  const result = parseDeepSeekOcrMarkdown(markdown);

  assert.equal(result.ok, true);
  assert.match(result.ocrText, /中国平安人寿保险股份有限公司/u);
  assert.match(result.ocrText, /保险合同号码：P123456789/u);
  assert.match(result.ocrText, /保险项目 保险期间 交费年限 基本保险金额／份数／档次 保险费/u);
  assert.match(result.ocrText, /投保主险：逸享人生（825） 42年 10年 120,000元 12,000.00元/u);
  assert.doesNotMatch(result.ocrText, /<\|ref\|>|<table>/u);
  assert.ok(result.boxes.some((box) => box.text === '保险项目' && box.source === 'deepseek-ocr-html-table'));
  assert.ok(result.boxes.some((box) => box.text === '120,000元' && box.source === 'deepseek-ocr-html-table'));
  assert.equal(result.tables.length, 1);
  assert.deepEqual(result.tables[0].headers, ['保险项目', '保险期间', '交费年限', '基本保险金额／份数／档次', '保险费']);
  assert.deepEqual(result.tables[0].rows[0], ['投保主险：逸享人生（825）', '42年', '10年', '120,000元', '12,000.00元']);
});

test('parseDeepSeekOcrMarkdown boxes feed layout field matching for insurance tables', () => {
  const parsed = parseDeepSeekOcrMarkdown(`
<|ref|>title<|/ref|><|det|>[[150, 78, 784, 106]]<|/det|>
# 中国平安人寿保险股份有限公司

<|ref|>text<|/ref|><|det|>[[29, 165, 884, 195]]<|/det|>
保险合同号码：P123456789 保险合同成立及生效日：2010年12月20日 00:00

<|ref|>text<|/ref|><|det|>[[28, 190, 904, 219]]<|/det|>
投保人：张三 性别：女 生日：1970年01月06日 证件号码：330000197001010000

<|ref|>text<|/ref|><|det|>[[28, 213, 875, 240]]<|/det|>
被保险人：李四 性别：男 生日：1967年01月19日 证件号码：330000196701010000

<|ref|>table<|/ref|><|det|>[[19, 350, 950, 404]]<|/det|>
<table><tr><td>保险项目</td><td>保险期间</td><td>交费年限</td><td>基本保险金额／份数／档次</td><td>保险费</td></tr><tr><td>投保主险：逸享人生（825）</td><td>42年</td><td>10年</td><td>120,000元</td><td>12,000.00元</td></tr></table>
`);
  const layout = parsePolicyBasicInfoFromLayoutBoxes(parsed.boxes);

  assert.equal(layout.fields.policyNumber, 'P123456789');
  assert.equal(layout.fields.applicant, '张三');
  assert.equal(layout.fields.insured, '李四');
  assert.equal(layout.fields.name, '逸享人生（825）');
  assert.equal(layout.fields.coveragePeriod, '42年');
  assert.equal(layout.fields.paymentPeriod, '10年交');
  assert.equal(layout.fields.amount, '120000');
  assert.equal(layout.fields.firstPremium, '12000');
  assert.equal(layout.fieldConfidence.name, 'visual-table');
  assert.equal(layout.fieldConfidence.amount, 'visual-table');
});

test('parseHtmlTablesFromDeepSeekOcrMarkdown repairs line-broken table cells', () => {
  const tables = parseHtmlTablesFromDeepSeekOcrMarkdown(`
<table>
  <tr><th>险种名称</th><th>标准保费</th><th>基本保额</th></tr>
  <tr>
    <td>694 V2.5 美利金生<br>终身年金保险（分红型）</td>
    <td>40,32<br>0.00元</td>
    <td>3000<br>0.00元</td>
  </tr>
</table>
`);

  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, ['险种名称', '标准保费', '基本保额']);
  assert.deepEqual(tables[0].rows[0], [
    '694 V2.5 美利金生终身年金保险（分红型）',
    '40,320.00元',
    '30000.00元',
  ]);
});

test('parseDeepSeekOcrMarkdown falls back to plain markdown tables without coordinate tags', () => {
  const result = parseDeepSeekOcrMarkdown(`
| 保单年度末 | 现金价值（元） |
| --- | --- |
| 1年末 | 110.00 |
| 2年末 | 380.00 |
`);

  assert.equal(result.ok, true);
  assert.equal(result.boxes.length, 0);
  assert.match(result.ocrText, /保单年度末 现金价值（元）/u);
  assert.deepEqual(result.tables[0].headers, ['保单年度末', '现金价值（元）']);
  assert.deepEqual(result.tables[0].rows, [
    ['1年末', '110.00'],
    ['2年末', '380.00'],
  ]);
});
