#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = '/Volumes/OCR_ARCHIVE/OCR_insurance';
const ALLOWED_STATES = new Set([
  'strict_aligned',
  'source_pending',
  'source_ready',
  'source_blocked',
  'version_conflict',
  'parse_pending',
  'validation_review',
  'model_retry',
  'approved',
  'materializer_blocked',
  'import_pending',
  'imported',
  'manual_review',
]);

function text(value) {
  return String(value ?? '').trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeIdentity(value) {
  return text(value).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
}

function normalizeDigest(value) {
  const candidate = text(value).toLowerCase();
  if (/^sha256:[0-9a-f]{64}$/.test(candidate)) return candidate;
  if (/^[0-9a-f]{64}$/.test(candidate)) return `sha256:${candidate}`;
  return '';
}

function normalizeUrl(value) {
  try {
    const url = new URL(text(value));
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return '';
  }
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function readJson(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : ''));
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function productIdentity(row) {
  const raw = text(rows(row.rawProducts)[0]);
  const [company = '', productName = ''] = raw.split('\u001f');
  return { company: text(company), productName: text(productName) };
}

function recordIdentity(record) {
  const artifact = record?.artifact || record?.canonicalArtifact || record?.result || {};
  const identity = record?.productIdentity || artifact?.productIdentity || {};
  return {
    company: text(record?.company || artifact?.company || identity?.company),
    productName: text(record?.productName || artifact?.productName || identity?.productName),
    sourceDigest: normalizeDigest(
      record?.sourceDigest
      || artifact?.sourceDigest
      || identity?.sourceDigest,
    ),
    sourceUrl: normalizeUrl(
      record?.sourceUrl
      || artifact?.sourceUrl
      || identity?.sourceUrl,
    ),
  };
}

function addIndex(map, key, row) {
  if (!key) return;
  const bucket = map.get(key) || [];
  bucket.push(row);
  map.set(key, bucket);
}

export function buildIndex(ledger) {
  const index = {
    byDigest: new Map(),
    byUrl: new Map(),
    byName: new Map(),
  };
  for (const row of ledger) {
    for (const value of rows(row.sourceDigests)) addIndex(index.byDigest, normalizeDigest(value), row);
    for (const value of rows(row.sourceUrls)) addIndex(index.byUrl, normalizeUrl(value), row);
    const { company, productName } = productIdentity(row);
    addIndex(index.byName, `${normalizeIdentity(company)}\u001f${normalizeIdentity(productName)}`, row);
  }
  return index;
}

function disambiguate(candidates, identity) {
  if (candidates.length <= 1) return candidates[0] || null;
  const nameKey = `${normalizeIdentity(identity.company)}\u001f${normalizeIdentity(identity.productName)}`;
  const exact = candidates.filter((candidate) => {
    const rowIdentity = productIdentity(candidate);
    return `${normalizeIdentity(rowIdentity.company)}\u001f${normalizeIdentity(rowIdentity.productName)}` === nameKey;
  });
  return exact.length === 1 ? exact[0] : null;
}

export function matchRecord(record, index) {
  const identity = recordIdentity(record);
  if (identity.sourceDigest) {
    const matched = disambiguate(index.byDigest.get(identity.sourceDigest) || [], identity);
    if (matched) return matched;
  }
  if (identity.sourceUrl) {
    const matched = disambiguate(index.byUrl.get(identity.sourceUrl) || [], identity);
    if (matched) return matched;
  }
  const nameKey = `${normalizeIdentity(identity.company)}\u001f${normalizeIdentity(identity.productName)}`;
  return disambiguate(index.byName.get(nameKey) || [], identity);
}

function baseState(category, cardCount, indicatorCount) {
  if (category === 'strict_aligned') {
    return { state: 'strict_aligned', lane: 'NONE', terminalStatus: 'strict_aligned', databaseStatus: 'strict_aligned' };
  }
  if (category === 'artifact_backed_deterministic_rebuild_formula_or_multi_indicator') {
    return { state: 'import_pending', lane: 'MATERIALIZER_REBUILD', terminalStatus: '', databaseStatus: 'non_strict' };
  }
  if (category === 'artifact_backed_materializer_only') {
    return { state: 'materializer_blocked', lane: 'MATERIALIZER_REPAIR', terminalStatus: '', databaseStatus: 'non_strict' };
  }
  if (category === 'duplicate_or_orphan_card_cleanup') {
    return { state: 'validation_review', lane: 'DUPLICATE_ORPHAN_REPAIR', terminalStatus: '', databaseStatus: 'non_strict' };
  }
  if (category === 'other_blocked') {
    const lane = cardCount > 0 && indicatorCount === 0 ? 'INCOMPLETE_CARD_ONLY' : 'INCOMPLETE_INDICATOR_ONLY';
    return { state: 'parse_pending', lane, terminalStatus: '', databaseStatus: 'incomplete' };
  }
  return { state: 'source_pending', lane: 'SOURCE', terminalStatus: '', databaseStatus: 'legacy_non_strict' };
}

export function createMasterLedger(alignment) {
  return rows(alignment.ledger).map((row) => {
    const { company, productName } = productIdentity(row);
    const initial = baseState(row.category, row.cards, row.indicators);
    return {
      productKey: row.key,
      company,
      productName,
      sourceUrl: text(rows(row.sourceUrls)[0]),
      sourceDigest: normalizeDigest(rows(row.sourceDigests)[0]),
      sourceStatus: row.category === 'strict_aligned' ? 'verified_in_database' : 'unknown',
      sourceFile: '',
      sourceTextFile: '',
      sourceContract: '',
      artifactPath: '',
      artifactStatus: row.evidence?.approvedArtifacts ? 'approved_in_database' : 'missing',
      providerRoute: '',
      manifestId: '',
      lane: initial.lane,
      state: initial.state,
      terminalStatus: initial.terminalStatus,
      databaseStatus: initial.databaseStatus,
      alignmentCategory: row.category,
      cards: Number(row.cards || 0),
      indicators: Number(row.indicators || 0),
      alignmentEvidence: row.evidence || {},
      receipts: [],
    };
  });
}

function receiptPath(label, sourcePath) {
  return { type: label, path: sourcePath };
}

function applySourceReady(master, record, sourcePath) {
  if (master.state === 'strict_aligned' || master.artifactStatus === 'approved_in_database') return;
  const identity = recordIdentity(record);
  master.sourceUrl = text(record.sourceUrl || master.sourceUrl);
  master.sourceDigest = identity.sourceDigest || master.sourceDigest;
  master.sourceStatus = 'source_ready';
  master.sourceFile = text(record.sourceFile || record.sourceDocumentPath);
  master.sourceTextFile = text(record.extractedTextFile || record.sourceTextPath || record.responsibilityTextFile);
  master.sourceContract = text(record.sourceContract);
  master.providerRoute = text(record.recommendedProvider);
  master.state = 'parse_pending';
  master.lane = master.providerRoute === 'deepseek-standard' ? 'DEEPSEEK' : 'LUNA';
  master.terminalStatus = '';
  master.receipts.push(receiptPath('source_ready', sourcePath));
}

function applyDirectFailure(master, record, sourcePath) {
  if (master.state === 'strict_aligned' || master.artifactStatus === 'approved_in_database') return;
  master.sourceStatus = 'direct_failed_next_ladder';
  master.state = 'source_pending';
  master.lane = 'SOURCE';
  master.terminalStatus = '';
  master.receipts.push(receiptPath('direct_source_failure', sourcePath));
}

function applyTerminal(master, record, state, sourcePath) {
  if (master.state === 'strict_aligned' || master.artifactStatus === 'approved_in_database') return;
  master.state = state;
  master.terminalStatus = state;
  master.lane = state === 'validation_review'
    ? 'REVIEW'
    : state === 'model_retry'
      ? (text(record.provider || record.primaryProvider || record.route).includes('deepseek') ? 'DEEPSEEK_RETRY' : 'LUNA_RETRY')
      : state === 'source_pending'
        ? 'SOURCE'
        : state === 'manual_review'
          ? 'MANUAL'
          : master.lane;
  master.artifactPath = text(record.artifactPath || record.canonicalArtifactPath || record.artifact?.artifactPath);
  master.artifactStatus = state === 'approved' ? 'approved_candidate' : master.artifactStatus;
  master.receipts.push(receiptPath(state, sourcePath));
}

function overlayRecords(masterLedger, records, sourcePath, handler) {
  const baseIndex = buildIndex(masterLedger.map((row) => ({
    key: row.productKey,
    rawProducts: [`${row.company}\u001f${row.productName}`],
    sourceDigests: row.sourceDigest ? [row.sourceDigest] : [],
    sourceUrls: row.sourceUrl ? [row.sourceUrl] : [],
  })));
  const masterByKey = new Map(masterLedger.map((row) => [row.productKey, row]));
  let matched = 0;
  const unmatched = [];
  for (const record of records) {
    const base = matchRecord(record, baseIndex);
    const master = base ? masterByKey.get(base.key) : null;
    if (!master) {
      unmatched.push(recordIdentity(record));
      continue;
    }
    handler(master, record, sourcePath);
    matched += 1;
  }
  return { input: records.length, matched, unmatched };
}

function parseDomain(value) {
  try {
    return new URL(text(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function runnerProduct(row) {
  return {
    company: row.company,
    productName: row.productName,
    sourceUrl: row.sourceUrl,
    officialDomain: parseDomain(row.sourceUrl),
    sourceDocumentPath: row.sourceFile,
    sourceTextPath: row.sourceTextFile,
    sourceDigest: row.sourceDigest,
    sourceContract: row.sourceContract,
    productKey: row.productKey,
    manifestId: row.manifestId,
    route: row.providerRoute,
  };
}

function writeManifest(outputDir, relativePath, selected, transform = (value) => value) {
  const filePath = path.join(outputDir, relativePath);
  const values = selected.map(transform);
  writeJson(filePath, values);
  return { path: filePath, selected: values.length, sha256: sha256(filePath) };
}

function assignManifest(rowsToAssign, manifestId, lane) {
  for (const row of rowsToAssign) {
    row.manifestId = manifestId;
    row.lane = lane;
  }
}

function first(values, count) {
  return values.slice(0, Math.max(0, count));
}

function buildSourceCanaries(masterLedger, outputDir) {
  const candidates = masterLedger.filter((row) => (
    row.state === 'source_pending'
    && row.alignmentCategory === 'missing_approved_artifact'
    && parseDomain(row.sourceUrl)
  ));
  const byDomain = new Map();
  for (const row of candidates) {
    const domain = parseDomain(row.sourceUrl);
    const bucket = byDomain.get(domain) || [];
    bucket.push(row);
    byDomain.set(domain, bucket);
  }
  const domains = [...byDomain.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .slice(0, 3);
  return domains.map(([domain, values], index) => {
    const selected = first(values, 20);
    const manifestId = `source-domain-canary-${String(index + 1).padStart(3, '0')}`;
    assignManifest(selected, manifestId, `SOURCE_${index + 1}`);
    const manifest = selected.map((row) => ({
      ...runnerProduct(row),
      previousSourceStatus: row.sourceStatus,
      startLayer: row.sourceStatus === 'direct_failed_next_ladder'
        ? 'company_catalog_or_browser'
        : 'cache_or_company_catalog',
    }));
    const relativePath = `manifests/source/lane-${index + 1}/canary-001.json`;
    const written = writeManifest(outputDir, relativePath, manifest);
    return { ...written, manifestId, domain, remainingForDomain: values.length - selected.length };
  });
}

function buildProviderCanaries(masterLedger, outputDir, route, lanePrefix, laneCount, perLane) {
  const candidates = masterLedger.filter((row) => row.state === 'parse_pending' && row.providerRoute === route);
  const manifests = [];
  for (let index = 0; index < laneCount; index += 1) {
    const selected = candidates.slice(index * perLane, (index + 1) * perLane);
    if (!selected.length) break;
    const manifestId = `${lanePrefix.toLowerCase()}-canary-${String(index + 1).padStart(3, '0')}`;
    assignManifest(selected, manifestId, `${lanePrefix}_${index + 1}`);
    manifests.push({
      ...writeManifest(
        outputDir,
        `manifests/${lanePrefix.toLowerCase()}/lane-${index + 1}/canary-001.json`,
        selected,
        runnerProduct,
      ),
      manifestId,
    });
  }
  return manifests;
}

function summarize(masterLedger) {
  const countBy = (field) => Object.fromEntries(
    [...masterLedger.reduce((map, row) => {
      const key = text(row[field]) || 'none';
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map()).entries()].sort(),
  );
  return {
    products: masterLedger.length,
    byState: countBy('state'),
    byLane: countBy('lane'),
    byAlignmentCategory: countBy('alignmentCategory'),
    sourceReady: masterLedger.filter((row) => row.sourceStatus === 'source_ready').length,
    nonTerminal: masterLedger.filter((row) => !['strict_aligned', 'source_blocked', 'version_conflict', 'manual_review', 'materializer_blocked', 'imported'].includes(row.state)).length,
  };
}

function collectShaFiles(rootDir) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name !== 'sha256.json') files[path.relative(rootDir, fullPath)] = sha256(fullPath);
    }
  };
  walk(rootDir);
  return files;
}

export function runCoordinator({
  alignmentPath,
  sourceRoot,
  firstParseRoot,
  secondaryRoot,
  unifiedReviewPath,
  materializerInputPath,
  outputDir,
}) {
  const alignment = readJson(alignmentPath);
  if (!alignment || !Array.isArray(alignment.ledger)) throw new Error(`invalid alignment ledger: ${alignmentPath}`);
  const masterLedger = createMasterLedger(alignment);
  const overlays = {};

  const sourceReadyPath = path.join(sourceRoot, 'FIRST_PARSE-return-queue-routed.jsonl');
  overlays.sourceReady = overlayRecords(
    masterLedger,
    readJsonl(sourceReadyPath),
    sourceReadyPath,
    applySourceReady,
  );
  const directFailurePath = path.join(sourceRoot, 'SOURCE-blocked-return-queue.jsonl');
  overlays.directFailure = overlayRecords(
    masterLedger,
    readJsonl(directFailurePath),
    directFailurePath,
    applyDirectFailure,
  );

  const terminalMappings = [
    ['validation-review.jsonl', 'validation_review'],
    ['model-retry.jsonl', 'model_retry'],
    ['source-retry.jsonl', 'source_pending'],
    ['manual-review.jsonl', 'manual_review'],
    ['approved.jsonl', 'approved'],
  ];
  for (const [fileName, state] of terminalMappings) {
    const filePath = path.join(firstParseRoot, 'final-queues', fileName);
    overlays[`firstParse:${state}`] = overlayRecords(
      masterLedger,
      readJsonl(filePath),
      filePath,
      (master, record, sourcePath) => applyTerminal(master, record, state, sourcePath),
    );
  }

  const providerTerminalPath = path.join(
    secondaryRoot,
    'execution-existing-evidence-21/provider-routed-18/terminal-provider-queues.jsonl',
  );
  const providerRecords = readJsonl(providerTerminalPath);
  for (const record of providerRecords) {
    const status = text(record.status || record.terminalStatus).replaceAll('-', '_');
    const state = status.includes('validation')
      ? 'validation_review'
      : status.includes('model')
        ? 'model_retry'
        : status.includes('source')
          ? 'source_pending'
          : status.includes('approved')
            ? 'approved'
            : '';
    if (!state) continue;
    overlayRecords(
      masterLedger,
      [record],
      providerTerminalPath,
      (master, value, sourcePath) => applyTerminal(master, value, state, sourcePath),
    );
  }

  overlays.unifiedReviewModel = overlayRecords(
    masterLedger,
    readJsonl(unifiedReviewPath),
    unifiedReviewPath,
    (master, record, sourcePath) => applyTerminal(master, record, 'model_retry', sourcePath),
  );

  const duplicateKeys = masterLedger.length - new Set(masterLedger.map((row) => row.productKey)).size;
  if (duplicateKeys) throw new Error(`master ledger has ${duplicateKeys} duplicate product keys`);
  const invalidStates = masterLedger.filter((row) => !ALLOWED_STATES.has(row.state));
  if (invalidStates.length) throw new Error(`master ledger has ${invalidStates.length} invalid states`);
  if (masterLedger.length !== Number(alignment.counts?.products || 0)) {
    throw new Error(`master ledger count ${masterLedger.length} does not match alignment ${alignment.counts?.products}`);
  }

  const materializerCandidates = masterLedger.filter((row) => row.state === 'import_pending');
  const materializerInput = rows(readJson(materializerInputPath, []));
  const masterIndex = buildIndex(alignment.ledger);
  const materializerCanary = [];
  for (const artifact of materializerInput) {
    const matched = matchRecord(artifact, masterIndex);
    if (!matched) continue;
    const master = masterLedger.find((row) => row.productKey === matched.key);
    if (!master || master.state !== 'import_pending') continue;
    materializerCanary.push(artifact);
    if (materializerCanary.length === 20) break;
  }

  const manifests = {};
  const materializerId = 'materializer-canary-001';
  const materializerKeys = new Set(materializerCanary.map((artifact) => matchRecord(artifact, masterIndex)?.key).filter(Boolean));
  const selectedMaterializerRows = materializerCandidates.filter((row) => materializerKeys.has(row.productKey));
  assignManifest(selectedMaterializerRows, materializerId, 'MATERIALIZER_CANARY');
  manifests.materializer = {
    ...writeManifest(outputDir, 'manifests/materializer/canary-001.json', materializerCanary),
    manifestId: materializerId,
  };

  const duplicateCanary = first(masterLedger.filter((row) => row.lane === 'DUPLICATE_ORPHAN_REPAIR'), 20);
  assignManifest(duplicateCanary, 'duplicate-orphan-canary-001', 'DUPLICATE_ORPHAN_CANARY');
  manifests.duplicateOrphan = {
    ...writeManifest(outputDir, 'manifests/duplicate-orphan/canary-001.json', duplicateCanary),
    manifestId: 'duplicate-orphan-canary-001',
  };
  manifests.source = buildSourceCanaries(masterLedger, outputDir);
  manifests.deepseek = buildProviderCanaries(masterLedger, outputDir, 'deepseek-standard', 'DEEPSEEK', 3, 20);
  manifests.luna = buildProviderCanaries(masterLedger, outputDir, 'luna-complex', 'LUNA', 1, 20);

  const reviewCanary = first(masterLedger.filter((row) => row.state === 'validation_review' && row.lane === 'REVIEW'), 100);
  assignManifest(reviewCanary, 'review-priority-001', 'REVIEW');
  manifests.review = {
    ...writeManifest(outputDir, 'manifests/review/priority-001.json', reviewCanary),
    manifestId: 'review-priority-001',
  };

  const modelRetryCanary = first(masterLedger.filter((row) => row.state === 'model_retry'), 100);
  assignManifest(modelRetryCanary, 'model-retry-priority-001', 'MODEL_RETRY');
  manifests.modelRetry = {
    ...writeManifest(outputDir, 'manifests/model-retry/priority-001.json', modelRetryCanary),
    manifestId: 'model-retry-priority-001',
  };

  const ledgerPath = path.join(outputDir, 'master-ledger.jsonl');
  writeJsonl(ledgerPath, masterLedger);
  const summary = {
    schema: 'responsibility-full-backfill-coordinator/v1',
    generatedAt: new Date().toISOString(),
    inputs: {
      alignmentPath,
      alignmentSha256: sha256(alignmentPath),
      sourceRoot,
      firstParseRoot,
      secondaryRoot,
      unifiedReviewPath,
      materializerInputPath,
    },
    dedupePrecedence: ['sourceDigest', 'sourceUrl', 'normalized company+productName'],
    productIdentityRule: 'shared digest or URL never merges distinct company+product identities',
    overlays,
    counts: summarize(masterLedger),
    manifests,
    invariants: {
      productsExact: masterLedger.length === alignment.counts.products,
      productKeysUnique: true,
      statesValid: true,
      workerCommunication: 'filesystem manifests and terminal receipts only',
      sqliteWritten: false,
      feishuWritten: false,
      published: false,
    },
  };
  const summaryPath = path.join(outputDir, 'summary.json');
  writeJson(summaryPath, summary);
  writeJson(path.join(outputDir, 'sha256.json'), { files: collectShaFiles(outputDir) });
  return { ledgerPath, summaryPath, summary };
}

function main() {
  const root = arg('root', DEFAULT_ROOT);
  const worktree = arg('worktree', path.join(root, '.worktrees/dev-agent-semantic-integration'));
  const outputDir = arg('output-dir', path.join(root, 'artifacts/responsibility-full-backfill-20260729'));
  const result = runCoordinator({
    alignmentPath: arg('alignment', path.join(outputDir, 'baseline/alignment.json')),
    sourceRoot: arg('source-root', path.join(root, 'artifacts/missing-approved-artifact-source-repair-20260729')),
    firstParseRoot: arg('first-parse-root', path.join(root, 'artifacts/first-parse-source-ready-42-20260729')),
    secondaryRoot: arg(
      'secondary-root',
      path.join(worktree, 'artifacts/responsibility-alignment-20260729/missing-artifact-secondary-classification'),
    ),
    unifiedReviewPath: arg(
      'unified-review',
      path.join(root, 'artifacts/review-unified-model-validation64-20260729/model-retry.jsonl'),
    ),
    materializerInputPath: arg(
      'materializer-input',
      path.join(worktree, 'artifacts/responsibility-alignment-20260729/materializer-only-approved-input-c001.json'),
    ),
    outputDir,
  });
  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    ledgerPath: result.ledgerPath,
    summaryPath: result.summaryPath,
    counts: result.summary.counts,
  }, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
