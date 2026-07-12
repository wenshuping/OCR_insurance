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
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || projectRoot;
const cloakProjectDir = process.env.CLOAK_CRAWLER_PROJECT_DIR || '/Users/wenshuping/Documents/cloak-crawler-starter';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';
const officialBaseUrl = 'https://www.cathaylife.cn/';
const filingUrl = 'https://www.cathaylife.cn/bacpnew/index.html';
const productPages = [
  { url: 'https://www.cathaylife.cn/zscpnew/index.html', salesStatus: '在售' },
  { url: 'https://www.cathaylife.cn/tscpnew/index.html', salesStatus: '停售（2023年7月1日后）' },
  { url: 'https://www.cathaylife.cn/lstsnew/index.html', salesStatus: '停售（历史：2023年6月30日前）' },
];
const tableCategories = {
  1: '人寿保险',
  2: '年金保险',
  3: '健康保险',
  4: '意外保险',
};

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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function saleStatusFilter(value) {
  const text = trim(value).toLowerCase();
  if (!text || text === 'all' || text === '全部') return new Set(productPages.map((page) => page.salesStatus));
  if (['available', 'in_sale', 'sale', '在售', 'y', '1'].includes(text)) return new Set(['在售']);
  if (['discontinued', 'stopped', 'stop', '停售', 'n', '0'].includes(text)) {
    return new Set(productPages.filter((page) => page.salesStatus.startsWith('停售')).map((page) => page.salesStatus));
  }
  if (trim(value).includes('历史')) return new Set(['停售（历史：2023年6月30日前）']);
  return new Set(productPages.filter((page) => page.salesStatus.startsWith(value) || page.salesStatus === value).map((page) => page.salesStatus));
}

function selectedProductPages(saleStatus) {
  const selected = saleStatusFilter(saleStatus);
  return productPages.filter((page) => selected.has(page.salesStatus));
}

function productType(productName, category = '') {
  if (trim(category)) return trim(category);
  const name = trim(productName);
  if (name.includes('重大疾病') || name.includes('癌症') || name.includes('防癌') || name.includes('疾病')) return '健康保险';
  if (name.includes('医疗') || name.includes('护理') || name.includes('特定药品') || name.includes('津贴')) return '健康保险';
  if (name.includes('意外') || name.includes('交通') || name.includes('旅行') || name.includes('驾乘')) return '意外保险';
  if (name.includes('年金') || name.includes('养老')) return '年金保险';
  if (name.includes('两全') || name.includes('终身寿险') || name.includes('定期寿险') || name.endsWith('寿险')) return '人寿保险';
  if (name.includes('团体')) return '团体保险';
  return '';
}

function materialType(label) {
  return trim(label).includes('说明') ? 'product_manual' : 'terms';
}

function keepMaterial(label, url) {
  if (!trim(label) || !trim(url)) return false;
  if (!trim(url).toLowerCase().includes('.pdf')) return false;
  if (trim(label).includes('规则') || /(费率|现金价值|投保|职业|健康告知|利益演示|红利实现率|信息披露|公告|须知|问卷)/u.test(label)) {
    return false;
  }
  return label.includes('条款') || label.includes('产品说明') || label.includes('说明文档') || label.includes('说明书') || label === '文件下载';
}

async function loadCloakLaunch() {
  const modulePath = path.join(cloakProjectDir, 'node_modules', 'cloakbrowser', 'dist', 'index.js');
  if (!fs.existsSync(modulePath)) {
    throw new Error(`未找到 cloakbrowser：${modulePath}`);
  }
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.launch !== 'function') throw new Error(`cloakbrowser 未暴露 launch：${modulePath}`);
  return module.launch;
}

