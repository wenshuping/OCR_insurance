import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

function trim(value) {
  return String(value || '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function buildJrcpcxCatalogPayload({
  cdpUrl = '',
  startPage = 1,
  maxPages = 1,
  pageSize = 50,
  productName = '',
  industryCode = '',
  deptName = '',
  productType = '00',
  productTerm = '00',
  productState = '00',
  region = '',
  fetchDetails = true,
} = {}) {
  return {
    mode: 'jrcpcx_insurance_catalog',
    cdpUrl: trim(cdpUrl) || 'http://127.0.0.1:9224',
    startPage: Number(startPage || 1),
    maxPages: Number(maxPages || 1),
    pageSize: Number(pageSize || 50),
    productName: trim(productName),
    industryCode: trim(industryCode),
    deptName: trim(deptName),
    productType: trim(productType) || '00',
    productTerm: trim(productTerm) || '00',
    productState: trim(productState) || '00',
    region: trim(region),
    fetchDetails: fetchDetails ? '1' : '0',
  };
}

export function hasJrcpcxQueryField(payload = {}) {
  return Boolean(
    trim(payload.productName) ||
      trim(payload.industryCode) ||
      trim(payload.deptName) ||
      (Array.isArray(payload.deptNames) && payload.deptNames.length) ||
      (Array.isArray(payload.queries) && payload.queries.length),
  );
}

export function summarizeJrcpcxCatalogResult(result = {}) {
  const products = Array.isArray(result.products) ? result.products : [];
  const records = Array.isArray(result.records) ? result.records : [];
  return {
    ok: result.ok !== false,
    code: result.code || '',
    message: result.message || '',
    source: result.source || 'https://www.jrcpcx.cn/#/query',
    sourceLevel: result.sourceLevel || 'regulatory_industry_index',
    cdpUrl: result.cdpUrl || '',
    region: result.region || result.request?.region || '',
    startPage: result.startPage || result.request?.page || 1,
    pageSize: result.pageSize || result.request?.size || 0,
    maxPages: result.maxPages || 0,
    pageCount: result.pageCount || (Array.isArray(result.pages) ? result.pages.length : 0),
    queryCount: result.queryCount || (Array.isArray(result.queries) ? result.queries.length : 0),
    productCount: result.productCount || products.length,
    recordCount: result.recordCount || records.length,
    responsibilityCount: result.responsibilityCount || records.filter((record) => trim(record.pageText)).length,
    pdfArchiveDir: result.pdfArchiveDir || '',
    pages: result.pages || [],
    queries: result.queries || [],
    detailResults: result.detailResults || [],
    samples: products.slice(0, 10).map((row) => ({
      catalogId: row.catalogId,
      queryDeptName: row.queryDeptName,
      queryProductType: row.queryProductType,
      queryProductState: row.queryProductState,
      productName: row.productName,
      industryCode: row.industryCode,
      deptName: row.deptName,
      productType: row.productType,
      productState: row.productState,
      detailUrl: row.detailUrl,
    })),
    recordSamples: records.slice(0, 5).map((record) => ({
      company: record.company,
      productName: record.productName,
      qualityStatus: record.qualityStatus,
      pageTextChars: trim(record.pageText).length,
      pdfLocalPath: record.pdfLocalPath,
    })),
  };
}

function splitList(value = '') {
  return trim(value)
    .split(/[,，\n]/u)
    .map((item) => trim(item))
    .filter(Boolean);
}

export function buildJrcpcxUiQueries({
  deptNames = [],
  productTypeLabels = ['全部'],
  productStateLabels = ['全部'],
  productTermLabels = ['全部'],
} = {}) {
  const departments = (Array.isArray(deptNames) ? deptNames : [])
    .map((item) => trim(item))
    .filter(Boolean);
  const types = (Array.isArray(productTypeLabels) ? productTypeLabels : ['全部']).map((item) => trim(item) || '全部');
  const states = (Array.isArray(productStateLabels) ? productStateLabels : ['全部']).map((item) => trim(item) || '全部');
  const terms = (Array.isArray(productTermLabels) ? productTermLabels : ['全部']).map((item) => trim(item) || '全部');
  const queries = [];
  for (const deptName of departments) {
    for (const productTypeLabel of types) {
      for (const productTermLabel of terms) {
        for (const productStateLabel of states) {
          queries.push({
            deptName,
            productTypeLabel,
            productTermLabel,
            productStateLabel,
          });
        }
      }
    }
  }
  return queries;
}

export const PING_AN_LIFE_DEPT_NAME = '中国平安人寿保险股份有限公司';
export const PING_AN_LIFE_PRODUCT_TYPE_LABEL = '人身保险类';
export const PING_AN_LIFE_STATUSES = ['在售', '停售', '停用'];
export const PING_AN_LIFE_KEYWORDS = [
  '附加',
  '终身',
  '年金',
  '两全',
  '医疗',
  '重疾',
  '疾病',
  '意外',
  '万能',
  '分红',
  '养老',
  '少儿',
  '护理',
  '教育',
  '金',
  '福',
  '安',
  '智',
  '鑫',
  '御',
  '盛世',
];

export function buildPingAnLifeShardQueries({
  keywords = PING_AN_LIFE_KEYWORDS,
  statuses = PING_AN_LIFE_STATUSES,
} = {}) {
  const normalizedKeywords = (Array.isArray(keywords) ? keywords : [])
    .map((item) => trim(item))
    .filter(Boolean);
  const normalizedStatuses = (Array.isArray(statuses) ? statuses : [])
    .map((item) => trim(item))
    .filter(Boolean);
  const queries = [];
  for (const productName of normalizedKeywords) {
    for (const productStateLabel of normalizedStatuses) {
      queries.push({
        deptName: PING_AN_LIFE_DEPT_NAME,
        productName,
        productTypeLabel: PING_AN_LIFE_PRODUCT_TYPE_LABEL,
        productTermLabel: '全部',
        productStateLabel,
      });
    }
  }
  return queries;
}

