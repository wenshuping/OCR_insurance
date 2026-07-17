import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import { extractInsurancePlanMatrixEvidence } from './insurance-plan-matrix-evidence.service.mjs';
import {
  CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_PHOTO_REVIEWED_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_PHOTO_SOURCE_KIND,
  CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL,
  CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_TERMS_SOURCE_KIND,
  EXTERNAL_REFERENCE_EVIDENCE_LABEL,
  EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
  REGULATORY_INDUSTRY_TERMS_EVIDENCE_LABEL,
  REGULATORY_INDUSTRY_TERMS_EVIDENCE_LEVEL,
  evidenceVerificationFields,
  isFormalResponsibilityEvidence,
  withEvidenceVerificationFields,
} from './evidence-classification.service.mjs';

const NEW_CHINA_PRODUCT_DISCLOSURE_URLS = [
  'https://www.newchinalife.com/info/4596',
  'https://www.newchinalife.com/info/3279_23',
];
const MAX_KNOWLEDGE_PAGE_TEXT_CHARS = 12000;
const MAX_KNOWLEDGE_PDF_BYTES = 1_500_000;
const DEFAULT_MAX_KNOWLEDGE_RESULTS = 5;
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_OPEN_WEB_SEARCH_MODEL = 'deepseek-v4-flash';
const DEFAULT_OPEN_WEB_SEARCH_TIMEOUT_MS = 12_000;
export const JRCPCX_TERMS_EVIDENCE_LABEL = REGULATORY_INDUSTRY_TERMS_EVIDENCE_LABEL;
export const JRCPCX_TERMS_EVIDENCE_LEVEL = REGULATORY_INDUSTRY_TERMS_EVIDENCE_LEVEL;
export const JRCPCX_OFFICIAL_DOMAIN = 'inspdinfo.iachina.cn';
export const LEGACY_EXTERNAL_REFERENCE_LABEL = EXTERNAL_REFERENCE_EVIDENCE_LABEL;
export const LEGACY_EXTERNAL_REFERENCE_LEVEL = EXTERNAL_REFERENCE_EVIDENCE_LEVEL;
export {
  CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_PHOTO_REVIEWED_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_PHOTO_SOURCE_KIND,
  CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL,
  CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_TERMS_SOURCE_KIND,
};
const JRCPCX_QUERY_URL = 'https://www.jrcpcx.cn/#/query';
const EXTERNAL_REFERENCE_SOURCE_KINDS = new Set(['legacy_external_reference', 'open_web_reference', CUSTOMER_POLICY_PHOTO_SOURCE_KIND]);
const LEGACY_EXTERNAL_PRODUCT_REFERENCES = [
  {
    company: '中国人寿',
    productName: '潇洒明天（历史老产品）',
    aliases: ['潇洒明天', '中国人寿潇洒明天', '国寿潇洒明天', '潇洒明天97版', '潇洒明天98版'],
    sources: [
      {
        title: '中国人寿潇洒明天 - 金投网',
        url: 'https://insurance.cngold.org/jczs/c3246186.html',
        snippet: '第三方网页称“潇洒明天”是一份增额终身人寿保险：生命保障在基本保额基础上每年按保额5%增长；每3年领取保额10%的生存金直至终身；生存金可选择累积，早期版本累积利率8%，后续版本调整为6点5%。',
      },
      {
        title: '人寿保险潇洒明天险种 - 深蓝保',
        url: 'https://www.shenlanbao.com/he/1608721',
        snippet: '第三方保险内容站提及“潇洒明天”相关老产品信息：保障与储蓄并存，包含身故保险金和生存保险金等责任线索；需以保险公司确认或补发合同为准。',
      },
    ],
  },
];
const FALLBACK_OPEN_WEB_REFERENCE_DOMAINS = [
  'e-chinalife.com',
  'chinalife.com.cn',
  'jrcpcx.cn',
  'iachina.cn',
  'nfra.gov.cn',
  'insurance.cngold.org',
  'shenlanbao.com',
  'xiangrikui.com',
  'zhihu.com',
];
const RESPONSIBILITY_MATERIAL_LABEL_PATTERN = /^(?:条款|保险条款|利益条款|产品说明书|产品说明)$/u;
const EXCLUDED_MATERIAL_LABEL_PATTERN = /近三年|通知|费率表|现金价值表|账户价值|利益演示/u;
const MATERIAL_KEYWORD_PATTERN = /保险条款|利益条款|产品说明书|产品说明|保险责任|责任免除|给付规则/u;
const GENERIC_ENTRY_PATHS = ['', 'products', 'product', 'product-center', 'productService', 'info', 'public', 'disclosure'];
const PRODUCT_IDENTITY_CODE_FIELDS = [
  'planCode',
  'productCode',
  'product_code',
  'riskCode',
  'risk_code',
  'industryCode',
  'industry_code',
];
const PRODUCT_IDENTITY_URL_FIELDS = ['url', 'sourceUrl', 'detailUrl', 'clauseUrl', 'pdfOriginalUrl'];
const PRODUCT_IDENTITY_URL_PARAMS = [
  'planCode',
  'productCode',
  'product_code',
  'riskCode',
  'risk_code',
  'industryCode',
  'industry_code',
];
const PRODUCT_IDENTITY_LABEL_PATTERN = /(?:产品|险种|计划|条款|方案)(?:代码|编码|编号|code)[:：]?\s*([A-Za-z0-9][A-Za-z0-9_-]{1,23})/giu;
const PARENTHETICAL_CODE_PATTERN = /[（(]\s*([A-Za-z0-9][A-Za-z0-9_-]{1,23})\s*[）)]/gu;
const DEFAULT_SCRAPLING_PROJECT_DIR = '/Users/wenshuping/Documents/Scrapling';
const DEFAULT_SCRAPLING_PYTHON_BIN = '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const SCRAPLING_OUTPUT_MARKER = '__POLICY_KNOWLEDGE_JSON__';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPLING_CRAWLER_SCRIPT = path.join(__dirname, 'scrapling-policy-crawler.py');

function trimString(value) {
  return String(value || '').trim();
}

function normalizeProductIdentityCode(value) {
  const text = trimString(value)
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{1,23}$/u.test(text) ? text : '';
}

function addProductIdentityCode(codes, value) {
  const code = normalizeProductIdentityCode(value);
  if (code) codes.add(code);
}

function extractProductIdentityCodesFromUrl(urlValue = '') {
  const codes = new Set();
  try {
    const url = new URL(trimString(urlValue));
    for (const key of PRODUCT_IDENTITY_URL_PARAMS) {
      addProductIdentityCode(codes, url.searchParams.get(key));
    }
  } catch {
    return [];
  }
  return [...codes];
}

export function productIdentityCodesFromRecord(record = {}) {
  const codes = new Set();
  for (const field of PRODUCT_IDENTITY_CODE_FIELDS) {
    addProductIdentityCode(codes, record?.[field]);
  }
  for (const field of PRODUCT_IDENTITY_URL_FIELDS) {
    for (const code of extractProductIdentityCodesFromUrl(record?.[field])) {
      codes.add(code);
    }
  }
  return [...codes];
}

function productIdentityCodesFromText(value = '') {
  const source = trimString(value).normalize('NFKC');
  if (!source) return [];
  const codes = new Set();
  for (const match of source.matchAll(PRODUCT_IDENTITY_LABEL_PATTERN)) {
    addProductIdentityCode(codes, match[1]);
  }
  for (const match of source.matchAll(PARENTHETICAL_CODE_PATTERN)) {
    addProductIdentityCode(codes, match[1]);
  }
  return [...codes];
}

function mergeProductIdentityCodes(...groups) {
  const codes = new Set();
  for (const group of groups) {
    for (const code of Array.isArray(group) ? group : []) {
      addProductIdentityCode(codes, code);
    }
  }
  return [...codes];
}

function isJrcpcxRecordLike(record = {}) {
  const level = trimString(record.evidenceLevel || record.sourceLevel);
  const target = [
    record.url,
    record.source,
    record.sourceUrl,
    record.detailUrl,
    record.clauseUrl,
    record.officialDomain,
    record.parser,
  ].map(trimString).join(' ');
  return (
    level === JRCPCX_TERMS_EVIDENCE_LEVEL ||
    /(?:jrcpcx\.cn|inspdinfo\.iachina\.cn|iachina\.cn|jrcpcx_)/iu.test(target)
  );
}

function normalizeKnowledgeSourceKind(record = {}) {
  const value = trimString(record.sourceKind);
  if (['local', 'insurer_official', 'jrcpcx', CUSTOMER_POLICY_TERMS_SOURCE_KIND, ...EXTERNAL_REFERENCE_SOURCE_KINDS].includes(value)) return value;
  if (trimString(record.evidenceLevel || record.sourceLevel) === LEGACY_EXTERNAL_REFERENCE_LEVEL) return 'open_web_reference';
  if (trimString(record.evidenceLevel || record.sourceLevel) === CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL) return CUSTOMER_POLICY_TERMS_SOURCE_KIND;
  if (isJrcpcxRecordLike(record)) return 'jrcpcx';
  return '';
}

export function sourceKindForKnowledgeRecord(record = {}) {
  return normalizeKnowledgeSourceKind(record) || 'local';
}

export function isExternalReferenceSourceKind(sourceKind = '') {
  return EXTERNAL_REFERENCE_SOURCE_KINDS.has(trimString(sourceKind));
}

function isApprovedCustomerPolicyPhotoRecord(record = {}) {
  return (
    trimString(record.sourceKind) === CUSTOMER_POLICY_PHOTO_SOURCE_KIND &&
    trimString(record.reviewStatus) === 'approved' &&
    record.globalSearchable === true
  );
}

function compactKnowledgeText(value) {
  return trimString(value).normalize('NFKC').replace(/\s+/gu, '');
}

function nowIso() {
  return new Date().toISOString();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>');
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' '),
  ).trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparableFact(value) {
  return trimString(value)
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/\s+/gu, '')
    .replace(/[：:]/gu, '')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '')
    .trim();
}

function normalizeOfficialDomain(value = '') {
  const raw = trimString(value)
    .replace(/^https?:\/\//iu, '')
    .replace(/\/.*$/u, '')
    .replace(/^www\./iu, '')
    .toLowerCase();
  return raw;
}

function normalizeOfficialDomains(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values]).map(normalizeOfficialDomain).filter(Boolean)));
}

function resolveUrlHostname(url = '') {
  try {
    return new URL(trimString(url)).hostname.replace(/^www\./iu, '').toLowerCase();
  } catch {
    return '';
  }
}

function domainMatches(hostname = '', domain = '') {
  const host = normalizeOfficialDomain(hostname);
  const normalizedDomain = normalizeOfficialDomain(domain);
  if (!host || !normalizedDomain) return false;
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
}

function resolveOfficialProfile(policy = {}, officialDomainProfiles = []) {
  const target = `${trimString(policy.company)} ${trimString(policy.name || policy.productName)}`;
  if (!target.trim()) return null;
  return (
    (officialDomainProfiles || []).find((profile) => {
      const aliases = Array.isArray(profile?.aliases) ? profile.aliases : [];
      return aliases.some((alias) => alias && target.includes(alias));
    }) || null
  );
}

function normalizeComparableCompany(value = '') {
  return normalizeComparableFact(value)
    .replace(/(?:人寿|财产|养老|健康)?保险股份有限公司/gu, '')
    .replace(/(?:人寿|财产|养老|健康)?保险有限责任公司/gu, '')
    .replace(/(?:人寿|财产|养老|健康)?保险有限公司/gu, '')
    .replace(/保险股份有限公司|保险有限责任公司|股份有限公司|有限责任公司|有限公司/gu, '')
    .trim();
}

function companyAliasSet(company = '', officialDomainProfiles = []) {
  const profile = resolveOfficialProfile({ company }, officialDomainProfiles);
  const values = [company];
  if (profile) {
    values.push(...(Array.isArray(profile.aliases) ? profile.aliases : []));
    values.push(...(Array.isArray(profile.companyAliases) ? profile.companyAliases : []));
  }
  return new Set(values.map(normalizeComparableCompany).filter(Boolean));
}

