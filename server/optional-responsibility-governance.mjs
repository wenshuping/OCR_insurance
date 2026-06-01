import crypto from 'node:crypto';
import {
  canonicalProductIdForRecord,
  canonicalProductIdFromOfficialProduct,
} from './canonical-product-id.mjs';

export const RESPONSIBILITY_SELECTION_STATUSES = new Set(['selected', 'not_selected', 'unknown']);
export const QUANTIFICATION_STATUSES = new Set(['quantified', 'pending_review', 'not_quantifiable']);

const OPTIONAL_WORDING_PATTERN =
  /可选(?:保险)?责任|可选部分|可选保障|可选择的保险责任项目|必选部分和可选部分|基本部分和可选部分|基本(?:保险)?责任和可选(?:保险)?责任|可由.{0,30}决定是否投保|可选择投保/u;
const OPTIONAL_NEGATIVE_PATTERN =
  /不含可选(?:保险)?责任|未选择投保可选(?:保险)?责任|未投保可选(?:保险)?责任|不投保可选(?:保险)?责任|不包含.{0,30}可选(?:保险)?责任/u;
const SECTION_PREFIX_PATTERN = String.raw`(?:^|[。；;:：]\s*|(?:\d+[.．、]\s*)+|第\s*[一二三四五六七八九十\d]+\s*条\s*)`;
const OPTIONAL_SECTION_PATTERN = new RegExp(`${SECTION_PREFIX_PATTERN}可选(?:保险)?责任\\s*([一二三四五六七八九十\\d]*)`, 'gu');
const OPTIONAL_SECTION_BOUNDARY_PATTERN = new RegExp(
  `${SECTION_PREFIX_PATTERN}(?:可选(?:保险)?责任\\s*[一二三四五六七八九十\\d]*|基本(?:保险)?责任|责任免除|释义)`,
  'u',
);

export function normalizeLookupText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
}

export function normalizeSelectionStatus(value, fallback = 'unknown') {
  const status = String(value || '').trim();
  return RESPONSIBILITY_SELECTION_STATUSES.has(status) ? status : fallback;
}

export function normalizeQuantificationStatus(value, fallback = 'pending_review') {
  const status = String(value || '').trim();
  return QUANTIFICATION_STATUSES.has(status) ? status : fallback;
}

export function buildOptionalResponsibilityId({ company = '', productName = '', canonicalProductId = '', liability = '', coverageType = '' } = {}) {
  const idSeed = canonicalProductId
    ? ['canonical-product', canonicalProductId, liability || coverageType]
    : [company, productName, liability || coverageType];
  const digest = crypto
    .createHash('sha1')
    .update(idSeed.map(normalizeLookupText).join('\u001f'))
    .digest('hex')
    .slice(0, 16);
  return `opt_${digest}`;
}

function parsePayload(record = {}) {
  if (record?.payload && typeof record.payload === 'object') return record.payload;
  if (typeof record?.payload !== 'string') return {};
  try {
    const parsed = JSON.parse(record.payload);
    return parsed && typeof parsed === 'object' ? parsed : { pageText: record.payload };
  } catch {
    return { pageText: record.payload };
  }
}

function knowledgeText(record = {}) {
  const payload = parsePayload(record);
  const pageTexts = Array.isArray(payload.pages)
    ? payload.pages.map((page) => [page?.pageText, page?.text, page?.content].filter(Boolean).join('\n'))
    : [];
  return [
    record.pageText,
    record.text,
    record.content,
    record.body,
    record.snippet,
    payload.pageText,
    payload.text,
    payload.content,
    payload.body,
    payload.snippet,
    ...pageTexts,
  ].map((item) => String(item || '').trim()).filter(Boolean).join('\n');
}

