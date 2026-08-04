import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';

function arg(name, fallback = '') {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function productKey(company, productName) {
  return `${compact(company)}\u001f${compact(productName)}`;
}

function sourceDigest(row, payload = {}) {
  return text(row.source_digest || row.sourceDigest || payload.sourceDigest || payload.source_digest || payload.productIdentity?.sourceDigest);
}

function sourceUrl(row, payload = {}) {
  return text(row.source_url || row.sourceUrl || row.url || payload.sourceUrl || payload.source_url || payload.productIdentity?.sourceUrl);
}

function addSource(record, digest, url) {
  if (digest) record.digests.add(digest);
  if (url) record.urls.add(url);
  if (digest || url) record.sourceKeys.add(digest || url);
}

function isDiseaseBranch(title) {
  return /^(?:疾病全残|疾病全残保险金|疾病身故(?:或|和)?(?:身体)?全残(?:保险金)?|疾病(?:导致)?全残(?:保险金)?)$/u.test(compact(title));
}

function aggregateTitleFromExcerpt(excerpt) {
  const target = compact(excerpt);
  if (target.includes('身故或身体全残保险金')) return '身故或身体全残保险金';
  if (target.includes('身故和身体全残保险金')) return '身故和身体全残保险金';
  if (target.includes('身故或全残保险金')) return '身故或全残保险金';
  return '';
}

function isAggregateTitle(title) {
  return /^(?:身故或身体全残保险金|身故和身体全残保险金|身故或全残保险金|身故和全残保险金)$/u.test(compact(title));
}

function ensureProduct(products, company, productName) {
  if (!text(company) || !text(productName)) return null;
  const key = productKey(company, productName);
  if (!products.has(key)) {
    products.set(key, {
      productKey: `company_product:${text(company)}:${text(productName)}`,
      company: text(company),
      productName: text(productName),
      counts: { knowledge: 0, indicators: 0, optionalResponsibilities: 0, artifacts: 0, cards: 0 },
      indicatorCount: 0,
      cardCount: 0,
      artifactCount: 0,
      approvedArtifactDigests: [],
      indicatorSourceDigests: [],
      cardSourceDigests: [],
      sourceUrls: [],
      digests: new Set(),
      urls: new Set(),
      sourceKeys: new Set(),
      diseaseIndicators: [],
      aggregateIndicators: [],
      diseaseCards: [],
      aggregateCards: [],
    });
  }
  return products.get(key);
}

function addIndicator(product, row, payload) {
  product.counts.indicators += 1;
  product.indicatorCount += 1;
  const digest = sourceDigest(row, payload);
  const url = sourceUrl(row, payload);
  addSource(product, digest, url);
  const title = text(row.liability || payload.liability || payload.title);
  const excerpt = text(payload.sourceExcerpt || payload.sourceText || payload.excerpt);
  const evidence = { id: text(row.id), title, sourceDigest: digest, sourceUrl: url, aggregateTitle: aggregateTitleFromExcerpt(excerpt) };
  if (isDiseaseBranch(title)) product.diseaseIndicators.push(evidence);
  if (isAggregateTitle(title)) product.aggregateIndicators.push(evidence);
}

function addCard(product, row, payload) {
  product.counts.cards += 1;
  product.cardCount += 1;
  const digest = sourceDigest(row, payload);
  const url = sourceUrl(row, payload);
  addSource(product, digest, url);
  const title = text(row.title || payload.title || payload.liability);
  const excerpt = text(payload.sourceExcerpt || payload.sourceText || payload.excerpt);
  const evidence = { id: text(row.id), title, sourceDigest: digest, sourceUrl: url, aggregateTitle: aggregateTitleFromExcerpt(excerpt) };
  if (isDiseaseBranch(title)) product.diseaseCards.push(evidence);
  if (isAggregateTitle(title)) product.aggregateCards.push(evidence);
}

function loadRows(db, table, sql, callback) {
  if (!tableExists(db, table)) return;
  for (const row of db.prepare(sql).iterate()) callback(row);
}

export function auditDiseaseFullDisabilityDedup({ dbPath = DEFAULT_DB_PATH, outputPath = '' } = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  const products = new Map();
  try {
    loadRows(db, 'knowledge_records', 'SELECT company, product_name, url, payload FROM knowledge_records ORDER BY company, product_name, id', (row) => {
      const product = ensureProduct(products, row.company, row.product_name);
      if (!product) return;
      product.counts.knowledge += 1;
      const payload = parseJson(row.payload);
      addSource(product, sourceDigest(row, payload), sourceUrl(row, payload));
    });
    loadRows(db, 'insurance_indicator_records', 'SELECT id, company, product_name, liability, payload FROM insurance_indicator_records ORDER BY company, product_name, id', (row) => {
      const product = ensureProduct(products, row.company, row.product_name);
      if (product) addIndicator(product, row, parseJson(row.payload));
    });
    loadRows(db, 'optional_responsibility_records', 'SELECT company, product_name, payload FROM optional_responsibility_records ORDER BY company, product_name, id', (row) => {
      const product = ensureProduct(products, row.company, row.product_name);
      if (product) product.counts.optionalResponsibilities += 1;
    });
    loadRows(db, 'product_responsibility_artifacts', 'SELECT company, product_name, source_digest, source_url, payload FROM product_responsibility_artifacts ORDER BY company, product_name, source_digest', (row) => {
      const product = ensureProduct(products, row.company, row.product_name);
      if (!product) return;
      product.counts.artifacts += 1;
      product.artifactCount += 1;
      const payload = parseJson(row.payload);
      const digest = sourceDigest(row, payload);
      const url = sourceUrl(row, payload);
      addSource(product, digest, url);
      if (digest) product.approvedArtifactDigests.push(digest);
    });
    loadRows(db, 'product_responsibility_cards', 'SELECT id, company, product_name, title, payload FROM product_responsibility_cards ORDER BY company, product_name, id', (row) => {
      const product = ensureProduct(products, row.company, row.product_name);
      if (product) addCard(product, row, parseJson(row.payload));
    });
  } finally {
    db.close();
  }

  const rows = [...products.values()].sort((a, b) => `${a.company}\u001f${a.productName}`.localeCompare(`${b.company}\u001f${b.productName}`, 'zh-Hans-CN'));
  let sameSourceRepairable = 0;
  let sameSourceKeyCandidates = 0;
  let sameSourceRepairableWithApprovedArtifact = 0;
  let sourceReview = 0;
  let sourceReady = 0;
  let versionConflict = 0;
  let manualReview = 0;
  let diseaseBranchProducts = 0;
  let splitIndicatorProducts = 0;
  let splitCardProducts = 0;
  const ledger = rows.map((product) => {
    const digestList = [...product.digests].sort();
    const digestConflict = digestList.length > 1;
    const rawDiseaseSourceKeys = new Set(product.diseaseIndicators.map((row) => row.sourceDigest || row.sourceUrl).filter(Boolean));
    const rawAggregateSourceKeys = new Set(product.aggregateIndicators.map((row) => row.sourceDigest || row.sourceUrl).filter(Boolean));
    const rawSameSourceKeys = [...rawDiseaseSourceKeys].filter((key) => rawAggregateSourceKeys.has(key));
    const diseaseSameSourceKeys = new Set(product.diseaseIndicators.filter((row) => row.aggregateTitle).map((row) => row.sourceDigest || row.sourceUrl).filter(Boolean));
    const aggregateSameSourceKeys = new Set(product.aggregateIndicators.filter((row) => row.aggregateTitle).map((row) => row.sourceDigest || row.sourceUrl).filter(Boolean));
    const sameSourceKeys = [...diseaseSameSourceKeys].filter((key) => aggregateSameSourceKeys.has(key));
    const sameSource = sameSourceKeys.length > 0;
    if (rawSameSourceKeys.length > 0) sameSourceKeyCandidates += 1;
    const hasDisease = product.diseaseIndicators.length > 0;
    const hasAggregate = product.aggregateIndicators.length > 0;
    const splitIndicators = hasDisease && hasAggregate && product.diseaseIndicators.length + product.aggregateIndicators.length > 1;
    const cardSameSource = product.diseaseCards.length > 0 && product.aggregateCards.length > 0;
    if (hasDisease) diseaseBranchProducts += 1;
    if (splitIndicators) splitIndicatorProducts += 1;
    if (cardSameSource) splitCardProducts += 1;
    if (sameSource && !digestConflict) sameSourceRepairable += 1;
    if (sameSource && !digestConflict && product.artifactCount > 0) {
      sameSourceRepairableWithApprovedArtifact += 1;
      sourceReady += 1;
    } else if (sameSource && !digestConflict) {
      sourceReview += 1;
    }
    else if (hasDisease && (digestConflict || product.digests.size > 1)) versionConflict += 1;
    else if (hasDisease && !sameSource) manualReview += 1;
    const terminalStatus = digestConflict
      ? 'version_conflict'
      : (sameSource && product.artifactCount > 0 ? 'approved' : (sameSource ? 'source_pending' : (hasDisease ? 'manual_review' : 'not_candidate')));
    return {
      productKey: product.productKey,
      company: product.company,
      productName: product.productName,
      counts: product.counts,
      indicatorCount: product.indicatorCount,
      cardCount: product.cardCount,
      artifactCount: product.artifactCount,
      approvedArtifactDigests: [...new Set(product.approvedArtifactDigests)].sort(),
      sourceDigests: digestList,
      sourceUrls: [...product.urls].sort(),
      diseaseBranchIndicators: product.diseaseIndicators,
      aggregateIndicators: product.aggregateIndicators,
      diseaseBranchCards: product.diseaseCards,
      aggregateCards: product.aggregateCards,
      classification: {
        diseaseBranch: hasDisease,
        splitIndicator: splitIndicators,
        splitCard: cardSameSource,
        sameSource,
        rawSameSourceKeys,
        sameSourceKeys,
        versionConflict: digestConflict,
        status: sameSource && !digestConflict ? 'same_source_repairable' : (digestConflict ? 'version_conflict' : (hasDisease ? 'manual_review' : 'not_candidate')),
        queue: sameSource && product.artifactCount === 0 ? 'source_review' : '',
        terminalStatus,
      },
    };
  });
  const result = {
    auditVersion: '2026-07-31-disease-full-disability-dedup-v1',
    dbPath: resolvedDbPath,
    readOnly: true,
    databaseMode: 'mode=ro, query_only=ON',
    generatedAt: new Date().toISOString(),
    summary: {
      productKeyCount: ledger.length,
      indicatorRowCount: ledger.reduce((sum, row) => sum + row.indicatorCount, 0),
      cardRowCount: ledger.reduce((sum, row) => sum + row.cardCount, 0),
      approvedArtifactRowCount: ledger.reduce((sum, row) => sum + row.artifactCount, 0),
      diseaseBranchProducts,
      splitIndicatorProducts,
      splitCardProducts,
      sameSourceRepairableProducts: sameSourceRepairable,
      sameSourceKeyCandidates,
      sameSourceRepairableWithApprovedArtifactProducts: sameSourceRepairableWithApprovedArtifact,
      sourceReadyProducts: sourceReady,
      sourceReviewProducts: sourceReview,
      materializerBlockedProducts: 0,
      versionConflictProducts: versionConflict,
      manualReviewProducts: manualReview,
    },
    products: ledger,
  };
  if (outputPath) {
    const resolvedOutputPath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
    fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(result, null, 2)}\n`);
    result.outputPath = resolvedOutputPath;
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = auditDiseaseFullDisabilityDedup({
    dbPath: arg('db-path', DEFAULT_DB_PATH),
    outputPath: arg('output', ''),
  });
  console.log(JSON.stringify(result.summary, null, 2));
}