function companyProfileAliasSet(company = '', officialDomainProfiles = []) {
  const profile = resolveOfficialProfile({ company }, officialDomainProfiles);
  if (!profile) return new Set();
  return new Set(
    [profile.company, ...(Array.isArray(profile.aliases) ? profile.aliases : []), ...(Array.isArray(profile.companyAliases) ? profile.companyAliases : [])]
      .map(normalizeComparableFact)
      .filter(Boolean),
  );
}

function normalizeCompanySuggestionText(value = '') {
  return trimString(value).replace(/\s+/gu, '').toLowerCase();
}

export function scoreCompanySuggestionMatch(query = '', candidate = '', officialDomainProfiles = []) {
  const rawQuery = trimString(query);
  const rawCandidate = trimString(candidate);
  if (!rawQuery || !rawCandidate) {
    return { matched: false, score: 0, matchType: '' };
  }

  const exactQuery = normalizeComparableFact(rawQuery);
  const exactCandidate = normalizeComparableFact(rawCandidate);
  const queryProfileAliases = companyProfileAliasSet(rawQuery, officialDomainProfiles);
  const candidateProfileAliases = companyProfileAliasSet(rawCandidate, officialDomainProfiles);
  if (
    exactQuery
    && exactCandidate
    && ((queryProfileAliases.has(exactCandidate) && queryProfileAliases.has(exactQuery))
      || (candidateProfileAliases.has(exactQuery) && candidateProfileAliases.has(exactCandidate)))
  ) {
    return { matched: true, score: 400, matchType: 'alias' };
  }

  const normalizedQuery = normalizeCompanySuggestionText(rawQuery);
  const normalizedCandidate = normalizeCompanySuggestionText(rawCandidate);
  if (!normalizedQuery || !normalizedCandidate) {
    return { matched: false, score: 0, matchType: '' };
  }
  if (normalizedCandidate === normalizedQuery) {
    return { matched: true, score: 320, matchType: 'exact' };
  }
  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return { matched: true, score: 240, matchType: 'prefix' };
  }
  const containsIndex = normalizedCandidate.indexOf(normalizedQuery);
  if (containsIndex >= 0) {
    return { matched: true, score: 180 - Math.min(containsIndex, 40), matchType: 'contains' };
  }

  const comparableQuery = normalizeComparableCompany(rawQuery);
  const comparableCandidate = normalizeComparableCompany(rawCandidate);
  if (!comparableQuery || !comparableCandidate) {
    return { matched: false, score: 0, matchType: '' };
  }
  if (comparableCandidate === comparableQuery) {
    return { matched: true, score: 160, matchType: 'generic' };
  }
  if (comparableCandidate.startsWith(comparableQuery)) {
    return { matched: true, score: 140, matchType: 'generic' };
  }
  const genericIndex = comparableCandidate.indexOf(comparableQuery);
  if (genericIndex >= 0) {
    return { matched: true, score: 120 - Math.min(genericIndex, 40), matchType: 'generic' };
  }
  return { matched: false, score: 0, matchType: '' };
}

export function companiesMatch(left = '', right = '', officialDomainProfiles = []) {
  const leftAliases = companyAliasSet(left, officialDomainProfiles);
  const rightAliases = companyAliasSet(right, officialDomainProfiles);
  if (!leftAliases.size || !rightAliases.size) return false;
  for (const alias of leftAliases) {
    if (rightAliases.has(alias)) return true;
  }
  return false;
}

function isOfficialUrl(url = '', policy = {}, officialDomainProfiles = []) {
  const hostname = resolveUrlHostname(url);
  if (!hostname) return false;
  const profile = resolveOfficialProfile(policy, officialDomainProfiles);
  const domains = normalizeOfficialDomains([
    ...(profile?.officialDomains || []),
    ...(profile?.siteDomains || []),
  ]);
  return domains.some((domain) => domainMatches(hostname, domain));
}

function resolveOfficialDomain(url = '', officialDomainProfiles = []) {
  const hostname = resolveUrlHostname(url);
  const allDomains = normalizeOfficialDomains(
    (officialDomainProfiles || []).flatMap((profile) => [...(profile?.officialDomains || []), ...(profile?.siteDomains || [])]),
  );
  return allDomains.find((domain) => domainMatches(hostname, domain)) || normalizeOfficialDomain(hostname);
}

function resolveAbsoluteUrl(href = '', baseUrl = '') {
  const decoded = decodeHtmlEntities(href);
  if (!decoded) return '';
  try {
    return new URL(decoded, baseUrl).toString();
  } catch {
    return '';
  }
}

function extractHtmlRows(html = '') {
  return Array.from(String(html || '').matchAll(/<tr\b[\s\S]*?<\/tr>/giu)).map((match) => match[0]);
}

function extractHtmlLinks(html = '', baseUrl = '') {
  return Array.from(String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu))
    .map((match) => {
      const url = resolveAbsoluteUrl(match[1], baseUrl);
      return {
        href: decodeHtmlEntities(match[1]),
        url,
        label: stripHtml(match[2]),
      };
    })
    .filter((link) => link.url && link.label);
}

function productMatchesText(productName = '', text = '') {
  const product = normalizeComparableFact(productName);
  const target = normalizeComparableFact(text);
  if (!product || !target) return false;
  return target.includes(product) || product.includes(target);
}

function normalizeProductMatchText(value = '', company = '') {
  const normalizedCompany = normalizeComparableFact(company);
  let text = normalizeComparableFact(value);
  if (!text) return '';
  if (normalizedCompany) text = text.replaceAll(normalizedCompany, '');
  return text
    .replace(/^[\p{Script=Han}]{2,14}(?:人寿|财产|养老|健康)?保险股份有限公司/gu, '')
    .replace(/^[\p{Script=Han}]{2,14}(?:人寿|财产|养老|健康)?保险有限责任公司/gu, '')
    .replace(/保险股份有限公司|保险有限责任公司|股份有限公司|有限责任公司|产品说明书|产品说明|保险条款|利益条款|条款/gu, '')
    .replace(/保险/gu, '')
    .trim();
}

function normalizeStrictProductMatchText(value = '', company = '') {
  const normalizedCompany = trimString(company)
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '');
  let text = trimString(value)
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[《》<>「」『』【】\[\]（）().,，。；;:：、·-]/gu, '');
  if (!text) return '';
  if (normalizedCompany) text = text.replaceAll(normalizedCompany, '');
  return text
    .replace(/^[\p{Script=Han}]{2,14}(?:人寿|财产|养老|健康)?保险股份有限公司/gu, '')
    .replace(/^[\p{Script=Han}]{2,14}(?:人寿|财产|养老|健康)?保险有限责任公司/gu, '')
    .replace(/保险股份有限公司|保险有限责任公司|股份有限公司|有限责任公司|产品说明书|产品说明|保险条款|利益条款|条款/gu, '')
    .replace(/保险$/u, '')
    .trim();
}

function strictProductNameMatches(queryName = '', candidateName = '', company = '') {
  const query = normalizeStrictProductMatchText(queryName, company);
  const candidate = normalizeStrictProductMatchText(candidateName, company);
  if (!query || !candidate) return false;
  return query === candidate;
}

export function isStrictPolicyProductMatch(queryName = '', candidateName = '', company = '') {
  return strictProductNameMatches(queryName, candidateName, company);
}

function toCharSet(value = '') {
  return new Set(Array.from(value).filter(Boolean));
}

function ngrams(value = '', size = 2) {
  const chars = Array.from(value).filter(Boolean);
  if (chars.length <= size) return chars.length ? [chars.join('')] : [];
  const result = [];
  for (let index = 0; index <= chars.length - size; index += 1) {
    result.push(chars.slice(index, index + size).join(''));
  }
  return result;
}

function jaccardScore(leftValues = [], rightValues = []) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const value of left) {
    if (right.has(value)) overlap += 1;
  }
  return overlap / (left.size + right.size - overlap);
}

function longestCommonSubstringLength(left = '', right = '') {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length || !b.length) return 0;
  let best = 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) best = current[j];
    }
    for (let j = 0; j < current.length; j += 1) previous[j] = current[j];
  }
  return best;
}

function productTypeTerms(value = '') {
  const text = normalizeComparableFact(value);
  return ['两全', '年金', '终身寿', '重大疾病', '医疗', '护理', '意外', '万能', '投连', '投资连结', '增额', '分红', '养老', '寿险'].filter(
    (term) => text.includes(term),
  );
}

const GENERIC_HEALTH_PRODUCT_TYPE_PATTERN = /^健康(?:险|保险)?$/u;
const GENERIC_LIFE_PRODUCT_TYPE_PATTERN = /^(?:寿险|人寿险|人寿保险|年金|年金保险|两全及生存|医疗保险|护理保险|意外保险|疾病保险)?$/u;
const INVALID_PRODUCT_TYPE_PATTERN = /^(?:-|全部|产品分类：|P[123])$/u;
const CRITICAL_ILLNESS_PRODUCT_TEXT_PATTERN =
  /重大疾病保险|重疾险|(重大疾病|轻症疾病|中症疾病|特定重大疾病|特定轻症疾病).{0,12}保险金/u;

function normalizeProductTypeAlias(value = '') {
  const raw = trimString(value);
  if (!raw) return '';
  if (INVALID_PRODUCT_TYPE_PATTERN.test(raw)) return '';
  if (raw === '意外保险' || raw === '意外伤害保险') return '意外险';
  if (raw === '医疗保险') return '医疗险';
  if (raw === '护理保险') return '护理险';
  if (raw === '年金保险' || raw === '年金') return '年金险';
  if (raw === '两全及生存') return '两全保险';
  if (raw === '人寿险' || raw === '人寿保险') return '寿险';
  if (raw === '重大疾病') return '重疾险';
  return raw;
}

function inferProductTypeFromText(record = {}) {
  const text = [record.productName, record.title, record.pageText].map(trimString).filter(Boolean).join(' ');
  if (!text) return '';
  if (CRITICAL_ILLNESS_PRODUCT_TEXT_PATTERN.test(text)) return '重疾险';
  if (/重大疾病|重疾/u.test(text)) return '重疾险';
  if (/医疗/u.test(text)) return '医疗险';
  if (/护理/u.test(text)) return '护理险';
  if (/年金/u.test(text)) return '年金险';
  if (/两全/u.test(text)) return '两全保险';
  if (/终身寿险|定期寿险|寿险/u.test(text)) return '寿险';
  if (/意外/u.test(text)) return '意外险';
  if (/恶性肿瘤|防癌|特定疾病|疾病保险/u.test(text)) return '疾病保险';
  return '';
}

export function normalizeKnowledgeProductType(record = {}) {
  const rawType = normalizeProductTypeAlias(record.productType);
  const inferredType = inferProductTypeFromText(record);
  if (!rawType) return inferredType;
  if (GENERIC_HEALTH_PRODUCT_TYPE_PATTERN.test(rawType) || GENERIC_LIFE_PRODUCT_TYPE_PATTERN.test(rawType)) {
    return inferredType || rawType;
  }
  return rawType;
}

export function scoreProductNameMatch(queryName = '', candidateName = '', company = '') {
  const query = normalizeProductMatchText(queryName, company);
  const candidate = normalizeProductMatchText(candidateName, company);
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  const containsScore = candidate.includes(query) || query.includes(candidate) ? 0.92 : 0;
  const charScore = jaccardScore(toCharSet(query), toCharSet(candidate));
  const bigramScore = jaccardScore(ngrams(query, 2), ngrams(candidate, 2));
  const trigramScore = jaccardScore(ngrams(query, 3), ngrams(candidate, 3));
  const lcsScore = longestCommonSubstringLength(query, candidate) / Math.min(Array.from(query).length, Array.from(candidate).length);
  const queryTypes = productTypeTerms(queryName);
  const candidateTypes = productTypeTerms(candidateName);
  const hasTypeOverlap = queryTypes.some((term) => candidateTypes.includes(term));
  const hasTypeConflict = queryTypes.length && candidateTypes.length && !hasTypeOverlap;
  let score = Math.max(containsScore, trigramScore * 0.35 + bigramScore * 0.25 + charScore * 0.2 + lcsScore * 0.2);
  if (hasTypeOverlap) score += 0.08;
  if (hasTypeConflict && lcsScore < 0.75) score -= 0.06;
  return Math.max(0, Math.min(1, score));
}

