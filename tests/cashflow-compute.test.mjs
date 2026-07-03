// tests/cashflow-compute.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePolicyCashflow,
  computeScenarioEntries,
} from '../server/cashflow-compute.mjs';

// ── Realistic test policies ──

const shengshiPolicy = {
  id: 500549, name: '盛世恒盈年金保险', company: '新华保险',
  amount: 1465, premium: 1200, date: '2025-12-22',
  insuredBirthday: '1988-12-16', insured: '温舒萍',
  paymentPeriod: '10年交', coveragePeriod: '至2073年12月22日',
};

const changxingPolicy = {
  id: 500552, name: '畅行万里智赢版两全保险', company: '新华保险',
  amount: 60000, premium: 3296, date: '2024-09-29',
  insuredBirthday: '1987-12-07', insured: '冯力',
  paymentPeriod: '10年交', coveragePeriod: '至2068年9月30日',
};

// ── 1. No template, no responsibilities, no indicators → empty array ──

test('computePolicyCashflow: no template, no responsibilities, no indicators → empty', () => {
  const entries = computePolicyCashflow(shengshiPolicy, null, []);
  assert.deepEqual(entries, []);
});

test('computePolicyCashflow: undefined template and empty indicators → empty', () => {
  const entries = computePolicyCashflow(changxingPolicy, undefined, []);
  assert.deepEqual(entries, []);
});

// ── 2. Template with range timing ──

test('computePolicyCashflow: template range timing → correct year range and 基本保额 amounts', () => {
  const template = {
    rules: [{
      timing: { type: 'range', start: { policyYear: 5 }, end: { beforeEvent: 'pensionStart' } },
      amount: { basis: '基本保额', factor: 1 },
      liability: '生存保险金',
    }],
    params: {},
  };
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  // effectiveYear=2025, start=2030; pensionStart=1988+55=2043, end=2042
  assert.equal(entries.length, 13);
  assert.equal(entries[0].year, 2030);
  assert.equal(entries[0].age, 42);
  assert.equal(entries[0].amount, 1465);
  assert.equal(entries[0].liability, '生存保险金');
  assert.equal(entries[0].policyId, 500549);
  assert.equal(entries[12].year, 2042);
  assert.equal(entries[12].amount, 1465);
});

test('computePolicyCashflow: template range timing with 已交保费 basis', () => {
  const template = {
    rules: [{
      timing: { type: 'range', start: { policyYear: 5 }, end: { beforeEvent: 'pensionStart' } },
      amount: { basis: '已交保费', factor: 1 },
      liability: '养老金',
    }],
    params: {},
  };
  // firstPremium=1200, paymentYears=10, totalPremium=12000
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 13);
  assert.equal(entries[0].amount, 12000);
});

// ── 3. Template with maturity timing ──

test('computePolicyCashflow: template maturity timing → single entry at coverageEndYear', () => {
  const template = {
    rules: [{
      timing: { type: 'maturity' },
      amount: { basis: '基本保额', factor: 1 },
      liability: '满期金',
    }],
    params: {},
  };
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2073);
  assert.equal(entries[0].age, 85);
  assert.equal(entries[0].amount, 1465);
  assert.equal(entries[0].liability, '满期金');
});

test('computePolicyCashflow: template maturity with max basis', () => {
  const template = {
    rules: [{
      timing: { type: 'maturity' },
      amount: { basis: 'max', factor: 1 },
      liability: '满期金',
    }],
    params: {},
  };
  // changxingPolicy: totalPremium=3296*10=32960, basicAmount=60000 → max=60000
  const entries = computePolicyCashflow(changxingPolicy, template, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2068);
  assert.equal(entries[0].age, 80);
  assert.equal(entries[0].amount, 60000);
});

test('computePolicyCashflow: template maturity with 已交保费 factor 1.2', () => {
  const template = {
    rules: [{
      timing: { type: 'maturity' },
      amount: { basis: '已交保费', factor: 1.2 },
      liability: '满期金',
    }],
    params: {},
  };
  // changxingPolicy: totalPremium=32960, * 1.2 = 39552
  const entries = computePolicyCashflow(changxingPolicy, template, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].age, 80);
  assert.equal(entries[0].amount, 39552);
});

test('computePolicyCashflow: indicator maturity uses exact coverage end age before birthday', () => {
  const indicators = [
    {
      coverageType: '现金流',
      liability: '满期生存保险金',
      unit: '公式',
      basis: '已交保费',
      formulaText: '满期生存保险金 = 实际交纳保险费',
    },
  ];

  const entries = computePolicyCashflow(changxingPolicy, null, indicators);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2068);
  assert.equal(entries[0].age, 80);
  assert.equal(entries[0].amount, 32960);
});

test('computePolicyCashflow: first premium cashflow basis uses first premium, not total paid premium or amount', () => {
  const policy = {
    id: 600001,
    name: '尊享人生年金保险（分红型）',
    company: '新华保险',
    amount: 100000,
    premium: 12000,
    date: '2025-01-01',
    insuredBirthday: '1980-01-01',
    paymentPeriod: '10年交',
    coveragePeriod: '至2035年01月01日',
  };
  const indicators = [
    {
      coverageType: '现金流',
      liability: '关爱年金',
      value: 1,
      unit: '%',
      basis: '首次交纳的基本责任的保险费',
      formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
      condition: '生效满1年',
    },
  ];

  const entries = computePolicyCashflow(policy, null, indicators);
  assert.ok(entries.length > 0);
  assert.equal(entries[0].amount, 120);
  assert.match(entries[0].calcText, /首期\/首年保费12,000元 × 1% = 120元/u);
});

// ── 4. Template with pointList timing ──

