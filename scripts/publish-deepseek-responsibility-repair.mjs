#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CANONICAL_REQUIRED_INPUTS,
  DEEPSEEK_REPAIR_VERSION,
  artifactSourceDigest,
  canonicalProductKey,
  digestJson,
} from '../server/deepseek-responsibility-repair.mjs';
import { importReviewedResponsibilityArtifacts } from './import-reviewed-responsibility-artifacts.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
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

function assertNewFile(filePath, label) {
  if (!filePath) throw new Error(`${label} path is required`);
  if (fs.existsSync(filePath)) throw new Error(`${label} already exists: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fileDigest(filePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function artifactTitles(artifact = {}) {
  return rows(artifact.responsibilities)
    .map((responsibility) => text(
      responsibility.card?.title
      || responsibility.liability
      || responsibility.officialTitle,
    ))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function canonicalInputIssues(value, location = '$', issues = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => canonicalInputIssues(item, `${location}[${index}]`, issues));
    return issues;
  }
  if (!value || typeof value !== 'object') return issues;
  if (Array.isArray(value.requiredInputs)) {
    value.requiredInputs.forEach((input, index) => {
      if (!CANONICAL_REQUIRED_INPUTS.has(text(input))) {
        issues.push(`${location}.requiredInputs[${index}]=${text(input)}`);
      }
    });
  }
  Object.entries(value).forEach(([key, item]) => canonicalInputIssues(item, `${location}.${key}`, issues));
  return issues;
}

function loadApprovedByProduct(registryPath) {
  const byProduct = new Map();
  for (const row of readJsonl(registryPath)) {
    const artifactPath = path.resolve(text(row.artifactPath));
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const company = text(row.company || artifact.company);
    const productName = text(row.productName || artifact.productName);
    byProduct.set(canonicalProductKey(company, productName), {
      artifact,
      artifactPath,
      sourceDigest: artifactSourceDigest(artifact),
    });
  }
  return byProduct;
}

function validateManifest({
  db,
  manifest,
  approvedRegistryPath,
}) {
  const approved = loadApprovedByProduct(approvedRegistryPath);
  const validated = [];
  const seenProducts = new Set();
  for (const entry of manifest) {
    if (entry.route !== 'deterministic_pass') {
      throw new Error(`Manifest contains non-deterministic route: ${entry.company} / ${entry.productName}`);
    }
    const productKey = canonicalProductKey(entry.company, entry.productName);
    if (seenProducts.has(productKey)) throw new Error(`Duplicate manifest product: ${entry.company} / ${entry.productName}`);
    seenProducts.add(productKey);
    const current = approved.get(productKey);
    if (!current) throw new Error(`Current approved product is missing: ${entry.company} / ${entry.productName}`);
    const artifactPath = path.resolve(text(entry.artifactPath));
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (text(artifact.artifactId) !== text(entry.artifactId)) {
      throw new Error(`Artifact ID mismatch: ${entry.company} / ${entry.productName}`);
    }
    if (text(artifact.repairAudit?.version) !== DEEPSEEK_REPAIR_VERSION) {
      throw new Error(`Repair version mismatch: ${entry.company} / ${entry.productName}`);
    }
    if (artifactSourceDigest(artifact) !== text(entry.sourceDigest)) {
      throw new Error(`Repair artifact source digest mismatch: ${entry.company} / ${entry.productName}`);
    }
    if (current.sourceDigest !== text(entry.sourceDigest)) {
      throw new Error(`Current approved source digest changed: ${entry.company} / ${entry.productName}`);
    }
    if (digestJson(current.artifact) !== text(entry.beforeDigest)) {
      throw new Error(`Current approved artifact changed: ${entry.company} / ${entry.productName}`);
    }
    const legacy = db.prepare(`
      SELECT id, source_digest
        FROM product_responsibility_artifacts
       WHERE id = ? AND publisher_version = '2026-07-23-unified-responsibility-artifact-v3'
    `).get(text(entry.legacyArtifactId));
    if (!legacy || text(legacy.source_digest) !== text(entry.sourceDigest)) {
      throw new Error(`Legacy source digest gate failed: ${entry.company} / ${entry.productName}`);
    }
    const inputIssues = canonicalInputIssues(artifact);
    if (inputIssues.length) {
      throw new Error(`Noncanonical requiredInputs: ${entry.company} / ${entry.productName}: ${inputIssues[0]}`);
    }
    if (rows(artifact.repairAudit?.invalidRuleRefs).length) {
      throw new Error(`Invalid rule references remain: ${entry.company} / ${entry.productName}`);
    }
    if (rows(artifact.repairAudit?.unsupportedNumericClaims).length) {
      throw new Error(`Unsupported numeric claims remain: ${entry.company} / ${entry.productName}`);
    }
    validated.push({ entry, artifact, artifactPath });
  }
  return validated;
}

function readbackProduct(db, artifact) {
  const company = text(artifact.company);
  const productName = text(artifact.productName);
  const expectedTitles = artifactTitles(artifact);
  const indicatorRows = db.prepare(`
    SELECT liability, payload
      FROM insurance_indicator_records
     WHERE company = ? AND product_name = ?
       AND json_extract(payload, '$.responsibilityRepairVersion') = ?
     ORDER BY liability, id
  `).all(company, productName, DEEPSEEK_REPAIR_VERSION);
  const cardRows = db.prepare(`
    SELECT title, payload
      FROM product_responsibility_cards
     WHERE company = ? AND product_name = ?
     ORDER BY title, id
  `).all(company, productName);
  const indicatorTitles = indicatorRows.map((row) => text(row.liability))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const cardTitles = cardRows.map((row) => text(row.title))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const indicatorProvenanceIssues = indicatorRows.filter((row) => {
    const payload = JSON.parse(row.payload);
    return text(payload.responsibilityArtifactId) !== text(artifact.artifactId)
      || text(payload.responsibilitySourceDigest) !== artifactSourceDigest(artifact);
  }).length;
  const cardProvenanceIssues = cardRows.filter((row) => {
    const payload = JSON.parse(row.payload);
    return !rows(payload.indicators).some((indicator) => (
      text(indicator.responsibilityArtifactId) === text(artifact.artifactId)
      && text(indicator.responsibilityRepairVersion) === DEEPSEEK_REPAIR_VERSION
      && text(indicator.responsibilitySourceDigest) === artifactSourceDigest(artifact)
    ));
  }).length;
  return {
    company,
    productName,
    artifactId: text(artifact.artifactId),
    expectedTitles,
    indicatorTitles,
    cardTitles,
    indicatorProvenanceIssues,
    cardProvenanceIssues,
    passed: JSON.stringify(expectedTitles) === JSON.stringify(indicatorTitles)
      && JSON.stringify(expectedTitles) === JSON.stringify(cardTitles)
      && indicatorProvenanceIssues === 0
      && cardProvenanceIssues === 0,
  };
}

function insertArtifacts(db, validated, now) {
  const insert = db.prepare(`
    INSERT INTO product_responsibility_artifacts (
      id, company, product_name, source_digest, source_url,
      published_at, publisher_version, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { artifact } of validated) {
      insert.run(
        text(artifact.artifactId),
        text(artifact.company),
        text(artifact.productName),
        artifactSourceDigest(artifact),
        text(artifact.productIdentity?.sourceUrl || artifact.sourceUrl),
        now,
        DEEPSEEK_REPAIR_VERSION,
        JSON.stringify(artifact),
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function publishDeepSeekRepair({
  dbPath,
  manifestPath,
  baselinePath,
  approvedRegistryPath,
  backupPath,
  receiptPath,
  skipBackup = false,
  now = new Date().toISOString(),
} = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedManifestPath = path.resolve(manifestPath);
  const resolvedBaselinePath = path.resolve(baselinePath);
  const resolvedApprovedRegistryPath = path.resolve(approvedRegistryPath);
  const resolvedReceiptPath = path.resolve(receiptPath);
  const resolvedBackupPath = backupPath ? path.resolve(backupPath) : '';
  assertNewFile(resolvedReceiptPath, 'Receipt');
  if (!skipBackup) assertNewFile(resolvedBackupPath, 'Backup');

  const baseline = JSON.parse(fs.readFileSync(resolvedBaselinePath, 'utf8'));
  if (text(baseline.approvedRegistryDigest) !== fileDigest(resolvedApprovedRegistryPath)) {
    throw new Error('Approved registry changed after pilot generation');
  }
  if (baseline.counts?.legacyArtifacts !== 4059 || baseline.counts?.currentApproved !== 4997) {
    throw new Error('Baseline counts are not the approved DeepSeek repair snapshot');
  }

  const manifest = readJsonl(resolvedManifestPath);
  if (!manifest.length || manifest.length > 50) throw new Error(`Invalid pilot manifest size: ${manifest.length}`);
  let db = new DatabaseSync(resolvedDbPath);
  try {
    const validated = validateManifest({
      db,
      manifest,
      approvedRegistryPath: resolvedApprovedRegistryPath,
    });
    const dryRun = importReviewedResponsibilityArtifacts({
      artifacts: [resolvedManifestPath],
      dbPath: resolvedDbPath,
      write: false,
      sampleLimit: 50,
      now,
    });
    if (!dryRun.ok || dryRun.validationIssueCount !== 0) {
      throw new Error(`Importer dry-run failed with ${dryRun.validationIssueCount} issues`);
    }
    if (!skipBackup) db.prepare('VACUUM INTO ?').run(resolvedBackupPath);
    db.close();
    db = null;

    const importResult = importReviewedResponsibilityArtifacts({
      artifacts: [resolvedManifestPath],
      dbPath: resolvedDbPath,
      write: true,
      sampleLimit: 50,
      now,
    });
    if (!importResult.ok || importResult.validationIssueCount !== 0) {
      throw new Error(`Importer write failed with ${importResult.validationIssueCount} issues`);
    }

    const writeDb = new DatabaseSync(resolvedDbPath);
    try {
      const readbackBeforeArtifactInsert = validated.map(({ artifact }) => readbackProduct(writeDb, artifact));
      const failures = readbackBeforeArtifactInsert.filter((result) => !result.passed);
      if (failures.length) {
        throw new Error(`Exact readback failed for ${failures.length} products; restore the batch backup`);
      }
      insertArtifacts(writeDb, validated, now);
      const insertedArtifacts = writeDb.prepare(`
        SELECT COUNT(*) AS count
          FROM product_responsibility_artifacts
         WHERE publisher_version = ?
           AND id IN (${validated.map(() => '?').join(',')})
      `).get(DEEPSEEK_REPAIR_VERSION, ...validated.map(({ artifact }) => artifact.artifactId)).count;
      const quickCheck = writeDb.prepare('PRAGMA quick_check').get();
      const receipt = {
        generatedAt: now,
        repairVersion: DEEPSEEK_REPAIR_VERSION,
        dbPath: resolvedDbPath,
        backupPath: skipBackup ? 'skipped_for_copy_rehearsal' : resolvedBackupPath,
        manifestPath: resolvedManifestPath,
        baselinePath: resolvedBaselinePath,
        products: validated.length,
        insertedArtifacts: Number(insertedArtifacts),
        dryRun,
        importResult,
        readback: readbackBeforeArtifactInsert,
        quickCheck: Object.values(quickCheck)[0],
      };
      fs.writeFileSync(resolvedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      return receipt;
    } finally {
      writeDb.close();
    }
  } finally {
    if (db) db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const receipt = await publishDeepSeekRepair({
    dbPath: readArg('db-path', '.runtime/local/policy-ocr.sqlite'),
    manifestPath: readArg('manifest'),
    baselinePath: readArg('baseline'),
    approvedRegistryPath: readArg(
      'approved-registry',
      'artifacts/responsibility-approved-all4997-import-20260726/all-4997-registry.jsonl',
    ),
    backupPath: readArg('backup-path'),
    receiptPath: readArg('receipt-path'),
    skipBackup: hasFlag('skip-backup'),
  });
  console.log(JSON.stringify({
    products: receipt.products,
    insertedArtifacts: receipt.insertedArtifacts,
    materializedCards: receipt.importResult.materializedCards,
    quickCheck: receipt.quickCheck,
    backupPath: receipt.backupPath,
  }, null, 2));
}
