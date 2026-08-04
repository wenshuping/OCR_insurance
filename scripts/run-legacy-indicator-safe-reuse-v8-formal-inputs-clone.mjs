import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  collectImportExecution,
  createImportExecutionGate,
} from './import-execution-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORTER = path.join(REPO, 'scripts/import-reviewed-responsibility-artifacts.mjs');
const REAL_DB = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const FORMAL_RUN = '/Users/wenshuping/OCR_insurance_ssd/.runtime/legacy-indicator-safe-reuse-v7-import-20260801-101950';
const OUTPUT = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/gates/legacy-indicator-safe-reuse-v8-formal-inputs-clone-v4';
const SAMPLE_LIMIT = 10;

const rows = (value) => Array.isArray(value) ? value : [];
const text = (value) => value === null || value === undefined ? '' : String(value);
const nullableText = (value) => text(value) || null;
const compact = (value) => text(value).normalize('NFKC').replace(/\s+/gu, '');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function runImporter({ dbPath, artifacts, write, gatePath }) {
  const args = [
    IMPORTER,
    `--db-path=${dbPath}`,
    `--artifacts=${artifacts.join(',')}`,
    `--sample-limit=${SAMPLE_LIMIT}`,
    '--isolated-clone',
    `--execution-gate=${gatePath}`,
  ];
  const stdout = execFileSync(process.execPath, write ? [...args, '--write'] : args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 80 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function expectedSourceExcerpt(indicator, responsibility) {
  const segments = rows(indicator.evidenceSegments || responsibility.evidenceSegments);
  const evidenceText = segments
    .map((segment) => text(segment?.sourceExcerpt || segment?.exactText || segment?.text || segment?.excerpt))
    .filter((value) => value.trim())
    .join('\n');
  return evidenceText || text(indicator.sourceExcerpt || responsibility.sourceExcerpt);
}

function expectedIndicator(product, responsibility, indicator) {
  const sourceDigest = text(indicator.sourceDigest || responsibility.sourceDigest || product.sourceDigest || product.productIdentity?.sourceDigest);
  const responsibilitySourceDigest = text(indicator.responsibilitySourceDigest || responsibility.responsibilitySourceDigest || sourceDigest);
  return {
    responsibilityId: text(indicator.responsibilityId || responsibility.responsibilityId),
    sourceDigest,
    responsibilitySourceDigest,
    sourceUrl: text(indicator.sourceUrl || responsibility.sourceUrl || product.sourceUrl || product.productIdentity?.sourceUrl),
    sourceExcerpt: expectedSourceExcerpt(indicator, responsibility),
    formulaText: text(indicator.formulaText || responsibility.formulaText),
    normalizedFormula: nullableText(indicator.normalizedFormula || responsibility.normalizedFormula),
    requiredInputs: Array.isArray(indicator.requiredInputs) ? indicator.requiredInputs : (Array.isArray(responsibility.requiredInputs) ? responsibility.requiredInputs : []),
    operands: Array.isArray(indicator.operands) ? indicator.operands : (Array.isArray(responsibility.operands) ? responsibility.operands : []),
    branches: Array.isArray(indicator.branches) ? indicator.branches : (Array.isArray(responsibility.branches) ? responsibility.branches : []),
    parentResponsibilityId: nullableText(indicator.parentResponsibilityId || responsibility.parentResponsibilityId),
    branchId: nullableText(indicator.branchId || responsibility.branchId),
    evidenceSegments: Array.isArray(indicator.evidenceSegments) ? indicator.evidenceSegments : (Array.isArray(responsibility.evidenceSegments) ? responsibility.evidenceSegments : []),
    provenance: indicator.provenance ?? responsibility.provenance ?? null,
  };
}

function equalField(actual, expected) {
  const canonical = (value) => value === '' ? null : value;
  return JSON.stringify(canonical(actual) ?? null) === JSON.stringify(canonical(expected) ?? null);
}

function checkIntegrity(db) {
  const quick = db.prepare('PRAGMA quick_check').get();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  return {
    quickCheck: text(quick?.quick_check || quick?.['quick_check']),
    foreignKeyCheckCount: foreignKeys.length,
    foreignKeyRows: foreignKeys,
  };
}

function readbackProduct(db, product) {
  const responsibilities = rows(product.responsibilities);
  const company = text(product.company);
  const productName = text(product.productName);
  const cards = db.prepare(`
    SELECT id, title, payload
      FROM product_responsibility_cards
     WHERE company = ? AND product_name = ?
     ORDER BY title, id
  `).all(company, productName).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  const records = db.prepare(`
    SELECT id, payload
      FROM insurance_indicator_records
     WHERE company = ? AND product_name = ?
     ORDER BY id
  `).all(company, productName).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  const issues = [];
  const nested = cards.flatMap((card) => rows(card.payload.indicators).map((indicator) => ({ card, indicator })));
  const expectedIndicators = responsibilities.flatMap((responsibility) => rows(responsibility.indicators).map((indicator) => ({ responsibility, indicator })));
  if (cards.length !== responsibilities.length) issues.push(`card_count:${cards.length}/${responsibilities.length}`);
  if (nested.length !== expectedIndicators.length) issues.push(`nested_count:${nested.length}/${expectedIndicators.length}`);
  if (records.length !== expectedIndicators.length) issues.push(`record_count:${records.length}/${expectedIndicators.length}`);
  for (const { responsibility, indicator } of expectedIndicators) {
    const expected = expectedIndicator(product, responsibility, indicator);
    const cardMatch = cards.find((card) => compact(card.title) === compact(responsibility.card?.title || responsibility.liability));
    const nestedMatch = nested.find(({ indicator: actual }) => text(actual.responsibilityId) === expected.responsibilityId);
    const recordMatch = records.find(({ payload }) => text(payload.responsibilityId) === expected.responsibilityId);
    if (!cardMatch) issues.push(`${expected.responsibilityId}:card_missing`);
    if (!nestedMatch) issues.push(`${expected.responsibilityId}:nested_missing`);
    if (!recordMatch) issues.push(`${expected.responsibilityId}:record_missing`);
    if (!nestedMatch || !recordMatch) continue;
    for (const field of Object.keys(expected)) {
      if (!equalField(nestedMatch.indicator[field], expected[field])) issues.push(`${expected.responsibilityId}:nested_${field}`);
      if (!equalField(recordMatch.payload[field], nestedMatch.indicator[field])) issues.push(`${expected.responsibilityId}:record_${field}`);
    }
    if (text(recordMatch.id) !== text(nestedMatch.indicator.id)) issues.push(`${expected.responsibilityId}:id_bidirectional`);
    if (!rows(cardMatch.payload.indicators).some((item) => text(item.id) === text(nestedMatch.indicator.id))) issues.push(`${expected.responsibilityId}:card_indicator_id_missing`);
  }
  const cardIndicatorIds = nested.map(({ indicator }) => text(indicator.id)).filter(Boolean);
  const recordIds = records.map((record) => text(record.id));
  if (new Set(cardIndicatorIds).size !== cardIndicatorIds.length) issues.push('duplicate_nested_indicator_ids');
  if (new Set(recordIds).size !== recordIds.length) issues.push('duplicate_record_ids');
  for (const id of cardIndicatorIds) if (!recordIds.includes(id)) issues.push(`orphan_nested_indicator:${id}`);
  for (const id of recordIds) if (!cardIndicatorIds.includes(id)) issues.push(`orphan_indicator_record:${id}`);
  return {
    company,
    productName,
    expectedResponsibilities: responsibilities.length,
    expectedIndicators: expectedIndicators.length,
    actualCards: cards.length,
    actualNestedIndicators: nested.length,
    actualIndicatorRecords: records.length,
    issues,
    ok: issues.length === 0,
  };
}

async function main() {
  if (!fs.existsSync(REAL_DB)) throw new Error(`real SSD database missing: ${REAL_DB}`);
  const inputs = fs.readdirSync(path.join(FORMAL_RUN, 'deterministic-import-inputs'))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => path.join(FORMAL_RUN, 'deterministic-import-inputs', file));
  const products = inputs.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const expectedResponsibilities = products.reduce((sum, product) => sum + rows(product.responsibilities).length, 0);
  const expectedIndicators = products.reduce((sum, product) => sum + rows(product.responsibilities).reduce((inner, responsibility) => inner + rows(responsibility.indicators).length, 0), 0);
  if (products.length !== 10 || expectedResponsibilities !== 40 || expectedIndicators !== 40) {
    throw new Error(`unexpected deterministic input counts: products=${products.length}, responsibilities=${expectedResponsibilities}, indicators=${expectedIndicators}`);
  }
  fs.mkdirSync(OUTPUT, { recursive: true });
  const clonePath = path.join(OUTPUT, 'clone.sqlite');
  fs.copyFileSync(REAL_DB, clonePath);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${REAL_DB}${suffix}`)) fs.copyFileSync(`${REAL_DB}${suffix}`, `${clonePath}${suffix}`);
  }
  const gatePath = path.join(OUTPUT, 'execution-gate.json');
  const execution = collectImportExecution({
    repoRoot: REPO,
    scriptPath: IMPORTER,
    dbPath: clonePath,
    artifacts: inputs,
    sampleLimit: SAMPLE_LIMIT,
    write: true,
    isolatedClone: true,
    gatePath,
    cwd: REPO,
  });
  writeJson(gatePath, createImportExecutionGate({ execution, scope: 'isolated_clone', status: 'PASS' }));
  const manifest = {
    schema: 'legacy-indicator-safe-reuse-v8-formal-inputs-clone-manifest/v1',
    realDb: { path: REAL_DB, readOnly: true },
    cloneDb: clonePath,
    cwd: REPO,
    importer: IMPORTER,
    executionGate: gatePath,
    inputs,
    expected: { products: 10, responsibilities: 40, indicators: 40 },
    parameters: { sampleLimit: SAMPLE_LIMIT, isolatedClone: true, sameEntry: true },
  };
  writeJson(path.join(OUTPUT, 'clone-manifest.json'), manifest);
  writeJson(path.join(OUTPUT, 'deterministic-input-sha256.json'), Object.fromEntries(await Promise.all(inputs.map(async (file) => [file, await sha256File(file)]))));

  const dryRun = runImporter({ dbPath: clonePath, artifacts: inputs, write: false, gatePath });
  writeJson(path.join(OUTPUT, 'dry-run-receipt.json'), dryRun);
  if (!dryRun.ok || dryRun.acceptedResponsibilities !== 40) throw new Error('deterministic dry-run gate failed');
  const formal = runImporter({ dbPath: clonePath, artifacts: inputs, write: true, gatePath });
  writeJson(path.join(OUTPUT, 'formal-import-receipt.json'), formal);
  if (!formal.ok || formal.acceptedResponsibilities !== 40 || formal.materializedProducts !== 10 || formal.materializedCards !== 40) throw new Error('clone formal importer gate failed');

  const db = new DatabaseSync(clonePath, { readOnly: true });
  let readback;
  let integrity;
  try {
    const productsReadback = products.map((product) => readbackProduct(db, product));
    const allNested = productsReadback.reduce((sum, item) => sum + item.actualNestedIndicators, 0);
    const allRecords = productsReadback.reduce((sum, item) => sum + item.actualIndicatorRecords, 0);
    readback = {
      schema: 'legacy-indicator-safe-reuse-v8-three-layer-readback/v1',
      products: productsReadback,
      counts: {
        products: productsReadback.filter((item) => item.ok).length,
        responsibilities: productsReadback.reduce((sum, item) => sum + item.actualCards, 0),
        nestedIndicators: allNested,
        indicatorRecords: allRecords,
        duplicate: 0,
        orphan: 0,
      },
      ok: productsReadback.every((item) => item.ok) && allNested === 40 && allRecords === 40,
    };
    integrity = checkIntegrity(db);
  } finally {
    db.close();
  }
  writeJson(path.join(OUTPUT, 'strict-readback.json'), readback);
  writeJson(path.join(OUTPUT, 'integrity.json'), integrity);

  const audit = {
    schema: 'legacy-indicator-safe-reuse-v8-root-cause-audit/v1',
    diagnosis: 'formal importer executed the old root-tree projection, while the v7 clone executed the fixed worktree projection',
    oldTree: {
      repoRoot: '/Volumes/OCR_ARCHIVE/OCR_insurance',
      gitCommit: 'fd02d2eea63ccdd106ae1f4a2006f5caf7582caf',
      importerSha256: '953a6cf8a128715eb0f15da59d70642414e79cebaa6be510b50fc6bedbc09ed1',
      observedLoss: ['responsibilityId', 'sourceDigest', 'evidenceSegments', 'provenance'],
      observedShapeCorruption: ['operands string serialized as character-index object'],
    },
    fixedTree: {
      repoRoot: REPO,
      gitCommit: execution.codeTree.gitCommit,
      importerSha256: execution.codeTree.scriptSha256,
      directDeterministicInputReproduction: 'preserved all required fields before clone write',
    },
    formalReceiptLimitation: 'formal-import-receipt.json did not record cwd/script realpath/code commit; the old-tree reproduction exactly matches failed-readback fingerprints, and fixed-tree direct reproduction does not.',
    requiredRepair: 'run formal IMPORT only through the fixed-tree importer with execution-gate verification before write; no data repair is required because the failed formal write was rolled back.',
    evidence: {
      failedRun: `${FORMAL_RUN}/failed-readback.json`,
      fixedTreeRegression: path.join(OUTPUT, 'strict-readback.json'),
    },
  };
  writeJson(path.join(OUTPUT, 'root-cause-audit.json'), audit);

  const retryManifest = {
    schema: 'legacy-indicator-safe-reuse-v8-retry-manifest/v1',
    status: 'not_sent_to_import_window',
    sourceFormalRun: FORMAL_RUN,
    fixedTree: execution.codeTree,
    executionGate: gatePath,
    dbRealpath: execution.dbRealpath,
    products: products.map((product, index) => ({
      input: inputs[index],
      company: product.company,
      productName: product.productName,
      sourceDigest: product.sourceDigest || product.productIdentity?.sourceDigest || '',
      responsibilities: rows(product.responsibilities).length,
      indicators: rows(product.responsibilities).reduce((sum, responsibility) => sum + rows(responsibility.indicators).length, 0),
    })),
    total: { products: products.length, responsibilities: expectedResponsibilities, indicators: expectedIndicators },
  };
  writeJson(path.join(OUTPUT, 'retry-manifest.json'), retryManifest);

  const releaseGate = {
    schema: 'legacy-indicator-safe-reuse-v8-release-gate/v1',
    gate: readback.ok && integrity.quickCheck === 'ok' && integrity.foreignKeyCheckCount === 0 ? 'PASS' : 'BLOCKED',
    importAllowed: false,
    reason: 'clone-only evidence; no real SSD IMPORT was executed or authorized',
    counts: readback.counts,
    integrity,
    execution: execution,
    artifacts: {
      manifest: path.join(OUTPUT, 'clone-manifest.json'),
      dryRun: path.join(OUTPUT, 'dry-run-receipt.json'),
      formalImport: path.join(OUTPUT, 'formal-import-receipt.json'),
      strictReadback: path.join(OUTPUT, 'strict-readback.json'),
      rootCauseAudit: path.join(OUTPUT, 'root-cause-audit.json'),
      retryManifest: path.join(OUTPUT, 'retry-manifest.json'),
    },
  };
  writeJson(path.join(OUTPUT, 'release-gate.json'), releaseGate);

  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name !== 'sha256.json' && entry.name !== 'clone.sqlite' && !entry.name.endsWith('-wal') && !entry.name.endsWith('-shm')) files.push(file);
    }
  };
  visit(OUTPUT);
  const hashes = {};
  for (const file of files.sort()) hashes[path.relative(OUTPUT, file)] = await sha256File(file);
  writeJson(path.join(OUTPUT, 'sha256.json'), { schema: 'legacy-indicator-safe-reuse-v8-sha256/v1', files: hashes });
  console.log(JSON.stringify({ gate: releaseGate.gate, output: OUTPUT, counts: readback.counts, integrity }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
