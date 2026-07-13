const CATALOG_TABLES = [
  { table: 'knowledge_records', product: 'product_name', requiredPublicColumns: ['payload'], publicWhere: `(
      json_valid(payload) = 1 AND (
        COALESCE(json_extract(payload, '$.sourceKind'), '') NOT IN ('open_web_reference', 'legacy_external_reference')
        AND COALESCE(json_extract(payload, '$.evidenceLevel'), '') != 'external_legacy_reference'
        AND COALESCE(json_extract(payload, '$.materialType'), '') != 'external_reference'
        AND COALESCE(json_extract(payload, '$.qualityStatus'), '') != 'external_reference_only'
        AND COALESCE(json_extract(payload, '$.parser'), '') NOT IN ('deepseek_planned_open_web_search', 'legacy_external_reference_seed', 'external_review_query_source')
        AND COALESCE(json_extract(payload, '$.responsibilityDeferred'), 0) != 1
        AND (
          COALESCE(json_extract(payload, '$.sourceKind'), '') != 'admin_product_material'
          OR (
            COALESCE(json_extract(payload, '$.reviewStatus'), '') = 'approved'
            AND COALESCE(json_extract(payload, '$.globalSearchable'), 0) = 1
          )
        )
      )
    )` },
  { table: 'insurance_indicator_records', product: 'product_name', public: false },
  { table: 'product_responsibility_cards', product: 'product_name', public: false },
  { table: 'optional_responsibility_records', product: 'product_name', public: false },
  { table: 'product_customer_responsibility_summaries', product: 'product_name', requiredPublicColumns: ['status'], publicWhere: "status = 'ready'" },
  { table: 'insurance_products', product: 'official_name', requiredPublicColumns: ['status'], publicWhere: "COALESCE(status, '') NOT IN ('draft', 'pending', 'disabled', 'rejected')" },
];

const queryCacheByDb = new WeakMap();
const CACHE_TTL_MS = 500;
const COMPANY_CACHE_TTL_MS = 30_000;

function clean(value) {
  return String(value || '').trim();
}

function comparable(value) {
  return clean(value).normalize('NFKC').replace(/[\s《》（）()【】\[\]·,，。:：;；、-]/gu, '').toLowerCase();
}

export function catalogProductIdentity(value) {
  return comparable(value).replace(/^[\p{Script=Han}]{2,24}?保险(?:股份)?有限公司/gu, '');
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name || '')));
  } catch {
    return new Set();
  }
}

function availableSources(db, visibility) {
  return CATALOG_TABLES.filter((source) => {
    if (visibility === 'public' && source.public === false) return false;
    const columns = tableColumns(db, source.table);
    const hasPublicColumns = visibility !== 'public'
      || (source.requiredPublicColumns || []).every((column) => columns.has(column));
    return columns.has('company') && columns.has(source.product) && hasPublicColumns;
  });
}

function productDocumentSourceSql(db, visibility) {
  const columns = tableColumns(db, 'product_documents');
  if (!columns.has('payload') || !columns.has('source_authority')) return '';
  if (visibility === 'public' && !columns.has('review_status')) return '';
  const reviewCondition = visibility === 'public' ? " AND documents.review_status = 'published'" : '';
  const validPayload = "CASE WHEN json_valid(documents.payload) THEN documents.payload ELSE '{}' END";
  const baseWhere = `documents.source_authority = 'company_material'${reviewCondition}`;
  return `
    SELECT
      json_extract(${validPayload}, '$.company') AS company,
      product_names.value AS product_name
    FROM product_documents AS documents
    JOIN json_each(
      CASE
        WHEN json_type(${validPayload}, '$.productNames') = 'array'
          THEN json_extract(${validPayload}, '$.productNames')
        ELSE '[]'
      END
    ) AS product_names
    WHERE ${baseWhere}
    UNION ALL
    SELECT
      json_extract(${validPayload}, '$.company') AS company,
      json_extract(${validPayload}, '$.productName') AS product_name
    FROM product_documents AS documents
    WHERE ${baseWhere}
  `;
}

export function catalogSearchTerms(value) {
  const normalized = comparable(value);
  if (!normalized) return [];
  const terms = new Set([normalized]);
  for (let index = 0; index < normalized.length - 1; index += 1) terms.add(normalized.slice(index, index + 2));
  return [...terms].filter((term) => term.length >= 2);
}

