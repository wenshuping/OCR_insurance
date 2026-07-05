import crypto from 'node:crypto';

import { jsonrepair } from 'jsonrepair';

import { routeInsuranceProductCategory } from './insurance-product-category-router.mjs';
import {
  callDeepSeekForResponsibilityPlanner,
  normalizeResponsibilityPlannerMode,
  runResponsibilityPlanner,
} from './responsibility-planner.service.mjs';
import { resolveOfficialResponsibilitySources } from './responsibility-source-resolver.mjs';
import { extractStructuredResponsibilitySections } from './responsibility-section-extractor.mjs';
import {
  buildOfficialResponsibilityRetryPrompt,
  buildStructuredResponsibilityPrompt,
} from './responsibility-summary-templates.mjs';
import { evaluateResponsibilitySummaryQuality } from './responsibility-summary-quality-gate.mjs';
import {
  RESPONSIBILITY_OFFICIAL_TEXT_FALLBACK_STATUS,
  buildOfficialTextFallbackCustomerSummary,
  getResponsibilityGenerationGovernanceConfig,
  responsibilityGenerationGovernanceDigest,
} from './responsibility-generation-governance.service.mjs';

export const CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION = 'customer-summary-v24-planner-blocks';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const PRO_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 45_000;
const DEEPSEEK_LOG_PREVIEW_LIMIT = 3000;
const OFFICIAL_RESPONSIBILITY_EXCERPT_LIMIT = 6500;
const PROMPT_RESPONSIBILITY_EXCERPT_LIMIT = 6500;

function text(value) {
  return String(value ?? '').trim();
}

function firstText(...values) {
  return values.map(text).find(Boolean) || '';
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function plainObject(value) {
  const candidate = typeof value === 'string' ? parseJson(value, null) : value;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
}

function excerpt(value, limit) {
  const normalized = text(value).replace(/\s+/gu, ' ');
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function parseJson(value, fallback = {}) {
  if (typeof value !== 'string') {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  }
  const raw = text(value);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidates = [
    raw,
    fenced?.[1] || '',
    raw.includes('{') && raw.includes('}') ? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1) : '',
  ].map(text).filter(Boolean);
  const seen = new Set();
  const parseCandidate = (candidate) => {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  };
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return parseCandidate(candidate);
    } catch {}
    try {
      return parseCandidate(jsonrepair(candidate));
    } catch {}
  }
  return fallback;
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

function customerSummaryModelCandidates({ routedModelName = '', resolvedModelName = '' } = {}) {
  const routed = text(routedModelName);
  const resolved = text(resolvedModelName) || DEFAULT_MODEL;
  if (routed === PRO_MODEL) {
    return uniqueStrings([DEFAULT_MODEL, resolved, PRO_MODEL]);
  }
  return uniqueStrings([routed || resolved, resolved]);
}

function sourceRefIdsFromValue(value) {
  return uniqueStrings(normalizeArray(value).map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return item;
    return item?.sourceRefId || item?.sourceId || item?.id;
  }));
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

export function buildCustomerResponsibilitySourceDigest({ cards = [], indicators = [], records = [], generationGovernance = null } = {}) {
  const payload = {
    cards: normalizeArray(cards).map(digestCard),
    indicators: normalizeArray(indicators).map(digestIndicator),
    records: normalizeArray(records).map(digestRecord),
    generationGovernanceDigest: generationGovernance
      ? responsibilityGenerationGovernanceDigest(generationGovernance)
      : '',
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
    const sourceRefs = sourceRefIdsFromValue(item?.sourceRefs || item?.source_refs || item?.sources);
    const normalized = {
      title: split?.title || rawTitle,
      plainText: split?.plainText || rawPlainText,
      triggerCondition: text(item?.triggerCondition || item?.trigger || item?.触发条件 || item?.给付条件),
      howItPays: text(item?.howItPays || item?.给付方式 || item?.给付规则 || item?.赔付方式),
      calculationStatus: text(item?.calculationStatus || item?.calculation_status || item?.计算状态),
      requiredPolicyFields: uniqueStrings(item?.requiredPolicyFields || item?.所需字段 || item?.需要字段),
    };
    if (sourceRefs.length) normalized.sourceRefs = sourceRefs;
    return normalized;
  }).filter((item) => item.title || item.plainText || item.triggerCondition || item.howItPays || item.calculationStatus || item.requiredPolicyFields.length || item.sourceRefs?.length);
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