test('computePolicyCashflow: template pointList timing → entries at specific ages', () => {
  const template = {
    rules: [{
      timing: { type: 'pointList', ages: [40, 45, 50], minPolicyYear: 2 },
      amount: { basis: '基本保额', factor: 1 },
      liability: '教育金',
    }],
    params: {},
  };
  // changxingPolicy: birthYear=1987, effectiveYear=2024
  // age 40 → year 2027 (policyYear=3 >= 2) ✓
  // age 45 → year 2032 (policyYear=8 >= 2) ✓
  // age 50 → year 2037 (policyYear=13 >= 2) ✓
  const entries = computePolicyCashflow(changxingPolicy, template, []);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].year, 2027);
  assert.equal(entries[0].age, 40);
  assert.equal(entries[0].amount, 60000);
  assert.equal(entries[1].year, 2032);
  assert.equal(entries[1].age, 45);
  assert.equal(entries[2].year, 2037);
  assert.equal(entries[2].age, 50);
});

test('computePolicyCashflow: template pointList with minPolicyYear filter', () => {
  const template = {
    rules: [{
      timing: { type: 'pointList', ages: [38, 40, 45], minPolicyYear: 5 },
      amount: { basis: '基本保额', factor: 1 },
      liability: '教育金',
    }],
    params: {},
  };
  // changxingPolicy: effectiveYear=2024, birthYear=1987
  // age 38 → year 2025, policyYear=1 < 5 → excluded
  // age 40 → year 2027, policyYear=3 < 5 → excluded
  // age 45 → year 2032, policyYear=8 >= 5 → included
  const entries = computePolicyCashflow(changxingPolicy, template, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2032);
  assert.equal(entries[0].age, 45);
});

// ── 5. Template with singleAge timing ──

test('computePolicyCashflow: template singleAge timing → single entry', () => {
  const template = {
    rules: [{
      timing: { type: 'singleAge', age: 40 },
      amount: { basis: '基本保额', factor: 1 },
      liability: '婚嫁金',
    }],
    params: {},
  };
  // changxingPolicy: birthYear=1987 → year=2027, effectiveYear=2024, coverageEnd=2068
  const entries = computePolicyCashflow(changxingPolicy, template, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2027);
  assert.equal(entries[0].age, 40);
  assert.equal(entries[0].amount, 60000);
  assert.equal(entries[0].liability, '婚嫁金');
});

test('computePolicyCashflow: template singleAge before effectiveYear → filtered out', () => {
  const template = {
    rules: [{
      timing: { type: 'singleAge', age: 5 },
      amount: { basis: '基本保额', factor: 1 },
      liability: '早期领取',
    }],
    params: {},
  };
  // shengshiPolicy: birthYear=1988, age 5 → year=1993 < effectiveYear=2025 → filtered
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 0);
});

// ── 6. Cumulative calculation ──

test('computePolicyCashflow: cumulative is calculated correctly across entries', () => {
  const template = {
    rules: [{
      timing: { type: 'range', start: { policyYear: 5 }, end: { beforeEvent: 'pensionStart' } },
      amount: { basis: '基本保额', factor: 1 },
      liability: '生存保险金',
    }],
    params: {},
  };
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries[0].cumulative, 1465);
  assert.equal(entries[1].cumulative, 2930);
  assert.equal(entries[2].cumulative, 4395);
  assert.equal(entries[12].cumulative, 1465 * 13); // 19045
});

test('computePolicyCashflow: cumulative across multiple rules', () => {
  const template = {
    rules: [
      {
        timing: { type: 'range', start: { policyYear: 5 }, end: { beforeEvent: 'pensionStart' } },
        amount: { basis: '基本保额', factor: 1 },
        liability: '生存保险金',
      },
      {
        timing: { type: 'maturity' },
        amount: { basis: '已交保费', factor: 1 },
        liability: '满期金',
      },
    ],
    params: {},
  };
  // shengshiPolicy: 13 entries of 1465 + 1 entry of 12000 (totalPremium)
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 14);
  // Last range entry
  assert.equal(entries[12].year, 2042);
  assert.equal(entries[12].cumulative, 19045);
  // Maturity entry
  assert.equal(entries[13].year, 2073);
  assert.equal(entries[13].amount, 12000);
  assert.equal(entries[13].cumulative, 19045 + 12000); // 31045
});

// ── 7. Year filtering ──

test('computePolicyCashflow: entries before effectiveYear are excluded', () => {
  // singleAge 5 → year 1993 < effectiveYear 2025
  const template = {
    rules: [{
      timing: { type: 'singleAge', age: 5 },
      amount: { basis: '基本保额', factor: 1 },
      liability: '早期领取',
    }],
    params: {},
  };
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 0);
});

test('computePolicyCashflow: entries after coverageEndYear are excluded', () => {
  // singleAge 90 → year 2078 > coverageEndYear 2073
  const template = {
    rules: [{
      timing: { type: 'singleAge', age: 90 },
      amount: { basis: '基本保额', factor: 1 },
      liability: '超龄领取',
    }],
    params: {},
  };
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 0);
});

// ── 8. computeScenarioEntries ──

