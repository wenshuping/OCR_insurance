import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

import { auditResponsibilityAlignment } from './audit-responsibility-card-indicator-alignment.mjs';
import {
  collectImportExecution,
  createImportExecutionGate,
} from './import-execution-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORTER = path.join(REPO, 'scripts/import-reviewed-responsibility-artifacts.mjs');
const REAL_DB = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const HISTORICAL_RUN = '/Users/wenshuping/OCR_insurance_ssd/.runtime/fast-materializer-20-20260801-123100';
const ARTIFACT = path.join(REPO, 'artifacts/participating-annuity-semantic-audit-20260731/materializer-canary-redline-v2/new-clone/approved-20.jsonl');
const OUTPUT = process.argv.find((value) => value.startsWith('--output='))?.slice('--output='.length)
  || '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/gates/strict-alignment-historical20-clone-20260801-v1';

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

function runImporter({ dbPath, write, gatePath }) {
  const args = [
    IMPORTER,
    `--db-path=${dbPath}`,
    `--artifacts=${ARTIFACT}`,
    '--sample-limit=20',
    '--isolated-clone',
    `--execution-gate=${gatePath}`,
  ];
  return JSON.parse(execFileSync(process.execPath, write ? [...args, '--write'] : args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 120 * 1024 * 1024,
  }));
}

function productKey(company, productName) {
  return `${company}\u001f${productName}`;
}

function integrity(db) {
  const quick = db.prepare('PRAGMA quick_check').get();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  return {
    quickCheck: String(quick?.quick_check || ''),
    foreignKeyIssueCount: foreignKeys.length,
  };
}

