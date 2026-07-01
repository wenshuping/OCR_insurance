import crypto from 'node:crypto';

import { routeInsuranceProductCategory } from './insurance-product-category-router.mjs';
import { resolveOfficialResponsibilitySources } from './responsibility-source-resolver.mjs';
import { extractStructuredResponsibilitySections } from './responsibility-section-extractor.mjs';
import { buildStructuredResponsibilityPrompt } from './responsibility-summary-templates.mjs';
import { evaluateResponsibilitySummaryQuality } from './responsibility-summary-quality-gate.mjs';

export const CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION = 'customer-summary-v22-structured-rag';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const PRO_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 45_000;
const DEEPSEEK_LOG_PREVIEW_LIMIT = 3000;
const OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT = 6500;
const PROMPT_RESPONSIBILITY_EXCERPT_LIMIT = 6500;
const RESPONSIBILITY_TITLE_SUFFIX_PATTERN = /(?:保险金|给付金|年金|养老金|生存金|祝寿金|满期金|豁免保险费|豁免保费)/u;
const RESPONSIBILITY_NUMBERED_TITLE_PATTERN = /(?:^|[\s。；;])(?:\d+[.．、]|[（(][一二三四五六七八九十]+[）)]|[一二三四五六七八九十]+[、.．])\s*([^。；;：:\n]{2,90}?(?:保险金|给付金|年金|养老金|生存金|祝寿金|满期金|豁免保险费|豁免保费))/gu;

