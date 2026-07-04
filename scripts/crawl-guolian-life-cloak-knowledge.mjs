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
const productPageUrl = 'https://www.guolian-life.com/web/#/relatedTransaction.html';
const scopesByStatus = {
  in_sale: { menuCode: '1875', grade: '4', label: '在售产品', salesStatus: '在售' },
  stopped: { menuCode: '1874', grade: '4', label: '停售产品', salesStatus: '停售' },
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

function productType(productName) {
  const name = trim(productName);
  if (name.includes('医疗')) return '医疗险';
  if (name.includes('重大疾病') || name.includes('疾病') || name.includes('恶性肿瘤') || name.includes('护理')) return '重疾险';
  if (name.includes('意外')) return '意外险';
  if (name.includes('年金') || name.includes('养老')) return '年金险';
  if (name.includes('两全')) return '两全保险';
  if (name.includes('增额终身寿险')) return '增额终身寿险';
  if (name.includes('万能')) return '万能账户';
  if (name.includes('定期寿险')) return '定期寿险';
  return '其他';
}

function materialType(label) {
  return trim(label).includes('说明') ? 'product_manual' : 'terms';
}

function isOfficialUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ['guolian-life.com', 'www.guolian-life.com', 'eservice.guolian-life.com'].includes(host);
  } catch {
    return false;
  }
}

function keepMaterial(label, url) {
  const text = `${trim(label)} ${trim(url)}`;
  if (!trim(url).toLowerCase().split('?', 1)[0].endsWith('.pdf')) return false;
  if (!text.includes('条款') && !text.includes('说明')) return false;
  return !/(费率|现价|现金价值|投保|职业|健康告知|利益演示|红利实现率|信息披露|公告|须知|问卷)/u.test(text);
}