async function withCloakPage(headless, callback) {
  const launch = await loadCloakLaunch();
  const browser = await launch({ headless });
  try {
    const page = await browser.newPage();
    await page.goto(officialBaseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout?.(1200);
    return await callback(page);
  } finally {
    await browser.close();
  }
}

async function extractTablePage(page, pageInfo) {
  let lastResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (attempt > 1) {
        await page.goto(officialBaseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout?.(800 * attempt);
      }
      const response = await page.goto(pageInfo.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout?.(2000 * attempt);
      const extracted = await page.evaluate(() => ({
        title: document.title,
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim(),
        rows: Array.from(document.querySelectorAll('table')).flatMap((table, tableIndex) => {
          const tableHeader = Array.from(table.querySelectorAll('tr:first-child th, tr:first-child td'))
            .map((cell) => (cell.innerText || '').replace(/\s+/g, ' ').trim())
            .join(' ');
          return Array.from(table.querySelectorAll('tr')).slice(1).map((row) => {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 2) return null;
            return {
              tableIndex,
              tableHeader,
              productName: (cells[0].innerText || '').replace(/\s+/g, ' ').trim(),
              productClass: (cells[2]?.innerText || '').replace(/\s+/g, ' ').trim(),
              rawText: row.innerText || '',
              materials: Array.from(cells[1].querySelectorAll('a')).map((anchor) => ({
                label: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim(),
                url: anchor.href || '',
              })),
            };
          }).filter(Boolean);
        }),
      }));
      const rows = Array.isArray(extracted.rows) ? extracted.rows : [];
      const verificationText = /确认您是真人|正在验证您是否是真人|需要先检查您的连接/u.test(extracted.bodyText);
      lastResult = {
        ok: rows.length > 0,
        code: rows.length ? '' : verificationText ? 'CATHAY_LIFE_HUMAN_VERIFICATION_REQUIRED' : 'CATHAY_LIFE_EMPTY_TABLE',
        url: pageInfo.url,
        salesStatus: pageInfo.salesStatus,
        status: response?.status?.() ?? null,
        title: extracted.title,
        rows,
        bodyTextPreview: extracted.bodyText.slice(0, 240),
      };
      if (rows.length > 0) return lastResult;
    } catch (error) {
      lastResult = {
        ok: false,
        code: 'CATHAY_LIFE_PAGE_EVALUATE_FAILED',
        url: pageInfo.url,
        salesStatus: pageInfo.salesStatus,
        status: null,
        title: '',
        rows: [],
        bodyTextPreview: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      };
    }
  }
  return lastResult;
}

async function extractProductPages({ saleStatus, headless }) {
  return await withCloakPage(headless, async (page) => {
    const pages = [];
    for (const pageInfo of selectedProductPages(saleStatus)) {
      pages.push(await extractTablePage(page, pageInfo));
    }
    return pages;
  });
}

async function extractFilingPage({ headless }) {
  return await withCloakPage(headless, async (page) => [await extractTablePage(page, { url: filingUrl, salesStatus: '备案信息' })]);
}

function buildProductTasks({ pages, maxProducts, productOffset }) {
  const products = [];
  const tasks = [];
  const pageSummaries = [];
  const seenProducts = new Set();
  const selectedProducts = new Set();
  const seenTasks = new Set();
  let productIndex = 0;

  for (const pageResult of pages) {
    if (!pageResult.ok) {
      pageSummaries.push({
        url: pageResult.url,
        status: pageResult.status,
        salesStatus: pageResult.salesStatus,
        ok: false,
        code: pageResult.code,
        productCount: 0,
        materialTaskCount: 0,
      });
      continue;
    }
    const productCategories = new Map();
    for (const row of pageResult.rows || []) {
      const productName = trim(row.productName);
      const category = tableCategories[Number(row.tableIndex)] || '';
      if (productName && category) productCategories.set(productName, category);
    }
    for (const row of pageResult.rows || []) {
      const productName = trim(row.productName);
      if (!productName) continue;
      const productKey = `${pageResult.salesStatus}|${productName}`;
      if (!seenProducts.has(productKey)) {
        seenProducts.add(productKey);
        productIndex += 1;
        if (productIndex <= productOffset) continue;
        if (maxProducts && selectedProducts.size >= maxProducts) continue;
        selectedProducts.add(productKey);
        const category = productCategories.get(productName) || tableCategories[Number(row.tableIndex)] || '';
        products.push({
          company: '陆家嘴国泰人寿',
          productName,
          productType: productType(productName, category),
          salesStatus: trim(pageResult.salesStatus),
          sourcePage: trim(pageResult.url),
          productClass: trim(row.productClass),
        });
      }
      if (!selectedProducts.has(productKey)) continue;
      const category = productCategories.get(productName) || tableCategories[Number(row.tableIndex)] || '';
      const type = productType(productName, category);
      for (const material of row.materials || []) {
        let label = trim(material.label);
        const materialUrl = trim(material.url);
        if (label === '文件下载' && trim(row.tableHeader).includes('产品条款')) label = '产品条款';
        if (!keepMaterial(label, materialUrl)) continue;
        const taskKey = `${productKey}|${materialUrl}`;
        if (seenTasks.has(taskKey)) continue;
        seenTasks.add(taskKey);
        tasks.push({
          company: '陆家嘴国泰人寿',
          productName,
          productType: type,
          salesStatus: trim(pageResult.salesStatus),
          title: `${productName}${label}`,
          label,
          url: materialUrl,
          sourcePage: trim(pageResult.url),
          materialType: materialType(label),
          officialDomain: 'www.cathaylife.cn',
        });
      }
    }
    pageSummaries.push({
      url: pageResult.url,
      status: pageResult.status,
      salesStatus: pageResult.salesStatus,
      ok: true,
      productCount: products.filter((product) => product.sourcePage === pageResult.url).length,
      materialTaskCount: tasks.filter((task) => task.sourcePage === pageResult.url).length,
    });
  }
  return { products, tasks, pages: pageSummaries };
}

