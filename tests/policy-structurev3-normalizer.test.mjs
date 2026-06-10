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

function box(cx, cy) {
  return [
    [cx - 10, cy - 10],
    [cx + 10, cy - 10],
    [cx + 10, cy + 10],
    [cx - 10, cy + 10],
  ];
}

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

test('normalizeStructureV3Inspection rebuilds collapsed PP-StructureV3 insurance-interest rows from OCR tokens', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      table_res_list: [
        {
          pred_html: '<table><tr><td>险种名称 基本保险金额 保险期间 保险费 畅行万里智赢版 60000.00元 两全保险</td></tr></table>',
          table_ocr_pred: {
            rec_texts: [
              '保险利益表',
              '保险期间',
              '保险费约定支付日',
              '保险费',
              '险种名称',
              '基本保险金额/保险金额',
              '交费方式',
              '/交费期间（续期保险费交费日期）',
              '/交费期满日',
              '至2068年9月30日零时年交',
              '每年09月30日',
              '每年3156.00元',
              '畅行万里智赢版',
              '60000.00元',
              '两全保险',
              '/10年',
              '/2033年09月30日',
              '140.00元',
              'i他男性特定疾病',
              '50000.00元',
              '至2025年09月29日一次交清',
              '保险',
              '￥3296.00',
              '首期保险费合计：（大写）叁仟贰佰玖拾陆元整',
            ],
            rec_polys: [
              box(590, 543),
              box(593, 592),
              box(952, 588),
              box(1150, 586),
              box(117, 594),
              box(354, 592),
              box(762, 591),
              box(890, 623),
              box(950, 656),
              box(634, 705),
              box(947, 701),
              box(1155, 694),
              box(143, 708),
              box(375, 708),
              box(145, 743),
              box(764, 738),
              box(950, 733),
              box(1158, 774),
              box(143, 793),
              box(376, 790),
              box(656, 786),
              box(147, 829),
              box(1142, 861),
              box(800, 870),
            ],
          },
        },
      ],
    },
  });

  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), [
    '畅行万里智赢版两全保险',
    'i他男性特定疾病保险',
  ]);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.role), ['main', 'rider']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.amount), ['60000', '50000']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.coveragePeriod), [
    '至2068年9月30日零时',
    '至2025年09月29日',
  ]);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.paymentPeriod), ['10年', '一次交清']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.premium), ['3156', '140']);
  assert.equal(result.candidates.policyFields.productName.value, '畅行万里智赢版两全保险');
  assert.equal(result.candidates.policyFields.firstPremium.value, '3296');
});

test('normalizeStructureV3Inspection distinguishes product column from responsibility column in visual tables', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      table_res_list: [
        {
          pred_html: '<table><tr><td>险种名称 保险责任名称 金额/份数 给付标准 免赔额 赔付比例</td></tr></table>',
          table_ocr_pred: {
            rec_texts: [
              '保险利益表',
              '险种名称',
              '保险责任名称',
              '金额/份数',
              '给付标准',
              '免赔额',
              '赔付比例',
              '学生平安意外伤害保险',
              '意外伤害身故和残疾保险金',
              '80000.00元',
              '附加学生平安A款定期寿险',
              '疾病身故或全残保险金',
              '80000.00元',
              '意外身故或全残保险金',
              '40.00元',
              '附加学生平安A款疾病住院医疗保险疾病住院医疗保险金',
              '800000.00元',
              '疾病特定门诊医疗保险金',
              '附加学生平安A1款意外伤害医疗保',
              '意外伤害医疗费用保险金',
              '20000.00元',
              '险',
              '附加学生平安A款住院津贴医疗保险住院津贴保险金',
              '6份',
              '保险期间：2024年08月16日零时起至2025年08月15日二十四时止，一年交费方式：一次交清',
              '保险费合计：（大写）贰佰玖拾捌元整',
              '￥298.00',
            ],
            rec_polys: [
              box(666, 587),
              box(194, 613),
              box(540, 615),
              box(802, 617),
              box(935, 615),
              box(1060, 615),
              box(1159, 616),
              box(250, 646),
              box(595, 649),
              box(801, 650),
              box(264, 676),
              box(574, 680),
              box(801, 681),
              box(573, 711),
              box(802, 712),
              box(399, 752),
              box(801, 754),
              box(583, 818),
              box(296, 876),
              box(582, 880),
              box(801, 879),
              box(154, 904),
              box(369, 1178),
              box(805, 1180),
              box(613, 1211),
              box(321, 1241),
              box(937, 1245),
            ],
          },
        },
      ],
    },
  });

  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), [
    '学生平安意外伤害保险',
    '附加学生平安A款定期寿险',
    '附加学生平安A款疾病住院医疗保险',
    '附加学生平安A1款意外伤害医疗保险',
    '附加学生平安A款住院津贴医疗保险',
  ]);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.role), [
    'main',
    'rider',
    'rider',
    'rider',
    'rider',
  ]);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.amount), [
    '80000',
    '80000',
    '800000',
    '20000',
    '',
  ]);
  assert.ok(result.candidates.plans.every((plan) => plan.coveragePeriod === '2024年08月16日零时至2025年08月15日二十四时止'));
  assert.ok(result.candidates.plans.every((plan) => plan.paymentPeriod === '一次交清'));
  assert.equal(result.candidates.policyFields.productName.value, '学生平安意外伤害保险');
  assert.equal(result.candidates.policyFields.firstPremium.value, '298');
});

