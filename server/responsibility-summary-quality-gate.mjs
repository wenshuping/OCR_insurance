import { categoryKeywordRules } from './responsibility-summary-templates.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectText(value) {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [text(value)];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (typeof value === 'object') return Object.values(value).flatMap(collectText);
  return [];
}

function joinedText(value) {
  return collectText(value).map(text).filter(Boolean).join(' ');
}

function compact(value) {
  return text(value).replace(/\s+/gu, '');
}

function includesLoose(content, keyword) {
  const normalized = compact(content);
  const key = compact(keyword);
  return Boolean(normalized && key && normalized.includes(key));
}

function includesAny(content, patterns) {
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(content);
    return includesLoose(content, pattern);
  });
}

function summaryResponsibilityText(summary = {}) {
  return normalizeArray(summary.responsibilities)
    .flatMap((item) => [item?.title, item?.plainText, item?.triggerCondition, item?.paymentRule])
    .map(text)
    .filter(Boolean)
    .join(' ');
}

function summaryFunctionAndNoteText(summary = {}) {
  return [
    ...collectText(summary.productFunctions),
    ...collectText(summary.importantNotes),
  ].map(text).filter(Boolean).join(' ');
}

function sourceText(sourceSections = {}) {
  return joinedText(sourceSections);
}

function pushMissingIssue(issues, keyword) {
  if (issues.some((issue) => issue.code === 'missing_required_keyword' && issue.keyword === keyword)) return;
  issues.push({ code: 'missing_required_keyword', keyword });
}

const OPTIONAL_RESPONSIBILITY_RULES = {
  critical_illness: [
    {
      keyword: '少儿前10年关爱保险金',
      sourcePatterns: ['少儿前10年关爱保险金', '少儿前10年关爱'],
      summaryPatterns: ['少儿前10年关爱保险金', '少儿前10年关爱'],
    },
    {
      keyword: '成人意外伤害特定疾病或身故关爱保险金',
      sourcePatterns: ['成人意外伤害特定疾病或身故关爱保险金', '成人意外关爱', '成人意外伤害特定疾病'],
      summaryPatterns: ['成人意外伤害特定疾病或身故关爱保险金', '成人意外关爱', '成人意外伤害特定疾病'],
    },
    {
      keyword: '豁免保险费',
      sourcePatterns: ['豁免保险费', '保费豁免'],
      summaryPatterns: ['豁免保险费', '保费豁免'],
    },
  ],
  incremental_whole_life: [
    {
      keyword: '交通意外额外给付',
      sourcePatterns: ['交通意外额外给付', '公共交通工具意外', '特定公共交通工具', '航空意外', '驾乘意外'],
      summaryPatterns: ['交通意外额外给付', '公共交通工具意外', '特定公共交通工具', '航空意外', '驾乘意外'],
    },
  ],
  accident: [
    {
      keyword: '交通意外额外给付',
      sourcePatterns: ['交通意外额外给付', '交通工具', '公共交通', '航空意外', '驾乘意外'],
      summaryPatterns: ['交通意外额外给付', '交通工具', '公共交通', '航空意外', '驾乘意外'],
    },
  ],
};

const PRODUCT_FUNCTION_TITLE_RULES = [
  { term: '保单贷款', pattern: /保单贷款/u },
  { term: '减保', pattern: /^减保$|减额交清/u },
  { term: '指定受益人', pattern: /指定受益人|受益人指定/u },
  { term: '红利', pattern: /红利|分红/u },
  { term: '现金价值管理', pattern: /现金价值管理/u },
  { term: '账户价值', pattern: /账户价值/u },
  { term: '结算利率', pattern: /结算利率/u },
  { term: '投资账户', pattern: /投资账户/u },
  { term: '保证利率', pattern: /保证利率/u },
  { term: '费用', pattern: /费用收取|初始费用|保单管理费|风险保险费|手续费|退保费用/u },
  { term: '投资风险', pattern: /投资风险/u },
];

const UNSUPPORTED_RESPONSIBILITY_RULES = [
  {
    keyword: '满期保险金',
    claimPatterns: ['满期保险金'],
    sourcePatterns: ['满期保险金', '满期给付', '满期时'],
  },
  {
    keyword: '住院医疗保险金',
    claimPatterns: ['住院医疗保险金', '住院医疗费用保险金'],
    sourcePatterns: ['住院医疗保险金', '住院医疗费用保险金', '住院医疗'],
  },
  {
    keyword: '意外身故保险金',
    claimPatterns: ['意外身故保险金', '意外身故'],
    sourcePatterns: ['意外身故保险金', '意外身故'],
  },
  {
    keyword: '豁免保险费',
    claimPatterns: ['豁免保险费', '保费豁免'],
    sourcePatterns: ['豁免保险费', '保费豁免'],
  },
  {
    keyword: '交通意外额外给付',
    claimPatterns: ['交通意外额外给付', '公共交通工具意外', '特定公共交通工具', '航空意外', '驾乘意外'],
    sourcePatterns: ['交通意外额外给付', '公共交通工具意外', '特定公共交通工具', '交通工具意外', '航空意外', '驾乘意外'],
  },
  {
    keyword: '少儿前10年关爱保险金',
    claimPatterns: ['少儿前10年关爱保险金', '少儿前10年关爱'],
    sourcePatterns: ['少儿前10年关爱保险金', '少儿前10年关爱'],
  },
  {
    keyword: '成人意外伤害特定疾病或身故关爱保险金',
    claimPatterns: ['成人意外伤害特定疾病或身故关爱保险金', '成人意外关爱', '成人意外伤害特定疾病'],
    sourcePatterns: ['成人意外伤害特定疾病或身故关爱保险金', '成人意外关爱', '成人意外伤害特定疾病'],
  },
];

