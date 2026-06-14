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

function readNonNegativeNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBooleanArg(name, fallback = false) {
  const value = readArg(name, '');
  if (!value) return fallback;
  return /^(?:1|true|yes|y)$/iu.test(value);
}

function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 360 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`瑞泰人寿批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`瑞泰人寿批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function main() {
  const maxProducts = readNumberArg('max-products', Number(process.env.RUITAI_LIFE_MAX_PRODUCTS || 0));
  const offset = readNonNegativeNumberArg('offset', Number(process.env.RUITAI_LIFE_OFFSET || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.RUITAI_LIFE_MAX_WORKERS || 4));
  const newOnly = readBooleanArg('new-only', process.env.RUITAI_LIFE_NEW_ONLY === '1');

  const stateBefore = readJson(statePath, createInitialState());
  const beforeUrls = new Set((stateBefore.knowledgeRecords || []).map((record) => String(record.url || '')).filter(Boolean));

  const result = runCrawler({
    mode: 'ruitai_life_pages',
    company: '瑞泰人寿',
    maxProducts,
    offset,
    maxWorkers,
    skipUrls: newOnly ? [...beforeUrls] : [],
  });

  const state = readJson(statePath, createInitialState());
  if (!Number(state.nextId)) state.nextId = 1;
  const before = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  const recordsToSave = newOnly
    ? (result.records || []).filter((record) => record?.url && !beforeUrls.has(String(record.url)))
    : result.records || [];
  const saved = upsertKnowledgeRecords(state, recordsToSave, { allocateId });
  const after = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(String(record.url)));
  const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
  writeJson(statePath, state);

  console.log(
    JSON.stringify(
      {
        ok: true,
        company: result.company || '瑞泰人寿',
        maxProducts,
        offset,
        maxWorkers,
        newOnly,
        source: result.source,
        officialDomain: result.officialDomain,
        pageCount: (result.pages || []).length,
        pages: result.pages || [],
        productCount: (result.products || []).length,
        materialTaskCount: result.materialTaskCount || 0,
        crawledRecordCount: (result.records || []).length,
        recordsToSaveCount: recordsToSave.length,
        savedRecordCount: saved.length,
        newSavedRecordCount: newSaved.length,
        newSavedMinId: newSavedIds[0] || null,
        newSavedMaxId: newSavedIds.at(-1) || null,
        qualitySplit: result.qualitySplit || {},
        statusSplit: result.statusSplit || {},
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
