import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const dbPath = arg('db');
const productsPath = arg('products');
const outputPath = arg('output');
const bounded = process.argv.includes('--bounded');
if (!dbPath || !productsPath || !outputPath) throw new Error('usage: --db DB --products PRODUCTS --output OUTPUT');

const fields = [
  'formulaText', 'normalizedFormula', 'basisKey', 'calculationKey', 'calculationEligible',
  'requiredInputs', 'operands', 'branches', 'ruleRefs', 'sourceExcerpt', 'evidenceSegments',
  'payoutSummary', 'customerSummary', 'plainSummary',
];
const arrayFields = new Set(['requiredInputs', 'operands', 'branches', 'ruleRefs', 'evidenceSegments']);
const specified = (value, field) => value !== undefined && value !== null
  && (arrayFields.has(field) || value !== '');
const canonical = (value, field) => value === undefined || value === null
  ? (arrayFields.has(field) ? [] : '')
  : value;
const equal = (left, right, field) => JSON.stringify(canonical(left, field)) === JSON.stringify(canonical(right, field));
const rows = (value) => Array.isArray(value) ? value : [];
const preserveText = (value) => value === undefined || value === null ? '' : String(value);
const sourceExcerptFromEvidenceSegments = (segments) => rows(segments)
  .map((segment) => preserveText(segment?.sourceExcerpt || segment?.text || segment?.excerpt))
  .filter((value) => value.trim())
  .join('\n');
const parsePayload = (row) => ({ ...row, payload: JSON.parse(row.payload || '{}') });

const products = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
const db = new DatabaseSync(dbPath, { readOnly: true });
const issues = [];
const allowedDerivations = [];
const productResults = [];
const timings = [];
const explain = [];

function timedGet(label, statement, params, product) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...params);
  const started = performance.now();
  const result = statement.includes('LIMIT 1') ? db.prepare(statement).get(...params) : db.prepare(statement).all(...params);
  timings.push({ label, company: product.company, productName: product.productName, elapsedMs: Number((performance.now() - started).toFixed(3)) });
  explain.push({ label, company: product.company, productName: product.productName, plan });
  return result;
}

for (const product of products) {
  const artifactRow = timedGet('artifact', `
    SELECT source_digest, payload FROM product_responsibility_artifacts
     WHERE company = ? AND product_name = ? ORDER BY id DESC LIMIT 1
  `, [product.company, product.productName], product);
  const artifact = artifactRow ? JSON.parse(artifactRow.payload || '{}') : {};
  const responsibilities = rows(artifact.responsibilities);
  const standalone = timedGet('standalone', `
    SELECT id, payload FROM insurance_indicator_records
     WHERE company = ? AND product_name = ? ORDER BY id
  `, [product.company, product.productName], product).map(parsePayload);
  const cards = timedGet('cards', `
    SELECT id, title, payload FROM product_responsibility_cards
     WHERE company = ? AND product_name = ? ORDER BY id
  `, [product.company, product.productName], product).map(parsePayload);
  const nested = cards.flatMap((card) => rows(card.payload.indicators));
  let productIssueCount = 0;

  for (const responsibility of responsibilities) {
    for (const [indicatorIndex, artifactIndicator] of rows(responsibility.indicators).entries()) {
      const expected = {};
      for (const field of fields) {
        const approvedEvidenceExcerpt = field === 'sourceExcerpt'
          ? sourceExcerptFromEvidenceSegments(artifactIndicator.evidenceSegments)
          : '';
        if (field === 'sourceExcerpt' && approvedEvidenceExcerpt.trim()) expected[field] = approvedEvidenceExcerpt;
        else if (Object.hasOwn(artifactIndicator, field) && specified(artifactIndicator[field], field)) expected[field] = artifactIndicator[field];
        else if (field === 'payoutSummary' && (responsibility.insurerObligation || responsibility.payout)) expected[field] = responsibility.insurerObligation || responsibility.payout;
        else if ((field === 'customerSummary' || field === 'plainSummary') && (responsibility.card?.customerSummary || responsibility.customerSummary)) expected[field] = responsibility.card?.customerSummary || responsibility.customerSummary;
        else if (field === 'sourceExcerpt' && responsibility.sourceExcerpt) expected[field] = responsibility.sourceExcerpt;
        else if (field === 'evidenceSegments' && responsibility.evidenceSegments) expected[field] = responsibility.evidenceSegments;
        else expected[field] = undefined;
      }
      const standaloneRow = standalone.find((row) => (
        row.payload.responsibilityId === responsibility.responsibilityId
        && Number(row.payload.reviewedIndicatorIndex) === indicatorIndex
      )) || standalone.find((row) => row.payload.responsibilityId === responsibility.responsibilityId);
      const actualStandalone = standaloneRow?.payload || {};
      const actualNested = standaloneRow
        ? nested.find((indicator) => indicator.id === standaloneRow.id)
        : null;
      for (const field of fields) {
        if (expected[field] === undefined) {
          if (actualStandalone[field] !== undefined || actualNested?.[field] !== undefined) {
            allowedDerivations.push({
              company: product.company,
              productName: product.productName,
              responsibilityId: responsibility.responsibilityId || '',
              indicatorId: standaloneRow?.id || artifactIndicator.id || '',
              field,
              standaloneActual: canonical(actualStandalone[field], field),
              cardNestedActual: canonical(actualNested?.[field], field),
              lossStage: 'artifact_unspecified_projection',
              displayDerivationAllowed: true,
            });
          }
          continue;
        }
        const standaloneDiff = !equal(expected[field], actualStandalone[field], field);
        const nestedDiff = !equal(actualStandalone[field], actualNested?.[field], field);
        if (!standaloneDiff && !nestedDiff) continue;
        productIssueCount += 1;
        issues.push({
          company: product.company,
          productName: product.productName,
          sourceDigest: product.sourceDigest || artifactRow?.source_digest || '',
          responsibilityId: responsibility.responsibilityId || '',
          indicatorId: standaloneRow?.id || artifactIndicator.id || '',
          field,
          artifactExpected: canonical(expected[field], field),
          standaloneActual: canonical(actualStandalone[field], field),
          cardNestedActual: canonical(actualNested?.[field], field),
          lossStage: standaloneDiff ? 'artifact_to_standalone_indicator' : 'standalone_to_card_nested',
          displayDerivationAllowed: false,
        });
      }
    }
  }
  productResults.push({
    company: product.company,
    productName: product.productName,
    sourceDigest: product.sourceDigest || artifactRow?.source_digest || '',
    indicatorCount: standalone.length,
    cardCount: cards.length,
    issueCount: productIssueCount,
  });
}

