import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { allocateId } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';
import {
  buildPingAnHistoricalSeedPayload,
  parsePlanCodeFilter,
  runCrawler,
  summarizeHistoricalSeedResult,
  summarizeSkippedByReason,
  withPingAnHistoricalBrowserOptions,
} from './crawl-ping-an-historical-seed.mjs';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultAuditDocumentKey = 'ping_an_historical_official_gap_audit';
const loanRateSourceUrl = 'https://life.pingan.com/ilifecore/biaogexiazai/baodandaikuanlilv.pdf';

function trim(value) {
  return String(value || '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizePlanCode(value) {
  return trim(value).toUpperCase();
}

function planCodeFromUrl(url = '') {
  try {
    return trim(new URL(url).searchParams.get('planCode'));
  } catch {
    return '';
  }
}

export function buildExistingPingAnPlanCodes(records = []) {
  const codes = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    if (trim(record?.company) !== '中国平安') continue;
    const planCode = trim(record?.planCode) || planCodeFromUrl(record?.url);
    if (planCode) codes.add(normalizePlanCode(planCode));
  }
  return codes;
}

function isNumericPlanCode(value = '') {
  return /^\d+$/u.test(trim(value));
}

export function buildPingAnHistoricalGapSeeds({
  officialProducts = [],
  existingPlanCodes = new Set(),
  includePlanCodes = new Set(),
  excludePlanCodes = new Set(),
  maxVersion = 3,
  numericOnly = true,
} = {}) {
  const include = includePlanCodes instanceof Set ? includePlanCodes : new Set();
  const exclude = excludePlanCodes instanceof Set ? excludePlanCodes : new Set();
  const existing = existingPlanCodes instanceof Set ? existingPlanCodes : new Set();
  return (Array.isArray(officialProducts) ? officialProducts : [])
    .map((product) => ({
      planCode: trim(product?.planCode),
      productName: trim(product?.productName),
      productType: trim(product?.productType),
      officialProductType: trim(product?.officialProductType),
      loanRate: trim(product?.loanRate),
      selfPayRate: trim(product?.selfPayRate),
      seedSourceUrl: trim(product?.sourceUrl) || loanRateSourceUrl,
    }))
    .filter((product) => product.planCode && product.productName)
    .filter((product) => !numericOnly || isNumericPlanCode(product.planCode))
    .filter((product) => !include.size || include.has(product.planCode))
    .filter((product) => !exclude.has(product.planCode))
    .filter((product) => !existing.has(normalizePlanCode(product.planCode)))
    .map((product) => ({
      ...product,
      maxVersion,
      salesStatus: '停售（平安官方保单贷款利率表历史产品）',
      seedSource: '平安官网保单贷款利率表',
    }));
}

function groupSkippedByPlanCode(skipped = []) {
  const byCode = new Map();
  for (const item of Array.isArray(skipped) ? skipped : []) {
    const planCode = trim(item?.planCode);
    if (!planCode) continue;
    if (!byCode.has(planCode)) byCode.set(planCode, []);
    byCode.get(planCode).push(item);
  }
  return byCode;
}

function annotateCandidates(candidates = [], result = {}) {
  const byCode = groupSkippedByPlanCode(result.skipped || []);
  const crawledCodes = new Set((result.records || []).map((record) => trim(record.planCode)).filter(Boolean));
  return candidates.map((candidate) => {
    const skipped = byCode.get(candidate.planCode) || [];
    return {
      planCode: candidate.planCode,
      productName: candidate.productName,
      productType: candidate.productType,
      officialProductType: candidate.officialProductType,
      seedSource: candidate.seedSource,
      seedSourceUrl: candidate.seedSourceUrl,
      maxVersion: candidate.maxVersion,
      status: crawledCodes.has(candidate.planCode) ? 'terms_crawled' : 'terms_not_crawled',
      skippedCount: skipped.length,
      skippedByReason: summarizeSkippedByReason(skipped),
      skippedSamples: skipped.slice(0, 3),
    };
  });
}

export function buildPingAnHistoricalAuditDocument({
  officialResult = {},
  existingPlanCodeCount = 0,
  excludedPlanCodes = new Set(),
  candidates = [],
  crawlResult = {},
  writeResult = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const annotatedCandidates = annotateCandidates(candidates, crawlResult);
  return {
    company: '中国平安',
    generatedAt,
    source: loanRateSourceUrl,
    sourceName: '平安官网保单贷款利率表',
    officialProductCount: officialResult.productCount || (officialResult.products || []).length || 0,
    existingPlanCodeCount,
    excludedPlanCodes: [...excludedPlanCodes],
    candidateCount: candidates.length,
    crawl: {
      seedCount: crawlResult.seedCount || 0,
      productCount: crawlResult.productCount || 0,
      recordCount: (crawlResult.records || []).length,
      skippedCount: crawlResult.skippedCount || 0,
      skippedByReason: summarizeSkippedByReason(crawlResult.skipped || []),
    },
    write: {
      dbPath: writeResult.dbPath || '',
      savedRecordCount: writeResult.savedRecordCount || 0,
      newSavedRecordCount: writeResult.newSavedRecordCount || 0,
      newSavedMinId: writeResult.newSavedMinId || null,
      newSavedMaxId: writeResult.newSavedMaxId || null,
      localKnowledgeAfter: writeResult.localKnowledgeAfter || null,
    },
    candidates: annotatedCandidates,
  };
}

async function writeKnowledgeRecords(records = [], knowledgeStore) {
  if (!records.length) {
    return {
      dbPath: knowledgeStore.dbPath,
      savedRecordCount: 0,
      newSavedRecordCount: 0,
      newSavedMinId: null,
      newSavedMaxId: null,
      localKnowledgeAfter: knowledgeStore.countKnowledgeRecords(),
    };
  }
  const state = knowledgeStore.loadState();
  if (!Number(state.nextId)) state.nextId = 1;
  const beforeUrls = new Set(knowledgeStore.allKnownUrls());
  const saved = upsertKnowledgeRecords(state, records, { allocateId });
  knowledgeStore.saveState(state);
  const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(trim(record.url)));
  const newSavedIds = newSaved
    .map((record) => Number(record.id))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    dbPath: knowledgeStore.dbPath,
    savedRecordCount: saved.length,
    newSavedRecordCount: newSaved.length,
    newSavedMinId: newSavedIds[0] || null,
    newSavedMaxId: newSavedIds.at(-1) || null,
    localKnowledgeAfter: knowledgeStore.countKnowledgeRecords(),
  };
}