test('normalizeStructureV3Inspection merges split plan rows and uses overall OCR text for people fields', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      overall_ocr_res: {
        rec_texts: [
          'NCI新华保险',
          '投保人冯力',
          '被保险人：冯力',
          '身故保险金受益人',
          '被保险人的法定继承人',
          '经投保人和被保险人同意',
        ],
      },
      table_res_list: [
        {
          pred_html: [
            '<table>',
            '<tr><td colspan="4">保险利益表 险种名称 基本保险金额/保险金额 保险期间</td></tr>',
            '<tr><td></td><td>/保障计划/份数</td><td>交费方式</td><td>保险费约定支付日 保险费 /交费期间（续期保险费交费日期） 交费期满日</td></tr>',
            '<tr><td>荣耀鑫享赢家版 终身寿险</td><td>165020.00元 终身</td><td>年交</td><td>每年06月07日 每年20000.00元</td></tr>',
            '<tr><td></td><td></td><td>/10年</td><td>/2033年06月07日</td></tr>',
            '<tr><td>金利瑞享终身寿险 （万能型）</td><td>终身</td><td>一次交清</td><td>10.00元</td></tr>',
            '<tr><td colspan="4">首期保险费合计：（大写）贰万零壹拾元整Y20010.00</td></tr>',
            '</table>',
          ].join(''),
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.company.value, '新华保险');
  assert.equal(result.candidates.policyFields.applicant.value, '冯力');
  assert.equal(result.candidates.policyFields.insured.value, '冯力');
  assert.equal(result.candidates.policyFields.beneficiary.value, '被保险人的法定继承人');
  assert.equal(result.candidates.policyFields.firstPremium.value, '20010');
  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), [
    '荣耀鑫享赢家版终身寿险',
    '金利瑞享终身寿险（万能型）',
  ]);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.role), ['main', 'rider']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.amount), ['165020', '']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.coveragePeriod), ['终身', '终身']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.paymentPeriod), ['10年', '一次交清']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.premium), ['20000', '10']);
});

