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
    throw new Error(`北京人寿批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`北京人寿批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

async function discoverBrowserTasks({ maxProducts, skipUrls }) {
  const modulePath = process.env.CLOAKBROWSER_MODULE || '/Users/wenshuping/Documents/cloak-crawler-starter/node_modules/cloakbrowser/dist/index.js';
  const { launch } = await import(modulePath);
  const pageUrl = 'https://www.beijinglife.com.cn/publicInfo/basicInfo/productBasicInfo/';
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    try {
      const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const rows = await page.$$eval('tr', (items) => items.map((row) => {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length < 5) return null;
        const links = [...row.querySelectorAll('a[href]')].map((anchor) => ({
          text: (anchor.innerText || anchor.textContent || '').trim(),
          href: anchor.href,
        }));
        return {
          cells: cells.map((cell) => (cell.innerText || cell.textContent || '').trim()),
          links,
        };
      }).filter(Boolean));
      const products = [];
      const tasks = [];
      const seenUrls = new Set();
      for (const row of rows) {
        const productName = String(row.cells?.[1] || '').trim();
        if (!productName || productName === '产品名称') continue;
        const rowText = row.cells.join(' ');
        const salesStatus = rowText.includes('停售') ? '停售' : rowText.includes('在售') ? '在售' : '';
        const rowTasks = [];
        for (const link of row.links || []) {
          const label = String(link.text || '').trim();
          if (!label || /费率|现金价值/u.test(label) || (!label.includes('查看') && !label.includes('产品说明'))) continue;
          let materialUrl = link.href;
          try {
            const parsed = new URL(materialUrl);
            materialUrl = parsed.searchParams.get('file') || materialUrl;
          } catch {
            continue;
          }
          let host = '';
          try { host = new URL(materialUrl).hostname.toLowerCase(); } catch { continue; }
          if (!/^(?:www\.)?(?:beijinglife\.com\.cn|blife\.com\.cn)$/u.test(host)) continue;
          if (skipUrls.has(materialUrl) || seenUrls.has(materialUrl)) continue;
          seenUrls.add(materialUrl);
          rowTasks.push({
            company: '北京人寿',
            productName,
            productType: '',
            salesStatus,
            label: label.includes('说明') ? label : '保险条款',
            materialType: label.includes('说明') ? 'product_manual' : 'terms',
            url: materialUrl,
            sourcePage: pageUrl,
          });
        }
        const preferredTasks = rowTasks.filter((task) => task.materialType === 'terms');
        const selectedTasks = preferredTasks.length ? preferredTasks : rowTasks;
        if (!selectedTasks.length) continue;
        if (maxProducts && products.length >= maxProducts) break;
        products.push({ company: '北京人寿', productName, productType: '', salesStatus, sourcePage: pageUrl });
        tasks.push(...selectedTasks);
      }
      return { status: response?.status() || 0, pageUrl, products, tasks };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const maxProducts = readNumberArg('max-products', Number(process.env.BEIJING_LIFE_MAX_PRODUCTS || 0));
  const offset = readNonNegativeNumberArg('offset', Number(process.env.BEIJING_LIFE_OFFSET || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.BEIJING_LIFE_MAX_WORKERS || 4));
  const newOnly = readBooleanArg('new-only', process.env.BEIJING_LIFE_NEW_ONLY === '1');

  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const beforeUrls = new Set(knowledgeStore.knownCompanyUrls('北京人寿'));

    let result = runCrawler({
    mode: 'beijing_life_pages',
    company: '北京人寿',
      skipUrls: [...beforeUrls],
    maxProducts,
    offset,
    maxWorkers,
  });

  if (!(result.materialTaskCount || 0)) {
    const browserResult = await discoverBrowserTasks({ maxProducts, skipUrls: beforeUrls });
    if (browserResult.tasks.length) {
      const materialResult = runCrawler({
        mode: 'browser_material_tasks',
        company: '北京人寿',
        officialDomains: ['beijinglife.com.cn', 'www.beijinglife.com.cn', 'blife.com.cn', 'www.blife.com.cn'],
        parser: 'scrapling_beijing_life_cloak_product_info',
        maxWorkers,
        tasks: browserResult.tasks,
      });
      result = {
        ...result,
        products: browserResult.products,
        materialTaskCount: browserResult.tasks.length,
        records: materialResult.records || [],
        pages: [...(result.pages || []), {
          url: browserResult.pageUrl,
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
        company: result.company || '北京人寿',
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
