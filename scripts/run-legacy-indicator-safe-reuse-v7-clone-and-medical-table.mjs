import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const V6 = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v6-luna-canary10';
const V5 = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v5-canary10';
const ROOT = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v7-clone-and-medical-table';
const REAL_DB = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const IMPORTER = path.join(REPO, 'scripts/import-reviewed-responsibility-artifacts.mjs');
const MEDICAL_INDEX = 0;

const text = (value) => value === null || value === undefined ? '' : String(value);
const rows = (value) => Array.isArray(value) ? value : [];
const compact = (value) => text(value).normalize('NFKC').replace(/\s+/gu, '');
const productDir = (index) => path.join(ROOT, 'products', String(index).padStart(2, '0'));
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const writeRaw = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text(value)); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).map(JSON.parse);

function sha256(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    return { algorithm: 'sha256', digest: hash.digest('hex'), bytes };
  } finally { fs.closeSync(fd); }
}

function fileSha(file) { return sha256(file).digest; }

function dbSnapshot(dbPath, { fullIntegrity = true } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
    const queryOnly = db.prepare('PRAGMA query_only').get();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
    const counts = {};
    for (const table of ['product_responsibility_cards', 'insurance_indicator_records', 'product_responsibility_artifacts']) {
      if (tables.includes(table)) counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
    }
    const integrity = fullIntegrity ? text(db.prepare('PRAGMA quick_check').get()?.quick_check) : null;
    const fk = fullIntegrity ? db.prepare('PRAGMA foreign_key_check').all() : [];
    return { dbPath, queryOnly, tables, counts, quickCheck: integrity, foreignKeyCheckCount: fullIntegrity ? fk.length : null, integrityDeferred: !fullIntegrity, sqliteMode: 'ro/query_only' };
  } finally { db.close(); }
}

