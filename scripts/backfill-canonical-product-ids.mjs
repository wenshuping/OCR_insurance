#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalProductIdFromOfficialProduct } from '../server/canonical-product-id.mjs';

function parseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { value, valid: true };
  }
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: {}, valid: false };
    }
    return { value: parsed, valid: true };
  } catch {
    return { value: {}, valid: false };
  }
}

function stringify(value) {
  return JSON.stringify(value);
}

function trim(value) {
  return String(value || '').trim();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function semanticJson(value) {
  return stringify(value);
}

function backfillPlan(plan = {}, fallbackCompany = '') {
  const productName = trim(plan.matchedProductName || plan.productName || plan.name);
  const canonicalProductId = trim(plan.canonicalProductId)
    || canonicalProductIdFromOfficialProduct({
      company: trim(plan.company || fallbackCompany),
      productName,
    });
  return canonicalProductId ? { ...plan, canonicalProductId } : { ...plan };
}

export function backfillCanonicalProductIdsInObject(input = {}) {
  const record = { ...input };
  const company = trim(record.company);
  if (!trim(record.canonicalProductId)) {
    const productName = trim(record.productName || record.product_name || record.matchedProductName || record.name);
    const id = canonicalProductIdFromOfficialProduct({ company, productName });
    if (id) record.canonicalProductId = id;
  }
  if (Array.isArray(record.plans)) {
    record.plans = record.plans.map((plan) => backfillPlan(plan, company));
    const primary = record.plans.find((plan) => plan.role === 'main') || record.plans[0];
    if (!trim(record.canonicalProductId) && primary?.canonicalProductId) {
      record.canonicalProductId = primary.canonicalProductId;
    }
  }
  return record;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function updatePayloadTable(db, tableName, idColumn = 'id', dryRun = true) {
  if (!tableExists(db, tableName)) {
    return { scanned: 0, updated: 0, skippedInvalidJson: 0, missingTable: true };
  }

  const rows = db.prepare(`
    SELECT ${idColumn} AS id, company, product_name, payload
    FROM ${tableName}
  `).all();
  const update = db.prepare(`UPDATE ${tableName} SET payload = ? WHERE ${idColumn} = ?`);
  const summary = { scanned: rows.length, updated: 0, skippedInvalidJson: 0, missingTable: false };

  for (const row of rows) {
    const parsed = parseJson(row.payload);
    if (!parsed.valid) {
      summary.skippedInvalidJson += 1;
      continue;
    }
    const payload = parsed.value;

    const hadCompany = hasOwn(payload, 'company');
    const hadProductName = hasOwn(payload, 'productName');
    const fallbackCompany = trim(payload.company || row.company);
    const fallbackProductName = trim(payload.productName || payload.product_name || row.product_name);
    const candidate = {
      ...payload,
      company: fallbackCompany,
      productName: fallbackProductName,
    };
    const next = backfillCanonicalProductIdsInObject(candidate);
    if (!hadCompany) delete next.company;
    if (!hadProductName) delete next.productName;

    if (semanticJson(payload) === semanticJson(next)) continue;
    summary.updated += 1;
    if (!dryRun) update.run(stringify(next), row.id);
  }

  return summary;
}

function updatePolicies(db, dryRun = true) {
  if (!tableExists(db, 'policies')) {
    return { scanned: 0, updated: 0, skippedInvalidJson: 0, missingTable: true };
  }

  const rows = db.prepare('SELECT id, company, name, payload FROM policies').all();
  const update = db.prepare('UPDATE policies SET payload = ? WHERE id = ?');
  const summary = { scanned: rows.length, updated: 0, skippedInvalidJson: 0, missingTable: false };

  for (const row of rows) {
    const parsed = parseJson(row.payload);
    if (!parsed.valid) {
      summary.skippedInvalidJson += 1;
      continue;
    }
    const payload = parsed.value;

    const hadCompany = hasOwn(payload, 'company');
    const hadName = hasOwn(payload, 'name');
    const candidate = {
      ...payload,
      company: trim(payload.company || row.company),
      name: trim(payload.name || row.name),
    };
    const next = backfillCanonicalProductIdsInObject(candidate);
    if (!hadCompany) delete next.company;
    if (!hadName) delete next.name;

    if (semanticJson(payload) === semanticJson(next)) continue;
    summary.updated += 1;
    if (!dryRun) update.run(stringify(next), row.id);
  }

  return summary;
}

export function backfillDatabase(dbPath, { dryRun = true } = {}) {
  if (!dbPath) throw new Error('dbPath is required');
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const summary = {
      dryRun: Boolean(dryRun),
      knowledgeRecords: updatePayloadTable(db, 'knowledge_records', 'id', dryRun),
      insuranceIndicatorRecords: updatePayloadTable(db, 'insurance_indicator_records', 'id', dryRun),
      optionalResponsibilityRecords: updatePayloadTable(db, 'optional_responsibility_records', 'id', dryRun),
      policies: updatePolicies(db, dryRun),
    };
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return summary;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failures so the original error is preserved.
    }
    throw error;
  } finally {
    db.close();
  }
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

function printUsageAndExit() {
  console.error('Usage: node scripts/backfill-canonical-product-ids.mjs --db <path> [--write]');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = readArg('db');
  if (!dbPath) printUsageAndExit();
  const dryRun = !hasFlag('write');
  const summary = backfillDatabase(path.resolve(dbPath), { dryRun });
  console.log(JSON.stringify(summary, null, 2));
}
