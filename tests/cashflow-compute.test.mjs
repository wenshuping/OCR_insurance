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