test('normalizeStructureV3Inspection rebuilds labeled one-cell policy plan sections', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      parsing_res_list: [
        {
          block_label: 'table',
          block_content: [
            '<table>',
            '<tr><td>投保人：翟卿 身份证：330106198411101516 性别：男 被保险人：翟宸彬 身份证：330106201311261218 性别：男</td></tr>',
            '<tr><td>受益人 证件号码 受益顺序 受益份额 翟卿 身份证：330106198411101516 50.00% 顾晨妍 身份证：330184198610271824 50.00%</td></tr>',
            '<tr><td>险种名称：祥瑞一生终身寿险（分红型） 保险期间：2014年01月01日零时起至被保险人终身 基本保险金额：100000.00元 交费方式：年交 交费期间：20年 续期保险费交费日期：每年01月01日 保险费：每年1580.00元</td></tr>',
            '<tr><td>险种名称：住院费用医疗保险（2007） 保险期间：2014年01月01日零时起至2014年12月31日二十四时止 保险金额：10000.00元 交费方式：一次交清 保险费：330.00元</td></tr>',
            '<tr><td>可选责任的约定：癌症特别关爱金 险种名称：附加祥瑞提前给付重大疾病保险 保险期间：2014年01月01日零时起至被保险人终身 保险金额：100000.00元 交费方式：年交交费期间：20年续期保险费交费日期：每年01月01日 保险费：每年770.00元 （大写）贰仟陆佰捌拾元整 ￥2680.00 保险费合计：</td></tr>',
            '<tr><td>特别约定：未成年人死亡保险金额总和不得超过10万元。</td></tr>',
            '</table>',
          ].join(''),
        },
      ],
      overall_ocr_res: {
        rec_texts: ['新华保险'],
      },
    },
  });

  assert.equal(result.candidates.policyFields.applicant.value, '翟卿');
  assert.equal(result.candidates.policyFields.insured.value, '翟宸彬');
  assert.equal(result.candidates.policyFields.beneficiary.value, '翟卿；顾晨妍');
  assert.equal(result.candidates.policyFields.firstPremium.value, '2680');
  assert.deepEqual(result.candidates.plans.map((plan) => plan.role), ['main', 'rider', 'rider']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), [
    '祥瑞一生终身寿险（分红型）',
    '住院费用医疗保险（2007）',
    '附加祥瑞提前给付重大疾病保险',
  ]);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.amount), ['100000', '10000', '100000']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.coveragePeriod), ['终身', '2014年01月01日零时至2014年12月31日二十四时止', '终身']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.paymentPeriod), ['20年', '一次交清', '20年']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.premium), ['1580', '330', '770']);
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

test('normalizeStructureV3Inspection keeps incomplete concrete rider rows', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['附加住院医疗保险', '', '', '', ''],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });
  const report = buildStructureV3InspectionReport({
    input: 'samples/policy.jpg',
    result,
    pythonStatus: { ok: true, device: 'gpu' },
  });

  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), ['金瑞人生', '附加住院医疗保险']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.role), ['main', 'rider']);
  assert.equal(result.candidates.plans[1].amount, '');
  assert.equal(result.candidates.plans[1].paymentPeriod, '');
  assert.equal(result.candidates.plans[1].coveragePeriod, '');
  assert.equal(result.candidates.plans[1].premium, '');
  assert.doesNotMatch(report, /## 结论: 建议接入正式流程/u);
});

test('normalizeStructureV3Inspection keeps incomplete product-column rows without keywords', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['金瑞人生', '', '', '', ''],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });
  const report = buildStructureV3InspectionReport({
    input: 'samples/policy.jpg',
    result,
    pythonStatus: { ok: true, device: 'gpu' },
  });

  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.equal(result.candidates.plans[0].role, 'main');
  assert.equal(result.candidates.plans[0].name, '金瑞人生');
  assert.equal(result.candidates.plans[0].amount, '');
  assert.equal(result.candidates.plans[0].paymentPeriod, '');
  assert.equal(result.candidates.plans[0].coveragePeriod, '');
  assert.equal(result.candidates.plans[0].premium, '');
  assert.doesNotMatch(report, /## 结论: 建议接入正式流程/u);
});

test('normalizeStructureV3Inspection skips label-only rows before incomplete product rows', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['责任名称', '', '', '', ''],
            ['保障内容', '', '', '', ''],
            ['金瑞人生', '', '', '', ''],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), ['金瑞人生']);
  assert.equal(result.candidates.plans[0].role, 'main');
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

test('normalizeStructureV3Inspection skips benefit labels before the real product row', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['现金价值', '100000元', '终身', '20年交', '4334元'],
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

test('normalizeStructureV3Inspection skips benefit insurance-gold variants before the real product row', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['重大疾病保险金', '100000元', '终身', '20年交', '4334元'],
            ['身故或身体全残保险金', '100000元', '终身', '20年交', '4334元'],
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), ['金瑞人生']);
});

test('normalizeStructureV3Inspection skips responsibility labels with concrete detail cells', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['保险责任名称', '100000元', '终身', '20年交', '4334元'],
            ['重大疾病保险金责任说明', '100000元', '终身', '20年交', '4334元'],
            ['责任免除', '100000元', '终身', '20年交', '4334元'],
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), ['金瑞人生']);
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