const GENERIC_RESPONSIBILITY_TITLES = new Set([
  '主要保险责任',
  '保险责任',
  '核心保障',
  '主要保障',
  '保障责任',
]);

function validateSchema(summary, issues) {
  if (!isPlainObject(summary)) {
    issues.push({ code: 'invalid_summary_shape', message: 'Summary must be an object.' });
    return false;
  }
  if (!Array.isArray(summary.responsibilities)) {
    issues.push({ code: 'invalid_responsibilities_shape', message: 'Summary responsibilities must be an array.' });
    return false;
  }
  for (const field of ['productFunctions', 'importantNotes', 'missingOrUnclear']) {
    if (!Array.isArray(summary[field])) {
      issues.push({ code: 'invalid_summary_array_field', field, message: `Summary ${field} must be an array.` });
    }
  }

  let renderableCount = 0;
  summary.responsibilities.forEach((item, index) => {
    if (!isPlainObject(item)) {
      issues.push({ code: 'invalid_responsibility_shape', index, message: 'Responsibility must be an object.' });
      return;
    }
    const title = text(item.title);
    const hasBody = Boolean(text(item.plainText) || text(item.paymentRule) || text(item.triggerCondition));
    if (!title) issues.push({ code: 'missing_responsibility_title', index });
    if (!hasBody) issues.push({ code: 'missing_responsibility_render_text', index, title });
    if (title && hasBody) renderableCount += 1;
  });

  if (!renderableCount) {
    issues.push({ code: 'empty_responsibilities', message: 'Summary has no renderable customer responsibilities.' });
  }
  return true;
}

function evaluateCoverage({ category, source, summary, issues }) {
  const responsibilityText = summaryResponsibilityText(summary);
  const rules = categoryKeywordRules(category);
  const required = rules.responsibility || [];

  for (const keyword of required) {
    if (!includesLoose(source, keyword)) continue;
    if (includesLoose(responsibilityText, keyword)) continue;
    pushMissingIssue(issues, keyword);
  }

  for (const rule of OPTIONAL_RESPONSIBILITY_RULES[category] || []) {
    if (!includesAny(source, rule.sourcePatterns)) continue;
    if (includesAny(responsibilityText, rule.summaryPatterns)) continue;
    pushMissingIssue(issues, rule.keyword);
  }
}

function hasUnsupportedGuaranteedDividend(content) {
  const pattern = /保证(?:给付|获得|领取|分配)?红利|红利(?:保证|确定|固定)|确定(?:给付|获得|领取|分配)?红利/gu;
  for (const match of text(content).matchAll(pattern)) {
    const prefix = text(content).slice(Math.max(0, match.index - 6), match.index);
    if (/(?:不|未|无|非|难以|不能|无法|不得|不会|并不|不可)$|不保证$/u.test(prefix)) continue;
    return true;
  }
  return false;
}

function evaluateSeparation({ source, summary, issues }) {
  for (const [index, item] of normalizeArray(summary.responsibilities).entries()) {
    const title = text(item?.title);
    if (!title) continue;
    const rule = PRODUCT_FUNCTION_TITLE_RULES.find((candidate) => candidate.pattern.test(title));
    if (rule) {
      issues.push({ code: 'function_mixed_into_responsibilities', index, title, term: rule.term });
    }
  }

  if (!/(?:分红型|分红|红利|累积红利保险金额)/u.test(source)) return;

  const functionAndNoteText = summaryFunctionAndNoteText(summary);
  if (!/(?:分红|红利|累积红利保险金额)/u.test(functionAndNoteText)) {
    issues.push({ code: 'missing_dividend_function_or_note', keyword: '红利' });
  }
  if (!/(?:不保证|不确定|非保证|取决于实际分配|不承诺)/u.test(functionAndNoteText)) {
    issues.push({ code: 'missing_dividend_uncertainty_note', keyword: '红利不保证' });
  }

  const allSummary = joinedText(summary);
  if (hasUnsupportedGuaranteedDividend(allSummary)) {
    issues.push({ code: 'unsupported_guaranteed_dividend', keyword: '红利' });
  }
}