test('computeScenarioEntries: accident scenarios produce correct entries', () => {
  const indicators = [
    { coverageType: '意外保障', liability: '一般意外身故/全残', value: 10, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 10', condition: '' },
    { coverageType: '意外保障', liability: '步行/骑行交通意外', value: 15, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 15', condition: '' },
    { coverageType: '意外保障', liability: '客运列车/航空意外', value: 60, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 60', condition: '' },
  ];
  const entries = computeScenarioEntries(indicators, changxingPolicy);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].scenario, '一般意外身故/全残');
  assert.equal(entries[0].amount, 600000);  // 60000 * 10
  assert.equal(entries[1].amount, 900000);  // 60000 * 15
  assert.equal(entries[2].amount, 3600000); // 60000 * 60
});

test('computeScenarioEntries: skips cashflow and rule-parameter types', () => {
  const indicators = [
    { coverageType: '现金流', liability: '生存金', value: 100, formulaText: '', condition: '' },
    { coverageType: '规则参数', liability: '参数', value: 55, formulaText: '', condition: '' },
    { coverageType: '意外保障', liability: '意外身故', value: 5, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 5', condition: '' },
  ];
  const entries = computeScenarioEntries(indicators, changxingPolicy);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].scenario, '意外身故');
  assert.equal(entries[0].amount, 300000);
});

test('computeScenarioEntries: skips optional indicators unless selected', () => {
  const indicators = [
    { coverageType: '意外保障', liability: '可选航空意外', value: 20, unit: '倍', basis: '基本保额', responsibilityScope: 'optional', selectionStatus: 'unknown' },
    { coverageType: '意外保障', liability: '可选交通意外', value: 10, unit: '倍', basis: '基本保额', responsibilityScope: 'optional', selectionStatus: 'not_selected' },
    { coverageType: '意外保障', liability: '已投保航空意外', value: 5, unit: '倍', basis: '基本保额', responsibilityScope: 'optional', selectionStatus: 'selected', quantificationStatus: 'quantified' },
  ];
  const entries = computeScenarioEntries(indicators, changxingPolicy);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].scenario, '已投保航空意外');
  assert.equal(entries[0].amount, 300000);
});

test('computeScenarioEntries: nursing care with max pattern', () => {
  const indicators = [
    { coverageType: '疾病保障', liability: '护理金(18岁前)', value: null, unit: '公式', basis: '已交保费', formulaText: '实际交纳保险费，现金价值不展示', condition: '18岁前' },
    { coverageType: '疾病保障', liability: '护理金(18-61岁)', value: 1.6, unit: '倍', basis: '已交保费', formulaText: '实际交纳保险费 × 160%，现金价值不展示', condition: '18-61岁' },
    { coverageType: '疾病保障', liability: '护理金(61岁后)', value: 1.2, unit: '倍', basis: '已交保费', formulaText: 'max(实际交纳保险费 × 120%, 基本保额)，现金价值不展示', condition: '61岁后' },
  ];
  const policy = {
    id: 4, name: '安鑫优选终身护理', company: '新华保险',
    amount: 60312, premium: 2400, firstPremium: 2400, paymentPeriod: '10年',
  };
  const entries = computeScenarioEntries(indicators, policy);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].amount, 24000);   // totalPremium
  assert.equal(entries[1].amount, 38400);   // totalPremium * 1.6
  assert.equal(entries[2].amount, 60312);   // max(28800, 60312)
});

test('computeScenarioEntries: uses the matched plan amount for rider indicators', () => {
  const policy = {
    id: 10,
    name: '主险',
    amount: 50000,
    plans: [
      { name: '主险', matchedProductName: '主险', amount: 50000, canonicalProductId: 'main_1' },
      { name: '附加重疾', matchedProductName: '附加重疾', amount: 120000, canonicalProductId: 'rider_1' },
    ],
  };
  const entries = computeScenarioEntries([
    {
      coverageType: '疾病保障',
      liability: '重大疾病保险金',
      value: 50,
      unit: '%',
      basis: '基本保额',
      productName: '附加重疾',
      canonicalProductId: 'rider_1',
    },
  ], policy);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, 60000);
  assert.equal(entries[0].productName, '附加重疾');
  assert.equal(entries[0].formula, '120,000 × 50%');
});

test('computeScenarioEntries: skips account-value indicators that are not fixed amounts', () => {
  const policy = {
    id: 11,
    name: '国寿鑫福年年养老年金保险',
    amount: 60193,
    plans: [
      { name: '国寿鑫福年年养老年金保险', matchedProductName: '国寿鑫福年年养老年金保险', amount: 60193, canonicalProductId: 'main_2' },
      { name: '国寿鑫账户两全保险（万能型）（钻石版）', matchedProductName: '国寿鑫账户两全保险（万能型）（钻石版）', amount: 10000, canonicalProductId: 'account_1' },
    ],
  };
  const entries = computeScenarioEntries([
    {
      coverageType: '意外保障',
      liability: '意外身故',
      value: 50,
      unit: '%',
      basis: '保单账户价值',
      productName: '国寿鑫账户两全保险（万能型）（钻石版）',
      canonicalProductId: 'account_1',
      sourceExcerpt: '按被保险人身故时本合同个人账户价值的50%给付意外伤害身故保险金。',
    },
  ], policy);

  assert.deepEqual(entries, []);
});

test('computeScenarioEntries: skips medical ratio indicators that are not fixed amounts', () => {
  const policy = {
    id: 12,
    name: '主险',
    amount: 50000,
    plans: [
      { name: '主险', matchedProductName: '主险', amount: 50000, canonicalProductId: 'main_3' },
      { name: '特药医疗', matchedProductName: '特药医疗', amount: 3000000, canonicalProductId: 'medical_1' },
    ],
  };
  const entries = computeScenarioEntries([
    {
      coverageType: '医疗保障',
      liability: '医保结算赔付比例',
      value: 100,
      unit: '%',
      basis: '实际医疗费用',
      productName: '特药医疗',
      canonicalProductId: 'medical_1',
      sourceExcerpt: '按实际发生的合理医疗费用扣除补偿后乘以赔付比例计算。',
    },
  ], policy);

  assert.deepEqual(entries, []);
});