export function catalogProductScore(query, productName) {
  const needle = comparable(query);
  const name = comparable(productName);
  if (!needle) return 0;
  if (name === needle) return 1000;
  if (name.includes(needle)) return 800 - Math.max(0, name.length - needle.length);
  const bigrams = catalogSearchTerms(needle).filter((term) => term.length === 2);
  const matchedBigrams = bigrams.filter((term) => name.includes(term)).length;
  const matchedCharacters = [...new Set([...needle])].filter((character) => name.includes(character)).length;
  return matchedBigrams * 40 + matchedCharacters * 4 - Math.min(30, Math.abs(name.length - needle.length));
}

export function rankProductCatalogRows(rows, query, limit = 30) {
  const deduplicated = new Map();
  for (const row of rows || []) {
    const company = clean(row.company);
    const productName = clean(row.productName || row.product_name);
    if (!company || !productName) continue;
    const key = `${company}\u001f${catalogProductIdentity(productName)}`;
    const current = deduplicated.get(key);
    if (!current || Number(row.recordCount || 0) > Number(current.recordCount || 0)) {
      deduplicated.set(key, { ...row, company, productName });
    }
  }
  return [...deduplicated.values()]
    .map((row) => ({ ...row, score: catalogProductScore(query, row.productName) }))
    .sort((left, right) => query
      ? right.score - left.score || left.productName.localeCompare(right.productName, 'zh-CN')
      : Number(right.recordCount || 0) - Number(left.recordCount || 0) || left.productName.localeCompare(right.productName, 'zh-CN'))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 30)));
}

function catalogUnionSql(db, visibility) {
  const sources = availableSources(db, visibility).map((source) => {
    const where = visibility === 'public' && source.publicWhere ? ` WHERE ${source.publicWhere}` : '';
    return `SELECT company, ${source.product} AS product_name FROM ${source.table}${where}`;
  });
  const productDocuments = productDocumentSourceSql(db, visibility);
  if (productDocuments) sources.push(productDocuments);
  return sources.join(' UNION ALL ');
}

function cached(db, key, load, ttlMs = CACHE_TTL_MS) {
  const cache = queryCacheByDb.get(db) || new Map();
  queryCacheByDb.set(db, cache);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.createdAt < ttlMs) return existing.value;
  const value = load();
  cache.set(key, { createdAt: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

export function listProductCatalogCompanies({ db, visibility = 'public' } = {}) {
  if (!db) return [];
  return cached(db, `companies:${visibility}`, () => {
    const union = catalogUnionSql(db, visibility);
    if (!union) return [];
    return db.prepare(`SELECT company, COUNT(*) AS record_count FROM (${union}) WHERE trim(company) != '' GROUP BY company ORDER BY record_count DESC, company`).all()
      .map((row) => ({ company: clean(row.company), recordCount: Number(row.record_count || 0), matchType: 'catalog' }))
      .filter((row) => row.company);
  }, COMPANY_CACHE_TTL_MS);
}

export function searchProductCatalog({ db, company = '', query = '', limit = 30, visibility = 'public' } = {}) {
  if (!db) return [];
  const normalizedCompany = clean(company);
  const normalizedQuery = clean(query);
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 30));
  const key = ['products', visibility, normalizedCompany, normalizedQuery, safeLimit].join(':');
  return cached(db, key, () => {
    const union = catalogUnionSql(db, visibility);
    if (!union) return [];
    const terms = catalogSearchTerms(normalizedQuery);
    const conditions = ["trim(product_name) != ''"];
    const params = [];
    if (normalizedCompany) {
      conditions.push('company = ?');
      params.push(normalizedCompany);
    }
    if (terms.length) {
      conditions.push(`(${terms.map(() => 'product_name LIKE ?').join(' OR ')})`);
      params.push(...terms.map((term) => `%${term}%`));
    }
    const candidateLimit = normalizedQuery ? 1000 : safeLimit;
    const rows = db.prepare(`
      SELECT company, product_name, COUNT(*) AS record_count
      FROM (${union})
      WHERE ${conditions.join(' AND ')}
      GROUP BY company, product_name
      ORDER BY product_name
      LIMIT ?
    `).all(...params, candidateLimit);
    return rankProductCatalogRows(rows.map((row) => ({
      company: row.company,
      productName: row.product_name,
      recordCount: Number(row.record_count || 0),
    })), normalizedQuery, safeLimit);
  });
}