function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function excerpt(value, limit) {
  const normalized = text(value).replace(/\s+/gu, ' ');
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  const list = Array.isArray(values) ? values : (typeof values === 'string' || typeof values === 'number' ? [values] : []);
  for (const value of list) {
    const item = text(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function valuesFromKeys(source = {}, keys = []) {
  const values = [];
  if (!source || typeof source !== 'object') return values;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) values.push(source[key]);
  }
  return values;
}

function firstTextFromKeys(source = {}, keys = []) {
  for (const value of valuesFromKeys(source, keys)) {
    const item = text(value);
    if (item) return item;
  }
  return '';
}

function arrayFromKeys(source = {}, keys = []) {
  const result = [];
  for (const value of valuesFromKeys(source, keys)) {
    if (Array.isArray(value)) {
      result.push(...value);
    } else if (value && typeof value === 'object') {
      result.push(value);
    } else if (text(value)) {
      result.push(value);
    }
  }
  return result;
}

function isResponsibilityCategoryTitle(value) {
  return /^(?:主要保险责任|基本责任|可选责任|附加责任|主险责任|可选保险责任)$/u.test(text(value).replace(/\s+/gu, ''));
}

function splitLeadingResponsibilityTitle(value) {
  const content = text(value);
  const match = content.match(/^([^：:\n]{2,50})\s*[：:]\s*(.+)$/u);
  if (!match) return null;
  const title = text(match[1]).replace(/\s+/gu, '');
  if (!title || /^(?:官网|条款|若|如|被保险人|本公司|我们|发生上述)/u.test(title)) return null;
  return { title, plainText: text(match[2]) || content };
}

function responsibilityItemsFromValue(value, groupTitle = '') {
  if (Array.isArray(value)) {
    return value.flatMap((item) => responsibilityItemsFromValue(item, groupTitle));
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const content = text(value);
    if (!content || !groupTitle) return [];
    const split = isResponsibilityCategoryTitle(groupTitle) ? splitLeadingResponsibilityTitle(content) : null;
    return [{ title: split?.title || groupTitle, plainText: split?.plainText || content }];
  }
  if (!value || typeof value !== 'object') return [];
  const explicitTitle = firstTextFromKeys(value, ['title', 'name', 'coverageType', 'liability', '责任名称', '名称', '标题']);
  if (explicitTitle) return [value];
  return Object.entries(value).flatMap(([key, nested]) => responsibilityItemsFromValue(nested, text(key)));
}

function truncateText(value, limit) {
  const normalized = text(value).replace(/\s+/gu, ' ');
  if (!normalized) return '';
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function safeCustomerText(value) {
  const normalized = text(value).replace(/\s+/gu, ' ');
  return normalized;
}

function productKeyFor(company, productName) {
  const resolvedCompany = text(company);
  const resolvedProductName = text(productName);
  if (!resolvedCompany || !resolvedProductName) return '';
  return `company_product:${resolvedCompany}:${resolvedProductName}`;
}

function comparableProductName(value) {
  return text(value).replace(/[\s《》（）()【】\[\]·,，。:：;；、-]/gu, '');
}

function productNameMatchesQuery(candidate, query) {
  const normalizedCandidate = comparableProductName(candidate);
  const normalizedQuery = comparableProductName(query);
  if (!normalizedCandidate || !normalizedQuery) return false;
  return normalizedCandidate === normalizedQuery
    || normalizedCandidate.includes(normalizedQuery)
    || normalizedQuery.includes(normalizedCandidate);
}

function sourceUrlFrom(row = {}) {
  return text(row.sourceUrl || row.officialUrl || row.url || row.source_url || row.fileUrl);
}

function summaryFieldText(value) {
  return typeof value === 'string' || typeof value === 'number' ? text(value) : '';
}

function officialResponsibilitySummaryTextFrom(row = {}) {
  return summaryFieldText(row.responsibilitySummary)
    || summaryFieldText(row.responsibility_summary)
    || summaryFieldText(row.officialResponsibilitySummary)
    || summaryFieldText(row.official_responsibility_summary)
    || summaryFieldText(row.coverageSummary)
    || summaryFieldText(row.coverage_summary);
}

function officialResponsibilitySourceTextFrom(row = {}) {
  return text(
    row.responsibilityText
      || row.responsibility_text
      || row.pageText
      || row.text
      || row.content
      || row.sourceExcerpt
      || row.excerpt
      || row.sourceText,
  );
}

function sourceTextFrom(row = {}) {
  return text(officialResponsibilitySummaryTextFrom(row) || officialResponsibilitySourceTextFrom(row));
}

function normalizeResponsibilityTitle(value) {
  return text(value)
    .replace(/^保险责任(?:包括|含|为|是)?/u, '')
    .replace(/^[\s\d一二三四五六七八九十().（）．.、:：;；-]+/u, '')
    .replace(/\s+/gu, '')
    .trim();
}

function isUsefulResponsibilityTitle(value) {
  const title = normalizeResponsibilityTitle(value);
  return title.length >= 4
    && title.length <= 60
    && RESPONSIBILITY_TITLE_SUFFIX_PATTERN.test(title)
    && !/^(?:保险金|给付金|年金)$/u.test(title)
    && !/^(?:若|则|其|被保险人|本公司|我们)/u.test(title)
    && !/(?:处于|二者之较大|三者之最大|金额为|根据以下不同情形)/u.test(title)
    && !/(?:责任免除|保险金申请|释义|保单贷款|现金价值权益|受益人|争议处理)/u.test(title);
}

function cleanResponsibilityClauseExcerpt(value) {
  return text(value)
    .replace(/^\s*(?:\d+[.．、]|[（(][一二三四五六七八九十]+[）)]|[一二三四五六七八九十]+[、.．])\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function productNameFrom(row = {}) {
  return text(row.productName || row.product_name || row.name || row.title);
}

function companyFrom(row = {}) {
  return text(row.company || row.companyName || row.company_name);
}

function normalizeCardRow(row = {}) {
  const payload = parseJson(row.payload, row);
  return {
    ...payload,
    id: text(payload.id || row.id),
    productKey: text(payload.productKey || payload.product_key || row.product_key),
    company: text(payload.company || row.company),
    productName: text(payload.productName || payload.product_name || row.product_name),
    title: text(payload.title || row.title),
    category: text(payload.category || row.category),
    plainSummary: text(payload.plainSummary || payload.plain_summary),
    payoutSummary: text(payload.payoutSummary || payload.payout_summary),
    sourceUrl: text(payload.sourceUrl || payload.source_url || row.source_url),
    sourceTitle: text(payload.sourceTitle || payload.source_title),
    sourceExcerpt: text(payload.sourceExcerpt || payload.source_excerpt),
    indicators: normalizeArray(payload.indicators),
  };
}

function productMatches(row, { company, productName, productKey }) {
  if (productKey && text(row.productKey) === productKey) return true;
  return companyFrom(row) === company && productNameMatchesQuery(productNameFrom(row), productName);
}

function loadProductResponsibilityCards(db, { company, productName, productKey }) {
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    const rows = db.prepare(`
      SELECT *
      FROM product_responsibility_cards
      WHERE product_key = ?
         OR (
           company = ?
           AND (
             product_name = ?
             OR product_name LIKE ?
             OR ? LIKE '%' || product_name || '%'
           )
         )
      ORDER BY title ASC, id ASC
    `).all(productKey, company, productName, `%${productName}%`, productName);
    return normalizeArray(rows)
      .map((row) => normalizeCardRow(row))
      .filter((row) => productMatches(row, { company, productName, productKey }));
  } catch {
    return [];
  }
}

function recordProductMatches(row, { company, productName }) {
  if (companyFrom(row) !== company) return false;
  return productNameMatchesQuery(productNameFrom(row), productName);
}

function sourceRecordsForProduct(records, product) {
  return normalizeArray(records)
    .filter((record) => recordProductMatches(record, product))
    .filter((record) => sourceUrlFrom(record) || sourceTextFrom(record))
    .slice(0, 6);
}

function extractOfficialResponsibilityText(value = '', limit = OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT) {
  const normalized = text(value)
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (!normalized) return '';
  const compacted = normalized.replace(/\s+/gu, ' ');
  const markerMatch = [...compacted.matchAll(/(?:^|[\s。；;])保险责任(?=[\s：:。；;]|$)/gu)][0];
  const marker = markerMatch ? markerMatch.index + markerMatch[0].search(/保险责任/u) : -1;
  const fromMarker = marker >= 0 ? compacted.slice(marker) : compacted;
  const stop = fromMarker.search(/(?:^|[\s。；;])(?:责任免除|保险金申请|释义|合同解除|犹豫期|现金价值|保单贷款|受益人|争议处理)(?:[\s：:。；;]|$)/u);
  const responsibilityText = stop > 20 ? fromMarker.slice(0, stop) : fromMarker;
  return excerpt(responsibilityText, limit);
}

function officialResponsibilityClausesFromRecord(record = {}) {
  const officialExcerpt = extractOfficialResponsibilityText(officialResponsibilitySourceTextFrom(record), OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT);
  if (!officialExcerpt) return [];
  const matches = [...officialExcerpt.matchAll(RESPONSIBILITY_NUMBERED_TITLE_PATTERN)]
    .filter((match) => isUsefulResponsibilityTitle(match[1]));
  const sourceUrl = sourceUrlFrom(record);
  const sourceTitle = text(record.title || record.sourceTitle || record.productName || record.name);
  if (!matches.length) {
    const fallbackMatch = officialExcerpt.match(/(?:^|[\s：:])([^。；;：:\n]{2,90}?(?:保险金|给付金|年金|养老金|生存金|祝寿金|满期金|豁免保险费|豁免保费))/u);
    const title = normalizeResponsibilityTitle(fallbackMatch?.[1]);
    if (!isUsefulResponsibilityTitle(title)) return [];
    return [{
      title,
      excerpt: cleanResponsibilityClauseExcerpt(officialExcerpt),
      sourceUrl,
      sourceTitle,
    }];
  }
  return matches.map((match, index) => {
    const title = normalizeResponsibilityTitle(match[1]);
    const start = match.index || 0;
    const end = matches[index + 1]?.index ?? officialExcerpt.length;
    return {
      title,
      excerpt: cleanResponsibilityClauseExcerpt(officialExcerpt.slice(start, end)),
      sourceUrl,
      sourceTitle,
    };
  }).filter((clause) => clause.title && clause.excerpt);
}

function officialResponsibilityClausesFromRecords(records = []) {
  const byTitle = new Map();
  for (const record of normalizeArray(records)) {
    for (const clause of officialResponsibilityClausesFromRecord(record)) {
      const current = byTitle.get(clause.title);
      if (!current || clause.excerpt.length > current.excerpt.length) {
        byTitle.set(clause.title, clause);
      }
    }
  }
  return [...byTitle.values()];
}

function indicatorsForProduct(records, product) {
  return normalizeArray(records)
    .filter((record) => recordProductMatches(record, product))
    .slice(0, 24);
}

function preferredProductNameFromSources({ inputProductName, cards = [], records = [], indicators = [] } = {}) {
  const counts = new Map();
  const add = (value, weight) => {
    const name = text(value);
    if (!name || !productNameMatchesQuery(name, inputProductName)) return;
    counts.set(name, (counts.get(name) || 0) + weight);
  };
  for (const card of normalizeArray(cards)) add(productNameFrom(card), 4);
  for (const record of normalizeArray(records)) add(productNameFrom(record), 3);
  for (const indicator of normalizeArray(indicators)) add(productNameFrom(indicator), 2);
  const ranked = [...counts.entries()]
    .sort((left, right) =>
      right[1] - left[1]
      || comparableProductName(right[0]).length - comparableProductName(left[0]).length
      || left[0].localeCompare(right[0], 'zh-CN'),
    );
  return ranked[0]?.[0] || text(inputProductName);
}

function digestCard(card = {}) {
  return {
    title: text(card.title),
    sourceExcerpt: extractOfficialResponsibilityText(card.sourceExcerpt, OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT),
    sourceUrl: sourceUrlFrom(card),
    payoutSummary: text(card.payoutSummary),
  };
}

function digestIndicator(indicator = {}) {
  return {
    liability: text(indicator.liability || indicator.title || indicator.name),
    formulaText: text(indicator.formulaText || indicator.formula || indicator.calcText),
    basis: text(indicator.basis || indicator.basisText),
    sourceUrl: sourceUrlFrom(indicator),
  };
}

function digestRecord(record = {}) {
  return {
    title: text(record.title || record.productName || record.name),
    url: sourceUrlFrom(record),
    responsibilitySummary: excerpt(officialResponsibilitySummaryTextFrom(record), OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT),
    pageText: extractOfficialResponsibilityText(officialResponsibilitySourceTextFrom(record), OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT),
  };
}

export function buildCustomerResponsibilitySourceDigest({ cards = [], indicators = [], records = [] } = {}) {
  const payload = {
    cards: normalizeArray(cards).map(digestCard),
    indicators: normalizeArray(indicators).map(digestIndicator),
    records: normalizeArray(records).map(digestRecord),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function validateCustomerResponsibilitySummaryJson(summary) {
  const sourceSummary = summary?.summary || summary?.result || summary?.data || summary;
  const responsibilities = normalizeArray(sourceSummary?.mainResponsibilities)
    .concat(normalizeArray(sourceSummary?.responsibilities))
    .concat(normalizeArray(sourceSummary?.insuranceResponsibilities))
    .concat(valuesFromKeys(sourceSummary, ['主要保险责任', '保险责任', '核心保险责任'])
      .flatMap((item) => responsibilityItemsFromValue(item, '主要保险责任')));
  const chineseNotices = arrayFromKeys(sourceSummary, [
    '主要功能',
    '适合解决的问题',
    '不适合解决的问题',
    '免责或风险提示',
    '风险提示',
    '注意事项',
  ]).map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return text(item);
    if (!item || typeof item !== 'object') return '';
    const label = firstTextFromKeys(item, ['title', '标题', '类别', '类型', 'name']);
    const body = firstTextFromKeys(item, ['plainText', 'summary', 'description', '内容', '说明', '提示']);
    return [label, body].filter(Boolean).join('：');
  });
  const normalizedResponsibilities = responsibilities.map((item) => {
    const rawTitle = text(item?.title || item?.name || item?.coverageType || item?.liability || item?.责任名称 || item?.名称 || item?.标题);
    const rawPlainText = text(item?.plainText || item?.summary || item?.description || item?.scenario || item?.payout || item?.内容 || item?.说明);
    const split = isResponsibilityCategoryTitle(rawTitle) ? splitLeadingResponsibilityTitle(rawPlainText) : null;
    return {
      title: split?.title || rawTitle,
      plainText: split?.plainText || rawPlainText,
      howItPays: text(item?.howItPays || item?.给付方式 || item?.给付规则 || item?.赔付方式),
      requiredPolicyFields: uniqueStrings(item?.requiredPolicyFields || item?.所需字段 || item?.需要字段),
    };
  }).filter((item) => item.title || item.plainText || item.howItPays);
  const normalized = {
    company: text(sourceSummary?.company || sourceSummary?.保险公司),
    productName: text(sourceSummary?.productName || sourceSummary?.产品名称),
    headline: text(
      sourceSummary?.headline
        || sourceSummary?.productSummary
        || sourceSummary?.summary
        || sourceSummary?.产品定位
        || sourceSummary?.产品总结,
    ),
    mainResponsibilities: normalizedResponsibilities,
    notices: uniqueStrings([
      ...uniqueStrings(sourceSummary?.notices),
      ...chineseNotices,
    ]),
    requiredPolicyFields: uniqueStrings(sourceSummary?.requiredPolicyFields || sourceSummary?.所需字段 || sourceSummary?.需要字段),
    sourceUrls: uniqueStrings(sourceSummary?.sourceUrls || sourceSummary?.来源链接 || sourceSummary?.资料来源),
  };
  return normalized;
}

function cardPromptItem(card = {}) {
  return {
    title: text(card.title),
    category: text(card.category),
    officialExcerpt: extractOfficialResponsibilityText(card.sourceExcerpt, PROMPT_RESPONSIBILITY_EXCERPT_LIMIT),
    plainSummary: safeCustomerText(card.plainSummary),
    payoutSummary: safeCustomerText(card.payoutSummary),
    sourceUrl: sourceUrlFrom(card),
    sourceTitle: text(card.sourceTitle),
  };
}

function indicatorPromptItem(indicator = {}) {
  const basisText = safeCustomerText(indicator.basis || indicator.basisText);
  const payoutText = safeCustomerText(indicator.payoutSummary || indicator.summary);
  return {
    liability: text(indicator.liability || indicator.title || indicator.name),
    payoutSummary: payoutText,
    basis: basisText,
    requiredFieldHints: requiredFieldsFromText(`${basisText} ${payoutText} ${indicator.calculationReason || ''}`),
    sourceUrl: sourceUrlFrom(indicator),
  };
}

function recordPromptItem(record = {}) {
  return {
    title: text(record.title || record.productName || record.name),
    url: sourceUrlFrom(record),
    excerpt: extractOfficialResponsibilityText(officialResponsibilitySourceTextFrom(record), PROMPT_RESPONSIBILITY_EXCERPT_LIMIT),
  };
}

function officialSummaryPromptItem(record = {}) {
  return {
    title: text(record.title || record.productName || record.name),
    url: sourceUrlFrom(record),
    summary: excerpt(officialResponsibilitySummaryTextFrom(record), PROMPT_RESPONSIBILITY_EXCERPT_LIMIT),
  };
}

function officialAnalysisSources(analysis = {}) {
  return normalizeArray(analysis.sources)
    .map((source) => ({
      source,
      title: text(source?.title || source?.name || source?.url),
      url: sourceUrlFrom(source),
      snippet: text(source?.snippet || source?.evidenceLabel || source?.description),
    }))
    .filter((source) => source.title || source.url || source.snippet)
    .slice(0, 6);
}

const OFFICIAL_ANALYSIS_DOMAINS = [
  'newchinalife.com',
  'pingan.com',
  'chinalife.com',
  'cpic.com',
  'picc.com',
];

function hasOfficialAnalysisDomain(value) {
  const url = text(value);
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OFFICIAL_ANALYSIS_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isOfficialAnalysisSource(source = {}) {
  const evidenceLevel = text(source.evidenceLevel || source.evidence_level).toLowerCase();
  const sourceType = text(source.sourceType || source.source_type || source.type).toLowerCase();
  return source.official === true
    || evidenceLevel === 'insurer_official'
    || sourceType === 'insurer_official'
    || sourceType === 'official'
    || hasOfficialAnalysisDomain(sourceUrlFrom(source));
}

function sourceRecordsFromOfficialAnalysis(analysis = {}, { company, productName } = {}) {
  const coverageText = normalizeArray(analysis.coverageTable)
    .map((row) => [row?.coverageType, row?.scenario, row?.payout, row?.note].map(text).filter(Boolean).join('：'))
    .filter(Boolean)
    .join('\n');
  return officialAnalysisSources(analysis)
    .filter((source) => isOfficialAnalysisSource(source.source))
    .map((source) => ({
      company,
      productName,
      title: source.title || productName,
      url: source.url,
      pageText: ['第五条 保险责任', source.snippet, coverageText].filter(Boolean).join('\n'),
      official: true,
    }));
}

function responsibilityCardsFromOfficialAnalysis(analysis = {}, { company, productName } = {}) {
  const sources = officialAnalysisSources(analysis);
  const firstSource = sources[0] || {};
  return normalizeArray(analysis.coverageTable)
    .map((row, index) => {
      const title = text(row?.coverageType || row?.title || row?.name);
      const scenario = text(row?.scenario || row?.description);
      const payout = text(row?.payout || row?.amount || row?.limit);
      const note = text(row?.note || row?.remark);
      return {
        id: `official_analysis_${index + 1}`,
        productKey: productKeyFor(company, productName),
        company,
        productName,
        title,
        category: '',
        plainSummary: scenario,
        payoutSummary: payout,
        sourceUrl: sourceUrlFrom(row) || firstSource.url || '',
        sourceTitle: text(row?.sourceTitle) || firstSource.title || '',
        sourceExcerpt: [scenario, payout, note].filter(Boolean).join(' '),
        indicators: [],
      };
    })
    .filter((card) => card.title && (card.sourceExcerpt || card.plainSummary || card.payoutSummary));
}

function buildDeepSeekPrompt({ company, productName, records }) {
  const context = {
    product: { company, productName },
    officialSources: normalizeArray(records).map(recordPromptItem),
  };
  return [
    '你是一名保险产品分析师，请基于提供的保险条款原文，分析以下产品：',
    '',
    `产品名称：${productName}`,
    '',
    '任务：',
    '1. 提取该产品的核心保险责任。',
    '2. 用普通客户能听懂的话解释这个保险主要解决什么问题。',
    '3. 区分“确定责任”和“不确定利益”，尤其说明分红不保证。',
    '4. 不要把医疗、重疾、报销类功能误写进去。',
    '5. 如果条款中没有明确写明，不要自行推断。',
    '6. 输出内容要包括：',
    '   - 产品定位',
    '   - 主要保险责任',
    '   - 主要功能',
    '   - 适合解决的问题',
    '   - 不适合解决的问题',
    '   - 免责或风险提示',
    '',
    '要求：',
    '- 只依据条款和产品说明书。',
    '- 用中文回答。',
    '- 面向普通投保人，不要写得太法律化。',
    '- 如果涉及给付比例、年龄、期限，要写清楚。',
    '',
    '以下是条款和产品说明书原文：',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function resolveDeepSeekConfig(env = process.env) {
  const timeoutCandidate = Number(env.DEEPSEEK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    apiKey: text(env.DEEPSEEK_API_KEY),
    baseUrl: text(env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
    model: text(env.DEEPSEEK_MODEL) || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeoutCandidate) ? Math.max(1000, timeoutCandidate) : DEFAULT_TIMEOUT_MS,
  };
}

function deepSeekTransportError(error) {
  if (error?.code && error?.status) return error;
  const timedOut = error?.name === 'AbortError';
  const next = new Error(timedOut ? 'DeepSeek request timed out' : 'DeepSeek request failed');
  next.code = timedOut ? 'DEEPSEEK_REQUEST_TIMEOUT' : 'DEEPSEEK_REQUEST_FAILED';
  next.status = 502;
  next.cause = error;
  return next;
}

function previewForLog(value, limit = DEEPSEEK_LOG_PREVIEW_LIMIT) {
  const normalized = text(value).replace(/\s+/gu, ' ');
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function responseShapeForLog(value) {
  const source = value?.summary || value?.result || value?.data || value;
  const responsibilities = normalizeArray(source?.mainResponsibilities)
    .concat(normalizeArray(source?.responsibilities))
    .concat(normalizeArray(source?.insuranceResponsibilities))
    .concat(valuesFromKeys(source, ['主要保险责任', '保险责任', '核心保险责任'])
      .flatMap((item) => responsibilityItemsFromValue(item, '主要保险责任')));
  return {
    topLevelKeys: source && typeof source === 'object' && !Array.isArray(source)
      ? Object.keys(source).slice(0, 20)
      : [],
    headline: previewForLog(
      source?.headline
        || source?.productSummary
        || source?.summary
        || source?.产品定位
        || source?.产品总结,
      300,
    ),
    responsibilityCount: responsibilities.length,
    responsibilityTitles: responsibilities
      .map((item) => text(item?.title || item?.name || item?.coverageType || item?.liability || item?.责任名称 || item?.名称 || item?.标题))
      .filter(Boolean)
      .slice(0, 20),
  };
}

function logDeepSeekCustomerSummary(event, detail = {}) {
  console.info(`[customer-responsibility-summary] ${event}`, detail);
}

export async function callDeepSeekForCustomerResponsibilitySummary({
  prompt,
  company = '',
  productName = '',
  modelNameOverride = '',
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const config = resolveDeepSeekConfig(env);
  const requestedModel = text(modelNameOverride) || config.model;
  if (!config.apiKey) {
    const error = new Error('DeepSeek API key is not configured');
    error.code = 'DEEPSEEK_API_KEY_MISSING';
    error.status = 503;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(new URL('/chat/completions', config.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: requestedModel,
          messages: [
            { role: 'system', content: '你是保险责任摘要助手，只输出合法 JSON。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
      });
    } catch (error) {
      throw deepSeekTransportError(error);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `DeepSeek request failed: ${response.status}`);
      error.code = 'DEEPSEEK_REQUEST_FAILED';
      error.status = 502;
      throw error;
    }
    const content = text(payload?.choices?.[0]?.message?.content);
    logDeepSeekCustomerSummary('DeepSeek raw response', {
      company: text(company),
      productName: text(productName),
      model: requestedModel,
      status: response.status,
      responseId: text(payload?.id),
      finishReason: text(payload?.choices?.[0]?.finish_reason),
      rawChars: content.length,
      rawPreview: previewForLog(content),
      usage: payload?.usage && typeof payload.usage === 'object' ? payload.usage : undefined,
    });
    const parsed = parseJson(content, null);
    logDeepSeekCustomerSummary('DeepSeek parsed response shape', {
      company: text(company),
      productName: text(productName),
      model: requestedModel,
      parsed: Boolean(parsed),
      ...responseShapeForLog(parsed),
    });
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function safeCustomerSummary(row = {}) {
  const summary = row.summaryJson || row.summary_json || row;
  return {
    company: text(summary.company),
    productName: text(summary.productName),
    headline: text(summary.headline),
    mainResponsibilities: normalizeArray(summary.mainResponsibilities).map((item) => ({
      title: text(item?.title),
      plainText: text(item?.plainText),
      howItPays: text(item?.howItPays),
      requiredPolicyFields: uniqueStrings(item?.requiredPolicyFields),
    })),
    notices: uniqueStrings(summary.notices),
    requiredPolicyFields: uniqueStrings(summary.requiredPolicyFields),
    sourceUrls: uniqueStrings(summary.sourceUrls),
  };
}

function requiredFieldsFromText(value) {
  const content = text(value);
  const fields = [];
  const add = (pattern, field) => {
    if (pattern.test(content)) fields.push(field);
  };
  add(/基本保险金额/u, '基本保险金额');
  add(/实际交纳|已交|已支付|保险费/u, '已交保险费');
  add(/累积红利|红利保险金额/u, '累积红利保险金额');
  add(/现金价值/u, '现金价值');
  add(/保单年度|合同生效.*年|生效之日起.*年/u, '保单年度或合同生效日期');
  add(/年龄|周岁/u, '被保险人年龄');
  add(/意外|疾病|身故|全残|伤残|确诊/u, '出险原因和出险日期');
  add(/医疗费用|实际费用|发票|报销/u, '实际医疗费用');
  add(/保险期间|届满|满期/u, '保险期间');
  add(/交费期间|交费期|缴费期间|缴费期/u, '交费期间');
  add(/给付系数/u, '给付系数');
  return uniqueStrings(fields);
}

function compoundGrowthRateFromText(value) {
  const content = text(value).replace(/\s+/gu, '');
  if (!content) return '';
  const match = content.match(/(?:基本保险金额|基本保额)[×xX*][（(]1[+＋]([0-9]+(?:\.[0-9]+)?)%[）)](?:\^?[（(]n[-－]1[）)]|[（(]n[-－]1[）)])/u);
  return match ? `${match[1]}%` : '';
}

function compoundGrowthRateFromSources({ cards = [], indicators = [], records = [] } = {}) {
  const texts = [
    ...normalizeArray(cards).flatMap((card) => [
      card.title,
      card.plainSummary,
      card.payoutSummary,
      card.sourceExcerpt,
      ...normalizeArray(card.indicators).flatMap((indicator) => [
        indicator.formulaText,
        indicator.calculationText,
        indicator.sourceExcerpt,
      ]),
    ]),
    ...normalizeArray(indicators).flatMap((indicator) => [
      indicator.formulaText,
      indicator.calculationText,
      indicator.sourceExcerpt,
    ]),
    ...normalizeArray(records).flatMap((record) => [
      officialResponsibilitySummaryTextFrom(record),
      officialResponsibilitySourceTextFrom(record),
    ]),
  ];
  for (const value of texts) {
    const rate = compoundGrowthRateFromText(value);
    if (rate) return rate;
  }
  return '';
}

function summaryAlreadyExplainsCompoundGrowth(summary = {}, rate = '') {
  const normalizedRate = text(rate);
  if (!normalizedRate) return true;
  const content = [
    summary.headline,
    ...normalizeArray(summary.mainResponsibilities).flatMap((item) => [
      item.title,
      item.plainText,
      item.howItPays,
    ]),
  ].join(' ');
  return content.includes(normalizedRate) && /(?:复利|递增|增长|有效保险金额)/u.test(content);
}

function enrichSummaryWithCompoundGrowth(summary = {}, sources = {}) {
  const rate = compoundGrowthRateFromSources(sources);
  if (!rate || summaryAlreadyExplainsCompoundGrowth(summary, rate)) return summary;
  const responsibilities = normalizeArray(summary.mainResponsibilities);
  if (!responsibilities.length) return summary;
  const note = `其中基本保险金额×(1+${rate})^(n-1)可以理解为当年度有效保险金额按每年${rate}复利递增。`;
  const targetIndex = responsibilities.findIndex((item) =>
    /身故|身体?全残|保险金额|基本保额/u.test(`${item?.title || ''} ${item?.plainText || ''} ${item?.howItPays || ''}`),
  );
  const index = targetIndex >= 0 ? targetIndex : 0;
  return {
    ...summary,
    mainResponsibilities: responsibilities.map((item, itemIndex) => itemIndex === index
      ? {
          ...item,
          plainText: [text(item?.plainText), note].filter(Boolean).join('\n'),
        }
      : item),
  };
}

function officialRecordExcerptForCard(card = {}, records = []) {
  const title = text(card.title);
  const cardUrl = sourceUrlFrom(card);
  const candidates = normalizeArray(records)
    .map((record) => ({
      record,
      url: sourceUrlFrom(record),
      sourceTitle: text(record.title || record.sourceTitle || record.productName || record.name),
      excerpt: extractOfficialResponsibilityText(officialResponsibilitySourceTextFrom(record), OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT),
    }))
    .filter((item) => item.excerpt && (!title || item.excerpt.includes(title)))
    .sort((left, right) => {
      const leftUrlMatch = cardUrl && left.url === cardUrl ? 1 : 0;
      const rightUrlMatch = cardUrl && right.url === cardUrl ? 1 : 0;
      return rightUrlMatch - leftUrlMatch || right.excerpt.length - left.excerpt.length;
    });
  return candidates[0] || null;
}

function enrichCardsWithOfficialRecords(cards = [], records = []) {
  return normalizeArray(cards).map((card) => {
    const official = officialRecordExcerptForCard(card, records);
    if (!official || official.excerpt.length <= text(card.sourceExcerpt).length + 80) return card;
    return {
      ...card,
      sourceUrl: sourceUrlFrom(card) || official.url,
      sourceTitle: text(card.sourceTitle) || official.sourceTitle,
      sourceExcerpt: official.excerpt,
    };
  });
}

function cleanOfficialResponsibilityText(card = {}) {
  const title = text(card.title);
  let content = text(card.sourceExcerpt).replace(/\s+/gu, ' ');
  if (!content) return '';
  content = content
    .replace(/^保险责任在本合同保险期间内[，,。；;：:\s]*我们按下列规定承担保险责任[：:\s]*/u, '')
    .replace(/[（(]\s*详见释义\s*[）)]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const originalContent = content;
  if (title) {
    const index = content.indexOf(title);
    if (index >= 0) {
      const afterTitle = content.slice(index + title.length).trim();
      if (afterTitle.replace(/[。；;，,\s]/gu, '').length >= 8) content = afterTitle;
    }
  }
  if (!content) return '';
  if (content.replace(/[。；;，,\s]/gu, '').length < 8) content = originalContent;
  return content;
}

function deathOrDisabilityOfficialSummary(card = {}) {
  const title = text(card.title);
  const content = cleanOfficialResponsibilityText(card);
  const target = `${title} ${content}`;
  if (!/(?:身故|死亡).{0,8}(?:身体)?全残|(?:身体)?全残.{0,8}(?:身故|死亡)/u.test(target)) return null;
  if (!/(?:现金价值|给付系数|基本保险金额|18\s*周岁|180\s*日)/u.test(target)) return null;
  if (/特定公共交通工具/u.test(target)) {
    return {
      plainText: truncateText('被保险人以乘客身份乘坐特定公共交通工具期间，在工具内因交通事故遭受意外伤害，并在约定期间内因此身故或身体全残且符合年龄条件时，保险公司承担本项额外给付责任', 260),
      howItPays: truncateText('在按身故或身体全残保险金给付的同时，另行给付特定公共交通工具意外伤害身故或身体全残保险金，金额为基本保险金额的 1.5 倍，合同终止', 300),
      fieldBasis: target,
    };
  }
  const plainParts = [];
  if (/180\s*日/u.test(target) && /疾病/u.test(target)) {
    plainParts.push('疾病原因在合同生效 180 日内身故或身体全残，保险公司按已交保险费给付，合同终止');
  }
  if (/意外/u.test(target) || /180\s*日/u.test(target)) {
    plainParts.push('意外原因或合同生效 180 日后身故或身体全残，按出险年龄、交费阶段和保单价值规则确定给付金额');
  }
  const howParts = [];
  if (/18\s*周岁/u.test(target) && /实际交纳|已交|保险费/u.test(target) && /现金价值/u.test(target)) {
    howParts.push('18 周岁前按已交保险费与现金价值二者较大者给付');
  }
  if (/交费期间届满后的首个保单周年日/u.test(target) && /二者之较大|二者较大|二者之最大|二者最大/u.test(target)) {
    howParts.push('18 周岁后且交费期届满前，按已交保险费乘以给付系数与现金价值二者较大者给付');
  }
  if (/三者之最大|三者最大/u.test(target) && /基本保险金额/u.test(target)) {
    howParts.push('交费期届满后，按已交保险费乘以给付系数、现金价值、基本保险金额按约定递增后的金额三者较大者给付');
  }
  if (/1\.6|1\.4|1\.2/u.test(target) && /给付系数/u.test(target)) {
    howParts.push('给付系数按出险年龄区间确定，条款列明 18 至 40 周岁、41 至 60 周岁、61 周岁及以后分别适用不同系数');
  }
  return {
    plainText: truncateText(plainParts.length ? plainParts.join('；') : `被保险人身故或身体全残时，保险公司按官网条款约定给付${title}。`, 260),
    howItPays: truncateText(howParts.length ? howParts.join('；') : payoutTextFromOfficialExcerpt(content), 300),
    fieldBasis: target,
  };
}

function customerExcerptFromCard(card = {}) {
  const specialSummary = deathOrDisabilityOfficialSummary(card);
  if (specialSummary) return specialSummary.plainText;
  const content = cleanOfficialResponsibilityText(card);
  if (!content) return '';
  const sentenceEnd = content.search(/[。；;]/u);
  const excerptText = sentenceEnd > 35 ? content.slice(0, sentenceEnd + 1) : content;
  return truncateText(`官网条款摘录显示：${excerptText}`, 220);
}

function payoutTextFromOfficialExcerpt(value) {
  const content = text(value)
    .replace(/^官网条款摘录显示：/u, '')
    .replace(/[（(]\s*详见释义\s*[）)]/gu, '')
    .replace(/\s+/gu, ' ');
  const match = content.match(/(?:按|按照)[^。；;]{2,120}?给付[^。；;]{0,80}/u);
  if (match?.[0]) return truncateText(match[0], 180);
  return '';
}

function summaryItemFromCard(card = {}) {
  const title = text(card.title);
  const specialSummary = deathOrDisabilityOfficialSummary(card);
  const officialText = customerExcerptFromCard(card);
  const body = officialText
    || safeCustomerText(card.plainSummary)
    || safeCustomerText(card.payoutSummary)
    || `${title}按保险合同约定承担保险责任。`;
  const condition = text(card.triggerCondition);
  const payout = specialSummary?.howItPays
    || payoutTextFromOfficialExcerpt(officialText)
    || safeCustomerText(card.payoutSummary || card.howItPays);
  const indicatorText = normalizeArray(card.indicators)
    .map((indicator) => safeCustomerText(indicator.payoutSummary || indicator.basis || indicator.formulaText))
    .filter(Boolean)
    .join(' ');
  const plainText = truncateText(
    body || [condition, payout].filter(Boolean).join('：') || `${title}按保险合同约定承担保险责任。`,
    180,
  );
  const howItPays = truncateText(
    payout || indicatorText || `${title}的给付金额和给付条件以保险合同及保单载明信息为准。`,
    180,
  );
  const fieldBasis = specialSummary?.fieldBasis
    || (officialText ? `${officialText} ${condition} ${payout}` : `${body} ${condition} ${payout} ${indicatorText}`);
  return {
    title,
    plainText,
    howItPays,
    requiredPolicyFields: uniqueStrings([
      ...requiredFieldsFromText(fieldBasis),
      ...(officialText ? [] : normalizeArray(card.indicators).flatMap((indicator) =>
        requiredFieldsFromText(`${indicator.payoutSummary || ''} ${indicator.basis || ''} ${indicator.formulaText || ''}`),
      )),
    ]),
  };
}

function summaryItemFromOfficialClause(clause = {}) {
  const title = text(clause.title);
  const cardLike = {
    title,
    sourceExcerpt: clause.excerpt,
    sourceUrl: clause.sourceUrl,
    sourceTitle: clause.sourceTitle,
  };
  const specialSummary = deathOrDisabilityOfficialSummary(cardLike);
  const plainText = specialSummary?.plainText || customerExcerptFromCard(cardLike);
  const howItPays = specialSummary?.howItPays || payoutTextFromOfficialExcerpt(clause.excerpt);
  return {
    title,
    plainText: truncateText(plainText || `${title}按官网保险责任正文约定承担保险责任。`, 260),
    howItPays: truncateText(howItPays || `${title}的给付条件和给付金额以官网条款及保单载明信息为准。`, 300),
    requiredPolicyFields: requiredFieldsFromText(`${specialSummary?.fieldBasis || ''} ${clause.excerpt}`),
  };
}

function summaryItemFromIndicator(indicator = {}) {
  const title = text(indicator.liability || indicator.title || indicator.name);
  const body = safeCustomerText(indicator.payoutSummary || indicator.basis || indicator.formulaText);
  return {
    title,
    plainText: truncateText(body || `${title}按保险合同约定承担保险责任。`, 180),
    howItPays: truncateText(safeCustomerText(indicator.basis || indicator.payoutSummary) || `${title}的金额以保单信息和条款约定为准。`, 180),
    requiredPolicyFields: requiredFieldsFromText(`${body} ${indicator.basis || ''}`),
  };
}

function inferHeadline(productName, items) {
  const titles = items.map((item) => item.title).join('、');
  if (/两全/u.test(productName) || (/身故|全残/u.test(titles) && /满期|生存/u.test(titles))) {
    return '这是一款兼有身故或全残保障和满期给付的保险。';
  }
  if (/年金|养老/u.test(productName) || /年金|养老金|生存金|祝寿/u.test(titles)) {
    return '这款产品主要按合同约定提供生存领取或养老年金。';
  }
  if (/重疾|重大疾病/u.test(productName) || /重疾|重大疾病|轻症|中症/u.test(titles)) {
    return '这款产品主要围绕重大疾病等疾病风险提供保障。';
  }
  if (/医疗/u.test(productName) || /医疗|住院|门诊|报销/u.test(titles)) {
    return '这款产品主要按合同约定报销或给付医疗相关费用。';
  }
  if (/身故|全残|寿险/u.test(productName) || /身故|全残|寿险/u.test(titles)) {
    return '这款产品主要提供身故或全残等人身保障。';
  }
  const preview = items.slice(0, 3).map((item) => item.title).join('、');
  return preview ? `这款产品主要提供${preview}等保险责任。` : '这款产品的保险责任以合同条款和保单载明信息为准。';
}

function noticesFromCards(cards, items) {
  const content = normalizeArray(cards)
    .map((card) => `${card.title || ''} ${card.plainSummary || ''} ${card.payoutSummary || ''} ${card.sourceExcerpt || ''}`)
    .join(' ');
  const notices = ['具体金额以正式保险合同、保单载明信息和条款表格为准。'];
  if (/红利|分红/u.test(content)) {
    notices.push('分红或累积红利金额不是固定保证值，应以保险公司实际公布和保单记录为准。');
  }
  if (items.some((item) => item.requiredPolicyFields.includes('出险原因和出险日期'))) {
    notices.push('理赔类责任需要结合实际出险原因、出险日期和条款约定判断。');
  }
  return uniqueStrings(notices);
}

function hasCustomerSummaryContent(summary = {}) {
  return normalizeArray(summary.mainResponsibilities).some((item) =>
    text(item?.title) || text(item?.plainText) || text(item?.howItPays),
  );
}

function officialResponsibilityTextsFromRecords(records = []) {
  return uniqueStrings(
    normalizeArray(records)
      .map((record) => extractOfficialResponsibilityText(officialResponsibilitySourceTextFrom(record), OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT))
      .filter(Boolean),
  );
}

function noticesFromOfficialRecords(records, items) {
  const content = officialResponsibilityTextsFromRecords(records).join(' ');
  const notices = ['具体金额以正式保险合同、保单载明信息和条款表格为准。'];
  if (/红利|分红|累积红利/u.test(content)) {
    notices.push('分红或累积红利金额不是固定保证值，应以保险公司实际公布和保单记录为准。');
  }
  if (items.some((item) => normalizeArray(item.requiredPolicyFields).includes('出险原因和出险日期'))) {
    notices.push('理赔类责任需要结合实际出险原因、出险日期和条款约定判断。');
  }
  return uniqueStrings(notices);
}

function buildSummaryContext({ productKey, company, productName, cards, indicators, records }) {
  return {
    productKey,
    product: { company, productName },
    cards: normalizeArray(cards).map(cardPromptItem),
    indicators: normalizeArray(indicators).map(indicatorPromptItem),
    officialSources: normalizeArray(records).map(recordPromptItem),
  };
}

function normalizeStructuredSummaryToCustomerSummary(raw = {}, { company, productName, sourceUrls = [] } = {}) {
  const source = raw?.summary || raw?.result || raw?.data || raw;
  const responsibilities = normalizeArray(source?.responsibilities)
    .concat(normalizeArray(source?.mainResponsibilities))
    .map((item) => {
      const body = text(item?.plainText || item?.summary || item?.description || item?.内容);
      const paymentRule = text(item?.paymentRule || item?.howItPays || item?.给付规则 || item?.赔付方式);
      return {
        title: text(item?.title || item?.name || item?.责任名称),
        plainText: body,
        howItPays: paymentRule,
        requiredPolicyFields: requiredFieldsFromText(`${body} ${paymentRule} ${item?.triggerCondition || ''}`),
      };
    })
    .filter((item) => item.title || item.plainText || item.howItPays);
  const notices = uniqueStrings([
    ...normalizeArray(source?.importantNotes).map(text),
    ...normalizeArray(source?.notices).map(text),
    ...normalizeArray(source?.missingOrUnclear).map((item) => {
      const content = text(item);
      return content ? `需核验：${content}` : '';
    }),
  ]);
  return {
    company,
    productName,
    headline: text(source?.headline || source?.productSummary || source?.summary),
    mainResponsibilities: responsibilities,
    notices,
    requiredPolicyFields: uniqueStrings(responsibilities.flatMap((item) => item.requiredPolicyFields)),
    sourceUrls: uniqueStrings(source?.sourceUrls || sourceUrls),
  };
}

function buildGenerationRun({
  productKey,
  company,
  productName,
  status,
  routing = {},
  sourceDigest = '',
  sourceSections = {},
  qualityIssues = [],
  rawPreview = '',
  modelName = '',
  modelTier = '',
  now = new Date().toISOString(),
} = {}) {
  return {
    id: `customer_summary_run:${productKey}:${CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION}:${crypto.randomUUID()}`,
    productKey,
    company,
    productName,
    summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
    status,
    productCategory: text(routing.productCategory),
    categoryLabel: text(routing.categoryLabel),
    modelProvider: modelName ? 'deepseek' : '',
    modelName: text(modelName),
    modelTier: text(modelTier || routing.modelTier),
    sourceDigest,
    sourceSectionsDigest: text(sourceSections.sourceSectionsDigest),
    qualityIssues: normalizeArray(qualityIssues),
    rawPreview: previewForLog(rawPreview),
    createdAt: now,
    payload: {
      routing,
      sourceSectionsQuality: sourceSections.quality,
      qualityIssues: normalizeArray(qualityIssues),
    },
  };
}

async function persistGenerationReviewRun(persistGenerationRun, run) {
  if (typeof persistGenerationRun !== 'function') return null;
  return persistGenerationRun(run);
}

export async function generateProductCustomerResponsibilitySummary({
  state = {},
  db,
  input = {},
  findSummary,
  persistSummary,
  persistGenerationRun,
  generateWithDeepSeek = callDeepSeekForCustomerResponsibilitySummary,
  generateOfficialAnalysis,
  modelName = resolveDeepSeekConfig().model,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const company = text(input.company).slice(0, 80);
  const inputProductName = text(input.name || input.productName).slice(0, 160);
  if (!company || !inputProductName) {
    const error = new Error('请输入保险公司和保险名称');
    error.code = 'POLICY_RESPONSIBILITY_QUERY_INPUT_REQUIRED';
    error.status = 400;
    throw error;
  }

  const inputProductKey = productKeyFor(company, inputProductName);
  const inputProduct = { company, productName: inputProductName, productKey: inputProductKey };
  let cards = loadProductResponsibilityCards(db, inputProduct);
  let records = sourceRecordsForProduct(state.knowledgeRecords, inputProduct);
  let indicators = indicatorsForProduct(state.insuranceIndicatorRecords, inputProduct);
  cards = enrichCardsWithOfficialRecords(cards, records);
  if (!cards.length && !records.length) {
    const existing = typeof findSummary === 'function'
      ? await findSummary({
        productKey: inputProductKey,
        summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
        sourceDigest: '',
      })
      : null;
    if (existing) {
      return {
        ok: true,
        source: 'database',
        summary: safeCustomerSummary(existing),
      };
    }
    if (typeof generateOfficialAnalysis === 'function') {
      const officialAnalysis = await generateOfficialAnalysis({ company, productName: inputProductName, input });
      cards = responsibilityCardsFromOfficialAnalysis(officialAnalysis, { company, productName: inputProductName });
      records = sourceRecordsFromOfficialAnalysis(officialAnalysis, { company, productName: inputProductName });
      indicators = [];
    }
    if (!cards.length && !records.length) {
      await persistGenerationReviewRun(persistGenerationRun, buildGenerationRun({
        productKey: inputProductKey,
        company,
        productName: inputProductName,
        status: 'needs_source_review',
        sourceDigest: '',
        now: nowIso(),
      }));
      return {
        ok: false,
        status: 'needs_source_review',
        message: '这个产品还缺少可用于客户摘要的保险责任来源。',
      };
    }
  }

  const productName = preferredProductNameFromSources({ inputProductName, cards, records, indicators });
  const productKey = productKeyFor(company, productName);
  if (productName !== inputProductName) {
    const resolvedProduct = { company, productName, productKey };
    const resolvedCards = loadProductResponsibilityCards(db, resolvedProduct);
    const resolvedRecords = sourceRecordsForProduct(state.knowledgeRecords, resolvedProduct);
    const resolvedIndicators = indicatorsForProduct(state.insuranceIndicatorRecords, resolvedProduct);
    if (resolvedCards.length || resolvedRecords.length) {
      cards = resolvedCards;
      records = resolvedRecords;
      indicators = resolvedIndicators;
      cards = enrichCardsWithOfficialRecords(cards, records);
    }
  }
  const sourceDigest = buildCustomerResponsibilitySourceDigest({ cards, indicators, records });
  const existing = typeof findSummary === 'function'
    ? await findSummary({
      productKey,
      summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
      sourceDigest,
    })
    : null;
  if (existing) {
    return {
      ok: true,
      source: 'database',
      summary: safeCustomerSummary(existing),
    };
  }

  const structuredNow = nowIso();
  let resolvedModelName = text(modelName) || DEFAULT_MODEL;
  const resolvedSources = resolveOfficialResponsibilitySources({
    company,
    productName,
    records,
  });
  if (resolvedSources.status !== 'ready') {
    await persistGenerationReviewRun(persistGenerationRun, buildGenerationRun({
      productKey,
      company,
      productName,
      status: 'needs_source_review',
      sourceDigest,
      now: structuredNow,
    }));
    return {
      ok: false,
      status: 'needs_source_review',
      message: '这个产品还缺少可用于客户摘要的官网保险责任资料。',
    };
  }
  const sourceRecords = resolvedSources.records;
  const preliminaryRouting = routeInsuranceProductCategory({
    productName,
    records: sourceRecords,
    indicators,
    cards,
    sourceSections: { mainResponsibilityText: sourceRecords.map((record) => officialResponsibilitySourceTextFrom(record)).join('\n') },
  });
  const sourceSections = extractStructuredResponsibilitySections({
    productCategory: preliminaryRouting.productCategory,
    records: sourceRecords,
  });
  if (sourceSections.quality?.status !== 'complete') {
    const qualityIssues = normalizeArray(sourceSections.quality?.warnings)
      .map((warning) => ({ code: text(warning) || 'source_extraction_warning' }));
    await persistGenerationReviewRun(persistGenerationRun, buildGenerationRun({
      productKey,
      company,
      productName,
      status: 'needs_extraction_review',
      routing: preliminaryRouting,
      sourceDigest,
      sourceSections,
      qualityIssues,
      modelTier: preliminaryRouting.modelTier,
      now: structuredNow,
    }));
    return {
      ok: false,
      status: 'needs_extraction_review',
      message: '这个产品的保险责任资料需要进一步核验，请稍后再试。',
    };
  }
  const routing = routeInsuranceProductCategory({
    productName,
    records: sourceRecords,
    indicators,
    cards,
    sourceSections,
  });
  const routedModelName = routing.modelTier === 'pro' ? PRO_MODEL : resolvedModelName;
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company, productName },
    routing,
    sourceSections,
    cards: normalizeArray(cards).map(cardPromptItem),
    indicators: normalizeArray(indicators).map(indicatorPromptItem),
  });
  let rawSummary = null;
  try {
    rawSummary = await generateWithDeepSeek({
      prompt,
      company,
      productName,
      cards,
      indicators,
      records: sourceRecords,
      modelNameOverride: routedModelName,
    });
  } catch (error) {
    const qualityIssues = [{
      code: text(error?.code) || 'model_generation_failed',
      message: text(error?.message),
    }];
    await persistGenerationReviewRun(persistGenerationRun, buildGenerationRun({
      productKey,
      company,
      productName,
      status: 'needs_model_review',
      routing,
      sourceDigest,
      sourceSections,
      qualityIssues,
      rawPreview: text(error?.message),
      modelName: routedModelName,
      modelTier: routing.modelTier,
      now: structuredNow,
    }));
    return {
      ok: false,
      status: 'needs_model_review',
      message: '这个产品的保险责任资料需要进一步核验，请稍后再试。',
    };
  }
  const quality = evaluateResponsibilitySummaryQuality({
    routing,
    sourceSections,
    summary: rawSummary,
  });
  if (quality.status !== 'passed') {
    await persistGenerationReviewRun(persistGenerationRun, buildGenerationRun({
      productKey,
      company,
      productName,
      status: 'needs_model_review',
      routing,
      sourceDigest,
      sourceSections,
      qualityIssues: quality.issues,
      rawPreview: JSON.stringify(rawSummary),
      modelName: routedModelName,
      modelTier: routing.modelTier,
      now: structuredNow,
    }));
    return {
      ok: false,
      status: 'needs_model_review',
      message: '这个产品的保险责任资料需要进一步核验，请稍后再试。',
    };
  }
  const summaryJson = enrichSummaryWithCompoundGrowth(
    normalizeStructuredSummaryToCustomerSummary(rawSummary, {
      company,
      productName,
      sourceUrls: uniqueStrings(sourceRecords.map(sourceUrlFrom)),
    }),
    { cards, indicators, records: sourceRecords },
  );
  const summaryContext = buildSummaryContext({ productKey, company, productName, cards, indicators, records: sourceRecords });
  const now = structuredNow;
  const row = {
    id: `customer_summary:${productKey}:${CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION}`,
    productKey,
    company,
    productName,
    summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
    status: 'ready',
    headline: summaryJson.headline,
    summaryJson,
    sourceUrls: summaryJson.sourceUrls,
    sourceDigest,
    modelProvider: 'deepseek',
    modelName: routedModelName,
    generatedAt: now,
    updatedAt: now,
    payload: {
      productKey,
      company,
      productName,
      summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
      sourceDigest,
      summaryJson,
      sourceUrls: summaryJson.sourceUrls,
      summaryContext,
      productCategory: routing.productCategory,
      categoryLabel: routing.categoryLabel,
      featureTags: routing.featureTags,
      sourceSectionsDigest: sourceSections.sourceSectionsDigest,
      sourceSections,
      sourceSectionsQuality: sourceSections.quality,
      modelTier: routing.modelTier,
      qualityGate: { status: 'passed', issues: [] },
      routing,
    },
  };
  const saved = typeof persistSummary === 'function' ? await persistSummary(row) : row;
  await persistGenerationReviewRun(persistGenerationRun, buildGenerationRun({
    productKey,
    company,
    productName,
    status: 'passed',
    routing,
    sourceDigest,
    sourceSections,
    qualityIssues: [],
    rawPreview: JSON.stringify(rawSummary),
    modelName: routedModelName,
    modelTier: routing.modelTier,
    now,
  }));
  if (generateWithDeepSeek === callDeepSeekForCustomerResponsibilitySummary) {
    logDeepSeekCustomerSummary('DeepSeek summary cached', {
      productKey,
      company,
      productName,
      summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
      modelName: routedModelName,
      sourceDigest,
      responsibilityCount: normalizeArray(summaryJson.mainResponsibilities).length,
      responsibilityTitles: normalizeArray(summaryJson.mainResponsibilities)
        .map((item) => text(item?.title))
        .filter(Boolean)
        .slice(0, 20),
      generatedAt: now,
    });
  }
  return {
    ok: true,
    source: 'generated',
    summary: safeCustomerSummary(saved || row),
  };
}
