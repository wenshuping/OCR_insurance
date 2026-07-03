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
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBooleanArg(name, fallback = false) {
  if (process.argv.includes(`--${name}`)) return true;
  const value = readArg(name, '');
  if (!value) return fallback;
  return /^(?:1|true|yes|y)$/iu.test(value);
}

function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 260 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`大家人寿批量爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`大家人寿批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

async function main() {
  const source = readArg('source', process.env.DAJIA_LIFE_SOURCE || 'all');
  const offset = readNumberArg('offset', Number(process.env.DAJIA_LIFE_OFFSET || 0));
  const maxProducts = readNumberArg('max-products', Number(process.env.DAJIA_LIFE_MAX_PRODUCTS || 0));
  const maxWorkers = Math.max(1, readNumberArg('max-workers', Number(process.env.DAJIA_LIFE_MAX_WORKERS || 4)));
  const newOnly = readBooleanArg('new-only', process.env.DAJIA_LIFE_NEW_ONLY === '1');

  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const beforeUrls = new Set(knowledgeStore.allKnownUrls());
    const result = runCrawler({
      mode: 'dajia_life_pages',
      company: '大家人寿',
      source,
      offset,
      maxProducts,
      maxWorkers,
      archivePdf: true,
    });

    const state = knowledgeStore.loadState();
    if (!Number(state.nextId)) state.nextId = 1;
    const before = knowledgeStore.countKnowledgeRecords();
    const recordsToSave = newOnly
      ? (result.records || []).filter((record) => record?.url && !beforeUrls.has(String(record.url)))
      : result.records || [];
    const saved = upsertKnowledgeRecords(state, recordsToSave, { allocateId });
    knowledgeStore.saveState(state);
    const after = knowledgeStore.countKnowledgeRecords();
    const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(String(record.url)));
    const newSavedIds = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);

    console.log(
      JSON.stringify(
        {
          ok: true,
          company: result.company || '大家人寿',
          source,
          offset,
          maxProducts,
          maxWorkers,
          newOnly,
          officialSource: result.source,
          officialDomains: result.officialDomains || [],
          sourceKeys: result.sourceKeys || [],
          pageCount: (result.pages || []).length,
          failedPageCount: (result.failedPages || []).length,
          pages: result.pages || [],
          totalCandidateProductCount: result.totalCandidateProductCount || 0,
          productCount: (result.products || []).length,
          materialTaskCount: result.materialTaskCount || 0,
          qualitySplit: result.qualitySplit || {},
          crawledRecordCount: (result.records || []).length,
          recordsToSaveCount: recordsToSave.length,
          savedRecordCount: saved.length,
          newSavedRecordCount: newSaved.length,
          newSavedMinId: newSavedIds[0] || null,
          newSavedMaxId: newSavedIds.at(-1) || null,
          archivedPdfCount: result.archivedPdfCount || 0,
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
