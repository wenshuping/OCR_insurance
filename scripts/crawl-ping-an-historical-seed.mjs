import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocateId } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

export const DEFAULT_PING_AN_HISTORICAL_SEEDS = [
  {
    planCode: '892',
    maxVersion: 3,
    salesStatus: '停售（目录外历史产品）',
    seedSource: '平安官网保单E服务FAQ：万能险智富人生892/893',
    seedSourceUrl: 'https://www.pingan.com/campaign/efuwu/questions.jsp',
  },
  {
    planCode: '893',
    maxVersion: 3,
    salesStatus: '停售（目录外历史产品）',
    seedSource: '平安官网保单E服务FAQ：万能险智富人生892/893',
    seedSourceUrl: 'https://www.pingan.com/campaign/efuwu/questions.jsp',
  },
  {
    planCode: '897',
    maxVersion: 2,
    salesStatus: '停售（目录外历史产品）',
    seedSource: '平安官网保单E服务FAQ：万能险稳赢一生897/898/899',
    seedSourceUrl: 'https://www.pingan.com/campaign/efuwu/questions.jsp',
  },
  {
    planCode: '898',
    maxVersion: 1,
    salesStatus: '停售（目录外历史产品）',
    seedSource: '平安官网保单E服务FAQ：万能险稳赢一生897/898/899',
    seedSourceUrl: 'https://www.pingan.com/campaign/efuwu/questions.jsp',
  },
];

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
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function parsePlanCodeFilter(value = '') {
  return new Set(
    trim(value)
      .split(/[,，\s]+/u)
      .map((item) => trim(item))
      .filter(Boolean),
  );
}

export function loadPingAnHistoricalSeeds(seedFile = '') {
  if (!trim(seedFile)) return DEFAULT_PING_AN_HISTORICAL_SEEDS;
  const payload = readJson(path.resolve(seedFile), []);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.seeds)) return payload.seeds;
  return [];
}

export function selectPingAnHistoricalSeeds(seeds = [], planCodeFilter = new Set()) {
  const filters = planCodeFilter instanceof Set ? planCodeFilter : new Set();
  return (Array.isArray(seeds) ? seeds : [])
    .map((seed) => ({ ...seed, planCode: trim(seed?.planCode) }))
    .filter((seed) => seed.planCode && (!filters.size || filters.has(seed.planCode)));
}

export function buildPingAnHistoricalSeedPayload({ seeds = [], maxVersion = 3 } = {}) {
  return {
    mode: 'ping_an_historical_seed',
    company: '中国平安',
    maxVersion,
    seeds: (Array.isArray(seeds) ? seeds : []).map((seed) => ({
      ...seed,
      planCode: trim(seed.planCode),
      maxVersion: Number(seed.maxVersion || maxVersion || 3),
    })),
  };
}

export function withPingAnHistoricalBrowserOptions(payload, {
  cdpUrl = '',
  delayMs = 0,
  pdfRetryCount = 0,
  pdfRetryDelayMs = 0,
  archivePdf = false,
  pdfArchiveDir = '',
} = {}) {
  const next = { ...payload };
  if (trim(cdpUrl)) next.cdpUrl = trim(cdpUrl);
  if (Number(delayMs) > 0) next.delayMs = Number(delayMs);
  if (Number(pdfRetryCount) > 0) next.pdfRetryCount = Number(pdfRetryCount);
  if (Number(pdfRetryDelayMs) > 0) next.pdfRetryDelayMs = Number(pdfRetryDelayMs);
  if (archivePdf) next.archivePdf = true;
  if (trim(pdfArchiveDir)) next.pdfArchiveDir = trim(pdfArchiveDir);
  return next;
}

export function summarizeSkippedByReason(skipped = []) {
  return (Array.isArray(skipped) ? skipped : []).reduce((acc, item) => {
    const reason = trim(item?.reason) || 'unknown';
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});
}

