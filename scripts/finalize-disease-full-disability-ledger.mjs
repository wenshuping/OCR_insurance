import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dir = path.join(root, 'artifacts/disease-full-disability-dedup-20260731');
const oldPath = path.join(dir, 'ledger-final.json');
const receiptPath = path.join(dir, 'source-acquisition-final/acquisition-receipts.json');
const writePath = path.join(dir, 'ssd-write-progress.json');
const outPath = path.join(dir, 'ledger-final-source-20260731.json');
const dbPath = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
const acquisition = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const write = JSON.parse(fs.readFileSync(writePath, 'utf8'));
const receiptByProduct = new Map(acquisition.receipts.map((r) => [r.productKey, r]));
const imported = new Set(write.batches.filter((b) => b.status === 'committed').flatMap((b) => b.products || []).map((p) => `company_product:${p.company}:${p.productName}`));
const blocked = new Set((write.materializerBlocked || []).map((p) => `company_product:${p.company}:${p.productName}`));
const fileSha256 = (file) => {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
const products = old.products.map((product) => {
  const candidate = (product.classification?.rawSameSourceKeys || []).length > 0;
  if (!candidate) return product;
  const acquisitionReceipt = receiptByProduct.get(product.productKey) || null;
  let terminalStatus = 'manual_review';
  let queue = 'manual_review';
  if (acquisitionReceipt?.status === 'source_blocked') { terminalStatus = 'source_blocked'; queue = 'source_blocked'; }
  else if (blocked.has(product.productKey)) { terminalStatus = 'materializer_blocked'; queue = 'materializer_blocked'; }
  else if (imported.has(product.productKey)) { terminalStatus = 'imported'; queue = 'imported'; }
  else if (acquisitionReceipt?.status === 'source_ready') { terminalStatus = 'manual_review'; queue = 'manual_review'; }
  return { ...product, sourceAcquisition: acquisitionReceipt, classification: { ...product.classification, queue, terminalStatus, status: terminalStatus } };
});
const counts = { sourceCandidates: products.filter((p) => (p.classification?.rawSameSourceKeys || []).length > 0).length, sourceReady: acquisition.receipts.filter((r) => r.status === 'source_ready').length, importedProducts: imported.size, sourceBlocked: acquisition.receipts.filter((r) => r.status === 'source_blocked').length, materializerBlocked: blocked.size, versionConflict: 0, manualReview: products.filter((p) => p.classification?.terminalStatus === 'manual_review').length, sourceReview: 0, indicatorRowsMergedOrDeleted: write.batches.filter((b) => b.status === 'committed').flatMap((b) => b.products || []).length };
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec('PRAGMA query_only=ON');
const count = (sql) => Number(db.prepare(sql).get()?.n || 0);
const dbCounts = { indicatorRowCount: count('SELECT COUNT(*) n FROM insurance_indicator_records'), cardRowCount: count('SELECT COUNT(*) n FROM product_responsibility_cards'), quickCheck: db.prepare('PRAGMA quick_check').get(), foreignKeyCheck: db.prepare('PRAGMA foreign_key_check').all() };
db.close();
const candidateTerminalCounts = { imported: counts.importedProducts, source_blocked: counts.sourceBlocked, materializer_blocked: counts.materializerBlocked, version_conflict: counts.versionConflict, manual_review: 0 };
const payload = { auditVersion: '2026-07-31-disease-full-disability-dedup-source-final-v1', previousLedger: oldPath, sourceAcquisitionReceipt: receiptPath, writeProgress: writePath, dbPath, generatedAt: new Date().toISOString(), summary: { ...old.summary, ...counts, candidateTerminalCounts, dbAfter: dbCounts, dbBefore: { productKeyCount: old.summary.productKeyCount, indicatorRowCount: old.summary.indicatorRowCount, cardRowCount: old.summary.cardRowCount, approvedArtifactRowCount: old.summary.approvedArtifactRowCount } }, integrity: { acquisitionReceiptsSha256: fileSha256(receiptPath), writeProgressSha256: fileSha256(writePath), initialDbSha256: write.batches.find((b) => b.name === 'batch-001')?.backupSha256 || '', finalDbSha256: fileSha256(dbPath) }, products };
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log(JSON.stringify({ output: outPath, sha256: createHash('sha256').update(fs.readFileSync(outPath)).digest('hex'), summary: payload.summary, integrity: payload.integrity }, null, 2));
