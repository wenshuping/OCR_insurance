import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { backup, DatabaseSync } from 'node:sqlite';

const ROOT = '/Volumes/OCR_ARCHIVE/OCR_insurance';
const FIXED_REPO = path.join(ROOT, '.worktrees/dev-agent-semantic-integration');
const INPUT_ROOT = path.join(
  ROOT,
  'artifacts/responsibility-full-backfill-20260731-v2/parse-source-wave007-20260801-v2',
);
const APPROVED_QUEUE = path.join(INPUT_ROOT, 'deepseek-canary-review-v1/approved.jsonl');
const PARSER_MANIFEST = path.join(INPUT_ROOT, 'manifests/deepseek-canary-020.json');
const OUTPUT = path.join(INPUT_ROOT, 'deepseek-approved14-clone-v1');
const SOURCE_DB = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const IMPORTER = path.join(FIXED_REPO, 'scripts/import-reviewed-responsibility-artifacts.mjs');
const PROJECTION = path.join(FIXED_REPO, 'scripts/audit-materializer-projection-readback.mjs');
const STRICT = path.join(FIXED_REPO, 'scripts/responsibility-strict-alignment.mjs');

const { importReviewedResponsibilityArtifacts } = await import(`file://${IMPORTER}`);
const { evaluateResponsibilityStrictAlignment } = await import(`file://${STRICT}`);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const writeJsonl = (file, rows) => fs.writeFileSync(
  file,
  `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rows = (value) => Array.isArray(value) ? value : [];

function payloadRow(row) {
  return { ...row, payload: JSON.parse(row.payload || '{}') };
}

function loadProductState(db, product) {
  const artifactRow = db.prepare(`
    SELECT payload FROM product_responsibility_artifacts
    WHERE company = ? AND product_name = ? ORDER BY id DESC LIMIT 1
  `).get(product.company, product.productName);
  const cards = db.prepare(`
    SELECT id, title, payload FROM product_responsibility_cards
    WHERE company = ? AND product_name = ? ORDER BY id
  `).all(product.company, product.productName).map(payloadRow);
  const indicators = db.prepare(`
    SELECT id, payload FROM insurance_indicator_records
    WHERE company = ? AND product_name = ? ORDER BY id
  `).all(product.company, product.productName).map(payloadRow);
  return {
    artifact: artifactRow ? JSON.parse(artifactRow.payload || '{}') : null,
    cards,
    indicators,
  };
}

async function main() {
  if (fs.existsSync(OUTPUT)) throw new Error(`refusing existing output: ${OUTPUT}`);
  fs.mkdirSync(OUTPUT, { recursive: true });

  const queue = readJsonl(APPROVED_QUEUE);
  const parserRows = readJson(PARSER_MANIFEST);
  if (queue.length !== 14) throw new Error(`approved queue count ${queue.length} != 14`);
  const parserBySource = new Map(parserRows.map((row) => [row.sourceUrl, row]));
  const artifacts = [];
  const products = [];
  const inputRows = [];
  const identities = new Set();
  for (const row of queue) {
    const parserRow = parserBySource.get(row.sourceUrl);
    if (!parserRow) throw new Error(`parser manifest row missing: ${row.sourceUrl}`);
    const artifactPath = path.resolve(ROOT, row.artifactPath);
    const artifact = readJson(artifactPath);
    const sourceDigest = artifact.productIdentity?.sourceDigest || artifact.sourceDigest || '';
    if (!sourceDigest || sourceDigest !== row.sourceDigest) {
      throw new Error(`artifact source digest mismatch: ${row.productName}`);
    }
    if (`sha256:${sha256(parserRow.sourceDocumentPath)}` !== sourceDigest) {
      throw new Error(`source file digest mismatch: ${row.productName}`);
    }
    const product = {
      company: artifact.company,
      productName: artifact.productName,
      sourceDigest,
    };
    const identity = `${product.company}\u001f${product.productName}\u001f${sourceDigest}`;
    if (identities.has(identity)) throw new Error(`duplicate identity: ${identity}`);
    identities.add(identity);
    artifacts.push(artifact);
    products.push(product);
    inputRows.push({
      ...product,
      artifactPath,
      artifactSha256: sha256(artifactPath),
      sourceFile: parserRow.sourceDocumentPath,
      sourceFileSha256: sha256(parserRow.sourceDocumentPath),
    });
  }

  const artifactsPath = path.join(OUTPUT, 'approved-artifacts.jsonl');
  const productsPath = path.join(OUTPUT, 'products.json');
  writeJsonl(artifactsPath, artifacts);
  writeJson(productsPath, products);
  writeJson(path.join(OUTPUT, 'input-lock.json'), {
    schema: 'source-wave007-approved14-clone-input/v1',
    approvedQueue: APPROVED_QUEUE,
    approvedQueueSha256: sha256(APPROVED_QUEUE),
    parserManifest: PARSER_MANIFEST,
    parserManifestSha256: sha256(PARSER_MANIFEST),
    fixedRepo: FIXED_REPO,
    importer: IMPORTER,
    importerSha256: sha256(IMPORTER),
    projectionTool: PROJECTION,
    projectionToolSha256: sha256(PROJECTION),
    sourceDb: { path: SOURCE_DB, readOnly: true },
    selected: inputRows.length,
    inputs: inputRows,
  });

  const clonePath = path.join(OUTPUT, 'clone.sqlite');
  const source = new DatabaseSync(SOURCE_DB, { readOnly: true });
  try {
    await backup(source, clonePath);
  } finally {
    source.close();
  }
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${clonePath}${suffix}`)) fs.rmSync(`${clonePath}${suffix}`);
  }

  const dryRun = importReviewedResponsibilityArtifacts({
    artifacts: [artifactsPath],
    dbPath: clonePath,
    write: false,
    now: '2026-08-01T00:00:00.000Z',
  });
  writeJson(path.join(OUTPUT, 'dry-run-receipt.json'), dryRun);
  const formal = importReviewedResponsibilityArtifacts({
    artifacts: [artifactsPath],
    dbPath: clonePath,
    write: true,
    now: '2026-08-01T00:00:00.000Z',
  });
  writeJson(path.join(OUTPUT, 'formal-import-receipt.json'), formal);

  const projectionPath = path.join(OUTPUT, 'projection-readback.json');
  execFileSync(process.execPath, [
    PROJECTION,
    `--db=${clonePath}`,
    `--products=${productsPath}`,
    `--output=${projectionPath}`,
  ], { cwd: FIXED_REPO, encoding: 'utf8', timeout: 120000, maxBuffer: 80 * 1024 * 1024 });
  const projection = readJson(projectionPath);

  const db = new DatabaseSync(clonePath, { readOnly: true });
  const strictProducts = products.map((product) => {
    const state = loadProductState(db, product);
    return evaluateResponsibilityStrictAlignment({ ...state, ...product });
  });
  const quickCheck = db.prepare('PRAGMA quick_check').get()?.quick_check || '';
  const foreignKeyIssueCount = db.prepare('PRAGMA foreign_key_check').all().length;
  const duplicateCardGroups = products.reduce((count, product) => count + Number(db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT title FROM product_responsibility_cards
      WHERE company = ? AND product_name = ?
      GROUP BY title HAVING COUNT(*) > 1
    )
  `).get(product.company, product.productName).count || 0), 0);
  db.close();

  const strictAligned = strictProducts.filter((item) => item.strictAligned).length;
  const passed = Boolean(
    dryRun.ok === true
    && dryRun.validationIssueCount === 0
    && formal.ok === true
    && projection.semanticExact === true
    && projection.fieldDifferenceCount === 0
    && projection.duplicateIssueCount === 0
    && projection.orphanIssueCount === 0
    && strictAligned === products.length
    && duplicateCardGroups === 0
    && quickCheck === 'ok'
    && foreignKeyIssueCount === 0
  );
  writeJson(path.join(OUTPUT, 'strict-alignment.json'), {
    schema: 'source-wave007-approved14-strict-alignment/v1',
    products: strictProducts,
    counts: { products: products.length, strictAligned },
  });

  const importReady = passed ? inputRows.map((row) => ({
    ...row,
    terminalStatus: 'import_ready',
    clonePath,
    importAuthorized: false,
  })) : [];
  const blocked = passed ? [] : inputRows.map((row, index) => ({
    ...row,
    terminalStatus: 'materializer_blocked',
    strictAlignment: strictProducts[index],
  }));
  writeJsonl(path.join(OUTPUT, 'import-ready.jsonl'), importReady);
  writeJsonl(path.join(OUTPUT, 'materializer-blocked.jsonl'), blocked);
  const terminal = {
    schema: 'source-wave007-approved14-clone-terminal/v1',
    gate: passed ? 'PASS' : 'BLOCKED',
    status: passed ? 'PASS_CLONE_ONLY' : 'MATERIALIZER_BLOCKED',
    selected: products.length,
    importReady: importReady.length,
    materializerBlocked: blocked.length,
    responsibilities: artifacts.reduce((sum, artifact) => sum + rows(artifact.responsibilities).length, 0),
    indicators: artifacts.reduce(
      (sum, artifact) => sum + rows(artifact.responsibilities).reduce(
        (inner, responsibility) => inner + rows(responsibility.indicators).length,
        0,
      ),
      0,
    ),
    projection: {
      semanticExact: projection.semanticExact,
      fieldDifferenceCount: projection.fieldDifferenceCount,
      duplicateIssueCount: projection.duplicateIssueCount,
      orphanIssueCount: projection.orphanIssueCount,
    },
    strict: { products: products.length, strictAligned },
    duplicateCardGroups,
    quickCheck,
    foreignKeyIssueCount,
    sourceDbReadOnly: true,
    realSsdWrites: 0,
    feishuWrites: 0,
    publishActions: 0,
    importAuthorized: false,
    clonePath,
  };
  writeJson(path.join(OUTPUT, 'terminal-receipt.json'), terminal);
  const files = fs.readdirSync(OUTPUT)
    .filter((name) => name !== 'sha256.json')
    .map((name) => path.join(OUTPUT, name))
    .filter((file) => fs.statSync(file).isFile());
  writeJson(path.join(OUTPUT, 'sha256.json'), {
    files: files.map((file) => ({ path: file, sha256: sha256(file) })),
  });
  process.stdout.write(`${JSON.stringify(terminal, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