const duplicateIssueCount = products.reduce((sum, product) => sum + Number(timedGet('duplicate-cards', `
  SELECT COUNT(*) AS count FROM (
    SELECT title FROM product_responsibility_cards
     WHERE company = ? AND product_name = ?
     GROUP BY title HAVING COUNT(*) > 1
  )
`, [product.company, product.productName], product).count || 0), 0);
const hasPolicies = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_policies'").get());
const orphanIssueCount = bounded ? 0 : (hasPolicies
  ? Number(db.prepare(`
    SELECT COUNT(*) AS count FROM product_responsibility_cards c
    LEFT JOIN product_policies p ON p.company = c.company AND p.product_name = c.product_name
    WHERE p.company IS NULL
  `).get().count || 0)
  : 0);
const foreignKeyIssues = bounded ? [] : db.prepare('PRAGMA foreign_key_check').all();
const quickCheck = bounded ? 'skipped_bounded' : (db.prepare('PRAGMA quick_check').get()?.quick_check || '');
const result = {
  generatedAt: new Date().toISOString(),
  dbPath,
  productsScanned: products.length,
  semanticExact: issues.length === 0,
  fieldDifferenceCount: issues.length,
  allowedDerivationCount: allowedDerivations.length,
  duplicateIssueCount,
  orphanIssueCount,
  foreignKeyIssueCount: foreignKeyIssues.length,
  quickCheck,
  bounded,
  maxQueryMs: Math.max(...timings.map((item) => item.elapsedMs), 0),
  totalQueryMs: Number(timings.reduce((sum, item) => sum + item.elapsedMs, 0).toFixed(3)),
  timings,
  explain,
  productResults,
  allowedDerivations,
  issues,
};
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  outputPath,
  productsScanned: result.productsScanned,
  semanticExact: result.semanticExact,
  fieldDifferenceCount: result.fieldDifferenceCount,
  allowedDerivationCount: result.allowedDerivationCount,
  duplicateIssueCount,
  orphanIssueCount,
  foreignKeyIssueCount: foreignKeyIssues.length,
  quickCheck,
  bounded,
  maxQueryMs: Math.max(...timings.map((item) => item.elapsedMs), 0),
}, null, 2));
