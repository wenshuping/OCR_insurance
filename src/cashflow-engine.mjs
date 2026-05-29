// src/cashflow-engine.mjs

/**
 * 解析 condition 文本，返回 { startYear, endYear } 或 null。
 * @param {string} condition
 * @param {{ effectiveYear: number, birthYear: number, coverageEndYear: number }} ctx
 * @returns {{ startYear: number, endYear: number } | null}
 */
export function parseConditionYearRange(condition, ctx) {
  const text = String(condition || '').trim();
  if (!text) return null;

  // "生效满N年...到..."
  const effectiveMatch = text.match(/生效满(\d+)年/);
  if (effectiveMatch) {
    const startYear = ctx.effectiveYear + Number(effectiveMatch[1]);
    let endYear = ctx.coverageEndYear - 1;
    if (/届满前|保障期满前/.test(text)) endYear = ctx.coverageEndYear - 1;
    if (/养老年金开始前/.test(text)) {
      const pensionStartYear = ctx.birthYear + 55;
      endYear = Math.min(endYear, pensionStartYear - 1);
    }
    return { startYear, endYear };
  }

  // "N周岁后首个保单周年日...到届满前"
  const ageMatch = text.match(/(\d+)周岁后/);
  if (ageMatch) {
    const startYear = ctx.birthYear + Number(ageMatch[1]);
    const endYear = /届满前|保障期满前/.test(text) ? ctx.coverageEndYear - 1 : ctx.coverageEndYear;
    return { startYear, endYear };
  }

  // "保障期满" / "届满"
  if (/保障期满|届满/.test(text)) {
    return { startYear: ctx.coverageEndYear, endYear: ctx.coverageEndYear };
  }

  return null;
}

function parsePaymentYearsFromText(value) {
  const text = String(value || '').replace(/\s/g, '');
  if (/趸交|一次交清/.test(text)) return 1;
  const yearMatch = text.match(/(\d+(?:\.\d+)?)年/);
  if (yearMatch) return Number(yearMatch[1]);
  const periodMatch = text.match(/(\d+(?:\.\d+)?)期/);
  if (periodMatch) return Number(periodMatch[1]);
  return 0;
}

function parseCoverageEndYear(policy) {
  const text = String(policy.coveragePeriod || '').trim();
  const ageMatch = text.match(/(\d+)\s*周岁/);
  if (ageMatch && policy.insuredBirthday) {
    const birthYear = new Date(policy.insuredBirthday).getFullYear();
    return birthYear + Number(ageMatch[1]);
  }
  const dateMatch = text.match(/(\d{4})-\d{2}-\d{2}/);
  if (dateMatch) return Number(dateMatch[1]);
  const yearMatch = text.match(/(\d+)\s*年/);
  if (yearMatch && policy.date) {
    const effectiveYear = new Date(policy.date).getFullYear();
    return effectiveYear + Number(yearMatch[1]);
  }
  return 0;
}

function resolveIndicatorAmountForCashflow(indicator, policy) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''} ${indicator.liability || ''}`;
  if (/实际交纳|已交保费|所交保费/.test(text)) {
    const premium = Number(policy.firstPremium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    return premium * years;
  }
  const value = Number(indicator.value);
  const unit = String(indicator.unit || '').trim();
  const basis = String(indicator.basis || '').trim();
  const amount = Number(policy.amount || 0);
  if (/%/.test(unit) && /基本保额/.test(basis)) return amount * value / 100;
  if (/倍/.test(unit) && /基本保额/.test(basis)) return amount * value;
  if (/基本保额/.test(basis) && /公式/.test(unit)) return amount;
  return amount || 0;
}

function formatCashflowCalculation(indicator, policy, amount) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''}`;
  if (/实际交纳|已交保费/.test(text)) {
    const premium = Number(policy.firstPremium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    if (years > 1) return `${premium.toLocaleString('zh-CN')} × ${years} = ${amount.toLocaleString('zh-CN')}元`;
    return `保费 = ${amount.toLocaleString('zh-CN')}元`;
  }
  if (/基本保额/.test(text)) return `基本保额 = ${amount.toLocaleString('zh-CN')}元`;
  return indicator.formulaText || `${amount.toLocaleString('zh-CN')}元`;
}

/**
 * 将单个现金流指标展开为年度条目。
 * @param {object} indicator - CoverageIndicator
 * @param {object} policy - Policy
 * @returns {Array<object>} CashflowEntry[]
 */
export function expandCashflowIndicator(indicator, policy) {
  if (!policy.insuredBirthday || !policy.date) return [];
  const effectiveYear = new Date(policy.date).getFullYear();
  const birthYear = new Date(policy.insuredBirthday).getFullYear();
  const coverageEndYear = parseCoverageEndYear(policy);
  if (!coverageEndYear) return [];

  const range = parseConditionYearRange(indicator.condition, { effectiveYear, birthYear, coverageEndYear });
  if (!range) return [];

  const conditionText = String(indicator.condition || '');
  if (/到养老年金开始前/.test(conditionText)) {
    const pensionStartYear = birthYear + 55;
    range.endYear = Math.min(range.endYear, pensionStartYear - 1);
  }

  const amount = resolveIndicatorAmountForCashflow(indicator, policy);
  if (amount <= 0) return [];

  const entries = [];
  let cumulative = 0;
  for (let year = range.startYear; year <= range.endYear; year++) {
    cumulative += amount;
    entries.push({
      year,
      age: year - birthYear,
      amount,
      cumulative,
      liability: indicator.liability || '现金流',
      policyId: policy.id,
      productName: policy.name || indicator.productName || '',
      calculationText: formatCashflowCalculation(indicator, policy, amount),
    });
  }
  return entries;
}