test('computeScenarioEntries: uses source text when basic amount multipliers are encoded as ratio names', () => {
  const policy = { id: 13, name: '两全保险', amount: 50000 };
  const entries = computeScenarioEntries([
    {
      coverageType: '意外保障',
      liability: '交通/航空等给付倍数',
      value: 20,
      unit: '倍',
      basis: '特定意外额外给付倍数',
      sourceExcerpt: '按基本保险金额的20倍给付驾乘意外伤害身故或身体全残保险金。',
    },
  ], policy);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, 1000000);
  assert.equal(entries[0].formula, '50,000 × 20倍');
});

test('computePolicyCashflow: skips parameter and account-value cashflow indicators', () => {
  const policy = {
    id: 14,
    name: '终身寿险',
    amount: 100000,
    date: '2020-01-01',
    insuredBirthday: '1980-01-01',
    coveragePeriod: '终身',
    plans: [
      { name: '终身寿险', matchedProductName: '终身寿险', amount: 100000, canonicalProductId: 'life_1' },
      { name: '万能账户', matchedProductName: '万能账户', amount: 10000, canonicalProductId: 'account_2' },
    ],
  };
  const entries = computePolicyCashflow(policy, null, [
    {
      coverageType: '现金流',
      liability: '领取起始年龄',
      value: 18,
      unit: '周岁',
      basis: '年金/养老金领取年龄',
      productName: '万能账户',
      canonicalProductId: 'account_2',
      sourceExcerpt: '若身故时被保险人处于18周岁保单周年日之前，按保单账户价值给付。',
    },
    {
      coverageType: '现金流',
      liability: '满期返还',
      value: null,
      unit: '公式',
      basis: '保单账户价值',
      formulaText: '满期返还 = 保单账户价值',
      productName: '万能账户',
      canonicalProductId: 'account_2',
    },
  ]);

  assert.deepEqual(entries, []);
});

test('computePolicyCashflow: skips optional cashflow indicators unless selected', () => {
  const optionalMaturity = {
    coverageType: '现金流',
    liability: '可选满期金',
    value: 100,
    unit: '%',
    basis: '基本保额',
    formulaText: '基本保额 × 100%',
    condition: '保障期满',
    responsibilityScope: 'optional',
    selectionStatus: 'unknown',
  };
  const selectedMaturity = { ...optionalMaturity, liability: '已投保满期金', selectionStatus: 'selected', quantificationStatus: 'quantified' };

  assert.deepEqual(computePolicyCashflow(shengshiPolicy, null, [optionalMaturity]), []);

  const entries = computePolicyCashflow(shengshiPolicy, null, [selectedMaturity]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].liability, '已投保满期金');
  assert.equal(entries[0].amount, shengshiPolicy.amount);
});

test('computeScenarioEntries skips selected optional indicators that are not quantified', () => {
  const indicators = [
    {
      coverageType: '意外保障',
      liability: '可选航空意外',
      value: 20,
      unit: '倍',
      basis: '基本保额',
      responsibilityScope: 'optional',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
    },
  ];

  assert.deepEqual(computeScenarioEntries(indicators, changxingPolicy), []);
});

test('computePolicyCashflow skips selected optional cashflow indicators that are not quantified', () => {
  const indicator = {
    coverageType: '现金流',
    liability: '可选满期金',
    value: 100,
    unit: '%',
    basis: '基本保额',
    formulaText: '基本保额 × 100%',
    responsibilityScope: 'optional',
    selectionStatus: 'selected',
    quantificationStatus: 'pending_review',
  };

  assert.deepEqual(computePolicyCashflow(shengshiPolicy, null, [indicator]), []);
});

// ── 9. Template variable substitution ──

test('computePolicyCashflow: template variable substitution from indicator', () => {
  const template = {
    rules: [{
      timing: { type: 'range', start: { policyYear: 5 }, end: { beforeEvent: '{{领取起始年龄}}' } },
      amount: { basis: '基本保额', factor: 1 },
      liability: '生存保险金',
    }],
    params: {
      pensionAge: { source: 'indicator', key: '领取起始年龄' },
    },
  };
  const indicators = [
    { coverageType: '现金流', liability: '领取起始年龄', value: 55 },
  ];
  // pensionAge resolved to 55 → beforeEvent becomes age 55 → end = 1988+55-1 = 2042
  const entries = computePolicyCashflow(shengshiPolicy, template, indicators);
  assert.equal(entries.length, 13);
  assert.equal(entries[0].year, 2030);
  assert.equal(entries[12].year, 2042);
});

test('computePolicyCashflow: template variable substitution with different age', () => {
  const template = {
    rules: [{
      timing: { type: 'range', start: { policyYear: 5 }, end: { beforeEvent: '{{领取起始年龄}}' } },
      amount: { basis: '基本保额', factor: 1 },
      liability: '生存保险金',
    }],
    params: {
      pensionAge: { source: 'indicator', key: '领取起始年龄' },
    },
  };
  const indicators = [
    { coverageType: '现金流', liability: '领取起始年龄', value: 60 },
  ];
  // pensionAge resolved to 60 → beforeEvent becomes age 60 → end = 1988+60-1 = 2047
  const entries = computePolicyCashflow(shengshiPolicy, template, indicators);
  assert.equal(entries.length, 18); // 2030..2047
  assert.equal(entries[0].year, 2030);
  assert.equal(entries[17].year, 2047);
});

// ── Additional: range with coverageEnd beforeEvent ──

test('computePolicyCashflow: template range with coverageEnd beforeEvent', () => {
  const template = {
    rules: [{
      timing: { type: 'range', start: { policyYear: 5 }, end: { beforeEvent: 'coverageEnd' } },
      amount: { basis: '基本保额', factor: 2 },
      liability: '养老年金',
    }],
    params: {},
  };
  // shengshiPolicy: start=2030, end=coverageEndYear-1=2072 → 43 entries
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 43);
  assert.equal(entries[0].year, 2030);
  assert.equal(entries[0].amount, 2930); // 1465 * 2
  assert.equal(entries[42].year, 2072);
});

