import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocateId, createInitialState } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const statePath = path.resolve(process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'));
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 420 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`复星联合健康批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`复星联合健康批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function summarizeQuality(records) {
  return records.reduce((acc, record) => {
    const status = String(record.qualityStatus || record.responsibilityQualityStatus || 'unknown');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function applyCrawlerMetadata(savedRecords, crawledRecords) {
  const crawledByUrl = new Map((crawledRecords || []).map((record) => [String(record.url || ''), record]));
  for (const saved of savedRecords || []) {
    const crawled = crawledByUrl.get(String(saved.url || ''));
    if (!crawled) continue;
    saved.qualityStatus = crawled.qualityStatus || crawled.responsibilityQualityStatus || saved.qualityStatus;
    saved.qualityReason = crawled.qualityReason || crawled.responsibilityQualityIssue || saved.qualityReason;
    saved.responsibilityQualityStatus = crawled.responsibilityQualityStatus || crawled.qualityStatus || saved.responsibilityQualityStatus;
    saved.responsibilityQualityIssue = crawled.responsibilityQualityIssue || crawled.qualityReason || saved.responsibilityQualityIssue;
    saved.sourceList = crawled.sourceList || saved.sourceList;
    saved.segment = crawled.segment || saved.segment;
    saved.productCode = crawled.productCode || saved.productCode;
    saved.startOfSaleDate = crawled.startOfSaleDate || saved.startOfSaleDate;
    saved.endOfSaleDate = crawled.endOfSaleDate || saved.endOfSaleDate;
  }
}

function main() {
  const saleStatus = readArg('sale-status', process.env.FOSUN_UHI_SALE_STATUS || 'all');
  const segment = readArg('segment', process.env.FOSUN_UHI_SEGMENT || 'all');
  const offset = readNumberArg('offset', Number(process.env.FOSUN_UHI_OFFSET || 0));
  const maxProducts = readNumberArg('max-products', Number(process.env.FOSUN_UHI_MAX_PRODUCTS || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.FOSUN_UHI_MAX_WORKERS || 4));
  const productName = readArg('product-name', process.env.FOSUN_UHI_PRODUCT_NAME || '');

  const result = runCrawler({
    mode: 'fosun_uhi_health_pages',
    company: '复星联合健康保险',
    saleStatus,
    segment,
    offset,
    maxProducts,
    maxWorkers,
    productName,
  });

  const state = readJson(statePath, createInitialState());
  if (!Number(state.nextId)) state.nextId = 1;
  const before = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  const beforeUrls = new Set((state.knowledgeRecords || []).map((record) => String(record.url || '')).filter(Boolean));
  const saved = upsertKnowledgeRecords(state, result.records || [], { allocateId });
  applyCrawlerMetadata(saved, result.records || []);
  const after = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(String(record.url)));
  const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
  writeJson(statePath, state);

  console.log(
    JSON.stringify(
      {
        ok: true,
        company: result.company || '复星联合健康保险',
        saleStatus,
        segment,
        offset,
        maxProducts,
        maxWorkers,
        productName,
        totalCandidateProductCount: result.totalCandidateProductCount || 0,
        source: result.source,
        pageCount: (result.pages || []).length,
        pages: result.pages || [],
        productCount: (result.products || []).length,
        materialTaskCount: result.materialTaskCount || 0,
        crawledRecordCount: (result.records || []).length,
        crawledQualitySplit: summarizeQuality(result.records || []),
        savedRecordCount: saved.length,
        newSavedRecordCount: newSaved.length,
        newSavedMinId: newSavedIds[0] || null,
        newSavedMaxId: newSavedIds.at(-1) || null,
        localKnowledgeBefore: before,
        localKnowledgeAfter: after,
        statePath,
      },
      null,
      2,
    ),
  );
}

main();
