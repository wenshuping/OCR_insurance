#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DEEPSEEK_REPAIR_VERSION,
  artifactSourceDigest,
  canonicalProductKey,
  digestJson,
  isLegacyCalculationEnabled,
  repairDeepSeekArtifact,
} from '../server/deepseek-responsibility-repair.mjs';

const DEFAULT_DB_PATH = path.resolve('.runtime/local/policy-ocr.sqlite');
const DEFAULT_APPROVED_REGISTRY = path.resolve(
  'artifacts/responsibility-approved-all4997-import-20260726/all-4997-registry.jsonl',
);

function text(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.writeFileSync(filePath, values.map((value) => JSON.stringify(value)).join('\n') + '\n');
}

function fileDigest(filePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function loadApprovedRegistry(registryPath) {
  const rows = readJsonl(registryPath);
  const byProduct = new Map();
  for (const row of rows) {
    const artifactPath = path.resolve(text(row.artifactPath));
    if (!artifactPath || !fs.existsSync(artifactPath)) {
      throw new Error(`Approved artifact is missing: ${artifactPath || '(blank)'}`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const company = text(row.company || artifact.company);
    const productName = text(row.productName || artifact.productName);
    const key = canonicalProductKey(company, productName);
    if (byProduct.has(key)) throw new Error(`Duplicate approved identity: ${company} / ${productName}`);
    byProduct.set(key, {
      ...row,
      company,
      productName,
      artifactPath,
      artifact,
      sourceDigest: artifactSourceDigest(artifact),
    });
  }
  return { rows, byProduct };
}

function createOutputDir(outputDir) {
  if (!outputDir) throw new Error('--output-dir is required unless --audit-only is used');
  const resolved = path.resolve(outputDir);
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length) {
    throw new Error(`Output directory is not empty: ${resolved}`);
  }
  fs.mkdirSync(path.join(resolved, 'products'), { recursive: true });
  return resolved;
}

function safeName(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80) || 'product';
}

function aggregateRoutes(receipts) {
  const counts = {};
  for (const receipt of receipts) counts[receipt.route] = (counts[receipt.route] || 0) + 1;
  return counts;
}

function pilotSelection(records, pilotSize) {
  const sameSource = records.filter((record) => record.cohort === 'same_source');
  const highRisk = sameSource.filter((record) => record.legacyCalculationEnabled);
  const selected = [];
  const selectedKeys = new Set();
  const add = (record) => {
    if (!record || selected.length >= pilotSize || selectedKeys.has(record.key)) return;
    selected.push(record);
    selectedKeys.add(record.key);
  };
  highRisk.forEach(add);

  const buckets = new Map();
  for (const record of sameSource) {
    if (!buckets.has(record.riskSignature)) buckets.set(record.riskSignature, []);
    buckets.get(record.riskSignature).push(record);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => (
      `${left.company}\u001f${left.productName}`.localeCompare(
        `${right.company}\u001f${right.productName}`,
        'zh-CN',
      )
    ));
  }
  const orderedBuckets = [...buckets.values()].sort((left, right) => right.length - left.length);
  while (selected.length < pilotSize) {
    let progressed = false;
    for (const bucket of orderedBuckets) {
      const record = bucket.shift();
      if (!record) continue;
      add(record);
      progressed = true;
      if (selected.length >= pilotSize) break;
    }
    if (!progressed) break;
  }
  return selected;
}

function riskSignature(artifact = {}) {
  let responsibilities = 0;
  let branches = 0;
  let rules = Array.isArray(artifact.productRules) ? artifact.productRules.length : 0;
  let optionalGroups = Array.isArray(artifact.optionalGroups) ? artifact.optionalGroups.length : 0;
  let tables = 0;
  for (const responsibility of artifact.responsibilities || []) {
    responsibilities += 1;
    for (const indicator of responsibility.indicators || []) {
      branches += Array.isArray(indicator.branches) ? indicator.branches.length : 0;
      if (/表|计划|档|等级|附录|附表/u.test([
        indicator.formulaText,
        indicator.calculationReason,
      ].filter(Boolean).join(' '))) tables += 1;
    }
  }
  return [
    responsibilities >= 10 ? 'many_responsibilities' : 'normal_responsibilities',
    branches >= 6 ? 'many_branches' : 'normal_branches',
    rules ? 'shared_rules' : 'no_shared_rules',
    optionalGroups ? 'optional_groups' : 'no_optional_groups',
    tables ? 'table_signals' : 'no_table_signals',
  ].join('|');
}