// ── Additional: entries are sorted by year ──

test('computePolicyCashflow: entries sorted by year with multiple rules', () => {
  const template = {
    rules: [
      {
        timing: { type: 'maturity' },
        amount: { basis: '基本保额', factor: 1 },
        liability: '满期金',
      },
      {
        timing: { type: 'singleAge', age: 50 },
        amount: { basis: '基本保额', factor: 1 },
        liability: '婚嫁金',
      },
    ],
    params: {},
  };
  // shengshiPolicy: singleAge 50 → year=2038, maturity → year=2073
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].year, 2038); // sorted first
  assert.equal(entries[0].liability, '婚嫁金');
  assert.equal(entries[1].year, 2073);
  assert.equal(entries[1].liability, '满期金');
});

// ── Additional: calcText is populated ──

test('computePolicyCashflow: entries have calcText for range entries', () => {
  const template = {
    rules: [{
      timing: { type: 'range', start: { policyYear: 5 }, end: { beforeEvent: 'pensionStart' } },
      amount: { basis: '基本保额', factor: 1 },
      liability: '生存保险金',
    }],
    params: {},
  };
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.ok(entries[0].calcText);
  assert.match(entries[0].calcText, /1,465/);
});

// ── Fixed amount test ──

test('computePolicyCashflow: template with fixed amount', () => {
  const template = {
    rules: [{
      timing: { type: 'singleAge', age: 45 },
      amount: { fixed: 5000 },
      liability: '固定领取',
    }],
    params: {},
  };
  // shengshiPolicy: birthYear=1988, age 45 → year=2033
  const entries = computePolicyCashflow(shengshiPolicy, template, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2033);
  assert.equal(entries[0].amount, 5000);
});

// ── 10. Responsibility text parsing path (Path 2: computeFromResponsibilities) ──

const policyWithResponsibilities = {
  id: 1, name: '测试年金', company: '测试保险',
  amount: 10000, premium: 1000, firstPremium: 1000,
  date: '2025-01-01', insuredBirthday: '1990-01-01',
  paymentPeriod: '10年交', coveragePeriod: '至2070年1月1日',
  responsibilities: [
    { scenario: '（1）生存保险金\n自本合同生效满5年的首个保单周年日起，每年按基本保额的100%给付生存保险金，至养老年金开始前。' }
  ],
};

test('computePolicyCashflow: responsibility text path produces entries when no template', () => {
  // No template provided → falls through to Path 2: responsibility text parsing
  const entries = computePolicyCashflow(policyWithResponsibilities, null, []);
  // effectiveYear=2025, birthYear=1990, coverageEndYear=2070
  // Pattern A: "生效满5年...首个保单周年日" → startYear=2030
  // No "养老年金开始领取日" match, so endYear=coverageEndYear-1=2069
  // Entries: years 2030..2069 = 40 entries
  assert.ok(entries.length > 0, 'responsibility text path should produce entries');
  assert.equal(entries[0].year, 2030);
  assert.equal(entries[0].amount, 10000); // basicAmount * 100%
  assert.equal(entries[0].age, 40); // 2030 - 1990
  assert.equal(entries[0].liability, '生存保险金');
});

test('computePolicyCashflow: responsibility text path skips unselected optional rows', () => {
  const policy = {
    ...policyWithResponsibilities,
    optionalResponsibilities: [
      {
        productName: '测试年金',
        coverageType: '可选责任',
        liability: '生存保险金',
        selectionStatus: 'unknown',
      },
    ],
  };
  const entries = computePolicyCashflow(policy, null, []);
  assert.deepEqual(entries, []);
});

test('computePolicyCashflow: responsibility text path skips unselected optional sections inside combined terms', () => {
  const policy = {
    id: 20,
    company: '测试保险',
    name: '测试年金',
    amount: 50000,
    firstPremium: 5000,
    date: '2020-01-01',
    insuredBirthday: '1980-01-01',
    paymentPeriod: '10年交',
    coveragePeriod: '30年',
    responsibilities: [
      {
        scenario: [
          '1. 基本责任',
          '（1）生存保险金',
          '被保险人生存至保险期间届满，我们按本合同基本保险金额给付生存保险金。',
          '2. 可选责任',
          '（1）成家立业金',
          '被保险人于30周岁保单周年日零时生存，我们按基本保险金额的2倍给付成家立业金。',
        ].join('\n'),
      },
    ],
    optionalResponsibilities: [
      {
        coverageType: '现金流',
        liability: '成家立业金',
        selectionStatus: 'not_selected',
        quantificationStatus: 'quantified',
      },
    ],
  };

  const entries = computePolicyCashflow(policy, null, []);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].liability, '生存保险金');
});

test('computePolicyCashflow: responsibility text path skips medical reimbursement continuation terms', () => {
  const policy = {
    id: 21,
    company: '测试保险',
    name: '学生平安意外伤害保险',
    amount: 80000,
    firstPremium: 100,
    date: '2024-08-16',
    insuredBirthday: '2009-06-08',
    paymentPeriod: '趸交',
    coveragePeriod: '至2025年08月15日',
    responsibilities: [
      {
        scenario: [
          '保险责任',
          '在本合同保险期间内，本公司承担下列保险责任：',
          '1. 被保险人已参加公费医疗或基本医疗保险，且在申请理赔时已获得补偿。',
          '2. 被保险人在申请理赔时未参加公费医疗或基本医疗保险，或被保险人已参加公费医疗但未获得补偿。',
          '被保险人因疾病在本公司认可医院治疗，至保险期间届满时治疗仍未结束的，本公司继续承担保险责任。',
          '被保险人不论一次或多次因疾病产生的合理医疗费用，本公司均按本条约定分别给付保险金，累计给付达到本合同保险金额时，本合同终止。',
        ].join('\n'),
      },
    ],
  };

  const entries = computePolicyCashflow(policy, null, []);

  assert.deepEqual(entries, []);
});