export function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 160 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`中国平安历史产品种子爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中国平安历史产品种子爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

export function summarizeHistoricalSeedResult(result = {}, { write = false, dbPath = '', saved = [] } = {}) {
  return {
    ok: result.ok !== false,
    company: result.company || '中国平安',
    mode: write ? 'write' : 'dry-run',
    dbPath: write ? dbPath : '',
    seedCount: result.seedCount || 0,
    productCount: result.productCount || 0,
    crawledRecordCount: (result.records || []).length,
    skippedCount: result.skippedCount || 0,
    skippedByReason: summarizeSkippedByReason(result.skipped || []),
    savedRecordCount: saved.length,
    pdfArchiveDir: result.pdfArchiveDir || '',
    archivedPdfCount: result.archivedPdfCount || 0,
    records: (result.records || []).map((record) => ({
      productName: record.productName,
      title: record.title,
      url: record.url,
      planCode: record.planCode,
      versionNo: record.versionNo,
      catalogStatus: record.catalogStatus,
      parser: record.parser,
      pdfLocalPath: record.pdfLocalPath,
      pdfSha256: record.pdfSha256,
    })),
    skippedSamples: (result.skipped || []).slice(0, 10),
  };
}

async function writeRecords(records = [], { dbPath = '', seedStatePath = '' } = {}) {
  const knowledgeStore = await createKnowledgeStateStore({
    ...(trim(dbPath) ? { dbPath } : {}),
    ...(trim(seedStatePath) ? { seedStatePath } : {}),
  });
  try {
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
      saved,
      newSavedRecordCount: newSaved.length,
      newSavedMinId: newSavedIds[0] || null,
      newSavedMaxId: newSavedIds.at(-1) || null,
      localKnowledgeAfter: knowledgeStore.countKnowledgeRecords(),
    };
  } finally {
    knowledgeStore.close();
  }
}

async function main() {
  const seedFile = readArg('seed-file', process.env.PING_AN_HISTORICAL_SEED_FILE || '');
  const planCodes = parsePlanCodeFilter(readArg('plan-code', process.env.PING_AN_HISTORICAL_PLAN_CODE || ''));
  const maxVersion = readNumberArg('max-version', Number(process.env.PING_AN_HISTORICAL_MAX_VERSION || 3));
  const cdpUrl = readArg('cdp-url', process.env.PING_AN_CDP_URL || '');
  const delayMs = readNumberArg('delay-ms', Number(process.env.PING_AN_HISTORICAL_DELAY_MS || 0));
  const pdfRetryCount = readNumberArg('pdf-retry-count', Number(process.env.PING_AN_PDF_RETRY_COUNT || 0));
  const pdfRetryDelayMs = readNumberArg('pdf-retry-delay-ms', Number(process.env.PING_AN_PDF_RETRY_DELAY_MS || 0));
  const write = hasFlag('write') || process.env.PING_AN_HISTORICAL_WRITE === '1';
  const pdfArchiveDir = readArg('pdf-archive-dir', process.env.POLICY_PDF_ARCHIVE_DIR || '');
  const archivePdf = write || hasFlag('archive-pdf') || process.env.POLICY_PDF_ARCHIVE === '1' || Boolean(trim(pdfArchiveDir));
  const dbPath = readArg('db-path', process.env.POLICY_OCR_APP_DB_PATH || '');
  const seedStatePath = readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || '');

  const seeds = selectPingAnHistoricalSeeds(loadPingAnHistoricalSeeds(seedFile), planCodes);
  if (!seeds.length) {
    console.log(JSON.stringify({ ok: true, company: '中国平安', mode: write ? 'write' : 'dry-run', seedCount: 0, message: '没有匹配的历史种子' }, null, 2));
    return;
  }

  const payload = withPingAnHistoricalBrowserOptions(buildPingAnHistoricalSeedPayload({ seeds, maxVersion }), {
    cdpUrl,
    delayMs,
    pdfRetryCount,
    pdfRetryDelayMs,
    archivePdf,
    pdfArchiveDir,
  });
  const result = runCrawler(payload);
  if (result.ok === false) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

  if (!write) {
    console.log(JSON.stringify(summarizeHistoricalSeedResult(result), null, 2));
    return;
  }

  const writeResult = await writeRecords(result.records || [], { dbPath, seedStatePath });
  console.log(
    JSON.stringify(
      {
        ...summarizeHistoricalSeedResult(result, {
          write: true,
          dbPath: writeResult.dbPath,
          saved: writeResult.saved,
        }),
        newSavedRecordCount: writeResult.newSavedRecordCount,
        newSavedMinId: writeResult.newSavedMinId,
        newSavedMaxId: writeResult.newSavedMaxId,
        localKnowledgeAfter: writeResult.localKnowledgeAfter,
        pdfArchiveDir: result.pdfArchiveDir || '',
        archivedPdfCount: result.archivedPdfCount || 0,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
