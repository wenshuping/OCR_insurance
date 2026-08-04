import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { materializeProductResponsibilityCards } from './materialize-product-responsibility-cards.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const artifactPath = path.join(root, 'artifacts/disease-full-disability-dedup-20260731/source-acquisition-final/source-ready-responsibility-artifacts.jsonl');
const clonePath = process.argv[2];
if (!clonePath) throw new Error('usage: node scripts/run-source-backed-canary.mjs <clone.sqlite>');
const db = new DatabaseSync(clonePath);
const now = new Date().toISOString();
const text = (v) => v == null ? '' : String(v).trim();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const details = [];

function readRows(company, productName) {
  return db.prepare('SELECT id, payload FROM insurance_indicator_records WHERE company = ? AND product_name = ?').all(company, productName).map((r) => ({ row: r, payload: JSON.parse(r.payload) }));
}
const products = fs.readFileSync(artifactPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  .filter((product) => readRows(product.company, product.productName).some(({ payload }) => text(payload.liability) === '疾病全残'))
  .slice(0, 20);
function updateCanonical(product, canonical) {
  const rows = readRows(product.company, product.productName);
  const target = rows.find(({ row }) => row.id === canonical.id || row.id === canonical.responsibilityId);
  const disease = rows.find(({ payload }) => text(payload.liability) === '疾病全残');
  if (!target || !disease) throw new Error(`${product.company}/${product.productName}: target or disease row missing`);
  const merged = { ...target.payload, ...canonical, id: target.row.id, company: product.company, productName: product.productName, updatedAt: now };
  db.prepare('UPDATE insurance_indicator_records SET liability = ?, payload = ? WHERE id = ?').run(merged.liability, JSON.stringify(merged), target.row.id);
  db.prepare('DELETE FROM insurance_indicator_records WHERE id = ?').run(disease.row.id);
  return { targetId: target.row.id, removedDiseaseId: disease.row.id };
}
for (const product of products) {
  const canonical = product.acceptedResponsibilities[0];
  const before = readRows(product.company, product.productName).length;
  const update = updateCanonical(product, canonical);
  const materialized = materializeProductResponsibilityCards({ dbPath: clonePath, write: true, company: product.company, productName: product.productName, sampleLimit: 20, now });
  const indicatorRows = readRows(product.company, product.productName);
  const tableRow = indicatorRows.find(({ row }) => row.id === update.targetId);
  const cards = db.prepare('SELECT id, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ?').all(product.company, product.productName).map((r) => ({ row: r, payload: JSON.parse(r.payload) }));
  const aggregateCards = cards.filter(({ payload }) => text(payload.title) === text(canonical.liability));
  const nested = aggregateCards.flatMap(({ payload }) => Array.isArray(payload.indicators) ? payload.indicators : []);
  const nestedCanonical = nested.find((x) => text(x.id) === update.targetId || text(x.responsibilityId) === text(canonical.responsibilityId));
  const expected = ['formulaText', 'normalizedFormula', 'requiredInputs', 'branches', 'operands', 'sourceDigest', 'sourceProvenance'];
  const mismatches = expected.filter((key) => !eq(tableRow?.payload?.[key], canonical[key] ?? (key === 'sourceProvenance' ? canonical.sourceProvenance : undefined)) || !eq(nestedCanonical?.[key], tableRow?.payload?.[key]));
  details.push({ company: product.company, productName: product.productName, beforeIndicatorRows: before, afterIndicatorRows: indicatorRows.length, aggregateCardCount: aggregateCards.length, nestedIndicatorCount: nested.length, tableRowId: tableRow?.row.id || '', nestedIndicatorId: nestedCanonical?.id || '', cardNestedIdMatchesTable: Boolean(tableRow && nestedCanonical && (nestedCanonical.id === tableRow.row.id || nestedCanonical.responsibilityId === tableRow.row.id)), fieldMismatches: mismatches, materialized: { insertedRows: materialized.insertedRows, deletedRows: materialized.deletedRows } });
}
const duplicateOrphanCount = details.reduce((n, d) => n + (d.aggregateCardCount !== 1 || d.nestedIndicatorCount !== 1 || !d.cardNestedIdMatchesTable ? 1 : 0), 0);
const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
const quick = db.prepare('PRAGMA quick_check').get();
const result = { canaryProducts: products.length, allOneAggregateCard: details.every((d) => d.aggregateCardCount === 1), allOneNestedIndicator: details.every((d) => d.nestedIndicatorCount === 1), allOneTableRow: details.every((d) => d.afterIndicatorRows >= 1), duplicateOrphanCount, fieldMismatchCount: details.reduce((n, d) => n + d.fieldMismatches.length, 0), foreignKeyIssues: fkIssues, quickCheck: quick, products: details };
const out = path.join(path.dirname(artifactPath), 'source-backed-canary-readback.json');
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, output: out, outputSha256: createHash('sha256').update(fs.readFileSync(out)).digest('hex') }, null, 2));
db.close();