test('computePolicyCashflow: responsibility text path has calcText on entries', () => {
  const entries = computePolicyCashflow(policyWithResponsibilities, null, []);
  assert.ok(entries.length > 0);
  // calcText should be present and contain the basic amount
  assert.ok(entries[0].calcText, 'calcText should be present');
  assert.match(entries[0].calcText, /10,000/, 'calcText should contain formatted amount');
});

test('computePolicyCashflow: responsibility text path cumulative is correct', () => {
  const entries = computePolicyCashflow(policyWithResponsibilities, null, []);
  assert.ok(entries.length >= 2);
  // Cumulative is recomputed at top level after sort
  assert.equal(entries[0].cumulative, 10000);
  assert.equal(entries[1].cumulative, 20000);
  assert.equal(entries[entries.length - 1].cumulative, entries.length * 10000);
});

test('computePolicyCashflow: responsibility text path expands child education staged benefits', () => {
  const policy = {
    id: 508870,
    company: '新华保险',
    name: '成长阳光少儿两全保险(A款)（分红型）',
    amount: 38760,
    firstPremium: 5475,
    date: '2014-01-01',
    insuredBirthday: '2013-11-26',
    paymentPeriod: '18年交',
    coveragePeriod: '至2041年12月31日',
    responsibilities: [
      {
        scenario: [
          '（一）被保险人生存保险金',
          '1、大学教育金 被保险人生存至十八——二十一周岁生效对应日，本公司分别按该保单在每一生效对应日有效保险金额的20%给付大学教育金。',
          '2、深造金 被保险人生存至二十二周岁生效对应日，本公司按该保单生效对应日有效保险金额的60%给付深造金。',
          '3、立业金 被保险人生存至二十五周岁生效对应日，本公司按该保单生效对应日有效保险金额的80%给付立业金。',
          '4、婚嫁金 被保险人生存至二十八周岁生效对应日，本公司按该保单生效对应日有效保险金额的80%给付婚嫁金。',
        ].join('\n'),
      },
    ],
  };

  const entries = computePolicyCashflow(policy, null, []);

  assert.deepEqual(entries.map((entry) => [entry.year, entry.age, entry.liability, entry.amount]), [
    [2031, 18, '大学教育金', 7752],
    [2032, 19, '大学教育金', 7752],
    [2033, 20, '大学教育金', 7752],
    [2034, 21, '大学教育金', 7752],
    [2035, 22, '深造金', 23256],
    [2038, 25, '立业金', 31008],
    [2041, 28, '婚嫁金', 31008],
  ]);
  assert.equal(entries.at(-1).cumulative, 116280);
});

test('computePolicyCashflow: responsibility parser ignores OCR-split decimal multipliers', () => {
  const policy = {
    id: 500552,
    company: '新华保险',
    name: '畅行万里智赢版两全保险',
    amount: 60000,
    firstPremium: 3296,
    date: '2024-09-30',
    insuredBirthday: '1987-12-07',
    paymentPeriod: '10年交',
    coveragePeriod: '至2068年9月30日零时',
    responsibilities: [
      {
        scenario: [
          '1. 满期生存保险金',
          '被保险人生存至保险期间届满，我们按本合同实际交纳的保险费给付满期生存保险金，本合同终止。',
          '2. 疾病身故或身体全残保险金',
          '41 周岁保单周年日（含）之后、61 周岁保单周年日（不含）之前 本合同实际交纳的保险费的',
          '1. 4 倍 61 周岁保单周年日（含）之后 本合同实际交纳的保险费的',
          '1. 2 倍',
          '3. 一般意外伤害身故或身体全残保险金',
          '被保险人因意外伤害身故，我们按基本保险金额的10倍给付。',
        ].join('\n'),
      },
    ],
  };

  const entries = computePolicyCashflow(policy, null, []);

  assert.deepEqual(entries.map((entry) => [entry.year, entry.liability, entry.amount]), [
    [2068, '满期生存保险金', 32960],
  ]);
});