function knowledgeMatchReason(score) {
  if (score >= 0.92) return '产品名称高度匹配';
  if (score >= 0.7) return '产品名称相近';
  return '产品名称部分相同';
}

function isNewChinaPolicy(policy = {}) {
  return /新华/u.test(trimString(policy.company)) || /新华/u.test(trimString(policy.name || policy.productName));
}

function extractNewChinaProductTitle(rowHtml = '', policy = {}) {
  const cells = Array.from(String(rowHtml || '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu))
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
  return cells.find((cell) => productMatchesText(policy.name || policy.productName, cell)) || trimString(policy.name || policy.productName);
}

function isNewChinaProductRow(rowHtml = '', policy = {}) {
  return productMatchesText(policy.name || policy.productName, stripHtml(rowHtml));
}

function classifyMaterialType(value = '') {
  const text = trimString(value);
  if (/现金价值表/u.test(text)) return 'cash_value_table';
  if (/费率表/u.test(text)) return 'rate_table';
  if (/产品说明书|产品说明/u.test(text)) return 'product_manual';
  if (/责任免除/u.test(text)) return 'exclusion';
  if (/保险条款|利益条款|条款/u.test(text)) return 'terms';
  if (/保险责任/u.test(text)) return 'responsibility';
  return /\.pdf(?:$|[?#])/iu.test(text) ? 'pdf' : 'html';
}

function resolveSourceType(url = '', contentType = '') {
  if (/application\/pdf/iu.test(contentType) || /\.pdf(?:$|[?#])/iu.test(trimString(url))) return 'pdf';
  return 'html';
}

function extractRelevantText(text = '', policy = {}) {
  const normalizedText = trimString(text);
  if (!normalizedText) return '';
  const productName = trimString(policy.name || policy.productName);
  const keywords = [
    '保险责任',
    '身故',
    '全残',
    '给付',
    '赔付',
    '报销',
    '现金价值',
    '红利',
    '责任免除',
    '投保年龄',
    '保险期间',
    '交费',
    '缴费',
    '等待期',
    '给付系数',
    '有效保险金额',
    '基本保险金额',
    '减保',
    '保单贷款',
  ];
  const sentences = normalizedText
    .split(/[。！？!?；;\n\r]+/u)
    .map((item) => trimString(item))
    .filter((item) => item.length >= 8 && item.length <= 420);
  const relevant = [];
  for (const sentence of sentences) {
    const hasProduct = productName && sentence.includes(productName);
    const hasKeyword = keywords.some((keyword) => sentence.includes(keyword));
    if (!hasProduct && !hasKeyword) continue;
    if (!relevant.includes(sentence)) relevant.push(sentence);
    if (relevant.join('。').length >= MAX_KNOWLEDGE_PAGE_TEXT_CHARS) break;
  }
  const fallbackStart = productName ? normalizedText.indexOf(productName) : -1;
  if (fallbackStart >= 0) {
    const nearby = normalizedText.slice(Math.max(0, fallbackStart - 240), fallbackStart + MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
    if (!relevant.length) return nearby;
    return `${nearby}。${relevant.join('。')}`.slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
  }
  return relevant.join('。').slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
}

function extractFocusedResponsibilityText(text = '') {
  const normalizedText = trimString(text).replace(/\s+/gu, ' ');
  if (!normalizedText) return '';
  const preferred = normalizedText.search(/保险责任\s*在本合同保险期间内/u);
  const start = preferred >= 0 ? preferred : normalizedText.indexOf('保险责任');
  if (start < 0) return '';
  const early = normalizedText.slice(start, start + 700);
  const before = normalizedText.slice(Math.max(0, start - 180), start);
  const headingCount = (early.match(/保险期间|犹豫期|宽限期|合同效力|责任免除|不保什么|其他免责条款|如何申请|如何领取|保险金申请|受益人|释义|保单红利|现金价值|保险费|退保/gu) || []).length;
  const tocLike = /目\s*录|条款目录|阅读指引|阅\s*读\s*指\s*引|\.{3,}|…{2,}|……/u.test(`${before} ${early}`);
  const hasPositiveNear = /(?:我们|本公司).{0,100}(?:承担|给付|赔付|赔偿|报销)|(?:按|按照).{0,100}(?:给付|赔付|赔偿|报销)|(?:承担下列|承担以下|承担如下).{0,80}保险责任/u.test(early);
  if (tocLike && headingCount >= 2 && !hasPositiveNear) return '';
  const tail = normalizedText.slice(start);
  const endMatch = tail
    .slice(40)
    .match(/第[一二三四五六七八九十]+条\s*(?:责任免除|保单红利|保险金申请|释义|其他事项|合同内容变更)|责任免除|保单红利|保险金申请/u);
  const excerpt = endMatch ? tail.slice(0, 40 + endMatch.index) : tail.slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
  const sentences = excerpt
    .split(/(?<=[。；;])/u)
    .map((item) => trimString(item))
    .filter(Boolean);
  const keywords = [
    '保险责任',
    '身故',
    '全残',
    '身体全残',
    '给付',
    '赔付',
    '报销',
    '保险金',
    '意外伤害',
    '交通工具',
    '重大疾病',
    '医疗',
    '等待期',
    '给付系数',
    '基本保险金额',
    '有效保险金额',
    '已交保险费',
    '现金价值',
  ];
  const focused = sentences.filter((sentence) => keywords.some((keyword) => sentence.includes(keyword))).join('\n');
  const candidate = focused || excerpt;
  const hasPositiveResponsibility = /(?:我们|本公司).{0,100}(?:承担|给付|赔付|赔偿|报销).{0,100}(?:保险责任|保险金|医疗费用|津贴|保险费)|(?:按|按照).{0,100}(?:给付|赔付|赔偿|报销).{0,100}(?:保险金|医疗费用|津贴|保险费)|(?:承担下列|承担以下|承担如下).{0,80}保险责任|被保险人.{0,220}(?:身故|全残|伤残|残疾|疾病|医疗|住院|意外伤害|烧伤|达到|生存).{0,220}(?:保险金|给付|赔付|赔偿|报销|豁免)|豁免保险费/u.test(candidate);
  if (!hasPositiveResponsibility) return '';
  return candidate.slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
}

function decodePdfHexText(value = '') {
  const normalized = String(value || '').replace(/\s+/gu, '');
  if (!normalized) return '';
  const bytes = Buffer.from(normalized, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode(bytes.readUInt16BE(index));
    }
    return output;
  }
  return bytes.toString('utf8');
}

function decodePdfLiteralText(value = '') {
  return String(value || '').replace(/\\([nrtbf()\\])/gu, (_match, token) => {
    const replacements = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\',
    };
    return replacements[token] || token;
  });
}

function extractPdfActualText(buffer) {
  const raw = Buffer.from(buffer || []).toString('latin1');
  if (!raw) return '';
  const values = [];
  const pattern = /\/ActualText\s*(?:\((.*?)\)|<([0-9A-Fa-f\s]+)>)/gsu;
  for (const match of raw.matchAll(pattern)) {
    const decoded = match[1] !== undefined ? decodePdfLiteralText(match[1]) : decodePdfHexText(match[2]);
    const text = trimString(decoded);
    if (text) values.push(text);
  }
  return values.join('');
}

async function extractPdfTextWithPython(buffer) {
  const raw = Buffer.from(buffer || []);
  if (!raw.length) return '';
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [
        '-c',
        [
          'import base64, io, sys',
          'try:',
          '    from pypdf import PdfReader',
          '    data = base64.b64decode(sys.stdin.read())',
          '    reader = PdfReader(io.BytesIO(data))',
          "    print('\\n'.join((page.extract_text() or '') for page in reader.pages))",
          'except Exception:',
          '    sys.exit(0)',
        ].join('\n'),
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve('');
    }, 8000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk || '');
      if (output.length > 20_000) child.kill('SIGTERM');
    });
    child.on('close', () => {
      clearTimeout(timeout);
      resolve(trimString(output));
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve('');
    });
    child.stdin.end(raw.toString('base64'));
  });
}

async function extractRelevantPdfText(buffer, policy = {}) {
  const actualText = extractPdfActualText(buffer);
  const rawText = actualText || (await extractPdfTextWithPython(buffer));
  return extractFocusedResponsibilityText(rawText) || extractRelevantText(rawText, policy);
}

async function fetchMaterialPageText({ url, policy, fetchImpl, signal } = {}) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml,application/pdf',
      },
    });
    if (!response.ok) return { pageText: '', sourceType: resolveSourceType(url), contentType: '' };
    const contentType = String(response.headers?.get?.('content-type') || '');
    const sourceType = resolveSourceType(url, contentType);
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (sourceType === 'pdf' && (!contentLength || contentLength <= MAX_KNOWLEDGE_PDF_BYTES)) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        pageText: buffer.length <= MAX_KNOWLEDGE_PDF_BYTES ? await extractRelevantPdfText(buffer, policy) : '',
        sourceType,
        contentType,
      };
    }
    if (!/(application\/msword|officedocument)/iu.test(contentType)) {
      const html = await response.text();
      const matrixEvidence = extractInsurancePlanMatrixEvidence(html).text;
      const relevantText = extractRelevantText(stripHtml(html), policy);
      return {
        pageText: [matrixEvidence, relevantText].filter(Boolean).join('\n\n')
          .slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS),
        sourceType,
        contentType,
      };
    }
    return { pageText: '', sourceType, contentType };
  } catch {
    return { pageText: '', sourceType: resolveSourceType(url), contentType: '' };
  }
}

function buildKnowledgeRecord({ policy, title, url, snippet = '', pageText = '', parser, officialDomainProfiles = [], sourceType = '', materialType = '' }) {
  const now = nowIso();
  return {
    company: trimString(policy.company),
    productName: trimString(policy.name || policy.productName),
    title: trimString(title) || trimString(url),
    url: trimString(url),
    snippet: trimString(snippet),
    pageText: trimString(pageText),
    sourceType: sourceType || resolveSourceType(url),
    materialType: materialType || classifyMaterialType(`${title} ${url}`),
    official: isOfficialUrl(url, policy, officialDomainProfiles),
    evidenceLabel: '本地知识库官方资料',
    evidenceLevel: 'insurer_official',
    officialDomain: resolveOfficialDomain(url, officialDomainProfiles),
    parser: trimString(parser),
    discoveredAt: now,
    lastFetchedAt: now,
    updatedAt: now,
    useCount: 0,
  };
}