test('normalizeStructureV3Inspection stops person fields at document labels and keeps multiple beneficiary values', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{
        type: 'text',
        text: '投保人姓名：楼媛媛 被保险人姓名：王俊曦 学校名称：学军中学 残疾保险金、意外医疗保险金受益人 被保险人本人 身故保险金受益人 被保险人的法定继承人 证件号码 保险利益表',
      }],
    },
  });

  assert.equal(result.candidates.policyFields.applicant.value, '楼媛媛');
  assert.equal(result.candidates.policyFields.insured.value, '王俊曦');
  assert.equal(result.candidates.policyFields.beneficiary.value, '被保险人本人；被保险人的法定继承人');
});

test('normalizeStructureV3Inspection extracts beneficiary names from roster columns in mixed order', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{
        type: 'text',
        text: '新华保险 投保人：吴连英 被保险人：吴连英 受益顺序 受益份额 证件号码 受益人 1 100.00% 身份证：330106195508141510 翟来深 合同生效日期：2014年01月29日',
      }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['福如东海A款终身寿险（分红型）', '60000元', '终身', '10年交', '5220元'],
            ['首期保险费合计', '', '', '', '5220元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.policyFields.applicant.value, '吴连英');
  assert.equal(result.candidates.policyFields.insured.value, '吴连英');
  assert.equal(result.candidates.policyFields.beneficiary.value, '翟来深');
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

test('normalizeStructureV3Inspection expands nested res arrays with table_res_list html', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      results: [
        {
          res: [
            {
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
          ],
        },
      ],
    },
  });

  assert.equal(result.normalized.tables[0].source, 'raw-table');
  assert.equal(result.candidates.plans[0].role, 'main');
  assert.equal(result.candidates.plans[0].name, '金瑞人生');
});

test('normalizeStructureV3Inspection parses pred_html with a title row before headers', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      table_res_list: [
        {
          pred_html: [
            '<table>',
            '<tr><td colspan="5">保险利益表</td></tr>',
            '<tr><th>险种名称</th><th>基本保险金额</th><th>保险期间</th><th>交费期间</th><th>保险费</th></tr>',
            '<tr><td>金瑞人生</td><td>100000元</td><td>终身</td><td>20年交</td><td>4334元</td></tr>',
            '<tr><td>首期保险费合计</td><td></td><td></td><td></td><td>4334元</td></tr>',
            '</table>',
          ].join(''),
        },
      ],
    },
  });

  assert.equal(result.normalized.tables[0].source, 'raw-table');
  assert.deepEqual(result.normalized.tables[0].headers, ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费']);
  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
});

test('normalizeStructureV3Inspection detects raw row headers after a title row', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      tables: [
        {
          title: '保险利益表',
          rows: [
            ['保险利益表'],
            ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
            ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });

  assert.deepEqual(result.normalized.tables[0].headers, ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费']);
  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
  assert.equal(result.candidates.plans[0].role, 'main');
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

test('normalizeStructureV3Inspection detects table_ocr_pred markdown headers after a title row', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' }],
      table_res_list: [
        {
          table_ocr_pred: [
            '| 保险利益表 |',
            '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |',
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
  assert.deepEqual(result.normalized.tables[0].headers, ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费']);
  assert.equal(result.candidates.policyFields.productName.value, '金瑞人生');
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

test('normalizeStructureV3Inspection ignores malformed null table cells without throwing', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      tables: [
        {
          cells: [
            null,
            { row: 0, col: 0, text: '保险利益表' },
          ],
        },
      ],
    },
  });

  assert.equal(result.normalized.tables.length, 0);
  assert.ok(result.normalized.warnings.includes('未识别到可用表格'));
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
  assert.match(report, /## 结论: 建议接入正式流程/u);
});

test('buildStructureV3InspectionReport does not recommend formal connection for incomplete plan rows', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [
        { type: 'title', text: '新华保险 保险单' },
        { type: 'text', text: '投保人 张三 被保险人 李四 受益人 法定' },
      ],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['金瑞人生', '100000元', '终身', '20年交', ''],
            ['首期保险费合计', '', '', '', '4334元'],
          ],
        },
      ],
    },
  });
  const report = buildStructureV3InspectionReport({
    input: 'samples/policy.jpg',
    result,
    pythonStatus: { ok: true, device: 'gpu' },
  });

  assert.doesNotMatch(report, /## 结论: 建议接入正式流程/u);
  assert.match(report, /## 结论: 需要更多样本/u);
});
