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
    maxBuffer: 100 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`中国平安批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中国平安批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function main() {
  const saleType = readArg('sale-type', process.env.PING_AN_SALE_TYPE || 'Y');
  const offset = Math.max(0, Number(readArg('offset', process.env.PING_AN_OFFSET || 0)) || 0);
  const maxProducts = readNumberArg('max-products', Number(process.env.PING_AN_MAX_PRODUCTS || 0));
  const cdpUrl = readArg('cdp-url', process.env.PING_AN_CDP_URL || 'http://127.0.0.1:9223');

  const result = runCrawler({
    mode: 'ping_an_browser_pages',
    company: '中国平安',
    saleType,
    offset,
    maxProducts,
    cdpUrl,
  });

  if (result.ok === false) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

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
        company: result.company || '中国平安',
        saleType,
        offset,
        maxProducts,
        pages: result.pages || [],
        productCount: (result.products || []).length,
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
