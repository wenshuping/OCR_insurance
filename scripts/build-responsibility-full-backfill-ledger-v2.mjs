#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = '/Volumes/OCR_ARCHIVE/OCR_insurance';
const DEFAULT_OUTPUT = path.join(DEFAULT_ROOT, 'artifacts/responsibility-full-backfill-20260731-v2');
const DEFAULT_SOURCE_PENDING = path.join(
  DEFAULT_ROOT,
  'artifacts/responsibility-full-backfill-20260729/coordinator/source-batch013-combined-v1/'
    + 'strict-remaining-source-pending-12330.jsonl',
);

function text(value) {
  return String(value ?? '').trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function arg(name, fallback = '') {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
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

function domain(value) {
  try {
    return new URL(text(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function productIdentity(row) {
  const [company = '', productName = ''] = text(rows(row.rawProducts)[0]).split('\u001f');
  return { company: text(company), productName: text(productName) };
}

function sourceStatus(row, sourceUrl, sourceDigest, artifactApproved) {
  if (row.evidence?.sourceDigestConflict) return 'version_conflict';
  if (artifactApproved && sourceUrl && sourceDigest) return 'ready';
  return 'pending';
}

function databaseStatus(row) {
  if (row.strict) return 'strict_aligned';
  return 'non_strict';
}

function laneFor(row, artifactApproved, dbStatus, srcStatus) {
  if (artifactApproved && dbStatus === 'strict_aligned' && srcStatus === 'ready') return 'FROZEN_COMPLETE';
  if (artifactApproved && dbStatus === 'strict_aligned') return 'SOURCE_EVIDENCE_RECONCILE';
  if (artifactApproved) return 'MATERIALIZER_459';
  if (row.strict) return 'HISTORICAL_ARTIFACT_7143';
  if (row.category === 'duplicate_or_orphan_card_cleanup') return 'INCOMPLETE_1080';
  if (row.category === 'other_blocked') return 'INCOMPLETE_1080';
  return 'SOURCE';
}

export function buildV2Ledger(alignment) {
  return rows(alignment.ledger).map((row) => {
    const { company, productName } = productIdentity(row);
    const artifactApproved = Number(row.evidence?.approvedArtifacts || 0) > 0;
    const sourceUrl = normalizeUrl(
      artifactApproved
        ? rows(row.artifactSourceUrls)[0] || rows(row.sourceUrls)[0]
        : rows(row.sourceUrls)[0],
    );
    const sourceDigest = normalizeDigest(
      artifactApproved
        ? rows(row.artifactSourceDigests)[0] || rows(row.sourceDigests)[0]
        : rows(row.sourceDigests)[0],
    );
    const artifactStatus = artifactApproved ? 'approved' : 'absent';
    const dbStatus = databaseStatus(row);
    const srcStatus = sourceStatus(row, sourceUrl, sourceDigest, artifactApproved);
    const lane = laneFor(row, artifactApproved, dbStatus, srcStatus);
    return {
      productKey: row.key,
      company,
      productName,
      normalizedCompanyProduct: `${normalizeIdentity(company)}\u001f${normalizeIdentity(productName)}`,
      sourceUrl,
      sourceDigest,
      sourceStatus: srcStatus,
      artifactStatus,
      databaseStatus: dbStatus,
      overallStatus: lane === 'FROZEN_COMPLETE' ? 'complete' : 'nonterminal',
      lane,
      manifestId: '',
      terminalStatus: lane === 'FROZEN_COMPLETE' ? 'strict_aligned' : '',
      cards: Number(row.cards || 0),
      indicators: Number(row.indicators || 0),
      alignmentCategory: row.category,
      receipts: [],
      evidence: row.evidence || {},
    };
  });
}

function countWhere(ledger, predicate) {
  return ledger.filter(predicate).length;
}

function summarize(ledger) {
  const group = (field) => Object.fromEntries(
    [...ledger.reduce((map, row) => {
      const key = text(row[field]) || 'none';
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map()).entries()].sort(),
  );
  const approvedStrict = countWhere(
    ledger,
    (row) => row.artifactStatus === 'approved' && row.databaseStatus === 'strict_aligned',
  );
  const approvedNonStrict = countWhere(
    ledger,
    (row) => row.artifactStatus === 'approved' && row.databaseStatus !== 'strict_aligned',
  );
  const strictArtifactAbsent = countWhere(
    ledger,
    (row) => row.artifactStatus === 'absent' && row.databaseStatus === 'strict_aligned',
  );
  const duplicateOrOrphan = countWhere(
    ledger,
    (row) => row.alignmentCategory === 'duplicate_or_orphan_card_cleanup',
  );
  const incompleteOneSided = countWhere(
    ledger,
    (row) => row.alignmentCategory === 'other_blocked',
  );
  const otherArtifactAbsent = countWhere(
    ledger,
    (row) => row.alignmentCategory === 'missing_approved_artifact',
  );
  const partition = [
    approvedStrict,
    approvedNonStrict,
    strictArtifactAbsent,
    duplicateOrOrphan,
    incompleteOneSided,
    otherArtifactAbsent,
  ];
  return {
    products: ledger.length,
    complete: countWhere(ledger, (row) => row.overallStatus === 'complete'),
    approvedStrict,
    approvedNonStrict,
    strictArtifactAbsent,
    duplicateOrOrphan,
    incompleteOneSided,
    otherArtifactAbsent,
    partition,
    partitionSum: partition.reduce((sum, value) => sum + value, 0),
    byDimension: {
      sourceStatus: group('sourceStatus'),
      artifactStatus: group('artifactStatus'),
      databaseStatus: group('databaseStatus'),
    },
  };
}

function dedupeSourcePending(input) {
  const seenDigest = new Set();
  const seenUrl = new Set();
  const seenName = new Set();
  const selected = [];
  const excluded = [];
  for (const row of input) {
    const digest = normalizeDigest(row.sourceDigest);
    const sourceUrl = normalizeUrl(row.sourceUrl);
    const nameKey = `${normalizeIdentity(row.company)}\u001f${normalizeIdentity(row.productName)}`;
    const duplicate = (digest && seenDigest.has(digest))
      || (sourceUrl && seenUrl.has(sourceUrl))
      || seenName.has(nameKey);
    const incrementalWholeLife = Boolean(row.marker?.incrementalWholeLifeNameHit);
    if (duplicate || incrementalWholeLife) {
      excluded.push({
        productKey: row.productKey,
        reason: incrementalWholeLife ? 'incremental_whole_life_isolated' : 'deduplicated',
      });
      continue;
    }
    if (digest) seenDigest.add(digest);
    if (sourceUrl) seenUrl.add(sourceUrl);
    seenName.add(nameKey);
    selected.push({ ...row, sourceUrl, sourceDigest: digest });
  }
  return { selected, excluded };
}

function sourceProduct(row, manifestId, manifestOrder) {
  return {
    ...row,
    manifestId,
    manifestOrder,
    officialDomain: domain(row.sourceUrl),
    sourceOnly: true,
    modelProviderAllowed: false,
    sqliteWriteAllowed: false,
    feishuWriteAllowed: false,
    publishAllowed: false,
    acquisitionLadder: [
      'official_cache',
      'company_catalog_api_static_pdf',
      'historical_url_migration',
      'aes_empty_password',
      'real_chrome',
      'company_cdp_crawler',
      'jrcpcx_exact',
      'source_blocked',
    ],
  };
}

function buildSourceManifests(sourceRows, outputDir) {
  const byDomain = new Map();
  for (const row of sourceRows) {
    const key = domain(row.sourceUrl) || '__no_domain__';
    const bucket = byDomain.get(key) || [];
    bucket.push(row);
    byDomain.set(key, bucket);
  }
  const domains = [...byDomain.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, values]) => [
      key,
      values.sort((left, right) => text(left.productKey).localeCompare(text(right.productKey))),
    ]);
  const windows = ['SOURCE-A', 'SOURCE-B', 'SOURCE-C'];
  const manifests = [];
  const selectedKeys = new Set();
  for (let batchIndex = 0; batchIndex < 6; batchIndex += 1) {
    const windowName = windows[batchIndex % windows.length];
    const sequence = Math.floor(batchIndex / windows.length) + 1;
    const manifestId = `${windowName.toLowerCase()}-batch-${String(sequence).padStart(3, '0')}`;
    const selected = (domains[batchIndex]?.[1] || []).slice(0, 100);
    for (const row of selected) selectedKeys.add(row.productKey);
    const products = selected.map((row, index) => sourceProduct(row, manifestId, index));
    const filePath = path.join(
      outputDir,
      'manifests/source',
      windowName.toLowerCase(),
      `manifest-${String(sequence).padStart(3, '0')}.json`,
    );
    writeJson(filePath, {
      schema: 'responsibility-full-backfill-source-manifest/v2',
      manifestId,
      window: windowName,
      sequence,
      selected: products.length,
      products,
    });
    manifests.push({
      manifestId,
      window: windowName,
      sequence,
      selected: products.length,
      path: filePath,
      sha256: sha256(filePath),
      domains: [...new Set(products.map((row) => row.officialDomain))],
    });
  }
  return {
    manifests,
    selected: sourceRows.filter((row) => selectedKeys.has(row.productKey)),
    remaining: sourceRows.filter((row) => !selectedKeys.has(row.productKey)),
  };
}

function collectHashes(rootDir) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.name !== 'sha256.json') files[path.relative(rootDir, filePath)] = sha256(filePath);
    }
  };
  walk(rootDir);
  return files;
}

export function run({
  alignmentPath,
  sourcePendingPath,
  outputDir,
}) {
  const alignment = readJson(alignmentPath);
  const ledger = buildV2Ledger(alignment);
  const counts = summarize(ledger);
  if (counts.products !== 30_592) throw new Error(`unexpected product count: ${counts.products}`);
  if (counts.partitionSum !== counts.products) {
    throw new Error(`v2 baseline partition mismatch: ${counts.partitionSum} != ${counts.products}`);
  }
  const productKeys = new Set(ledger.map((row) => row.productKey));
  if (productKeys.size !== ledger.length) throw new Error('duplicate productKey in v2 ledger');

  const dedupedSource = dedupeSourcePending(readJsonl(sourcePendingPath));
  const sourceWave = buildSourceManifests(dedupedSource.selected, outputDir);
  const selectedKeys = new Set(sourceWave.selected.map((row) => row.productKey));
  for (const row of ledger) {
    if (selectedKeys.has(row.productKey)) row.manifestId = 'source-first-wave-20260731';
  }

  const ledgerPath = path.join(outputDir, 'master-ledger.jsonl');
  writeJsonl(ledgerPath, ledger);
  const materializerQueue = ledger.filter(
    (row) => row.artifactStatus === 'approved' && row.databaseStatus !== 'strict_aligned',
  );
  const historicalArtifactQueue = ledger.filter(
    (row) => row.artifactStatus === 'absent' && row.databaseStatus === 'strict_aligned',
  );
  const incompleteQueue = ledger.filter(
    (row) => ['duplicate_or_orphan_card_cleanup', 'other_blocked'].includes(row.alignmentCategory),
  );
  writeJsonl(path.join(outputDir, 'queues/materializer-approved-nonstrict-459.jsonl'), materializerQueue);
  writeJsonl(path.join(outputDir, 'queues/historical-aligned-artifact-absent-7143.jsonl'), historicalArtifactQueue);
  writeJsonl(path.join(outputDir, 'queues/incomplete-card-indicator-1080.jsonl'), incompleteQueue);
  const sourceRemainingPath = path.join(outputDir, 'queues/source-pending-after-first-wave.jsonl');
  writeJsonl(sourceRemainingPath, sourceWave.remaining);
  const sourceExclusionsPath = path.join(outputDir, 'queues/source-first-wave-exclusions.jsonl');
  writeJsonl(sourceExclusionsPath, dedupedSource.excluded);

  const summary = {
    schema: 'responsibility-full-backfill-coordinator/v2',
    generatedAt: new Date().toISOString(),
    database: '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite',
    identityPrecedence: ['sourceDigest', 'sourceUrl', 'normalized company+productName'],
    dimensions: {
      sourceStatus: ['pending', 'ready', 'blocked', 'version_conflict', 'ocr_review'],
      artifactStatus: ['absent', 'parse_pending', 'validation_review', 'model_retry', 'approved'],
      databaseStatus: ['absent', 'non_strict', 'materializer_blocked', 'strict_aligned'],
    },
    completionRule: 'sourceStatus=ready AND artifactStatus=approved AND databaseStatus=strict_aligned',
    inputs: {
      alignmentPath,
      alignmentSha256: sha256(alignmentPath),
      sourcePendingPath,
      sourcePendingSha256: sha256(sourcePendingPath),
    },
    counts,
    dailyMetrics: {
      newSourceReady: 0,
      newInventoryReady: 0,
      newApproved: 0,
      newStrictAlignedImported: 0,
      newMaterializerBlocked: 0,
      remainingSourcePending: dedupedSource.selected.length,
      validatedProductsPerHour: 0,
    },
    deferredQueues: {
      materializerApprovedNonStrict: materializerQueue.length,
      historicalAlignedArtifactAbsent: historicalArtifactQueue.length,
      incompleteCardIndicator: incompleteQueue.length,
      executionGate: 'BUGFIX_GATE must pass before worker launch or SSD write',
    },
    sourceFirstWave: {
      input: readJsonl(sourcePendingPath).length,
      uniqueEligible: dedupedSource.selected.length,
      excluded: dedupedSource.excluded.length,
      selected: sourceWave.selected.length,
      remaining: sourceWave.remaining.length,
      manifests: sourceWave.manifests,
    },
    invariants: {
      productKeysUnique: true,
      baselinePartitionMutuallyExclusive: true,
      sourceManifestProductsMutuallyExclusive: true,
      incrementalWholeLifeExcluded: true,
      sqliteWritten: false,
      feishuWritten: false,
      published: false,
      workerCommunication: 'coordinator receipts only',
    },
  };
  const summaryPath = path.join(outputDir, 'summary.json');
  writeJson(summaryPath, summary);
  writeJson(path.join(outputDir, 'sha256.json'), { files: collectHashes(outputDir) });
  return { ledgerPath, summaryPath, summary };
}

function main() {
  const outputDir = arg('output-dir', DEFAULT_OUTPUT);
  const result = run({
    alignmentPath: arg('alignment', path.join(outputDir, 'baseline/alignment.json')),
    sourcePendingPath: arg('source-pending', DEFAULT_SOURCE_PENDING),
    outputDir,
  });
  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    ledgerPath: result.ledgerPath,
    summaryPath: result.summaryPath,
    counts: result.summary.counts,
    sourceFirstWave: result.summary.sourceFirstWave,
  }, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
