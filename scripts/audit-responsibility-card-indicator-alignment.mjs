#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { evaluateResponsibilityStrictAlignment } from './responsibility-strict-alignment.mjs';

const DEFAULT_DB = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';

function text(value) {
  return String(value ?? '').trim();
}

function json(value, fallback = {}) {
  try {
    return JSON.parse(text(value));
  } catch {
    return fallback;
  }
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function productSource(payload = {}) {
  const sourceDigest = text(
    payload.sourceDigest
      || payload.responsibilitySourceDigest
      || payload.productIdentity?.sourceDigest,
  );
  const sourceUrl = text(payload.sourceUrl || payload.productIdentity?.sourceUrl);
  return { sourceDigest, sourceUrl };
}

function rawProductKey(company, productName) {
  return `${text(company)}\u001f${text(productName)}`;
}

function sourceKey(company, productName, payload = {}) {
  const source = productSource(payload);
  if (source.sourceDigest) return `digest:${source.sourceDigest}`;
  if (source.sourceUrl) return `url:${source.sourceUrl}`;
  return `product:${rawProductKey(company, productName)}`;
}

function evidence(payload = {}) {
  const source = productSource(payload);
  return Boolean(source.sourceUrl && text(payload.sourceExcerpt));
}

function nestedIndicatorIds(cardPayload) {
  return rows(cardPayload?.indicators).map((indicator) => text(
    indicator?.id || indicator?.indicatorId || indicator?.nestedIndicatorId,
  ));
}

function loadRows(db, table) {
  return db.prepare(`SELECT company, product_name productName, payload FROM ${table}`).all()
    .map((row) => ({
      company: text(row.company),
      productName: text(row.productName),
      payload: json(row.payload),
    }));
}

function loadApprovedArtifacts(db) {
  const bySource = new Map();
  for (const row of db.prepare(`
    SELECT company, product_name productName, source_digest sourceDigest, payload
      FROM product_responsibility_artifacts
     WHERE json_extract(payload, '$.audit.status') = 'approved'
  `).all()) {
    const artifact = json(row.payload);
    const key = sourceKey(row.company, row.productName, {
      ...artifact,
      sourceDigest: text(artifact.sourceDigest || row.sourceDigest),
    });
    const list = bySource.get(key) || [];
    list.push({
      company: text(row.company),
      productName: text(row.productName),
      sourceDigest: text(artifact.sourceDigest || row.sourceDigest),
      sourceUrl: text(artifact.sourceUrl || artifact.productIdentity?.sourceUrl),
      artifact,
    });
    bySource.set(key, list);
  }
  return bySource;
}

function buildProducts(cards, indicators, artifacts) {
  const raw = new Map();
  const addRaw = (company, productName, payload, type, row) => {
    const rawKey = rawProductKey(company, productName);
    const item = raw.get(rawKey) || {
      rawKey,
      company: text(company),
      productName: text(productName),
      sourceDigests: new Set(),
      sourceUrls: new Set(),
      artifactSourceDigests: new Set(),
      artifactSourceUrls: new Set(),
      cards: [],
      indicators: [],
      artifacts: [],
    };
    if (type !== 'artifacts') {
      const source = productSource(payload);
      if (source.sourceDigest) item.sourceDigests.add(source.sourceDigest);
      if (source.sourceUrl) item.sourceUrls.add(source.sourceUrl);
    }
    item[type].push(row);
    if (type === 'artifacts') {
      const source = productSource(payload);
      if (source.sourceDigest) item.artifactSourceDigests.add(source.sourceDigest);
      if (source.sourceUrl) item.artifactSourceUrls.add(source.sourceUrl);
    }
    raw.set(rawKey, item);
  };
  for (const row of cards) addRaw(row.company, row.productName, row.payload, 'cards', row);
  for (const row of indicators) addRaw(row.company, row.productName, row.payload, 'indicators', row);
  for (const list of artifacts.values()) {
    for (const item of list) addRaw(item.company, item.productName, item.artifact, 'artifacts', item);
  }

  const products = new Map();
  const rawToCanonical = new Map();
  for (const item of raw.values()) {
    // The database rows are already product-scoped. Source identity is kept as
    // audit evidence and conflict metadata; it must not merge distinct product
    // names merely because a catalog reused one PDF URL.
    const key = `product:${item.rawKey}`;
    rawToCanonical.set(item.rawKey, key);
    const product = products.get(key) || {
      key,
      rawProducts: new Set(),
      sourceDigests: new Set(),
      sourceUrls: new Set(),
      artifactSourceDigests: new Set(),
      artifactSourceUrls: new Set(),
      cards: [],
      indicators: [],
      artifacts: [],
    };
    product.rawProducts.add(item.rawKey);
    for (const value of item.sourceDigests) product.sourceDigests.add(value);
    for (const value of item.sourceUrls) product.sourceUrls.add(value);
    for (const value of item.artifactSourceDigests) product.artifactSourceDigests.add(value);
    for (const value of item.artifactSourceUrls) product.artifactSourceUrls.add(value);
    product.cards.push(...item.cards);
    product.indicators.push(...item.indicators);
    product.artifacts.push(...item.artifacts);
    products.set(key, product);
  }
  return { products, rawToCanonical };
}

function classify(product) {
  const indicatorIds = new Set(product.indicators.map((row) => text(row.payload.id)));
  const nestedIds = product.cards.flatMap((row) => nestedIndicatorIds(row.payload));
  const emptyNestedIds = nestedIds.filter((id) => !id).length;
  const duplicateNestedIds = nestedIds.length - new Set(nestedIds.filter(Boolean)).size;
  const missingNestedIds = nestedIds.filter((id) => id && !indicatorIds.has(id)).length;
  const unreferencedIndicatorIds = [...indicatorIds]
    .filter((id) => id && !new Set(nestedIds.filter(Boolean)).has(id)).length;
  const titles = product.cards.map((row) => text(row.payload.title || row.title));
  const duplicateTitles = titles.length - new Set(titles.filter(Boolean)).size;
  const cardEvidenceMissing = product.cards.filter((row) => !evidence(row.payload)).length;
  const indicatorEvidenceMissing = product.indicators.filter((row) => !evidence(row.payload)).length;
  const [rawProduct = ''] = [...product.rawProducts];
  const [company = '', productName = ''] = rawProduct.split('\u001f');
  const strictAlignment = evaluateResponsibilityStrictAlignment({
    artifacts: product.artifacts.map((item) => item.artifact),
    cards: product.cards,
    indicators: product.indicators,
    company,
    productName,
  });
  const strict = strictAlignment.strictAligned;
  const artifactResponsibilities = product.artifacts.flatMap((item) => rows(
    item.artifact.responsibilities || item.artifact.acceptedResponsibilities,
  ));
  const approvedIndicators = artifactResponsibilities.flatMap((responsibility) => rows(responsibility.indicators));
  const hasFormulaStructure = product.artifacts.some((item) => (
    artifactResponsibilities.some((responsibility) => (
      text(responsibility.normalizedFormula)
      || rows(responsibility.operands).length
      || rows(responsibility.branches).length
      || text(responsibility.branchSemanticContract)
    ))
    || approvedIndicators.some((indicator) => (
      text(indicator.normalizedFormula)
      || rows(indicator.operands).length
      || rows(indicator.branches).length
      || text(indicator.branchSemanticContract)
    ))
  ));
  const allSourceDigests = new Set([
    ...product.sourceDigests,
    ...product.artifactSourceDigests,
  ]);
  const allSourceUrls = new Set([
    ...product.sourceUrls,
    ...product.artifactSourceUrls,
  ]);
  const sourceConflict = allSourceDigests.size > 1;
  const hasCardsAndIndicators = product.cards.length > 0 && product.indicators.length > 0;
  let category = 'other_blocked';
  if (!hasCardsAndIndicators) category = 'other_blocked';
  else if (sourceConflict) category = 'source_version_conflict';
  else if (product.artifacts.length) category = hasFormulaStructure
    ? 'artifact_backed_deterministic_rebuild_formula_or_multi_indicator'
    : 'artifact_backed_materializer_only';
  else if (duplicateNestedIds || duplicateTitles || missingNestedIds) category = 'duplicate_or_orphan_card_cleanup';
  else if (!product.artifacts.length) category = 'missing_approved_artifact';
  return {
    key: product.key,
    rawProducts: [...product.rawProducts].sort(),
    sourceDigests: [...product.sourceDigests].sort(),
    sourceUrls: [...product.sourceUrls].sort(),
    artifactSourceDigests: [...product.artifactSourceDigests].sort(),
    artifactSourceUrls: [...product.artifactSourceUrls].sort(),
    allSourceDigests: [...allSourceDigests].sort(),
    allSourceUrls: [...allSourceUrls].sort(),
    cards: product.cards.length,
    indicators: product.indicators.length,
    hasCardsAndIndicators,
    strict,
    strictAlignment,
    reasonCodes: strictAlignment.reasonCodes,
    category: strict ? 'strict_aligned' : category,
    evidence: {
      nestedIndicatorIds: nestedIds.length,
      emptyNestedIds,
      duplicateNestedIds,
      missingNestedIds,
      unreferencedIndicatorIds,
      duplicateTitles,
      cardEvidenceMissing,
      indicatorEvidenceMissing,
      approvedArtifacts: product.artifacts.length,
      sourceDigestConflict: sourceConflict,
    },
  };
}

export function auditResponsibilityAlignment(db) {
  const { products } = buildProducts(
    loadRows(db, 'product_responsibility_cards'),
    loadRows(db, 'insurance_indicator_records'),
    loadApprovedArtifacts(db),
  );
  const ledger = [...products.values()].map(classify).sort((left, right) => left.key.localeCompare(right.key));
  const counts = {};
  for (const row of ledger) counts[row.category] = (counts[row.category] || 0) + 1;
  const both = ledger.filter((row) => row.hasCardsAndIndicators);
  return {
    schema: 'responsibility-card-indicator-alignment/v1',
    generatedAt: new Date().toISOString(),
    counts: {
      products: ledger.length,
      strictAligned: counts.strict_aligned || 0,
      productsWithCardsAndIndicators: both.length,
      nonStrict: ledger.length - (counts.strict_aligned || 0),
      nonStrictWithCardsAndIndicators: both.filter((row) => !row.strict).length,
      cardOnly: ledger.filter((row) => row.cards > 0 && row.indicators === 0).length,
      indicatorOnly: ledger.filter((row) => row.cards === 0 && row.indicators > 0).length,
      cards: ledger.reduce((sum, row) => sum + row.cards, 0),
      indicators: ledger.reduce((sum, row) => sum + row.indicators, 0),
      byCategory: counts,
    },
    ledger,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = path.resolve(arg('db', DEFAULT_DB));
  const outputPath = arg('output');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let report;
  try {
    report = auditResponsibilityAlignment(db);
  } finally {
    db.close();
  }
  const canonical = `${JSON.stringify(report, null, 2)}\n`;
  const result = {
    ...report,
    reportSha256: digest(canonical),
  };
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(JSON.stringify({
    dbPath,
    outputPath: outputPath ? path.resolve(outputPath) : null,
    ...result.counts,
    reportSha256: result.reportSha256,
  }, null, 2));
  process.stdout.write('\n');
}
