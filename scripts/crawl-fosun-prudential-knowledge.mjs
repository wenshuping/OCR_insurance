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
    maxBuffer: 420 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`复星保德信批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`复星保德信批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

async function main() {
  const saleStatus = readArg('sale-status', process.env.FOSUN_PRUDENTIAL_SALE_STATUS || 'all');
  const offset = readNumberArg('offset', Number(process.env.FOSUN_PRUDENTIAL_OFFSET || 0));
  const pageSize = readNumberArg('page-size', Number(process.env.FOSUN_PRUDENTIAL_PAGE_SIZE || 50));
  const maxProducts = readNumberArg('max-products', Number(process.env.FOSUN_PRUDENTIAL_MAX_PRODUCTS || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.FOSUN_PRUDENTIAL_MAX_WORKERS || 4));
  const productName = readArg('product-name', process.env.FOSUN_PRUDENTIAL_PRODUCT_NAME || '');

  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const beforeUrls = new Set(knowledgeStore.knownCompanyUrls('复星保德信人寿'));

    const result = runCrawler({
    mode: 'fosun_prudential_life_pages',
    company: '复星保德信人寿',
      skipUrls: [...beforeUrls],
    saleStatus,
    offset,
    pageSize,
    maxProducts,
    maxWorkers,
    productName,
  });

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
        company: result.company || '复星保德信人寿',
        saleStatus,
        offset,
        pageSize,
        maxProducts,
        maxWorkers,
        productName,
        totalCandidateProductCount: result.totalCandidateProductCount || 0,
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
