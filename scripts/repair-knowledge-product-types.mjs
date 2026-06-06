#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeKnowledgeProductType } from '../server/policy-knowledge.service.mjs';

function trim(value) {
  return String(value || '').trim();
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { value, valid: true };
  }
  if (typeof value !== 'string') {
    return { value: {}, valid: false };
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: {}, valid: false };
    }
    return { value: parsed, valid: true };
  } catch {
    return { value: {}, valid: false };
  }
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function semanticJson(value) {
  return JSON.stringify(value);
}

export function repairKnowledgeProductTypes(dbPath, { dryRun = true } = {}) {
  if (!dbPath) throw new Error('dbPath is required');
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  try {
    if (!tableExists(db, 'knowledge_records')) {
      return { dryRun: Boolean(dryRun), scanned: 0, updated: 0, skippedInvalidJson: 0, missingTable: true };
    }

    db.exec('BEGIN IMMEDIATE');
    const rows = db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records').all();
    const update = db.prepare('UPDATE knowledge_records SET payload = ?, company = ?, product_name = ?, url = ? WHERE id = ?');
    const summary = {
      dryRun: Boolean(dryRun),
      scanned: rows.length,
      updated: 0,
      skippedInvalidJson: 0,
      missingTable: false,
      byType: {},
    };

    for (const row of rows) {
      const parsed = parseJson(row.payload);
      if (!parsed.valid) {
        summary.skippedInvalidJson += 1;
        continue;
      }

      const payload = parsed.value;
      const next = {
        ...payload,
        company: trim(payload.company || row.company),
        productName: trim(payload.productName || payload.name || row.product_name),
        url: trim(payload.url || row.url),
      };
      const nextType = normalizeKnowledgeProductType(next);
      if (nextType) next.productType = nextType;
      else delete next.productType;

      if (semanticJson(payload) === semanticJson(next)) continue;

      summary.updated += 1;
      summary.byType[nextType || '(empty)'] = Number(summary.byType[nextType || '(empty)'] || 0) + 1;
      if (!dryRun) {
        update.run(
          JSON.stringify(next),
          trim(next.company || row.company),
          trim(next.productName || row.product_name),
          trim(next.url || row.url),
          row.id,
        );
      }
    }

    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return summary;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep original error.
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
  console.error('Usage: node scripts/repair-knowledge-product-types.mjs --db <path> [--write]');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = readArg('db');
  if (!dbPath) printUsageAndExit();
  const dryRun = !hasFlag('write');
  const summary = repairKnowledgeProductTypes(path.resolve(dbPath), { dryRun });
  console.log(JSON.stringify(summary, null, 2));
}
