// server/cashflow-compute.mjs
// Server-side cashflow computation engine.
// Migrated from src/cashflow-engine.mjs with new template-based computation.

// ────────────────────────────────────────────────────────────────────────────
// Migrated helpers (from src/cashflow-engine.mjs)
// ────────────────────────────────────────────────────────────────────────────

/** Parse condition text for year ranges. */
function parseConditionYearRange(condition, ctx) {
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

/** Extract payment years from text like "10年交". */
function parsePaymentYearsFromText(value) {
  const text = String(value || '').replace(/\s/g, '');
  if (/趸交|一次交清/.test(text)) return 1;
  const yearMatch = text.match(/(\d+(?:\.\d+)?)年/);
  if (yearMatch) return Number(yearMatch[1]);
  const periodMatch = text.match(/(\d+(?:\.\d+)?)期/);
  if (periodMatch) return Number(periodMatch[1]);
  return 0;
}

/** Parse coverage end year from policy. */
function parseCoverageEndYear(policy) {
  const text = String(policy.coveragePeriod || '').trim();
  // "终身" — use age 105 as standard actuarial assumption
  if (/终身/.test(text) && policy.insuredBirthday) {
    const birthYear = new Date(policy.insuredBirthday).getFullYear();
    return birthYear + 105;
  }
  const ageMatch = text.match(/(\d+)\s*周岁/);
  if (ageMatch && policy.insuredBirthday) {
    const birthYear = new Date(policy.insuredBirthday).getFullYear();
    return birthYear + Number(ageMatch[1]);
  }
  // Absolute date: "2073-12-22" or "至2073年12月22日"
  const dateMatch = text.match(/(\d{4})[年\-]\d{1,2}[月\-]\d{1,2}/);
  if (dateMatch) return Number(dateMatch[1]);
  const yearMatch = text.match(/(\d+)\s*年/);
  if (yearMatch && policy.date) {
    const effectiveYear = new Date(policy.date).getFullYear();
    return effectiveYear + Number(yearMatch[1]);
  }
  return 0;
}

/** Resolve amount from indicator. */
function resolveIndicatorAmountForCashflow(indicator, policy) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''} ${indicator.liability || ''}`;
  if (/实际交纳|已交保费|所交保费/.test(text)) {
    const premium = Number(policy.firstPremium || policy.premium || 0);
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

/** Format calculation text for an indicator. */
function formatCashflowCalculation(indicator, policy, amount) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''}`;
  if (/实际交纳|已交保费/.test(text)) {
    const premium = Number(policy.firstPremium || policy.premium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    if (years > 1) return `${premium.toLocaleString('zh-CN')} × ${years} = ${amount.toLocaleString('zh-CN')}元`;
    return `保费 = ${amount.toLocaleString('zh-CN')}元`;
  }
  if (/基本保额/.test(text)) return `基本保额 = ${amount.toLocaleString('zh-CN')}元`;
  return indicator.formulaText || `${amount.toLocaleString('zh-CN')}元`;
}

/** Expand a single cashflow indicator to yearly entries. */
function expandCashflowIndicator(indicator, policy) {
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
      calcText: formatCashflowCalculation(indicator, policy, amount),
    });
  }
  return entries;
}

