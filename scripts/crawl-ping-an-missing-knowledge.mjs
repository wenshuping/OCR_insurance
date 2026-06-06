import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocateId } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const catalogPath = path.resolve(process.env.PING_AN_CATALOG_PATH || path.join(runtimeDir, 'ping-an-product-catalog.json'));
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

function trim(value) {
  return String(value || '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function runCrawler(payload) {
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
    throw new Error(`中国平安缺失资料补爬失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中国平安缺失资料补爬没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function buildExistingUrls(state) {
  return new Set(
    (Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : [])
      .filter((record) => trim(record.company) === '中国平安')
      .map((record) => trim(record.url))
      .filter(Boolean),
  );
}

function allowedStatusSet(value) {
  const raw = trim(value) || 'missing,partial';
  const aliases = {
    missing: '未入库',
    partial: '部分入库',
    done: '已入库',
  };
  return new Set(
    raw
      .split(/[,，]/u)
      .map((item) => trim(item))
      .filter(Boolean)
      .map((item) => aliases[item] || item),
  );
}

function pushTask(tasks, product, url, label, materialType, existingUrls) {
  const materialUrl = trim(url);
  if (!materialUrl || existingUrls.has(materialUrl)) return;
  tasks.push({
    productName: trim(product.productName),
    productType: trim(product.productType),
    salesStatus: trim(product.salesStatus),
    label,
    materialType,
    url: materialUrl,
  });
}

function buildTasks({ catalog, state, saleType, statuses }) {
  const existingUrls = buildExistingUrls(state);
  const statusSet = allowedStatusSet(statuses);
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const tasks = [];
  for (const product of products) {
    if (saleType && trim(product.saleType) !== saleType) continue;
    if (!statusSet.has(trim(product.knowledgeStatus))) continue;
    if (product.hasTerms) pushTask(tasks, product, product.termsUrl, '产品条款', 'terms', existingUrls);
    if (product.hasProductManual) pushTask(tasks, product, product.productManualUrl, '产品说明书', 'product_manual', existingUrls);
  }
  return tasks;
}

async function main() {
  const saleType = trim(readArg('sale-type', process.env.PING_AN_MISSING_SALE_TYPE || ''));
  const statuses = readArg('status', process.env.PING_AN_MISSING_STATUS || 'missing,partial');
  const offset = readNumberArg('offset', Number(process.env.PING_AN_MISSING_OFFSET || 0));
  const limit = readNumberArg('limit', Number(process.env.PING_AN_MISSING_LIMIT || 50));
  const cdpUrl = readArg('cdp-url', process.env.PING_AN_CDP_URL || 'http://127.0.0.1:9223');
  const catalog = readJson(catalogPath, {});
  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const taskState = knowledgeStore.loadState();
    const allTasks = buildTasks({ catalog, state: taskState, saleType, statuses });
    const selectedTasks = limit ? allTasks.slice(offset, offset + limit) : allTasks.slice(offset);
    if (!selectedTasks.length) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            company: '中国平安',
            catalogPath,
            dbPath: knowledgeStore.dbPath,
            saleType,
            statuses,
            offset,
            limit,
            totalMissingMaterialTasks: allTasks.length,
            selectedTaskCount: 0,
            message: '没有需要补爬的缺失资料',
          },
          null,
          2,
        ),
      );
      return;
    }

    const result = runCrawler({
      mode: 'ping_an_browser_catalog_materials',
      company: '中国平安',
      cdpUrl,
      tasks: selectedTasks,
    });
    if (result.ok === false) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 2;
      return;
    }
    const state = knowledgeStore.loadState();
    if (!Number(state.nextId)) state.nextId = 1;
    const before = knowledgeStore.countKnowledgeRecords();
    const beforeUrls = new Set(knowledgeStore.allKnownUrls());
    const saved = upsertKnowledgeRecords(state, result.records || [], { allocateId });
    knowledgeStore.saveState(state);
    const after = knowledgeStore.countKnowledgeRecords();
    const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(trim(record.url)));
    const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);

    console.log(
      JSON.stringify(
        {
          ok: true,
          company: '中国平安',
          catalogPath,
          dbPath: knowledgeStore.dbPath,
          saleType,
          statuses,
          offset,
          limit,
          totalMissingMaterialTasks: allTasks.length,
          selectedTaskCount: selectedTasks.length,
          crawledRecordCount: (result.records || []).length,
          skippedCount: result.skippedCount || 0,
          skippedSamples: (result.skipped || []).slice(0, 10),
          savedRecordCount: saved.length,
          newSavedRecordCount: newSaved.length,
          newSavedMinId: newSavedIds[0] || null,
          newSavedMaxId: newSavedIds.at(-1) || null,
          localKnowledgeBefore: before,
          localKnowledgeAfter: after,
        },
        null,
        2,
      ),
    );
  } finally {
    knowledgeStore.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
