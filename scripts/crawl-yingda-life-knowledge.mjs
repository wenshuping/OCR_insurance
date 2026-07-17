import path from 'node:path';
import { spawn } from 'node:child_process';
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
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(scraplingPython, [crawlerPath], {
      cwd: scraplingCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    let stdout = '';
    let stderr = '';
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      process.stderr.write(`[英大人寿] crawling ${elapsedSeconds}s...\n`);
    }, 30000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearInterval(heartbeat);
      reject(error);
    });
    child.on('close', (status) => {
      clearInterval(heartbeat);
      if (status !== 0) {
        reject(new Error(`英大人寿批量爬取失败\n${stderr || stdout}`));
        return;
      }
      const line = String(stdout || '')
        .split(/\r?\n/u)
        .reverse()
        .find((item) => item.includes(outputMarker));
      if (!line) {
        reject(new Error(`英大人寿批量爬取没有返回结果\n${stdout}\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main() {
  const source = readArg('source', process.env.YINGDA_LIFE_SOURCE || 'all');
  const saleStatus = readArg('sale-status', process.env.YINGDA_LIFE_SALE_STATUS || 'all');
  const maxProducts = readNumberArg('max-products', Number(process.env.YINGDA_LIFE_MAX_PRODUCTS || 0));
  const productOffset = Math.max(0, Number(readArg('product-offset', process.env.YINGDA_LIFE_PRODUCT_OFFSET || 0)) || 0);
  const startPage = readNumberArg('start-page', Number(process.env.YINGDA_LIFE_START_PAGE || 1));
  const maxPages = readNumberArg('max-pages', Number(process.env.YINGDA_LIFE_MAX_PAGES || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.YINGDA_LIFE_MAX_WORKERS || 4));

  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const beforeUrls = new Set(knowledgeStore.knownCompanyUrls('英大人寿'));
    const result = await runCrawler({
      mode: 'yingda_life_pages',
      company: '英大人寿',
      source,
      saleStatus,
      maxProducts,
      productOffset,
      startPage,
      maxPages,
      maxWorkers,
      skipUrls: [...beforeUrls],
      archivePdf: true,
    });

    const state = knowledgeStore.loadState();
    if (!Number(state.nextId)) state.nextId = 1;
    const before = knowledgeStore.countKnowledgeRecords();
    const recordsToSave = (result.records || []).filter((record) => record?.url && !beforeUrls.has(String(record.url)));
    const saved = upsertKnowledgeRecords(state, recordsToSave, { allocateId });
    knowledgeStore.saveState(state);
    const after = knowledgeStore.countKnowledgeRecords();
    const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(String(record.url)));
    const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);

    console.log(
      JSON.stringify(
        {
          ok: true,
          company: result.company || '英大人寿',
          source,
          saleStatus,
          maxProducts,
          productOffset,
          startPage,
          maxPages,
          maxWorkers,
          officialSource: result.source,
          sourceFilter: result.sourceFilter,
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