function buildFilingTasks({ pages, maxProducts, productOffset, knownUrls, includeExisting }) {
  const products = [];
  const tasks = [];
  const pageSummaries = [];
  const knownEntries = Array.from(knownUrls).filter((url) => url.includes('#entry='));
  const seenProducts = new Set();
  const selectedProducts = new Set();
  const seenZipUrls = new Set();
  let productIndex = 0;

  for (const pageResult of pages) {
    if (!pageResult.ok) {
      pageSummaries.push({
        url: pageResult.url,
        status: pageResult.status,
        salesStatus: '备案信息',
        ok: false,
        code: pageResult.code,
        productCount: 0,
        materialTaskCount: 0,
      });
      continue;
    }
    for (const row of pageResult.rows || []) {
      const productName = trim(row.productName);
      if (!productName) continue;
      const productKey = `备案信息|${productName}`;
      if (!seenProducts.has(productKey)) {
        seenProducts.add(productKey);
        productIndex += 1;
        if (productIndex <= productOffset) continue;
        if (maxProducts && selectedProducts.size >= maxProducts) continue;
        selectedProducts.add(productKey);
        products.push({
          company: '陆家嘴国泰人寿',
          productName,
          productType: productType(productName),
          salesStatus: '备案信息',
          sourcePage: filingUrl,
        });
      }
      if (!selectedProducts.has(productKey)) continue;
      for (const material of row.materials || []) {
        const zipUrl = trim(material.url);
        if (!zipUrl.toLowerCase().endsWith('.zip') || seenZipUrls.has(zipUrl)) continue;
        if (!includeExisting && knownEntries.some((url) => url.startsWith(`${zipUrl}#entry=`))) continue;
        seenZipUrls.add(zipUrl);
        tasks.push({
          company: '陆家嘴国泰人寿',
          productName,
          productType: productType(productName),
          salesStatus: '备案信息',
          url: zipUrl,
          sourcePage: filingUrl,
          officialDomain: 'www.cathaylife.cn',
        });
      }
    }
    pageSummaries.push({
      url: pageResult.url,
      status: pageResult.status,
      salesStatus: '备案信息',
      ok: true,
      productCount: products.length,
      materialTaskCount: tasks.length,
    });
  }
  return { products, tasks, pages: pageSummaries };
}

