import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const DEFAULT_DB_PATHS = [
  path.join(runtimeDir, 'policy-ocr.sqlite'),
  path.join(runtimeDir, 'local', 'policy-ocr.sqlite'),
];
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

function trim(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parsePayload(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupSqlite(dbPath) {
  if (!(await exists(dbPath))) return [];
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const label = dbPath.includes(`${path.sep}local${path.sep}`) ? 'local-policy-ocr' : 'policy-ocr';
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupBase = path.join(backupDir, `${label}-before-pending-optional-source-refill-${stamp}.sqlite`);
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (!(await exists(source))) continue;
    const target = `${backupBase}${suffix}`;
    await fs.copyFile(source, target);
    copied.push(target);
  }
  return copied;
}

function dbPathsFromArgs() {
  const arg = trim(readArg('db-paths')) || trim(readArg('db-path'));
  if (!arg) return DEFAULT_DB_PATHS;
  return arg.split(',').map((item) => path.resolve(item)).filter(Boolean);
}

function knowledgeText(payload = {}) {
  const pageTexts = Array.isArray(payload.pages)
    ? payload.pages.map((page) => [page?.pageText, page?.text, page?.content].filter(Boolean).join('\n'))
    : [];
  return [
    payload.pageText,
    payload.text,
    payload.content,
    payload.body,
    payload.snippet,
    ...pageTexts,
  ].map(trim).filter(Boolean).join('\n');
}

function collectTasks(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT o.id optional_id,
              o.company optional_company,
              o.product_name optional_product_name,
              o.payload optional_payload,
              k.id source_id,
              k.company source_company,
              k.product_name source_product_name,
              k.url source_url,
              k.payload source_payload
         FROM optional_responsibility_records o
         LEFT JOIN knowledge_records k
           ON CAST(k.id AS TEXT) = json_extract(o.payload, '$.sourceRecordId')
        WHERE json_extract(o.payload, '$.quantificationStatus') = 'pending_review'
        ORDER BY o.company, o.product_name, o.liability, o.id`,
    ).all();

    const tasks = [];
    for (const row of rows) {
      const optionalPayload = parsePayload(row.optional_payload);
      const sourcePayload = parsePayload(row.source_payload);
      const sourceId = trim(row.source_id || optionalPayload.sourceRecordId);
      const url = trim(row.source_url || sourcePayload.url || optionalPayload.sourceUrl);
      const productName = trim(row.source_product_name || sourcePayload.productName || row.optional_product_name);
      if (!sourceId || !url || !productName) continue;
      tasks.push({
        id: sourceId,
        company: trim(row.source_company || sourcePayload.company || row.optional_company),
        productName,
        productType: trim(sourcePayload.productType),
        salesStatus: trim(sourcePayload.salesStatus),
        title: trim(sourcePayload.title || row.source_product_name || row.optional_product_name),
        url,
        materialType: trim(sourcePayload.materialType || sourcePayload.sourceType),
        officialDomain: trim(sourcePayload.officialDomain),
        existingTextLength: knowledgeText(sourcePayload).length,
      });
    }
    return tasks;
  } finally {
    db.close();
  }
}

function dedupeTasks(tasks) {
  const byKey = new Map();
  for (const task of tasks) {
    const key = `${task.id}::${task.url}`;
    if (!byKey.has(key)) byKey.set(key, task);
  }
  return [...byKey.values()];
}

function runCrawler(tasks, maxWorkers) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify({ mode: 'reextract_responsibility_records', maxWorkers, records: tasks }),
    encoding: 'utf8',
    maxBuffer: 280 * 1024 * 1024,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`重新抽取官方资料失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/gu)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`重新抽取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function mergeKnowledgePayload(existingPayload, record) {
  return {
    ...existingPayload,
    id: Number(record.id) || existingPayload.id || record.id,
    company: trim(record.company) || existingPayload.company,
    productName: trim(record.productName) || existingPayload.productName,
    productType: trim(record.productType) || existingPayload.productType,
    salesStatus: trim(record.salesStatus) || existingPayload.salesStatus,
    title: trim(record.title) || existingPayload.title,
    url: trim(record.url) || existingPayload.url,
    snippet: trim(record.snippet) || existingPayload.snippet,
    pageText: trim(record.pageText) || existingPayload.pageText,
    sourceType: trim(record.sourceType) || existingPayload.sourceType,
    materialType: trim(record.materialType) || existingPayload.materialType,
    official: record.official ?? existingPayload.official ?? true,
    evidenceLabel: existingPayload.evidenceLabel || '本地知识库官方资料',
    evidenceLevel: existingPayload.evidenceLevel || 'insurer_official',
    officialDomain: trim(record.officialDomain) || existingPayload.officialDomain,
    parser: trim(record.parser) || existingPayload.parser,
    pages: record.pages ?? existingPayload.pages,
    bytes: record.bytes ?? existingPayload.bytes,
    contentType: trim(record.contentType) || existingPayload.contentType,
    archiveEntry: trim(record.archiveEntry) || existingPayload.archiveEntry,
    optionalResponsibilitySourceRefilledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function applyRecords(dbPath, records) {
  const db = new DatabaseSync(dbPath);
  try {
    const select = db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records WHERE id = ?');
    const update = db.prepare('UPDATE knowledge_records SET company = ?, product_name = ?, url = ?, payload = ? WHERE id = ?');
    let updated = 0;
    for (const record of records) {
      const sourceId = Number(record.id);
      if (!Number.isFinite(sourceId)) continue;
      const existing = select.get(sourceId);
      if (!existing) continue;
      const existingPayload = parsePayload(existing.payload);
      const merged = mergeKnowledgePayload(existingPayload, record);
      update.run(
        trim(record.company) || existing.company,
        trim(record.productName) || existing.product_name,
        trim(record.url) || existing.url,
        JSON.stringify(merged),
        sourceId,
      );
      updated += 1;
    }
    return updated;
  } finally {
    db.close();
  }
}

async function main() {
  const dbPaths = dbPathsFromArgs();
  const dryRun = hasFlag('dry-run');
  const maxWorkers = Number(readArg('max-workers', '3')) || 3;
  const taskSourceDb = dbPaths[0];
  const tasks = dedupeTasks(collectTasks(taskSourceDb));
  const result = dryRun ? { taskCount: tasks.length, recordCount: 0, skippedCount: 0, records: [], skipped: [] } : runCrawler(tasks, maxWorkers);
  const backups = {};
  const applied = {};
  if (!dryRun) {
    for (const dbPath of dbPaths) backups[dbPath] = await backupSqlite(dbPath);
    for (const dbPath of dbPaths) applied[dbPath] = applyRecords(dbPath, result.records || []);
  }
  const report = {
    ok: true,
    dryRun,
    generatedAt: new Date().toISOString(),
    dbPaths,
    maxWorkers,
    taskCount: tasks.length,
    tasks: tasks.slice(0, 120),
    crawler: {
      taskCount: result.taskCount ?? tasks.length,
      recordCount: result.recordCount ?? (result.records || []).length,
      skippedCount: result.skippedCount ?? (result.skipped || []).length,
      skipped: (result.skipped || []).slice(0, 80),
    },
    backups,
    applied,
  };
  const reportPath = path.join(runtimeDir, 'reports', `pending-optional-source-refill-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
