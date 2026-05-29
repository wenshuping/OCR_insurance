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
    maxBuffer: 720 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    const stdoutTail = String(result.stdout || '').slice(-4000);
    const stderrTail = String(result.stderr || '').slice(-4000);
    throw new Error(
      `中华人寿批量爬取失败 status=${result.status} signal=${result.signal || ''} error=${result.error?.message || ''}\n${stderrTail || stdoutTail}`,
    );
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中华人寿批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function main() {
  const source = readArg('source', process.env.CHINA_UNITED_LIFE_SOURCE || 'all');
  const saleStatus = readArg('sale-status', process.env.CHINA_UNITED_LIFE_SALE_STATUS || 'all');
  const maxProducts = readNumberArg('max-products', Number(process.env.CHINA_UNITED_LIFE_MAX_PRODUCTS || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.CHINA_UNITED_LIFE_MAX_WORKERS || 6));
  const pageSize = readNumberArg('page-size', Number(process.env.CHINA_UNITED_LIFE_PAGE_SIZE || 20));

  const result = runCrawler({
    mode: 'china_united_life_pages',
    company: '中华人寿',
    source,
    saleStatus,
    maxProducts,
    maxWorkers,
    pageSize,
  });
  if (!result.ok) {
    throw new Error(`中华人寿爬取未完成：${result.code || ''} ${result.message || ''}`.trim());
  }

  const state = readJson(statePath, createInitialState());
  if (!Number(state.nextId)) state.nextId = 1;
  const before = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  const beforeUrls = new Set((state.knowledgeRecords || []).map((record) => String(record.url || '')).filter(Boolean));
  const saved = upsertKnowledgeRecords(state, result.records || [], { allocateId });
  const after = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(String(record.url)));
  const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
  writeJson(statePath, state);

  console.log(
    JSON.stringify(
      {
        ok: true,
        company: result.company || '中华人寿',
        sourceMode: source,
        saleStatus,
        maxProducts,
        maxWorkers,
        pageSize,
        source: result.source,
        endpoint: result.endpoint,
        pageCount: (result.pages || []).length,
        pages: result.pages || [],
        productCount: (result.products || []).length,
        materialTaskCount: result.materialTaskCount || 0,
        crawledRecordCount: (result.records || []).length,
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