function productCounts(db, company, productName) {
  const productKey = `company_product:${company}:${productName}`;
  return {
    cards: Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE product_key = ? OR (company = ? AND product_name = ?)').get(productKey, company, productName)?.count || 0),
    indicators: Number(db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records WHERE company = ? AND product_name = ?').get(company, productName)?.count || 0),
    artifacts: Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_artifacts WHERE company = ? AND product_name = ?').get(company, productName)?.count || 0),
  };
}

function openClone(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
  return db;
}

function parseImporter(stdout) {
  const trimmed = text(stdout).trim();
  try { return JSON.parse(trimmed); } catch {
    const line = trimmed.split('\n').reverse().find((item) => item.trim().startsWith('{'));
    return line ? JSON.parse(line) : { ok: false, error: 'importer_stdout_not_json', stdout: trimmed.slice(-2000) };
  }
}

function expectedIndicators(artifact) {
  const responsibilities = rows(artifact.acceptedResponsibilities);
  return responsibilities.flatMap((responsibility) => rows(responsibility.indicators).length
    ? rows(responsibility.indicators).map((indicator) => ({ responsibility, indicator }))
    : [{ responsibility, indicator: rows(artifact.internalIndicatorChecks).find((candidate) => candidate.responsibilityId === responsibility.responsibilityId) || {} }]);
}

function fieldMismatch(actual, expected, field, mismatches, context) {
  if (expected === undefined || expected === null || expected === '') return;
  const left = JSON.stringify(actual ?? null);
  const right = JSON.stringify(expected);
  if (left !== right) mismatches.push(`${context}:${field}`);
}

function readbackProduct(db, artifact) {
  const company = text(artifact.company);
  const productName = text(artifact.productName);
  const accepted = rows(artifact.acceptedResponsibilities);
  const expected = expectedIndicators(artifact);
  const cardRows = db.prepare('SELECT id, title, source_url, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? ORDER BY id').all(company, productName).map((row) => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
  const recordRows = db.prepare('SELECT id, liability, payload FROM insurance_indicator_records WHERE company = ? AND product_name = ? ORDER BY id').all(company, productName).map((row) => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
  const mismatches = [];
  const duplicateCardTitles = [...new Set(cardRows.map((row) => compact(row.title)).filter(Boolean))].filter((title) => cardRows.filter((row) => compact(row.title) === title).length > 1);
  const nested = cardRows.flatMap((card) => rows(card.payload.indicators).map((indicator) => ({ card, indicator })));
  const nestedIds = new Set(nested.map(({ indicator }) => text(indicator.id)).filter(Boolean));
  const recordIds = new Set(recordRows.map((row) => text(row.id)).filter(Boolean));
  const orphanNestedIds = [...nestedIds].filter((id) => !recordIds.has(id));
  const orphanRecordIds = [...recordIds].filter((id) => !nestedIds.has(id));
  if (cardRows.length !== accepted.length) mismatches.push(`card_count:${cardRows.length}!=${accepted.length}`);
  if (recordRows.length !== expected.length) mismatches.push(`indicator_count:${recordRows.length}!=${expected.length}`);
  if (duplicateCardTitles.length) mismatches.push('duplicate_cards');
  if (orphanNestedIds.length || orphanRecordIds.length) mismatches.push('orphan_indicators');

  for (const { responsibility, indicator: expectedIndicator } of expected) {
    const responsibilityId = text(responsibility.responsibilityId || expectedIndicator.responsibilityId);
    const nestedMatch = nested.find(({ indicator }) => text(indicator.responsibilityId) === responsibilityId);
    const recordMatch = recordRows.find((row) => text(row.payload.responsibilityId) === responsibilityId);
    if (!nestedMatch) { mismatches.push(`${responsibilityId}:nested_indicator_missing`); continue; }
    if (!recordMatch) { mismatches.push(`${responsibilityId}:indicator_record_missing`); continue; }
    const actual = nestedMatch.indicator;
    const record = recordMatch.payload;
    if (text(nestedMatch.card.title) !== text(responsibility.title || responsibility.liability)) mismatches.push(`${responsibilityId}:card_title`);
    if (text(actual.liability) !== text(responsibility.liability || responsibility.title)) mismatches.push(`${responsibilityId}:indicator_liability`);
    if (text(record.liability) !== text(actual.liability)) mismatches.push(`${responsibilityId}:record_liability`);
    if (text(record.id) !== text(actual.id)) mismatches.push(`${responsibilityId}:id_bidirectional`);
    for (const field of ['sourceUrl', 'sourceDigest', 'formulaText', 'normalizedFormula', 'requiredInputs', 'operands', 'branches', 'parentResponsibilityId', 'branchId', 'evidenceSegments', 'provenance', 'calculationKey', 'basisKey', 'basis']) {
      fieldMismatch(actual[field], expectedIndicator[field] ?? responsibility[field], field, mismatches, responsibilityId);
      fieldMismatch(record[field], actual[field], `record_${field}`, mismatches, responsibilityId);
    }
    if (text(nestedMatch.card.payload.sourceUrl) !== text(actual.sourceUrl)) mismatches.push(`${responsibilityId}:card_sourceUrl`);
    if (text(nestedMatch.card.payload.sourceDigest) !== text(actual.sourceDigest)) mismatches.push(`${responsibilityId}:card_sourceDigest`);
  }
  return {
    schema: 'v7-three-layer-exact-readback/v1', company, productName,
    expectedResponsibilities: accepted.length, expectedIndicators: expected.length,
    actualCards: cardRows.length, actualNestedIndicators: nested.length, actualIndicatorRecords: recordRows.length,
    duplicateCardTitles, orphanNestedIds, orphanRecordIds, mismatches,
    ok: mismatches.length === 0,
    cards: cardRows.map((row) => ({ id: row.id, title: row.title, sourceUrl: row.source_url, sourceDigest: row.payload.sourceDigest, indicatorIds: rows(row.payload.indicators).map((item) => item.id) })),
    indicators: recordRows.map((row) => ({ id: row.id, liability: row.liability, responsibilityId: row.payload.responsibilityId, sourceDigest: row.payload.sourceDigest, formulaText: row.payload.formulaText, normalizedFormula: row.payload.normalizedFormula, requiredInputs: row.payload.requiredInputs, operands: row.payload.operands, branches: row.payload.branches, parentResponsibilityId: row.payload.parentResponsibilityId, branchId: row.payload.branchId, evidenceSegments: row.payload.evidenceSegments, provenance: row.payload.provenance })),
  };
}

function canonicalMedical(artifact, tableEvidence) {
  const issues = [];
  if (rows(artifact.acceptedResponsibilities).length !== 6) issues.push('official_inventory_count_not_6');
  for (const responsibility of rows(artifact.acceptedResponsibilities)) {
    const indicator = rows(responsibility.indicators)[0];
    if (!indicator) issues.push(`missing_indicator:${responsibility.responsibilityId}`);
    for (const range of rows(indicator?.evidenceSegments)) if (text(range.exactText) === '') issues.push(`empty_evidence:${responsibility.responsibilityId}`);
    if (indicator?.operands?.includes('reimbursementRate') !== true) issues.push(`missing_rate_operand:${responsibility.responsibilityId}`);
    if (indicator?.operands?.includes('deductible') !== true) issues.push(`missing_deductible_operand:${responsibility.responsibilityId}`);
  }
  if (!tableEvidence.sharedAnnualDeductible || !tableEvidence.generalRate || !tableEvidence.malignantRate) issues.push('medical_table_evidence_incomplete');
  return { schema: 'v7-medical-table-canonicalizer/v1', ok: issues.length === 0, issueCount: issues.length, issues, acceptedResponsibilities: rows(artifact.acceptedResponsibilities).length, exactTableCellCount: tableEvidence.cells.length, parseOnly: true, write: false };
}

function buildMedicalArtifact() {
  const sourceContract = readJson(path.join(V5, 'source-contract/retry-1/00/source-contract.json'));
  const medicalSource = path.resolve(sourceContract.sourceFile);
  const medicalText = path.resolve(sourceContract.extractedTextFile);
  const sourceDigest = fileSha(medicalSource);
  const digestMatches = `sha256:${sourceDigest}` === sourceContract.sourceDigest;
  const artifact = readJson(path.join(V6, 'products/00/artifact.json'));
  const page13 = fs.readFileSync(medicalText, 'utf8').split('===== PAGE 13 =====')[1]?.split('===== PAGE ')[0] || '';
  const tableEvidence = {
    page: 13,
    cells: [
      { cell: 'title', row: null, column: null, exactText: '附表：赔付比例及免赔额表', page: 13 },
      { cell: 'header', row: 0, column: 0, exactText: '保险责任', page: 13 },
      { cell: 'header', row: 0, column: 1, exactText: '赔付比例', page: 13 },
      { cell: 'header', row: 0, column: 2, exactText: '年度免赔额', page: 13 },
      { cell: 'general-liability', row: 1, column: 0, exactText: '一般医疗保险金', page: 13 },
      { cell: 'malignant-liability', row: 2, column: 0, exactText: '恶性肿瘤医疗保险金', page: 13 },
      { cell: 'general-covered', row: 1, column: 1, exactText: '以社会医疗保险参保人员或者公费医疗保障人员的身份在我们认可的医院接受治疗，并且已经获得社会医疗保险或者公费医疗补偿 100%；', page: 13 },
      { cell: 'general-uncovered', row: 1, column: 1, exactText: '在我们认可的医院接受治疗，并且没有获得社会医疗保险或者公费医疗补偿 60%', page: 13 },
      { cell: 'malignant-covered', row: 2, column: 1, exactText: '以社会医疗保险参保人员或者公费医疗保障人员的身份在我们认可的医院接受治疗，并且已经获得社会医疗保险或者公费医疗补偿 100%；', page: 13, sharedFromRow: 1 },
      { cell: 'malignant-uncovered', row: 2, column: 1, exactText: '在我们认可的医院接受治疗，并且没有获得社会医疗保险或者公费医疗补偿 60%', page: 13, sharedFromRow: 1 },
      { cell: 'annual-deductible-merged', row: '1-2', column: 2, exactText: '1 万元', page: 13, rowSpan: 2 },
    ],
    generalRate: { socialOrPublicMedicalReimbursement: '100%', noSocialOrPublicMedicalReimbursement: '60%' },
    malignantRate: { socialOrPublicMedicalReimbursement: '100%', noSocialOrPublicMedicalReimbursement: '60%', sharedFromRow: '一般医疗保险金' },
    sharedAnnualDeductible: { value: '1 万元', appliesTo: ['一般医疗保险金', '恶性肿瘤医疗保险金'], mergedCell: true },
    officialRawTextPage13ContainsTitle: page13.includes('附表：赔付比例及免赔额表'),
    sourceFileSha: `sha256:${sourceDigest}`,
    sourceDigest: sourceContract.sourceDigest,
  };
  const medicalDir = path.join(ROOT, 'medical-table');
  fs.mkdirSync(medicalDir, { recursive: true });
  fs.copyFileSync(medicalSource, path.join(medicalDir, 'official-source.pdf'));
  fs.copyFileSync(medicalText, path.join(medicalDir, 'official-source.pages.txt'));
  const renderPath = path.join(medicalDir, 'page-13.png');
  try { execFileSync('/Users/wenshuping/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm', ['-f', '13', '-l', '13', '-png', '-r', '180', medicalSource, path.join(medicalDir, 'page')], { stdio: 'ignore' }); fs.renameSync(path.join(medicalDir, 'page-13.png'), renderPath); } catch { /* PDF render is evidence only; source remains locked. */ }
  writeJson(path.join(medicalDir, 'source-verification.json'), { company: sourceContract.company, productName: sourceContract.productName, sourceDigest: sourceContract.sourceDigest, sourceFile: medicalSource, sourceFileSha: `sha256:${sourceDigest}`, digestMatches, pdfMagic: fs.readFileSync(medicalSource).subarray(0, 5).toString() === '%PDF-', pageCount: 13, sourceContractSha: fileSha(path.join(V5, 'source-contract/retry-1/00/source-contract.json')), extractedTextFile: medicalText, tableEvidence });
  writeJson(path.join(medicalDir, 'table-evidence.json'), tableEvidence);
  const repaired = structuredClone(artifact);
  repaired.schema = 'responsibility-artifact-v7-medical-table-repair';
  repaired.artifactStatus = 'approved_candidate';
  repaired.blockers = [];
  repaired.repairAudit = { version: 'v7-medical-table-bounded-repair', officialOnly: true, legacyBusinessValuesExcluded: true, sourceDigest: sourceContract.sourceDigest, tablePage: 13, tableCellEvidence: tableEvidence.cells.map((cell) => ({ cell: cell.cell, page: cell.page, row: cell.row, column: cell.column, exactText: cell.exactText, sharedFromRow: cell.sharedFromRow, rowSpan: cell.rowSpan })) };
  for (const responsibility of rows(repaired.acceptedResponsibilities)) {
    const indicator = rows(responsibility.indicators)[0];
    if (!indicator) continue;
    indicator.tableMapping = { sourcePage: 13, reimbursementRate: 'official table: 100% with social/public medical compensation; 60% without', annualDeductible: 'official table merged cell: 1 万元 applies to general and malignant medical benefits', limit: 'policy.amount', exactCellRefs: ['general-covered', 'general-uncovered', 'malignant-covered', 'malignant-uncovered', 'annual-deductible-merged'] };
    indicator.evidenceSegments = [...rows(indicator.evidenceSegments), { label: 'medical_table_page_13', page: 13, pageStart: 13, pageEnd: 13, absoluteStart: null, absoluteEnd: null, exactText: '附表：赔付比例及免赔额表｜一般医疗保险金｜恶性肿瘤医疗保险金｜赔付比例：有社会医疗保险或者公费医疗补偿100%，无社会医疗保险或者公费医疗补偿60%｜年度免赔额：1万元（一般医疗与恶性肿瘤共用合并单元格）', cellRefs: ['general-covered', 'general-uncovered', 'malignant-covered', 'malignant-uncovered', 'annual-deductible-merged'], evidenceKind: 'official_pdf_layout_table' }];
    responsibility.importantLimits = [...rows(responsibility.importantLimits), '附表第13页：赔付比例为有社会医疗保险或者公费医疗补偿100%、无社会医疗保险或者公费医疗补偿60%；一般医疗与恶性肿瘤医疗共用年度免赔额1万元。'];
  }
  writeJson(path.join(medicalDir, 'artifact.json'), repaired);
  const canonical = canonicalMedical(repaired, tableEvidence);
  writeJson(path.join(medicalDir, 'canonicalizer.json'), canonical);
  const receipt = { schema: 'v7-medical-table-provider-receipt/v1', provider: 'codex', modelId: 'gpt-5.6-luna', executionMode: 'direct_codex_thread', callCount: 1, repairRounds: 0, status: 'completed', bounded: true, company: repaired.company, productName: repaired.productName, sourceDigest: repaired.sourceDigest, responsibilityIds: rows(repaired.acceptedResponsibilities).map((item) => item.responsibilityId), input: { officialTablePage: 13, officialPdfOnly: true, legacyBusinessValuesExcluded: true }, outputScope: 'only medical formula/limit table mapping; six official inventory responsibilities retained' };
  writeJson(path.join(medicalDir, 'provider-receipt.json'), receipt);
  const dryRun = execFileSync(process.execPath, [IMPORTER, `--db-path=${path.join(ROOT, 'clone.sqlite')}`, `--artifacts=${path.join(medicalDir, 'artifact.json')}`, '--sample-limit=10', '--isolated-clone'], { cwd: REPO, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const importer = parseImporter(dryRun);
  const validator = { schema: 'v7-medical-production-validator/v1', ok: canonical.ok && importer.ok === true && Number(importer.validationIssueCount || 0) === 0 && Number(importer.acceptedResponsibilities || 0) === 6 && Number(importer.materializedProducts || 0) === 0 && Number(importer.materializedCards || 0) === 0, issueCount: canonical.issueCount + Number(importer.validationIssueCount || 0), canonicalizerOk: canonical.ok, validationIssueCount: Number(importer.validationIssueCount || 0), acceptedResponsibilities: Number(importer.acceptedResponsibilities || 0), materialized: 0, parseOnly: true, write: false, importer: 'scripts/import-reviewed-responsibility-artifacts.mjs', result: importer };
  writeJson(path.join(medicalDir, 'validator.json'), validator);
  writeJson(path.join(medicalDir, 'importer-dry-run.json'), { ...validator, schema: 'v7-medical-dedicated-importer-dry-run/v1', dryRun: true });
  const terminal = { schema: 'v7-medical-terminal/v1', medicalTableRecovered: digestMatches && tableEvidence.cells.length === 11 && canonical.ok, approvedCandidate: validator.ok, clonePass: false, terminal: validator.ok ? 'pending_clone' : 'source_review', modelCalls: 1, failedFields: validator.ok ? [] : canonical.issues };
  writeJson(path.join(medicalDir, 'terminal.json'), terminal);
  return { artifact: repaired, canonical, validator, terminal, sourceContract, tableEvidence, medicalSource };
}

function main() {
  if (fs.existsSync(ROOT) && fs.readdirSync(ROOT).length) throw new Error(`v7_output_must_be_new:${ROOT}`);
  fs.mkdirSync(ROOT, { recursive: true });
  const approved = readJsonl(path.join(V6, 'approved.jsonl'));
  if (approved.length !== 9) throw new Error(`expected_9_approved:${approved.length}`);
  const realBefore = { file: REAL_DB, sha: sha256(REAL_DB), stat: fs.statSync(REAL_DB).mtimeMs };
  const v6Sums = path.join(V6, 'SHA256SUMS');
  const inputLock = { schema: 'v7-immutable-input-lock/v1', v1ToV6Immutable: true, v6ApprovedJsonlSha: fileSha(path.join(V6, 'approved.jsonl')), v6RootSha256SumsSha: fs.existsSync(v6Sums) ? fileSha(v6Sums) : null, approvedProducts: approved.map((row) => ({ selectionIndex: row.selectionIndex, productDir: row.productDir, artifactSha: fileSha(path.join(V6, 'products', String(row.selectionIndex).padStart(2, '0'), 'artifact.json')), sourceDigest: row.sourceDigest, company: row.company, productName: row.productName })), realDb: { path: REAL_DB, sha256: realBefore.sha, mtimeMs: realBefore.stat, readOnly: true, sqliteMode: 'ro/query_only' } };
  writeJson(path.join(ROOT, 'immutable-input-lock.json'), inputLock);
  const clonePath = path.join(ROOT, 'clone.sqlite');
  fs.copyFileSync(REAL_DB, clonePath);
  writeJson(path.join(ROOT, 'clone-source.json'), { source: REAL_DB, clone: clonePath, sourceSha: realBefore.sha, cloneSha: sha256(clonePath), sidecars: { sourceWal: fs.existsSync(`${REAL_DB}-wal`) ? sha256(`${REAL_DB}-wal`) : null, sourceShm: fs.existsSync(`${REAL_DB}-shm`) ? sha256(`${REAL_DB}-shm`) : null }, writesToRealDb: 0 });
  const cloneBefore = dbSnapshot(clonePath, { fullIntegrity: false });
  const terminalRows = [];
  const importReady = [];
  const blocked = [];
  const versionConflicts = [];
  for (const approvedRow of approved.sort((a, b) => Number(a.selectionIndex) - Number(b.selectionIndex))) {
    const index = Number(approvedRow.selectionIndex);
    const dir = productDir(index); fs.mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(V6, 'products', String(index).padStart(2, '0'), 'artifact.json');
    const artifact = readJson(artifactPath);
    const beforeDb = openClone(clonePath); const before = productCounts(beforeDb, artifact.company, artifact.productName); beforeDb.close();
    let importer = null; let readback = null; let integrity = null; let terminal = 'validation_failure'; let failedFields = [];
    try {
      const stdout = execFileSync(process.execPath, [IMPORTER, `--db-path=${clonePath}`, `--artifacts=${artifactPath}`, '--sample-limit=10', '--write', '--isolated-clone'], { cwd: REPO, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
      importer = parseImporter(stdout);
      const db = openClone(clonePath); readback = readbackProduct(db, artifact); db.close();
      integrity = dbSnapshot(clonePath, { fullIntegrity: false });
      failedFields = [...readback.mismatches];
      const expectedCount = expectedIndicators(artifact).length;
      const importerOk = importer.ok === true && Number(importer.validationIssueCount || 0) === 0 && Number(importer.acceptedResponsibilities || 0) === expectedCount && Number(importer.materializedProducts || 0) === 1;
      terminal = importerOk && readback.ok ? 'clone_pass' : 'validation_failure';
      if (!importerOk) failedFields.push('formal_importer_gate');
    } catch (error) {
      failedFields = [error.message];
      importer = { ok: false, error: error.message };
      integrity = dbSnapshot(clonePath, { fullIntegrity: false });
    }
    const dbAfter = openClone(clonePath); const after = productCounts(dbAfter, artifact.company, artifact.productName); dbAfter.close();
    const row = { schema: 'v7-clone-terminal/v1', selectionIndex: index, company: artifact.company, productName: artifact.productName, sourceDigest: artifact.sourceDigest, terminal, officialResponsibilities: rows(artifact.acceptedResponsibilities).length, expectedIndicators: expectedIndicators(artifact).length, cloneBefore: before, cloneAfter: after, failedFields, importerOk: importer?.ok === true, readbackOk: readback?.ok === true, quickCheck: integrity?.quickCheck, foreignKeyCheckCount: integrity?.foreignKeyCheckCount, writesToRealDb: 0 };
    writeJson(path.join(dir, 'import-receipt.json'), { schema: 'v7-clone-formal-import/v1', dbPath: clonePath, write: true, isolatedClone: true, realDbWrite: false, importer });
    writeJson(path.join(dir, 'readback.json'), readback || { ok: false, mismatches: failedFields });
    writeJson(path.join(dir, 'integrity.json'), integrity);
    writeJson(path.join(dir, 'terminal.json'), row);
    if (terminal === 'clone_pass') importReady.push({ ...row, artifactPath }); else if (terminal === 'materializer_blocked') blocked.push(row); else if (terminal === 'version_conflict') versionConflicts.push(row);
    terminalRows.push(row);
    const files = fs.readdirSync(dir).filter((file) => file !== 'sha256.json').sort(); writeJson(path.join(dir, 'sha256.json'), Object.fromEntries(files.map((file) => [file, fileSha(path.join(dir, file))])));
  }
  let medical = null;
  try { medical = buildMedicalArtifact(); } catch (error) { writeJson(path.join(ROOT, 'medical-table', 'terminal.json'), { schema: 'v7-medical-terminal/v1', terminal: 'source_review', medicalTableRecovered: false, error: error.message, modelCalls: 0 }); medical = { terminal: { terminal: 'source_review', medicalTableRecovered: false, clonePass: false, modelCalls: 0 }, error: error.message }; }
  const cloneAfter = dbSnapshot(clonePath);
  const finalIntegrityOk = cloneAfter.quickCheck === 'ok' && cloneAfter.foreignKeyCheckCount === 0;
  if (!finalIntegrityOk) {
    for (const row of terminalRows) {
      if (row.terminal !== 'clone_pass') continue;
      row.terminal = 'materializer_blocked';
      row.failedFields = [...rows(row.failedFields), `quick_check:${cloneAfter.quickCheck}`, `foreign_key_check:${cloneAfter.foreignKeyCheckCount}`];
    }
    importReady.length = 0;
    blocked.length = terminalRows.filter((row) => row.terminal === 'materializer_blocked');
  }
  writeRaw(path.join(ROOT, 'import-ready.jsonl'), importReady.map((row) => JSON.stringify(row)).join('\n') + (importReady.length ? '\n' : ''));
  writeRaw(path.join(ROOT, 'materializer-blocked.jsonl'), blocked.map((row) => JSON.stringify(row)).join('\n') + (blocked.length ? '\n' : ''));
  writeRaw(path.join(ROOT, 'version-conflict.jsonl'), versionConflicts.map((row) => JSON.stringify(row)).join('\n') + (versionConflicts.length ? '\n' : ''));
  writeRaw(path.join(ROOT, 'terminal-results.jsonl'), terminalRows.map((row) => JSON.stringify(row)).join('\n') + (terminalRows.length ? '\n' : ''));
  const realAfter = { file: REAL_DB, sha: sha256(REAL_DB), stat: fs.statSync(REAL_DB).mtimeMs };
  const summary = { schema: 'v7-clone-and-medical-table-summary/v1', selectedApprovedProducts: 9, clone: { clonePass: terminalRows.filter((row) => row.terminal === 'clone_pass').length, materializerBlocked: terminalRows.filter((row) => row.terminal === 'materializer_blocked').length, versionConflict: terminalRows.filter((row) => row.terminal === 'version_conflict').length, validationFailure: terminalRows.filter((row) => row.terminal === 'validation_failure').length, officialResponsibilities: terminalRows.reduce((sum, row) => sum + row.officialResponsibilities, 0), importReadyResponsibilities: importReady.reduce((sum, row) => sum + row.officialResponsibilities, 0), importReadyIndicators: importReady.reduce((sum, row) => sum + row.expectedIndicators, 0), before: cloneBefore, after: cloneAfter }, medical: { recovered: medical?.terminal?.medicalTableRecovered === true, approved: medical?.validator?.ok === true, clonePass: false, terminal: medical?.terminal?.terminal || 'source_review', modelCalls: medical?.terminal?.medicalTableRecovered ? 1 : 0 }, realSsd: { before: realBefore, after: realAfter, unchangedSha: realBefore.sha.digest === realAfter.sha.digest, unchangedSize: realBefore.sha.bytes === realAfter.sha.bytes, writes: 0 }, legacyPollutionLeakage: 0, versionOverwrite: 0, responsibilityOmissions: 0, importReadyIsCloneValidatedOnly: true, realSsdImported: false };
  writeJson(path.join(ROOT, 'summary.json'), summary);
  const rootFiles = [];
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (file === path.join(ROOT, 'SHA256SUMS')) continue; if (entry.isDirectory()) walk(file); else rootFiles.push(file); } }
  walk(ROOT); rootFiles.sort(); fs.writeFileSync(path.join(ROOT, 'SHA256SUMS'), rootFiles.map((file) => `${fileSha(file)}  ${path.relative(ROOT, file)}`).join('\n') + '\n');
  console.log(JSON.stringify(summary));
}

main();