async function main() {
  if (fs.existsSync(OUTPUT)) throw new Error(`gate output already exists: ${OUTPUT}`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const clonePath = path.join(OUTPUT, 'clone.sqlite');
  const sourceDb = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    await backup(sourceDb, clonePath);
  } finally {
    sourceDb.close();
  }

  const historicalManifest = JSON.parse(fs.readFileSync(path.join(HISTORICAL_RUN, 'immutable-manifest.json'), 'utf8'));
  const historicalFinal = JSON.parse(fs.readFileSync(path.join(HISTORICAL_RUN, 'final-receipt.json'), 'utf8'));
  const lockedProducts = historicalManifest.selection.products;
  if (lockedProducts.length !== 20) throw new Error(`historical manifest count mismatch: ${lockedProducts.length}`);
  const artifactSha256 = await sha256File(ARTIFACT);
  if (artifactSha256 !== historicalManifest.scope.artifactSha256.digest) {
    throw new Error(`historical artifact SHA mismatch: ${artifactSha256}`);
  }

  const gatePath = path.join(OUTPUT, 'execution-gate.json');
  const execution = collectImportExecution({
    repoRoot: REPO,
    scriptPath: IMPORTER,
    dbPath: clonePath,
    artifacts: [ARTIFACT],
    sampleLimit: 20,
    write: true,
    isolatedClone: true,
    gatePath,
    cwd: REPO,
  });
  writeJson(gatePath, createImportExecutionGate({ execution, scope: 'isolated_clone', status: 'PASS' }));
  writeJson(path.join(OUTPUT, 'immutable-manifest.json'), {
    schema: 'strict-alignment-historical20-clone-manifest/v1',
    sourceDb: { path: REAL_DB, readOnly: true },
    cloneDb: clonePath,
    historicalManifest: path.join(HISTORICAL_RUN, 'immutable-manifest.json'),
    historicalManifestSha256: await sha256File(path.join(HISTORICAL_RUN, 'immutable-manifest.json')),
    artifact: ARTIFACT,
    artifactSha256,
    products: lockedProducts.map(({ company, productName, sourceDigest }) => ({ company, productName, sourceDigest })),
    execution,
  });

  const dryRun = runImporter({ dbPath: clonePath, write: false, gatePath });
  writeJson(path.join(OUTPUT, 'dry-run-receipt.json'), dryRun);
  if (!dryRun.ok || dryRun.productsReviewed !== 20 || dryRun.acceptedResponsibilities !== 65) {
    throw new Error('historical20 dry-run gate failed');
  }
  const formal = runImporter({ dbPath: clonePath, write: true, gatePath });
  writeJson(path.join(OUTPUT, 'formal-import-receipt.json'), formal);
  if (!formal.ok || formal.materializedProducts !== 20 || formal.strictAlignment.evaluatedProducts !== 20) {
    throw new Error('historical20 formal importer gate failed');
  }

  const cloneDb = new DatabaseSync(clonePath, { readOnly: true });
  let fullAudit;
  let cloneIntegrity;
  try {
    fullAudit = auditResponsibilityAlignment(cloneDb);
    cloneIntegrity = integrity(cloneDb);
  } finally {
    cloneDb.close();
  }
  const lockedKeys = new Set(lockedProducts.map((product) => productKey(product.company, product.productName)));
  const auditProducts = fullAudit.ledger
    .filter((product) => product.rawProducts.some((rawKey) => lockedKeys.has(rawKey)))
    .map((product) => product.strictAlignment);
  const importerByKey = new Map(formal.strictAlignment.products.map((product) => [productKey(product.company, product.productName), product]));
  const auditByKey = new Map(auditProducts.map((product) => [productKey(product.company, product.productName), product]));
  const agreement = lockedProducts.map((product) => {
    const key = productKey(product.company, product.productName);
    const importerResult = importerByKey.get(key);
    const auditResult = auditByKey.get(key);
    const statusEqual = importerResult?.strictAligned === auditResult?.strictAligned;
    const importerReasons = importerResult?.reasonCodes || [];
    const auditReasons = auditResult?.reasonCodes || [];
    const reasonCodesEqual = JSON.stringify(importerReasons) === JSON.stringify(auditReasons);
    const historical = historicalFinal.strictAlignment.products.find((item) => (
      item.company === product.company && item.productName === product.productName
    ));
    return {
      company: product.company,
      productName: product.productName,
      sourceDigest: product.sourceDigest,
      historicalStrictAligned: Boolean(historical?.strictAligned),
      importerStrictAligned: Boolean(importerResult?.strictAligned),
      auditStrictAligned: Boolean(auditResult?.strictAligned),
      importerReasonCodes: importerReasons,
      auditReasonCodes: auditReasons,
      statusEqual,
      reasonCodesEqual,
      diagnosis: statusEqual && reasonCodesEqual && importerResult?.strictAligned
        ? 'historical_audit_mismatch_dual_predicate'
        : 'current_projection_or_audit_failure',
    };
  });
  writeJson(path.join(OUTPUT, 'alignment-agreement.json'), {
    schema: 'strict-alignment-historical20-agreement/v1',
    products: agreement,
    counts: {
      products: agreement.length,
      exactAgreement: agreement.filter((item) => item.statusEqual && item.reasonCodesEqual).length,
      strictAligned: agreement.filter((item) => item.importerStrictAligned && item.auditStrictAligned).length,
      historicalDivergences: agreement.filter((item) => item.historicalStrictAligned !== item.importerStrictAligned).length,
    },
  });
  writeJson(path.join(OUTPUT, 'full-alignment-audit.json'), fullAudit);
  writeJson(path.join(OUTPUT, 'integrity.json'), cloneIntegrity);

  const pass = agreement.length === 20
    && agreement.every((item) => item.statusEqual && item.reasonCodesEqual && item.importerStrictAligned)
    && cloneIntegrity.quickCheck === 'ok'
    && cloneIntegrity.foreignKeyIssueCount === 0;
  const releaseGate = {
    schema: 'strict-alignment-historical20-release-gate/v1',
    gate: pass ? 'PASS' : 'BLOCKED',
    importAllowed: false,
    reason: 'Phase 1 clone-only gate; real SSD import is not authorized by this receipt.',
    diagnosis: pass
      ? 'The historical 18/20 divergence was an audit mismatch caused by dual predicates; the fixed projection is semantically exact for all 20.'
      : 'Shared strict alignment still detects projection loss or an audit mismatch.',
    counts: {
      selectedProducts: 20,
      artifactResponsibilities: 63,
      artifactIndicators: 65,
      importerStrictAligned: agreement.filter((item) => item.importerStrictAligned).length,
      auditStrictAligned: agreement.filter((item) => item.auditStrictAligned).length,
      exactAgreement: agreement.filter((item) => item.statusEqual && item.reasonCodesEqual).length,
    },
    integrity: cloneIntegrity,
    workflowBinding: {
      runnerRealpath: fs.realpathSync(fileURLToPath(import.meta.url)),
      runnerSha256: await sha256File(fileURLToPath(import.meta.url)),
      importerExecution: execution,
    },
  };
  writeJson(path.join(OUTPUT, 'release-gate.json'), releaseGate);

  const files = fs.readdirSync(OUTPUT)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name !== 'sha256.json')
    .sort();
  const hashes = {};
  for (const name of files) hashes[name] = await sha256File(path.join(OUTPUT, name));
  writeJson(path.join(OUTPUT, 'sha256.json'), { schema: 'strict-alignment-historical20-sha256/v1', files: hashes });
  process.stdout.write(`${JSON.stringify({ gate: releaseGate.gate, output: OUTPUT, counts: releaseGate.counts, integrity: cloneIntegrity }, null, 2)}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
