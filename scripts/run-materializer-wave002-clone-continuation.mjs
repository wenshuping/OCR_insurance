#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

import {
  collectImportExecution,
  createImportExecutionGate,
} from './import-execution-guard.mjs';
import { loadStrictAlignmentProduct } from './responsibility-strict-alignment.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DB = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const BASE = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2';
const MANIFESTS = {
  A: path.join(BASE, 'wave-002-coordinator/manifests/materializer-A.jsonl'),
  B: path.join(BASE, 'wave-002-coordinator/manifests/materializer-B.jsonl'),
};
const EXISTING_A02 = path.join(BASE, 'materializer-gate-wave002-200-20260801/A-02');
const OUTPUT = process.argv.find((value) => value.startsWith('--output='))?.slice('--output='.length)
  || path.join(BASE, 'materializer-gate-wave002-continuation-20260801-v1');
const IMPORTER = path.join(REPO, 'scripts/import-reviewed-responsibility-artifacts.mjs');
const PROJECTION = path.join(REPO, 'scripts/audit-materializer-projection-readback.mjs');
const STRICT = path.join(REPO, 'scripts/responsibility-strict-alignment.mjs');
const TOOL_BINDINGS = {
  [IMPORTER]: 'c1aea3b932be469ce21cdaf257b27948bf1e3be7facfa4f940d58e3d01f51fbf',
  [PROJECTION]: 'bebb76398cd1c4eef8a759a2bd292c0b158a8d3bfe31ef1cdd6670ef9abd1b5c',
  [STRICT]: 'fad2aac835d5a0b94807f26e41c7873131bda0838a02dae8b964e5e28d3b49ac',
  [path.join(REPO, 'scripts/audit-responsibility-card-indicator-alignment.mjs')]: '5570ef83b77147c1305119907a605241816c06f86bd23724c7abdc985fd42fe0',
  [path.join(REPO, 'scripts/import-execution-guard.mjs')]: '0526de953cc44bc12f8b67dcdd1fa5654d8098b8700740657d253c0df6756ec0',
  [path.join(REPO, 'scripts/materialize-product-responsibility-cards.mjs')]: '5b025e6b4a493826e4d83ff8cdee7bb88d08211a132e8bb804b52d066aef0370',
};

function text(value) {
  return String(value ?? '').trim();
}

