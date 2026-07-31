import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  importReviewedResponsibilityArtifacts,
  prepareReviewedResponsibilityArtifacts,
} from './import-reviewed-responsibility-artifacts.mjs';

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

function text(value) {
  return String(value ?? '').trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function productKey(product = {}) {
  return `${text(product.company)}\u001f${text(product.productName)}`;
}

function sourceIdentity(product = {}) {
  const identity = product.productIdentity && typeof product.productIdentity === 'object'
    ? product.productIdentity
    : {};
  return {
    sourceDigest: text(identity.sourceDigest || product.sourceDigest),
    sourceUrl: text(identity.sourceUrl || product.sourceUrl),
  };
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sorted(values = []) {
  return [...values].map(text).filter(Boolean).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

function exactArray(left = [], right = []) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function readPayload(row = {}) {
  try {
    return JSON.parse(row.payload || '{}');
  } catch {
    return {};
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function manifestArtifacts(manifestPath, manifest = {}) {
  const root = path.dirname(manifestPath);
  return rows(manifest.products).map((product) => ({
    ...product,
    artifactPath: path.resolve(root, text(product.artifactPath)),
  }));
}

function validateHandoff({ manifestPath, artifacts, preparedProducts }) {
  const issues = [];
  const expectedByKey = new Map();
  for (const product of artifacts) {
    const key = productKey(product);
    if (!text(product.company) || !text(product.productName)) issues.push(`manifest_missing_product_identity:${key}`);
    if (!text(product.sourceDigest)) issues.push(`manifest_missing_source_digest:${key}`);
    if (!text(product.sourceUrl)) issues.push(`manifest_missing_source_url:${key}`);
    if (!text(product.artifactPath) || !fs.existsSync(product.artifactPath)) {
      issues.push(`artifact_missing:${text(product.artifactPath)}`);
      continue;
    }
    if (text(product.artifactSha256) !== sha256(product.artifactPath)) {
      issues.push(`artifact_sha256_mismatch:${path.basename(product.artifactPath)}`);
    }
    if (expectedByKey.has(key)) issues.push(`manifest_duplicate_product:${key}`);
    expectedByKey.set(key, product);
  }
  if (!artifacts.length) issues.push(`manifest_has_no_products:${manifestPath}`);

  const actualByKey = new Map();
  for (const product of preparedProducts) {
    const key = productKey(product);
    if (actualByKey.has(key)) issues.push(`artifact_duplicate_product:${key}`);
    actualByKey.set(key, product);
  }
  if (actualByKey.size !== expectedByKey.size) issues.push(`product_count_mismatch:${actualByKey.size}:${expectedByKey.size}`);

  const products = artifacts.map((expected) => {
    const actual = actualByKey.get(productKey(expected));
    const productIssues = [];
    if (!actual) productIssues.push('artifact_product_missing');
    const actualSource = sourceIdentity(actual);
    if (actualSource.sourceDigest !== text(expected.sourceDigest)) productIssues.push('source_digest_mismatch');
    if (actualSource.sourceUrl !== text(expected.sourceUrl)) productIssues.push('source_url_mismatch');
    const accepted = rows(actual?.acceptedResponsibilities);
    if (accepted.length !== Number(expected.expectedCards || 0)) productIssues.push(`card_count_mismatch:${accepted.length}:${expected.expectedCards}`);
    if (accepted.length !== Number(expected.expectedIndicators || 0)) productIssues.push(`indicator_count_mismatch:${accepted.length}:${expected.expectedIndicators}`);
    for (const responsibility of accepted) {
      if (text(responsibility.sourceUrl) !== text(expected.sourceUrl)) productIssues.push(`responsibility_source_url_mismatch:${text(responsibility.liability)}`);
    }
    issues.push(...productIssues.map((issue) => `${expected.order}:${issue}`));
    return {
      order: expected.order,
      company: expected.company,
      productName: expected.productName,
      numericId: expected.numericId ?? null,
      sourceDigest: expected.sourceDigest,
      sourceUrl: expected.sourceUrl,
      expectedCards: expected.expectedCards,
      expectedIndicators: expected.expectedIndicators,
      validationIssues: productIssues,
    };
  });

  return { issues, products };
}

function preflightTargetDatabase({ dbPath, products }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasCards = tableExists(db, 'product_responsibility_cards');
    const hasIndicators = tableExists(db, 'insurance_indicator_records');
    const result = products.map((product) => {
      const cards = hasCards ? db.prepare(`
        SELECT source_url, payload
          FROM product_responsibility_cards
         WHERE company = ? AND product_name = ?
      `).all(product.company, product.productName) : [];
      const indicators = hasIndicators ? db.prepare(`
        SELECT payload
          FROM insurance_indicator_records
         WHERE company = ? AND product_name = ?
      `).all(product.company, product.productName) : [];
      const observedUrls = new Set(cards.map((row) => text(row.source_url)).filter(Boolean));
      const observedDigests = new Set();
      for (const row of [...cards, ...indicators]) {
        const payload = readPayload(row);
        if (text(payload.sourceUrl)) observedUrls.add(text(payload.sourceUrl));
        if (text(payload.sourceDigest)) observedDigests.add(text(payload.sourceDigest));
      }
      const versionConflicts = [
        ...[...observedUrls].filter((value) => value !== product.sourceUrl).map((value) => `source_url:${value}`),
        ...[...observedDigests].filter((value) => value !== product.sourceDigest).map((value) => `source_digest:${value}`),
      ];
      return {
        order: product.order,
        productName: product.productName,
        existingCards: cards.length,
        existingIndicators: indicators.length,
        observedSourceUrls: sorted(observedUrls),
        observedSourceDigests: sorted(observedDigests),
        versionConflicts,
      };
    });
    const quickCheck = String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
    return {
      dbPath: path.resolve(dbPath),
      quickCheck,
      products: result,
      versionConflictCount: result.reduce((sum, product) => sum + product.versionConflicts.length, 0),
    };
  } finally {
    db.close();
  }
}

function semanticReadback({ dbPath, products, preparedProducts }) {
  const expectedByKey = new Map(preparedProducts.map((product) => [productKey(product), product]));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const productResults = products.map((product) => {
      const expected = expectedByKey.get(productKey(product)) || {};
      const accepted = rows(expected.acceptedResponsibilities);
      const cards = db.prepare(`
        SELECT title, source_url, payload
          FROM product_responsibility_cards
         WHERE company = ? AND product_name = ?
         ORDER BY title
      `).all(product.company, product.productName);
      const indicators = db.prepare(`
        SELECT liability, payload
          FROM insurance_indicator_records
         WHERE company = ? AND product_name = ?
         ORDER BY liability
      `).all(product.company, product.productName);
      const issues = [];
      const expectedTitles = accepted.map((responsibility) => responsibility.liability);
      if (cards.length !== Number(product.expectedCards || 0)) issues.push(`card_count:${cards.length}:${product.expectedCards}`);
      if (indicators.length !== Number(product.expectedIndicators || 0)) issues.push(`indicator_count:${indicators.length}:${product.expectedIndicators}`);
      if (!exactArray(cards.map((card) => card.title), expectedTitles)) issues.push('card_titles_mismatch');
      if (!exactArray(indicators.map((indicator) => indicator.liability), expectedTitles)) issues.push('indicator_liabilities_mismatch');
      for (const responsibility of accepted) {
        const card = cards.find((item) => text(item.title) === text(responsibility.liability));
        const indicator = indicators.find((item) => text(item.liability) === text(responsibility.liability));
        if (!card || !indicator) continue;
        const cardPayload = readPayload(card);
        const indicatorPayload = readPayload(indicator);
        if (text(card.source_url) !== product.sourceUrl || text(cardPayload.sourceUrl) !== product.sourceUrl) {
          issues.push(`card_source_url_mismatch:${responsibility.liability}`);
        }
        if (text(indicatorPayload.sourceUrl) !== product.sourceUrl) issues.push(`indicator_source_url_mismatch:${responsibility.liability}`);
        if (text(indicatorPayload.sourceDigest) !== product.sourceDigest) issues.push(`indicator_source_digest_mismatch:${responsibility.liability}`);
        if (text(indicatorPayload.formulaText) !== text(responsibility.formulaText)) issues.push(`formula_mismatch:${responsibility.liability}`);
        const cardIndicators = rows(cardPayload.indicators);
        if (!cardIndicators.some((item) => text(item.liability) === text(responsibility.liability))) {
          issues.push(`card_indicator_projection_missing:${responsibility.liability}`);
        }
      }
      return {
        order: product.order,
        productName: product.productName,
        cards: cards.length,
        indicators: indicators.length,
        validationIssues: issues,
      };
    });
    const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
    const quickCheck = String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
    const validationIssueCount = productResults.reduce((sum, product) => sum + product.validationIssues.length, 0)
      + foreignKeyIssues.length
      + (quickCheck === 'ok' ? 0 : 1);
    return {
      products: productResults,
      foreignKeyIssueCount: foreignKeyIssues.length,
      quickCheck,
      validationIssueCount,
      ok: validationIssueCount === 0,
    };
  } finally {
    db.close();
  }
}

export function importProductionResponsibilityHandoff({
  manifestPath = '',
  dbPath = '',
  write = false,
  sampleLimit = 10,
} = {}) {
  if (!manifestPath) throw new Error('manifestPath is required');
  if (!dbPath) throw new Error('dbPath is required');
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'));
  const artifacts = manifestArtifacts(resolvedManifestPath, manifest);
  const artifactPaths = artifacts.map((artifact) => artifact.artifactPath);
  const preparedProducts = prepareReviewedResponsibilityArtifacts({ artifacts: artifactPaths });
  const manifestValidation = validateHandoff({
    manifestPath: resolvedManifestPath,
    artifacts,
    preparedProducts,
  });
  const targetPreflight = preflightTargetDatabase({ dbPath, products: manifestValidation.products });
  const validationIssues = [
    ...manifestValidation.issues,
    ...(targetPreflight.quickCheck === 'ok' ? [] : [`target_quick_check:${targetPreflight.quickCheck}`]),
    ...targetPreflight.products.flatMap((product) => product.versionConflicts.map((conflict) => `${product.order}:version_conflict:${conflict}`)),
  ];
  if (validationIssues.length) {
    return {
      ok: false,
      dryRun: !write,
      manifestPath: resolvedManifestPath,
      dbPath: path.resolve(dbPath),
      validationIssueCount: validationIssues.length,
      validationIssues,
      products: manifestValidation.products,
      targetPreflight,
    };
  }

  const imported = importReviewedResponsibilityArtifacts({
    artifacts: artifactPaths,
    dbPath,
    write,
    sampleLimit,
  });
  const importIssues = [
    ...imported.validationFailures.flatMap((failure) => failure.issues),
    ...imported.blockerProducts.flatMap((product) => rows(product.blockers).map((blocker) => text(blocker.reason || blocker))),
  ].filter(Boolean);
  if (imported.productsReviewed !== manifestValidation.products.length) importIssues.push('import_product_count_mismatch');
  if (imported.acceptedResponsibilities !== manifestValidation.products.reduce((sum, product) => sum + Number(product.expectedIndicators || 0), 0)) {
    importIssues.push('import_indicator_count_mismatch');
  }
  const readback = write ? semanticReadback({
    dbPath,
    products: manifestValidation.products,
    preparedProducts,
  }) : null;
  const validationIssueCount = importIssues.length + Number(readback?.validationIssueCount || 0);
  return {
    ok: validationIssueCount === 0,
    dryRun: !write,
    manifestPath: resolvedManifestPath,
    dbPath: path.resolve(dbPath),
    validationIssueCount,
    validationIssues: importIssues,
    products: manifestValidation.products,
    targetPreflight,
    imported,
    readback,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(importProductionResponsibilityHandoff({
      manifestPath: readArg('manifest'),
      dbPath: readArg('db-path'),
      write: hasFlag('write'),
      sampleLimit: Number(readArg('sample-limit', 10)) || 10,
    }), null, 2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
