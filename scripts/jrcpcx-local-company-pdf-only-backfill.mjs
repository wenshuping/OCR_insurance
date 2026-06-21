import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeClauseUrl,
} from './jrcpcx-major-company-gap-backfill.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const DEFAULT_DB_PATH = path.join(runtimeDir, 'policy-ocr.sqlite');
const DEFAULT_STATUS_SHARDS = Object.freeze(['在售', '停售', '停用']);

function trim(value = '') {
  return String(value || '').trim();
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function productNameOf(row = {}) {
  return trim(row.productName || row.product_name || row.name || row.payload?.productName);
}

function productTypeOf(row = {}) {
  return trim(row.productType || row.product_type || row.payload?.productType || row.detailFields?.产品类别 || row.detailFields?.产品类型);
}

function pageTextOf(row = {}) {
  return trim(row.pageText || row.payload?.pageText || row.snippet || row.payload?.snippet);
}

function pdfLocalPathOf(row = {}) {
  return trim(row.pdfLocalPath || row.pdfFilePath || row.payload?.pdfLocalPath || row.payload?.pdfFilePath);
}

function companyOf(row = {}) {
  return trim(row.company || row.issuerFullName || row.payload?.company || row.payload?.issuerFullName);
}

function localCompanyNameOf(row = {}) {
  return trim(row.localCompanyName || row.local_company_name || row.payload?.localCompanyName || row.payload?.local_company_name);
}

function submittedDeptNameOf(row = {}) {
  return trim(row.submittedDeptName || row.submitted_dept_name || row.payload?.submittedDeptName || row.payload?.submitted_dept_name);
}

const STRONG_HUMAN_INSURANCE_RE = /人身保险|人寿|寿险|健康保险|疾病保险|医疗保险|意外|年金|养老|两全|终身寿|定期寿|护理|重疾|少儿|教育金/iu;
const PROPERTY_INSURANCE_RE = /财产保险|财险|车险|机动车|责任保险|保证保险|信用保险|农业保险|货运|船舶|工程保险|企业财产/iu;

function evidenceTextOf(row = {}) {
  return [companyOf(row), productNameOf(row), productTypeOf(row), pageTextOf(row)].filter(Boolean).join(' ');
}

function materialSignalTextOf(row = {}) {
  return [productNameOf(row), productTypeOf(row), pageTextOf(row)].filter(Boolean).join(' ');
}

function hasPropertyInsuranceEvidence(row = {}) {
  return PROPERTY_INSURANCE_RE.test(materialSignalTextOf(row));
}

export function isHumanInsuranceEvidence(row = {}) {
  const text = evidenceTextOf(row);
  if (!text) return false;
  const materialText = materialSignalTextOf(row);
  const hasStrongHumanEvidence = STRONG_HUMAN_INSURANCE_RE.test(materialText);
  if (hasPropertyInsuranceEvidence(row) && !hasStrongHumanEvidence) return false;
  return hasStrongHumanEvidence;
}

function jrcpcxClauseUrlOf(row = {}) {
  for (const value of [row.url, row.payload?.url, row.pdfOriginalUrl, row.payload?.pdfOriginalUrl]) {
    const normalized = normalizeClauseUrl(value);
    if (normalized) return normalized;
  }
  return '';
}

function companySummaryFromRows(company, rows = []) {
  const localJrcpcxClauseUrlCount = rows.filter((row) => jrcpcxClauseUrlOf(row)).length;
  const localPdfPathCount = rows.filter((row) => pdfLocalPathOf(row)).length;
  const localHumanInsuranceEvidenceCount = rows.filter((row) => isHumanInsuranceEvidence(row)).length;
  const hasPropertyOnlyEvidence = rows.length > 0 && localHumanInsuranceEvidenceCount === 0 && rows.every((row) => hasPropertyInsuranceEvidence(row));
  const included = localHumanInsuranceEvidenceCount > 0;
  const localCompanyName = rows.map((row) => localCompanyNameOf(row)).find(Boolean) || company;
  const submittedDeptName = rows.map((row) => submittedDeptNameOf(row)).find(Boolean) || company;
  return {
    company,
    localCompanyName,
    submittedDeptName,
    localKnowledgeRecordCount: rows.length,
    localHumanInsuranceEvidenceCount,
    localJrcpcxClauseUrlCount,
    localPdfPathCount,
    included,
    excludeReason: included ? '' : (hasPropertyOnlyEvidence ? 'property_insurance_only' : 'no_human_insurance_evidence'),
  };
}

export function buildLocalCompanyInventory(records = []) {
  const byCompany = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    const payload = raw.payload && typeof raw.payload === 'string' ? parseJson(raw.payload, {}) : (raw.payload || {});
    const row = { ...payload, ...raw, payload };
    const company = companyOf(row);
    if (!company) continue;
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company).push(row);
  }
  return [...byCompany.entries()]
    .map(([company, rows]) => companySummaryFromRows(company, rows))
    .sort((a, b) => {
      if (a.included !== b.included) return a.included ? -1 : 1;
      return b.localKnowledgeRecordCount - a.localKnowledgeRecordCount || a.company.localeCompare(b.company, 'zh-Hans-CN');
    });
}

export function buildLocalCompanyQueries(inventory = [], statusLabels = DEFAULT_STATUS_SHARDS) {
  const queries = [];
  for (const company of Array.isArray(inventory) ? inventory : []) {
    if (!company.included) continue;
    for (const productStateLabel of statusLabels) {
      queries.push({
        deptName: trim(company.submittedDeptName || company.company),
        localCompanyName: trim(company.localCompanyName || company.company),
        productTypeLabel: '人身保险类',
        productTermLabel: '全部',
        productStateLabel,
      });
    }
  }
  return queries;
}
