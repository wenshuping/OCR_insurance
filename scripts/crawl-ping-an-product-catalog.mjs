import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const statePath = path.resolve(process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'));
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

function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 80 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`中国平安产品目录爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中国平安产品目录爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function parsePingAnMaterial(record) {
  try {
    const url = new URL(record.url);
    const planCode = trim(url.searchParams.get('planCode'));
    const versionNo = trim(url.searchParams.get('versionNo'));
    const attachmentType = trim(url.searchParams.get('attachmentType'));
    if (!planCode || !versionNo) return null;
    const saleType = trim(record.salesStatus).startsWith('停售') ? 'N' : 'Y';
    return {
      key: `${saleType}|${planCode}|${versionNo}`,
      attachmentType,
      materialType: trim(record.materialType || record.sourceType),
    };
  } catch {
    return null;
  }
}

function buildKnowledgeIndex(state) {
  const index = new Map();
  for (const record of Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : []) {
    if (trim(record.company) !== '中国平安') continue;
    const parsed = parsePingAnMaterial(record);
    if (!parsed) continue;
    if (!index.has(parsed.key)) {
      index.set(parsed.key, {
        total: 0,
        terms: 0,
        productManual: 0,
      });
    }
    const item = index.get(parsed.key);
    item.total += 1;
    if (parsed.materialType === 'terms' || parsed.attachmentType === '1') item.terms += 1;
    if (parsed.materialType === 'product_manual' || parsed.attachmentType === '7') item.productManual += 1;
  }
  return index;
}

function expectedMaterialCount(product) {
  return (product.hasTerms ? 1 : 0) + (product.hasProductManual ? 1 : 0);
}

function knowledgeStatus(product, stats) {
  if (!stats?.total) return '未入库';
  if (stats.total >= expectedMaterialCount(product)) return '已入库';
  return '部分入库';
}

function skipReason(product, stats) {
  const status = knowledgeStatus(product, stats);
  if (status === '已入库') return '已进入责任资料库';
  if (status === '部分入库') return '部分资料已入库，仍有条款或说明书未抽取';
  if (!product.hasTerms && !product.hasProductManual) return '官网目录未标记产品条款/说明书';
  if (!product.planCode || !product.versionNo) return '缺少 planCode/versionNo，无法生成资料链接';
  return '官网有资料标记，但未抽取到保险责任正文或PDF不可用';
}

function enrichProducts(products, knowledgeIndex, generatedAt) {
  return products.map((product) => {
    const key = `${product.saleType}|${product.planCode}|${product.versionNo}`;
    const stats = knowledgeIndex.get(key) || { total: 0, terms: 0, productManual: 0 };
    return {
      ...product,
      knowledgeRecordCount: stats.total,
      knowledgeTermsCount: stats.terms,
      knowledgeProductManualCount: stats.productManual,
      knowledgeStatus: knowledgeStatus(product, stats),
      skipReason: skipReason(product, stats),
      updatedAt: generatedAt,
    };
  });
}

function main() {
  const saleTypeArg = trim(readArg('sale-type', process.env.PING_AN_CATALOG_SALE_TYPE || 'all'));
  const saleTypes = saleTypeArg.toLowerCase() === 'all' ? ['Y', 'N'] : [saleTypeArg];
  const isOnlyNew = trim(readArg('is-only-new', process.env.PING_AN_CATALOG_IS_ONLY_NEW || 'Y')) || 'Y';
  const cdpUrl = readArg('cdp-url', process.env.PING_AN_CDP_URL || 'http://127.0.0.1:9223');
  const state = readJson(statePath, {});
  const knowledgeIndex = buildKnowledgeIndex(state);
  const generatedAt = new Date().toISOString();
  const pages = [];
  const products = [];

  for (const saleType of saleTypes) {
    const result = runCrawler({
      mode: 'ping_an_browser_catalog',
      company: '中国平安',
      saleType,
      isOnlyNew,
      cdpUrl,
    });
    if (result.ok === false) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 2;
      return;
    }
    pages.push(...(result.pages || []));
    products.push(...(result.products || []));
  }

  const rows = enrichProducts(products, knowledgeIndex, generatedAt);
  const bySaleType = rows.reduce((acc, row) => {
    acc[row.saleType] = (acc[row.saleType] || 0) + 1;
    return acc;
  }, {});
  const byKnowledgeStatus = rows.reduce((acc, row) => {
    acc[row.knowledgeStatus] = (acc[row.knowledgeStatus] || 0) + 1;
    return acc;
  }, {});
  const bySkipReason = rows.reduce((acc, row) => {
    acc[row.skipReason] = (acc[row.skipReason] || 0) + 1;
    return acc;
  }, {});

  const output = {
    ok: true,
    company: '中国平安',
    isOnlyNew,
    generatedAt,
    source: 'https://life.pingan.com/ilife-home/product/getProductList',
    pages,
    totalProducts: rows.length,
    bySaleType,
    byKnowledgeStatus,
    bySkipReason,
    products: rows,
  };
  writeJson(catalogPath, output);
  console.log(JSON.stringify({ ...output, products: undefined, catalogPath }, null, 2));
}

main();
