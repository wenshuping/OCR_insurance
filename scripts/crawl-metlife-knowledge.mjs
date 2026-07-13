import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocateId } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

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
    maxBuffer: 240 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`大都会人寿批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`大都会人寿批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

async function discoverBrowserTasks({ pageUrl, salesStatus, maxProducts, skipUrls }) {
  const modulePath = process.env.CLOAKBROWSER_MODULE || '/Users/wenshuping/Documents/cloak-crawler-starter/node_modules/cloakbrowser/dist/index.js';
  const { launch } = await import(modulePath);
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    try {
      const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const products = await page.$$eval('div.font-metlife-medium.text-1xl', (headers) => headers.map((header) => {
        let container = header;
        for (let depth = 0; depth < 5 && container; depth += 1, container = container.parentElement) {
          const links = [...container.querySelectorAll('a[href]')].map((anchor) => ({
            text: (anchor.innerText || anchor.textContent || '').trim(),
            href: anchor.href,
          }));
          if (links.length) return { productName: (header.innerText || header.textContent || '').trim(), links };
        }
        return { productName: (header.innerText || header.textContent || '').trim(), links: [] };
      }));
      const tasks = [];
      const productRows = [];
      const seenUrls = new Set();
      for (const product of products) {
        if (!product.productName) continue;
        const candidates = product.links.filter((link) => /产品条款|产品说明/u.test(link.text) && !/费率|现金价值/u.test(link.text));
        const preferred = candidates.filter((link) => link.text.includes('条款'));
        const selected = preferred.length ? preferred : candidates;
        const rowTasks = [];
        for (const link of selected) {
          if (skipUrls.has(link.href) || seenUrls.has(link.href)) continue;
          seenUrls.add(link.href);
          rowTasks.push({
            company: '大都会人寿',
            productName: product.productName,
            productType: '',
            salesStatus,
            label: link.text.includes('说明') ? '产品说明书' : '产品条款',
            materialType: link.text.includes('说明') ? 'product_manual' : 'terms',
            url: link.href,
            sourcePage: pageUrl,
          });
        }
        if (!rowTasks.length) continue;
        if (maxProducts && productRows.length >= maxProducts) break;
        productRows.push({ company: '大都会人寿', productName: product.productName, productType: '', salesStatus, sourcePage: pageUrl });
        tasks.push(...rowTasks);
      }
      return { status: response?.status() || 0, products: productRows, tasks };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const saleStatus = readArg('sale-status', process.env.METLIFE_SALE_STATUS || 'all');
  const maxProducts = readNumberArg('max-products', Number(process.env.METLIFE_MAX_PRODUCTS || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.METLIFE_MAX_WORKERS || 6));

  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const beforeUrls = new Set(knowledgeStore.knownCompanyUrls('大都会人寿'));

    let result = runCrawler({
    mode: 'metlife_china_life_pages',
    company: '大都会人寿',
      skipUrls: [...beforeUrls],
    saleStatus,
    maxProducts,
    maxWorkers,
  });

  if (!(result.materialTaskCount || 0)) {
    const pageUrl = saleStatus.includes('停售')
      ? 'https://www.metlife.com.cn/information-disclosure/public-information-disclosure/basic-information/basic-product-information/discontinued-products'
      : 'https://www.metlife.com.cn/information-disclosure/public-information-disclosure/basic-information/basic-product-information/available-products';
    const browserResult = await discoverBrowserTasks({ pageUrl, salesStatus: saleStatus.includes('停售') ? '停售' : '在售', maxProducts, skipUrls: beforeUrls });
    if (browserResult.tasks.length) {
      const materialResult = runCrawler({
        mode: 'browser_material_tasks',
        company: '大都会人寿',
        officialDomains: ['metlife.com.cn', 'www.metlife.com.cn'],
        parser: 'scrapling_metlife_cloak_product_info',
        maxWorkers,
        tasks: browserResult.tasks,
      });
      result = {
        ...result,
        products: browserResult.products,
        materialTaskCount: browserResult.tasks.length,
        records: materialResult.records || [],
        pages: [...(result.pages || []), {
          url: pageUrl,
          status: browserResult.status,
          source: 'cloakbrowser_dom_fallback',
          productCount: browserResult.products.length,
          materialTaskCount: browserResult.tasks.length,
          recordCount: (materialResult.records || []).length,
        }],
      };
    }
  }

  const state = knowledgeStore.loadState();
  if (!Number(state.nextId)) state.nextId = 1;
  const before = knowledgeStore.countKnowledgeRecords();
  const recordsToSave = (result.records || []).filter((record) => record?.url && !beforeUrls.has(String(record.url)));
  const saved = upsertKnowledgeRecords(state, recordsToSave, { allocateId });
  const after = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0;
  const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(String(record.url)));
  const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
  knowledgeStore.saveState(state);

  console.log(
    JSON.stringify(
      {
        ok: true,
        company: result.company || '大都会人寿',
        saleStatus,
        maxProducts,
        maxWorkers,
        source: result.source,
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
        statePath: knowledgeStore.dbPath,
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
