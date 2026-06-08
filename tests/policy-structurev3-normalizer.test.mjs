import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStructureV3InspectionReport,
  normalizeStructureV3Inspection,
} from '../ocr-service/policy-structurev3-normalizer.mjs';

const rawStructureFixture = {
  blocks: [
    { type: 'title', text: '新华保险 保险单' },
    { type: 'text', text: '投保人 张三' },
    { type: 'text', text: '被保险人 李四' },
    { type: 'text', text: '身故保险金受益人 法定' },
  ],
  tables: [
    {
      title: '保险利益表',
      source: 'raw-table',
      headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
      rows: [
        ['盛世荣耀终身寿险', '100000元', '终身', '20年交', '4334元'],
        ['附加住院医疗保险', '20000元', '1年', '1年交', '266元'],
        ['附加意外伤害保险', '50000元', '1年', '1年交', '400元'],
        ['首期保险费合计', '', '', '', '5000元'],
      ],
    },
  ],
};

test('normalizeStructureV3Inspection prefers raw tables and separates main, riders, and total premium', () => {
  const result = normalizeStructureV3Inspection({
    raw: rawStructureFixture,
    markdown: '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |\n| --- | --- | --- | --- | --- |\n| 错误主险 | 1元 | 1年 | 1年交 | 1元 |',
  });

  assert.equal(result.normalized.tables.length, 1);
  assert.equal(result.normalized.tables[0].source, 'raw-table');
  assert.equal(result.candidates.policyFields.company.value, '新华保险');
  assert.equal(result.candidates.policyFields.productName.value, '盛世荣耀终身寿险');
  assert.equal(result.candidates.policyFields.applicant.value, '张三');
  assert.equal(result.candidates.policyFields.insured.value, '李四');
  assert.equal(result.candidates.policyFields.beneficiary.value, '法定');
  assert.equal(result.candidates.policyFields.firstPremium.value, '5000');
  assert.deepEqual(result.candidates.plans.map((plan) => plan.role), ['main', 'rider', 'rider']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), [
    '盛世荣耀终身寿险',
    '附加住院医疗保险',
    '附加意外伤害保险',
  ]);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.amount), ['100000', '20000', '50000']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.paymentPeriod), ['20年交', '1年交', '1年交']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.coveragePeriod), ['终身', '1年', '1年']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.premium), ['4334', '266', '400']);
});

test('normalizeStructureV3Inspection falls back to markdown tables when raw tables are unavailable', () => {
  const markdown = [
    '| 险种名称 | 基本保险金额 | 保险期间 | 缴费期间 | 保险费 |',
    '| --- | --- | --- | --- | --- |',
    '| 鑫享终身寿险 | 80000元 | 终身 | 10年交 | 1234元 |',
    '| 附加豁免保险费疾病保险 | 0元 | 10年 | 10年交 | 88元 |',
    '| 首期保费合计 |  |  |  | 1322元 |',
  ].join('\n');

  const result = normalizeStructureV3Inspection({
    raw: { blocks: [{ type: 'text', text: '中国平安保险 投保人 王五 被保险人 赵六 受益人 法定' }] },
    markdown,
  });

  assert.equal(result.normalized.tables[0].source, 'markdown-table');
  assert.equal(result.candidates.policyFields.company.value, '中国平安保险');
  assert.equal(result.candidates.policyFields.productName.value, '鑫享终身寿险');
  assert.equal(result.candidates.policyFields.firstPremium.value, '1322');
  assert.equal(result.candidates.plans[0].role, 'main');
  assert.equal(result.candidates.plans[1].role, 'rider');
});

test('normalizeStructureV3Inspection marks missing fields and does not borrow values across rows', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['主险A', '100000元', '终身', '20年交', ''],
            ['附加险B', '', '1年', '1年交', '100元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.plans[0].premium, '');
  assert.equal(result.candidates.plans[1].amount, '');
  assert.ok(result.candidates.missingFields.includes('insured'));
  assert.ok(result.candidates.missingFields.includes('beneficiary'));
  assert.ok(result.normalized.warnings.some((warning) => warning.includes('缺少被保险人')));
});

test('normalizeStructureV3Inspection accepts product-column rows without insurance keywords', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.equal(result.candidates.plans[0].role, 'main');
  assert.equal(result.candidates.plans[0].premium, '4334');
});

test('normalizeStructureV3Inspection skips explanatory note rows before the real product row', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['保险责任说明：本保险合同条款如下', '', '详见条款', '', ''],
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.equal(result.candidates.plans.length, 1);
  assert.equal(result.candidates.plans[0].role, 'main');
});

test('normalizeStructureV3Inspection stops compact labeled values at the next label', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险投保人张三被保险人李四受益人法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.applicant.value, '张三');
  assert.equal(result.candidates.policyFields.insured.value, '李四');
  assert.equal(result.candidates.policyFields.beneficiary.value, '法定');
});