function modelGenerationIssueFromError(error, fallbackCode) {
  const issue = {
    code: text(error?.code) || fallbackCode,
    message: text(error?.message),
  };
  for (const key of ['responseId', 'finishReason', 'rawPreview', 'modelName']) {
    const value = text(error?.[key]);
    if (value) issue[key] = value;
  }
  for (const key of ['status', 'rawChars']) {
    if (Number.isFinite(Number(error?.[key]))) issue[key] = Number(error[key]);
  }
  if (error?.usage && typeof error.usage === 'object') issue.usage = error.usage;
  return issue;
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
    if (!content) {
      const error = new Error('DeepSeek returned empty message content');
      error.code = 'empty_model_content';
      error.status = response.status;
      error.responseId = text(payload?.id);
      error.finishReason = text(payload?.choices?.[0]?.finish_reason);
      error.rawChars = 0;
      error.rawPreview = '';
      error.modelName = requestedModel;
      error.usage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : undefined;
      throw error;
    }
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
  const payload = plainObject(row.payload);
  const nestedPayload = plainObject(payload.payload);
  const sourceSections = plainObject(payload.sourceSections);
  const nestedSourceSections = plainObject(nestedPayload.sourceSections);
  const routing = plainObject(payload.routing || nestedPayload.routing || payload.summaryContext?.routing || nestedPayload.summaryContext?.routing);
  const normalizedContentBlocks = normalizeCustomerSummaryContentBlocks(
    summary.contentBlocks,
    summary,
    {
      ...payload,
      ...nestedPayload,
      sourceSections: Object.keys(nestedSourceSections).length ? nestedSourceSections : sourceSections,
    },
    { routing },
  );
  return {
    company: text(summary.company),
    productName: text(summary.productName),
    headline: text(summary.headline),
    mainResponsibilities: normalizeArray(summary.mainResponsibilities).map((item) => {
      const sourceRefs = sourceRefIdsFromValue(item?.sourceRefs);
      const normalized = {
        title: text(item?.title),
        plainText: text(item?.plainText),
        triggerCondition: text(item?.triggerCondition),
        howItPays: text(item?.howItPays),
        calculationStatus: text(item?.calculationStatus),
        requiredPolicyFields: uniqueStrings(item?.requiredPolicyFields),
      };
      if (sourceRefs.length) normalized.sourceRefs = sourceRefs;
      return normalized;
    }),
    notices: uniqueStrings(summary.notices),
    requiredPolicyFields: uniqueStrings(summary.requiredPolicyFields),
    sourceUrls: uniqueStrings(summary.sourceUrls),
    officialResponsibilityText: text(
      summary.officialResponsibilityText
        || summary.official_responsibility_text
        || payload.officialResponsibilityText
        || payload.official_responsibility_text
        || sourceSections.mainResponsibilityText
        || sourceSections.main_responsibility_text
        || nestedPayload.officialResponsibilityText
        || nestedPayload.official_responsibility_text
        || nestedSourceSections.mainResponsibilityText
        || nestedSourceSections.main_responsibility_text,
    ),
    contentBlocks: normalizeArray(normalizedContentBlocks)
      .map((block) => {
        const blockKey = text(block?.blockKey);
        return {
          blockKey,
          title: text(block?.title),
          enabled: block?.enabled !== false,
          editable: block?.editable !== false,
          order: Number.isFinite(Number(block?.order)) ? Number(block.order) : 0,
          content: text(block?.content),
        };
      })
      .filter((block) => block.blockKey || block.title || block.content),
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

function buildSummaryContext({ productKey, company, productName, cards, indicators, records }) {
  return {
    productKey,
    product: { company, productName },
    cards: normalizeArray(cards).map(cardPromptItem),
    indicators: normalizeArray(indicators).map(indicatorPromptItem),
    officialSources: normalizeArray(records).map(recordPromptItem),
  };
}

const CUSTOMER_SUMMARY_BLOCK_DEFINITIONS = [
  { blockKey: 'productPurpose', title: '产品主要做什么', order: 1 },
  { blockKey: 'responsibilities', title: '主要保险责任', order: 2 },
  { blockKey: 'productFunctions', title: '产品功能/权益', order: 3 },
  { blockKey: 'attentionNotes', title: '注意事项', order: 4 },
];

function linesToText(lines = []) {
  return normalizeArray(lines).map(text).filter(Boolean).join('\n');
}

function productFunctionTextFrom(item) {
  if (typeof item === 'string') return text(item);
  return firstText(item?.title, item?.name, item?.plainText, item?.summary, item?.description);
}

function responsibilitySearchText(item = {}) {
  return [
    item.title,
    item.plainText,
    item.howItPays,
  ].map(text).filter(Boolean).join(' ');
}

function hasCompositeEndowmentAccidentProfile(summary = {}, routing = {}) {
  const responsibilities = normalizeArray(summary.mainResponsibilities);
  const content = responsibilities.map(responsibilitySearchText).join(' ');
  const category = text(routing.productCategory || summary.productCategory);
  return category === 'endowment'
    && /意外/u.test(content)
    && /交通|航空|列车|客运|轮船|汽车|驾乘|步行|骑行|电梯|高空|公共场所|自然灾害|(?:10|15|20|30|40|60)\s*倍/u.test(content);
}

function sourceResponsibilityText(source = {}) {
  const directSource = plainObject(source);
  const nestedPayload = plainObject(directSource.payload);
  const sourceSections = plainObject(directSource.sourceSections);
  const nestedSourceSections = plainObject(nestedPayload.sourceSections);
  return text(
    directSource.officialResponsibilityText
      || directSource.official_responsibility_text
      || sourceSections.mainResponsibilityText
      || sourceSections.main_responsibility_text
      || nestedPayload.officialResponsibilityText
      || nestedPayload.official_responsibility_text
      || nestedSourceSections.mainResponsibilityText
      || nestedSourceSections.main_responsibility_text,
  );
}

function responsibilityDisplayLine(item = {}) {
  const title = text(item.title) || '保险责任';
  const plainText = text(item.plainText);
  const triggerCondition = text(item.triggerCondition);
  const howItPays = text(item.howItPays);
  const cleanPart = (value) => text(value).replace(/\s+/gu, ' ').replace(/[。；;]+$/u, '');
  const detailParts = [cleanPart(plainText)];
  if (triggerCondition && !plainText.includes(triggerCondition)) detailParts.push(`触发条件：${cleanPart(triggerCondition)}`);
  if (howItPays && !plainText.includes(howItPays)) detailParts.push(`给付规则：${cleanPart(howItPays)}`);
  const details = detailParts.filter(Boolean).join('；');
  return details ? `${title}：${details}。` : title;
}

function buildStructuredResponsibilitiesContent(summary = {}) {
  const responsibilities = normalizeArray(summary.mainResponsibilities);
  if (!responsibilities.length) return '';
  const hasBasicOptionalSplit = responsibilities.some((item) =>
    /基本责任|可选责任/u.test(`${item?.title || ''} ${item?.plainText || ''} ${item?.howItPays || ''}`),
  );
  const opening = hasBasicOptionalSplit ? '本产品保险责任分为基本责任和可选责任，具体责任如下。' : '';
  return linesToText([
    opening,
    ...responsibilities.map(responsibilityDisplayLine),
  ]);
}

function normalizeCompositeDisplayBlocks(blocks = [], summary = {}, routing = {}) {
  const responsibilities = normalizeArray(summary.mainResponsibilities);
  const composite = hasCompositeEndowmentAccidentProfile(summary, routing);
  const hasCompositePurpose = (content) => /两全/u.test(content)
    && /意外/u.test(content)
    && /交通|特定|高倍/u.test(content);
  return blocks.map((block) => {
    if (block.blockKey === 'productPurpose' && composite && !hasCompositePurpose(block.content)) {
      return {
        ...block,
        content: linesToText([
          '这是一款意外保障型两全保险：既保留满期返还/生存给付属性，也突出交通及特定意外高倍身故/全残保障。',
          block.content,
        ]),
      };
    }
    return block;
  });
}

function defaultCustomerSummaryBlocks(summary = {}, source = {}) {
  const responsibilities = normalizeArray(summary.mainResponsibilities);
  const productFunctions = normalizeArray(source.productFunctions).map(productFunctionTextFrom).filter(Boolean);
  return [
    { blockKey: 'productPurpose', content: text(summary.headline) },
    {
      blockKey: 'responsibilities',
      content: linesToText(responsibilities.map((item) =>
        [text(item?.title) || '保险责任', text(item?.plainText), text(item?.howItPays)].filter(Boolean).join('：'),
      )),
    },
    { blockKey: 'productFunctions', content: linesToText(productFunctions) },
    { blockKey: 'attentionNotes', content: linesToText(summary.notices) },
  ];
}

function normalizeCustomerSummaryContentBlocks(rawBlocks, summary = {}, source = {}, context = {}) {
  const sourceBlocks = Array.isArray(rawBlocks) && rawBlocks.length
    ? rawBlocks
    : defaultCustomerSummaryBlocks(summary, source);
  const rawByKey = new Map(sourceBlocks
    .filter((block) => block && typeof block === 'object')
    .map((block) => [text(block.blockKey), block]));
  const blocks = CUSTOMER_SUMMARY_BLOCK_DEFINITIONS.map((definition) => {
    const raw = rawByKey.get(definition.blockKey) || {};
    return {
      blockKey: definition.blockKey,
      title: text(raw.title) || definition.title,
      enabled: raw.enabled !== false,
      editable: raw.editable !== false,
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : definition.order,
      content: text(raw.content),
    };
  });
  return normalizeCompositeDisplayBlocks(blocks, summary, context.routing || {});
}

function normalizeStructuredSummaryToCustomerSummary(raw = {}, { company, productName, sourceUrls = [], routing = {}, sourceSections = {} } = {}) {
  const source = raw?.summary || raw?.result || raw?.data || raw;
  const responsibilities = normalizeArray(source?.responsibilities)
    .concat(normalizeArray(source?.mainResponsibilities))
    .map((item) => {
      const body = text(item?.plainText || item?.summary || item?.description || item?.内容);
      const paymentRule = text(item?.paymentRule || item?.howItPays || item?.给付规则 || item?.赔付方式);
      const triggerCondition = text(item?.triggerCondition || item?.trigger || item?.触发条件 || item?.给付条件);
      const sourceRefs = sourceRefIdsFromValue(item?.sourceRefs || item?.source_refs || item?.sources);
      const normalized = {
        title: text(item?.title || item?.name || item?.责任名称),
        plainText: body,
        triggerCondition,
        howItPays: paymentRule,
        calculationStatus: text(item?.calculationStatus || item?.calculation_status || item?.计算状态),
        requiredPolicyFields: requiredFieldsFromText(`${body} ${paymentRule} ${triggerCondition}`),
      };
      if (sourceRefs.length) normalized.sourceRefs = sourceRefs;
      return normalized;
    })
    .filter((item) => item.title || item.plainText || item.triggerCondition || item.howItPays || item.calculationStatus || item.requiredPolicyFields.length || item.sourceRefs?.length);
  const notices = uniqueStrings([
    ...normalizeArray(source?.importantNotes).map(text),
    ...normalizeArray(source?.notices).map(text),
    ...normalizeArray(source?.missingOrUnclear).map((item) => {
      const content = text(item);
      return content ? `需核验：${content}` : '';
    }),
  ]);
  const summary = {
    company,
    productName,
    headline: text(source?.headline || source?.productSummary || source?.summary),
    mainResponsibilities: responsibilities,
    notices,
    requiredPolicyFields: uniqueStrings(responsibilities.flatMap((item) => item.requiredPolicyFields)),
    sourceUrls: uniqueStrings(source?.sourceUrls || sourceUrls),
    officialResponsibilityText: sourceResponsibilityText(source) || sourceResponsibilityText({ sourceSections }),
  };
  summary.contentBlocks = normalizeCustomerSummaryContentBlocks(source?.contentBlocks, summary, { ...source, sourceSections }, { routing });
  return summary;
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
  plannerResult = null,
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
      planner: plannerResult
        ? {
            plannerMode: plannerResult.plannerMode,
            plannerUsed: plannerResult.plannerUsed,
            plannerReason: plannerResult.plannerReason,
            plannerModel: plannerResult.plannerModel,
            plannerOutput: plannerResult.planner,
            plannerError: plannerResult.plannerError,
            plannerPromptPreview: plannerResult.plannerPrompt ? previewForLog(plannerResult.plannerPrompt, 2000) : null,
          }
        : null,
    },
  };
}

