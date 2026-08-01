#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = '.runtime/local/policy-ocr.sqlite';

function text(value) {
  return String(value || '').trim();
}

function argValue(flag, fallback = '') {
  const prefix = `${flag}=`;
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(flag);
  return index >= 0 ? text(process.argv[index + 1]) : fallback;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function productKey(company, productName) {
  return `${text(company)}\u001f${text(productName)}`;
}

export function auditResponsibilityPipelineCoverage(db) {
  const requiredTables = ['product_responsibility_artifacts', 'product_responsibility_cards', 'insurance_indicator_records'];
  const missingTables = requiredTables.filter((table) => !tableExists(db, table));
  if (missingTables.length) return { ok: false, missingTables };

  const cardsByProduct = new Map(db.prepare(`
    SELECT company, product_name productName, COUNT(*) count
    FROM product_responsibility_cards
    GROUP BY company, product_name
  `).all().map((row) => [productKey(row.company, row.productName), Number(row.count)]));
  const indicatorsByProduct = new Map(db.prepare(`
    SELECT company, product_name productName, COUNT(*) count
    FROM insurance_indicator_records
    GROUP BY company, product_name
  `).all().map((row) => [productKey(row.company, row.productName), Number(row.count)]));
  const summariesByProduct = tableExists(db, 'product_customer_responsibility_summaries')
    ? new Map(db.prepare(`
        SELECT company, product_name productName, COUNT(*) count
        FROM product_customer_responsibility_summaries
        GROUP BY company, product_name
      `).all().map((row) => [productKey(row.company, row.productName), Number(row.count)]))
    : new Map();

  const approved = [];
  const artifactIssues = [];
  for (const row of db.prepare('SELECT company, product_name productName, source_digest sourceDigest, publisher_version publisherVersion, payload FROM product_responsibility_artifacts ORDER BY company, product_name').all()) {
    const artifact = parseJson(row.payload);
    const responsibilities = Array.isArray(artifact.responsibilities) ? artifact.responsibilities : [];
    const expectedCards = responsibilities.length;
    const expectedIndicators = responsibilities.reduce((sum, responsibility) => sum + (Array.isArray(responsibility?.indicators) ? responsibility.indicators.length : 0), 0);
    const key = productKey(row.company, row.productName);
    const actualCards = cardsByProduct.get(key) || 0;
    const actualIndicators = indicatorsByProduct.get(key) || 0;
    const issues = [];
    if (text(artifact?.audit?.status) !== 'approved') issues.push('artifact_not_approved');
    if (!expectedCards) issues.push('artifact_has_no_responsibilities');
    if (actualCards !== expectedCards) issues.push(`card_count:${actualCards}/${expectedCards}`);
    if (actualIndicators !== expectedIndicators) issues.push(`indicator_count:${actualIndicators}/${expectedIndicators}`);
    const item = {
      company: text(row.company),
      productName: text(row.productName),
      sourceDigest: text(row.sourceDigest),
      publisherVersion: text(row.publisherVersion),
      expectedCards,
      actualCards,
      expectedIndicators,
      actualIndicators,
      customerSummaryCount: summariesByProduct.get(key) || 0,
    };
    if (issues.length) artifactIssues.push({ ...item, issues });
    else approved.push(item);
  }

  const artifactKeys = new Set([...approved, ...artifactIssues].map((row) => productKey(row.company, row.productName)));
  const legacyOrUnreviewed = [];
  for (const key of new Set([...cardsByProduct.keys(), ...indicatorsByProduct.keys()])) {
    if (artifactKeys.has(key)) continue;
    const [company, productName] = key.split('\u001f');
    legacyOrUnreviewed.push({
      company,
      productName,
      cardCount: cardsByProduct.get(key) || 0,
      indicatorCount: indicatorsByProduct.get(key) || 0,
      customerSummaryCount: summariesByProduct.get(key) || 0,
      action: 'regenerate_and_validate_before_replace',
    });
  }

  return {
    ok: artifactIssues.length === 0,
    generatedAt: new Date().toISOString(),
    counts: {
      approvedReusableProducts: approved.length,
      artifactProductsWithIssues: artifactIssues.length,
      legacyOrUnreviewedProducts: legacyOrUnreviewed.length,
      customerSummaryProducts: summariesByProduct.size,
    },
    approvedReusable: approved,
    artifactIssues,
    legacyOrUnreviewed,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = path.resolve(argValue('--db', process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH));
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let report;
  try {
    report = auditResponsibilityPipelineCoverage(db);
  } finally {
    db.close();
  }
  const output = `${JSON.stringify({ dbPath, ...report }, null, 2)}\n`;
  const outputPath = text(argValue('--output'));
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), output);
  process.stdout.write(output);
}