test('normalizeStructureV3Inspection stops beneficiary values at following labels', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险投保人张三被保险人李四受益人法定保单号12345' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.beneficiary.value, '法定');
});

test('normalizeStructureV3Inspection treats parsing_res_list block_content markdown as raw table', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      parsing_res_list: [
        {
          block_label: 'table',
          block_content: [
            '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |',
            '| --- | --- | --- | --- | --- |',
            '| 金瑞人生 | 100000元 | 终身 | 20年交 | 4334元 |',
            '| 首期保险费合计 |  |  |  | 4334元 |',
          ].join('\n'),
        },
      ],
    },
    markdown: [
      '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |',
      '| --- | --- | --- | --- | --- |',
      '| 错误外部Markdown | 1元 | 1年 | 1年交 | 1元 |',
    ].join('\n'),
  });

  assert.equal(result.normalized.tables[0].source, 'raw-table');
  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
});

test('normalizeStructureV3Inspection parses table_res_list pred_html as raw table', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      table_res_list: [
        {
          pred_html: [
            '<table>',
            '<tr><th>险种名称</th><th>基本保险金额</th><th>保险期间</th><th>交费期间</th><th>保险费</th></tr>',
            '<tr><td>金瑞人生</td><td>100000元</td><td>终身</td><td>20年交</td><td>4334元</td></tr>',
            '<tr><td>首期保险费合计</td><td></td><td></td><td></td><td>4334元</td></tr>',
            '</table>',
          ].join(''),
        },
      ],
    },
    markdown: [
      '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |',
      '| --- | --- | --- | --- | --- |',
      '| 错误外部Markdown | 1元 | 1年 | 1年交 | 1元 |',
    ].join('\n'),
  });

  assert.equal(result.normalized.tables[0].source, 'raw-table');
  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.equal(result.candidates.policyFields.firstPremium.value, '4334');
});

test('normalizeStructureV3Inspection parses table_res_list table_ocr_pred markdown as raw table', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      table_res_list: [
        {
          table_ocr_pred: [
            '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |',
            '| --- | --- | --- | --- | --- |',
            '| 金瑞人生 | 100000元 | 终身 | 20年交 | 4334元 |',
            '| 首期保险费合计 |  |  |  | 4334元 |',
          ].join('\n'),
        },
      ],
    },
    markdown: [
      '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |',
      '| --- | --- | --- | --- | --- |',
      '| 错误外部Markdown | 1元 | 1年 | 1年交 | 1元 |',
    ].join('\n'),
  });

  assert.equal(result.normalized.tables[0].source, 'raw-table');
  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.equal(result.candidates.plans[0].name, '金瑞人生');
});

test('normalizeStructureV3Inspection treats blocks and layout table markdown as raw table', () => {
  const tableBlock = {
    type: 'table',
    block_content: [
      '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |',
      '| --- | --- | --- | --- | --- |',
      '| 金瑞人生 | 100000元 | 终身 | 20年交 | 4334元 |',
      '| 首期保险费合计 |  |  |  | 4334元 |',
    ].join('\n'),
  };
  const externalMarkdown = [
    '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |',
    '| --- | --- | --- | --- | --- |',
    '| 错误外部Markdown | 1元 | 1年 | 1年交 | 1元 |',
  ].join('\n');

  for (const raw of [
    { blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }, tableBlock] },
    { layout: [tableBlock], blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }] },
  ]) {
    const result = normalizeStructureV3Inspection({ raw, markdown: externalMarkdown });

    assert.equal(result.normalized.tables[0].source, 'raw-table');
    assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  }
});

test('normalizeStructureV3Inspection ignores malformed table rows without throwing', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            'malformed row',
            { cells: ['malformed'] },
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.plans.length, 1);
  assert.equal(result.candidates.plans[0].name, '金瑞人生');
});

test('normalizeStructureV3Inspection ignores unusable malformed raw table entries', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      tables: [
        null,
        { headers: ['险种名称'], rows: 'bad' },
      ],
    },
  });

  assert.equal(result.normalized.tables.length, 0);
  assert.ok(result.normalized.warnings.includes('未识别到可用表格'));
});

test('buildStructureV3InspectionReport summarizes source quality and plan rows', () => {
  const result = normalizeStructureV3Inspection({ raw: rawStructureFixture });
  const report = buildStructureV3InspectionReport({
    input: 'samples/policy.jpg',
    result,
    pythonStatus: { ok: true, device: 'gpu' },
  });

  assert.match(report, /PP-StructureV3 离线验证报告/u);
  assert.match(report, /原始表格: 可用/u);
  assert.match(report, /主险: 盛世荣耀终身寿险/u);
  assert.match(report, /附加险: 附加住院医疗保险/u);
  assert.match(report, /首期保费合计: 5000/u);
  assert.match(report, /建议接入正式流程|需要更多样本/u);
});
