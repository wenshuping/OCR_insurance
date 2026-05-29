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

function readNonNegativeNumberArg(name, fallback = 0) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBooleanArg(name, fallback = false) {
  const value = readArg(name, '');
  if (!value) return process.argv.includes(`--${name}`) || fallback;
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
}

function readStringListFile(filePath) {
  if (!filePath) return [];
  const value = readJson(path.resolve(filePath), []);
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
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
    maxBuffer: 120 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`中国太平批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中国太平批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function main() {
  const startId = readNumberArg('start-id', Number(process.env.CHINA_TAIPING_START_ID || 1000));
  const endId = readNumberArg('end-id', Number(process.env.CHINA_TAIPING_END_ID || 4210));
  const maxProducts = readNumberArg('max-products', Number(process.env.CHINA_TAIPING_MAX_PRODUCTS || 0));
  const maxRecords = readNumberArg('max-records', Number(process.env.CHINA_TAIPING_MAX_RECORDS || 0));
  const offset = readNonNegativeNumberArg('offset', Number(process.env.CHINA_TAIPING_OFFSET || 0));
  const concurrency = readNumberArg('concurrency', Number(process.env.CHINA_TAIPING_CONCURRENCY || 24));
  const timeoutSeconds = Number(readArg('timeout-seconds', process.env.CHINA_TAIPING_TIMEOUT_SECONDS || 1.5)) || 1.5;
  const includeCompound = readBooleanArg('include-compound', true);
  const material = readArg('material', process.env.CHINA_TAIPING_MATERIAL || 'all');
  const htmlPathArg = readArg('html-path', process.env.CHINA_TAIPING_HTML_PATH || '');
  const htmlPath = htmlPathArg ? path.resolve(htmlPathArg) : '';
  const urls = readStringListFile(readArg('urls-file', process.env.CHINA_TAIPING_URLS_FILE || ''));
  const scanRange = urls.length ? readBooleanArg('scan-range', false) : true;
  const skipExisting = readBooleanArg('skip-existing', true);
  const skipState = readJson(statePath, createInitialState());
  const skipUrls = skipExisting ? knownCompanyUrls(skipState, '中国太平') : [];

  const payload = htmlPath
    ? {
        mode: 'china_taiping_disclosure_html',
        company: '中国太平',
        htmlPath,
        offset,
        maxRecords,
        concurrency,
        material,
        skipUrls,
      }
    : {
        mode: 'china_taiping_pages',
        company: '中国太平',
        startId,
        endId,
        maxProducts,
        concurrency,
        timeoutSeconds,
        includeCompound,
        scanRange,
        urls,
        skipUrls,
      };

  const result = runCrawler(payload);

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
        company: result.company || '中国太平',
        mode: payload.mode,
        startId,
        endId,
        maxProducts,
        maxRecords,
        offset,
        material,
        htmlPath,
        concurrency,
        timeoutSeconds,
        urlsFileRecordCount: urls.length,
        scannedUrlCount: result.scannedUrlCount || 0,
        matchedPageCount: result.matchedPageCount || 0,
        discoveredMaterialCount: result.discoveredMaterialCount || 0,
        filteredMaterialCount: result.filteredMaterialCount || 0,
        selectedMaterialCount: result.selectedMaterialCount || 0,
        productCount: (result.products || []).length,
        skipExisting,
        skippedExistingUrlCount: skipUrls.length,
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