function runScraplingPolicyCrawler({ policy, officialDomainProfiles = [], timeoutMs = 45_000 } = {}) {
  if (!isNewChinaPolicy(policy)) return Promise.resolve([]);
  const pythonBin = trimString(process.env.SCRAPLING_PYTHON_BIN) || DEFAULT_SCRAPLING_PYTHON_BIN;
  const scraplingProjectDir = trimString(process.env.SCRAPLING_PROJECT_DIR) || DEFAULT_SCRAPLING_PROJECT_DIR;
  return new Promise((resolve) => {
    const child = spawn(pythonBin, [SCRAPLING_CRAWLER_SCRIPT], {
      cwd: scraplingProjectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (records = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(Array.isArray(records) ? records : []);
    };
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      finish([]);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', () => finish([]));
    child.on('close', () => {
      const line = stdout
        .split(/\r?\n/u)
        .reverse()
        .find((item) => item.includes(SCRAPLING_OUTPUT_MARKER));
      if (!line) return finish([]);
      try {
        const payload = JSON.parse(line.slice(line.indexOf(SCRAPLING_OUTPUT_MARKER) + SCRAPLING_OUTPUT_MARKER.length));
        const records = (Array.isArray(payload?.records) ? payload.records : [])
          .map((record) =>
            normalizeKnowledgeRecord(
              {
                ...record,
                parser: trimString(record.parser) || 'scrapling',
              },
              { officialDomainProfiles },
            ),
          )
          .filter(Boolean);
        finish(records);
      } catch {
        finish([]);
      }
    });
    child.stdin.end(
      JSON.stringify({
        company: policy.company,
        name: policy.name || policy.productName,
      }),
    );
  });
}

function runScraplingCrawlerPayload(payload = {}, { timeoutMs = 45_000 } = {}) {
  const pythonBin = trimString(process.env.SCRAPLING_PYTHON_BIN) || DEFAULT_SCRAPLING_PYTHON_BIN;
  const scraplingProjectDir = trimString(process.env.SCRAPLING_PROJECT_DIR) || DEFAULT_SCRAPLING_PROJECT_DIR;
  return new Promise((resolve) => {
    const child = spawn(pythonBin, [SCRAPLING_CRAWLER_SCRIPT], {
      cwd: scraplingProjectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result && typeof result === 'object' ? result : {});
    };
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        ok: false,
        code: 'SCRAPLING_TIMEOUT',
        message: '外部查询超时，请稍后重试或人工核对条款名称。',
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        code: 'SCRAPLING_START_FAILED',
        message: error?.message || '外部查询进程启动失败。',
      });
    });
    child.on('close', () => {
      const line = stdout
        .split(/\r?\n/u)
        .reverse()
        .find((item) => item.includes(SCRAPLING_OUTPUT_MARKER));
      if (!line) {
        finish({
          ok: false,
          code: 'SCRAPLING_OUTPUT_MISSING',
          message: stderr || '外部查询未返回可解析结果。',
        });
        return;
      }
      try {
        finish(JSON.parse(line.slice(line.indexOf(SCRAPLING_OUTPUT_MARKER) + SCRAPLING_OUTPUT_MARKER.length)));
      } catch (error) {
        finish({
          ok: false,
          code: 'SCRAPLING_OUTPUT_INVALID',
          message: error?.message || '外部查询结果解析失败。',
        });
      }
    });
    child.stdin.end(JSON.stringify(payload || {}));
  });
}

function jrcpcxCandidateUrl(product = {}) {
  const detailUrl = trimString(product.detailUrl);
  if (detailUrl) return detailUrl;
  const catalogId = trimString(product.catalogId || product.rowId || product.industryCode || product.productName);
  if (!catalogId) return JRCPCX_QUERY_URL;
  return `${JRCPCX_QUERY_URL}?catalogId=${encodeURIComponent(catalogId)}`;
}

export function jrcpcxProductCandidateRecord(product = {}, policy = {}) {
  const productName = trimString(product.productName || product.name);
  const company = trimString(product.deptName || product.company || policy.company);
  const url = jrcpcxCandidateUrl(product);
  if (!company || !productName || !url) return null;
  const now = nowIso();
  return normalizeKnowledgeRecord({
    company,
    productName,
    productType: trimString(product.productType),
    salesStatus: trimString(product.productState || product.salesStatus || product.status),
    title: `${productName}条款`,
    url,
    source: trimString(product.source) || JRCPCX_QUERY_URL,
    sourceUrl: trimString(product.source) || JRCPCX_QUERY_URL,
    sourceKind: 'jrcpcx',
    sourceLevel: JRCPCX_TERMS_EVIDENCE_LEVEL,
    evidenceLabel: JRCPCX_TERMS_EVIDENCE_LABEL,
    evidenceLevel: JRCPCX_TERMS_EVIDENCE_LEVEL,
    official: true,
    officialDomain: JRCPCX_OFFICIAL_DOMAIN,
    sourceType: 'html',
    materialType: 'terms',
    parser: 'jrcpcx_insurance_catalog',
    pageText: trimString(product.pageText),
    snippet: trimString(product.snippet) || '金融产品查询平台收录的保险产品目录；需客户确认官方产品或条款名后再生成责任。',
    industryCode: trimString(product.industryCode),
    rowId: trimString(product.rowId || product.catalogId),
    catalogStatus: trimString(product.productState || product.status),
    qualityStatus: trimString(product.qualityStatus) || (trimString(product.pageText) ? 'valid_complete' : 'catalog_candidate'),
    detailUrl: trimString(product.detailUrl),
    clauseUrl: trimString(product.clauseUrl),
    detailFields: product.detail && typeof product.detail === 'object' && !Array.isArray(product.detail) ? product.detail : undefined,
    discoveredAt: now,
    lastFetchedAt: now,
    updatedAt: now,
  });
}

export function jrcpcxSourceReviewMessage(result = {}) {
  const code = trimString(result.code);
  const message = trimString(result.message);
  if (/ECONNREFUSED|connect_over_cdp|Traceback|SCRAPLING_OUTPUT_MISSING|127\.0\.0\.1:9224/iu.test(`${code}\n${message}`)) {
    return '金融产品查询平台浏览器未连接或需要人工验证，请稍后重试，或核对合同条款名称/上传条款页。';
  }
  return message || '金融产品查询平台需要人工验证或暂时不可用，请核对合同条款名称/上传条款页。';
}

function parseJsonObject(value, fallback = {}) {
  const raw = trimString(value);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/u);
    if (!match) return fallback;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
}