function scopesForSaleStatus(value) {
  const normalized = trim(value).toLowerCase();
  if (['in_sale', 'sale', 'available', '在售', 'y', '1'].includes(normalized)) return [scopesByStatus.in_sale];
  if (['stopped', 'stop', 'discontinued', '停售', 'n', '0'].includes(normalized)) return [scopesByStatus.stopped];
  return [scopesByStatus.in_sale, scopesByStatus.stopped];
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

async function fetchCatalogPages({ saleStatus, maxPages, headless }) {
  const launch = await loadCloakLaunch();
  const browser = await launch({ headless });
  const catalogPages = [];
  try {
    const page = await browser.newPage();
    for (const scope of scopesForSaleStatus(saleStatus)) {
      const routeUrl = `${productPageUrl}?menuCode=${encodeURIComponent(scope.menuCode)}&grade=${encodeURIComponent(scope.grade)}`;
      const response = await page.goto(routeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout?.(1500);
      const pages = await page.evaluate(async ({ menuCode, grade, maxPagesValue, scopeValue }) => {
        const script = Array.from(document.scripts).find((item) =>
          item.type === 'module' && item.src.includes('/web/assets/index-')
        );
        if (!script) throw new Error('missing_guolian_module_script');
        const mod = await import(new URL(script.src).pathname);
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        async function fetchCatalogPage(pageNo) {
          let lastError = null;
          for (let attempt = 1; attempt <= 4; attempt += 1) {
            try {
              return await mod.ag({ menuCode, grade, pageNo });
            } catch (error) {
              lastError = error;
              await sleep(1000 * attempt);
            }
          }
          throw lastError || new Error(`guolian_catalog_page_failed_${pageNo}`);
        }
        const first = await fetchCatalogPage(1);
        const totalPage = Number(first?.totalPage || 1);
        const limit = maxPagesValue ? Math.min(totalPage, maxPagesValue) : totalPage;
        const output = [];
        for (let pageNo = 1; pageNo <= limit; pageNo += 1) {
          const data = pageNo === 1 ? first : await fetchCatalogPage(pageNo);
          output.push({
            ...data,
            pageNo,
            sourceScope: scopeValue,
          });
        }
        return output;
      }, { menuCode: scope.menuCode, grade: scope.grade, maxPagesValue: maxPages, scopeValue: scope });
      catalogPages.push(...pages.map((item) => ({ ...item, httpStatus: response?.status?.() ?? null })));
    }
  } finally {
    await browser.close();
  }
  return catalogPages;
}

function buildTasks({ catalogPages, maxProducts, productOffset }) {
  const products = [];
  const tasks = [];
  const pages = [];
  const seenProducts = new Set();
  const seenUrls = new Set();
  let productIndex = 0;

  for (const catalogPage of catalogPages) {
    const scope = catalogPage.sourceScope || {};
    const sourcePage = `${productPageUrl}?menuCode=${encodeURIComponent(trim(scope.menuCode))}&grade=${encodeURIComponent(trim(scope.grade) || '4')}`;
    let pageProductCount = 0;
    let pageTaskCount = 0;
    for (const item of catalogPage.articleInfoList || []) {
      const productName = trim(item.title);
      if (!productName) continue;
      pageProductCount += 1;
      productIndex += 1;
      if (productIndex <= productOffset) continue;
      if (maxProducts && products.length >= maxProducts && !seenProducts.has(`${scope.salesStatus}|${productName}`)) continue;
      const type = productType(productName);
      const productKey = `${scope.salesStatus}|${productName}`;
      if (!seenProducts.has(productKey)) {
        seenProducts.add(productKey);
        products.push({
          company: '国联人寿',
          productName,
          productType: type,
          salesStatus: trim(scope.salesStatus),
          sourcePage,
        });
      }
      for (const material of item.articleInfoFileList || []) {
        const label = trim(material.articleName);
        const url = trim(material.fileurl || material.fileUrl);
        if (!isOfficialUrl(url) || !keepMaterial(label, url) || seenUrls.has(url)) continue;
        seenUrls.add(url);
        tasks.push({
          company: '国联人寿',
          productName,
          productType: type,
          salesStatus: trim(scope.salesStatus),
          title: label || `${productName}产品条款`,
          label,
          url,
          sourcePage,
          materialType: materialType(label),
          officialDomain: new URL(url).hostname.toLowerCase(),
        });
        pageTaskCount += 1;
      }
    }
    pages.push({
      url: sourcePage,
      pageNumber: Number(catalogPage.pageNo || 1),
      totalPage: Number(catalogPage.totalPage || 1),
      title: trim(catalogPage.articleInfoTitle) || trim(scope.label),
      salesStatus: trim(scope.salesStatus),
      productCount: pageProductCount,
      materialTaskCount: pageTaskCount,
      httpStatus: catalogPage.httpStatus ?? null,
    });
  }
  return { products, tasks, pages };
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
    maxBuffer: 320 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`国联人寿 cloak PDF 责任抽取失败 status=${result.status}\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`国联人寿 cloak PDF 责任抽取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function normalizeRecord(record) {
  return {
    ...record,
    parser: 'scrapling_guolian_life_cloak_product_info',
    qualityStatus: trim(record.qualityStatus) || 'valid_complete',
    responsibilityQualityStatus: trim(record.responsibilityQualityStatus) || 'valid_complete',
    responsibilityQualityIssue: trim(record.responsibilityQualityIssue),
  };
}

async function main() {
  const saleStatus = readArg('sale-status', process.env.GUOLIAN_LIFE_SALE_STATUS || 'all');
  const maxProducts = readNumberArg('max-products', Number(process.env.GUOLIAN_LIFE_MAX_PRODUCTS || 0));
  const productOffset = readNumberArg('product-offset', Number(process.env.GUOLIAN_LIFE_PRODUCT_OFFSET || 0));
  const maxPages = readNumberArg('max-pages', Number(process.env.GUOLIAN_LIFE_MAX_PAGES || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.GUOLIAN_LIFE_MAX_WORKERS || 3)) || 3;
  const pdfArchiveDir = readArg('pdf-archive-dir', process.env.POLICY_PDF_ARCHIVE_DIR || '');
  const dryRun = process.argv.includes('--dry-run');
  const includeExisting = process.argv.includes('--include-existing');
  const headless = !process.argv.includes('--headed');

  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const before = knowledgeStore.countKnowledgeRecords();
    const knownUrls = new Set(knowledgeStore.knownCompanyUrls('国联人寿'));
    const catalogPages = await fetchCatalogPages({ saleStatus, maxPages, headless });
    const { products, tasks: allTasks, pages } = buildTasks({ catalogPages, maxProducts, productOffset });
    const tasks = includeExisting ? allTasks : allTasks.filter((task) => !knownUrls.has(trim(task.url)));
    const tasksPath = path.join(runtimeDir, `guolian-life-cloak-tasks-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    writeJson(tasksPath, {
      saleStatus,
      maxProducts,
      productOffset,
      maxPages,
      pageCount: pages.length,
      productCount: products.length,
      materialTaskCount: allTasks.length,
      skippedExistingTaskCount: allTasks.length - tasks.length,
      tasks,
      pages,
    });

    if (dryRun || !tasks.length) {
      console.log(JSON.stringify({
        ok: true,
        dryRun,
        company: '国联人寿',
        saleStatus,
        maxProducts,
        productOffset,
        maxPages,
        pageCount: pages.length,
        pages,
        productCount: products.length,
        materialTaskCount: allTasks.length,
        skippedExistingTaskCount: allTasks.length - tasks.length,
        selectedTaskCount: tasks.length,
        tasksPath,
        localKnowledgeBefore: before,
        dbPath: knowledgeStore.dbPath,
      }, null, 2));
      return;
    }

    const result = runCrawler(tasks, { maxWorkers, pdfArchiveDir });
    const records = (result.records || []).map(normalizeRecord);
    const state = knowledgeStore.loadState();
    if (!Number(state.nextId)) state.nextId = 1;
    const beforeUrls = new Set(knowledgeStore.allKnownUrls());
    const saved = upsertKnowledgeRecords(state, records, { allocateId });
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
      company: '国联人寿',
      saleStatus,
      maxProducts,
      productOffset,
      maxPages,
      maxWorkers,
      pageCount: pages.length,
      pages,
      productCount: products.length,
      materialTaskCount: allTasks.length,
      skippedExistingTaskCount: allTasks.length - tasks.length,
      selectedTaskCount: tasks.length,
      crawledRecordCount: records.length,
      skippedCount: Array.isArray(result.skipped) ? result.skipped.length : 0,
      savedRecordCount: saved.length,
      newSavedRecordCount: newSaved.length,
      newSavedMinId: newSavedIds[0] || null,
      newSavedMaxId: newSavedIds.at(-1) || null,
      responsibilityQualitySplit: qualitySplit,
      localKnowledgeBefore: before,
      localKnowledgeAfter: after,
      dbPath: knowledgeStore.dbPath,
      tasksPath,
      pdfArchiveDir: result.pdfArchiveDir || '',
      archivedPdfCount: result.archivedPdfCount || 0,
    }, null, 2));
  } finally {
    knowledgeStore.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