test('computePolicyCashflow: indicator source replaces policy-level duplicate responsibility amount', () => {
  const policy = {
    id: 15,
    company: '测试保险',
    name: '测试两全',
    amount: 50000,
    firstPremium: 3291,
    date: '2020-01-01',
    insuredBirthday: '1989-01-01',
    paymentPeriod: '10年交',
    coveragePeriod: '40年',
    plans: [
      {
        company: '测试保险',
        role: 'main',
        name: '测试两全',
        matchedProductName: '测试两全',
        amount: 50000,
        premium: 3105,
        paymentPeriod: '10年交',
        coveragePeriod: '40年',
        canonicalProductId: 'main_4',
      },
      {
        company: '测试保险',
        role: 'rider',
        name: '测试医疗',
        matchedProductName: '测试医疗',
        amount: 3000000,
        premium: 186,
        canonicalProductId: 'medical_2',
      },
    ],
    responsibilities: [
      { scenario: '（1）满期生存保险金\n被保险人生存至保险期间届满，我们按本合同实际交纳的保险费给付满期生存保险金。' },
    ],
  };
  const entries = computePolicyCashflow(policy, null, [
    {
      coverageType: '现金流',
      liability: '满期生存保险金',
      value: null,
      unit: '公式',
      basis: '已交保费',
      formulaText: '满期生存保险金 = 实际交纳保险费',
      productName: '测试两全',
      canonicalProductId: 'main_4',
      sourceExcerpt: '满期生存保险金被保险人生存至保险期间届满，我们按本合同实际交纳的保险费给付满期生存保险金。',
    },
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, 31050);
  assert.equal(entries[0].cumulative, 31050);
  assert.equal(entries[0].calcText, '实际交纳保险费 = 31,050元');
});

test('computePolicyCashflow: dedupes synonymous maturity entries across responsibility and indicator sources', () => {
  const policy = {
    id: 500744,
    company: '中国人寿',
    name: '国寿鑫颐宝两全保险（2024版）',
    amount: 159948,
    firstPremium: 12000,
    date: '2024-12-05',
    insuredBirthday: '1987-12-02',
    paymentPeriod: '10年交',
    coveragePeriod: '至60岁',
    plans: [
      {
        company: '中国人寿',
        role: 'main',
        name: '国寿鑫颐宝两全保险（2024版）',
        matchedProductName: '国寿鑫颐宝两全保险（2024版）',
        amount: 159948,
        premium: 12000,
        paymentPeriod: '',
        coveragePeriod: '',
        canonicalProductId: 'product_ebc4958897c71d57',
      },
    ],
    responsibilities: [
      {
        scenario: '二、满期保险金\n被保险人生存至本合同保险期间届满的年生效对应日，本合同终止，本公司按本合同基本保险金额给付满期保险金。',
      },
    ],
  };

  const entries = computePolicyCashflow(policy, null, [
    {
      id: 'ind_8305e5dc67ca675931',
      coverageType: '现金流',
      liability: '满期返还',
      value: 100,
      unit: '%',
      basis: '基本保额',
      productName: '国寿鑫颐宝两全保险（2024版）',
      canonicalProductId: 'product_ebc4958897c71d57',
      sourceExcerpt: '二、满期保险金被保险人生存至本合同保险期间届满的年生效对应日，本合同终止，本公司按本合同基本保险金额给付满期保险金',
    },
  ]);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries.map((entry) => ({
    year: entry.year,
    age: entry.age,
    amount: entry.amount,
    cumulative: entry.cumulative,
    liability: entry.liability,
    calcText: entry.calcText,
  })), [
    {
      year: 2047,
      age: 60,
      amount: 159948,
      cumulative: 159948,
      liability: '满期保险金',
      calcText: '基本保额 = 159,948元',
    },
  ]);
});

test('computePolicyCashflow: keeps same-year same-amount distinct liabilities separate', () => {
  const policy = {
    id: 16,
    company: '测试保险',
    name: '测试年金',
    amount: 50000,
    firstPremium: 5000,
    date: '2020-01-01',
    insuredBirthday: '1980-01-01',
    paymentPeriod: '10年交',
    coveragePeriod: '30年',
    responsibilities: [
      { scenario: '一、生存保险金\n被保险人生存至保险期间届满的年生效对应日，我们按本合同基本保险金额给付生存保险金。\n二、祝寿金\n被保险人生存至保险期间届满的年生效对应日，我们按本合同基本保险金额给付祝寿金。' },
    ],
  };

  const entries = computePolicyCashflow(policy, null, []);

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => ({
    year: entry.year,
    amount: entry.amount,
    liability: entry.liability,
    cumulative: entry.cumulative,
  })), [
    { year: 2050, amount: 50000, liability: '生存保险金', cumulative: 50000 },
    { year: 2050, amount: 50000, liability: '祝寿金', cumulative: 100000 },
  ]);
});

test('computePolicyCashflow: does not merge special maturity benefits into standard maturity', () => {
  const policy = {
    id: 17,
    company: '测试保险',
    name: '测试两全',
    amount: 50000,
    firstPremium: 5000,
    date: '2020-01-01',
    insuredBirthday: '1980-01-01',
    paymentPeriod: '10年交',
    coveragePeriod: '30年',
    responsibilities: [
      { scenario: '一、特别满期保险金\n被保险人生存至保险期间届满的年生效对应日，我们按本合同基本保险金额给付特别满期保险金。' },
    ],
  };

  const entries = computePolicyCashflow(policy, null, [
    {
      id: 'standard_maturity_indicator',
      coverageType: '现金流',
      liability: '满期返还',
      value: 100,
      unit: '%',
      basis: '基本保额',
      productName: '测试两全',
      sourceExcerpt: '满期保险金被保险人生存至本合同保险期间届满的年生效对应日，我们按本合同基本保险金额给付满期保险金。',
    },
  ]);

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.liability), ['特别满期保险金', '满期返还']);
  assert.deepEqual(entries.map((entry) => entry.cumulative), [50000, 100000]);
});

test('computePolicyCashflow: source excerpt stops survival benefit before pension start age', () => {
  const policy = {
    id: 18,
    company: '测试保险',
    name: '测试年金',
    amount: 1465,
    firstPremium: 11000,
    date: '2025-12-22',
    insuredBirthday: '1988-12-16',
    paymentPeriod: '10年交',
    coveragePeriod: '至2073年12月22日',
  };

  const entries = computePolicyCashflow(policy, null, [
    {
      id: 'survival',
      coverageType: '现金流',
      liability: '生存保险金',
      value: 100,
      unit: '%',
      basis: '基本保额',
      productName: '测试年金',
      sourceExcerpt: '（1）生存保险金 若被保险人于本合同生效满五年的首个保单周年日（含）起至养老年金开始领取日（不含）之前，在每个保单周年日零时生存，我们按基本保险金额给付生存保险金。',
    },
    {
      id: 'pension_start',
      coverageType: '现金流',
      liability: '领取起始年龄',
      value: 55,
      unit: '周岁',
      basis: '年金/养老金领取年龄',
      productName: '测试年金',
    },
    {
      id: 'pension',
      coverageType: '现金流',
      liability: '养老年金',
      value: 100,
      unit: '%',
      basis: '基本保额',
      productName: '测试年金',
      sourceExcerpt: '（2）养老年金 被保险人于养老年金开始领取日（含）起至保险期间届满之前，在每个保单周年日零时生存，我们按基本保险金额给付养老年金。',
    },
  ]);

  assert.equal(entries.length, 43);
  assert.equal(entries.filter((entry) => entry.liability === '生存保险金').at(-1).year, 2042);
  assert.deepEqual(entries.filter((entry) => entry.year === 2043).map((entry) => entry.liability), ['养老年金']);
});