function uniqueTrimmed(values = [], limit = 8) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = trimString(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function fallbackOpenWebSearchPlan(policy = {}) {
  const company = trimString(policy.company);
  const productName = trimString(policy.name || policy.productName);
  const queryBase = [company, productName].filter(Boolean).join(' ');
  return {
    queries: uniqueTrimmed([
      `${queryBase} 保险 条款`,
      `${queryBase} 产品 责任`,
      `${queryBase} 老产品`,
      `${queryBase} 保单`,
    ], 6),
    preferredDomains: FALLBACK_OPEN_WEB_REFERENCE_DOMAINS,
    source: 'fallback',
  };
}

function normalizeOpenWebSearchPlan(plan = {}, policy = {}) {
  const fallback = fallbackOpenWebSearchPlan(policy);
  const queries = uniqueTrimmed([
    ...(Array.isArray(plan.queries) ? plan.queries.map((item) => (typeof item === 'string' ? item : item?.query)) : []),
    ...fallback.queries,
  ], 8);
  const preferredDomains = uniqueTrimmed([
    ...(Array.isArray(plan.preferredDomains) ? plan.preferredDomains : []),
    ...(Array.isArray(plan.domains) ? plan.domains : []),
    ...fallback.preferredDomains,
  ], 12).map(normalizeOfficialDomain).filter(Boolean);
  return {
    queries,
    preferredDomains,
    source: trimString(plan.source) || 'deepseek',
  };
}

export async function callDeepSeekForOpenWebSearchPlan({
  policy = {},
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_OPEN_WEB_SEARCH_TIMEOUT_MS,
} = {}) {
  const apiKey = trimString(env.DEEPSEEK_API_KEY);
  if (!apiKey) return fallbackOpenWebSearchPlan(policy);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(3000, timeoutMs));
  try {
    const baseUrl = trimString(env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL;
    const model = trimString(env.DEEPSEEK_OPEN_WEB_SEARCH_MODEL || env.DEEPSEEK_MODEL) || DEFAULT_OPEN_WEB_SEARCH_MODEL;
    const response = await fetchImpl(new URL('/chat/completions', baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sanitizeDeepSeekRequestBody({
        model,
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          {
            role: 'system',
            content: [
              '你是保险产品公开资料搜索规划器，只返回 JSON。',
              '目标：为后端生成搜索关键词和可优先查看的域名，不要编造搜索结果。',
              '优先级：保险公司官网/官方披露页、金融产品查询平台或行业协会、监管机构；之后才是第三方保险网站、问答、新闻。',
              '第三方网页只能作为“非官方资料，待保险公司确认”的线索。',
              'JSON 格式：{"queries":["..."],"preferredDomains":["..."],"reason":"..."}',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `保险公司：${trimString(policy.company)}\n客户输入产品名：${trimString(policy.name || policy.productName)}\n请给 3-6 个中文搜索关键词和 5-10 个优先域名。`,
          },
        ],
      })),
    });
    if (!response.ok) return fallbackOpenWebSearchPlan(policy);
    const payload = await response.json().catch(() => ({}));
    const content = trimString(payload?.choices?.[0]?.message?.content);
    return normalizeOpenWebSearchPlan(parseJsonObject(content, {}), policy);
  } catch {
    return fallbackOpenWebSearchPlan(policy);
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeSearchResultUrl(href = '') {
  const raw = decodeHtmlEntities(trimString(href));
  if (!raw) return '';
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const url = new URL(absolute);
    const redirected = trimString(url.searchParams.get('uddg'));
    if (/duckduckgo\.com$/u.test(url.hostname) && redirected) return redirected;
    return url.toString();
  } catch {
    return absolute;
  }
}

function parseDuckDuckGoResults(html = '', policy = {}, maxResults = 8) {
  const blocks = Array.from(String(html || '').matchAll(/<div class="result[\s\S]*?(?=<div class="result|<\/body>|$)/gu)).map((match) => match[0]);
  const productName = normalizeComparableFact(policy.name || policy.productName);
  const results = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u)
      || block.match(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u);
    if (!linkMatch) continue;
    const url = normalizeSearchResultUrl(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    const snippetMatch = block.match(/<a\s+[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/u)
      || block.match(/<div\s+[^>]*class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/u);
    const snippet = stripHtml(snippetMatch?.[1] || title);
    const relevanceText = normalizeComparableFact(`${title} ${snippet} ${url}`);
    if (!url || !title || (productName && !relevanceText.includes(productName))) continue;
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function parseBaiduResults(html = '', policy = {}, maxResults = 8) {
  const blocks = Array.from(String(html || '').matchAll(/<div[^>]+(?:result|c-container)[^>]*>[\s\S]*?(?=<div[^>]+(?:result|c-container)|<\/body>|$)/giu)).map((match) => match[0]);
  const productName = normalizeComparableFact(policy.name || policy.productName);
  const results = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<h3[^>]*>[\s\S]*?<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu)
      || block.match(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu);
    if (!linkMatch) continue;
    const url = normalizeSearchResultUrl(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    const snippetMatch = block.match(/<(?:div|span)[^>]+class="[^"]*(?:c-abstract|content-right|result-desc)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/iu);
    const snippet = stripHtml(snippetMatch?.[1] || title);
    const relevanceText = normalizeComparableFact(`${title} ${snippet} ${url}`);
    if (!url || !title || !/^https?:\/\//iu.test(url) || (productName && !relevanceText.includes(productName))) continue;
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function parseSoResults(html = '', policy = {}, maxResults = 8) {
  const blocks = Array.from(String(html || '').matchAll(/<li[^>]*class=["'][^"']*res-list[^"']*["'][^>]*>[\s\S]*?<\/li>/giu))
    .map((match) => match[0]);
  const productName = normalizeComparableFact(policy.name || policy.productName);
  const results = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<h3[^>]*>[\s\S]*?<a\s+([^>]*)>([\s\S]*?)<\/a>/iu);
    if (!linkMatch) continue;
    const attributes = linkMatch[1];
    const directUrl = attributes.match(/data-mdurl=["']([^"']+)["']/iu)?.[1];
    const href = attributes.match(/href=["']([^"']+)["']/iu)?.[1];
    const url = normalizeSearchResultUrl(directUrl || href || '');
    const title = stripHtml(linkMatch[2]);
    const snippetMatch = block.match(/<(?:span|p)[^>]*class=["'][^"']*(?:res-list-summary|res-desc)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|p)>/iu);
    const snippet = stripHtml(snippetMatch?.[1] || title);
    const relevanceText = normalizeComparableFact(`${title} ${snippet} ${url}`);
    if (!url || !title || !/^https?:\/\//iu.test(url) || (productName && !relevanceText.includes(productName))) continue;
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function searchQueriesFromPlan(plan = {}) {
  const queries = [];
  for (const query of plan.queries || []) {
    queries.push(query);
    for (const domain of (plan.preferredDomains || []).slice(0, 4)) {
      queries.push(`${query} site:${domain}`);
    }
  }
  return uniqueTrimmed(queries, 12);
}

async function fetchOpenWebSearchResults({ plan, policy, fetchImpl = fetch, timeoutMs = DEFAULT_OPEN_WEB_SEARCH_TIMEOUT_MS, maxResults = 8 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(3000, timeoutMs));
  const results = [];
  const seen = new Set();
  const engines = [
    { baseUrl: 'https://www.so.com/s', param: 'q', parse: parseSoResults },
    { baseUrl: 'https://duckduckgo.com/html/', param: 'q', parse: parseDuckDuckGoResults },
    { baseUrl: 'https://www.baidu.com/s', param: 'wd', parse: parseBaiduResults },
  ];
  try {
    for (const query of searchQueriesFromPlan(plan)) {
      for (const engine of engines) {
        if (results.length >= maxResults) break;
        try {
          const url = new URL(engine.baseUrl);
          url.searchParams.set(engine.param, query);
          if (engine.param !== 'q') url.searchParams.set('q', query);
          const response = await fetchImpl(url, {
            method: 'GET',
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0',
              Accept: 'text/html,application/xhtml+xml',
            },
          });
          if (!response.ok) continue;
          for (const result of engine.parse(await response.text(), policy, maxResults)) {
            const key = trimString(result.url);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            results.push(result);
            if (results.length >= maxResults) break;
          }
        } catch {
          continue;
        }
      }
      if (results.length >= maxResults) break;
    }
  } finally {
    clearTimeout(timeoutId);
  }
  return results;
}

function explicitSalesStatus(text = '', productName = '') {
  const content = normalizeComparableFact(text);
  const product = normalizeComparableFact(productName);
  const index = product ? content.indexOf(product) : -1;
  if (index < 0) return '';
  const nearby = content.slice(Math.max(0, index - 120), index + product.length + 120);
  if (/(?:已停售|停售|停止销售|不再销售)/u.test(nearby)) return '停售';
  if (/(?:在售|销售中|正在销售|可投保|立即投保)/u.test(nearby)) return '在售';
  return '';
}

async function fetchOfficialSalesStatusPage({ url, productName, fetchImpl, signal } = {}) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' },
    });
    const contentType = trimString(response.headers?.get?.('content-type'));
    if (!response.ok || (contentType && !contentType.includes('text/html'))) return '';
    return explicitSalesStatus(stripHtml(await response.text()), productName);
  } catch {
    return '';
  }
}

function discoveredMedicalProductNames(value = '', profile = {}) {
  const aliases = uniqueTrimmed([...(profile?.aliases || []), ...(profile?.companyAliases || [])], 20)
    .filter((alias) => alias.length >= 2);
  const compact = String(value || '').replace(/\s+/gu, '');
  const matches = [
    ...Array.from(compact.matchAll(
      /[\p{Script=Han}A-Za-z0-9·—（）()-]{2,60}?(?:百万医疗险|百万医疗保险|医疗保险)(?:[（(][^）)\n]{1,24}[）)])?/gu,
    )),
    ...Array.from(compact.matchAll(/(?:中国人寿|国寿)惠享保(?:[（(][^）)\n]{1,24}[）)])?(?:百万医疗险)?/gu)),
  ];
  return uniqueTrimmed(matches.map((match) => {
    let candidate = trimString(match[0]);
    const brandIndexes = aliases.map((alias) => ({ alias, index: candidate.lastIndexOf(alias) }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => right.index - left.index);
    if (brandIndexes[0]?.index > 0) candidate = candidate.slice(brandIndexes[0].index);
    if (/(?:中国人寿|国寿)/u.test(aliases.join(' '))) {
      candidate = candidate.replace(/^中国人寿(?:寿险公司)?(?:推出|发布)?/u, '国寿');
    }
    return candidate;
  }).filter((candidate) => (
    candidate.length >= 6
    && candidate.length <= 60
    && !/(?:有哪些|价格表|靠谱吗|值得买吗|险种|产品详情|产品有哪些|推荐|保险公司提供|有百万|财险|历史上|的一款)/u.test(candidate)
    && !/^国寿(?:百万医疗保险|百万医疗险|中端医疗保险|康悦医疗保险)$/u.test(candidate)
    && aliases.some((alias) => candidate.includes(alias))
  )), 12);
}

export async function searchOfficialProductSalesStatuses({
  company = '',
  productNames = [],
  discoveryQuery = '',
  officialDomainProfiles = [],
  fetchImpl = fetch,
  timeoutMs = 8_000,
} = {}) {
  const knownNames = uniqueTrimmed(productNames, 8);
  const categoryQuery = trimString(discoveryQuery);
  if (!trimString(company) || (!knownNames.length && !categoryQuery)) return [];
  const profile = resolveOfficialProfile({ company }, officialDomainProfiles);
  const domains = normalizeOfficialDomains(profile?.siteDomains?.length ? profile.siteDomains : profile?.officialDomains || []);
  if (!domains.length) return [];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(3_000, timeoutMs));
  try {
    const discovered = [];
    if (categoryQuery) {
      const discoveryQueries = [
        `${trimString(company)} ${categoryQuery} 在售 产品`,
        `${trimString(company)} ${categoryQuery} 2025 2026`,
        `${trimString(company)} 医疗保险 新品`,
        `${trimString(company)} 保证续保 医疗保险 新品`,
        ...(knownNames.some((name) => /康悦/u.test(name)) ? [`${trimString(company)} 康悦 医疗保险 2025 2026`] : []),
      ];
      const matches = (await Promise.all(discoveryQueries.map((query) => fetchOpenWebSearchResults({
        plan: { queries: [query], preferredDomains: [] },
        policy: { company },
        fetchImpl,
        timeoutMs,
        maxResults: 8,
      })))).flat();
      for (const match of matches) {
        const official = isOfficialUrl(match.url, { company }, officialDomainProfiles);
        const sourceText = `${match.title} ${match.snippet}`;
        const productNames = [
          ...discoveredMedicalProductNames(sourceText, profile),
          ...(/惠享保/u.test(sourceText) && /百万/u.test(sourceText)
            ? [`国寿惠享保百万医疗险${/免健告|免健康告知/u.test(sourceText) ? '（免健告版）' : ''}`]
            : []),
        ].filter((productName) => (
          !/百万医疗/u.test(categoryQuery)
          || /百万/u.test(sourceText)
          || (/康悦|惠享保/u.test(productName) && !/质子|海外/u.test(productName))
        ) && !(productName.includes('超医保') && /财险/u.test(sourceText)));
        for (const productName of productNames) {
          discovered.push({
            company: trimString(company),
            productName,
            status: '待核验',
            checkedAt: nowIso(),
            evidenceLevel: official ? 'insurer_official' : 'open_web_reference',
            source: { title: trimString(match.title) || `${productName}公开网页线索`, url: match.url },
          });
        }
      }
    }
    const names = uniqueTrimmed([...knownNames, ...discovered.map((item) => item.productName)], 12);
    const results = await Promise.all(names.map(async (productName) => {
      const query = `\"${productName}\" 在售 停售 (${domains.map((domain) => `site:${domain}`).join(' OR ')})`;
      const matches = await fetchOpenWebSearchResults({
        plan: { queries: [query], preferredDomains: [] },
        policy: { company, name: productName },
        fetchImpl,
        timeoutMs,
        maxResults: 3,
      });
      for (const match of matches) {
        if (!isOfficialUrl(match.url, { company, name: productName }, officialDomainProfiles)) continue;
        const snippetStatus = explicitSalesStatus(`${match.title} ${match.snippet}`, productName);
        const status = snippetStatus || await fetchOfficialSalesStatusPage({
          url: match.url,
          productName,
          fetchImpl,
          signal: controller.signal,
        });
        if (status) {
          return {
            company: trimString(company),
            productName,
            status,
            checkedAt: nowIso(),
            evidenceLevel: 'insurer_official',
            source: { title: trimString(match.title) || `${productName}官方资料`, url: match.url },
          };
        }
      }
      return null;
    }));
    const verifiedNames = new Set(results.filter(Boolean).map((item) => trimString(item.productName)));
    const combined = [
      ...results.filter(Boolean),
      ...discovered.filter((item) => !verifiedNames.has(trimString(item.productName))),
    ];
    const combinedByName = new Map();
    for (const item of combined) {
      const key = trimString(item.productName).normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
        .replace(/百万(?=医疗)/gu, '')
        .replace(/医疗险(?=\(|$)/u, '医疗保险')
        .replace(/\(([a-z])(?:款)?\)$/iu, '($1款)');
      const current = combinedByName.get(key);
      const score = (trimString(item.evidenceLevel) === 'insurer_official' ? 100 : 0)
        + (/医疗保险(?:[（(]|$)/u.test(trimString(item.productName)) ? 10 : 0)
        - (/百万医疗保险/u.test(trimString(item.productName)) ? 1 : 0);
      const currentScore = current
        ? (trimString(current.evidenceLevel) === 'insurer_official' ? 100 : 0)
          + (/医疗保险(?:[（(]|$)/u.test(trimString(current.productName)) ? 10 : 0)
          - (/百万医疗保险/u.test(trimString(current.productName)) ? 1 : 0)
        : -1;
      if (!current || score > currentScore) combinedByName.set(key, item);
    }
    return [...combinedByName.values()];
  } finally {
    clearTimeout(timeoutId);
  }
}

function openWebReferenceRecordFromSearchResult(result = {}, policy = {}, officialDomainProfiles = []) {
  const url = trimString(result.url);
  const company = trimString(policy.company);
  const productName = trimString(policy.name || policy.productName);
  if (!url || !company || !productName) return null;
  const sourceKind = isJrcpcxRecordLike({ url }) ? 'jrcpcx' : isOfficialUrl(url, policy, officialDomainProfiles) ? 'insurer_official' : 'open_web_reference';
  const official = sourceKind !== 'open_web_reference';
  const jrcpcx = sourceKind === 'jrcpcx';
  return normalizeKnowledgeRecord({
    company,
    productName,
    title: trimString(result.title) || `${productName}公开网页线索`,
    url,
    snippet: trimString(result.snippet) || '公开网页搜索结果；需保险公司确认后再使用责任信息。',
    pageText: trimString(result.pageText),
    sourceType: trimString(result.sourceType) || resolveSourceType(url),
    materialType: official ? classifyMaterialType(`${result.title} ${url}`) : 'external_reference',
    official,
    sourceKind,
    evidenceLabel: jrcpcx ? JRCPCX_TERMS_EVIDENCE_LABEL : official ? '保险公司官方资料' : LEGACY_EXTERNAL_REFERENCE_LABEL,
    evidenceLevel: jrcpcx ? JRCPCX_TERMS_EVIDENCE_LEVEL : official ? 'insurer_official' : LEGACY_EXTERNAL_REFERENCE_LEVEL,
    qualityStatus: official ? 'search_candidate' : 'external_reference_only',
    qualityReason: official ? '开放网页搜索发现的强来源候选。' : '开放网页搜索发现的非官方线索，仅作建档和核实提示。',
    responsibilityDeferred: !official,
    parser: 'deepseek_planned_open_web_search',
  });
}

export async function crawlOpenWebProductReferenceRecords({
  policy = {},
  maxResults = 8,
  fetchImpl = fetch,
  officialDomainProfiles = [],
  searchPlan,
  timeoutMs = DEFAULT_OPEN_WEB_SEARCH_TIMEOUT_MS,
} = {}) {
  const productName = trimString(policy.name || policy.productName);
  if (!trimString(policy.company) || !productName) return { status: 'not_found', records: [], message: '请补充保险公司和产品名称。' };
  const plan = normalizeOpenWebSearchPlan(searchPlan || await callDeepSeekForOpenWebSearchPlan({ policy, fetchImpl, timeoutMs }), policy);
  const results = await fetchOpenWebSearchResults({
    plan,
    policy,
    fetchImpl,
    timeoutMs,
    maxResults: Math.max(3, Math.min(20, maxResults * 2)),
  });
  const records = [];
  const seen = new Set();
  for (const result of results) {
    const fetched = await fetchMaterialPageText({
      url: result.url,
      policy,
      fetchImpl,
      signal: undefined,
    });
    const record = openWebReferenceRecordFromSearchResult(
      {
        ...result,
        pageText: fetched.pageText,
        sourceType: fetched.sourceType,
      },
      policy,
      officialDomainProfiles,
    );
    if (!record) continue;
    const key = `${record.company}\u001f${record.productName}\u001f${record.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
    if (records.length >= maxResults) break;
  }
  if (!records.length) {
    return {
      status: 'not_found',
      records: [],
      message: '开放网页未找到可建档线索；请尝试合同上的完整条款名称、保单号，或联系保险公司核实。',
      plan,
    };
  }
  return {
    status: 'candidates',
    records,
    message: records.some((record) => record.sourceKind === 'open_web_reference')
      ? '已按 DeepSeek 搜索计划找到开放网页线索；非官方资料需保险公司确认后再使用责任信息。'
      : '已按 DeepSeek 搜索计划找到强来源候选，请确认官方产品或条款名。',
    plan,
  };
}

export function legacyExternalProductReferenceRecords({ policy = {} } = {}) {
  const inputCompany = trimString(policy.company);
  const inputName = compactKnowledgeText(policy.name || policy.productName);
  if (!inputCompany || !inputName) return [];
  const records = [];
  for (const item of LEGACY_EXTERNAL_PRODUCT_REFERENCES) {
    const companyMatchesInput = companiesMatch(inputCompany, item.company, []) || compactKnowledgeText(inputCompany).includes(compactKnowledgeText(item.company));
    if (!companyMatchesInput) continue;
    const aliases = [item.productName, ...(Array.isArray(item.aliases) ? item.aliases : [])];
    const aliasMatched = aliases.some((alias) => {
      const normalized = compactKnowledgeText(alias);
      return normalized && (normalized.includes(inputName) || inputName.includes(normalized));
    });
    if (!aliasMatched) continue;
    for (const source of item.sources || []) {
      const record = normalizeKnowledgeRecord({
        company: item.company,
        productName: item.productName,
        title: trimString(source.title) || `${item.productName}外部线索`,
        url: trimString(source.url),
        snippet: trimString(source.snippet) || '第三方公开网页线索；需保险公司确认后再使用责任信息。',
        pageText: '',
        sourceType: 'html',
        materialType: 'external_reference',
        official: false,
        sourceKind: 'legacy_external_reference',
        evidenceLabel: LEGACY_EXTERNAL_REFERENCE_LABEL,
        evidenceLevel: LEGACY_EXTERNAL_REFERENCE_LEVEL,
        qualityStatus: 'legacy_reference_only',
        qualityReason: '历史老产品公开渠道未找到官方条款 PDF，仅作建档线索。',
        responsibilityDeferred: true,
        parser: 'legacy_external_reference_seed',
      });
      if (record) records.push(record);
    }
  }
  return records;
}

export async function crawlJrcpcxProductCandidateRecords({ policy = {}, maxResults = 8, timeoutMs = 30_000 } = {}) {
  const productName = trimString(policy.name || policy.productName);
  if (!productName) {
    return {
      status: 'not_found',
      records: [],
      message: '请核对合同条款名称/险种名称，或上传条款页。',
    };
  }
  const pageSize = Math.max(10, Math.min(50, Number(maxResults || 8) * 2));
  const result = await runScraplingCrawlerPayload(
    {
      mode: 'jrcpcx_insurance_catalog_ui',
      cdpUrl: trimString(process.env.JRCPCX_CDP_URL) || 'http://127.0.0.1:9224',
      waitMs: Math.max(5000, Math.min(timeoutMs - 1000, 20_000)),
      pageSize,
      maxPages: 1,
      fetchDetailLinks: '1',
      extractResponsibility: '0',
      queries: [
        {
          productName,
          productTypeLabel: '全部',
          productTermLabel: '全部',
          productStateLabel: '全部',
        },
      ],
    },
    { timeoutMs: Math.max(8000, timeoutMs) },
  );
  const products = Array.isArray(result.products) ? result.products : [];
  const rawRecords = Array.isArray(result.records) ? result.records : [];
  const records = [
    ...rawRecords.map((record) => normalizeKnowledgeRecord({
      ...record,
      sourceKind: 'jrcpcx',
      evidenceLabel: JRCPCX_TERMS_EVIDENCE_LABEL,
      evidenceLevel: JRCPCX_TERMS_EVIDENCE_LEVEL,
    })).filter(Boolean),
    ...products.map((product) => jrcpcxProductCandidateRecord(product, policy)).filter(Boolean),
  ];
  const deduped = [];
  const seen = new Set();
  for (const record of records) {
    const key = `${record.company}\u001f${record.productName}\u001f${record.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(record);
  }
  if (deduped.length) {
    return {
      status: 'candidates',
      records: deduped,
      message: '已从金融产品查询平台找到候选产品，请确认官方产品或条款名。',
      raw: result,
    };
  }
  if (result.ok === false || result.partial || ['JRCPCX_VERIFICATION_REQUIRED', 'JRCPCX_QUERY_BUTTON_DISABLED', 'SCRAPLING_TIMEOUT'].includes(trimString(result.code))) {
    return {
      status: 'source_review_required',
      records: [],
      code: trimString(result.code) || 'JRCPCX_REVIEW_REQUIRED',
      message: jrcpcxSourceReviewMessage(result),
      raw: result,
    };
  }
  return {
    status: 'not_found',
    records: [],
    message: '请核对保险合同上的具体条款名称/险种名称，或上传条款页。',
    raw: result,
  };
}

async function parseNewChinaKnowledge({ policy, officialDomainProfiles, fetchImpl, signal } = {}) {
  if (!isNewChinaPolicy(policy)) return [];
  const productName = trimString(policy.name || policy.productName);
  if (!productName) return [];
  const records = [];
  const seenUrls = new Set();
  for (const disclosureUrlValue of NEW_CHINA_PRODUCT_DISCLOSURE_URLS) {
    const disclosureUrl = new URL(disclosureUrlValue);
    disclosureUrl.searchParams.set('productName', productName);
    try {
      const response = await fetchImpl(disclosureUrl, {
        method: 'GET',
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!response.ok) continue;
      const html = await response.text();
      const productRows = extractHtmlRows(html).filter((row) => isNewChinaProductRow(row, policy));
      for (const row of productRows) {
        const productTitle = extractNewChinaProductTitle(row, policy);
        const materialLinks = extractHtmlLinks(row, disclosureUrl.toString()).filter(
          (link) => RESPONSIBILITY_MATERIAL_LABEL_PATTERN.test(link.label) && !EXCLUDED_MATERIAL_LABEL_PATTERN.test(link.label),
        );
        for (const link of materialLinks) {
          const materialUrl = link.url;
          const candidates = /\.pdf(?:$|[?#])/iu.test(materialUrl)
            ? [{ ...link, url: materialUrl, label: link.label }]
            : extractHtmlLinks(
                await fetchImpl(materialUrl, {
                  method: 'GET',
                  signal,
                  headers: {
                    'User-Agent': 'Mozilla/5.0',
                    Accept: 'text/html,application/xhtml+xml',
                  },
                }).then((materialResponse) => (materialResponse.ok ? materialResponse.text() : ''))
                  .catch(() => ''),
                materialUrl,
              ).filter(
                (nestedLink) =>
                  /\.pdf(?:$|[?#])/iu.test(nestedLink.url)
                  && productMatchesText(productName, nestedLink.label)
                  && !EXCLUDED_MATERIAL_LABEL_PATTERN.test(nestedLink.label),
              );
          for (const candidate of candidates) {
            if (!candidate.url || seenUrls.has(candidate.url)) continue;
            seenUrls.add(candidate.url);
            const { pageText, sourceType } = await fetchMaterialPageText({
              url: candidate.url,
              policy,
              fetchImpl,
              signal,
            });
            if (!pageText) continue;
            records.push(
              buildKnowledgeRecord({
                policy: { ...policy, name: productName },
                title: trimString(`${productTitle}${candidate.label && !productTitle.includes(candidate.label) ? candidate.label : ''}`),
                url: candidate.url,
                snippet: `新华保险官网产品基本信息披露材料：${candidate.label || link.label || '披露材料'}`,
                pageText,
                sourceType,
                materialType: classifyMaterialType(`${candidate.label} ${link.label}`),
                parser: 'new_china_disclosure',
                officialDomainProfiles,
              }),
            );
          }
        }
      }
    } catch {
      continue;
    }
  }
  return records;
}

function buildGenericEntryUrls(policy = {}, officialDomainProfiles = []) {
  const profile = resolveOfficialProfile(policy, officialDomainProfiles);
  const domains = normalizeOfficialDomains(profile?.siteDomains?.length ? profile.siteDomains : profile?.officialDomains || []);
  const urls = [];
  for (const domain of domains) {
    for (const path of GENERIC_ENTRY_PATHS) {
      urls.push(`https://${domain}/${path}`.replace(/\/$/u, '/'));
      if (!domain.startsWith('www.')) urls.push(`https://www.${domain}/${path}`.replace(/\/$/u, '/'));
    }
  }
  return Array.from(new Set(urls));
}

async function parseGenericOfficialKnowledge({ policy, officialDomainProfiles, fetchImpl, signal } = {}) {
  const productName = trimString(policy.name || policy.productName);
  if (!trimString(policy.company) || !productName) return [];
  const records = [];
  const seenUrls = new Set();
  for (const entryUrl of buildGenericEntryUrls(policy, officialDomainProfiles)) {
    try {
      const response = await fetchImpl(entryUrl, {
        method: 'GET',
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!response.ok) continue;
      const html = await response.text();
      const links = extractHtmlLinks(html, entryUrl).filter((link) => {
        const text = `${link.label} ${link.url}`;
        return isOfficialUrl(link.url, policy, officialDomainProfiles)
          && productMatchesText(productName, text)
          && !EXCLUDED_MATERIAL_LABEL_PATTERN.test(text)
          && (MATERIAL_KEYWORD_PATTERN.test(text) || /\.pdf(?:$|[?#])/iu.test(link.url));
      });
      for (const link of links) {
        if (seenUrls.has(link.url)) continue;
        seenUrls.add(link.url);
        const { pageText, sourceType } = await fetchMaterialPageText({
          url: link.url,
          policy,
          fetchImpl,
          signal,
        });
        if (!pageText) continue;
        records.push(
          buildKnowledgeRecord({
            policy,
            title: link.label,
            url: link.url,
            snippet: `${trimString(policy.company)}官网页面发现的产品资料`,
            pageText,
            sourceType,
            materialType: classifyMaterialType(`${link.label} ${link.url}`),
            parser: 'generic_official_links',
            officialDomainProfiles,
          }),
        );
      }
    } catch {
      continue;
    }
  }
  return records;
}

export function normalizeKnowledgeRecord(record = {}, { officialDomainProfiles = [] } = {}) {
  const url = trimString(record.url);
  const company = trimString(record.company);
  const productName = trimString(record.productName || record.name);
  if (!url || !company || !productName) return null;
  const now = nowIso();
  const policy = { company, name: productName };
  const jrcpcxRecord = isJrcpcxRecordLike(record);
  const sourceLevel = trimString(record.sourceLevel);
  const sourceKind = normalizeKnowledgeSourceKind(record);
  const customerPolicyPhoto = sourceKind === CUSTOMER_POLICY_PHOTO_SOURCE_KIND;
  const customerPolicyTerms = sourceKind === CUSTOMER_POLICY_TERMS_SOURCE_KIND;
  const reviewStatus = trimString(record.reviewStatus) || (customerPolicyPhoto ? 'pending' : customerPolicyTerms ? 'approved' : '');
  const globalSearchable = customerPolicyPhoto
    ? record.globalSearchable === true
    : customerPolicyTerms
      ? record.globalSearchable !== false
      : Boolean(record.globalSearchable);
  const normalized = {
    id: record.id,
    company,
    productName,
    productType: normalizeKnowledgeProductType(record),
    salesStatus: trimString(record.salesStatus),
    title: trimString(record.title) || url,
    url,
    snippet: trimString(record.snippet),
    pageText: trimString(record.pageText),
    sourceType: trimString(record.sourceType) || resolveSourceType(url),
    materialType: trimString(record.materialType) || classifyMaterialType(`${record.title} ${url}`),
    official: customerPolicyTerms ? true : (record.official === undefined ? isOfficialUrl(url, policy, officialDomainProfiles) : Boolean(record.official)),
    evidenceLabel: trimString(record.evidenceLabel) || (customerPolicyTerms ? CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL : customerPolicyPhoto ? '客户上传保单照片（待审核）' : jrcpcxRecord ? JRCPCX_TERMS_EVIDENCE_LABEL : '本地知识库官方资料'),
    evidenceLevel: trimString(record.evidenceLevel) || sourceLevel || (customerPolicyTerms ? CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL : customerPolicyPhoto ? CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL : jrcpcxRecord ? JRCPCX_TERMS_EVIDENCE_LEVEL : 'insurer_official'),
    sourceLevel,
    sourceKind,
    officialDomain: trimString(record.officialDomain) || (jrcpcxRecord ? JRCPCX_OFFICIAL_DOMAIN : resolveOfficialDomain(url, officialDomainProfiles)),
    sourceUrl: trimString(record.sourceUrl || record.source),
    parser: trimString(record.parser),
    extractionMethod: trimString(record.extractionMethod),
    planCode: trimString(record.planCode),
    productCode: trimString(record.productCode || record.product_code),
    riskCode: trimString(record.riskCode || record.risk_code),
    versionNo: trimString(record.versionNo),
    industryCode: trimString(record.industryCode),
    rowId: trimString(record.rowId),
    catalogStatus: trimString(record.catalogStatus),
    seedSource: trimString(record.seedSource),
    seedSourceUrl: trimString(record.seedSourceUrl),
    qualityStatus: trimString(record.qualityStatus),
    qualityReason: trimString(record.qualityReason),
    pages: Number(record.pages || 0) || 0,
    bytes: Number(record.bytes || 0) || 0,
    contentType: trimString(record.contentType),
    pdfLocalPath: trimString(record.pdfLocalPath),
    pdfSha256: trimString(record.pdfSha256),
    pdfBytes: Number(record.pdfBytes || 0) || 0,
    pdfOriginalUrl: trimString(record.pdfOriginalUrl),
    pdfArchivedAt: trimString(record.pdfArchivedAt),
    detailUrl: trimString(record.detailUrl),
    detailApiUrl: trimString(record.detailApiUrl),
    clauseFileName: trimString(record.clauseFileName),
    clauseUrl: trimString(record.clauseUrl),
    futureExtractionStatus: trimString(record.futureExtractionStatus),
    responsibilityDeferred: customerPolicyTerms ? false : Boolean(record.responsibilityDeferred),
    reviewStatus,
    globalSearchable,
    reviewedAt: trimString(record.reviewedAt),
    ownerUserId: Number(record.ownerUserId || 0) || 0,
    ownerGuestId: trimString(record.ownerGuestId),
    uploadNames: Array.isArray(record.uploadNames) ? record.uploadNames.map(trimString).filter(Boolean) : [],
    uploadImages: Array.isArray(record.uploadImages)
      ? record.uploadImages.map((item) => ({
        name: trimString(item?.name),
        type: trimString(item?.type) || 'image/jpeg',
        size: Number(item?.size || 0) || 0,
        dataUrl: trimString(item?.dataUrl),
      })).filter((item) => item.dataUrl.startsWith('data:image/'))
      : [],
    detailFields: record.detailFields && typeof record.detailFields === 'object' && !Array.isArray(record.detailFields)
      ? record.detailFields
      : undefined,
    discoveredAt: trimString(record.discoveredAt) || now,
    lastFetchedAt: trimString(record.lastFetchedAt) || now,
    updatedAt: trimString(record.updatedAt) || now,
    lastUsedAt: trimString(record.lastUsedAt),
    useCount: Number(record.useCount || 0) || 0,
  };
  return {
    ...normalized,
    ...evidenceVerificationFields(normalized),
  };
}

export function upsertKnowledgeRecords(state, records = [], { allocateId, officialDomainProfiles = [] } = {}) {
  if (!state) return [];
  if (!Array.isArray(state.knowledgeRecords)) state.knowledgeRecords = [];
  const saved = [];
  for (const rawRecord of Array.isArray(records) ? records : []) {
    const record = normalizeKnowledgeRecord(rawRecord, { officialDomainProfiles });
    if (!record) continue;
    const existing = state.knowledgeRecords.find((row) => String(row.url || '') === record.url) || null;
    if (existing) {
      existing.company = record.company || existing.company;
      existing.productName = record.productName || existing.productName;
      existing.productType = record.productType || existing.productType;
      existing.salesStatus = record.salesStatus || existing.salesStatus;
      existing.title = record.title || existing.title;
      existing.snippet = record.snippet || existing.snippet;
      existing.pageText = record.pageText || existing.pageText;
      existing.sourceType = record.sourceType || existing.sourceType;
      existing.materialType = record.materialType || existing.materialType;
      existing.official = Boolean(record.official);
      existing.evidenceLabel = record.evidenceLabel || existing.evidenceLabel;
      existing.evidenceLevel = record.evidenceLevel || existing.evidenceLevel;
      existing.verificationStatus = record.verificationStatus || existing.verificationStatus;
      existing.verificationLabel = record.verificationLabel || existing.verificationLabel;
      existing.referenceOnly = record.referenceOnly === true;
      existing.sourceLevel = record.sourceLevel || existing.sourceLevel;
      existing.sourceKind = record.sourceKind || existing.sourceKind;
      existing.officialDomain = record.officialDomain || existing.officialDomain;
      existing.sourceUrl = record.sourceUrl || existing.sourceUrl;
      existing.parser = record.parser || existing.parser;
      existing.extractionMethod = record.extractionMethod || existing.extractionMethod;
      existing.planCode = record.planCode || existing.planCode;
      existing.productCode = record.productCode || existing.productCode;
      existing.riskCode = record.riskCode || existing.riskCode;
      existing.versionNo = record.versionNo || existing.versionNo;
      existing.industryCode = record.industryCode || existing.industryCode;
      existing.rowId = record.rowId || existing.rowId;
      existing.catalogStatus = record.catalogStatus || existing.catalogStatus;
      existing.seedSource = record.seedSource || existing.seedSource;
      existing.seedSourceUrl = record.seedSourceUrl || existing.seedSourceUrl;
      existing.qualityStatus = record.qualityStatus || existing.qualityStatus;
      existing.qualityReason = record.qualityReason || existing.qualityReason;
      existing.pages = record.pages || existing.pages;
      existing.bytes = record.bytes || existing.bytes;
      existing.contentType = record.contentType || existing.contentType;
      existing.pdfLocalPath = record.pdfLocalPath || existing.pdfLocalPath;
      existing.pdfSha256 = record.pdfSha256 || existing.pdfSha256;
      existing.pdfBytes = record.pdfBytes || existing.pdfBytes;
      existing.pdfOriginalUrl = record.pdfOriginalUrl || existing.pdfOriginalUrl;
      existing.pdfArchivedAt = record.pdfArchivedAt || existing.pdfArchivedAt;
      existing.detailUrl = record.detailUrl || existing.detailUrl;
      existing.detailApiUrl = record.detailApiUrl || existing.detailApiUrl;
      existing.clauseFileName = record.clauseFileName || existing.clauseFileName;
      existing.clauseUrl = record.clauseUrl || existing.clauseUrl;
      existing.futureExtractionStatus = record.futureExtractionStatus || existing.futureExtractionStatus;
      existing.responsibilityDeferred = record.responsibilityDeferred || existing.responsibilityDeferred;
      existing.reviewStatus = record.reviewStatus || existing.reviewStatus;
      existing.globalSearchable = record.globalSearchable;
      existing.reviewedAt = record.reviewedAt || existing.reviewedAt;
      existing.ownerUserId = record.ownerUserId || existing.ownerUserId;
      existing.ownerGuestId = record.ownerGuestId || existing.ownerGuestId;
      existing.uploadNames = record.uploadNames?.length ? record.uploadNames : existing.uploadNames;
      existing.detailFields = record.detailFields || existing.detailFields;
      existing.lastFetchedAt = record.lastFetchedAt || existing.lastFetchedAt;
      existing.updatedAt = nowIso();
      saved.push(existing);
      continue;
    }
    const next = {
      ...record,
      id: record.id || (typeof allocateId === 'function' ? allocateId(state) : undefined),
    };
    state.knowledgeRecords.push(next);
    saved.push(next);
  }
  return saved;
}

export function findKnowledgeRecordsForPolicy({
  policy = {},
  records = [],
  officialDomainProfiles = [],
  maxResults = DEFAULT_MAX_KNOWLEDGE_RESULTS,
  includeExternalReferences = false,
} = {}) {
  const productName = trimString(policy.name || policy.productName);
  const company = trimString(policy.company);
  if (!company || !productName) return [];
  const matched = (Array.isArray(records) ? records : [])
    .map((record) => normalizeKnowledgeRecord(record, { officialDomainProfiles }))
    .filter(Boolean)
    .filter((record) => {
      if (record.qualityStatus === 'invalid_responsibility') return false;
      const sourceKind = sourceKindForKnowledgeRecord(record);
      const externalReference = includeExternalReferences && isExternalReferenceSourceKind(sourceKind);
      if (externalReference) return Boolean(record.pageText || record.snippet);
      if (sourceKind === CUSTOMER_POLICY_TERMS_SOURCE_KIND) return isFormalResponsibilityEvidence(record) && Boolean(record.pageText || record.snippet);
      return (
        record.official &&
        record.pageText &&
        (isOfficialUrl(record.url, policy, officialDomainProfiles) ||
          domainMatches(resolveUrlHostname(record.url), record.officialDomain))
      );
    })
    .filter((record) => {
      const companyMatch = !record.company || companiesMatch(company, record.company, officialDomainProfiles);
      return companyMatch && productMatchesText(productName, record.productName || record.title || record.url);
    });
  const exactVersionMatches = matched.filter((record) =>
    strictProductNameMatches(productName, record.productName, company)
      || strictProductNameMatches(productName, record.title, company),
  );
  return (exactVersionMatches.length ? exactVersionMatches : matched)
    .sort((left, right) => {
      const leftExact = Number(
        strictProductNameMatches(productName, left.productName, company)
          || strictProductNameMatches(productName, left.title, company),
      );
      const rightExact = Number(
        strictProductNameMatches(productName, right.productName, company)
          || strictProductNameMatches(productName, right.title, company),
      );
      const leftScore = leftExact * 100 + Number(Boolean(left.pageText)) * 20 + Number(left.sourceType === 'pdf') * 10 + Number(left.materialType === 'terms') * 5;
      const rightScore = rightExact * 100 + Number(Boolean(right.pageText)) * 20 + Number(right.sourceType === 'pdf') * 10 + Number(right.materialType === 'terms') * 5;
      return rightScore - leftScore || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    })
    .slice(0, maxResults);
}

export function findKnowledgeProductCandidates({
  policy = {},
  records = [],
  officialDomainProfiles = [],
  maxResults = 8,
  minScore = 0.32,
  requirePageText = true,
  includeExternalReferences = false,
  includeCustomerPolicyPhotoRecords = false,
} = {}) {
  const productName = trimString(policy.name || policy.productName);
  const company = trimString(policy.company);
  if (!company || !productName) return [];
  const queryProductCodes = productIdentityCodesFromText(productName);
  const grouped = new Map();
  for (const rawRecord of Array.isArray(records) ? records : []) {
    const record = normalizeKnowledgeRecord(rawRecord, { officialDomainProfiles });
    if (!record) continue;
    const sourceKind = sourceKindForKnowledgeRecord(record);
    const customerPolicyPhotoReference = (
      sourceKind === CUSTOMER_POLICY_PHOTO_SOURCE_KIND &&
      isApprovedCustomerPolicyPhotoRecord(record) &&
      (includeExternalReferences || includeCustomerPolicyPhotoRecords)
    );
    const externalReference = includeExternalReferences && isExternalReferenceSourceKind(sourceKind) && (
      sourceKind !== CUSTOMER_POLICY_PHOTO_SOURCE_KIND || customerPolicyPhotoReference
    );
    const nonOfficialReference = externalReference || customerPolicyPhotoReference;
    const evidenceFields = evidenceVerificationFields(record);
    if ((!record.official && !nonOfficialReference) || (requirePageText && !record.pageText && !nonOfficialReference) || record.qualityStatus === 'invalid_responsibility') continue;
    if (
      !nonOfficialReference &&
      !(
        sourceKind === CUSTOMER_POLICY_TERMS_SOURCE_KIND ||
        sourceKind === 'jrcpcx' ||
        isOfficialUrl(record.url, { company: record.company, name: record.productName }, officialDomainProfiles) ||
        domainMatches(resolveUrlHostname(record.url), record.officialDomain)
      )
    ) {
      continue;
    }
    const companyMatch = !record.company || companiesMatch(company, record.company, officialDomainProfiles);
    if (!companyMatch) continue;
    const recordProductCodes = productIdentityCodesFromRecord(record);
    const matchedProductCode = recordProductCodes.find((code) => queryProductCodes.includes(code)) || '';
    const hasDifferentKnownCode = Boolean(queryProductCodes.length && recordProductCodes.length && !matchedProductCode);
    const productScore = scoreProductNameMatch(productName, record.productName, company);
    const titleScore = scoreProductNameMatch(productName, record.title, company) * 0.96;
    let score = Math.max(productScore, titleScore);
    if (matchedProductCode) score = Math.max(score, 1);
    else if (hasDifferentKnownCode) score = Math.min(score, 0.64);
    if (score < minScore) continue;
    const key = `${record.company}\n${record.productName}`;
    const existing = grouped.get(key);
    const strictExact = strictProductNameMatches(productName, record.productName, company)
      || strictProductNameMatches(productName, record.title, company);
    const sourceWeight = Number(record.sourceType === 'pdf') * 0.03 + Number(record.materialType === 'terms') * 0.02;
    const rankingScore = score + Number(strictExact) * 0.2 + Number(Boolean(matchedProductCode)) * 0.4 + sourceWeight;
    if (!existing) {
      grouped.set(key, {
        company: record.company,
        productName: record.productName,
        canonicalProductId: canonicalProductIdFromOfficialProduct({
          company: record.company,
          productName: record.productName,
        }),
        title: record.title,
        score,
        matchReason: matchedProductCode ? `产品代码 ${matchedProductCode}` : knowledgeMatchReason(score),
        evidenceLabel: record.evidenceLabel || '本地知识库官方资料',
        evidenceLevel: record.evidenceLevel || 'insurer_official',
        verificationStatus: evidenceFields.verificationStatus,
        verificationLabel: evidenceFields.verificationLabel,
        referenceOnly: evidenceFields.referenceOnly,
        sourceKind,
        inputName: productName,
        resolvedProductName: record.productName,
        productCode: recordProductCodes[0] || '',
        productCodes: recordProductCodes,
        needsConfirmation: true,
        responsibilityDeferred: Boolean(record.responsibilityDeferred),
        sourceCount: 1,
        bestSource: {
          title: record.title,
          url: record.url,
          sourceType: record.sourceType,
          materialType: record.materialType,
          sourceKind,
          evidenceLevel: record.evidenceLevel || 'insurer_official',
          verificationStatus: evidenceFields.verificationStatus,
          verificationLabel: evidenceFields.verificationLabel,
          referenceOnly: evidenceFields.referenceOnly,
          detailUrl: record.detailUrl,
          clauseUrl: record.clauseUrl,
          productCode: recordProductCodes[0] || '',
          productCodes: recordProductCodes,
          responsibilityDeferred: Boolean(record.responsibilityDeferred),
        },
        rankingScore,
      });
      continue;
    }
    existing.sourceCount += 1;
    existing.productCodes = mergeProductIdentityCodes(existing.productCodes, recordProductCodes);
    existing.productCode = existing.productCode || existing.productCodes[0] || '';
    if (rankingScore > existing.rankingScore) {
      existing.title = record.title;
      existing.score = score;
      existing.matchReason = matchedProductCode ? `产品代码 ${matchedProductCode}` : knowledgeMatchReason(score);
      existing.evidenceLabel = record.evidenceLabel || existing.evidenceLabel;
      existing.evidenceLevel = record.evidenceLevel || existing.evidenceLevel;
      existing.verificationStatus = evidenceFields.verificationStatus;
      existing.verificationLabel = evidenceFields.verificationLabel;
      existing.referenceOnly = evidenceFields.referenceOnly;
      existing.sourceKind = sourceKind;
      existing.responsibilityDeferred = Boolean(record.responsibilityDeferred);
      existing.bestSource = {
        title: record.title,
        url: record.url,
        sourceType: record.sourceType,
        materialType: record.materialType,
        sourceKind,
        evidenceLevel: record.evidenceLevel || existing.evidenceLevel,
        verificationStatus: evidenceFields.verificationStatus,
        verificationLabel: evidenceFields.verificationLabel,
        referenceOnly: evidenceFields.referenceOnly,
        detailUrl: record.detailUrl,
        clauseUrl: record.clauseUrl,
        productCode: recordProductCodes[0] || '',
        productCodes: recordProductCodes,
        responsibilityDeferred: Boolean(record.responsibilityDeferred),
      };
      existing.rankingScore = rankingScore;
    }
  }
  return [...grouped.values()]
    .sort((left, right) => right.rankingScore - left.rankingScore || right.sourceCount - left.sourceCount || left.productName.localeCompare(right.productName))
    .slice(0, maxResults)
    .map(({ rankingScore, ...item }) => ({
      ...item,
      score: Number(item.score.toFixed(3)),
    }));
}

export function withPolicyProductMatchStatus({ policy = {}, matches = [] } = {}) {
  const inputName = trimString(policy.name || policy.productName);
  const company = trimString(policy.company);
  const inputProductCodes = productIdentityCodesFromText(inputName);
  const enriched = (Array.isArray(matches) ? matches : [])
    .map((match) => {
      const resolvedProductName = trimString(match.resolvedProductName || match.productName);
      const sourceKind = match.sourceKind || 'local';
      const alwaysConfirm = Boolean(match.responsibilityDeferred) || isExternalReferenceSourceKind(sourceKind);
      const matchProductCodes = mergeProductIdentityCodes(
        match.productCodes,
        match.productCode ? [match.productCode] : [],
        match.bestSource?.productCodes,
        match.bestSource?.productCode ? [match.bestSource.productCode] : [],
      );
      const productCodeExact = !alwaysConfirm && inputProductCodes.some((code) => matchProductCodes.includes(code));
      const strictExact = !alwaysConfirm && (
        productCodeExact ||
        strictProductNameMatches(inputName, resolvedProductName, company)
          || strictProductNameMatches(inputName, match.title, company)
      );
      return {
        ...match,
        sourceKind,
        inputName,
        resolvedProductName,
        needsConfirmation: true,
        evidenceLevel: match.evidenceLevel || match.bestSource?.evidenceLevel || 'insurer_official',
        strictExact,
      };
    })
    .sort((left, right) =>
      Number(Boolean(right.strictExact)) - Number(Boolean(left.strictExact)) ||
      Number(right.score || 0) - Number(left.score || 0) ||
      String(left.productName || '').localeCompare(String(right.productName || ''), 'zh-Hans-CN'),
    );
  const exactCount = enriched.filter((match) => match.strictExact).length;
  const status = exactCount === 1 ? 'exact' : enriched.length ? 'candidates' : 'not_found';
  const resolved = enriched.map(({ strictExact, ...match }) => ({
    ...match,
    needsConfirmation: status === 'exact' ? !strictExact : true,
  }));
  return {
    status,
    matches: resolved,
  };
}

export function buildKnowledgeSearchArtifacts({
  policy = {},
  records = [],
  officialDomainProfiles = [],
  maxResults = DEFAULT_MAX_KNOWLEDGE_RESULTS,
  includeExternalReferences = false,
} = {}) {
  const matched = findKnowledgeRecordsForPolicy({
    policy,
    records,
    officialDomainProfiles,
    maxResults,
    includeExternalReferences,
  });
  if (!matched.length) return { context: '', sources: [], records: [] };
  const sources = matched.map((record) => {
    const enriched = withEvidenceVerificationFields({
      ...record,
      sourceKind: sourceKindForKnowledgeRecord(record),
    });
    return {
      title: record.title || record.url,
      url: record.url,
      snippet: record.snippet,
      evidenceLabel: record.evidenceLabel || '本地知识库官方资料',
      evidenceLevel: record.evidenceLevel || 'insurer_official',
      verificationStatus: enriched.verificationStatus,
      verificationLabel: enriched.verificationLabel,
      referenceOnly: enriched.referenceOnly,
      official: !isExternalReferenceSourceKind(sourceKindForKnowledgeRecord(record)) && record.official !== false,
      sourceType: record.sourceType,
      sourceKind: sourceKindForKnowledgeRecord(record),
    };
  });
  const context = matched
    .map((record, index) =>
      [
        `【资料${index + 1}】${record.title || record.url}`,
        `证据等级：${record.evidenceLabel || '本地知识库官方资料'}`,
        `核实状态：${record.verificationLabel || evidenceVerificationFields(record).verificationLabel}`,
        record.referenceOnly ? '用途限制：仅作待核实参考，不得当作已确认保险责任' : '',
        record.snippet ? `摘要：${record.snippet}` : '',
        record.pageText ? `正文：${record.pageText}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  return { context, sources, records: matched };
}

export async function crawlOfficialKnowledge({ policy = {}, officialDomainProfiles = [], fetchImpl = fetch, timeoutMs = 25_000 } = {}) {
  const normalizedPolicy = {
    company: trimString(policy.company),
    name: trimString(policy.name || policy.productName),
  };
  if (!normalizedPolicy.company || !normalizedPolicy.name) {
    const error = new Error('请填写保险公司和产品名称');
    error.code = 'KNOWLEDGE_CRAWL_POLICY_REQUIRED';
    error.status = 400;
    throw error;
  }
  const scraplingRecords = await runScraplingPolicyCrawler({
    policy: normalizedPolicy,
    officialDomainProfiles,
    timeoutMs: Math.max(timeoutMs, 45_000),
  });
  if (scraplingRecords.length) return scraplingRecords;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const parsers = [
      () => parseNewChinaKnowledge({ policy: normalizedPolicy, officialDomainProfiles, fetchImpl, signal: controller.signal }),
      () => parseGenericOfficialKnowledge({ policy: normalizedPolicy, officialDomainProfiles, fetchImpl, signal: controller.signal }),
    ];
    const recordsByUrl = new Map();
    for (const parser of parsers) {
      const records = await parser();
      for (const record of records) {
        if (record.url && !recordsByUrl.has(record.url)) recordsByUrl.set(record.url, record);
      }
    }
    return [...recordsByUrl.values()].filter((record) => record.official);
  } finally {
    clearTimeout(timeoutId);
  }
}
