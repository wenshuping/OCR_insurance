import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'policy-ocr.sqlite');

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeLookupText(value) {
  return trim(value).normalize('NFKC').replace(/\s+/gu, '');
}

function parsePayload(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sha1(value, length = 12) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function knowledgeText(record = {}) {
  const payload = record.payload || {};
  const pages = Array.isArray(payload.pages)
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
    payload.responsibility,
    payload.analysis?.report,
    ...(Array.isArray(payload.analysis?.coverageTable)
      ? payload.analysis.coverageTable.map((item) => [item.coverageType, item.scenario, item.payout, item.note].filter(Boolean).join(' '))
      : []),
    ...pages,
  ].map(trim).filter(Boolean).join('\n');
}

function knowledgeProductNames(record = {}) {
  const payload = record.payload || {};
  return [record.productName, record.product_name, record.name, record.title, payload.productName, payload.name, payload.title]
    .map(trim)
    .filter(Boolean);
}

function recordMatchesIndicatorProduct(record = {}, indicator = {}) {
  const recordCompany = normalizeLookupText(record.company || record.payload?.company);
  const indicatorCompany = normalizeLookupText(indicator.company);
  if (recordCompany && indicatorCompany && recordCompany !== indicatorCompany) return false;
  const indicatorProduct = normalizeLookupText(indicator.productName);
  if (!indicatorProduct) return false;
  return knowledgeProductNames(record).some((name) => {
    const normalized = normalizeLookupText(name);
    return normalized === indicatorProduct || normalized.includes(indicatorProduct) || indicatorProduct.includes(normalized);
  });
}

function sourceFields(record = {}) {
  const payload = record.payload || {};
  return {
    sourceRecordId: trim(record.id || payload.id),
    sourceUrl: trim(record.url || payload.url),
    sourceTitle: trim(record.title || payload.title || record.productName || payload.productName),
  };
}

function excerptAround(text, index, length = 900) {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  const start = Math.max(0, Number(index || 0) - 80);
  return normalized.slice(start, start + length).trim();
}

function compactIndexOf(source, needle) {
  const sourceText = String(source || '');
  const compactSource = normalizeLookupText(sourceText);
  const compactNeedle = normalizeLookupText(needle);
  if (!compactNeedle) return -1;
  const compactIndex = compactSource.indexOf(compactNeedle);
  if (compactIndex < 0) return -1;
  let seen = 0;
  for (let i = 0; i < sourceText.length; i += 1) {
    if (/\s/u.test(sourceText[i])) continue;
    if (seen >= compactIndex) return i;
    seen += 1;
  }
  return -1;
}

function tokensForIndicator(indicator = {}) {
  const liability = trim(indicator.liability);
  const condition = trim(indicator.condition);
  const tokens = new Set();
  for (const part of liability.split(/[\/、()（）\s-]+/u)) {
    const token = trim(part)
      .replace(/保险金|给付|首次|一般|特定/u, '')
      .replace(/\d+岁前|\d+岁后|\d+-\d+岁/u, '');
    if (token.length >= 2) tokens.add(token);
  }
  if (/护理/u.test(liability)) tokens.add('护理保险金');
  if (/身故|全残/u.test(liability)) tokens.add('身故或身体全残');
  if (/客运列车|航空/u.test(liability)) {
    tokens.add('客运列车');
    tokens.add('航空');
  }
  if (/客运轮船|汽车/u.test(liability)) {
    tokens.add('客运轮船');
    tokens.add('汽车');
  }
  if (/步行|骑行/u.test(liability)) {
    tokens.add('步行');
    tokens.add('骑行');
  }
  if (/高空坠物|抛物/u.test(liability)) {
    tokens.add('高空坠物');
    tokens.add('抛物');
  }
  if (/公共场所/u.test(liability)) tokens.add('公共场所');
  if (/重大自然灾害/u.test(liability)) tokens.add('重大自然灾害');
  if (/电梯/u.test(liability)) tokens.add('电梯');
  if (/驾乘/u.test(liability)) tokens.add('驾乘');
  if (condition) tokens.add(condition.replace(/岁/gu, '周岁'));
  return [...tokens].filter(Boolean);
}

