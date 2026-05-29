import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const defaultStatePath = path.join(runtimeDir, 'state.json');

function trim(value) {
  return String(value || '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
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

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function recordKey(record) {
  return `${trim(record.company)}||${trim(record.productName)}`;
}

function sourceScore(record) {
  const title = trim(record.title);
  const materialType = trim(record.materialType || record.sourceType);
  const status = trim(record.qualityStatus);
  return (
    (status.startsWith('valid') ? 20 : 0) +
    (materialType === 'terms' ? 12 : 0) +
    (/条款/u.test(title) ? 8 : 0) +
    (/产品说明/u.test(title) ? 2 : 0) +
    Math.min(trim(record.pageText).length / 1000, 8)
  );
}

function main() {
  const statePath = path.resolve(readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || defaultStatePath));
  const suspectsPath = trim(readArg('suspects-path', ''));
  const dryRun = process.argv.includes('--dry-run');
  const now = new Date().toISOString();
  const stamp = timestampForFile();

  const state = readJson(statePath, {});
  if (!Array.isArray(state.knowledgeRecords)) {
    throw new Error(`未找到 knowledgeRecords：${statePath}`);
  }

  const suspectIds = new Set();
  if (suspectsPath) {
    const suspects = readJson(path.resolve(suspectsPath), []);
    for (const item of Array.isArray(suspects) ? suspects : []) {
      const id = trim(item.id || item.localId);
      if (id) suspectIds.add(id);
    }
  }

  const sourceByKey = new Map();
  for (const record of state.knowledgeRecords) {
    if (!trim(record.company) || !trim(record.productName) || !trim(record.pageText)) continue;
    const key = recordKey(record);
    const candidate = { record, score: sourceScore(record) };
    const existing = sourceByKey.get(key);
    if (!existing || candidate.score > existing.score) sourceByKey.set(key, candidate);
  }

  const refilled = [];
  const skipped = [];
  for (const record of state.knowledgeRecords) {
    const id = trim(record.id);
    if (suspectIds.size && !suspectIds.has(id)) continue;
    if (!trim(record.company) || !trim(record.productName) || trim(record.pageText)) continue;
    if (trim(record.qualityStatus) !== 'invalid_responsibility') continue;
    const source = sourceByKey.get(recordKey(record))?.record;
    if (!source || trim(source.id) === id || !trim(source.pageText)) {
      skipped.push({ id, company: trim(record.company), productName: trim(record.productName), reason: 'same_product_source_missing' });
      continue;
    }

    const sourceUrl = trim(source.url);
    const sourceTitle = trim(source.title) || trim(source.productName);
    if (!dryRun) {
      record.pageText = trim(source.pageText);
      record.snippet = `同产品官方资料已存在保险责任正文，责任来源：${sourceTitle}${sourceUrl ? `（${sourceUrl}）` : ''}`;
      record.parser = 'same_product_official_responsibility_refill';
      record.qualityStatus = 'valid_responsibility_refilled';
      record.qualityReason = '';
      record.responsibilitySourceId = trim(source.id);
      record.responsibilitySourceTitle = sourceTitle;
      record.responsibilitySourceUrl = sourceUrl;
      record.refilledAt = now;
      record.lastFetchedAt = now;
      record.updatedAt = now;
      if (!trim(record.officialDomain) && trim(source.officialDomain)) record.officialDomain = trim(source.officialDomain);
    }
    refilled.push({
      id,
      company: trim(record.company),
      productName: trim(record.productName),
      title: trim(record.title),
      url: trim(record.url),
      sourceId: trim(source.id),
      sourceTitle,
      sourceUrl,
      pageTextLength: trim(source.pageText).length,
      preview: trim(source.pageText).slice(0, 220),
    });
  }

  const report = {
    ok: true,
    dryRun,
    statePath,
    suspectsPath: suspectsPath ? path.resolve(suspectsPath) : '',
    refilledCount: refilled.length,
    skippedCount: skipped.length,
    refilled,
    skipped,
  };
  const reportPath = path.join(runtimeDir, `same-product-responsibility-refill-report-${stamp}.json`);
  const suspectsOutPath = path.join(runtimeDir, `same-product-responsibility-refilled-suspects-${stamp}.json`);
  writeJson(reportPath, report);
  writeJson(suspectsOutPath, refilled);
  if (!dryRun) writeJson(statePath, state);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        refilledCount: refilled.length,
        skippedCount: skipped.length,
        reportPath,
        suspectsPath: suspectsOutPath,
      },
      null,
      2,
    ),
  );
}

main();
