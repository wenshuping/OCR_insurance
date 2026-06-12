import { POLICY_FIELD_SCHEMA } from '../insurance-field-schema.mjs';
import { compactText, cleanupFieldText } from '../insurance-field-rules.mjs';
import { findBestFuzzyMatch } from '../fuzzy-matching.mjs';

export const POLICY_CSV_PARSER_ID = 'analyzer/csv-parser';

export const POLICY_CSV_FIELD_LABELS = {
  company: '保险公司',
  name: '主险/保单名称',
  applicant: '投保人',
  beneficiary: '受益人',
  policyNumber: '保险合同号',
  insured: '被保险人',
  insuredIdNumber: '被保险人证件号',
  insuredBirthday: '被保险人出生日期',
  date: '合同生效日期',
  paymentPeriod: '缴费期间',
  coveragePeriod: '保险期间',
  amount: '主保额',
  firstPremium: '保险费合计',
};

export const POLICY_CSV_FIELD_KEYS = Object.keys(POLICY_CSV_FIELD_LABELS);

const POLICY_CSV_UNCERTAIN_CONFIDENCE_VALUES = new Set([
  'review',
  'low',
  'uncertain',
  'unknown',
  'needs-review',
  'need-review',
  '不确定',
  '未知',
  '需确认',
  '待确认',
]);

const FIELD_ALIAS_OVERRIDES = {
  date: POLICY_FIELD_SCHEMA.effectiveDate?.aliases || [],
  insuredIdNumber: ['被保险人证件号', '被保险人证件号码', '被保险人身份证', '被保险人身份证号', '证件号码', '身份证号码', '身份证号'],
  insuredBirthday: ['被保险人出生日期', '被保险人生日', '出生日期', '生日'],
};

const FIELD_ALIAS_ENTRIES = POLICY_CSV_FIELD_KEYS.flatMap((field) => {
  const schemaKey = field === 'date' ? 'effectiveDate' : field;
  const schema = POLICY_FIELD_SCHEMA[schemaKey] || {};
  const aliases = [
    field,
    POLICY_CSV_FIELD_LABELS[field],
    schema.label,
    ...(schema.aliases || []),
    ...(FIELD_ALIAS_OVERRIDES[field] || []),
  ];
  return [...new Set(aliases.map((alias) => cleanupFieldText(alias)).filter(Boolean))]
    .map((alias) => ({ field, alias, compactAlias: compactText(alias) }));
});

const LONG_FIELD_LABEL_KEYS = ['label', '标签', '字段名', '字段', 'field', 'key', 'name', '名称'];
const LONG_FIELD_VALUE_KEYS = ['value', '识别值', '字段值', '值', '内容', 'result', 'text'];
const CONFIDENCE_KEYS = ['confidence', '置信度', 'score', '可信度'];
const EVIDENCE_KEYS = ['evidence', '证据', 'rowText', '原文', '来源文本'];
const SOURCE_KEYS = ['source', '来源', '识别来源'];

function trim(value) {
  return String(value ?? '').trim();
}

function firstNonEmpty(row = {}, keys = []) {
  for (const key of keys) {
    const value = row[key];
    if (trim(value)) return value;
  }
  return '';
}

function configuredRate(env, primaryName, fallbackName, defaultValue) {
  const value = Number(env?.[primaryName] || env?.[fallbackName] || defaultValue);
  if (!Number.isFinite(value) || value <= 0) return defaultValue;
  return value > 1 ? Math.min(value / 100, 1) : Math.min(value, 1);
}

export function getPolicyCsvRecognitionThreshold(env = process.env) {
  return configuredRate(env, 'POLICY_OCR_CSV_PARSER_MIN_RECOGNITION_RATE', 'POLICY_OCR_EXCEL_SKILL_MIN_RECOGNITION_RATE', 0.6);
}

export function getPolicyCsvFieldConfidenceThreshold(env = process.env) {
  return configuredRate(env, 'POLICY_OCR_CSV_PARSER_MIN_FIELD_CONFIDENCE', 'POLICY_OCR_EXCEL_SKILL_MIN_FIELD_CONFIDENCE', 0.6);
}

export function isPolicyCsvConfidenceCertain(confidence, env = process.env) {
  const marker = trim(confidence);
  if (!marker) return true;
  if (POLICY_CSV_UNCERTAIN_CONFIDENCE_VALUES.has(marker.toLowerCase())) return false;
  const numeric = Number(marker);
  if (!Number.isFinite(numeric)) return true;
  return numeric >= getPolicyCsvFieldConfidenceThreshold(env);
}

export function isPolicyCsvRowCertain(row = {}, env = process.env) {
  if (!isPolicyCsvConfidenceCertain(firstNonEmpty(row, CONFIDENCE_KEYS), env)) return false;
  const evidence = row.evidence;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    return isPolicyCsvConfidenceCertain(evidence.confidence ?? evidence.score, env);
  }
  return true;
}