function productKey(product) {
  return `${text(product.company)}\u001f${text(product.productName)}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length ? `${values.map((value) => JSON.stringify(value)).join('\n')}\n` : '');
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyToolBindings() {
  return Object.entries(TOOL_BINDINGS).map(([filePath, expectedSha256]) => {
    const realpath = fs.realpathSync(filePath);
    const actualSha256 = sha256File(realpath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`tool binding mismatch: ${realpath}: ${actualSha256} != ${expectedSha256}`);
    }
    return { realpath, sha256: actualSha256 };
  });
}

function approvedDigest(row) {
  const artifact = JSON.parse(row.payload || '{}');
  return text(artifact.sourceDigest || artifact.productIdentity?.sourceDigest || row.sourceDigest);
}

function batchArtifacts(db, products) {
  const where = products.map(() => '(company = ? AND product_name = ?)').join(' OR ');
  const params = products.flatMap((product) => [text(product.company), text(product.productName)]);
  const rows = db.prepare(`
    SELECT id, company, product_name productName, source_digest sourceDigest,
           source_url sourceUrl, published_at publishedAt, payload
      FROM product_responsibility_artifacts
     WHERE (${where})
       AND json_extract(payload, '$.audit.status') = 'approved'
     ORDER BY published_at DESC, id DESC
  `).all(...params);
  const byProduct = new Map(products.map((product) => [productKey(product), []]));
  for (const row of rows) {
    const key = productKey(row);
    if (byProduct.has(key)) byProduct.get(key).push(row);
  }
  return { rows, byProduct, queryCount: 1 };
}

function selectArtifact(product, rows) {
  const manifestDigests = new Set([product.sourceDigest, ...(product.sourceDigests || [])].map(text).filter(Boolean));
  const artifactDigests = new Set(rows.map(approvedDigest).filter(Boolean));
  if (manifestDigests.size > 1 || artifactDigests.size > 1) {
    return { status: 'version_conflict', reasonCodes: ['NONEMPTY_SOURCE_DIGEST_CONFLICT'] };
  }
  const wanted = text(product.sourceDigest);
  const selected = wanted ? rows.find((row) => approvedDigest(row) === wanted) : rows[0];
  if (!selected) {
    return {
      status: 'materializer_blocked',
      reasonCodes: [rows.length ? 'APPROVED_ARTIFACT_DIGEST_MISMATCH' : 'APPROVED_ARTIFACT_NOT_FOUND'],
    };
  }
  return { status: 'selected', row: selected, artifact: JSON.parse(selected.payload || '{}') };
}

function isIncrementalWholeLifeSpecialty(product) {
  const name = text(product.productName);
  return /增额.*终身寿|终身寿.*增额/.test(name);
}

function runImporter({ dbPath, artifactsPath, gatePath, write }) {
  const args = [
    IMPORTER,
    `--db-path=${dbPath}`,
    `--artifacts=${artifactsPath}`,
    '--sample-limit=20',
    '--isolated-clone',
    `--execution-gate=${gatePath}`,
  ];
  return JSON.parse(execFileSync(process.execPath, write ? [...args, '--write'] : args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 160 * 1024 * 1024,
  }));
}

function runProjection({ dbPath, productsPath, outputPath }) {
  return JSON.parse(execFileSync(process.execPath, [
    PROJECTION,
    `--db=${dbPath}`,
    `--products=${productsPath}`,
    `--output=${outputPath}`,
    '--bounded',
  ], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 160 * 1024 * 1024,
  }));
}

function integrity(db) {
  return {
    quickCheck: text(db.prepare('PRAGMA quick_check').get()?.quick_check),
    foreignKeyIssueCount: db.prepare('PRAGMA foreign_key_check').all().length,
  };
}

function hashEvidence(unitDir) {
  const files = fs.readdirSync(unitDir)
    .filter((name) => /\.(json|jsonl)$/.test(name) && name !== 'sha256.json')
    .sort();
  const hashes = Object.fromEntries(files.map((name) => [name, sha256File(path.join(unitDir, name))]));
  writeJson(path.join(unitDir, 'sha256.json'), { schema: 'materializer-wave002-unit-sha256/v1', files: hashes });
}

function reconcileA02(toolBindings) {
  const unitDir = path.join(OUTPUT, 'A-02-reconciled');
  fs.mkdirSync(unitDir, { recursive: true });
  const artifacts = readJsonl(path.join(EXISTING_A02, 'approved-artifacts.jsonl'));
  const strict = readJson(path.join(EXISTING_A02, 'strict-alignment.json'));
  const artifactByKey = new Map(artifacts.map((artifact) => [productKey(artifact), artifact]));
  const readyProducts = strict.products.filter((product) => product.strictAligned);
  const blockedProducts = strict.products.filter((product) => !product.strictAligned).map((product) => ({
    ...product,
    terminalStatus: 'materializer_blocked',
    sourceUnit: 'A-02',
  }));
  const readyArtifacts = readyProducts.map((product) => artifactByKey.get(productKey(product))).filter(Boolean);
  if (readyArtifacts.length !== 19 || blockedProducts.length !== 1) {
    throw new Error(`A-02 reconciliation mismatch: ready=${readyArtifacts.length} blocked=${blockedProducts.length}`);
  }
  writeJsonl(path.join(unitDir, 'import-ready.jsonl'), readyArtifacts);
  writeJsonl(path.join(unitDir, 'materializer-blocked.jsonl'), blockedProducts);
  const receipt = {
    schema: 'materializer-wave002-a02-reconciliation/v1',
    unit: 'A-02',
    selected: 20,
    strictReady: 19,
    blocked: 1,
    sourceCloneReused: path.join(EXISTING_A02, 'clone.sqlite'),
    sourceTerminalReceipt: path.join(EXISTING_A02, 'terminal-receipt.json'),
    toolBindings,
    realSsdWrite: false,
  };
  writeJson(path.join(unitDir, 'receipt.json'), receipt);
  hashEvidence(unitDir);
  return { ...receipt, elapsedMs: 0 };
}

async function runUnit({ lane, batchNo, products, sourceDb, toolBindings }) {
  const started = performance.now();
  const unit = `${lane}-${String(batchNo).padStart(2, '0')}`;
  const unitDir = path.join(OUTPUT, unit);
  fs.mkdirSync(unitDir, { recursive: true });
  const artifactBatch = batchArtifacts(sourceDb, products);
  const selected = [];
  const exclusions = [];
  const preBlocked = [];
  for (const product of products) {
    if (isIncrementalWholeLifeSpecialty(product)) {
      exclusions.push({ ...product, terminalStatus: 'specialty_excluded', reasonCodes: ['INCREMENTAL_WHOLE_LIFE_SPECIALTY'] });
      continue;
    }
    const current = loadStrictAlignmentProduct(sourceDb, product);
    if (current.strictAligned) {
      exclusions.push({ ...product, terminalStatus: 'already_strict_aligned', reasonCodes: [] });
      continue;
    }
    const artifact = selectArtifact(product, artifactBatch.byProduct.get(productKey(product)) || []);
    if (artifact.status !== 'selected') {
      preBlocked.push({ ...product, terminalStatus: artifact.status, reasonCodes: artifact.reasonCodes });
      continue;
    }
    selected.push({ product, artifact: artifact.artifact });
  }

  const selectedProducts = selected.map(({ product }) => product);
  const artifacts = selected.map(({ artifact }) => artifact);
  writeJson(path.join(unitDir, 'input-lock.json'), {
    schema: 'materializer-wave002-unit-input-lock/v1',
    unit,
    manifest: MANIFESTS[lane],
    manifestSha256: sha256File(MANIFESTS[lane]),
    requestedProducts: products,
    selectedProducts,
    exclusions,
    preBlocked,
    artifactBatchQueryCount: artifactBatch.queryCount,
    artifactRowsReturned: artifactBatch.rows.length,
    sourceDb: { path: REAL_DB, readOnly: true },
    toolBindings,
  });
  writeJson(path.join(unitDir, 'products.json'), selectedProducts);
  writeJsonl(path.join(unitDir, 'approved-artifacts.jsonl'), artifacts);

  const clonePath = path.join(unitDir, 'clone.sqlite');
  await backup(sourceDb, clonePath);
  const artifactsPath = path.join(unitDir, 'approved-artifacts.jsonl');
  const gatePath = path.join(unitDir, 'execution-gate.json');
  const execution = collectImportExecution({
    repoRoot: REPO,
    scriptPath: IMPORTER,
    dbPath: clonePath,
    artifacts: [artifactsPath],
    sampleLimit: 20,
    write: true,
    isolatedClone: true,
    gatePath,
    cwd: REPO,
  });
  writeJson(gatePath, {
    ...createImportExecutionGate({ execution, scope: 'isolated_clone', status: 'PASS' }),
    wave002ToolBindings: toolBindings,
  });

  const dryRun = selected.length ? runImporter({ dbPath: clonePath, artifactsPath, gatePath, write: false }) : null;
  writeJson(path.join(unitDir, 'dry-run-receipt.json'), dryRun);
  const formal = selected.length ? runImporter({ dbPath: clonePath, artifactsPath, gatePath, write: true }) : null;
  writeJson(path.join(unitDir, 'formal-import-receipt.json'), formal);
  const projectionPath = path.join(unitDir, 'projection-readback.json');
  const projectionSummary = selected.length
    ? runProjection({ dbPath: clonePath, productsPath: path.join(unitDir, 'products.json'), outputPath: projectionPath })
    : null;
  if (!selected.length) writeJson(projectionPath, { productsScanned: 0, semanticExact: true, fieldDifferenceCount: 0 });
  const projection = readJson(projectionPath);

  const cloneDb = new DatabaseSync(clonePath, { readOnly: true });
  let strictProducts;
  let cloneIntegrity;
  try {
    strictProducts = selectedProducts.map((product) => loadStrictAlignmentProduct(cloneDb, product));
    cloneIntegrity = integrity(cloneDb);
  } finally {
    cloneDb.close();
  }
  writeJson(path.join(unitDir, 'strict-alignment.json'), {
    schema: 'materializer-wave002-unit-strict-alignment/v1',
    products: strictProducts,
    counts: { products: strictProducts.length, strictAligned: strictProducts.filter((product) => product.strictAligned).length },
  });

  const projectionIssueKeys = new Set((projection.productResults || [])
    .filter((product) => product.issueCount > 0)
    .map(productKey));
  const strictByKey = new Map(strictProducts.map((product) => [productKey(product), product]));
  const readyArtifacts = [];
  const postBlocked = [];
  for (const item of selected) {
    const key = productKey(item.product);
    const strictResult = strictByKey.get(key);
    if (strictResult?.strictAligned && !projectionIssueKeys.has(key)) readyArtifacts.push(item.artifact);
    else postBlocked.push({
      ...item.product,
      terminalStatus: 'materializer_blocked',
      reasonCodes: [...new Set([
        ...(strictResult?.reasonCodes || ['STRICT_ALIGNMENT_RESULT_MISSING']),
        ...(projectionIssueKeys.has(key) ? ['THREE_LAYER_PROJECTION_MISMATCH'] : []),
      ])],
    });
  }
  const blocked = [...preBlocked, ...postBlocked];
  writeJsonl(path.join(unitDir, 'import-ready.jsonl'), readyArtifacts);
  writeJsonl(path.join(unitDir, 'materializer-blocked.jsonl'), blocked);
  writeJsonl(path.join(unitDir, 'excluded.jsonl'), exclusions);
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const receipt = {
    schema: 'materializer-wave002-unit-terminal/v1',
    unit,
    gate: blocked.length === 0 ? 'PASS' : 'PARTIAL',
    requested: products.length,
    selected: selected.length,
    strictReady: readyArtifacts.length,
    blocked: blocked.length,
    excluded: exclusions.length,
    artifactBatchQueryCount: artifactBatch.queryCount,
    projection: {
      semanticExact: Boolean(projection.semanticExact),
      fieldDifferenceCount: Number(projection.fieldDifferenceCount || 0),
      maxQueryMs: Number(projection.maxQueryMs || 0),
      totalQueryMs: Number(projection.totalQueryMs || 0),
      summary: projectionSummary,
    },
    strictAligned: strictProducts.filter((product) => product.strictAligned).length,
    integrity: cloneIntegrity,
    elapsedMs,
    sourceDbReadOnly: true,
    realSsdWrite: false,
    oldVolumesDbWrite: false,
    modelCalls: 0,
    feishuWrites: 0,
    publishActions: 0,
  };
  writeJson(path.join(unitDir, 'receipt.json'), receipt);
  hashEvidence(unitDir);
  return receipt;
}

async function main() {
  if (fs.existsSync(OUTPUT)) throw new Error(`output already exists: ${OUTPUT}`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const toolBindings = verifyToolBindings();
  const manifests = Object.fromEntries(Object.entries(MANIFESTS).map(([lane, filePath]) => [lane, readJsonl(filePath)]));
  if (manifests.A.length !== 100 || manifests.B.length !== 100) throw new Error('wave002 manifests must contain 100 rows per lane');
  const allKeys = [...manifests.A, ...manifests.B].map(productKey);
  if (new Set(allKeys).size !== 200) throw new Error('wave002 manifests are not mutually exclusive');

  writeJson(path.join(OUTPUT, 'manifest-lock.json'), {
    schema: 'materializer-wave002-continuation-lock/v1',
    manifests: Object.fromEntries(Object.entries(MANIFESTS).map(([lane, filePath]) => [lane, {
      path: filePath,
      sha256: sha256File(filePath),
      products: manifests[lane].length,
    }])),
    excludedUnit: 'A-01',
    excludedReason: 'already imported to SSD before this clone-only continuation',
    sourceDb: { path: REAL_DB, readOnly: true },
    toolBindings,
  });

  const results = [reconcileA02(toolBindings)];
  const sourceDb = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    for (const lane of ['A', 'B']) {
      const firstBatch = lane === 'A' ? 3 : 1;
      for (let batchNo = firstBatch; batchNo <= 5; batchNo += 1) {
        const products = manifests[lane].slice((batchNo - 1) * 20, batchNo * 20);
        const result = await runUnit({ lane, batchNo, products, sourceDb, toolBindings });
        results.push(result);
        process.stdout.write(`${JSON.stringify({ unit: result.unit, strictReady: result.strictReady, blocked: result.blocked, excluded: result.excluded, elapsedMs: result.elapsedMs })}\n`);
      }
    }
  } finally {
    sourceDb.close();
  }

  const summary = {
    schema: 'materializer-wave002-continuation-summary/v1',
    requestedProducts: 200,
    a01ExcludedAlreadyImported: 20,
    selected: results.reduce((sum, result) => sum + Number(result.selected || 0), 0),
    strictReady: results.reduce((sum, result) => sum + Number(result.strictReady || 0), 0),
    blocked: results.reduce((sum, result) => sum + Number(result.blocked || 0), 0),
    excluded: results.reduce((sum, result) => sum + Number(result.excluded || 0), 0),
    units: results,
    unprocessed: 0,
    realSsdWrite: false,
    oldVolumesDbWrite: false,
    modelCalls: 0,
    feishuWrites: 0,
    publishActions: 0,
  };
  writeJson(path.join(OUTPUT, 'summary.json'), summary);
  const rootFiles = ['manifest-lock.json', 'summary.json'];
  writeJson(path.join(OUTPUT, 'sha256.json'), {
    schema: 'materializer-wave002-continuation-sha256/v1',
    files: Object.fromEntries(rootFiles.map((name) => [name, sha256File(path.join(OUTPUT, name))])),
    unitSha256: results.map((result) => ({ unit: result.unit, sha256: sha256File(path.join(OUTPUT, result.unit === 'A-02' ? 'A-02-reconciled' : result.unit, 'sha256.json')) })),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