async function main() {
  const maxVersion = readNumberArg('max-version', Number(process.env.PING_AN_HISTORICAL_MAX_VERSION || 3));
  const offset = readNumberArg('offset', Number(process.env.PING_AN_HISTORICAL_OFFSET || 0));
  const limit = readNumberArg('limit', Number(process.env.PING_AN_HISTORICAL_LIMIT || 0));
  const includePlanCodes = parsePlanCodeFilter(readArg('plan-code', process.env.PING_AN_HISTORICAL_PLAN_CODE || ''));
  const excludePlanCodes = parsePlanCodeFilter(readArg('exclude-plan-code', process.env.PING_AN_HISTORICAL_EXCLUDE_PLAN_CODE || ''));
  const numericOnly = !hasFlag('include-alphanumeric');
  const writeRecords = hasFlag('write') || process.env.PING_AN_HISTORICAL_WRITE === '1';
  const writeAudit = !hasFlag('no-write-audit');
  const auditKey = trim(readArg('audit-key', process.env.PING_AN_HISTORICAL_AUDIT_KEY || defaultAuditDocumentKey));
  const cdpUrl = readArg('cdp-url', process.env.PING_AN_CDP_URL || '');
  const delayMs = readNumberArg('delay-ms', Number(process.env.PING_AN_HISTORICAL_DELAY_MS || 0));
  const pdfRetryCount = readNumberArg('pdf-retry-count', Number(process.env.PING_AN_PDF_RETRY_COUNT || 0));
  const pdfRetryDelayMs = readNumberArg('pdf-retry-delay-ms', Number(process.env.PING_AN_PDF_RETRY_DELAY_MS || 0));
  const dbPath = readArg('db-path', process.env.POLICY_OCR_APP_DB_PATH || '');
  const seedStatePath = readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || '');

  const officialResult = runCrawler({ mode: 'ping_an_loan_rate_products', company: '中国平安' });
  if (officialResult.ok === false) {
    console.log(JSON.stringify(officialResult, null, 2));
    process.exitCode = 2;
    return;
  }

  const knowledgeStore = await createKnowledgeStateStore({
    ...(trim(dbPath) ? { dbPath: path.resolve(projectRoot, dbPath) } : {}),
    ...(trim(seedStatePath) ? { seedStatePath: path.resolve(projectRoot, seedStatePath) } : {}),
  });
  try {
    const state = knowledgeStore.loadState();
    const existingPlanCodes = buildExistingPingAnPlanCodes(state.knowledgeRecords || []);
    const allCandidates = buildPingAnHistoricalGapSeeds({
      officialProducts: officialResult.products || [],
      existingPlanCodes,
      includePlanCodes,
      excludePlanCodes,
      maxVersion,
      numericOnly,
    });
    const candidates = limit > 0 ? allCandidates.slice(offset, offset + limit) : allCandidates.slice(offset);
    const crawlPayload = withPingAnHistoricalBrowserOptions(buildPingAnHistoricalSeedPayload({ seeds: candidates, maxVersion }), {
      cdpUrl,
      delayMs,
      pdfRetryCount,
      pdfRetryDelayMs,
    });
    const crawlResult = candidates.length
      ? runCrawler(crawlPayload)
      : { ok: true, company: '中国平安', seedCount: 0, productCount: 0, records: [], skipped: [], skippedCount: 0 };
    if (crawlResult.ok === false) {
      console.log(JSON.stringify(crawlResult, null, 2));
      process.exitCode = 2;
      return;
    }
    const writeResult = writeRecords ? await writeKnowledgeRecords(crawlResult.records || [], knowledgeStore) : {};
    const auditDocument = buildPingAnHistoricalAuditDocument({
      officialResult,
      existingPlanCodeCount: existingPlanCodes.size,
      excludedPlanCodes: excludePlanCodes,
      candidates,
      crawlResult,
      writeResult,
    });
    if (writeAudit && auditKey) {
      knowledgeStore.writeStateDocument(auditKey, auditDocument);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          company: '中国平安',
          dbPath: knowledgeStore.dbPath,
          auditDocumentKey: writeAudit ? auditKey : '',
          source: loanRateSourceUrl,
          officialProductCount: auditDocument.officialProductCount,
          existingPlanCodeCount: existingPlanCodes.size,
          excludedPlanCodes: [...excludePlanCodes],
          totalCandidateCount: allCandidates.length,
          candidateCount: candidates.length,
          offset,
          limit,
          crawl: auditDocument.crawl,
          write: auditDocument.write,
          historicalSeedSummary: summarizeHistoricalSeedResult(crawlResult, {
            write: writeRecords,
            dbPath: writeResult.dbPath || '',
            saved: Array.from({ length: writeResult.savedRecordCount || 0 }, () => ({})),
          }),
          candidateSamples: auditDocument.candidates.slice(0, 20),
        },
        null,
        2,
      ),
    );
  } finally {
    knowledgeStore.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
