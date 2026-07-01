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

function missingText(summary = {}) {
  return collectText(summary.missingOrUnclear).map(text).filter(Boolean).join(' ');
}

function sourceText(sourceSections = {}) {
  return joinedText(sourceSections);
}

function hasAcceptableMissingExplanation(summary, keyword, aliases = []) {
  const content = missingText(summary);
  if (!content) return false;
  const mentioned = [keyword, ...aliases].some((alias) => includesLoose(content, alias));
  return mentioned && /不明|缺失|未载明|无法|不能确定|需要|待核|来源|条款|表/u.test(content);
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

const PRODUCT_FUNCTION_TITLE_TERMS = [
  '保单贷款',
  '减保',
  '指定受益人',
  '受益人指定',
  '红利',
  '分红',
  '现金价值管理',
  '账户价值',
  '结算利率',
  '投资账户',
  '保证利率',
  '费用',
  '投资风险',
];

const UNSUPPORTED_RESPONSIBILITY_RULES = [
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

function validateSchema(summary, issues) {
  if (!isPlainObject(summary)) {
    issues.push({ code: 'invalid_summary_shape', message: 'Summary must be an object.' });
    return false;
  }
  if (!Array.isArray(summary.responsibilities)) {
    issues.push({ code: 'invalid_responsibilities_shape', message: 'Summary responsibilities must be an array.' });
    return false;
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
  const missing = missingText(summary);
  const rules = categoryKeywordRules(category);
  const required = rules.responsibility || [];

  for (const keyword of required) {
    if (!includesLoose(source, keyword)) continue;
    if (includesLoose(responsibilityText, keyword)) continue;
    if (hasAcceptableMissingExplanation(summary, keyword)) continue;
    pushMissingIssue(issues, keyword);
  }

  for (const rule of OPTIONAL_RESPONSIBILITY_RULES[category] || []) {
    if (!includesAny(source, rule.sourcePatterns)) continue;
    if (includesAny(responsibilityText, rule.summaryPatterns)) continue;
    if (hasAcceptableMissingExplanation(summary, rule.keyword, rule.summaryPatterns)) continue;
    if (includesAny(missing, rule.summaryPatterns) && hasAcceptableMissingExplanation(summary, rule.keyword, rule.summaryPatterns)) continue;
    pushMissingIssue(issues, rule.keyword);
  }
}

function evaluateSeparation({ source, summary, issues }) {
  for (const [index, item] of normalizeArray(summary.responsibilities).entries()) {
    const title = text(item?.title);
    if (!title) continue;
    const term = PRODUCT_FUNCTION_TITLE_TERMS.find((candidate) => includesLoose(title, candidate));
    if (term) {
      issues.push({ code: 'function_mixed_into_responsibilities', index, title, term });
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
  const saysGuaranteedDividend = /(?:保证(?:给付|获得|领取|分配)?红利|红利(?:保证|确定|固定)|确定(?:给付|获得|领取|分配)?红利)/u.test(allSummary)
    && !/(?:红利不保证|红利并不保证|红利非保证|红利是不确定|红利分配是不确定)/u.test(allSummary);
  if (saysGuaranteedDividend) {
    issues.push({ code: 'unsupported_guaranteed_dividend', keyword: '红利' });
  }
}

function hasCompoundFormula(source) {
  return /(?:基本保险金额|基本保额|有效保险金额)?[×xX*]\s*(?:[（(]\s*1\s*[+＋]\s*3\.5%\s*[）)]|1\.035)\s*\^\s*[（(]?\s*n\s*-\s*1\s*[）)]?/u.test(compact(source));
}

function evaluateIncrementalFormula({ category, source, summary, issues }) {
  if (category !== 'incremental_whole_life' || !hasCompoundFormula(source)) return;

  const allSummary = joinedText(summary);
  if (!/(?:3\.5%|1\.035)/u.test(allSummary)) {
    issues.push({ code: 'compound_growth_rate_missing', keyword: '3.5%' });
  }
  if (!/(?:复利|递增|逐年增长)/u.test(allSummary)) {
    issues.push({ code: 'compound_growth_not_explained', keyword: '复利递增' });
  }
  if (!/(?:有效保险金额|给付基准|保险金额|基本保险金额|基本保额)/u.test(allSummary)) {
    issues.push({ code: 'compound_growth_basis_missing', keyword: '有效保险金额' });
  }

  const confusedWithCashValue = /(?:现金价值|收益|回报|收益率).{0,12}(?:3\.5%|复利|递增)|(?:3\.5%|复利|递增).{0,12}(?:现金价值|收益|回报|收益率)/u.test(allSummary)
    && !/(?:不等于|不是|不代表|并非|非收益|非保证收益|不保证收益|不等同)/u.test(allSummary);
  if (confusedWithCashValue) {
    issues.push({ code: 'compound_growth_confused_with_cash_value_or_return', keyword: '复利递增' });
  }
}

function evaluateUnsupportedClaims({ source, summary, issues }) {
  const missing = missingText(summary);
  for (const item of normalizeArray(summary.responsibilities)) {
    const claimText = [item?.title, item?.plainText, item?.triggerCondition, item?.paymentRule].map(text).join(' ');
    if (!claimText) continue;
    for (const rule of UNSUPPORTED_RESPONSIBILITY_RULES) {
      if (!includesAny(claimText, rule.claimPatterns)) continue;
      if (includesAny(source, rule.sourcePatterns)) continue;
      if (includesAny(missing, rule.claimPatterns)) continue;
      issues.push({ code: 'unsupported_responsibility_claim', keyword: rule.keyword, title: text(item?.title) });
    }
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

  return {
    status: issues.length ? 'failed' : 'passed',
    issues,
  };
}