function formatRate(value) {
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded).replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1');
}

function compoundFormulaRates(source) {
  const content = compact(source);
  const rates = [];
  const formula = /[×xX*](?:[（(]1[+＋]([0-9]+(?:\.[0-9]+)?)%[）)]|1\.(\d+))\^\(?n-1\)?/gu;
  for (const match of content.matchAll(formula)) {
    if (match[1]) {
      rates.push(formatRate(Number(match[1])));
      continue;
    }
    if (match[2]) {
      const scalar = Number(`1.${match[2]}`);
      if (Number.isFinite(scalar) && scalar > 1) rates.push(formatRate((scalar - 1) * 100));
    }
  }
  return [...new Set(rates)];
}

function escapeRegExp(value) {
  return text(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function evaluateIncrementalFormula({ category, source, summary, issues }) {
  const rates = compoundFormulaRates(source);
  if (category !== 'incremental_whole_life' || !rates.length) return;

  const allSummary = joinedText(summary);
  for (const rate of rates) {
    if (!new RegExp(`${escapeRegExp(rate)}%`, 'u').test(allSummary)) {
      issues.push({ code: 'compound_growth_rate_missing', keyword: `${rate}%` });
    }
  }
  if (!/(?:复利|递增|逐年增长)/u.test(allSummary)) {
    issues.push({ code: 'compound_growth_not_explained', keyword: '复利递增' });
  }
  if (!/(?:有效保险金额|给付基准|保险金额|基本保险金额|基本保额)/u.test(allSummary)) {
    issues.push({ code: 'compound_growth_basis_missing', keyword: '有效保险金额' });
  }

  const ratePattern = rates.map(escapeRegExp).join('|');
  const growthPattern = `(?:${ratePattern}%|复利|递增)`;
  const confusedWithCashValue = new RegExp(`(?:现金价值|收益|回报|收益率).{0,12}${growthPattern}|${growthPattern}.{0,12}(?:现金价值|收益|回报|收益率)`, 'u').test(allSummary)
    && !/(?:不等于|不是|不代表|并非|非收益|非保证收益|不保证收益|不等同)/u.test(allSummary);
  if (confusedWithCashValue) {
    issues.push({ code: 'compound_growth_confused_with_cash_value_or_return', keyword: '复利递增' });
  }
}

function evaluateUnsupportedClaims({ source, summary, issues }) {
  for (const item of normalizeArray(summary.responsibilities)) {
    const title = text(item?.title);
    const claimText = [title, item?.plainText, item?.triggerCondition, item?.paymentRule].map(text).join(' ');
    if (!claimText) continue;
    for (const rule of UNSUPPORTED_RESPONSIBILITY_RULES) {
      if (!includesAny(claimText, rule.claimPatterns)) continue;
      if (includesAny(source, rule.sourcePatterns)) continue;
      issues.push({ code: 'unsupported_responsibility_claim', keyword: rule.keyword, title: text(item?.title) });
    }
  }
}

function isConcreteResponsibilityTitle(title) {
  const normalized = compact(title);
  if (!normalized || GENERIC_RESPONSIBILITY_TITLES.has(normalized)) return false;
  return /(?:保险金|年金|津贴|豁免保险费)$/u.test(normalized);
}

function titleSupportedBySource(title, source) {
  if (includesLoose(source, title)) return true;
  const normalizedTitle = compact(title);
  if (/(?:身故|死亡).*(?:全残|身体全残)|(?:全残|身体全残).*(?:身故|死亡)/u.test(normalizedTitle)) {
    return /身故|死亡/u.test(source) && /全残|身体全残/u.test(source);
  }
  if (includesLoose(title, '保费豁免') || includesLoose(title, '豁免保险费')) {
    return /保费豁免|豁免保险费/u.test(source);
  }
  return false;
}

function evaluateTitleSourceSupport({ source, summary, issues }) {
  for (const item of normalizeArray(summary.responsibilities)) {
    const title = text(item?.title);
    if (!isConcreteResponsibilityTitle(title)) continue;
    if (titleSupportedBySource(title, source)) continue;
    issues.push({ code: 'unsupported_responsibility_claim', keyword: title, title });
  }
}

export function evaluateResponsibilitySummaryQuality({
  routing = {},
  sourceSections = {},
  summary = {},
} = {}) {
  const issues = [];
  const shapeUsable = validateSchema(summary, issues);
  if (!shapeUsable) {
    return { status: 'failed', issues };
  }

  const category = text(routing.productCategory);
  const source = sourceText(sourceSections);

  evaluateCoverage({ category, source, summary, issues });
  evaluateSeparation({ source, summary, issues });
  evaluateIncrementalFormula({ category, source, summary, issues });
  evaluateUnsupportedClaims({ source, summary, issues });
  evaluateTitleSourceSupport({ source, summary, issues });

  return {
    status: issues.length ? 'failed' : 'passed',
    issues,
  };
}