export function parseCsvText(text = '') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/u, '');

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item) => trim(item))) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((header) => trim(header));
  return rows.slice(1).map((items) => headers.reduce((record, header, index) => {
    if (header) record[header] = trim(items[index]);
    return record;
  }, {}));
}

function normalizeRows(sheet) {
  if (!sheet) return [];
  if (typeof sheet === 'string') return parseCsvText(sheet);
  if (!Array.isArray(sheet)) return [];
  if (!sheet.length) return [];
  if (Array.isArray(sheet[0])) {
    const headers = sheet[0].map((header) => trim(header));
    return sheet.slice(1).map((items) => headers.reduce((record, header, index) => {
      if (header) record[header] = trim(items[index]);
      return record;
    }, {}));
  }
  return sheet.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function splitTextLines(raw) {
  return String(raw || '')
    .replace(/\r/gu, '\n')
    .split('\n')
    .map((line) => trim(line))
    .filter(Boolean);
}

function mergeEvidencePayloads(payloads = []) {
  const merged = {};
  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    for (const [rawKey, value] of Object.entries(payload)) {
      const key = trim(rawKey);
      if (!key || value == null || merged[key]) continue;
      if (typeof value === 'string' && !trim(value)) continue;
      merged[key] = value;
    }
  }
  return merged;
}

function policyFieldForLabel(label) {
  const text = trim(label);
  if (!text) return '';
  if (POLICY_CSV_FIELD_KEYS.includes(text)) return text;
  const compact = compactText(text);
  const exact = FIELD_ALIAS_ENTRIES.find((entry) => entry.compactAlias === compact);
  if (exact) return exact.field;
  const fuzzy = findBestFuzzyMatch(compact, FIELD_ALIAS_ENTRIES.map((entry) => entry.compactAlias), {
    minScore: compact.length <= 4 ? 0.7 : 0.76,
    requireSalientOverlap: false,
  });
  return FIELD_ALIAS_ENTRIES.find((entry) => entry.compactAlias === fuzzy?.choice)?.field || '';
}

function buildRowText(row = {}) {
  return Object.entries(row)
    .map(([key, value]) => `${key}:${typeof value === 'object' ? JSON.stringify(value) : trim(value)}`)
    .join(' ');
}

function buildEvidence(row = {}, field, value, source) {
  const evidence = row.evidence;
  const labelText = trim(row.label || row.field || POLICY_CSV_FIELD_LABELS[field] || field);
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    return {
      ...evidence,
      value,
      labelText: evidence.labelText || labelText,
      rowText: evidence.rowText || buildRowText(row),
      relation: evidence.relation || 'csv-parser',
      source: evidence.source || source,
    };
  }
  const text = trim(firstNonEmpty(row, EVIDENCE_KEYS)) || buildRowText(row);
  return {
    value,
    labelText,
    rowText: text,
    relation: 'csv-parser',
    source,
  };
}

function collectFieldRows(rows = [], source, env) {
  const data = {};
  const fieldEvidence = {};
  const fieldConfidence = {};
  const fieldAttribution = {};

  function addField({ field, value, row, label }) {
    const cleanValue = trim(value);
    if (!field || !cleanValue || data[field] || !isPolicyCsvRowCertain(row, env)) return;
    const rowSource = trim(firstNonEmpty(row, SOURCE_KEYS)) || source;
    const confidence = firstNonEmpty(row, CONFIDENCE_KEYS);
    data[field] = cleanValue;
    if (confidence) fieldConfidence[field] = trim(confidence);
    fieldEvidence[field] = buildEvidence({ ...row, label: label || row.label }, field, cleanValue, rowSource);
    fieldAttribution[field] = {
      field,
      value: cleanValue,
      label: trim(label || row.label || row.field || POLICY_CSV_FIELD_LABELS[field] || field),
      source: rowSource,
      parser: POLICY_CSV_PARSER_ID,
      ...(confidence ? { confidence: trim(confidence) } : {}),
    };
  }

  for (const row of rows) {
    const longLabel = firstNonEmpty(row, LONG_FIELD_LABEL_KEYS);
    const longValue = firstNonEmpty(row, LONG_FIELD_VALUE_KEYS);
    if (longLabel && longValue) {
      addField({ field: policyFieldForLabel(longLabel), value: longValue, row, label: longLabel });
      continue;
    }

    for (const [header, value] of Object.entries(row)) {
      const field = policyFieldForLabel(header);
      if (field) addField({ field, value, row: { ...row, field, label: header, value }, label: header });
    }
  }

  return { data, fieldEvidence, fieldConfidence, fieldAttribution };
}