function findBestExcerpt(text = '', indicator = {}) {
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!source) return '';
  const existingExcerpt = trim(indicator.sourceExcerpt);
  if (existingExcerpt) {
    const index = compactIndexOf(source, existingExcerpt.slice(0, 80));
    if (index >= 0) return excerptAround(source, index);
  }
  const candidates = tokensForIndicator(indicator);
  let best = { score: -1, index: -1 };
  for (const token of candidates) {
    const index = compactIndexOf(source, token);
    if (index < 0) continue;
    let score = token.length;
    const window = excerptAround(source, index, 700);
    const normalizedWindow = normalizeLookupText(window);
    if (indicator.value !== undefined && indicator.value !== null) {
      const valueText = String(indicator.value).replace(/\.0$/u, '');
      if (normalizedWindow.includes(`${valueText}${indicator.unit || ''}`)) score += 20;
      if (indicator.unit === '%' && normalizedWindow.includes(`${valueText}％`)) score += 20;
      if (indicator.unit === '倍' && normalizedWindow.includes(`${valueText}倍`)) score += 20;
    }
    if (trim(indicator.condition) && normalizedWindow.includes(normalizeLookupText(indicator.condition))) score += 12;
    if (score > best.score) best = { score, index };
  }
  if (best.index >= 0) return excerptAround(source, best.index);
  return source.slice(0, 900).trim();
}

function findSourceForIndicator(knowledgeRecords = [], indicator = {}) {
  const candidates = knowledgeRecords
    .filter((record) => recordMatchesIndicatorProduct(record, indicator))
    .map((record) => {
      const text = knowledgeText(record);
      const excerpt = findBestExcerpt(text, indicator);
      let score = excerpt ? 1 : 0;
      const normalizedText = normalizeLookupText(text);
      const normalizedExcerpt = normalizeLookupText(indicator.sourceExcerpt);
      if (normalizedExcerpt && normalizedText.includes(normalizedExcerpt.slice(0, 40))) score += 40;
      for (const token of tokensForIndicator(indicator)) {
        if (normalizeLookupText(excerpt).includes(normalizeLookupText(token))) score += 5;
      }
      if (indicator.value !== undefined && indicator.value !== null) {
        const valueText = String(indicator.value).replace(/\.0$/u, '');
        if (normalizeLookupText(excerpt).includes(`${valueText}${indicator.unit || ''}`)) score += 8;
      }
      return { record, excerpt, score };
    })
    .filter((candidate) => candidate.excerpt);
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best) return null;
  return {
    ...sourceFields(best.record),
    sourceExcerpt: trim(indicator.sourceExcerpt) || best.excerpt,
  };
}

function isWaitingRefundMisclassified(row = {}) {
  const payload = row.payload || {};
  const liability = trim(row.liability || payload.liability);
  const basis = trim(payload.basis);
  const text = normalizeLookupText(payload.sourceExcerpt);
  if (!/重疾|重大疾病|疾病|癌|身故|全残|护理/u.test(liability)) return false;
  if (basis !== '已交保费') return false;
  if (!text) return false;
  if (/等待期内.{0,80}按.{0,30}(?:已交保险费|所交保险费).{0,20}(?:给付|赔付).{0,20}(?:身故|全残)/u.test(text)) {
    return false;
  }
  return /(?:等待期内.{0,120}(?:不承担|无息退还|退还|返还).{0,40}(?:保险费|保费))|(?:(?:不承担|不给付).{0,90}(?:退还|返还).{0,40}(?:保险费|保费))/u.test(text);
}

function waitingRefundFormulaText(sourceExcerpt = '') {
  const text = normalizeLookupText(sourceExcerpt);
  if (/累计已交保险费/u.test(text)) return '等待期内不承担原保险金责任，退还累计已交保险费';
  if (/实际交纳的?保险费|实际已交纳?保险费/u.test(text)) return '等待期内不承担原保险金责任，退还实际交纳保险费';
  if (/已交保险费|所交保险费|保费/u.test(text)) return '等待期内不承担原保险金责任，退还已交保险费';
  return '等待期内不承担原保险金责任，退还条款约定保险费';
}

