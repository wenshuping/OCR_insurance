import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const REPO = '/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration';
const ROOT = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v7-clone-and-medical-table';
const CLONE = path.join(ROOT, 'clone.sqlite');
const ARTIFACT = path.join(ROOT, 'medical-table/artifact.json');
const IMPORTER = path.join(REPO, 'scripts/import-reviewed-responsibility-artifacts.mjs');
const text = (v) => v === null || v === undefined ? '' : String(v);
const rows = (v) => Array.isArray(v) ? v : [];
const compact = (v) => text(v).normalize('NFKC').replace(/\s+/gu, '');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
function sha256(p) { const h = createHash('sha256'); const fd = fs.openSync(p, 'r'); const b = Buffer.allocUnsafe(1024 * 1024); let n = 0; try { while (true) { const c = fs.readSync(fd, b, 0, b.length, null); if (!c) break; h.update(b.subarray(0, c)); n += c; } } finally { fs.closeSync(fd); } return { algorithm: 'sha256', digest: h.digest('hex'), bytes: n }; }
function open() { const db = new DatabaseSync(CLONE); db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;'); return db; }
function counts(db, company, productName) { return { cards: Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE company = ? AND product_name = ?').get(company, productName)?.count || 0), indicators: Number(db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records WHERE company = ? AND product_name = ?').get(company, productName)?.count || 0), artifacts: Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_artifacts WHERE company = ? AND product_name = ?').get(company, productName)?.count || 0) }; }
function main() {
  const artifact = readJson(ARTIFACT); const beforeDb = open(); const before = counts(beforeDb, artifact.company, artifact.productName); beforeDb.close();
  const stdout = execFileSync(process.execPath, [IMPORTER, `--db-path=${CLONE}`, `--artifacts=${ARTIFACT}`, '--sample-limit=10', '--write', '--isolated-clone'], { cwd: REPO, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const importer = JSON.parse(stdout); writeJson(path.join(ROOT, 'medical-table/clone-import.json'), { schema: 'v7-medical-clone-formal-import/v1', dbPath: CLONE, write: true, isolatedClone: true, realDbWrite: false, importer });
  const db = open();
  const cards = db.prepare('SELECT id, title, source_url, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? ORDER BY id').all(artifact.company, artifact.productName).map((row) => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
  const records = db.prepare('SELECT id, liability, payload FROM insurance_indicator_records WHERE company = ? AND product_name = ? ORDER BY id').all(artifact.company, artifact.productName).map((row) => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
  const expected = rows(artifact.acceptedResponsibilities); const expectedIndicators = expected.flatMap((r) => rows(r.indicators)); const mismatches = [];
  if (cards.length !== expected.length) mismatches.push(`cards:${cards.length}!=${expected.length}`);
  if (records.length !== expectedIndicators.length) mismatches.push(`indicators:${records.length}!=${expectedIndicators.length}`);
  for (const responsibility of expected) {
    const expectedIndicator = rows(responsibility.indicators)[0]; const card = cards.find((row) => compact(row.title) === compact(responsibility.title)); const nested = card?.payload?.indicators?.find((item) => item.responsibilityId === responsibility.responsibilityId); const record = records.find((row) => row.payload.responsibilityId === responsibility.responsibilityId);
    if (!card) { mismatches.push(`${responsibility.responsibilityId}:card_missing`); continue; }
    if (!nested) { mismatches.push(`${responsibility.responsibilityId}:nested_missing`); continue; }
    if (!record) { mismatches.push(`${responsibility.responsibilityId}:record_missing`); continue; }
    for (const field of ['sourceUrl', 'sourceDigest', 'formulaText', 'normalizedFormula', 'requiredInputs', 'operands', 'branches', 'evidenceSegments', 'provenance', 'calculationKey', 'basisKey']) {
      if (expectedIndicator[field] !== undefined && JSON.stringify(nested[field] ?? null) !== JSON.stringify(expectedIndicator[field])) mismatches.push(`${responsibility.responsibilityId}:${field}`);
      if (JSON.stringify(record.payload[field] ?? null) !== JSON.stringify(nested[field] ?? null)) mismatches.push(`${responsibility.responsibilityId}:record_${field}`);
    }
    if (text(card.payload.sourceDigest) !== text(nested.sourceDigest)) mismatches.push(`${responsibility.responsibilityId}:card_digest`);
    if (text(record.id) !== text(nested.id)) mismatches.push(`${responsibility.responsibilityId}:id_bidirectional`);
  }
  const duplicateCards = cards.filter((row, index) => cards.findIndex((candidate) => compact(candidate.title) === compact(row.title)) !== index).length;
  const nestedIds = new Set(cards.flatMap((row) => rows(row.payload.indicators).map((i) => i.id))); const recordIds = new Set(records.map((row) => row.id)); const orphanCount = [...nestedIds].filter((id) => !recordIds.has(id)).length + [...recordIds].filter((id) => !nestedIds.has(id)).length;
  const readback = { schema: 'v7-medical-three-layer-exact-readback/v1', company: artifact.company, productName: artifact.productName, expectedResponsibilities: expected.length, expectedIndicators: expectedIndicators.length, actualCards: cards.length, actualNestedIndicators: [...nestedIds].length, actualIndicatorRecords: records.length, duplicateCardCount: duplicateCards, orphanIndicatorCount: orphanCount, mismatches, ok: mismatches.length === 0 && duplicateCards === 0 && orphanCount === 0 };
  db.close(); writeJson(path.join(ROOT, 'medical-table/clone-readback.json'), readback);
  const integrityDb = new DatabaseSync(CLONE); integrityDb.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;'); const quickCheck = text(integrityDb.prepare('PRAGMA quick_check').get()?.quick_check); const fk = integrityDb.prepare('PRAGMA foreign_key_check').all(); integrityDb.close();
  const integrity = { schema: 'v7-medical-clone-integrity/v1', dbPath: CLONE, queryOnly: 1, quickCheck, foreignKeyCheckCount: fk.length, sqliteMode: 'ro/query_only' }; writeJson(path.join(ROOT, 'medical-table/clone-integrity.json'), integrity);
  const terminal = { schema: 'v7-medical-clone-terminal/v1', terminal: importer.ok === true && importer.validationIssueCount === 0 && importer.materializedProducts === 1 && readback.ok && quickCheck === 'ok' && fk.length === 0 ? 'clone_pass' : 'validation_failure', clonePass: importer.ok === true && importer.validationIssueCount === 0 && importer.materializedProducts === 1 && readback.ok && quickCheck === 'ok' && fk.length === 0, sourceDigest: artifact.sourceDigest, officialResponsibilities: expected.length, indicators: expectedIndicators.length, failedFields: mismatches, writesToRealDb: 0 };
  writeJson(path.join(ROOT, 'medical-table/clone-terminal.json'), terminal);
  const summaryPath = path.join(ROOT, 'summary.json'); const summary = readJson(summaryPath); summary.medical.clonePass = terminal.clonePass; summary.medical.terminal = terminal.terminal; if (terminal.clonePass) { summary.clone.clonePass += 1; summary.clone.importReadyResponsibilities += expected.length; summary.clone.importReadyIndicators += expectedIndicators.length; } writeJson(summaryPath, summary);
  const priorReady = fs.readFileSync(path.join(ROOT, 'import-ready.jsonl'), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).map(JSON.parse).filter((row) => row.selectionIndex !== 0); const row = { selectionIndex: 0, company: artifact.company, productName: artifact.productName, sourceDigest: artifact.sourceDigest, terminal: terminal.terminal, officialResponsibilities: expected.length, expectedIndicators: expectedIndicators.length, artifactPath: ARTIFACT, medicalTableRepair: true, clonePass: terminal.clonePass }; if (terminal.clonePass) priorReady.push(row); fs.writeFileSync(path.join(ROOT, 'import-ready.jsonl'), priorReady.map((item) => JSON.stringify(item)).join('\n') + (priorReady.length ? '\n' : ''));
  const files = fs.readdirSync(path.join(ROOT, 'medical-table')).filter((file) => file !== 'sha256.json').sort(); writeJson(path.join(ROOT, 'medical-table/sha256.json'), Object.fromEntries(files.map((file) => [file, sha256(path.join(ROOT, 'medical-table', file)).digest])));
  console.log(JSON.stringify({ terminal, before, after: counts((() => { const x = open(); return x; })(), artifact.company, artifact.productName) }));
}
main();
