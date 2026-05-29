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

function readBooleanArg(name, fallback = false) {
  const value = readArg(name, '');
  if (!value) return process.argv.includes(`--${name}`) || fallback;
  return !['0', 'false', 'no'].includes(value.toLowerCase());
}

function knownCompanyUrls(state, company) {
  return (state.knowledgeRecords || [])
    .filter((record) => String(record.company || '').trim() === company)
    .map((record) => String(record.url || '').trim())
    .filter(Boolean);
}

function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`中国人寿批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中国人寿批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function main() {
  const saleType = readArg('sale-type', process.env.CHINA_LIFE_SALE_TYPE || '1');
  const startPage = readNumberArg('start-page', Number(process.env.CHINA_LIFE_START_PAGE || 1));
  const maxPages = readNumberArg('max-pages', Number(process.env.CHINA_LIFE_MAX_PAGES || 1));
  const pageSize = readNumberArg('page-size', Number(process.env.CHINA_LIFE_PAGE_SIZE || 15));
  const skipExisting = readBooleanArg('skip-existing', true);
  const skipState = readJson(statePath, createInitialState());
  const skipUrls = skipExisting ? knownCompanyUrls(skipState, '中国人寿') : [];

  const result = runCrawler({
    mode: 'china_life_pages',
    company: '中国人寿',
    saleType,
    startPage,
    maxPages,
    pageSize,
    skipUrls,
  });

  const state = readJson(statePath, createInitialState());
  if (!Number(state.nextId)) state.nextId = 1;
  const before = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  const saved = upsertKnowledgeRecords(state, result.records || [], { allocateId });
  const after = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  writeJson(statePath, state);

  console.log(
    JSON.stringify(
      {
        ok: true,
        company: result.company || '中国人寿',
        saleType,
        startPage,
        maxPages,
        pageSize,
        pages: result.pages || [],
        productCount: (result.products || []).length,
        skipExisting,
        skippedExistingUrlCount: skipUrls.length,
        crawledRecordCount: (result.records || []).length,
        savedRecordCount: saved.length,
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
