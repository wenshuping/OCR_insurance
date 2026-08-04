import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { materializeProductResponsibilityCards } from './materialize-product-responsibility-cards.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dbPath = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
if (!dbPath.startsWith('/Users/wenshuping/OCR_insurance_ssd/')) throw new Error('refusing non-SSD target');
const dir = path.join(root, 'artifacts/disease-full-disability-dedup-20260731');
const artifactPath = path.join(dir, 'source-acquisition-final/source-ready-responsibility-artifacts.jsonl');
const backupDir = path.join(dir, 'ssd-write-backups-20260731');
fs.mkdirSync(backupDir, { recursive: true });
const products = fs.readFileSync(artifactPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const batchSize = 20;
const text = (v) => v == null ? '' : String(v).trim();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = (file) => {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
const now = new Date().toISOString();
const progressPath = path.join(dir, 'ssd-write-progress.json');
const prior = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, 'utf8')) : null;

function rows(db, company, productName) {
  return db.prepare('SELECT id, payload FROM insurance_indicator_records WHERE company = ? AND product_name = ?').all(company, productName).map((r) => ({ row: r, payload: JSON.parse(r.payload) }));
}
function repairProduct(product) {
  const canonical = product.acceptedResponsibilities[0];
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const all = rows(db, product.company, product.productName);
    const target = all.find(({ row }) => row.id === canonical.id || row.id === canonical.responsibilityId);
    const disease = all.find(({ payload }) => text(payload.liability) === '疾病全残');
    if (!target || !disease) throw new Error('target_or_disease_row_missing');
    const merged = { ...target.payload, ...canonical, id: target.row.id, company: product.company, productName: product.productName, updatedAt: now };
    db.prepare('UPDATE insurance_indicator_records SET liability = ?, payload = ? WHERE id = ?').run(merged.liability, JSON.stringify(merged), target.row.id);
    db.prepare('DELETE FROM insurance_indicator_records WHERE id = ?').run(disease.row.id);
    db.exec('COMMIT');
    return { targetId: target.row.id, removedDiseaseId: disease.row.id };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}
function readback(product, canonical, targetId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const indicators = rows(db, product.company, product.productName);
    const table = indicators.find(({ row }) => row.id === targetId);
    const diseaseCount = indicators.filter(({ payload }) => text(payload.liability) === '疾病全残').length;
    const cards = db.prepare('SELECT id, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ?').all(product.company, product.productName).map((r) => JSON.parse(r.payload));
    const aggregates = cards.filter((c) => text(c.title) === text(canonical.liability));
    const targetCards = aggregates.filter((c) => (Array.isArray(c.indicators) ? c.indicators : []).some((x) => text(x.id) === targetId || text(x.responsibilityId) === text(canonical.responsibilityId)));
    const nested = targetCards.flatMap((c) => (Array.isArray(c.indicators) ? c.indicators : []).filter((x) => text(x.id) === targetId || text(x.responsibilityId) === text(canonical.responsibilityId)));
    const nestedRow = nested[0];
    const fields = ['formulaText', 'normalizedFormula', 'requiredInputs', 'branches', 'operands', 'sourceDigest', 'sourceProvenance'];
    const mismatches = fields.filter((key) => !eq(table?.payload?.[key], canonical[key] ?? (key === 'sourceProvenance' ? canonical.sourceProvenance : undefined)) || !eq(nestedRow?.[key], table?.payload?.[key]));
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    return { company: product.company, productName: product.productName, indicatorRows: indicators.length, diseaseCount, aggregateCardCount: targetCards.length, aggregateTitleCardCount: aggregates.length, nestedIndicatorCount: nested.length, tableRowId: table?.row.id || '', nestedIndicatorId: nestedRow?.id || '', mismatches, foreignKeyIssues: fk, quickCheck: db.prepare('PRAGMA quick_check').get() };
  } finally { db.close(); }
}
const committedKeys = new Set((prior?.batches || []).filter((x) => x.status === 'committed').flatMap((x) => x.products || []).map((x) => `${x.company}\u001f${x.productName}`));
const materializerBlocked = [];
const pending = products.filter((product) => {
  if (committedKeys.has(`${product.company}\u001f${product.productName}`)) return false;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  const all = rows(db, product.company, product.productName);
  db.close();
  const canonical = product.acceptedResponsibilities[0];
  const target = all.find(({ row }) => row.id === canonical.id || row.id === canonical.responsibilityId);
  const disease = all.find(({ payload }) => text(payload.liability) === '疾病全残');
  if (!target || !disease) {
    materializerBlocked.push({ company: product.company, productName: product.productName, reason: 'target_or_disease_row_missing', targetPresent: Boolean(target), diseasePresent: Boolean(disease) });
    return false;
  }
  return true;
});
const priorBatchNumbers = (prior?.batches || []).map((x) => Number(String(x.name || '').replace(/\D/gu, '')) || 0);
let nextBatchNumber = Math.max(0, ...priorBatchNumbers) + 1;
const report = { target: dbPath, targetBeforeSha256: sha(dbPath), batchSize, batches: prior?.batches || [], materializerBlocked: prior?.materializerBlocked || [], startedAt: prior?.startedAt || now, resumedAt: prior ? now : undefined };
for (let start = 0; start < pending.length; start += batchSize) {
  const batch = pending.slice(start, start + batchSize);
  const name = `batch-${String(nextBatchNumber++).padStart(3, '0')}`;
  const backup = path.join(backupDir, `${name}.before.sqlite`);
  fs.copyFileSync(dbPath, backup);
  const beforeSha = sha(backup);
  const item = { name, productCount: batch.length, products: [], backup, backupSha256: beforeSha, status: 'running' };
  try {
    for (const product of batch) {
      const canonical = product.acceptedResponsibilities[0];
      const update = repairProduct(product);
      const materialized = materializeProductResponsibilityCards({ dbPath, write: true, company: product.company, productName: product.productName, sampleLimit: 20, now });
      const rb = readback(product, canonical, update.targetId);
      if (rb.diseaseCount !== 0 || rb.aggregateCardCount !== 1 || rb.nestedIndicatorCount !== 1 || rb.mismatches.length || rb.foreignKeyIssues.length || rb.quickCheck.quick_check !== 'ok') throw new Error(`readback_failed:${JSON.stringify(rb)}`);
      item.products.push({ ...rb, removedDiseaseId: update.removedDiseaseId, materialized: { insertedRows: materialized.insertedRows, deletedRows: materialized.deletedRows } });
    }
    item.status = 'committed';
    item.afterSha256 = sha(dbPath);
  } catch (error) {
    fs.copyFileSync(backup, dbPath);
    item.status = 'rolled_back';
    item.error = String(error?.stack || error);
    item.rollbackSha256 = sha(dbPath);
    report.batches.push(item);
    fs.writeFileSync(progressPath, JSON.stringify(report, null, 2) + '\n');
    throw error;
  }
  report.batches.push(item);
  fs.writeFileSync(progressPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ batch: name, status: item.status, productCount: batch.length, afterSha256: item.afterSha256 }));
}
report.materializerBlocked.push(...materializerBlocked);
report.finishedAt = new Date().toISOString();
report.targetAfterSha256 = sha(dbPath);
fs.writeFileSync(progressPath, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'ssd-write-receipt.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: 'completed', productCount: products.length, targetAfterSha256: report.targetAfterSha256 }));