test('computePolicyCashflow: normalizes maturity source excerpt names before merging', () => {
  const policy = {
    id: 19,
    company: '测试保险',
    name: '测试两全',
    amount: 50000,
    firstPremium: 5000,
    date: '2020-01-01',
    insuredBirthday: '1980-01-01',
    paymentPeriod: '10年交',
    coveragePeriod: '30年',
    responsibilities: [
      { scenario: '一、满期生存保险金 被保险人生存至保险期间届满，我们按本合同实际交纳的保险费给付满期生存保险金。' },
    ],
  };

  const entries = computePolicyCashflow(policy, null, [
    {
      id: 'maturity_source',
      coverageType: '现金流',
      liability: '满期生存保险金',
      unit: '公式',
      basis: '已交保费',
      productName: '测试两全',
      sourceExcerpt: '（1）满期生存保险金被保险人生存至保险期间届满，我们按本合同实际交纳的保险费给付满期生存保险金。',
    },
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2050);
  assert.equal(entries[0].liability, '满期生存保险金');
});

test('computePolicyCashflow: expands China Life multi-plan annuity source excerpts with plan amounts', () => {
  const policy = {
    id: 500747,
    company: '中国人寿',
    name: '国寿鑫福年年养老年金保险',
    amount: 60193,
    firstPremium: 100007,
    date: '2015-12-31',
    insuredBirthday: '1978-12-20',
    paymentPeriod: '5年交',
    coveragePeriod: '44年',
    plans: [
      {
        company: '中国人寿',
        role: 'main',
        name: '国寿鑫福年年养老年金保险',
        matchedProductName: '国寿鑫福年年养老年金保险',
        amount: 60193,
        coveragePeriod: '44年',
        paymentPeriod: '5年交',
        premium: 29491,
        canonicalProductId: 'product_d02553971f2be98b',
      },
      {
        company: '中国人寿',
        role: 'rider',
        name: '国寿鑫福年年年金保险',
        matchedProductName: '国寿鑫福年年年金保险',
        amount: 56622,
        coveragePeriod: '24年',
        paymentPeriod: '5年交',
        premium: 70506,
        canonicalProductId: 'product_8e7d078e82a21134',
      },
      {
        company: '中国人寿',
        role: 'linked_account',
        name: '国寿鑫账户两全保险（万能型）（钻石版）',
        matchedProductName: '国寿鑫账户两全保险（万能型）（钻石版）',
        amount: 10000,
        coveragePeriod: '终身',
        paymentPeriod: '不定期交',
        premium: 10,
        canonicalProductId: 'product_b5a9a593e3d42135',
      },
    ],
  };
  const indicators = [
    {
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 15,
      unit: '%',
      basis: '基本保额',
      productName: '国寿鑫福年年养老年金保险',
      canonicalProductId: 'product_d02553971f2be98b',
      sourceExcerpt: '第五条保险责任在本合同保险期间内，本公司承担以下保险责任：一、养老年金自本合同约定的养老年金开始领取日起至被保险人年满八十周岁的年生效对应日前，若被保险人生存至本合同的年生效对应日，本公司每年按本合同基本保险金额的15%给付养老年金',
    },
    {
      coverageType: '现金流',
      liability: '满期返还',
      value: 100,
      unit: '%',
      basis: '基本保额',
      productName: '国寿鑫福年年养老年金保险',
      canonicalProductId: 'product_d02553971f2be98b',
      sourceExcerpt: '三、满期保险金被保险人生存至年满八十周岁的年生效对应日，本合同终止，本公司按本合同基本保险金额给付满期保险金',
    },
    {
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 12,
      unit: '%',
      basis: '基本保额',
      productName: '国寿鑫福年年年金保险',
      canonicalProductId: 'product_8e7d078e82a21134',
      sourceExcerpt: '第五条保险责任在本合同保险期间内，本公司承担以下保险责任：一、年金自本合同生效之日起至本合同保险期间届满的年生效对应日前，若被保险人生存至本合同的年生效对应日，本公司每年按下列约定给付年金：首次给付的年金为本合同及国寿鑫福年年养老年金保险合同首次交纳的保险费的12%，以后每年按本合同基本保险金额的15%给付年金',
    },
  ];

  const entries = computePolicyCashflow(policy, null, indicators);
  const riderFirst = entries.find((entry) => entry.productName === '国寿鑫福年年年金保险' && entry.year === 2015);
  const riderLater = entries.find((entry) => entry.productName === '国寿鑫福年年年金保险' && entry.year === 2038);
  const pensionFirst = entries.find((entry) => entry.productName === '国寿鑫福年年养老年金保险' && entry.year === 2039);
  const maturity = entries.find((entry) => entry.productName === '国寿鑫福年年养老年金保险' && entry.year === 2059);

  assert.equal(entries.length, 45);
  assert.equal(riderFirst.amount, 12000);
  assert.equal(riderLater.amount, 8493);
  assert.equal(pensionFirst.amount, 9029);
  assert.equal(maturity.amount, 60193);
});
