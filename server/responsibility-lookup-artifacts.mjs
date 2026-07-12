import {
  RESPONSIBILITY_CARD_INDICATOR_CHECK_VERSION,
  indicatorCheckForResponsibilityCard,
} from './responsibility-card-standardizer.mjs';
import {
  JRCPCX_TERMS_EVIDENCE_LABEL,
  JRCPCX_TERMS_EVIDENCE_LEVEL,
  JRCPCX_OFFICIAL_DOMAIN,
  LEGACY_EXTERNAL_REFERENCE_LABEL,
  LEGACY_EXTERNAL_REFERENCE_LEVEL,
} from './policy-knowledge.service.mjs';
import {
  CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL,
  CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_TERMS_SOURCE_KIND,
  evidenceVerificationFields,
  isFormalResponsibilityEvidence,
} from './evidence-classification.service.mjs';
import { buildIndicatorFromResponsibilityCard } from '../scripts/backfill-basic-indicators-from-responsibility-cards.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function isStructuredCalculationIndicator(indicator = {}) {
  if (!indicator || typeof indicator !== 'object') return false;
  const calculationKey = text(indicator.calculationKey);
  const basisKey = text(indicator.basisKey);
  if (!calculationKey || ['unknown', 'not_calculable'].includes(calculationKey)) return false;
  if (basisKey === 'rule_parameter') return false;
  return true;
}

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function truncate(value, max) {
  const resolved = text(value);
  return resolved.length > max ? resolved.slice(0, max) : resolved;
}

function sourceLooksLikeJrcpcx(source = {}) {
  const target = [
    source.url,
    source.sourceUrl,
    source.detailUrl,
    source.clauseUrl,
    source.evidenceLevel,
    source.sourceKind,
  ].map(text).join(' ');
  return /(?:jrcpcx\.cn|inspdinfo\.iachina\.cn|iachina\.cn|regulatory_industry_terms)/iu.test(target);
}

function sourceKindForSource(source = {}) {
  if (text(source.sourceKind) === 'jrcpcx' || sourceLooksLikeJrcpcx(source)) return 'jrcpcx';
  if (text(source.sourceKind) === CUSTOMER_POLICY_TERMS_SOURCE_KIND || text(source.evidenceLevel) === CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL) return CUSTOMER_POLICY_TERMS_SOURCE_KIND;
  if (['legacy_external_reference', 'open_web_reference'].includes(text(source.sourceKind))) return text(source.sourceKind);
  if (text(source.evidenceLevel) === LEGACY_EXTERNAL_REFERENCE_LEVEL) return 'open_web_reference';
  return 'insurer_official';
}

export function productResponsibilityKey(company, productName) {
  const resolvedCompany = text(company);
  const resolvedProductName = text(productName);
  if (!resolvedCompany || !resolvedProductName) return '';
  return `company_product:${resolvedCompany}:${resolvedProductName}`;
}

export function knowledgeRecordsFromResponsibilityAnalysis({ analysis = {}, policy = {} } = {}) {
  const company = text(policy.company);
  const productName = text(policy.name || policy.productName);
  if (!company || !productName) return [];
  const sources = Array.isArray(analysis.sources) ? analysis.sources : [];
  const rows = Array.isArray(analysis.coverageTable) ? analysis.coverageTable : [];
  const responsibilityText = rows
    .map((row) => [row.coverageType, row.scenario, row.payout, row.note].map(text).filter(Boolean).join('：'))
    .filter(Boolean)
    .join('\n');
  return sources
    .map((source) => {
      const url = text(source.url);
      if (!url) return null;
      const sourceKind = sourceKindForSource(source);
      const jrcpcx = sourceKind === 'jrcpcx';
      const customerPolicyTerms = sourceKind === CUSTOMER_POLICY_TERMS_SOURCE_KIND;
      const externalReference = sourceKind === 'legacy_external_reference' || sourceKind === 'open_web_reference';
      const snippet = text(source.snippet);
      const pageText = truncate([snippet, responsibilityText].map(text).filter(Boolean).join('\n'), 12000);
      const official = customerPolicyTerms ? true : (externalReference ? false : source.official !== false);
      const exposesFormalResponsibilityText = Boolean(
        pageText
          && responsibilityText
          && (customerPolicyTerms || jrcpcx || (!externalReference && official)),
      );
      const record = {
        company,
        productName,
        title: text(source.title) || productName,
        url,
        snippet: snippet || truncate(responsibilityText, 500),
        pageText,
        ...(exposesFormalResponsibilityText ? {
          responsibilityText: pageText,
          qualityStatus: 'valid_responsibility_refilled',
          qualityReason: 'responsibility_query 已抽取保险责任正文段',
        } : {}),
        sourceType: text(source.sourceType) || (customerPolicyTerms ? 'customer_policy_terms' : ''),
        materialType: text(source.materialType) || (externalReference ? 'external_reference' : customerPolicyTerms ? 'policy_terms' : 'terms'),
        official,
        sourceKind,
        sourceLevel: customerPolicyTerms ? CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL : jrcpcx ? JRCPCX_TERMS_EVIDENCE_LEVEL : text(source.sourceLevel),
        evidenceLabel: customerPolicyTerms ? CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL : jrcpcx ? JRCPCX_TERMS_EVIDENCE_LABEL : externalReference ? LEGACY_EXTERNAL_REFERENCE_LABEL : text(source.evidenceLabel) || '保险公司官方资料',
        evidenceLevel: customerPolicyTerms ? CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL : jrcpcx ? JRCPCX_TERMS_EVIDENCE_LEVEL : externalReference ? LEGACY_EXTERNAL_REFERENCE_LEVEL : text(source.evidenceLevel) || 'insurer_official',
        officialDomain: jrcpcx ? JRCPCX_OFFICIAL_DOMAIN : text(source.officialDomain),
        detailUrl: text(source.detailUrl),
        clauseUrl: text(source.clauseUrl),
        parser: 'responsibility_query',
      };
      return {
        ...record,
        ...evidenceVerificationFields(record),
      };
    })
    .filter(Boolean);
}