function productNames(record = {}) {
  const payload = parsePayload(record);
  return [record.productName, record.name, record.title, payload.productName, payload.name, payload.title]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function knowledgeSourceFields(record = {}) {
  const payload = parsePayload(record);
  return {
    sourceRecordId: String(record.id || payload.id || '').trim(),
    sourceUrl: String(record.url || payload.url || '').trim(),
    sourceTitle: String(record.title || payload.title || record.productName || payload.productName || '').trim(),
  };
}

function policyProductNames(policy = {}) {
  return [
    policy.name,
    policy.productName,
    ...(Array.isArray(policy.plans)
      ? policy.plans.map((plan) => plan?.matchedProductName || plan?.productName || plan?.name)
      : []),
  ].map((item) => String(item || '').trim()).filter(Boolean);
}

function explicitCanonicalProductId(record = {}) {
  return String(record?.canonicalProductId || '').trim();
}

function policyCanonicalProductIds(policy = {}) {
  const ids = [];
  const add = (canonicalProductId) => {
    const id = String(canonicalProductId || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(policy.canonicalProductId);
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    add(plan?.canonicalProductId);
    const matchedProductName = String(plan?.matchedProductName || '').trim();
    if (matchedProductName) {
      add(canonicalProductIdFromOfficialProduct({
        company: plan?.company || policy.company,
        productName: matchedProductName,
      }));
    }
  }
  return ids;
}

function recordMatchesPolicy(record = {}, policy = {}) {
  const canonicalIds = new Set(policyCanonicalProductIds(policy));
  const recordCanonicalProductId = explicitCanonicalProductId(record);
  if (canonicalIds.size && recordCanonicalProductId) return canonicalIds.has(recordCanonicalProductId);
  const payload = parsePayload(record);
  const company = normalizeLookupText(record.company || payload.company || policy.company);
  const policyCompany = normalizeLookupText(policy.company);
  if (policyCompany && company && company !== policyCompany) return false;
  const policyNames = new Set(policyProductNames(policy).map(normalizeLookupText));
  return productNames(record).some((name) => policyNames.has(normalizeLookupText(name)));
}

function excerptAround(text, index, length = 900) {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  return normalized.slice(Math.max(0, Number(index || 0) - 24), Math.max(0, Number(index || 0) - 24) + length).trim();
}

function sectionExcerpt(text, match) {
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  const markerOffset = String(match?.[0] || '').search(/可选/u);
  const start = Number(match?.index || 0) + Math.max(0, markerOffset);
  const rest = source.slice(start + Math.max(1, String(match?.[0] || '').length - Math.max(0, markerOffset)));
  const next = rest.search(OPTIONAL_SECTION_BOUNDARY_PATTERN);
  if (next > 40) {
    return source.slice(start, start + String(match?.[0] || '').length - Math.max(0, markerOffset) + next).trim();
  }
  return source.slice(start, start + 6000).trim();
}

function extractOptionalSections(text = '') {
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!OPTIONAL_WORDING_PATTERN.test(source)) return [];
  const matches = [...source.matchAll(OPTIONAL_SECTION_PATTERN)]
    .map((match) => {
      const suffix = String(match[1] || '').trim();
      return {
        liability: `可选责任${suffix}`,
        sourceExcerpt: sectionExcerpt(source, match),
      };
    })
    .filter((section, index, list) => list.findIndex((item) => item.liability === section.liability) === index);
  const specific = matches.filter((section) => section.liability !== '可选责任');
  if (!specific.length && OPTIONAL_NEGATIVE_PATTERN.test(source)) return [];
  return specific.length ? specific : matches.slice(0, 1);
}

function responsibilityKey(record = {}) {
  return [
    explicitCanonicalProductId(record),
    record.company,
    record.productName,
    record.liability || record.title || record.coverageType,
  ].map(normalizeLookupText).join('\u001f');
}

function indicatorLinkedTo(record, indicator = {}) {
  const company = normalizeLookupText(record.company);
  const indicatorCompany = normalizeLookupText(indicator.company);
  if (company && indicatorCompany && company !== indicatorCompany) return false;
  const recordCanonicalProductId = explicitCanonicalProductId(record);
  const indicatorCanonicalProductId = explicitCanonicalProductId(indicator);
  if (recordCanonicalProductId && indicatorCanonicalProductId) {
    if (recordCanonicalProductId !== indicatorCanonicalProductId) return false;
  }
  const productName = normalizeLookupText(record.productName);
  const indicatorProductName = normalizeLookupText(indicator.productName);
  if (productName && indicatorProductName && productName !== indicatorProductName) return false;
  const indicatorOptionalResponsibilityId = String(indicator?.optionalResponsibilityId || '').trim();
  if (indicatorOptionalResponsibilityId) return indicatorOptionalResponsibilityId === String(record.id || '').trim();
  const text = normalizeLookupText([indicator.coverageType, indicator.liability, indicator.sourceExcerpt].join(' '));
  const liability = normalizeLookupText(record.liability);
  return liability.length >= 2 && text.includes(liability);
}

function indicatorIsQuantified(indicator = {}) {
  if (normalizeQuantificationStatus(indicator.quantificationStatus, '') === 'quantified') return true;
  if (indicator.value !== undefined && indicator.value !== null && String(indicator.unit || indicator.formulaText || '').trim()) return true;
  if (String(indicator.formulaText || '').trim() && !/按条款|以条款/u.test(String(indicator.formulaText || ''))) return true;
  return false;
}

function inferSelectionStatus(policy = {}, liability = '') {
  const text = normalizeLookupText([policy.ocrText, policy.report].join(' '));
  const suffix = normalizeLookupText(liability).replace(/^可选(?:保险)?责任/u, '');
  if (suffix && /(?:包含|含)基本(?:保险)?责任和可选(?:保险)?责任/u.test(text)) {
    return text.includes(`可选责任${suffix}`) || text.includes(`可选保险责任${suffix}`) ? 'selected' : 'not_selected';
  }
  if (suffix && new RegExp(`不含.{0,16}可选(?:保险)?责任${suffix}`, 'u').test(text)) return 'not_selected';
  if (suffix && new RegExp(`(?:包含|含|投保|选择投保).{0,16}可选(?:保险)?责任${suffix}`, 'u').test(text)) return 'selected';
  if (/不含可选(?:保险)?责任|未选择投保可选(?:保险)?责任|未投保可选(?:保险)?责任|不投保可选(?:保险)?责任/u.test(text)) return 'not_selected';
  if (/含可选(?:保险)?责任|包含.{0,30}可选(?:保险)?责任|选择投保可选(?:保险)?责任|已投保可选(?:保险)?责任|投保可选(?:保险)?责任/u.test(text)) return 'selected';
  return 'unknown';
}

export function normalizeOptionalResponsibilityRecord(record = {}) {
  const company = String(record.company || '').trim();
  const productName = String(record.productName || '').trim();
  const canonicalProductId = canonicalProductIdForRecord(record);
  const explicitIdCanonicalProductId = explicitCanonicalProductId(record);
  const liability = String(record.liability || record.title || record.coverageType || '可选责任').trim();
  const indicatorIds = (Array.isArray(record.indicatorIds) ? record.indicatorIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const id = String(record.id || '').trim() || buildOptionalResponsibilityId({
    company,
    productName,
    canonicalProductId: explicitIdCanonicalProductId,
    liability,
  });
  return {
    id,
    company,
    productName,
    ...(canonicalProductId ? { canonicalProductId } : {}),
    coverageType: String(record.coverageType || '可选责任').trim() || '可选责任',
    liability,
    title: String(record.title || liability).trim(),
    responsibilityScope: 'optional',
    selectionStatus: normalizeSelectionStatus(record.selectionStatus),
    selectionEvidence: String(record.selectionEvidence || 'official_terms').trim() || 'official_terms',
    quantificationStatus: normalizeQuantificationStatus(
      record.quantificationStatus,
      indicatorIds.length ? 'quantified' : 'pending_review',
    ),
    quantificationReason: String(record.quantificationReason || '').trim(),
    indicatorIds,
    sourceExcerpt: String(record.sourceExcerpt || '').trim().slice(0, 4000),
    sourceRecordId: String(record.sourceRecordId || '').trim(),
    sourceUrl: String(record.sourceUrl || '').trim(),
    sourceTitle: String(record.sourceTitle || '').trim(),
  };
}

export function buildOptionalResponsibilityRecords({ policy = {}, knowledgeRecords = [], indicators = [], existingRecords = [] } = {}) {
  const existingById = new Map();
  const existingByKey = new Map();
  for (const row of Array.isArray(existingRecords) ? existingRecords : []) {
    const normalized = normalizeOptionalResponsibilityRecord(row);
    existingById.set(normalized.id, normalized);
    existingByKey.set(responsibilityKey(normalized), normalized);
  }

  const candidates = [];
  for (const knowledgeRecord of Array.isArray(knowledgeRecords) ? knowledgeRecords : []) {
    if (!recordMatchesPolicy(knowledgeRecord, policy)) continue;
    for (const section of extractOptionalSections(knowledgeText(knowledgeRecord))) {
      const base = normalizeOptionalResponsibilityRecord({
        company: policy.company || knowledgeRecord.company,
        productName: policy.name || productNames(knowledgeRecord)[0],
        canonicalProductId: explicitCanonicalProductId(knowledgeRecord) || explicitCanonicalProductId(policy),
        liability: section.liability,
        sourceExcerpt: section.sourceExcerpt,
        ...knowledgeSourceFields(knowledgeRecord),
        selectionStatus: inferSelectionStatus(policy, section.liability),
        selectionEvidence: 'policy_ocr',
      });
      const linkedIndicators = (Array.isArray(indicators) ? indicators : []).filter((indicator) => indicatorLinkedTo(base, indicator));
      const quantifiedIds = linkedIndicators.filter(indicatorIsQuantified).map((indicator) => String(indicator.id || '').trim()).filter(Boolean);
      const existing = existingById.get(base.id) || existingByKey.get(responsibilityKey(base));
      const status = existing?.quantificationStatus === 'not_quantifiable'
        ? 'not_quantifiable'
        : quantifiedIds.length
          ? 'quantified'
          : 'pending_review';
      candidates.push(normalizeOptionalResponsibilityRecord({
        ...base,
        ...existing,
        selectionStatus: base.selectionStatus,
        selectionEvidence: base.selectionEvidence,
        sourceExcerpt: base.sourceExcerpt || existing?.sourceExcerpt || '',
        sourceRecordId: base.sourceRecordId || existing?.sourceRecordId || '',
        sourceUrl: base.sourceUrl || existing?.sourceUrl || '',
        sourceTitle: base.sourceTitle || existing?.sourceTitle || '',
        indicatorIds: quantifiedIds.length ? quantifiedIds : existing?.indicatorIds || [],
        quantificationStatus: status,
        quantificationReason: status === 'pending_review'
          ? existing?.quantificationReason || '缺少可计算结构化指标'
          : existing?.quantificationReason || '',
      }));
    }
  }
  return candidates.sort((left, right) =>
    String(left.productName || '').localeCompare(String(right.productName || ''), 'zh-CN') ||
    String(left.liability || '').localeCompare(String(right.liability || ''), 'zh-CN')
  );
}

function indicatorIdFor({ company = '', productName = '', liability = '', optionalResponsibilityId = '' } = {}) {
  const digest = crypto
    .createHash('sha1')
    .update(['optional-indicator', company, productName, liability, optionalResponsibilityId].map(normalizeLookupText).join('\u001f'))
    .digest('hex')
    .slice(0, 18);
  return `ind_opt_${digest}`;
}

function splitBenefitClauses(text = '') {
  return String(text || '')
    .replace(/\s+/gu, ' ')
    .split(/(?=（\d+）|第[一二三四五六七八九十\d]+项|[。；;]\s*)/u)
    .map((item) => item.trim())
    .filter((item) => /保险金|豁免|给付|领取/u.test(item));
}

function classifyCoverageType(liability) {
  if (/轻度疾病|中度疾病|重度疾病|重大疾病|特定疾病|豁免/u.test(liability)) return '疾病保障';
  if (/身故|全残/u.test(liability)) return '人寿保障';
  if (/生存|年金|满期|领取/u.test(liability)) return '现金流';
  if (/医疗|住院|津贴/u.test(liability)) return '医疗保障';
  return '保险责任';
}

function extractLiability(clause) {
  const text = String(clause || '').replace(/\s+/gu, ' ').trim();
  const directCandidates = [...text.matchAll(/[一-龥A-Za-z0-9（）()]{2,30}(?:保险金(?!额)|豁免保险费|豁免|年金|津贴)/gu)]
    .map((match) => match[0].trim()
      .replace(/^（\d+）/u, '')
      .replace(/^(?:给付|按|以|向|将按|本公司按|我们按)/u, ''))
    .filter((value) => !/本合同可选责任|我们除按|按本合同|给付条件|保险金金额|领取人|基本保险金$/u.test(value));
  if (directCandidates.length) return directCandidates.at(-1);
  const match = text.match(/(?:（\d+）)?\s*([一-龥A-Za-z0-9（）()]{2,30}?(?:保险金|豁免|年金|津贴|给付))/u);
  return match?.[1] || '';
}

function extractFormula(clause) {
  const text = String(clause || '').normalize('NFKC');
  if (/利益演示|退保金|现金价值/u.test(text)) return null;
  const percent = text.match(/(?:本合同|合同|该被保险人名下的)?(?:的)?(?:基本保险金额|基本保额|保险金额|意外伤害保险金额)(?:的)?\s*(\d+(?:\.\d+)?)\s*%/u);
  if (percent) {
    const basis = percent[0].replace(/(?:的)?\s*\d+(?:\.\d+)?\s*%.*/u, '').trim() || '基本保险金额';
    return {
      value: Number(percent[1]),
      unit: '%',
      basis,
      formulaText: `${basis} × ${percent[1]}%`,
    };
  }
  const multiple = text.match(/(?:本合同|合同|该被保险人名下的)?(?:的)?(?:基本保险金额|基本保额|保险金额|意外伤害保险金额)(?:的)?\s*(\d+(?:\.\d+)?)\s*倍/u);
  if (multiple) {
    const basis = multiple[0].replace(/(?:的)?\s*\d+(?:\.\d+)?\s*倍.*/u, '').trim() || '基本保险金额';
    return {
      value: Number(multiple[1]),
      unit: '倍',
      basis,
      formulaText: `${basis} × ${multiple[1]}`,
    };
  }
  const baseAmount = text.match(/(?:按|以)(?:本合同|合同|该被保险人名下的)?(?:的)?(基本保险金额|基本保额|保险金额|意外伤害保险金额)(?:额外)?给付|给付(?:本合同|合同|该被保险人名下的)?(?:的)?(基本保险金额|基本保额|保险金额|意外伤害保险金额)/u);
  if (baseAmount) {
    const basis = baseAmount[1] || baseAmount[2] || '基本保险金额';
    return {
      value: 100,
      unit: '%',
      basis,
      formulaText: `${basis} × 100%`,
    };
  }
  if (/津贴日额与住院日数相乘|住院日数\s*[×xX*]\s*.*津贴日额|津贴日额\s*[×xX*]\s*.*住院日数/u.test(text)) {
    return {
      value: null,
      unit: '公式',
      basis: '住院津贴日额',
      formulaText: '住院津贴日额 × 住院日数',
    };
  }
  const fixed = text.match(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*元/u);
  if (fixed) {
    return {
      value: Number(fixed[1].replace(/,/gu, '')),
      unit: '元',
      basis: '固定金额',
      formulaText: `${fixed[1]}元`,
    };
  }
  if (/豁免/u.test(text)) {
    return {
      value: null,
      unit: '公式',
      basis: '后续保险费',
      formulaText: '豁免后续应交保险费',
    };
  }
  return null;
}

export function extractOptionalIndicatorsFromSection(section = {}) {
  const optionalResponsibilityId = String(section.id || '').trim() || buildOptionalResponsibilityId(section);
  return splitBenefitClauses(section.sourceExcerpt)
    .map((clause) => {
      const liability = extractLiability(clause);
      const formula = extractFormula(clause);
      if (!liability || !formula) return null;
      return {
        id: indicatorIdFor({ ...section, liability, optionalResponsibilityId }),
        company: String(section.company || '').trim(),
        productName: String(section.productName || '').trim(),
        ...(section.canonicalProductId ? { canonicalProductId: section.canonicalProductId } : {}),
        coverageType: classifyCoverageType(liability),
        liability,
        ...formula,
        condition: '',
        responsibilityScope: 'optional',
        optionalResponsibilityId,
        quantificationStatus: 'quantified',
        sourceExcerpt: clause.slice(0, 500),
        sourceRecordId: String(section.sourceRecordId || '').trim(),
        sourceUrl: String(section.sourceUrl || '').trim(),
        sourceTitle: String(section.sourceTitle || '').trim(),
        sourceEvidenceLevel: section.sourceRecordId || section.sourceUrl ? 'official_terms' : '',
        extractionMethod: 'optional_terms_rule',
        updatedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

export function rebuildOptionalResponsibilityGovernance(state = {}) {
  const groupKey = (company = '', productName = '', canonicalProductId = '') =>
    canonicalProductId
      ? `canonical\u001f${canonicalProductId}`
      : `${normalizeLookupText(company)}\u001f${normalizeLookupText(productName)}`;
  const knowledgeGroups = new Map();
  for (const record of Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : []) {
    const payload = parsePayload(record);
    const company = String(record.company || payload.company || '').trim();
    const name = String(record.productName || record.title || payload.productName || payload.title || productNames(record)[0] || '').trim();
    const canonicalProductId = explicitCanonicalProductId(record) || canonicalProductIdForRecord(record, company);
    const key = groupKey(company, name, explicitCanonicalProductId(record));
    if (!normalizeLookupText(name)) continue;
    const group = knowledgeGroups.get(key) || {
      policy: {
        company,
        name,
        ...(canonicalProductId ? { canonicalProductId } : {}),
      },
      records: [],
    };
    group.records.push(record);
    knowledgeGroups.set(key, group);
  }
  const indicatorGroups = new Map();
  for (const indicator of Array.isArray(state.insuranceIndicatorRecords) ? state.insuranceIndicatorRecords : []) {
    const productName = String(indicator?.productName || '').trim();
    if (!normalizeLookupText(productName)) continue;
    const key = groupKey(indicator?.company, productName, explicitCanonicalProductId(indicator));
    const group = indicatorGroups.get(key) || [];
    group.push(indicator);
    indicatorGroups.set(key, group);
  }
  const optionalRecords = [];
  const optionalIndicators = [];
  const existingOptionalIndicators = (Array.isArray(state.insuranceIndicatorRecords) ? state.insuranceIndicatorRecords : [])
    .filter((indicator) => String(indicator.responsibilityScope || '') === 'optional');
  for (const { policy, records: groupedKnowledgeRecords } of knowledgeGroups.values()) {
    const groupedIndicators = [
      ...(indicatorGroups.get(groupKey(policy.company, policy.name, explicitCanonicalProductId(policy))) || []),
      ...(indicatorGroups.get(groupKey(policy.company, policy.name)) || []),
      ...(indicatorGroups.get(groupKey('', policy.name)) || []),
    ];
    const records = buildOptionalResponsibilityRecords({
      policy,
      knowledgeRecords: groupedKnowledgeRecords,
      indicators: groupedIndicators,
      existingRecords: state.optionalResponsibilityRecords,
    });
    for (const record of records) {
      const derivedIndicators = extractOptionalIndicatorsFromSection(record);
      const retainedIndicators = derivedIndicators.length
        ? []
        : existingOptionalIndicators.filter((indicator) => {
          const id = String(indicator?.id || '').trim();
          return id
            && (String(indicator?.optionalResponsibilityId || '').trim() === record.id
              || (Array.isArray(record.indicatorIds) && record.indicatorIds.includes(id)))
            && indicatorLinkedTo(record, indicator);
        });
      const nextIndicators = derivedIndicators.length ? derivedIndicators : retainedIndicators;
      const indicatorIds = nextIndicators.map((indicator) => indicator.id);
      const quantificationStatus = indicatorIds.length
        ? 'quantified'
        : record.quantificationStatus === 'not_quantifiable'
          ? 'not_quantifiable'
          : 'pending_review';
      const nextRecord = normalizeOptionalResponsibilityRecord({
        ...record,
        indicatorIds,
        quantificationStatus,
        quantificationReason: indicatorIds.length ? '' : record.quantificationReason || '缺少可计算结构化指标',
      });
      optionalRecords.push(nextRecord);
      optionalIndicators.push(...nextIndicators);
    }
  }
  const existingNonOptionalIndicators = (Array.isArray(state.insuranceIndicatorRecords) ? state.insuranceIndicatorRecords : [])
    .filter((indicator) => String(indicator.responsibilityScope || 'basic') !== 'optional');
  const uniqueOptionalRecords = [...new Map(optionalRecords.map((record) => [
    `${record.id}\u001f${explicitCanonicalProductId(record)}`,
    record,
  ])).values()];
  const uniqueIndicators = [...new Map([...existingNonOptionalIndicators, ...optionalIndicators]
    .map((indicator) => [String(indicator.id || ''), indicator]))
    .values()]
    .filter((indicator) => String(indicator.id || '').trim());
  return {
    ...state,
    optionalResponsibilityRecords: uniqueOptionalRecords,
    insuranceIndicatorRecords: uniqueIndicators,
  };
}

export function buildOptionalResponsibilityGaps({ optionalResponsibilityRecords = [], policies = [] } = {}) {
  const recentPolicyCounts = new Map();
  for (const policy of Array.isArray(policies) ? policies : []) {
    for (const item of Array.isArray(policy?.optionalResponsibilities) ? policy.optionalResponsibilities : []) {
      if (normalizeSelectionStatus(item?.selectionStatus) !== 'selected') continue;
      const id = String(item?.id || '').trim();
      if (!id) continue;
      recentPolicyCounts.set(id, (recentPolicyCounts.get(id) || 0) + 1);
    }
  }
  return (Array.isArray(optionalResponsibilityRecords) ? optionalResponsibilityRecords : [])
    .map(normalizeOptionalResponsibilityRecord)
    .filter((record) => normalizeQuantificationStatus(record.quantificationStatus) === 'pending_review')
    .map((record) => ({
      id: record.id,
      company: record.company,
      productName: record.productName,
      liability: record.liability,
      quantificationStatus: record.quantificationStatus,
      quantificationReason: record.quantificationReason || '缺少可计算结构化指标',
      missingFields: record.indicatorIds?.length ? [] : ['indicatorIds'],
      sourceExcerpt: record.sourceExcerpt || '',
      recentPolicyCount: recentPolicyCounts.get(record.id) || 0,
    }))
    .sort((left, right) =>
      right.recentPolicyCount - left.recentPolicyCount ||
      String(left.productName || '').localeCompare(String(right.productName || ''), 'zh-CN')
    );
}

export function isSelectedQuantifiedIndicator(indicator = {}) {
  const scope = String(indicator?.responsibilityScope || 'basic');
  if (scope !== 'optional') return true;
  return normalizeSelectionStatus(indicator.selectionStatus) === 'selected'
    && normalizeQuantificationStatus(indicator.quantificationStatus) === 'quantified';
}