function qualityIssuesFromGenerationAttempts(generationAttempts = []) {
  return normalizeArray(generationAttempts).flatMap((attempt) =>
    normalizeArray(attempt.quality?.issues).map((issue) => ({
      ...issue,
      stage: attempt.stage,
      modelName: attempt.modelName,
    })),
  );
}

async function persistGenerationReviewRun(persistGenerationRun, run) {
  if (typeof persistGenerationRun !== 'function') return null;
  return persistGenerationRun(run);
}

async function persistReadyCustomerSummary({
  persistSummary,
  persistGenerationRun,
  productKey,
  company,
  productName,
  sourceDigest,
  sourceSections,
  routing,
  summaryJson,
  summaryContext,
  rawPreview = '',
  modelProvider = '',
  modelName = '',
  modelTier = '',
  plannerResult = null,
  runStatus = 'passed',
  qualityGate = { status: 'passed', issues: [] },
  now,
} = {}) {
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
    modelProvider,
    modelName,
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
      plannerMode: summaryContext?.plannerMode,
      plannerUsed: summaryContext?.plannerUsed,
      plannerReason: summaryContext?.plannerReason,
      plannerModel: summaryContext?.plannerModel,
      plannerOutput: summaryContext?.plannerOutput,
      plannerError: summaryContext?.plannerError,
      contentBlocks: summaryJson.contentBlocks,
      productCategory: routing.productCategory,
      categoryLabel: routing.categoryLabel,
      featureTags: routing.featureTags,
      sourceSectionsDigest: sourceSections.sourceSectionsDigest,
      sourceSections,
      sourceSectionsQuality: sourceSections.quality,
      modelTier: text(modelTier || routing.modelTier),
      qualityGate,
      routing,
    },
  };
  const saved = typeof persistSummary === 'function' ? await persistSummary(row) : row;
  await persistGenerationReviewRun(persistGenerationRun, buildGenerationRun({
    productKey,
    company,
    productName,
    status: runStatus,
    routing,
    sourceDigest,
    sourceSections,
    qualityIssues: normalizeArray(qualityGate.issues),
    rawPreview,
    modelName,
    modelTier: modelTier || routing.modelTier,
    plannerResult,
    now,
  }));
  return saved;
}