export function materializeResponsibilityCardRows({ policy = {}, cards = [], now = new Date().toISOString() } = {}) {
  const company = text(policy.company);
  const productName = text(policy.name || policy.productName);
  const productKey = productResponsibilityKey(company, productName);
  if (!productKey) return [];
  return (Array.isArray(cards) ? cards : [])
    .map((card, index) => {
      const hydrated = {
        ...card,
        company: text(card.company) || company,
        productName: text(card.productName) || productName,
      };
      const evidenceFields = evidenceVerificationFields(hydrated);
      const titleKey = compact(hydrated.title) || '保险责任';
      const id = `product_responsibility_card:${productKey}:${String(index).padStart(4, '0')}:${titleKey}`;
      const indicatorCheck = indicatorCheckForResponsibilityCard(hydrated);
      return {
        id,
        productKey,
        company: hydrated.company,
        productName: hydrated.productName,
        title: text(hydrated.title),
        category: text(hydrated.category),
        cashflowTreatment: text(hydrated.cashflowTreatment),
        calculationStatus: text(hydrated.calculationStatus),
        calculationReason: text(hydrated.calculationReason),
        responsibilityScope: text(hydrated.responsibilityScope),
        selectionStatus: text(hydrated.selectionStatus),
        sourceUrl: text(hydrated.sourceUrl),
        verificationStatus: evidenceFields.verificationStatus,
        referenceOnly: evidenceFields.referenceOnly,
        generatedAt: now,
        updatedAt: now,
        payload: {
          ...hydrated,
          ...evidenceFields,
          productKey,
          generatedAt: now,
          sourceCardId: text(hydrated.id),
          sourceGate: hydrated.sourceUrl ? 'source_url_present' : 'missing_source_url',
          liabilityGate: hydrated.title && hydrated.cashflowTreatment !== 'not_cashflow' ? 'accepted' : 'needs_review',
          indicatorCheckStatus: indicatorCheck.status,
          indicatorCheckIssues: indicatorCheck.issues,
          indicatorCheckSummary: indicatorCheck.summary,
          indicatorCheckVersion: RESPONSIBILITY_CARD_INDICATOR_CHECK_VERSION,
        },
      };
    })
    .filter((row) => row.id && row.company && row.productName && row.title);
}

export function indicatorsFromResponsibilityCards({ policy = {}, cards = [], existingIndicators = [], now = new Date().toISOString() } = {}) {
  const company = text(policy.company);
  const productName = text(policy.name || policy.productName);
  const existingIds = new Set((Array.isArray(existingIndicators) ? existingIndicators : []).map((indicator) => text(indicator.id)).filter(Boolean));
  const indicators = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!isFormalResponsibilityEvidence(card)) continue;
    const hydrated = {
      ...card,
      company: text(card.company) || company,
      productName: text(card.productName) || productName,
      rowId: text(card.rowId || card.id),
    };
    const result = buildIndicatorFromResponsibilityCard(hydrated, now);
    const indicator = result?.indicator;
    if (!isStructuredCalculationIndicator(indicator)) continue;
    if (!indicator?.id || existingIds.has(indicator.id)) continue;
    existingIds.add(indicator.id);
    indicators.push(indicator);
  }
  return indicators;
}