export function runDeepSeekRepair({
  dbPath = DEFAULT_DB_PATH,
  approvedRegistryPath = DEFAULT_APPROVED_REGISTRY,
  outputDir = '',
  pilotSize = 50,
  auditOnly = false,
  now = new Date().toISOString(),
} = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedRegistryPath = path.resolve(approvedRegistryPath);
  const approved = loadApprovedRegistry(resolvedRegistryPath);
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  const records = [];
  const legacyOnly = [];
  const versionConflicts = [];
  let legacyCount = 0;
  let overlapCount = 0;
  let sameSourceCount = 0;
  try {
    const statement = db.prepare(`
      SELECT id, company, product_name, source_digest, publisher_version, payload
        FROM product_responsibility_artifacts
       WHERE publisher_version = '2026-07-23-unified-responsibility-artifact-v3'
       ORDER BY company, product_name, id
    `);
    for (const row of statement.iterate()) {
      legacyCount += 1;
      const legacyArtifact = JSON.parse(row.payload);
      const key = canonicalProductKey(row.company, row.product_name);
      const current = approved.byProduct.get(key);
      if (!current) {
        const record = {
          key,
          cohort: 'legacy_only',
          legacyArtifactId: row.id,
          company: row.company,
          productName: row.product_name,
          legacySourceDigest: text(row.source_digest),
          currentSourceDigest: '',
          legacyCalculationEnabled: isLegacyCalculationEnabled(legacyArtifact),
          riskSignature: riskSignature(legacyArtifact),
        };
        records.push(record);
        legacyOnly.push(record);
        continue;
      }
      overlapCount += 1;
      const currentDigest = text(current.sourceDigest);
      const sameSource = text(row.source_digest) === currentDigest;
      const record = {
        key,
        cohort: sameSource ? 'same_source' : 'version_conflict',
        legacyArtifactId: row.id,
        company: row.company,
        productName: row.product_name,
        legacySourceDigest: text(row.source_digest),
        currentSourceDigest: currentDigest,
        currentArtifactPath: current.artifactPath,
        legacyCalculationEnabled: isLegacyCalculationEnabled(legacyArtifact),
        riskSignature: riskSignature(current.artifact),
        legacyArtifact,
        currentArtifact: current.artifact,
      };
      records.push(record);
      if (sameSource) sameSourceCount += 1;
      else versionConflicts.push(record);
    }
  } finally {
    db.close();
  }

  const baseline = {
    repairVersion: DEEPSEEK_REPAIR_VERSION,
    generatedAt: now,
    dbPath: resolvedDbPath,
    dbDigest: fileDigest(resolvedDbPath),
    approvedRegistryPath: resolvedRegistryPath,
    approvedRegistryDigest: fileDigest(resolvedRegistryPath),
    counts: {
      legacyArtifacts: legacyCount,
      currentApproved: approved.rows.length,
      overlap: overlapCount,
      legacyOnly: legacyOnly.length,
      sameSource: sameSourceCount,
      versionConflict: versionConflicts.length,
      currentApprovedWithoutSourceDigest: [...approved.byProduct.values()]
        .filter((record) => !record.sourceDigest).length,
    },
  };
  const expected = { legacyArtifacts: 4059, currentApproved: 4997, overlap: 3759, legacyOnly: 300 };
  for (const [field, value] of Object.entries(expected)) {
    if (baseline.counts[field] !== value) {
      throw new Error(`Baseline assertion failed for ${field}: expected ${value}, got ${baseline.counts[field]}`);
    }
  }
  if (auditOnly) return { baseline, records, versionConflicts, legacyOnly };

  const resolvedOutputDir = createOutputDir(outputDir);
  const selected = pilotSelection(records, Math.max(1, Math.min(50, Number(pilotSize) || 50)));
  const receipts = [];
  const manifest = [];
  for (const record of selected) {
    const repaired = repairDeepSeekArtifact({
      legacyArtifact: record.legacyArtifact,
      authoritativeArtifact: record.currentArtifact,
      legacyArtifactId: record.legacyArtifactId,
      authority: 'current_approved_same_source',
      now,
    });
    const productDir = path.join(
      resolvedOutputDir,
      'products',
      `${safeName(record.company)}-${safeName(record.productName)}-${repaired.receipt.artifactId.slice(-8)}`,
    );
    fs.mkdirSync(productDir, { recursive: false });
    const artifactPath = path.join(productDir, 'artifact.json');
    const receiptPath = path.join(productDir, 'repair-receipt.json');
    writeJson(artifactPath, repaired.artifact);
    writeJson(receiptPath, repaired.receipt);
    receipts.push(repaired.receipt);
    manifest.push({
      company: record.company,
      productName: record.productName,
      sourceDigest: record.currentSourceDigest,
      legacyArtifactId: record.legacyArtifactId,
      artifactId: repaired.receipt.artifactId,
      artifactPath,
      receiptPath,
      responsibilityCount: repaired.receipt.metrics.responsibilityCount,
      route: repaired.receipt.route,
      legacyCalculationEnabled: record.legacyCalculationEnabled,
      beforeDigest: repaired.receipt.beforeDigest,
      afterDigest: repaired.receipt.afterDigest,
    });
  }

  const serializableRecords = records.map(({ legacyArtifact, currentArtifact, ...record }) => record);
  writeJson(path.join(resolvedOutputDir, 'baseline-audit.json'), baseline);
  writeJsonl(path.join(resolvedOutputDir, 'cohort-audit.jsonl'), serializableRecords);
  writeJsonl(
    path.join(resolvedOutputDir, 'version-conflicts.jsonl'),
    versionConflicts.map(({ legacyArtifact, currentArtifact, ...record }) => record),
  );
  writeJsonl(path.join(resolvedOutputDir, 'pilot-manifest.jsonl'), manifest);
  writeJsonl(
    path.join(resolvedOutputDir, 'ready-for-import.jsonl'),
    manifest.filter((record) => record.route === 'deterministic_pass'),
  );
  writeJsonl(
    path.join(resolvedOutputDir, 'gemini-required.jsonl'),
    manifest.filter((record) => record.route === 'gemini_required'),
  );
  writeJson(path.join(resolvedOutputDir, 'pilot-receipts.json'), receipts);
  const summary = {
    ...baseline,
    outputDir: resolvedOutputDir,
    pilot: {
      selected: manifest.length,
      highRiskSelected: manifest.filter((record) => record.legacyCalculationEnabled).length,
      routes: aggregateRoutes(receipts),
      manifestPath: path.join(resolvedOutputDir, 'pilot-manifest.jsonl'),
    },
  };
  writeJson(path.join(resolvedOutputDir, 'summary.json'), summary);
  return { baseline, summary, manifest, receipts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runDeepSeekRepair({
    dbPath: readArg('db-path', DEFAULT_DB_PATH),
    approvedRegistryPath: readArg('approved-registry', DEFAULT_APPROVED_REGISTRY),
    outputDir: readArg('output-dir'),
    pilotSize: Number(readArg('pilot-size', '50')),
    auditOnly: hasFlag('audit-only'),
  });
  const printable = result.summary || {
    baseline: result.baseline,
    versionConflicts: result.versionConflicts.length,
    legacyOnly: result.legacyOnly.length,
  };
  console.log(JSON.stringify(printable, null, 2));
}
