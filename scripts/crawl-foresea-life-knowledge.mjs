import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocateId } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const company = '前海人寿';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const crawlerPath = path.join(__dirname, '..', 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

function readNumberArg(name, fallback) {
  const value = Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function runCrawler(payload) {
  const result = spawnSync(scraplingPython, [crawlerPath], { cwd: scraplingCwd, input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 260 * 1024 * 1024, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  if (result.status !== 0) throw new Error(`前海人寿批量爬取失败\n${result.stderr || result.stdout}`);
  const line = String(result.stdout || '').split(/\r?\n/u).reverse().find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`前海人寿批量爬取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

async function main() {
  const maxProducts = readNumberArg('max-products', Number(process.env.FORESEA_LIFE_MAX_PRODUCTS || 0));
  const maxWorkers = readNumberArg('max-workers', Number(process.env.FORESEA_LIFE_MAX_WORKERS || 6));
  const knowledgeStore = await createKnowledgeStateStore();
  try {
    const skipUrls = knowledgeStore.knownCompanyUrls(company);
    const result = runCrawler({ mode: 'foresea_life_pages', company, maxProducts, maxWorkers, skipUrls });
    const state = knowledgeStore.loadState();
    const before = knowledgeStore.countKnowledgeRecords();
    const beforeUrls = new Set(knowledgeStore.allKnownUrls());
    const saved = upsertKnowledgeRecords(state, result.records || [], { allocateId });
    knowledgeStore.saveState(state);
    const newSaved = saved.filter((record) => record?.url && !beforeUrls.has(String(record.url)));
    const ids = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((a, b) => a - b);
    console.log(JSON.stringify({ ok: true, company, maxProducts, maxWorkers, source: result.source, pages: result.pages || [], productCount: (result.products || []).length, materialTaskCount: result.materialTaskCount || 0, skippedExistingUrlCount: skipUrls.length, crawledRecordCount: (result.records || []).length, savedRecordCount: saved.length, newSavedRecordCount: newSaved.length, newSavedMinId: ids[0] || null, newSavedMaxId: ids.at(-1) || null, localKnowledgeBefore: before, localKnowledgeAfter: knowledgeStore.countKnowledgeRecords(), dbPath: knowledgeStore.dbPath }, null, 2));
  } finally {
    knowledgeStore.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
