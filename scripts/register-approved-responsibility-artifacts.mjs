import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_VERSION = '2026-07-29-approved-artifact-backfill-v1';

function text(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function loadArtifact(filePath) {
  const resolvedPath = path.resolve(filePath);
  const artifact = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const sourceDigest = text(artifact.productIdentity?.sourceDigest || artifact.sourceDigest);
  const sourceUrl = text(artifact.productIdentity?.sourceUrl || artifact.sourceUrl);
  const responsibilities = Array.isArray(artifact.responsibilities) ? artifact.responsibilities : [];
  const issues = [];
  if (!text(artifact.company)) issues.push('missing_company');
  if (!text(artifact.productName)) issues.push('missing_productName');
  if (!/^sha256:[0-9a-f]{64}$/u.test(sourceDigest)) issues.push('invalid_sourceDigest');
  if (!sourceUrl) issues.push('missing_sourceUrl');
  if (!responsibilities.length) issues.push('empty_responsibilities');
  if (issues.length) throw new Error(`${resolvedPath}: ${issues.join(',')}`);
  return {
    path: resolvedPath,
    artifact,
    id: `responsibility_artifact_${sourceDigest.slice(7, 31)}`,
    company: text(artifact.company),
    productName: text(artifact.productName),
    sourceDigest,
    sourceUrl,
    responsibilityCount: responsibilities.length,
  };
}

function assertUnique(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.sourceDigest)) throw new Error(`duplicate sourceDigest: ${entry.sourceDigest}`);
    seen.add(entry.sourceDigest);
  }
}

function registerApprovedResponsibilityArtifacts({
  artifacts,
  dbPath,
  write = false,
  publisherVersion = DEFAULT_VERSION,
  now = new Date().toISOString(),
} = {}) {
  const entries = artifacts.map(loadArtifact);
  assertUnique(entries);
  const db = new DatabaseSync(path.resolve(dbPath), write ? {} : { readOnly: true });
  const inserted = [];
  const skipped = [];
  const conflicts = [];
  try {
    const byDigest = db.prepare(`
      SELECT id, company, product_name, source_digest, source_url, payload
        FROM product_responsibility_artifacts
       WHERE source_digest = ?
    `);
    const byId = db.prepare(`
      SELECT id, company, product_name, source_digest, source_url, payload
        FROM product_responsibility_artifacts
       WHERE id = ?
    `);
    for (const entry of entries) {
      const existing = byDigest.get(entry.sourceDigest) || byId.get(entry.id);
      if (!existing) continue;
      const same = existing.id === entry.id
        && existing.company === entry.company
        && existing.product_name === entry.productName
        && existing.source_digest === entry.sourceDigest
        && existing.source_url === entry.sourceUrl
        && existing.payload === JSON.stringify(entry.artifact);
      if (same) skipped.push(entry);
      else conflicts.push({ entry, existing });
    }
    if (conflicts.length) {
      return { dbPath: path.resolve(dbPath), dryRun: !write, ok: false, inserted, skipped, conflicts };
    }
    if (write && entries.length) {
      const insert = db.prepare(`
        INSERT INTO product_responsibility_artifacts
          (id, company, product_name, source_digest, source_url, published_at, publisher_version, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const entry of entries) {
          if (skipped.includes(entry)) continue;
          insert.run(entry.id, entry.company, entry.productName, entry.sourceDigest, entry.sourceUrl, now, publisherVersion, JSON.stringify(entry.artifact));
          inserted.push(entry);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return {
      dbPath: path.resolve(dbPath),
      dryRun: !write,
      ok: true,
      selected: entries.length,
      inserted: inserted.map((entry) => ({ ...entry, artifact: undefined })),
      skipped: skipped.map((entry) => ({ ...entry, artifact: undefined })),
      conflicts,
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const artifacts = readArg('artifacts').split(',').map((item) => item.trim()).filter(Boolean);
  const result = registerApprovedResponsibilityArtifacts({
    artifacts,
    dbPath: readArg('db-path'),
    write: hasFlag('write'),
    publisherVersion: readArg('publisher-version', DEFAULT_VERSION),
  });
  const receiptPath = readArg('receipt-path');
  if (receiptPath) fs.writeFileSync(path.resolve(receiptPath), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

export { registerApprovedResponsibilityArtifacts };
