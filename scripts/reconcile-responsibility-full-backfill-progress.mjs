#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
    const parsed = new URL(text(value));
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readRecords(filePath) {
  return filePath.endsWith('.jsonl') ? readJsonl(filePath) : readJson(filePath);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function addIndex(map, key, row) {
  if (!key) return;
  const values = map.get(key) || [];
  values.push(row);
  map.set(key, values);
}

function buildIndex(ledger) {
  const index = {
    byKey: new Map(),
    byDigest: new Map(),
    byUrl: new Map(),
    byName: new Map(),
  };
  for (const row of ledger) {
    index.byKey.set(text(row.productKey), row);
    addIndex(index.byDigest, normalizeDigest(row.sourceDigest), row);
    addIndex(index.byUrl, normalizeUrl(row.sourceUrl), row);
    addIndex(
      index.byName,
      `${normalizeIdentity(row.company)}\u001f${normalizeIdentity(row.productName)}`,
      row,
    );
  }
  return index;
}

function disambiguate(candidates, event) {
  if (!candidates.length) return null;
  const productName = normalizeIdentity(event.productName);
  const company = normalizeIdentity(event.company);
  let filtered = candidates;
  if (productName) {
    filtered = filtered.filter((row) => normalizeIdentity(row.productName) === productName);
  }
  if (filtered.length > 1 && company) {
    filtered = filtered.filter((row) => normalizeIdentity(row.company) === company);
  }
  return filtered.length === 1 ? filtered[0] : null;
}

export function matchProgressEvent(event, index) {
  const productKey = text(event.productKey);
  if (productKey && index.byKey.has(productKey)) return index.byKey.get(productKey);
  const digest = normalizeDigest(event.sourceDigest || event.productIdentity?.sourceDigest);
  if (digest) {
    const matched = disambiguate(index.byDigest.get(digest) || [], event);
    if (matched) return matched;
  }
  const sourceUrl = normalizeUrl(event.sourceUrl || event.productIdentity?.sourceUrl);
  if (sourceUrl) {
    const matched = disambiguate(index.byUrl.get(sourceUrl) || [], event);
    if (matched) return matched;
  }
  const nameKey = `${normalizeIdentity(event.company)}\u001f${normalizeIdentity(event.productName)}`;
  return disambiguate(index.byName.get(nameKey) || [], event);
}

function summarize(ledger) {
  const countBy = (field) => Object.fromEntries(
    [...ledger.reduce((counts, row) => {
      const value = text(row[field]) || 'none';
      counts.set(value, (counts.get(value) || 0) + 1);
      return counts;
    }, new Map()).entries()].sort(),
  );
  return {
    products: ledger.length,
    byState: countBy('state'),
    byLane: countBy('lane'),
    sourceReady: ledger.filter((row) => row.sourceStatus === 'source_ready').length,
    strictAlignedOrImported: ledger.filter(
      (row) => row.state === 'strict_aligned' || row.state === 'imported',
    ).length,
    nonTerminal: ledger.filter(
      (row) => ![
        'strict_aligned',
        'source_blocked',
        'version_conflict',
        'materializer_blocked',
        'manual_review',
        'imported',
      ].includes(row.state),
    ).length,
  };
}

export function applyProgressEvents(baseLedger, groups) {
  const ledger = baseLedger.map((row) => ({
    ...row,
    receipts: Array.isArray(row.receipts) ? [...row.receipts] : [],
  }));
  const index = buildIndex(ledger);
  const claimed = new Set();
  const audit = [];
  for (const group of groups) {
    let matched = 0;
    const unmatched = [];
    const excluded = [];
    for (const record of group.records) {
      const event = {
        ...record,
        sourceDigest: record.sourceDigest || record.productIdentity?.sourceDigest,
        sourceUrl: record.sourceUrl || record.productIdentity?.sourceUrl,
        state: text(record.state || group.state),
        lane: text(group.laneOverride || record.lane || group.lane),
        terminalStatus: text(record.terminalStatus || group.terminalStatus),
        databaseStatus: text(record.databaseStatus || group.databaseStatus),
        artifactStatus: text(record.artifactStatus || group.artifactStatus),
        providerRoute: text(record.providerRoute || group.providerRoute),
        manifestId: text(record.manifestId || group.manifestId),
      };
      if (!ALLOWED_STATES.has(event.state)) {
        throw new Error(`invalid event state ${event.state} in ${group.label}`);
      }
      const row = matchProgressEvent(event, index);
      if (!row) {
        unmatched.push({
          productKey: text(event.productKey),
          company: text(event.company),
          productName: text(event.productName),
          sourceDigest: normalizeDigest(event.sourceDigest),
          sourceUrl: normalizeUrl(event.sourceUrl),
        });
        continue;
      }
      if (claimed.has(row.productKey)) {
        throw new Error(`progress event overlap for ${row.productKey}`);
      }
      claimed.add(row.productKey);
      if (
        ['strict_aligned', 'imported'].includes(row.state)
        && !['strict_aligned', 'imported'].includes(event.state)
      ) {
        excluded.push({ productKey: row.productKey, reason: `protected_${row.state}` });
        continue;
      }
      row.state = event.state;
      if (event.lane) row.lane = event.lane;
      if (event.terminalStatus) row.terminalStatus = event.terminalStatus;
      if (event.databaseStatus) row.databaseStatus = event.databaseStatus;
      for (const field of [
        'sourceStatus',
        'sourceUrl',
        'sourceDigest',
        'sourceFile',
        'sourceTextFile',
        'sourceContract',
        'artifactPath',
        'artifactStatus',
        'providerRoute',
        'manifestId',
      ]) {
        if (text(event[field])) row[field] = event[field];
      }
      row.receipts.push({
        type: text(group.label),
        path: text(group.path),
      });
      matched += 1;
    }
    audit.push({
      label: group.label,
      path: group.path,
      input: group.records.length,
      matched,
      unmatched,
      excluded,
    });
  }
  return { ledger, audit, counts: summarize(ledger) };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`);
}

function main() {
  const masterPath = arg('master');
  const eventsConfigPath = arg('events-config');
  const outputDir = arg('output-dir');
  if (!masterPath || !eventsConfigPath || !outputDir) {
    throw new Error('--master, --events-config and --output-dir are required');
  }
  const baseLedger = readJsonl(masterPath);
  const config = readJson(eventsConfigPath);
  if (!Array.isArray(config)) throw new Error('events config must be a JSON array');
  const groups = config.map((entry) => ({
    ...entry,
    records: readRecords(entry.path),
  }));
  const result = applyProgressEvents(baseLedger, groups);
  if (result.ledger.length !== baseLedger.length) throw new Error('ledger product count changed');
  if (new Set(result.ledger.map((row) => row.productKey)).size !== result.ledger.length) {
    throw new Error('ledger product keys are not unique');
  }
  const ledgerPath = path.join(outputDir, 'master-ledger.jsonl');
  const summaryPath = path.join(outputDir, 'summary.json');
  writeJsonl(ledgerPath, result.ledger);
  writeJson(summaryPath, {
    schema: 'responsibility-full-backfill-progress/v1',
    generatedAt: new Date().toISOString(),
    baseMasterPath: masterPath,
    baseMasterSha256: sha256(masterPath),
    eventsConfigPath,
    eventsConfigSha256: sha256(eventsConfigPath),
    dedupePrecedence: ['sourceDigest', 'sourceUrl', 'normalized company+productName'],
    eventAudit: result.audit,
    counts: result.counts,
    invariants: {
      productsExact: result.ledger.length === baseLedger.length,
      productKeysUnique: true,
      eventIntersectionsZero: true,
    },
  });
  writeJson(path.join(outputDir, 'sha256.json'), {
    files: {
      'master-ledger.jsonl': sha256(ledgerPath),
      'summary.json': sha256(summaryPath),
    },
  });
  process.stdout.write(`${JSON.stringify(result.counts)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