function buildWaitingRefundUpdate(row = {}, now = new Date().toISOString()) {
  const payload = row.payload || {};
  const formulaText = waitingRefundFormulaText(payload.sourceExcerpt);
  const next = {
    ...payload,
    coverageType: '规则参数',
    liability: '等待期退费处理',
    value: null,
    valueText: '',
    unit: '公式',
    basis: /累计已交保险费/u.test(formulaText) ? '累计已交保险费' : '已交保费',
    formulaText,
    condition: payload.condition || '等待期内',
    originalCoverageType: payload.originalCoverageType || row.coverageType || payload.coverageType,
    originalLiability: payload.originalLiability || row.liability || payload.liability,
    originalValue: payload.originalValue ?? payload.value ?? null,
    originalUnit: payload.originalUnit || payload.unit || '',
    qualityStatus: 'reclassified_waiting_period_refund',
    qualityReason: '等待期内不承担原保险金责任并退还保费，不能作为保障给付指标',
    updatedAt: now,
  };
  return {
    id: row.id,
    company: row.company,
    productName: row.productName,
    coverageType: '规则参数',
    liability: '等待期退费处理',
    payload: next,
  };
}

function normalizeIndicatorRows(indicatorRows = []) {
  return indicatorRows.map((row) => ({
    id: trim(row.id),
    company: trim(row.company),
    productName: trim(row.productName || row.product_name),
    coverageType: trim(row.coverageType || row.coverage_type),
    liability: trim(row.liability),
    payload: parsePayload(row.payload),
  }));
}

function normalizeKnowledgeRows(knowledgeRows = []) {
  return knowledgeRows.map((row) => ({
    id: trim(row.id),
    company: trim(row.company),
    productName: trim(row.productName || row.product_name),
    title: trim(row.title),
    url: trim(row.url),
    payload: parsePayload(row.payload),
  }));
}

function normalizeOptionalRows(optionalRows = []) {
  return optionalRows.map((row) => ({
    id: trim(row.id),
    company: trim(row.company),
    productName: trim(row.productName || row.product_name),
    liability: trim(row.liability),
    payload: parsePayload(row.payload),
  }));
}

function sourcePatchForIndicator(indicator, source, now) {
  return {
    ...indicator.payload,
    sourceRecordId: source.sourceRecordId || indicator.payload.sourceRecordId || '',
    sourceUrl: source.sourceUrl || indicator.payload.sourceUrl || '',
    sourceTitle: source.sourceTitle || indicator.payload.sourceTitle || '',
    sourceExcerpt: trim(indicator.payload.sourceExcerpt) || source.sourceExcerpt || '',
    sourceEvidenceLevel: 'official_terms',
    updatedAt: now,
  };
}

