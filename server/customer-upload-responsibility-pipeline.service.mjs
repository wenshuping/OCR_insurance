import crypto from 'node:crypto';

import { callDeepSeekForCustomerResponsibilitySummary } from './product-customer-responsibility-summary.service.mjs';

const PIPELINE_VERSION = 'customer_ocr_responsibility_v1';
const MAX_MODEL_ATTEMPTS = 3;
const MAX_OCR_PAGE_CHARS = 12_000;

function text(value) {
  return String(value || '').trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function stableId(value, fallback = 'responsibility') {
  const normalized = text(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 80);
  return normalized || fallback;
}

function digest(value) {
  return crypto.createHash('sha1').update(text(value)).digest('hex').slice(0, 16);
}

function normalizedPage(rawPage = {}, index = 0) {
  return {
    pageNumber: Number(rawPage.pageNumber || index + 1) || index + 1,
    name: text(rawPage.name) || `第${index + 1}张`,
    ocrText: text(rawPage.ocrText).slice(0, MAX_OCR_PAGE_CHARS),
  };
}

function sourcePageOf(raw = {}, fallback = '') {
  return text(raw.sourcePage || raw.pageNumber || fallback);
}

function normalizedIndicator(raw = {}, responsibility = {}, index = 0) {
  const fallbackExcerpt = text(responsibility.sourceExcerpt);
  return {
    indicatorName: text(raw.indicatorName || raw.name) || `${responsibility.liability}量化指标`,
    formulaText: text(raw.formulaText || raw.formula),
    normalizedFormula: text(raw.normalizedFormula),
    basisKey: text(raw.basisKey) || 'not_identified',
    calculationKey: text(raw.calculationKey),
    calculationStatus: ['calculable', 'display_only', 'needs_table', 'needs_claim_facts', 'not_quantitative'].includes(text(raw.calculationStatus))
      ? text(raw.calculationStatus)
      : (text(raw.formulaText || raw.formula) ? 'display_only' : 'not_quantitative'),
    calculationReason: text(raw.calculationReason),
    requiredInputs: list(raw.requiredInputs).map(text).filter(Boolean),
    sourcePage: sourcePageOf(raw, responsibility.sourcePage),
    sourceExcerpt: text(raw.sourceExcerpt) || fallbackExcerpt,
    branches: list(raw.branches),
    _order: index,
  };
}

function normalizedResponsibility(raw = {}, index = 0) {
  const liability = text(raw.liability || raw.title || raw.card?.title);
  const responsibilityId = stableId(raw.responsibilityId || liability, `responsibility_${index + 1}`);
  const normalized = {
    responsibilityId,
    liability,
    groupId: text(raw.groupId) || null,
    responsibilityKind: text(raw.responsibilityKind) || 'benefit',
    coverageAggregation: text(raw.coverageAggregation) || 'include',
    selectionStatus: ['included', 'not_included', 'unknown'].includes(text(raw.selectionStatus))
      ? text(raw.selectionStatus)
      : 'unknown',
    triggerCondition: text(raw.triggerCondition),
    insurerObligation: text(raw.insurerObligation || raw.howItPays),
    importantLimits: list(raw.importantLimits).map(text).filter(Boolean),
    sourcePage: sourcePageOf(raw),
    sourceExcerpt: text(raw.sourceExcerpt),
    card: {
      title: text(raw.card?.title) || liability,
      customerSummary: text(raw.card?.customerSummary || raw.customerSummary),
      benefitExplanation: text(raw.card?.benefitExplanation || raw.benefitExplanation || raw.insurerObligation),
    },
    indicators: [],
  };
  const rawIndicators = list(raw.indicators).length ? raw.indicators : (raw.indicator ? [raw.indicator] : []);
  normalized.indicators = rawIndicators.map((indicator, indicatorIndex) => normalizedIndicator(indicator, normalized, indicatorIndex));
  if (!normalized.indicators.length) normalized.indicators = [normalizedIndicator({}, normalized, 0)];
  return normalized;
}

function normalizeArtifact(rawArtifact = {}, { company, productName, pages }) {
  const candidate = rawArtifact?.artifact && typeof rawArtifact.artifact === 'object' ? rawArtifact.artifact : rawArtifact;
  const responsibilities = list(candidate?.responsibilities).map(normalizedResponsibility);
  const seen = new Map();
  for (const responsibility of responsibilities) {
    const count = seen.get(responsibility.responsibilityId) || 0;
    seen.set(responsibility.responsibilityId, count + 1);
    if (count) responsibility.responsibilityId = `${responsibility.responsibilityId}_${count + 1}`;
    for (const indicator of responsibility.indicators) delete indicator._order;
  }
  return {
    schemaVersion: '1.0',
    pipelineVersion: PIPELINE_VERSION,
    sourceMode: 'customer_ocr_upload',
    company: text(candidate?.company) || text(company),
    productName: text(candidate?.productName) || text(productName),
    productOverview: {
      productType: text(candidate?.productOverview?.productType),
      primaryPurpose: text(candidate?.productOverview?.primaryPurpose),
      mainFunctions: list(candidate?.productOverview?.mainFunctions).map(text).filter(Boolean),
      importantLimits: list(candidate?.productOverview?.importantLimits).map(text).filter(Boolean),
    },
    optionalGroups: list(candidate?.optionalGroups).map((group, index) => ({
      groupId: stableId(group?.groupId || group?.title, `optional_group_${index + 1}`),
      title: text(group?.title),
      selectionStatus: ['included', 'not_included', 'unknown'].includes(text(group?.selectionStatus))
        ? text(group.selectionStatus)
        : 'unknown',
      responsibilityIds: list(group?.responsibilityIds).map((item) => stableId(item)).filter(Boolean),
      sourcePage: sourcePageOf(group),
      sourceExcerpt: text(group?.sourceExcerpt),
    })),
    responsibilities,
    evidencePages: pages.map(({ pageNumber, name }) => ({ pageNumber, name })),
  };
}

function normalizeToFixedPoint(rawArtifact, context) {
  let current = rawArtifact;
  let serialized = '';
  let passes = 0;
  for (let index = 0; index < 3; index += 1) {
    const next = normalizeArtifact(current, context);
    const nextSerialized = JSON.stringify(next);
    passes += 1;
    current = next;
    if (nextSerialized === serialized) break;
    serialized = nextSerialized;
  }
  return { artifact: current, normalizationPasses: passes };
}

function excerptExists(pages, sourcePage, excerpt) {
  const target = compact(excerpt);
  if (!target) return false;
  const pageNumber = Number(sourcePage || 0);
  const candidates = pageNumber
    ? pages.filter((page) => Number(page.pageNumber) === pageNumber)
    : pages;
  return candidates.some((page) => compact(page.ocrText).includes(target));
}

export function validateCustomerUploadResponsibilityArtifact(artifact = {}, pages = []) {
  const issues = [];
  const responsibilities = list(artifact.responsibilities);
  if (!text(artifact.company)) issues.push('company_required');
  if (!text(artifact.productName)) issues.push('product_name_required');
  if (!responsibilities.length) issues.push('responsibility_required');
  const ids = new Set();
  for (const responsibility of responsibilities) {
    const id = text(responsibility.responsibilityId);
    if (!id) issues.push('responsibility_id_required');
    else if (ids.has(id)) issues.push(`responsibility_id_duplicate:${id}`);
    ids.add(id);
    if (!text(responsibility.liability)) issues.push(`liability_required:${id}`);
    if (!text(responsibility.triggerCondition)) issues.push(`trigger_required:${id}`);
    if (!text(responsibility.insurerObligation)) issues.push(`obligation_required:${id}`);
    if (!text(responsibility.card?.title) || !text(responsibility.card?.customerSummary)) issues.push(`card_incomplete:${id}`);
    if (!excerptExists(pages, responsibility.sourcePage, responsibility.sourceExcerpt)) issues.push(`responsibility_evidence_not_exact:${id}`);
    if (!list(responsibility.indicators).length) issues.push(`indicator_decision_required:${id}`);
    for (const indicator of list(responsibility.indicators)) {
      if (!text(indicator.indicatorName)) issues.push(`indicator_name_required:${id}`);
      if (!excerptExists(pages, indicator.sourcePage, indicator.sourceExcerpt)) issues.push(`indicator_evidence_not_exact:${id}:${text(indicator.indicatorName)}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function buildPrompt({ company, productName, pages, previousIssues = [] }) {
  return [
    '你是保险合同责任结构化助手。输入是客户上传图片经 OCR 得到的逐页文本，不是官方条款。只输出合法 JSON。',
    '必须严格使用 OCR_PAGES 中出现的事实；不得凭产品名、常识或模型记忆补充。',
    '每个独立命名且有独立给付义务的责任单独一项。基本责任、可选责任套餐是分组，不是责任卡。',
    '每个责任必须含一张 card，并对指标作出明确决定；有保额、保费、比例、金额、年龄、日期、次数、免赔额、限额或表格就保留公式，无法算出金额也用 display_only/needs_table/needs_claim_facts 展示。',
    'sourceExcerpt 必须逐字复制自对应 OCR 页，不能改写、拼接、使用省略号。sourcePage 填页码数字。',
    '客户保单是否选择可选责任不能从产品责任页推断；没有明确投保选择证据时 selectionStatus 必须为 unknown。',
    'JSON 结构：',
    JSON.stringify({
      company: '', productName: '', productOverview: { productType: '', primaryPurpose: '', mainFunctions: [], importantLimits: [] },
      optionalGroups: [{ groupId: '', title: '', selectionStatus: 'unknown', responsibilityIds: [], sourcePage: '1', sourceExcerpt: '' }],
      responsibilities: [{
        responsibilityId: '', liability: '', groupId: null, responsibilityKind: 'benefit|waiver|waiting_period_refund', coverageAggregation: 'include|exclude', selectionStatus: 'included|not_included|unknown',
        triggerCondition: '', insurerObligation: '', importantLimits: [], sourcePage: '1', sourceExcerpt: '',
        card: { title: '', customerSummary: '', benefitExplanation: '' },
        indicators: [{ indicatorName: '', formulaText: '', normalizedFormula: '', basisKey: '', calculationKey: '', calculationStatus: 'calculable|display_only|needs_table|needs_claim_facts|not_quantitative', calculationReason: '', requiredInputs: [], sourcePage: '1', sourceExcerpt: '', branches: [] }],
      }],
    }),
    previousIssues.length ? `上一次确定性校验错误（必须逐项修复，不能删除真实责任来规避）：${JSON.stringify(previousIssues)}` : '',
    `产品输入：${JSON.stringify({ company, productName })}`,
    `OCR_PAGES：${JSON.stringify(pages)}`,
  ].filter(Boolean).join('\n');
}

export async function parseCustomerUploadResponsibilityArtifact({
  company = '',
  productName = '',
  ocrPages = [],
  generateWithDeepSeek = callDeepSeekForCustomerResponsibilitySummary,
  maxAttempts = MAX_MODEL_ATTEMPTS,
} = {}) {
  const pages = list(ocrPages).map(normalizedPage).filter((page) => page.ocrText);
  if (!text(company) || !text(productName) || !pages.length) {
    return { status: 'manual_review', pipelineVersion: PIPELINE_VERSION, attempts: 0, normalizationPasses: 0, validationIssues: ['pipeline_input_incomplete'], artifact: null };
  }
  let previousIssues = [];
  let lastArtifact = null;
  let normalizationPasses = 0;
  const attempts = Math.max(1, Math.min(MAX_MODEL_ATTEMPTS, Number(maxAttempts || MAX_MODEL_ATTEMPTS)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let rawArtifact;
    try {
      rawArtifact = await generateWithDeepSeek({
        prompt: buildPrompt({ company, productName, pages, previousIssues }),
        company,
        productName,
      });
    } catch (error) {
      previousIssues = [`model_error:${text(error?.code || error?.message) || 'unknown'}`];
      continue;
    }
    const normalized = normalizeToFixedPoint(rawArtifact || {}, { company, productName, pages });
    lastArtifact = normalized.artifact;
    normalizationPasses = normalized.normalizationPasses;
    const validation = validateCustomerUploadResponsibilityArtifact(lastArtifact, pages);
    if (validation.ok) {
      return {
        status: 'pending_review',
        pipelineVersion: PIPELINE_VERSION,
        attempts: attempt,
        normalizationPasses,
        validationIssues: [],
        artifact: lastArtifact,
      };
    }
    previousIssues = validation.issues;
  }
  return {
    status: 'manual_review',
    pipelineVersion: PIPELINE_VERSION,
    attempts,
    normalizationPasses,
    validationIssues: previousIssues,
    artifact: lastArtifact,
  };
}

function coverageTypeFor(responsibility = {}) {
  const value = `${text(responsibility.liability)} ${text(responsibility.responsibilityKind)}`;
  if (/医疗|住院|门诊|费用/u.test(value)) return '医疗保障';
  if (/重大疾病|中度疾病|轻度疾病|癌/u.test(value)) return '疾病保障';
  if (/意外/u.test(value)) return '意外保障';
  if (/身故|全残|寿险/u.test(value)) return '身故及全残保障';
  if (/年金|生存|满期|教育|婚嫁|养老/u.test(value)) return '生存及年金保障';
  if (/豁免/u.test(value)) return '保费豁免';
  return '其他保障';
}

export function buildPublishedCustomerUploadResponsibilityRows(record = {}, reviewedAt = new Date().toISOString()) {
  const artifact = record.responsibilityArtifact;
  if (!artifact || text(record.responsibilityPipelineStatus) !== 'pending_review') return null;
  const company = text(record.company || artifact.company);
  const productName = text(record.productName || artifact.productName);
  const recordKey = text(record.id) || digest(`${company}\u001f${productName}\u001f${record.url}`);
  const productKey = `company_product:${company}:${productName}`;
  const sourceUrl = text(record.url);
  const responsibilityCards = [];
  const indicatorRecords = [];
  for (const responsibility of list(artifact.responsibilities)) {
    const responsibilityId = stableId(responsibility.responsibilityId || responsibility.liability);
    const baseId = `customer_upload:${recordKey}:${responsibilityId}`;
    const category = coverageTypeFor(responsibility);
    const firstIndicator = list(responsibility.indicators)[0] || {};
    responsibilityCards.push({
      id: `${baseId}:card`,
      productKey,
      company,
      productName,
      title: text(responsibility.card?.title || responsibility.liability),
      category,
      cashflowTreatment: text(responsibility.responsibilityKind) === 'waiver' ? 'waiver_only' : 'claim_contingent',
      calculationStatus: text(firstIndicator.calculationStatus) || 'not_quantitative',
      calculationReason: text(firstIndicator.calculationReason),
      responsibilityScope: text(responsibility.responsibilityKind) || 'benefit',
      selectionStatus: text(responsibility.selectionStatus) || 'unknown',
      sourceUrl,
      generatedAt: reviewedAt,
      updatedAt: reviewedAt,
      payload: {
        ...responsibility.card,
        id: `${baseId}:card`,
        responsibilityId,
        productKey,
        company,
        productName,
        title: text(responsibility.card?.title || responsibility.liability),
        category,
        triggerCondition: text(responsibility.triggerCondition),
        insurerObligation: text(responsibility.insurerObligation),
        sourcePage: text(responsibility.sourcePage),
        sourceExcerpt: text(responsibility.sourceExcerpt),
        sourceUrl,
        sourceKind: 'customer_policy_terms',
        evidenceLevel: 'customer_policy_terms',
        evidenceLabel: '客户上传保险责任（运营审核通过）',
        official: false,
        reviewedCustomerUpload: true,
        knowledgeRecordId: Number(record.id || 0) || 0,
      },
    });
    for (const [indicatorIndex, indicator] of list(responsibility.indicators).entries()) {
      const id = `${baseId}:indicator:${indicatorIndex + 1}`;
      indicatorRecords.push({
        id,
        company,
        productName,
        coverageType: category,
        liability: text(responsibility.liability),
        responsibilityId,
        indicatorName: text(indicator.indicatorName),
        formulaText: text(indicator.formulaText),
        normalizedFormula: text(indicator.normalizedFormula),
        basisKey: text(indicator.basisKey),
        calculationKey: text(indicator.calculationKey),
        calculationStatus: text(indicator.calculationStatus),
        calculationReason: text(indicator.calculationReason),
        requiredInputs: list(indicator.requiredInputs),
        sourcePage: text(indicator.sourcePage),
        sourceExcerpt: text(indicator.sourceExcerpt),
        sourceUrl,
        sourceKind: 'customer_policy_terms',
        evidenceLevel: 'customer_policy_terms',
        evidenceLabel: '客户上传保险责任（运营审核通过）',
        official: false,
        reviewedCustomerUpload: true,
        knowledgeRecordId: Number(record.id || 0) || 0,
        selectionStatus: text(responsibility.selectionStatus) || 'unknown',
      });
    }
  }
  return {
    responsibilityCards,
    indicatorRecords,
    responsibilityCardIds: responsibilityCards.map((row) => row.id),
    indicatorRecordIds: indicatorRecords.map((row) => row.id),
  };
}

export { PIPELINE_VERSION as CUSTOMER_UPLOAD_RESPONSIBILITY_PIPELINE_VERSION };
