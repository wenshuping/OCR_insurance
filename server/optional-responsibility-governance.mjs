import crypto from 'node:crypto';

export const RESPONSIBILITY_SELECTION_STATUSES = new Set(['selected', 'not_selected', 'unknown']);
export const QUANTIFICATION_STATUSES = new Set(['quantified', 'pending_review', 'not_quantifiable']);

const OPTIONAL_WORDING_PATTERN =
  /可选(?:保险)?责任|可选部分|可选保障|可选择的保险责任项目|必选部分和可选部分|基本部分和可选部分|基本(?:保险)?责任和可选(?:保险)?责任|可由.{0,30}决定是否投保|可选择投保/u;
const OPTIONAL_NEGATIVE_PATTERN =
  /不含可选(?:保险)?责任|未选择投保可选(?:保险)?责任|未投保可选(?:保险)?责任|不投保可选(?:保险)?责任|不包含.{0,30}可选(?:保险)?责任/u;
const OPTIONAL_SECTION_PATTERN = /(?:^|[。；;:：]\s*|\d+[.．、]\s*)可选(?:保险)?责任\s*([一二三四五六七八九十\d]*)/gu;

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

export function buildOptionalResponsibilityId({ company = '', productName = '', liability = '', coverageType = '' } = {}) {
  const digest = crypto
    .createHash('sha1')
    .update([company, productName, liability || coverageType].map(normalizeLookupText).join('\u001f'))
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

function policyProductNames(policy = {}) {
  return [
    policy.name,
    policy.productName,
    ...(Array.isArray(policy.plans)
      ? policy.plans.map((plan) => plan?.matchedProductName || plan?.productName || plan?.name)
      : []),
  ].map((item) => String(item || '').trim()).filter(Boolean);
}

function recordMatchesPolicy(record = {}, policy = {}) {
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

function extractOptionalSections(text = '') {
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!OPTIONAL_WORDING_PATTERN.test(source) || OPTIONAL_NEGATIVE_PATTERN.test(source)) return [];
  const matches = [...source.matchAll(OPTIONAL_SECTION_PATTERN)]
    .map((match) => {
      const suffix = String(match[1] || '').trim();
      return {
        liability: `可选责任${suffix}`,
        sourceExcerpt: excerptAround(source, match.index),
      };
    })
    .filter((section, index, list) => list.findIndex((item) => item.liability === section.liability) === index);
  const specific = matches.filter((section) => section.liability !== '可选责任');
  return specific.length ? specific : matches.slice(0, 1);
}

function responsibilityKey(record = {}) {
  return [
    record.company,
    record.productName,
    record.liability || record.title || record.coverageType,
  ].map(normalizeLookupText).join('\u001f');
}

function indicatorLinkedTo(record, indicator = {}) {
  if (indicator?.optionalResponsibilityId && indicator.optionalResponsibilityId === record.id) return true;
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
  const liability = String(record.liability || record.title || record.coverageType || '可选责任').trim();
  const indicatorIds = (Array.isArray(record.indicatorIds) ? record.indicatorIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const id = String(record.id || '').trim() || buildOptionalResponsibilityId({ company, productName, liability });
  return {
    id,
    company,
    productName,
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
    sourceExcerpt: String(record.sourceExcerpt || '').trim().slice(0, 900),
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
        liability: section.liability,
        sourceExcerpt: section.sourceExcerpt,
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
  const match = String(clause || '').match(/(?:（\d+）)?\s*([一-龥A-Za-z0-9（）()]{2,30}?(?:保险金|豁免|年金|津贴|给付))/u);
  return match?.[1] || '';
}

function extractFormula(clause) {
  const text = String(clause || '').normalize('NFKC');
  const percent = text.match(/基本保险金额的\s*(\d+(?:\.\d+)?)\s*%/u);
  if (percent) {
    return {
      value: Number(percent[1]),
      unit: '%',
      basis: '基本保险金额',
      formulaText: `基本保额 × ${percent[1]}%`,
    };
  }
  const multiple = text.match(/基本保险金额的\s*(\d+(?:\.\d+)?)\s*倍/u);
  if (multiple) {
    return {
      value: Number(multiple[1]),
      unit: '倍',
      basis: '基本保险金额',
      formulaText: `基本保额 × ${multiple[1]}`,
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
        coverageType: classifyCoverageType(liability),
        liability,
        ...formula,
        condition: '',
        responsibilityScope: 'optional',
        optionalResponsibilityId,
        quantificationStatus: 'quantified',
        sourceExcerpt: clause.slice(0, 500),
        extractionMethod: 'optional_terms_rule',
        updatedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

export function rebuildOptionalResponsibilityGovernance(state = {}) {
  const knowledgeGroups = new Map();
  for (const record of Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : []) {
    const payload = parsePayload(record);
    const company = String(record.company || payload.company || '').trim();
    const name = String(record.productName || record.title || payload.productName || payload.title || productNames(record)[0] || '').trim();
    const key = `${normalizeLookupText(company)}\u001f${normalizeLookupText(name)}`;
    if (!normalizeLookupText(name)) continue;
    const group = knowledgeGroups.get(key) || {
      policy: { company, name },
      records: [],
    };
    group.records.push(record);
    knowledgeGroups.set(key, group);
  }
  const optionalRecords = [];
  const optionalIndicators = [];
  for (const { policy, records: groupedKnowledgeRecords } of knowledgeGroups.values()) {
    const records = buildOptionalResponsibilityRecords({
      policy,
      knowledgeRecords: groupedKnowledgeRecords,
      indicators: state.insuranceIndicatorRecords,
      existingRecords: state.optionalResponsibilityRecords,
    });
    for (const record of records) {
      const derivedIndicators = extractOptionalIndicatorsFromSection(record);
      const nextRecord = normalizeOptionalResponsibilityRecord({
        ...record,
        indicatorIds: derivedIndicators.map((indicator) => indicator.id),
        quantificationStatus: derivedIndicators.length ? 'quantified' : record.quantificationStatus,
        quantificationReason: derivedIndicators.length ? '' : record.quantificationReason,
      });
      optionalRecords.push(nextRecord);
      optionalIndicators.push(...derivedIndicators);
    }
  }
  const existingNonOptionalIndicators = (Array.isArray(state.insuranceIndicatorRecords) ? state.insuranceIndicatorRecords : [])
    .filter((indicator) => String(indicator.responsibilityScope || 'basic') !== 'optional');
  const uniqueOptionalRecords = [...new Map(optionalRecords.map((record) => [record.id, record])).values()];
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
