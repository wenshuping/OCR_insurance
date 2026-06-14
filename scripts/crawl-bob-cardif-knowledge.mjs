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

function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 320 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`中荷人寿批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中荷人寿批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

async function main() {
  const saleStatus = readArg('sale-status', process.env.BOB_CARDIF_SALE_STATUS || 'all');
  const maxProducts = readNumberArg('max-products', Number(process.env.BOB_CARDIF_MAX_PRODUCTS || 0));
  const productOffset = readNonNegativeNumberArg('product-offset', Number(process.env.BOB_CARDIF_PRODUCT_OFFSET || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.BOB_CARDIF_MAX_WORKERS || 6));
  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const result = runCrawler({
      mode: 'bob_cardif_life_pages',
      company: '中荷人寿',
      saleStatus,
      maxProducts,
      productOffset,
      maxWorkers,
    });

    const state = knowledgeStore.loadState();
    if (!Number(state.nextId)) state.nextId = 1;
    const before = knowledgeStore.countKnowledgeRecords();
    const beforeUrls = new Set(knowledgeStore.allKnownUrls());
    const saved = upsertKnowledgeRecords(state, result.records || [], { allocateId });
    knowledgeStore.saveState(state);
    const after = knowledgeStore.countKnowledgeRecords();
    const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(String(record.url)));
    const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
    const qualitySplit = saved.reduce((acc, record) => {
      const status = String(record.responsibilityQualityStatus || record.qualityStatus || 'unknown');
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    console.log(
      JSON.stringify(
        {
          ok: true,
          company: result.company || '中荷人寿',
          saleStatus,
          maxProducts,
          productOffset,
          maxWorkers,
          source: result.source,
          officialDomain: result.officialDomain,
          officialDomains: result.officialDomains,
          pageCount: (result.pages || []).length,
          pages: result.pages || [],
          totalCandidateProductCount: result.totalCandidateProductCount || 0,
          productCount: (result.products || []).length,
          materialTaskCount: result.materialTaskCount || 0,
          crawledRecordCount: (result.records || []).length,
          savedRecordCount: saved.length,
          newSavedRecordCount: newSaved.length,
          newSavedMinId: newSavedIds[0] || null,
          newSavedMaxId: newSavedIds.at(-1) || null,
          responsibilityQualitySplit: qualitySplit,
          localKnowledgeBefore: before,
          localKnowledgeAfter: after,
          dbPath: knowledgeStore.dbPath,
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
