import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { allocateId } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const cloakProjectDir = process.env.CLOAK_CRAWLER_PROJECT_DIR || '/Users/wenshuping/Documents/cloak-crawler-starter';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';
const productListEndpoint = 'https://life.pingan.com/ilife-home/product/getProductList';
const planPdfEndpoint = 'https://life.pingan.com/ilife-home/product/getPlanClausePdf';

function trim(value) {
  return String(value || '').trim();
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
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function materialUrl(planCode, versionNo, attachmentType) {
  const params = new URLSearchParams({ planCode, versionNo, attachmentType });
  return `${planPdfEndpoint}?${params.toString()}`;
}

function materialTasksForItem(item, saleType) {
  const productName = trim(item.clauseName || item.planDesc);
  const planCode = trim(item.actualPlanCode || item.planCode);
  const versionNo = trim(item.versionNo);
  if (!productName || !planCode || !versionNo) return [];
  const productType = trim(item.productLevel || item.productType);
  const endDate = trim(item.endDate);
  const salesStatus = saleType === 'Y' ? '在售' : endDate ? `停售（${endDate}）` : '停售';
  const base = {
    company: '中国平安',
    productName,
    productType,
    salesStatus,
    sourcePage: productListEndpoint,
    officialDomain: 'life.pingan.com',
  };
  const tasks = [];
  if (String(item.clauseContent) === '1') {
    tasks.push({
      ...base,
      title: `${productName}产品条款`,
      url: materialUrl(planCode, versionNo, '1'),
      materialType: 'terms',
    });
  }
  if (String(item.productInstruction) === '1') {
    tasks.push({
      ...base,
      title: `${productName}产品说明书`,
      url: materialUrl(planCode, versionNo, '7'),
      materialType: 'product_manual',
    });
  }
  return tasks;
}

function runCrawler(records, { maxWorkers, pdfArchiveDir }) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify({
      mode: 'reextract_responsibility_records',
      maxWorkers,
      archivePdf: true,
      ...(trim(pdfArchiveDir) ? { pdfArchiveDir: trim(pdfArchiveDir) } : {}),
      records,
    }),
    encoding: 'utf8',
    maxBuffer: 280 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`平安 cloak PDF 责任抽取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`平安 cloak PDF 责任抽取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

async function loadCloakLaunch() {
  const modulePath = path.join(cloakProjectDir, 'node_modules', 'cloakbrowser', 'dist', 'index.js');
  if (!fs.existsSync(modulePath)) {
    throw new Error(`未找到 cloakbrowser：${modulePath}。请先在 ${cloakProjectDir} 安装依赖。`);
  }
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.launch !== 'function') {
    throw new Error(`cloakbrowser 没有暴露 launch：${modulePath}`);
  }
  return module.launch;
}

async function fetchPingAnProducts({ saleType, headless }) {
  const launch = await loadCloakLaunch();
  const browser = await launch({ headless });
  try {
    const page = await browser.newPage();
    await page.goto('https://life.pingan.com/gongkaixinxipilu/baoxianchanpinmulujitiaokuan.jsp', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(1500);
    return await page.evaluate(async (requestPayload) => {
      const response = await fetch('/ilife-home/product/getProductList', {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestPayload),
      });
      const text = await response.text();
      const data = JSON.parse(text);
      return {
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        data,
      };
    }, {
      isOrNotSale: saleType,
      planSalesStatus: saleType,
      sourceCode: 'ilife-core',
      planCode: '',
      planDesc: '',
      isOnlyNew: 'Y',
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const saleType = trim(readArg('sale-type', process.env.PING_AN_SALE_TYPE || 'Y')) || 'Y';
  const offset = readNumberArg('offset', Number(process.env.PING_AN_OFFSET || 0));
  const maxProducts = readNumberArg('max-products', Number(process.env.PING_AN_MAX_PRODUCTS || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.PING_AN_MAX_WORKERS || 3)) || 3;
  const pdfArchiveDir = readArg('pdf-archive-dir', process.env.POLICY_PDF_ARCHIVE_DIR || '');
  const dryRun = process.argv.includes('--dry-run');
  const includeExisting = process.argv.includes('--include-existing');
  const headless = !process.argv.includes('--headed');

  const knowledgeStore = await createKnowledgeStateStore();
  try {
  const state = knowledgeStore.loadState();
  const before = knowledgeStore.countKnowledgeRecords();
  const knownUrls = new Set(knowledgeStore.allKnownUrls());
  const response = await fetchPingAnProducts({ saleType, headless });
  const data = response.data && typeof response.data.data === 'object' ? response.data.data : response.data;
  const code = trim(data?.CODE || data?.code);
  const message = trim(data?.MSG || data?.msg);
  const items = Array.isArray(data?.DATA) ? data.DATA : [];
  if (code && code !== '00') {
    console.log(JSON.stringify({ ok: false, code, message, status: response.status, saleType }, null, 2));
    process.exitCode = 2;
    return;
  }

  const selectedItems = maxProducts ? items.slice(offset, offset + maxProducts) : items.slice(offset);
  const allTasks = selectedItems.flatMap((item) => materialTasksForItem(item, saleType));
  const tasks = includeExisting ? allTasks : allTasks.filter((task) => !knownUrls.has(trim(task.url)));
  const tasksPath = path.join(runtimeDir, `ping-an-cloak-tasks-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  writeJson(tasksPath, {
    saleType,
    offset,
    maxProducts,
    totalProductCount: items.length,
    selectedProductCount: selectedItems.length,
    materialTaskCount: allTasks.length,
    skippedExistingTaskCount: allTasks.length - tasks.length,
    tasks,
  });

  if (dryRun || !tasks.length) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun,
          saleType,
          status: response.status,
          code: code || '',
          message,
          totalProductCount: items.length,
          selectedProductCount: selectedItems.length,
          materialTaskCount: allTasks.length,
          skippedExistingTaskCount: allTasks.length - tasks.length,
          selectedTaskCount: tasks.length,
          tasksPath,
          localKnowledgeBefore: before,
          dbPath: knowledgeStore.dbPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = runCrawler(tasks, { maxWorkers, pdfArchiveDir });
  const records = (result.records || []).map((record) => ({
    ...record,
    parser: 'scrapling_ping_an_cloak_product_info',
  }));
  const saved = upsertKnowledgeRecords(state, records, { allocateId });
  knowledgeStore.saveState(state);
  const after = knowledgeStore.countKnowledgeRecords();

  console.log(
    JSON.stringify(
      {
        ok: true,
        company: '中国平安',
        saleType,
        status: response.status,
        code: code || '',
        message,
        totalProductCount: items.length,
        selectedProductCount: selectedItems.length,
        materialTaskCount: allTasks.length,
        skippedExistingTaskCount: allTasks.length - tasks.length,
        selectedTaskCount: tasks.length,
        crawledRecordCount: records.length,
        skippedCount: Array.isArray(result.skipped) ? result.skipped.length : 0,
        savedRecordCount: saved.length,
        newSavedRecordCount: saved.filter((record) => !knownUrls.has(trim(record.url))).length,
        localKnowledgeBefore: before,
        localKnowledgeAfter: after,
        dbPath: knowledgeStore.dbPath,
        tasksPath,
        pdfArchiveDir: result.pdfArchiveDir || '',
        archivedPdfCount: result.archivedPdfCount || 0,
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
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
