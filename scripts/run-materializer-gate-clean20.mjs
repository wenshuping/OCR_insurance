import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { importReviewedResponsibilityArtifacts } from './import-reviewed-responsibility-artifacts.mjs';
import { evaluateResponsibilityStrictAlignment } from './responsibility-strict-alignment.mjs';

const execFileAsync = promisify(execFile);
const root = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2';
const coordinator = path.join(root, 'wave-002-coordinator');
const output = path.join(root, 'materializer-gate-clean20-20260801');
const sourceDbPath = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const projectionTool = path.join(repo, 'scripts/audit-materializer-projection-readback.mjs');

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const productKey = (row) => `${row.company}\u001f${row.productName}`;
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

function runWithTimeout(file, args, timeout, stdoutFile) {
  return execFileAsync(process.execPath, [file, ...args], { cwd: repo, timeout, maxBuffer: 80 * 1024 * 1024 })
    .then(({ stdout, stderr }) => { fs.writeFileSync(stdoutFile, stdout); if (stderr) fs.writeFileSync(`${stdoutFile}.stderr`, stderr); return { status: 'completed', stdout }; })
    .catch((error) => { fs.writeFileSync(stdoutFile, error.stdout || ''); fs.writeFileSync(`${stdoutFile}.stderr`, error.stderr || error.message || String(error)); return { status: error.killed ? 'timeout' : 'failed', code: error.code || null }; });
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const aPath = path.join(coordinator, 'manifests/materializer-A.jsonl');
  const bPath = path.join(coordinator, 'manifests/materializer-B.jsonl');
  const a = readJsonl(aPath).slice(0, 10);
  const b = readJsonl(bPath).slice(0, 10);
  const products = [...a, ...b];
  const keys = new Set(products.map(productKey));
  const exclusions = products.filter((row) => /增额终身寿/.test(row.productName));
  if (products.length !== 20 || keys.size !== 20 || exclusions.length) throw new Error('locked product selection failed');
  const productsPath = path.join(output, 'products.json');
  writeJson(productsPath, products);
  writeJson(path.join(output, 'input-lock.json'), {
    schema: 'materializer-gate-clean20-input-lock/v1',
    manifests: { a: aPath, aSha256: sha256(aPath), b: bPath, bSha256: sha256(bPath) },
    products: products.map(({ company, productName, sourceDigest }) => ({ company, productName, sourceDigest })),
    sourceDb: { path: sourceDbPath, readOnly: true },
    excludedSpecialty: exclusions.length,
  });

  const clonePath = path.join(output, 'clone.sqlite');
  const source = new DatabaseSync(sourceDbPath, { readOnly: true });
  try { await backup(source, clonePath); } finally { source.close(); }
  for (const suffix of ['-wal', '-shm']) if (fs.existsSync(`${clonePath}${suffix}`)) fs.rmSync(`${clonePath}${suffix}`);

  const artifactPath = path.join(output, 'approved-artifacts.jsonl');
  const sourceRead = new DatabaseSync(sourceDbPath, { readOnly: true });
  const artifacts = products.map((product) => sourceRead.prepare(`SELECT payload FROM product_responsibility_artifacts WHERE company = ? AND product_name = ? ORDER BY id DESC LIMIT 1`).get(product.company, product.productName)?.payload).filter(Boolean).map(JSON.parse);
  sourceRead.close();
  if (artifacts.length !== 20) throw new Error(`approved artifact count ${artifacts.length} != 20`);
  fs.writeFileSync(artifactPath, `${artifacts.map((item) => JSON.stringify(item)).join('\n')}\n`);

  const importResult = importReviewedResponsibilityArtifacts({ artifacts: [artifactPath], dbPath: clonePath, write: true, now: '2026-08-01T00:00:00.000Z' });
  writeJson(path.join(output, 'formal-import-receipt.json'), importResult);
  const projectionPath = path.join(output, 'projection-readback.json');
  const projectionRun = await runWithTimeout(projectionTool, [`--db=${clonePath}`, `--products=${productsPath}`, `--output=${projectionPath}`], 120000, path.join(output, 'projection-readback.stdout'));
  const projection = fs.existsSync(projectionPath) ? JSON.parse(fs.readFileSync(projectionPath)) : { semanticExact: false, fieldDifferenceCount: null, reason: projectionRun.status };

  const db = new DatabaseSync(clonePath, { readOnly: true });
  const strictProducts = products.map((product) => {
    const artifact = db.prepare('SELECT payload FROM product_responsibility_artifacts WHERE company = ? AND product_name = ? ORDER BY id DESC LIMIT 1').get(product.company, product.productName);
    const cards = db.prepare('SELECT id, title, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? ORDER BY id').all(product.company, product.productName).map((row) => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
    const indicators = db.prepare('SELECT id, payload FROM insurance_indicator_records WHERE company = ? AND product_name = ? ORDER BY id').all(product.company, product.productName).map((row) => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
    return evaluateResponsibilityStrictAlignment({ artifact: artifact ? JSON.parse(artifact.payload || '{}') : null, cards, indicators, company: product.company, productName: product.productName });
  });
  const quickCheck = db.prepare('PRAGMA quick_check').get()?.quick_check || '';
  const foreignKeyIssueCount = db.prepare('PRAGMA foreign_key_check').all().length;
  db.close();
  const strict = { schema: 'materializer-gate-clean20-strict-alignment/v1', products: strictProducts, counts: { products: 20, strictAligned: strictProducts.filter((item) => item.strictAligned).length } };
  writeJson(path.join(output, 'strict-alignment.json'), strict);
  const pass = projection.semanticExact && projection.fieldDifferenceCount === 0 && strict.counts.strictAligned === 20 && quickCheck === 'ok' && foreignKeyIssueCount === 0 && projectionRun.status === 'completed';
  const receipt = { schema: 'materializer-gate-clean20-terminal/v1', gate: pass ? 'PASS' : 'BLOCKED', status: pass ? 'PASS_CLONE_ONLY' : 'BLOCKED', reasonCodes: pass ? [] : ['THREE_LAYER_READBACK_FAILED'], products: 20, aProducts: 10, bProducts: 10, projection: { semanticExact: projection.semanticExact, fieldDifferenceCount: projection.fieldDifferenceCount }, strict: strict.counts, quickCheck, foreignKeyIssueCount, projectionRun: { status: projectionRun.status, timeoutMs: 120000 }, sourceDbReadOnly: true, databaseWrites: 0, feishuWrites: 0, publishActions: 0, clonePath };
  writeJson(path.join(output, 'terminal-receipt.json'), receipt);
  writeJson(path.join(output, 'SHA256SUMS.json'), { terminalReceiptSha256: sha256(path.join(output, 'terminal-receipt.json')), inputLockSha256: sha256(path.join(output, 'input-lock.json')) });
  console.log(JSON.stringify(receipt, null, 2));
  if (!pass) process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
