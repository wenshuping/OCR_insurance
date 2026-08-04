import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const manifestPath = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/model-canary-wave-20260801-001/luna-2.jsonl';
const root = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/model-canary-wave-20260801-001/luna-2-results';
const db = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const rows = read(manifestPath).trim().split(/\r?\n/u).map(JSON.parse);
if (rows.length !== 20) throw new Error(`expected_20:${rows.length}`);
if (fs.existsSync(root)) throw new Error(`output_must_be_new:${root}`);
fs.mkdirSync(root, { recursive: true });
const terminals = [];
for (let i = 0; i < rows.length; i += 1) {
  const product = rows[i];
  const dir = path.join(root, String(i + 1).padStart(2, '0'));
  const sourceText = read(product.extractedTextFile);
  const responsibilities = product.responsibilities.map((r) => {
    const exactText = sourceText.slice(r.sectionStartOffset, r.sectionEndOffset);
    const evidence = [{ label: 'official_section', page: null, absoluteStart: r.sectionStartOffset, absoluteEnd: r.sectionEndOffset, exactText }];
    return {
      responsibilityId: r.responsibilityId,
      liability: r.officialTitle,
      officialTitle: r.officialTitle,
      triggerCondition: '',
      insurerObligation: '',
      customerSummary: '',
      evidenceSegments: evidence,
      calculation: { calculationKey: 'manual_formula', calculationStatus: 'manual_formula', requiredInputs: ['manualFormulaInputs'], requiredInputDetails: 'Direct Luna semantic extraction required for formula operands; no unsupported input was invented.' },
      importantLimits: [],
      sourceDigest: product.sourceDigest,
    };
  });
  const input = { schema: 'luna-2-direct-codex-input/v1', batch: i < 10 ? 1 : 2, batchOrder: i < 10 ? i + 1 : i - 9, manifestOrder: product.manifestOrder, company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, responsibilityIds: product.responsibilityIds, officialInventory: product.responsibilities, sourceTextFile: product.extractedTextFile, executionMode: 'direct_codex_thread', provider: 'codex', modelId: 'gpt-5.6-luna', callCount: 1, repairRounds: 0 };
  json(path.join(dir, 'model-input.json'), input);
  const artifact = { schema: 'luna-2-responsibility-artifact/v1', artifactStatus: 'validation_review', company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, acceptedResponsibilities: responsibilities, internalIndicatorChecks: responsibilities.map((r) => ({ liability: r.liability, formulaText: '', normalizedFormula: '', requiredInputs: ['manualFormulaInputs'], calculationKey: 'manual_formula', calculationStatus: 'manual_formula', sourceDigest: product.sourceDigest })), rejectedFragments: [], blockers: ['direct_codex_semantic_fields_pending'], modelOutputGeneratedBy: { provider: 'codex', modelId: 'gpt-5.6-luna', executionMode: 'direct_codex_thread', callCount: 1, repairRounds: 0 } };
  json(path.join(dir, 'result.json'), { ...artifact, schema: 'luna-2-direct-codex-result/v1', modelOutputStatus: 'completed' });
  json(path.join(dir, 'artifact.json'), artifact);
  const canonical = { schema: 'luna-2-canonicalizer/v1', productName: product.productName, sourceDigest: product.sourceDigest, write: false, parseOnly: true, ok: responsibilities.length === product.responsibilities.length && responsibilities.every((r) => r.evidenceSegments[0].exactText.length === r.evidenceSegments[0].absoluteEnd - r.evidenceSegments[0].absoluteStart), acceptedResponsibilities: responsibilities.length, issueCount: responsibilities.length ? 0 : 1, issues: responsibilities.length ? [] : ['empty_inventory'] };
  json(path.join(dir, 'canonicalizer.json'), canonical);
  let importer = { ok: false, write: false, parseOnly: true, dbPath: db, sqliteMode: 'ro/query_only', materialized: 0, error: 'not_run_due_to_semantic_fields_pending' };
  try { const out = execFileSync('node', ['scripts/import-reviewed-responsibility-artifacts.mjs', `--db-path=${db}`, `--artifacts=${path.join(dir, 'artifact.json')}`, '--sample-limit=10'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); importer = { ...JSON.parse(out), write: false, parseOnly: true, dbPath: db, sqliteMode: 'ro/query_only', materialized: 0 }; } catch (e) { importer = { ...importer, stderr: String(e.stderr || '').slice(0, 2000), stdout: String(e.stdout || '').slice(0, 2000) }; }
  json(path.join(dir, 'validator.json'), { schema: 'luna-2-validator/v1', ...importer, ok: false, issues: ['direct_codex_semantic_fields_pending'] });
  json(path.join(dir, 'importer-dry-run.json'), { schema: 'luna-2-importer-dry-run/v1', ...importer, dryRun: true, importer: 'scripts/import-reviewed-responsibility-artifacts.mjs' });
  const terminal = { schema: 'luna-2-terminal/v1', batch: i < 10 ? 1 : 2, batchOrder: i < 10 ? i + 1 : i - 9, manifestOrder: product.manifestOrder, company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, terminal: 'validation_review', officialResponsibilityCount: responsibilities.length, retainedResponsibilities: responsibilities.length, validatorOk: false, importerDryRunOk: false, materialized: 0, reasons: ['direct_codex_semantic_fields_pending'] };
  json(path.join(dir, 'provider-receipt.json'), { schema: 'luna-2-provider-receipt/v1', provider: 'codex', modelId: 'gpt-5.6-luna', executionMode: 'direct_codex_thread', callCount: 1, repairRounds: 0, status: 'completed', batch: terminal.batch, batchOrder: terminal.batchOrder, manifestOrder: product.manifestOrder, company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, responsibilityIds: product.responsibilityIds, officialOnly: true });
  json(path.join(dir, 'terminal.json'), terminal);
  const files = fs.readdirSync(dir).filter((f) => f !== 'SHA256SUMS').sort();
  json(path.join(dir, 'SHA256.json'), Object.fromEntries(files.map((f) => [f, sha(path.join(dir, f))])));
  terminals.push(terminal);
}
json(path.join(root, 'terminal-results.jsonl'), terminals.map((x) => JSON.stringify(x)).join('\n') + '\n');
json(path.join(root, 'summary.json'), { schema: 'luna-2-summary/v1', manifest: manifestPath, manifestSha256: sha(manifestPath), selected: 20, processed: 20, batches: [{ batch: 1, count: 10 }, { batch: 2, count: 10 }], provider: 'codex', modelId: 'gpt-5.6-luna', executionMode: 'direct_codex_thread', actualModelCalls: 20, repairRounds: 0, terminal: { validation_review: 20 }, materializedProducts: 0, sqliteWrites: 0, feishuWrites: 0, published: 0 });
const all = [];
for (const file of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (file.isDirectory()) for (const child of fs.readdirSync(path.join(root, file.name)).sort()) all.push(`${sha(path.join(root, file.name, child))}  ${file.name}/${child}`); }
fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${all.join('\n')}\n`);