export async function generateProductCustomerResponsibilitySummary({
  state = {},
  db,
  input = {},
  findSummary,
  persistSummary,
  persistGenerationRun,
  generateWithDeepSeek = callDeepSeekForCustomerResponsibilitySummary,
  generatePlannerWithDeepSeek,
  generateOfficialAnalysis,
  modelName = resolveDeepSeekConfig().model,
  nowIso = () => new Date().toISOString(),
  logger = console,
} = {}) {
  const company = text(input.company).slice(0, 80);
  const inputProductName = text(input.name || input.productName).slice(0, 160);
  if (!company || !inputProductName) {
    const error = new Error('请输入保险公司和保险名称');
    error.code = 'POLICY_RESPONSIBILITY_QUERY_INPUT_REQUIRED';
    error.status = 400;
    throw error;
  }

  const generationGovernance = getResponsibilityGenerationGovernanceConfig(state);
  const generationGovernanceEnabled = generationGovernance.enabled === true;
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
  const sourceDigest = buildCustomerResponsibilitySourceDigest({ cards, indicators, records, generationGovernance });
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
  const plannerMode = normalizeResponsibilityPlannerMode(
    input?.plannerMode,
    generationGovernance.plannerMode || process.env.RESPONSIBILITY_PLANNER_MODE || 'auto',
  );
  const resolvedGeneratePlannerWithDeepSeek = typeof generatePlannerWithDeepSeek === 'function'
    ? generatePlannerWithDeepSeek
    : generateWithDeepSeek === callDeepSeekForCustomerResponsibilitySummary
      ? callDeepSeekForResponsibilityPlanner
      : async () => {
          throw new Error('Responsibility Planner generator is not configured for mocked summary generation');
        };
  const plannerResult = await runResponsibilityPlanner({
    mode: plannerMode,
    model: process.env.RESPONSIBILITY_PLANNER_MODEL || 'deepseek-v4-flash',
    product: { company, productName },
    routing,
    sourceSections,
    cards: normalizeArray(cards).map(cardPromptItem),
    indicators: normalizeArray(indicators).map(indicatorPromptItem),
    generateWithDeepSeek: resolvedGeneratePlannerWithDeepSeek,
    logger,
  });
  const routedModelName = routing.modelTier === 'pro' ? PRO_MODEL : resolvedModelName;
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company, productName },
    routing,
    sourceSections,
    cards: normalizeArray(cards).map(cardPromptItem),
    indicators: normalizeArray(indicators).map(indicatorPromptItem),
    plannerResult,
    generationGovernance,
  });
  let rawSummary = null;
  let quality = { status: 'failed', issues: [] };
  const modelCandidates = customerSummaryModelCandidates({
    routedModelName,
    resolvedModelName,
  });
  const preferredModelName = modelCandidates[0] || routedModelName;
  let usedModelName = preferredModelName;
  const generationAttempts = [];
  for (const candidateModelName of modelCandidates) {
    let candidateSummary = null;
    let candidateIssues = [];
    try {
      candidateSummary = await generateWithDeepSeek({
        prompt,
        company,
        productName,
        cards,
        indicators,
        records: sourceRecords,
        modelNameOverride: candidateModelName,
      });
    } catch (error) {
      candidateIssues = [modelGenerationIssueFromError(error, 'model_generation_failed')];
    }
    const candidateQuality = candidateIssues.length
      ? { status: 'failed', issues: candidateIssues }
      : evaluateResponsibilitySummaryQuality({
          routing,
          sourceSections,
          summary: candidateSummary,
          generationGovernance,
        });
    generationAttempts.push({
      stage: 'primary',
      modelName: candidateModelName,
      quality: candidateQuality,
      summary: candidateSummary,
    });
    if (candidateQuality.status === 'passed') {
      rawSummary = candidateSummary;
      quality = candidateQuality;
      usedModelName = candidateModelName;
      break;
    }
  }
  let qualityGateStatus = 'passed';
  if (quality.status === 'passed' && usedModelName !== preferredModelName) {
    qualityGateStatus = 'passed_after_model_fallback';
    quality = {
      ...quality,
      issues: qualityIssuesFromGenerationAttempts(generationAttempts),
    };
  }
  if (quality.status !== 'passed') {
    let retryRawSummary = null;
    let retryQuality = { status: 'failed', issues: [] };
    let retryModelName = preferredModelName;
    const officialRetryPrompt = buildOfficialResponsibilityRetryPrompt({
      product: { company, productName },
      routing,
      sourceSections,
      generationGovernance,
      qualityIssues: generationGovernanceEnabled ? qualityIssuesFromGenerationAttempts(generationAttempts) : [],
    });
    for (const candidateModelName of modelCandidates) {
      let candidateSummary = null;
      let candidateIssues = [];
      try {
        candidateSummary = await generateWithDeepSeek({
          prompt: officialRetryPrompt,
          company,
          productName,
          cards: [],
          indicators: [],
          records: sourceRecords,
          modelNameOverride: candidateModelName,
        });
      } catch (error) {
        candidateIssues = [modelGenerationIssueFromError(error, 'official_retry_generation_failed')];
      }
      const candidateQuality = candidateIssues.length
        ? { status: 'failed', issues: candidateIssues }
        : evaluateResponsibilitySummaryQuality({
            routing,
            sourceSections,
            summary: candidateSummary,
            generationGovernance,
          });
      generationAttempts.push({
        stage: 'official_retry',
        modelName: candidateModelName,
        quality: candidateQuality,
        summary: candidateSummary,
      });
      if (candidateQuality.status === 'passed') {
        retryRawSummary = candidateSummary;
        retryQuality = candidateQuality;
        retryModelName = candidateModelName;
        break;
      }
    }
    if (retryQuality.status !== 'passed') {
      const qualityIssues = qualityIssuesFromGenerationAttempts(generationAttempts);
      if (generationGovernanceEnabled && generationGovernance.fallbackMode === 'official_text_after_second_failure') {
        const fallbackSummary = buildOfficialTextFallbackCustomerSummary({
          company,
          productName,
          sourceSections,
          sourceUrls: uniqueStrings(sourceRecords.map(sourceUrlFrom)),
        });
        const summaryContext = buildSummaryContext({ productKey, company, productName, cards, indicators, records: sourceRecords });
        Object.assign(summaryContext, {
          generationGovernance,
          fallbackStatus: RESPONSIBILITY_OFFICIAL_TEXT_FALLBACK_STATUS,
          plannerMode: plannerResult.plannerMode,
          plannerUsed: plannerResult.plannerUsed,
          plannerReason: plannerResult.plannerReason,
          plannerModel: plannerResult.plannerModel,
          plannerOutput: plannerResult.planner,
          plannerError: plannerResult.plannerError,
        });
        const saved = await persistReadyCustomerSummary({
          persistSummary,
          persistGenerationRun,
          productKey,
          company,
          productName,
          sourceDigest,
          sourceSections,
          routing,
          summaryJson: fallbackSummary,
          summaryContext,
          rawPreview: JSON.stringify(generationAttempts.map((attempt) => ({
            stage: attempt.stage,
            modelName: attempt.modelName,
            quality: attempt.quality,
            summary: attempt.summary,
          }))),
          modelProvider: 'official_text_fallback',
          modelName: modelCandidates.at(-1) || routedModelName,
          modelTier: routing.modelTier,
          plannerResult,
          runStatus: RESPONSIBILITY_OFFICIAL_TEXT_FALLBACK_STATUS,
          qualityGate: {
            status: RESPONSIBILITY_OFFICIAL_TEXT_FALLBACK_STATUS,
            issues: qualityIssues,
          },
          now: structuredNow,
        });
        return {
          ok: true,
          source: 'official_text_fallback',
          status: RESPONSIBILITY_OFFICIAL_TEXT_FALLBACK_STATUS,
          summary: safeCustomerSummary(saved),
        };
      }
      await persistGenerationReviewRun(persistGenerationRun, buildGenerationRun({
        productKey,
        company,
        productName,
        status: 'needs_model_review',
        routing,
        sourceDigest,
        sourceSections,
        qualityIssues,
        rawPreview: JSON.stringify(generationAttempts.map((attempt) => ({
          stage: attempt.stage,
          modelName: attempt.modelName,
          quality: attempt.quality,
          summary: attempt.summary,
        }))),
        modelName: modelCandidates.at(-1) || routedModelName,
        modelTier: routing.modelTier,
        plannerResult,
        now: structuredNow,
      }));
      return {
        ok: false,
        status: 'needs_model_review',
        message: '这个产品的保险责任资料需要进一步核验，请稍后再试。',
      };
    }
    rawSummary = retryRawSummary;
    usedModelName = retryModelName;
    qualityGateStatus = retryModelName === preferredModelName
      ? 'passed_after_official_retry'
      : 'passed_after_official_retry_model_fallback';
    quality = {
      status: 'passed',
      issues: qualityIssuesFromGenerationAttempts(generationAttempts),
    };
  }
  const summaryJson = enrichSummaryWithCompoundGrowth(
    normalizeStructuredSummaryToCustomerSummary(rawSummary, {
      company,
      productName,
      sourceUrls: uniqueStrings(sourceRecords.map(sourceUrlFrom)),
      routing,
      sourceSections,
    }),
    { cards, indicators, records: sourceRecords },
  );
  const summaryContext = buildSummaryContext({ productKey, company, productName, cards, indicators, records: sourceRecords });
  Object.assign(summaryContext, {
    generationGovernance,
    plannerMode: plannerResult.plannerMode,
    plannerUsed: plannerResult.plannerUsed,
    plannerReason: plannerResult.plannerReason,
    plannerModel: plannerResult.plannerModel,
    plannerOutput: plannerResult.planner,
    plannerError: plannerResult.plannerError,
  });
  const now = structuredNow;
  const saved = await persistReadyCustomerSummary({
    persistSummary,
    persistGenerationRun,
    productKey,
    company,
    productName,
    sourceDigest,
    sourceSections,
    routing,
    summaryJson,
    summaryContext,
    rawPreview: JSON.stringify(rawSummary),
    modelProvider: 'deepseek',
    modelName: usedModelName,
    modelTier: routing.modelTier,
    plannerResult,
    qualityGate: { status: qualityGateStatus, issues: quality.issues },
    now,
  });
  if (generateWithDeepSeek === callDeepSeekForCustomerResponsibilitySummary) {
    logDeepSeekCustomerSummary('DeepSeek summary cached', {
      productKey,
      company,
      productName,
      summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
      modelName: usedModelName,
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
    summary: safeCustomerSummary(saved),
  };
}
