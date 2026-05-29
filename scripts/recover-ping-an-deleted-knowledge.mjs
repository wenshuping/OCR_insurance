import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocateId, createInitialState } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const statePath = path.resolve(process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'));
const catalogPath = path.resolve(process.env.PING_AN_CATALOG_PATH || path.join(runtimeDir, 'ping-an-product-catalog.json'));
const defaultAuditPath = path.join(runtimeDir, 'responsibility-toc-cleanup-20260522-014101.json');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

function trim(value) {
  return String(value || '').trim();
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '').replace('T', '-');
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readNumberArg(name, fallback = 0) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

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

function normalizeProductName(value) {
  return trim(value)
    .replace(/[\s（）()【】[\]<>《》,，、·.。:：;；\-—_]/gu, '')
    .replace(/分红型|万能型/gu, '');
}

function parsePingAnUrl(url) {
  try {
    const parsed = new URL(trim(url));
    return {
      planCode: parsed.searchParams.get('planCode') || '',
      versionNo: parsed.searchParams.get('versionNo') || '',
      attachmentType: parsed.searchParams.get('attachmentType') || '',
    };
  } catch {
    return { planCode: '', versionNo: '', attachmentType: '' };
  }
}

function versionSortValue(value) {
  const parts = trim(value)
    .split(/[^0-9]+/u)
    .map((part) => Number(part))
    .filter(Number.isFinite);
  return parts.reduce((total, part) => total * 1000 + part, 0);
}

function dateSortValue(value) {
  const match = trim(value).match(/(20\d{2})-(\d{2})-(\d{2})/u);
  if (!match) return trim(value).startsWith('在售') ? 99999999 : 0;
  return Number(`${match[1]}${match[2]}${match[3]}`);
}

function knowledgeStatusRank(value) {
  const status = trim(value);
  if (status === '已入库') return 3;
  if (status === '部分入库') return 2;
  if (status === '未入库') return 1;
  return 0;
}

function candidateKey(candidate) {
  return `${trim(candidate.planCode)}|${trim(candidate.versionNo)}`;
}

function buildExistingVersionKeys(state) {
  const byProduct = new Map();
  for (const record of Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : []) {
    if (trim(record.company) !== '中国平安') continue;
    const parsed = parsePingAnUrl(record.url);
    if (!parsed.planCode || !parsed.versionNo) continue;
    const productKey = normalizeProductName(record.productName);
    if (!productKey) continue;
    if (!byProduct.has(productKey)) byProduct.set(productKey, new Set());
    byProduct.get(productKey).add(`${parsed.planCode}|${parsed.versionNo}`);
  }
  return byProduct;
}

function sortCandidates(productKey, candidates, existingVersionKeys) {
  const companionVersions = existingVersionKeys.get(productKey) || new Set();
  return [...candidates].sort((left, right) => {
    const leftCompanion = companionVersions.has(candidateKey(left)) ? 1 : 0;
    const rightCompanion = companionVersions.has(candidateKey(right)) ? 1 : 0;
    return (
      rightCompanion - leftCompanion ||
      knowledgeStatusRank(right.knowledgeStatus) - knowledgeStatusRank(left.knowledgeStatus) ||
      dateSortValue(right.salesStatus) - dateSortValue(left.salesStatus) ||
      versionSortValue(right.versionNo) - versionSortValue(left.versionNo) ||
      String(right.termsUrl || '').localeCompare(String(left.termsUrl || ''))
    );
  });
}

function buildRecoveryPlan({ audit, catalog, state, offset, limit }) {
  const existingIds = new Set((state.knowledgeRecords || []).map((record) => String(record.id)));
  const existingUrls = new Set(
    (state.knowledgeRecords || [])
      .filter((record) => trim(record.company) === '中国平安')
      .map((record) => trim(record.url))
      .filter(Boolean),
  );
  const existingVersionKeys = buildExistingVersionKeys(state);
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const catalogByProduct = new Map();
  for (const product of products) {
    if (!product?.hasTerms || !trim(product.termsUrl)) continue;
    const key = normalizeProductName(product.productName);
    if (!key) continue;
    if (!catalogByProduct.has(key)) catalogByProduct.set(key, []);
    catalogByProduct.get(key).push(product);
  }

  const deletedRows = (Array.isArray(audit.deleted) ? audit.deleted : [])
    .filter((row) => trim(row.company) === '中国平安' && trim(row.materialType || 'terms') === 'terms')
    .sort((left, right) => Number(left.id) - Number(right.id));
  const groups = new Map();
  for (const row of deletedRows) {
    const key = normalizeProductName(row.productName);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const selected = [];
  const alreadyExisting = [];
  const unmatched = [];
  const ambiguous = [];
  for (const [productKey, rows] of groups) {
    const candidates = sortCandidates(productKey, catalogByProduct.get(productKey) || [], existingVersionKeys);
    if (candidates.length > rows.length) {
      ambiguous.push({
        productName: rows[0]?.productName || '',
        deletedCount: rows.length,
        candidateCount: candidates.length,
        chosen: candidates.slice(0, rows.length).map((candidate) => ({
          planCode: candidate.planCode,
          versionNo: candidate.versionNo,
          salesStatus: candidate.salesStatus,
          knowledgeStatus: candidate.knowledgeStatus,
          termsUrl: candidate.termsUrl,
        })),
      });
    }
    for (const [index, row] of rows.entries()) {
      const candidate = candidates[index];
      if (!candidate) {
        unmatched.push({ id: row.id, productName: row.productName, reason: 'no_catalog_candidate' });
        continue;
      }
      const task = {
        restoreId: Number(row.id),
        productName: trim(candidate.productName || row.productName),
        productType: trim(candidate.productType),
        salesStatus: trim(candidate.salesStatus),
        label: '产品条款',
        materialType: 'terms',
        url: trim(candidate.termsUrl),
        planCode: trim(candidate.planCode),
        versionNo: trim(candidate.versionNo),
        knowledgeStatus: trim(candidate.knowledgeStatus),
        deletedOldPreview: trim(row.oldPreview).slice(0, 240),
      };
      if (existingIds.has(String(task.restoreId))) {
        unmatched.push({ id: row.id, productName: row.productName, url: task.url, reason: 'restore_id_already_exists' });
        continue;
      }
      if (existingUrls.has(task.url)) {
        alreadyExisting.push(task);
        continue;
      }
      selected.push(task);
    }
  }

  const slicedTasks = limit ? selected.slice(offset, offset + limit) : selected.slice(offset);
  return { deletedRows, selected, tasks: slicedTasks, alreadyExisting, unmatched, ambiguous };
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
    throw new Error(`中国平安误删资料恢复失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`中国平安误删资料恢复没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function main() {
  const auditPath = path.resolve(readArg('audit-path', process.env.PING_AN_RECOVERY_AUDIT_PATH || defaultAuditPath));
  const cdpUrl = readArg('cdp-url', process.env.PING_AN_CDP_URL || 'http://127.0.0.1:9223');
  const offset = readNumberArg('offset', Number(process.env.PING_AN_RECOVERY_OFFSET || 0));
  const limit = readNumberArg('limit', Number(process.env.PING_AN_RECOVERY_LIMIT || 0));
  const delayMs = readNumberArg('delay-ms', Number(process.env.PING_AN_RECOVERY_DELAY_MS || 900));
  const pdfRetryCount = readNumberArg('pdf-retry-count', Number(process.env.PING_AN_RECOVERY_PDF_RETRY_COUNT || 4));
  const pdfRetryDelayMs = readNumberArg('pdf-retry-delay-ms', Number(process.env.PING_AN_RECOVERY_PDF_RETRY_DELAY_MS || 5000));
  const dryRun = process.argv.includes('--dry-run');
  const ts = timestampForFile();

  const state = readJson(statePath, createInitialState());
  if (!Array.isArray(state.knowledgeRecords)) state.knowledgeRecords = [];
  if (!Number(state.nextId)) state.nextId = 1;
  const audit = readJson(auditPath, {});
  const catalog = readJson(catalogPath, {});
  const plan = buildRecoveryPlan({ audit, catalog, state, offset, limit });

  const tasksPath = path.join(runtimeDir, `ping-an-deleted-recovery-tasks-${ts}.json`);
  writeJson(tasksPath, {
    auditPath,
    catalogPath,
    statePath,
    offset,
    limit,
    deletedCount: plan.deletedRows.length,
    recoverableTaskCount: plan.selected.length,
    selectedTaskCount: plan.tasks.length,
    alreadyExistingCount: plan.alreadyExisting.length,
    unmatchedCount: plan.unmatched.length,
    ambiguousCount: plan.ambiguous.length,
    tasks: plan.tasks,
    alreadyExisting: plan.alreadyExisting,
    unmatched: plan.unmatched,
    ambiguous: plan.ambiguous,
  });

  if (dryRun || !plan.tasks.length) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun,
          deletedCount: plan.deletedRows.length,
          recoverableTaskCount: plan.selected.length,
          selectedTaskCount: plan.tasks.length,
          alreadyExistingCount: plan.alreadyExisting.length,
          unmatchedCount: plan.unmatched.length,
          ambiguousCount: plan.ambiguous.length,
          tasksPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  const beforeCount = state.knowledgeRecords.length;
  const beforePingAnCount = state.knowledgeRecords.filter((record) => trim(record.company) === '中国平安').length;
  const backupPath = path.join(runtimeDir, `state-before-ping-an-recovery-${ts}.json`);
  writeJson(backupPath, state);

  const result = runCrawler({
    mode: 'ping_an_browser_catalog_materials',
    company: '中国平安',
    cdpUrl,
    tasks: plan.tasks,
    delayMs,
    pdfRetryCount,
    pdfRetryDelayMs,
  });
  if (result.ok === false) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

  const taskByUrl = new Map(plan.tasks.map((task) => [task.url, task]));
  const restoredRecords = [];
  for (const record of Array.isArray(result.records) ? result.records : []) {
    const task = taskByUrl.get(trim(record.url));
    if (!task) continue;
    restoredRecords.push({
      ...record,
      id: task.restoreId,
      productName: task.productName || record.productName,
      productType: task.productType || record.productType,
      salesStatus: task.salesStatus || record.salesStatus,
      parser: 'scrapling_ping_an_deleted_recovery',
    });
  }

  const saved = upsertKnowledgeRecords(state, restoredRecords, { allocateId });
  writeJson(statePath, state);

  const savedIds = saved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
  const syncStatePath = path.join(runtimeDir, `ping-an-deleted-recovery-sync-state-${ts}.json`);
  writeJson(syncStatePath, { ...createInitialState(), knowledgeRecords: saved, nextId: 1 });

  const reportPath = path.join(runtimeDir, `ping-an-deleted-recovery-${ts}.json`);
  writeJson(reportPath, {
    ok: true,
    auditPath,
    catalogPath,
    statePath,
    backupPath,
    tasksPath,
    syncStatePath,
    cdpUrl,
    delayMs,
    pdfRetryCount,
    pdfRetryDelayMs,
    offset,
    limit,
    deletedCount: plan.deletedRows.length,
    recoverableTaskCount: plan.selected.length,
    selectedTaskCount: plan.tasks.length,
    crawledRecordCount: restoredRecords.length,
    skippedCount: result.skippedCount || 0,
    skipped: result.skipped || [],
    savedRecordCount: saved.length,
    savedMinId: savedIds[0] || null,
    savedMaxId: savedIds.at(-1) || null,
    savedIds,
    alreadyExistingCount: plan.alreadyExisting.length,
    unmatchedCount: plan.unmatched.length,
    ambiguousCount: plan.ambiguous.length,
    localKnowledgeBefore: beforeCount,
    localKnowledgeAfter: state.knowledgeRecords.length,
    localPingAnBefore: beforePingAnCount,
    localPingAnAfter: state.knowledgeRecords.filter((record) => trim(record.company) === '中国平安').length,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        deletedCount: plan.deletedRows.length,
        recoverableTaskCount: plan.selected.length,
        selectedTaskCount: plan.tasks.length,
        crawledRecordCount: restoredRecords.length,
        skippedCount: result.skippedCount || 0,
        savedRecordCount: saved.length,
        savedMinId: savedIds[0] || null,
        savedMaxId: savedIds.at(-1) || null,
        alreadyExistingCount: plan.alreadyExisting.length,
        unmatchedCount: plan.unmatched.length,
        ambiguousCount: plan.ambiguous.length,
        localKnowledgeBefore: beforeCount,
        localKnowledgeAfter: state.knowledgeRecords.length,
        localPingAnBefore: beforePingAnCount,
        localPingAnAfter: state.knowledgeRecords.filter((record) => trim(record.company) === '中国平安').length,
        tasksPath,
        reportPath,
        syncStatePath,
      },
      null,
      2,
    ),
  );
}

main();