/** Resolve scenario amount for non-cashflow indicators. */
function resolveScenarioAmount(indicator, policy) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''}`;
  const value = Number(indicator.value);
  const basis = String(indicator.basis || '');
  const amount = Number(policy.amount || 0);

  // max() pattern takes priority
  if (/max/i.test(indicator.formulaText || '')) {
    const premium = Number(policy.firstPremium || policy.premium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    const totalPremium = premium * years;
    const factorMatch = (indicator.formulaText || '').match(/(\d+)%/);
    const factor = factorMatch ? Number(factorMatch[1]) / 100 : 1;
    return Math.max(Math.round(totalPremium * factor), amount);
  }

  if (/实际交纳|已交保费/.test(text)) {
    const premium = Number(policy.firstPremium || policy.premium || 0);
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

/** Build formula display text for scenario entries. */
function buildScenarioFormula(indicator, policy, amount) {
  if (indicator.formulaText) {
    return indicator.formulaText.replace(/[，,]\s*现金价值不展示/g, '').trim();
  }
  const value = Number(indicator.value);
  const basis = String(indicator.basis || '');
  const unit = String(indicator.unit || '');
  if (/基本保额/.test(basis) && value) {
    const unitSuffix = /%/.test(unit) ? '%' : /倍/.test(unit) ? '倍' : '';
    return `${Number(policy.amount || 0).toLocaleString('zh-CN')} × ${value}${unitSuffix}`;
  }
  return `${amount.toLocaleString('zh-CN')}`;
}

/** Split responsibility text into sections by numbered markers. */
function splitResponsibilitySections(text) {
  const markers = [];
  // Pattern 1: （N） Chinese-style numbered markers
  const cnRe = /[（(]\s*\d+\s*[）)]\s*/g;
  let m;
  while ((m = cnRe.exec(text)) !== null) {
    markers.push({ index: m.index, end: m.index + m[0].length });
  }
  // Pattern 2: "N. " Arabic numeral section markers (not decimals like 1.6)
  const arRe = /(?:^|\n)\s*(\d+)\.\s+(?!\d)/g;
  while ((m = arRe.exec(text)) !== null) {
    const markerStart = m.index + m[0].indexOf(m[1]);
    const markerEnd = markerStart + m[1].length + 1 + m[0].slice(m[0].indexOf(m[1]) + m[1].length + 1).match(/^\s*/)[0].length;
    markers.push({ index: markerStart, end: markerEnd });
  }
  markers.sort((a, b) => a.index - b.index);
  if (!markers.length) return [];

  const sections = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].end;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const chunk = text.substring(start, end).trim();
    const nameMatch = chunk.match(/^(.+?)[\s\n]/);
    const name = nameMatch ? nameMatch[1].trim() : chunk.substring(0, 10);
    sections.push({ name, content: chunk });
  }
  return sections;
}

/** Parse a single benefit section into yearly items. */
function parseBenefitSection(sec, ctx) {
  const { effectiveYear, birthYear, coverageEndYear, pensionStartAge, amount, policy } = ctx;
  const text = sec.content;
  const name = sec.name;
  const results = [];

  const benefitAmount = resolveBenefitAmount(text, amount, policy);
  if (benefitAmount <= 0) return results;

  // 模式A: "生效满N年...至...之前" → 每年领取（区间）
  const rangeStartMatch = text.match(/生效满[五5两2三3四4六6七7八8九9十10](\d*)年.*?首个保单周年日/);
  if (rangeStartMatch) {
    const waitYears = parseChineseNumber(rangeStartMatch[0]);
    const startYear = effectiveYear + waitYears;

    let endYear = coverageEndYear - 1;
    if (/养老年金开始领取日.*?(?:之前|不含)/.test(text) && pensionStartAge) {
      endYear = birthYear + pensionStartAge - 1;
    } else if (/保险期间届满.*?(?:之前|不含)/.test(text)) {
      endYear = coverageEndYear - 1;
    }

    for (let year = startYear; year <= endYear; year++) {
      results.push({ year, amount: benefitAmount, liability: name, calculationText: buildCalcText(benefitAmount, amount, text) });
    }
    return results;
  }

  // 模式B: "养老年金开始领取日（含）起至保险期间届满之前"
  if (/开始领取日.*?(?:起|含).*?至.*?届满.*?前/.test(text)) {
    if (pensionStartAge) {
      const startYear = birthYear + pensionStartAge;
      for (let year = startYear; year <= coverageEndYear - 1; year++) {
        results.push({ year, amount: benefitAmount, liability: name, calculationText: buildCalcText(benefitAmount, amount, text) });
      }
    }
    return results;
  }

  // 模式C: 多个特定周岁列表 "15周岁、18周岁、21周岁、24周岁"
  const ageListMatch = text.match(/(\d+)\s*周岁(?:[、，,]\s*(\d+)\s*周岁)+/);
  if (ageListMatch) {
    const ages = extractAgeList(text);
    const minYear = effectiveYear + parseMinPolicyYear(text);
    for (const age of ages) {
      const year = birthYear + age;
      if (year >= minYear) {
        results.push({ year, amount: benefitAmount, liability: name, calculationText: buildCalcText(benefitAmount, amount, text) });
      }
    }
    return results;
  }

  // 模式D: 单个特定周岁 "N周岁保单周年日"
  const singleAgeMatch = text.match(/(\d+)\s*周岁.*?保单周年日/);
  if (singleAgeMatch && !/至|起|开始/.test(text)) {
    const age = Number(singleAgeMatch[1]);
    const year = birthYear + age;
    if (year >= effectiveYear && year <= coverageEndYear) {
      results.push({ year, amount: benefitAmount, liability: name, calculationText: buildCalcText(benefitAmount, amount, text) });
    }
    return results;
  }

  // 模式E: "保险期间届满" / "生存至保险期间届满" → 满期一次性
  if (/保险期间届满|保障期满|届满/.test(text) && !/之前|不含|起/.test(text)) {
    results.push({ year: coverageEndYear, amount: benefitAmount, liability: name, calculationText: buildCalcText(benefitAmount, amount, text) });
    return results;
  }

  return results;
}

/** Resolve benefit amount from responsibility text. */
function resolveBenefitAmount(text, basicAmount, policy) {
  const premium = Number(policy.firstPremium || policy.premium || 0);
  const paymentYears = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
  const totalPremium = premium * paymentYears;

  if (/实际交纳.*?保险费|已交保费|所交保费/.test(text)) {
    const pctMatch = text.match(/(\d+)\s*%/);
    if (pctMatch) return Math.round(totalPremium * Number(pctMatch[1]) / 100);
    return totalPremium;
  }
  const multipleMatch = text.match(/基本保险金额[的]?\s*(\d+)\s*倍/);
  if (multipleMatch) return basicAmount * Number(multipleMatch[1]);
  const pctOfAmount = text.match(/基本保险金额[的]?\s*(\d+)\s*%/);
  if (pctOfAmount) return Math.round(basicAmount * Number(pctOfAmount[1]) / 100);
  if (/基本保险金额|基本保额/.test(text)) return basicAmount;
  if (/max|二者之[较最]大|三者之[最]/.test(text)) {
    return Math.max(totalPremium, basicAmount);
  }
  return basicAmount || 0;
}

/** Extract age list from text, e.g. [15, 18, 21, 24]. */
function extractAgeList(text) {
  const ages = [];
  const re = /(\d+)\s*周岁/g;
  let m;
  while ((m = re.exec(text)) !== null) ages.push(Number(m[1]));
  return [...new Set(ages)].sort((a, b) => a - b);
}

/** Parse minimum policy year from text. */
function parseMinPolicyYear(text) {
  const m = text.match(/生效满[五5两2三3四4六6七7八8九9十10](\d*)年.*?已经过/);
  if (m) return parseChineseNumber(m[0]);
  return 0;
}

/** Parse Chinese numerals. */
function parseChineseNumber(text) {
  const m = text.match(/生效满([五5两2三3四4六6七7八8九9十10]\d*|五|十)/);
  if (!m) return 0;
  const ch = m[1];
  if (ch === '五') return 5;
  if (ch === '十') return 10;
  return Number(ch) || 0;
}

/** Build calculation text for responsibility-based entries. */
function buildCalcText(benefitAmount, basicAmount, text) {
  if (/实际交纳.*?保险费|已交保费/.test(text)) return `实际交纳保险费 = ${benefitAmount.toLocaleString('zh-CN')}元`;
  const m = text.match(/基本保险金额[的]?\s*(\d+)\s*倍/);
  if (m) return `基本保额 ${basicAmount.toLocaleString('zh-CN')} × ${m[1]} = ${benefitAmount.toLocaleString('zh-CN')}元`;
  return `基本保额 = ${benefitAmount.toLocaleString('zh-CN')}元`;
}

/** Indicator-only fallback synthesis (no responsibility text). */
function synthesizeCashflowFromIndicatorsOnly(cashflowIndicators, policy, effectiveYear, birthYear, coverageEndYear, pensionStartAge) {
  const entries = [];
  let cumulative = 0;
  const productName = policy.name || '';

  for (const ind of cashflowIndicators) {
    const liability = String(ind.liability || '');
    const formulaText = String(ind.formulaText || '');

    if (/领取.*年龄/.test(liability)) continue; // skip parameter indicator

    if (pensionStartAge && /教育|养老金|两全|返还|年金/.test(liability) && !/满期/.test(liability)) {
      const amount = resolveIndicatorAmountForCashflow(ind, policy);
      if (amount <= 0) continue;
      for (let year = birthYear + pensionStartAge; year <= coverageEndYear - 1; year++) {
        cumulative += amount;
        entries.push({
          year, age: year - birthYear, amount, cumulative,
          liability: '年金', policyId: policy.id, productName,
          calcText: formatCashflowCalculation(ind, policy, amount),
        });
      }
    }

    if (/满期/.test(liability) || /满期/.test(formulaText)) {
      const amount = resolveIndicatorAmountForCashflow(ind, policy);
      if (amount <= 0) continue;
      cumulative += amount;
      entries.push({
        year: coverageEndYear, age: coverageEndYear - birthYear, amount, cumulative,
        liability: '满期金', policyId: policy.id, productName,
        calcText: formatCashflowCalculation(ind, policy, amount),
      });
    }
  }
  return entries;
}

// ────────────────────────────────────────────────────────────────────────────
// New server-side functions
// ────────────────────────────────────────────────────────────────────────────

/** Extract year from a date string. */
function parseYearFromDate(dateStr) {
  if (!dateStr) return 0;
  const m = String(dateStr).match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}

/** Build a computation context from a policy. */
function buildContext(policy) {
  const effectiveYear = parseYearFromDate(policy.date);
  const birthYear = parseYearFromDate(policy.insuredBirthday);
  const coverageEndYear = parseCoverageEndYear(policy);
  const paymentYears = parsePaymentYearsFromText(policy.paymentPeriod);
  const firstPremium = Number(policy.firstPremium || policy.premium || 0);
  const basicAmount = Number(policy.amount || 0);
  const totalPremium = firstPremium * paymentYears;
  return { effectiveYear, birthYear, coverageEndYear, paymentYears, firstPremium, basicAmount, totalPremium, policy };
}

/**
 * Substitute {{variable}} placeholders in text with resolved param values.
 */
function substituteVariables(text, resolvedParams) {
  // Use a single global regex to avoid regex injection from template keys
  return text.replace(/\{\{([^}]+)\}\}/g, (_, k) => String(resolvedParams[k.trim()] ?? `{{${k.trim()}}}`));
}

/**
 * Resolve template params from cashflow indicators.
 */
function resolveTemplateParams(params, cashflowIndicators) {
  const resolved = {};
  for (const [key, spec] of Object.entries(params || {})) {
    if (spec.source === 'indicator') {
      const ind = cashflowIndicators.find(i => i.liability === spec.key);
      const value = Number(ind?.value || 0);
      // Store under both param name and indicator key for flexible reference
      resolved[key] = value;
      resolved[spec.key] = value;
    }
  }
  return resolved;
}

/**
 * Resolve a timing bound spec to a concrete calendar year.
 * @param {object|string} bound - e.g. {policyYear:5}, {age:55}, {beforeEvent:'pensionStart'}, or '{{var}}'
 * @param {object} ctx - buildContext result
 * @param {object} resolvedParams - resolved template params
 * @param {string} direction - 'start' | 'end'
 * @returns {number} calendar year
 */
function resolveTimingBound(bound, ctx, resolvedParams, direction) {
  if (!bound) return 0;

  // String with {{variable}} substitution (e.g. '{{领取起始年龄}}')
  if (typeof bound === 'string') {
    if (/^\{\{/.test(bound)) {
      const substituted = substituteVariables(bound, resolvedParams);
      const num = Number(substituted);
      if (!Number.isNaN(num) && num > 0) {
        // Treat as age when used in beforeEvent context
        return direction === 'end'
          ? ctx.birthYear + num - 1
          : ctx.birthYear + num;
      }
    }
    return 0;
  }

  if (bound.policyYear != null) {
    return ctx.effectiveYear + bound.policyYear;
  }

  if (bound.age != null) {
    return ctx.birthYear + bound.age;
  }

  if (bound.beforeEvent) {
    if (bound.beforeEvent === 'pensionStart') {
      return ctx.birthYear + 55 - 1;
    }
    if (bound.beforeEvent === 'coverageEnd') {
      return ctx.coverageEndYear - 1;
    }
    // Support {{variable}} substitution in beforeEvent value
    const eventValue = substituteVariables(bound.beforeEvent, resolvedParams);
    // If substitution produced a plain number, treat it as an age
    const numVal = Number(eventValue);
    if (!Number.isNaN(numVal) && numVal > 0) {
      return ctx.birthYear + numVal - 1;
    }
    // Otherwise try as a direct param name lookup
    const age = resolvedParams[eventValue];
    if (age) {
      return ctx.birthYear + age - 1;
    }
  }

  return 0;
}

/**
 * Resolve amount from a template rule's amount spec.
 */
function resolveRuleAmount(amountSpec, ctx) {
  if (!amountSpec) return 0;

  if (amountSpec.fixed != null) {
    return amountSpec.fixed;
  }

  const factor = amountSpec.factor ?? 1;
  const basis = amountSpec.basis;

  if (basis === '基本保额') {
    return ctx.basicAmount * factor;
  }
  if (basis === '已交保费') {
    return ctx.totalPremium * factor;
  }
  if (basis === 'max') {
    return Math.max(ctx.totalPremium, ctx.basicAmount) * factor;
  }

  return 0;
}

/**
 * Generate human-readable calculation text for a template rule.
 */
function buildRuleCalcText(rule, ctx, amount) {
  const spec = rule.amount || {};
  if (spec.fixed != null) {
    return `固定金额 = ${amount.toLocaleString('zh-CN')}元`;
  }
  const factor = spec.factor ?? 1;
  const basis = spec.basis || '';
  if (basis === '基本保额') {
    if (factor !== 1) return `基本保额 ${ctx.basicAmount.toLocaleString('zh-CN')} × ${factor} = ${amount.toLocaleString('zh-CN')}元`;
    return `基本保额 = ${amount.toLocaleString('zh-CN')}元`;
  }
  if (basis === '已交保费') {
    if (factor !== 1) return `已交保费 ${ctx.totalPremium.toLocaleString('zh-CN')} × ${factor} = ${amount.toLocaleString('zh-CN')}元`;
    return `已交保费 = ${amount.toLocaleString('zh-CN')}元`;
  }
  if (basis === 'max') {
    return `max(已交保费, 基本保额) = ${amount.toLocaleString('zh-CN')}元`;
  }
  return `${amount.toLocaleString('zh-CN')}元`;
}

/**
 * Expand a single template rule into yearly cashflow entries.
 */
function expandRule(rule, ctx, resolvedParams) {
  const timing = rule.timing;
  if (!timing) return [];

  const amount = resolveRuleAmount(rule.amount, ctx);
  if (amount <= 0) return [];

  const productName = ctx.policy.name || '';
  const policyId = ctx.policy.id;
  const liability = rule.liability || '现金流';
  const calcText = buildRuleCalcText(rule, ctx, amount);

  const entries = [];

  if (timing.type === 'range') {
    const startYear = resolveTimingBound(timing.start, ctx, resolvedParams, 'start');
    const endYear = resolveTimingBound(timing.end, ctx, resolvedParams, 'end');
    for (let year = startYear; year <= endYear; year++) {
      if (year < ctx.effectiveYear || year > ctx.coverageEndYear) continue;
      entries.push({
        year,
        age: year - ctx.birthYear,
        amount,
        liability,
        productName,
        policyId,
        calcText,
      });
    }
  } else if (timing.type === 'pointList') {
    const minPolicyYear = timing.minPolicyYear || 0;
    for (const age of (timing.ages || [])) {
      const year = ctx.birthYear + age;
      const policyYear = year - ctx.effectiveYear;
      if (policyYear < minPolicyYear) continue;
      if (year < ctx.effectiveYear || year > ctx.coverageEndYear) continue;
      entries.push({
        year,
        age,
        amount,
        liability,
        productName,
        policyId,
        calcText,
      });
    }
  } else if (timing.type === 'singleAge') {
    const year = ctx.birthYear + timing.age;
    if (year >= ctx.effectiveYear && year <= ctx.coverageEndYear) {
      entries.push({
        year,
        age: timing.age,
        amount,
        liability,
        productName,
        policyId,
        calcText,
      });
    }
  } else if (timing.type === 'maturity') {
    const year = ctx.coverageEndYear;
    if (year >= ctx.effectiveYear) {
      entries.push({
        year,
        age: year - ctx.birthYear,
        amount,
        liability,
        productName,
        policyId,
        calcText,
      });
    }
  }

  return entries;
}

/**
 * Compute cashflow entries from template rules.
 */
function computeFromTemplate(rules, params, ctx, cashflowIndicators) {
  const resolvedParams = resolveTemplateParams(params, cashflowIndicators);
  const entries = [];
  for (const rule of rules) {
    entries.push(...expandRule(rule, ctx, resolvedParams));
  }
  return entries;
}

/**
 * Compute cashflow entries from policy responsibility text.
 */
function normalizeOptionalText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
}

function responsibilityMatchesOptionalResponsibility(row, optional) {
  const rowText = normalizeOptionalText([
    row?.coverageType,
    row?.scenario,
    row?.payout,
    row?.note,
  ].join(' '));
  const liability = normalizeOptionalText(optional?.liability);
  if (liability && liability.length >= 2 && rowText.includes(liability)) return true;

  const coverageType = normalizeOptionalText(optional?.coverageType);
  if (!coverageType || coverageType.length < 3 || /可选责任|保险责任/.test(coverageType)) return false;
  return rowText.includes(coverageType);
}

function isSelectedResponsibilityRow(policy, row) {
  const matchingOptionalResponsibilities = (Array.isArray(policy?.optionalResponsibilities) ? policy.optionalResponsibilities : [])
    .filter((optional) => responsibilityMatchesOptionalResponsibility(row, optional));
  if (!matchingOptionalResponsibilities.length) return true;
  return matchingOptionalResponsibilities.some((optional) =>
    String(optional?.selectionStatus || '') === 'selected' &&
    String(optional?.quantificationStatus || 'pending_review') === 'quantified'
  );
}

function computeFromResponsibilities(policy, ctx, cashflowIndicators) {
  const { effectiveYear, birthYear, coverageEndYear } = ctx;
  const productName = policy.name || '';
  const amount = ctx.basicAmount;

  // Extract pension start age from indicators
  let pensionStartAge = 0;
  for (const ind of cashflowIndicators) {
    const liab = String(ind.liability || '');
    const basis = String(ind.basis || '');
    if ((/领取.*年龄|年金.*年龄|养老.*年龄/.test(liab) || /领取.*年龄/.test(basis)) && ind.value) {
      pensionStartAge = Number(ind.value);
      break;
    }
  }

  // Concatenate responsibility texts
  const respText = (Array.isArray(policy.responsibilities) ? policy.responsibilities : [])
    .filter((row) => isSelectedResponsibilityRow(policy, row))
    .map((r) => String(r.scenario || '')).join('\n');

  if (!respText) {
    return synthesizeCashflowFromIndicatorsOnly(cashflowIndicators, policy, effectiveYear, birthYear, coverageEndYear, pensionStartAge);
  }

  const sections = splitResponsibilitySections(respText);
  const entries = [];
  let cumulative = 0;

  for (const sec of sections) {
    if (/身故/.test(sec.name)) continue;

    const parsed = parseBenefitSection(sec, {
      effectiveYear, birthYear, coverageEndYear, pensionStartAge,
      amount, policy,
    });

    for (const item of parsed) {
      cumulative += item.amount;
      entries.push({
        year: item.year,
        age: item.year - birthYear,
        amount: item.amount,
        cumulative,
        liability: item.liability || sec.name,
        policyId: policy.id,
        productName,
        calcText: item.calculationText,
      });
    }
  }

  if (!entries.length) {
    return synthesizeCashflowFromIndicatorsOnly(cashflowIndicators, policy, effectiveYear, birthYear, coverageEndYear, pensionStartAge);
  }

  // Also check for 满期 entries from indicators that might be missing
  for (const ind of cashflowIndicators) {
    const liability = String(ind.liability || '');
    const formulaText = String(ind.formulaText || '');
    if (/满期/.test(liability) || /满期/.test(formulaText)) {
      const hasCoverageEndEntry = entries.some(e => e.year === coverageEndYear);
      if (!hasCoverageEndEntry) {
        const indAmount = resolveIndicatorAmountForCashflow(ind, policy);
        if (indAmount > 0) {
          cumulative += indAmount;
          entries.push({
            year: coverageEndYear,
            age: coverageEndYear - birthYear,
            amount: indAmount,
            cumulative,
            liability: '满期金',
            policyId: policy.id,
            productName,
            calcText: formatCashflowCalculation(ind, policy, indAmount),
          });
        }
      }
    }
  }

  return entries;
}

/**
 * Compute cashflow entries from indicators (fallback path).
 */
function computeFromIndicators(cashflowIndicators, ctx) {
  const entries = [];
  for (const indicator of cashflowIndicators) {
    entries.push(...expandCashflowIndicator(indicator, ctx.policy));
  }

  if (!entries.length && cashflowIndicators.length) {
    const { effectiveYear, birthYear, coverageEndYear } = ctx;
    let pensionStartAge = 0;
    for (const ind of cashflowIndicators) {
      const liab = String(ind.liability || '');
      const basis = String(ind.basis || '');
      if ((/领取.*年龄|年金.*年龄|养老.*年龄/.test(liab) || /领取.*年龄/.test(basis)) && ind.value) {
        pensionStartAge = Number(ind.value);
        break;
      }
    }
    return synthesizeCashflowFromIndicatorsOnly(cashflowIndicators, ctx.policy, effectiveYear, birthYear, coverageEndYear, pensionStartAge);
  }

  return entries;
}

// ────────────────────────────────────────────────────────────────────────────
// Exported entry points
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute policy cashflow entries using a 3-tier strategy:
 *   1. Template rules (highest priority)
 *   2. Responsibility text parsing
 *   3. Indicator fallback
 *
 * @param {object} policy - Policy object
 * @param {object|null} template - Template with rules and params
 * @param {Array<object>} indicators - All coverage indicators
 * @returns {Array<object>} Sorted cashflow entries with cumulative amounts
 */
export function computePolicyCashflow(policy, template, indicators) {
  const ctx = buildContext(policy);
  const effectiveIndicators = (Array.isArray(indicators) ? indicators : []).filter(isSelectedCoverageIndicator);
  const cashflowIndicators = effectiveIndicators.filter(i => i.coverageType === '现金流');
  const rules = template?.rules || [];

  let entries = [];

  // Path 1: template rules (highest priority)
  if (rules.length) {
    entries = computeFromTemplate(rules, template.params, ctx, cashflowIndicators);
  }

  // Path 2: responsibility text parsing
  if (!entries.length && policy.responsibilities?.length) {
    entries = computeFromResponsibilities(policy, ctx, cashflowIndicators);
  }

  // Path 3: indicator fallback
  if (!entries.length && cashflowIndicators.length) {
    entries = computeFromIndicators(cashflowIndicators, ctx);
  }

  // Calculate cumulative and sort by year
  let cumulative = 0;
  entries = entries
    .sort((a, b) => a.year - b.year)
    .map(e => { cumulative += e.amount; return { ...e, cumulative }; });

  return entries;
}

/**
 * Build scenario entries for non-cashflow indicators (accident, illness, nursing, etc.).
 * Migrated from buildScenarioEntries in src/cashflow-engine.mjs.
 *
 * @param {Array<object>} indicators - All coverage indicators
 * @param {object} policy - Policy object
 * @returns {Array<object>} Scenario entries
 */
export function computeScenarioEntries(indicators, policy) {
  const entries = [];
  for (const indicator of (Array.isArray(indicators) ? indicators : [])) {
    if (!isSelectedCoverageIndicator(indicator)) continue;
    if (indicator.coverageType === '现金流') continue;
    if (indicator.coverageType === '规则参数') continue;
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

function isSelectedCoverageIndicator(indicator) {
  const scope = String(indicator?.responsibilityScope || 'basic');
  const status = String(indicator?.selectionStatus || (scope === 'optional' ? 'unknown' : 'selected'));
  const quantificationStatus = String(indicator?.quantificationStatus || 'pending_review');
  return scope !== 'optional' || (status === 'selected' && quantificationStatus === 'quantified');
}