function collectPlans(rows = [], source, env) {
  return rows
    .filter((row) => isPolicyCsvRowCertain(row, env))
    .map((row, index) => {
      const name = firstNonEmpty(row, ['name', 'productName', 'planName', '险种名称', '产品名称', '主险/保单名称']);
      if (!name) return null;
      return {
        role: firstNonEmpty(row, ['role', '角色']) || (index === 0 ? 'main' : 'rider'),
        company: firstNonEmpty(row, ['company', '保险公司']),
        name,
        productType: firstNonEmpty(row, ['productType', '产品类型']),
        amount: firstNonEmpty(row, ['amount', '基本保险金额', '保险金额', '保额']),
        coveragePeriod: firstNonEmpty(row, ['coveragePeriod', '保险期间', '保障期间']),
        paymentMode: firstNonEmpty(row, ['paymentMode', '交费方式', '缴费方式']),
        paymentPeriod: firstNonEmpty(row, ['paymentPeriod', '交费期间', '缴费期间']),
        premium: firstNonEmpty(row, ['premium', 'firstPremium', '保险费', '首期保险费']),
        premiumText: firstNonEmpty(row, ['premiumText', '保费原文']),
        source,
        evidence: firstNonEmpty(row, EVIDENCE_KEYS),
      };
    })
    .filter(Boolean);
}

export function mapPolicyRowsToScan({ fields, plans: sourcePlans, ocrLines, warnings } = {}, { source = 'csv', env = process.env } = {}) {
  const parserSource = source || 'csv';
  const fieldRows = normalizeRows(fields);
  const planRows = normalizeRows(sourcePlans);
  const ocrRows = normalizeRows(ocrLines);
  const warningRows = normalizeRows(warnings);
  const mapped = collectFieldRows(fieldRows, parserSource, env);
  const plans = collectPlans(planRows, parserSource, env);
  if (plans.length) mapped.data.plans = plans;
  const ocrText = ocrRows
    .map((row) => trim(row.text || row.OCR || row['原文'] || Object.values(row).join(' ')))
    .filter(Boolean)
    .join('\n');
  const ocrWarnings = warningRows
    .map((row) => trim(row.warning || row['警告'] || Object.values(row).join(' ')))
    .filter(Boolean);
  const recognizedFields = POLICY_CSV_FIELD_KEYS.filter((field) => trim(mapped.data[field])).length;

  return {
    ...mapped,
    ocrText,
    ocrWarnings,
    quality: {
      recognizedFields,
      totalFields: POLICY_CSV_FIELD_KEYS.length,
      recognitionRate: recognizedFields / POLICY_CSV_FIELD_KEYS.length,
    },
    parser: POLICY_CSV_PARSER_ID,
  };
}

export function readPolicyScanRows(scan = {}, {
  source = 'ocr',
  env = process.env,
  fields = POLICY_CSV_FIELD_KEYS,
  fieldEvidence = null,
  splitOcrText = splitTextLines,
} = {}) {
  const data = scan?.data && typeof scan.data === 'object' ? scan.data : {};
  const fieldConfidence = scan?.fieldConfidence || scan?.data?.fieldConfidence || data.fieldConfidence || {};
  const mergedFieldEvidence = fieldEvidence || mergeEvidencePayloads([scan?.fieldEvidence, data.fieldEvidence]);
  const fieldRows = fields.map((field) => ({
    field,
    label: POLICY_CSV_FIELD_LABELS[field] || field,
    value: data[field] || '',
    confidence: fieldConfidence[field] || '',
    evidence: mergedFieldEvidence[field] || null,
    source,
  }));
  const planRows = (Array.isArray(data.plans) ? data.plans : []).map((plan, index) => ({
    index: index + 1,
    role: plan?.role || '',
    company: plan?.company || data.company || '',
    name: plan?.name || '',
    productType: plan?.productType || '',
    amount: plan?.amount || '',
    coveragePeriod: plan?.coveragePeriod || '',
    paymentMode: plan?.paymentMode || '',
    paymentPeriod: plan?.paymentPeriod || '',
    premium: plan?.premium || '',
    premiumText: plan?.premiumText || '',
    source,
    confidence: plan?.confidence || '',
    evidence: plan?.evidence || null,
  }));
  const ocrRows = splitOcrText(scan?.ocrText || '').map((text, index) => ({
    index: index + 1,
    text,
    source,
  }));
  const warningRows = (Array.isArray(scan?.ocrWarnings) ? scan.ocrWarnings : [])
    .map((warning, index) => ({
      index: index + 1,
      warning: trim(warning),
      source,
    }))
    .filter((row) => row.warning);

  return mapPolicyRowsToScan({
    fields: fieldRows,
    plans: planRows,
    ocrLines: ocrRows,
    warnings: warningRows,
  }, { source, env });
}

export function mapPolicyWorkbookToScan(workbook = {}, { source = '', env = process.env } = {}) {
  const sheets = workbook?.sheets || {};
  return mapPolicyRowsToScan({
    fields: sheets.fields || sheets.Fields || sheets['字段'] || sheets['字段映射'],
    plans: sheets.plans || sheets.Plans || sheets['险种'] || sheets['计划'],
    ocrLines: sheets.ocrLines || sheets.ocr || sheets['OCR原文'],
    warnings: sheets.warnings || sheets['警告'],
  }, {
    source: source || workbook?.source || 'csv',
    env,
  });
}