export function summarizeJrcpcxShardResults(result = {}) {
  const queries = Array.isArray(result.queries) ? result.queries : [];
  const rows = queries.map((query) => ({
    deptName: trim(query.deptName || query.queryDeptName),
    productName: trim(query.productName),
    status: trim(query.productStateLabel || query.queryProductState),
    rowCount: Number(query.rowCount || 0) || 0,
    truncated: Boolean(query.truncated),
    nextAction: query.truncated ? 'split_keyword' : 'complete',
  }));
  return {
    queryCount: rows.length,
    truncatedCount: rows.filter((row) => row.truncated).length,
    completeCount: rows.filter((row) => !row.truncated).length,
    shards: rows,
    unresolvedShards: rows
      .filter((row) => row.truncated)
      .map((row) => ({
        deptName: row.deptName,
        productName: row.productName,
        status: row.status,
        rowCount: row.rowCount,
        nextAction: row.nextAction,
      })),
  };
}

export function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 240 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`金融产品查询平台目录爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`金融产品查询平台目录爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function main() {
  const catalogPath = path.resolve(readArg('catalog-path', process.env.JRCPCX_CATALOG_PATH || path.join(runtimeDir, 'jrcpcx-insurance-catalog.json')));
  const useUi = hasFlag('ui') || process.env.JRCPCX_UI === '1';
  const deptNameArg = readArg('dept-name', process.env.JRCPCX_DEPT_NAME || '');
  const payload = buildJrcpcxCatalogPayload({
    cdpUrl: readArg('cdp-url', process.env.JRCPCX_CDP_URL || 'http://127.0.0.1:9224'),
    startPage: readNumberArg('start-page', Number(process.env.JRCPCX_START_PAGE || 1)),
    maxPages: readNumberArg('max-pages', Number(process.env.JRCPCX_MAX_PAGES || 1)),
    pageSize: readNumberArg('page-size', Number(process.env.JRCPCX_PAGE_SIZE || 50)),
    productName: readArg('product-name', process.env.JRCPCX_PRODUCT_NAME || ''),
    industryCode: readArg('industry-code', process.env.JRCPCX_INDUSTRY_CODE || ''),
    deptName: deptNameArg,
    productType: readArg('product-type', process.env.JRCPCX_PRODUCT_TYPE || '00'),
    productTerm: readArg('product-term', process.env.JRCPCX_PRODUCT_TERM || '00'),
    productState: readArg('product-state', process.env.JRCPCX_PRODUCT_STATE || '00'),
    region: readArg('region', process.env.JRCPCX_REGION || ''),
    fetchDetails: !hasFlag('no-details') && process.env.JRCPCX_FETCH_DETAILS !== '0',
  });
  if (useUi) {
    payload.mode = 'jrcpcx_insurance_catalog_ui';
    payload.deptNames = splitList(deptNameArg);
    const queryFile = readArg('query-file', process.env.JRCPCX_QUERY_FILE || '');
    if (queryFile) {
      const queryPath = path.resolve(queryFile);
      const loaded = JSON.parse(fs.readFileSync(queryPath, 'utf8'));
      payload.queries = Array.isArray(loaded) ? loaded : loaded.queries;
      payload.queryFile = queryPath;
    }
    if (hasFlag('shard-status-type')) {
      payload.queries = buildJrcpcxUiQueries({
        deptNames: payload.deptNames,
        productTypeLabels: splitList(readArg('product-type-labels', '人身保险类')),
        productStateLabels: splitList(readArg('product-state-labels', '在售,停售,停用')),
        productTermLabels: splitList(readArg('product-term-labels', '全部')),
      });
    }
    if (hasFlag('fetch-detail-links')) {
      payload.fetchDetailLinks = '1';
    }
    if (hasFlag('extract-responsibility')) {
      payload.fetchDetailLinks = '1';
      payload.extractResponsibility = '1';
      if (!hasFlag('no-archive-pdf')) {
        payload.archivePdf = true;
      }
    }
    payload.maxDetailProducts = readNumberArg('max-detail-products', Number(process.env.JRCPCX_MAX_DETAIL_PRODUCTS || 0));
    payload.pdfArchiveDir = readArg('pdf-archive-dir', process.env.JRCPCX_PDF_ARCHIVE_DIR || '');
    payload.waitMs = readNumberArg('wait-ms', Number(process.env.JRCPCX_WAIT_MS || 120000));
  }
  if (!hasJrcpcxQueryField(payload) && !hasFlag('allow-broad')) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          code: 'JRCPCX_QUERY_FIELD_REQUIRED',
          message: '金融产品查询平台空条件会提示“查询结果超过100条”，请提供 --product-name、--industry-code 或 --dept-name；只试探接口时可加 --allow-broad。',
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }
  const result = runCrawler(payload);
  if (result.ok === false) {
    console.log(JSON.stringify(summarizeJrcpcxCatalogResult(result), null, 2));
    process.exitCode = 2;
    return;
  }
  if (hasFlag('write') || process.env.JRCPCX_WRITE === '1') {
    writeJson(catalogPath, {
      ...result,
      generatedAt: new Date().toISOString(),
      catalogPath,
    });
  }
  console.log(
    JSON.stringify(
      {
        ...summarizeJrcpcxCatalogResult(result),
        catalogPath: hasFlag('write') || process.env.JRCPCX_WRITE === '1' ? catalogPath : '',
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