async function downloadMaterials({ tasks, headless, materialDir, kind }) {
  fs.mkdirSync(materialDir, { recursive: true });
  return await withCloakPage(headless, async (page) => {
    const downloaded = [];
    const failed = [];
    let currentSourcePage = '';
    for (const [index, task] of tasks.entries()) {
      let saved = false;
      let lastFailure = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const sourcePage = trim(task.sourcePage);
          if (sourcePage && (sourcePage !== currentSourcePage || attempt > 1)) {
            if (attempt > 1) {
              await page.goto(officialBaseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
              await page.waitForTimeout?.(800 * attempt);
            }
            await page.goto(sourcePage, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout?.(1200 * attempt);
            currentSourcePage = sourcePage;
          }
          const response = await page.evaluate(async ({ url, accept }) => {
            const fetchResponse = await fetch(url, {
              credentials: 'include',
              headers: { accept },
            });
            const buffer = await fetchResponse.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            const chunkSize = 0x8000;
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
              binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
            }
            return {
              status: fetchResponse.status,
              contentType: fetchResponse.headers.get('content-type') || '',
              byteLength: buffer.byteLength,
              base64: btoa(binary),
            };
          }, {
            url: task.url,
            accept: kind === 'zip' ? 'application/zip,application/octet-stream,*/*' : 'application/pdf,*/*',
          });
          const data = Buffer.from(response.base64 || '', 'base64');
          const isValid = kind === 'zip' ? data.subarray(0, 2).toString('utf8') === 'PK' : data.subarray(0, 4).toString('utf8') === '%PDF';
          if (response.status < 200 || response.status >= 300 || !isValid) {
            lastFailure = {
              productName: task.productName,
              url: task.url,
              status: response.status,
              contentType: response.contentType,
              bytes: response.byteLength,
              reason: `${kind}_unavailable`,
            };
            currentSourcePage = '';
            continue;
          }
          const filePath = path.join(materialDir, `${String(index + 1).padStart(4, '0')}.${kind}`);
          fs.writeFileSync(filePath, data);
          downloaded.push({
            ...task,
            contentType: response.contentType,
            bytes: response.byteLength,
            ...(kind === 'zip' ? { zipPath: filePath } : { pdfPath: filePath }),
          });
          saved = true;
          break;
        } catch (error) {
          lastFailure = {
            productName: task.productName,
            url: task.url,
            reason: error instanceof Error ? error.message : String(error),
          };
          currentSourcePage = '';
        }
      }
      if (!saved) {
        if (lastFailure) {
          failed.push(lastFailure);
        } else {
          failed.push({
            productName: task.productName,
            url: task.url,
            reason: `${kind}_unavailable`,
          });
        }
      }
    }
    return { downloaded, failed };
  });
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
    throw new Error(`陆家嘴国泰 cloak 责任抽取失败 status=${result.status}\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`陆家嘴国泰 cloak 责任抽取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function normalizeRecord(record, parser) {
  return {
    ...record,
    parser,
    qualityStatus: trim(record.qualityStatus) || 'valid_complete',
    responsibilityQualityStatus: trim(record.responsibilityQualityStatus) || 'valid_complete',
    responsibilityQualityIssue: trim(record.responsibilityQualityIssue),
  };
}

async function main() {
  const source = trim(readArg('source', process.env.CATHAY_LIFE_SOURCE || 'product-info')) || 'product-info';
  const saleStatus = readArg('sale-status', process.env.CATHAY_LIFE_SALE_STATUS || 'all');
  const maxProducts = readNumberArg('max-products', Number(process.env.CATHAY_LIFE_MAX_PRODUCTS || 0));
  const productOffset = readNumberArg('product-offset', Number(process.env.CATHAY_LIFE_PRODUCT_OFFSET || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.CATHAY_LIFE_MAX_WORKERS || 3)) || 3;
  const dryRun = process.argv.includes('--dry-run');
  const includeExisting = process.argv.includes('--include-existing');
  const headless = !process.argv.includes('--headed');
  const stamp = safeStamp();
  const materialDir = path.join(runtimeDir, `cathay-life-cloak-materials-${stamp}`);
  const tasksPath = path.join(runtimeDir, `cathay-life-cloak-tasks-${stamp}.json`);

  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const before = knowledgeStore.countKnowledgeRecords();
    const knownUrls = new Set(knowledgeStore.knownCompanyUrls('陆家嘴国泰人寿'));
    const selectedSources = source === 'all' ? ['product-info', 'filing'] : [source];
    const plan = [];
    const blockers = [];

    if (selectedSources.includes('product-info')) {
      const extractedPages = await extractProductPages({ saleStatus, headless });
      const built = buildProductTasks({ pages: extractedPages, maxProducts, productOffset });
      blockers.push(...extractedPages.filter((page) => !page.ok).map((page) => ({ source: 'product-info', url: page.url, code: page.code })));
      const tasks = includeExisting ? built.tasks : built.tasks.filter((task) => !knownUrls.has(trim(task.url)));
      plan.push({
        source: 'product-info',
        products: built.products,
        pages: built.pages,
        allTasks: built.tasks,
        tasks,
      });
    }

    if (selectedSources.includes('filing')) {
      const extractedPages = await extractFilingPage({ headless });
      const built = buildFilingTasks({ pages: extractedPages, maxProducts, productOffset, knownUrls, includeExisting });
      blockers.push(...extractedPages.filter((page) => !page.ok).map((page) => ({ source: 'filing', url: page.url, code: page.code })));
      plan.push({
        source: 'filing',
        products: built.products,
        pages: built.pages,
        allTasks: built.tasks,
        tasks: built.tasks,
      });
    }

    writeJson(tasksPath, {
      source,
      saleStatus,
      maxProducts,
      productOffset,
      includeExisting,
      blockers,
      plan: plan.map((item) => ({
        source: item.source,
        pageCount: item.pages.length,
        pages: item.pages,
        productCount: item.products.length,
        materialTaskCount: item.allTasks.length,
        skippedExistingTaskCount: item.allTasks.length - item.tasks.length,
        selectedTaskCount: item.tasks.length,
        tasks: item.tasks,
      })),
    });

    if (dryRun || plan.every((item) => !item.tasks.length)) {
      console.log(JSON.stringify({
        ok: blockers.length === 0,
        dryRun,
        company: '陆家嘴国泰人寿',
        source,
        saleStatus,
        maxProducts,
        productOffset,
        blockers,
        plans: plan.map((item) => ({
          source: item.source,
          pageCount: item.pages.length,
          pages: item.pages,
          productCount: item.products.length,
          materialTaskCount: item.allTasks.length,
          skippedExistingTaskCount: item.allTasks.length - item.tasks.length,
          selectedTaskCount: item.tasks.length,
        })),
        tasksPath,
        localKnowledgeBefore: before,
        dbPath: knowledgeStore.dbPath,
      }, null, 2));
      return;
    }

    const allRecords = [];
    const failedDownloads = [];
    const extractorSkipped = [];
    for (const item of plan) {
      if (!item.tasks.length) continue;
      if (item.source === 'product-info') {
        const downloaded = await downloadMaterials({
          tasks: item.tasks,
          headless,
          materialDir: path.join(materialDir, 'pdf'),
          kind: 'pdf',
        });
        failedDownloads.push(...downloaded.failed.map((row) => ({ ...row, source: item.source })));
        if (downloaded.downloaded.length) {
          const result = runCrawler({
            mode: 'reextract_responsibility_records',
            maxWorkers,
            records: downloaded.downloaded,
          });
          allRecords.push(...(result.records || []).map((record) => normalizeRecord(record, 'scrapling_cathay_life_cloak_product_info')));
          extractorSkipped.push(...(result.skipped || []).map((row) => ({ ...row, source: item.source })));
        }
      }
      if (item.source === 'filing') {
        const downloaded = await downloadMaterials({
          tasks: item.tasks,
          headless,
          materialDir: path.join(materialDir, 'zip'),
          kind: 'zip',
        });
        failedDownloads.push(...downloaded.failed.map((row) => ({ ...row, source: item.source })));
        if (downloaded.downloaded.length) {
          const result = runCrawler({
            mode: 'reextract_cathay_life_filing_zip_paths',
            records: downloaded.downloaded,
          });
          allRecords.push(...(result.records || []).map((record) => normalizeRecord(record, 'scrapling_cathay_life_cloak_filing_zip')));
          extractorSkipped.push(...(result.skipped || []).map((row) => ({ ...row, source: item.source })));
        }
      }
    }

    const state = knowledgeStore.loadState();
    if (!Number(state.nextId)) state.nextId = 1;
    const beforeUrls = new Set(knowledgeStore.allKnownUrls());
    const saved = upsertKnowledgeRecords(state, allRecords, { allocateId });
    knowledgeStore.saveState(state);
    const after = knowledgeStore.countKnowledgeRecords();
    const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(trim(record.url)));
    const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
    const qualitySplit = saved.reduce((acc, record) => {
      const key = trim(record.responsibilityQualityStatus || record.qualityStatus) || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    console.log(JSON.stringify({
      ok: true,
      company: '陆家嘴国泰人寿',
      source,
      saleStatus,
      maxProducts,
      productOffset,
      maxWorkers,
      blockers,
      plans: plan.map((item) => ({
        source: item.source,
        pageCount: item.pages.length,
        pages: item.pages,
        productCount: item.products.length,
        materialTaskCount: item.allTasks.length,
        skippedExistingTaskCount: item.allTasks.length - item.tasks.length,
        selectedTaskCount: item.tasks.length,
      })),
      crawledRecordCount: allRecords.length,
      failedDownloadCount: failedDownloads.length,
      extractorSkippedCount: extractorSkipped.length,
      savedRecordCount: saved.length,
      newSavedRecordCount: newSaved.length,
      newSavedMinId: newSavedIds[0] || null,
      newSavedMaxId: newSavedIds.at(-1) || null,
      responsibilityQualitySplit: qualitySplit,
      localKnowledgeBefore: before,
      localKnowledgeAfter: after,
      dbPath: knowledgeStore.dbPath,
      tasksPath,
      materialDir,
      failedDownloads: failedDownloads.slice(0, 20),
      extractorSkipped: extractorSkipped.slice(0, 20),
    }, null, 2));
  } finally {
    knowledgeStore.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