function resolveScenarioAmount(indicator, policy) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''}`;
  const value = Number(indicator.value);
  const basis = String(indicator.basis || '');
  const amount = Number(policy.amount || 0);

  // max() pattern takes priority — e.g. max(实际交纳保险费 × 120%, 基本保额)
  if (/max/i.test(indicator.formulaText || '')) {
    const premium = Number(policy.firstPremium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    const totalPremium = premium * years;
    const factorMatch = (indicator.formulaText || '').match(/(\d+)%/);
    const factor = factorMatch ? Number(factorMatch[1]) / 100 : 1;
    return Math.max(Math.round(totalPremium * factor), amount);
  }

  if (/实际交纳|已交保费/.test(text)) {
    const premium = Number(policy.firstPremium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    const totalPremium = premium * years;
    if (value && /倍|×/.test(String(indicator.unit || '') + indicator.formulaText || '')) {
      return Math.round(totalPremium * value);
    }
    return totalPremium;
  }
  if (value && /基本保额/.test(basis)) {
    if (/倍/.test(indicator.unit || '')) return amount * value;
    if (/%/.test(indicator.unit || '')) return Math.round(amount * value / 100);
  }
  return amount;
}

function buildScenarioFormula(indicator, policy, amount) {
  if (indicator.formulaText) return indicator.formulaText;
  const value = Number(indicator.value);
  const basis = String(indicator.basis || '');
  if (/基本保额/.test(basis) && value) {
    return `${Number(policy.amount || 0).toLocaleString('zh-CN')} × ${value}`;
  }
  return `${amount.toLocaleString('zh-CN')}`;
}

/**
 * 为非现金流指标（意外/疾病/护理）构建场景条目。
 * @param {Array<object>} indicators - CoverageIndicator[]
 * @param {object} policy - Policy
 * @returns {Array<object>} ScenarioEntry[]
 */
export function buildScenarioEntries(indicators, policy) {
  const entries = [];
  for (const indicator of indicators) {
    if (indicator.coverageType === '现金流') continue;
    if (/账户价值|现金价值/.test(indicator.formulaText || '') &&
        !/现金价值不展示/.test(indicator.formulaText || '')) continue;

    const amount = resolveScenarioAmount(indicator, policy);
    const formula = buildScenarioFormula(indicator, policy, amount);

    entries.push({
      scenario: indicator.liability || indicator.coverageType || '保障责任',
      formula,
      amount,
      condition: indicator.condition || '',
      policyId: policy.id,
      productName: policy.name || indicator.productName || '',
      calculationText: `${formula} = ${amount.toLocaleString('zh-CN')}元`,
    });
  }
  return entries;
}

/**
 * 为保单列表生成现金流计划。
 * @param {Array<object>} policies
 * @returns {Array<object>} PolicyCashflowPlan[]
 */
export function buildPolicyCashflowPlans(policies) {
  const now = new Date();
  return policies.map((policy) => {
    const indicators = Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators : [];
    const coverageEndYear = parseCoverageEndYear(policy);
    const expired = coverageEndYear > 0 && coverageEndYear < now.getFullYear();

    const cashflowIndicators = indicators.filter((i) => i.coverageType === '现金流');
    const scenarioIndicators = indicators.filter((i) => i.coverageType !== '现金流');

    let annualEntries = [];
    for (const indicator of cashflowIndicators) {
      const entries = expandCashflowIndicator(indicator, policy);
      annualEntries.push(...entries);
    }
    annualEntries.sort((a, b) => a.year - b.year);
    let cumulative = 0;
    annualEntries = annualEntries.map((entry) => {
      cumulative += entry.amount;
      return { ...entry, cumulative };
    });

    const scenarioEntries = buildScenarioEntries(scenarioIndicators, policy);
    const totalDeterministicCashflow = annualEntries.reduce((sum, e) => sum + e.amount, 0);

    return {
      policyId: policy.id,
      productName: policy.name || '',
      company: policy.company || '',
      insured: policy.insured || '',
      insuredBirthday: policy.insuredBirthday || '',
      effectiveDate: policy.date || '',
      annualEntries,
      scenarioEntries,
      totalDeterministicCashflow,
      expired,
    };
  });
}

/**
 * 按被保人汇总年度现金流。
 * @param {Array<object>} plans - PolicyCashflowPlan[]
 * @returns {Array<object>} MemberAnnualSummary[]
 */
export function buildMemberAnnualSummaries(plans) {
  const activePlans = plans.filter((p) => !p.expired);
  const memberMap = new Map();

  for (const plan of activePlans) {
    const member = plan.insured || '未识别被保人';
    if (!memberMap.has(member)) {
      memberMap.set(member, { member, birthday: plan.insuredBirthday, yearMap: new Map() });
    }
    const data = memberMap.get(member);
    if (!data.birthday && plan.insuredBirthday) data.birthday = plan.insuredBirthday;

    for (const entry of plan.annualEntries) {
      const existing = data.yearMap.get(entry.year) || { year: entry.year, age: entry.age, totalAmount: 0, details: [] };
      existing.totalAmount += entry.amount;
      existing.details.push(entry);
      data.yearMap.set(entry.year, existing);
    }
  }

  return Array.from(memberMap.values()).map((data) => {
    const entries = Array.from(data.yearMap.values())
      .sort((a, b) => a.year - b.year);
    let cumulative = 0;
    for (const entry of entries) {
      cumulative += entry.totalAmount;
      entry.cumulative = cumulative;
    }
    return {
      member: data.member,
      birthday: data.birthday || '',
      entries,
      totalCashflow: cumulative,
    };
  });
}