export function buildIndicatorSourceRepairPlan({
  indicatorRows = [],
  knowledgeRows = [],
  optionalRows = [],
  now = new Date().toISOString(),
} = {}) {
  const indicators = normalizeIndicatorRows(indicatorRows);
  const knowledgeRecords = normalizeKnowledgeRows(knowledgeRows);
  const optionalRecords = normalizeOptionalRows(optionalRows);
  const indicatorUpdates = [];
  const optionalRecordUpdates = [];
  const unresolved = [];

  for (const indicator of indicators) {
    const payload = indicator.payload || {};
    const needsSource = !trim(payload.sourceExcerpt)
      || (payload.responsibilityScope === 'optional'
        && (!trim(payload.sourceRecordId) || !trim(payload.sourceUrl)));
    if (needsSource) {
      const source = findSourceForIndicator(knowledgeRecords, {
        ...indicator,
        ...payload,
      });
      if (source?.sourceRecordId) {
        indicatorUpdates.push({
          reason: !trim(payload.sourceExcerpt) ? 'repair_missing_source_excerpt' : 'repair_optional_source_link',
          row: {
            ...indicator,
            payload: sourcePatchForIndicator(indicator, source, now),
          },
        });
      } else {
        unresolved.push({ id: indicator.id, reason: 'source_not_found' });
      }
    }

    if (isWaitingRefundMisclassified(indicator)) {
      indicatorUpdates.push({
        reason: 'reclassify_waiting_period_refund',
        row: buildWaitingRefundUpdate(indicator, now),
      });
    }
  }

  for (const optionalRecord of optionalRecords) {
    const payload = optionalRecord.payload || {};
    if (trim(payload.sourceRecordId) && trim(payload.sourceUrl)) continue;
    const source = findSourceForIndicator(knowledgeRecords, {
      company: optionalRecord.company,
      productName: optionalRecord.productName,
      liability: optionalRecord.liability,
      sourceExcerpt: payload.sourceExcerpt,
      payload,
    });
    if (source?.sourceRecordId) {
      optionalRecordUpdates.push({
        reason: 'repair_optional_record_source_link',
        row: {
          ...optionalRecord,
          payload: {
            ...payload,
            sourceRecordId: source.sourceRecordId,
            sourceUrl: source.sourceUrl,
            sourceTitle: source.sourceTitle,
            sourceEvidenceLevel: 'official_terms',
            updatedAt: now,
          },
        },
      });
    }
  }

  const uniqueIndicatorUpdates = [...new Map(indicatorUpdates.map((item) => [item.row.id, item])).values()];
  const summary = {
    indicatorUpdates: uniqueIndicatorUpdates.length,
    optionalRecordUpdates: optionalRecordUpdates.length,
    missingSourceRepairs: uniqueIndicatorUpdates.filter((item) => item.reason === 'repair_missing_source_excerpt').length,
    optionalSourceRepairs: uniqueIndicatorUpdates.filter((item) => item.reason === 'repair_optional_source_link').length,
    waitingRefundReclasses: uniqueIndicatorUpdates.filter((item) => item.reason === 'reclassify_waiting_period_refund').length,
    unresolved: unresolved.length,
    unresolvedSample: unresolved.slice(0, 20),
  };
  return {
    summary,
    indicatorUpdates: uniqueIndicatorUpdates,
    optionalRecordUpdates,
  };
}

function loadRows(db) {
  return {
    indicatorRows: db.prepare('SELECT id, company, product_name, coverage_type, liability, payload FROM insurance_indicator_records').all(),
    knowledgeRows: db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records').all(),
    optionalRows: db.prepare('SELECT id, company, product_name, liability, payload FROM optional_responsibility_records').all(),
  };
}

function applyPlan(db, plan) {
  const updateIndicator = db.prepare(`
    UPDATE insurance_indicator_records
       SET company = ?, product_name = ?, coverage_type = ?, liability = ?, payload = ?
     WHERE id = ?
  `);
  const updateOptional = db.prepare(`
    UPDATE optional_responsibility_records
       SET company = ?, product_name = ?, liability = ?, payload = ?
     WHERE id = ?
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { row } of plan.indicatorUpdates) {
      updateIndicator.run(row.company, row.productName, row.coverageType, row.liability, JSON.stringify(row.payload), row.id);
    }
    for (const { row } of plan.optionalRecordUpdates) {
      updateOptional.run(row.company, row.productName, row.liability, JSON.stringify(row.payload), row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function repairIndicatorSourceGovernance({ dbPath = DEFAULT_DB_PATH, dryRun = false } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const plan = buildIndicatorSourceRepairPlan(loadRows(db));
    if (!dryRun) applyPlan(db, plan);
    return {
      dbPath,
      dryRun,
      summary: plan.summary,
      sample: {
        indicatorUpdates: plan.indicatorUpdates.slice(0, 10).map((item) => ({
          reason: item.reason,
          id: item.row.id,
          productName: item.row.productName,
          liability: item.row.liability,
          sourceRecordId: item.row.payload.sourceRecordId,
        })),
        optionalRecordUpdates: plan.optionalRecordUpdates.slice(0, 10).map((item) => ({
          id: item.row.id,
          productName: item.row.productName,
          liability: item.row.liability,
          sourceRecordId: item.row.payload.sourceRecordId,
        })),
      },
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = path.resolve(readArg('db-path', DEFAULT_DB_PATH));
  const dryRun = hasFlag('dry-run');
  const result = repairIndicatorSourceGovernance({ dbPath, dryRun });
  console.log(JSON.stringify(result, null, 2));
}
