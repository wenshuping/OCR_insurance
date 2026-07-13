import {
  catalogProductIdentity,
  listProductCatalogCompanies,
  searchProductCatalog,
} from './product-catalog-search.mjs';

const INACTIVE_PRODUCT_STATUSES = ['draft', 'pending', 'disabled', 'rejected'];
const MATCH_TYPES = new Set([
  'exact_official_name',
  'approved_alias',
  'company_scoped_normalized',
  'unique_high_confidence',
]);

function clean(value) {
  return String(value || '').trim();
}

function comparable(value) {
  return clean(value).normalize('NFKC').replace(/[\s《》（）()【】\[\]·,，。:：;；、-]/gu, '').toLowerCase();
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => clean(row.name)));
  } catch {
    return new Set();
  }
}

function parsePayload(value) {
  try {
    const parsed = JSON.parse(clean(value) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicProductRows(db) {
  const columns = tableColumns(db, 'insurance_products');
  if (!columns.has('company') || !columns.has('official_name')) return [];
  const canonicalId = columns.has('canonical_product_id') ? 'canonical_product_id' : "''";
  const payload = columns.has('payload') ? 'payload' : "'{}'";
  const statusWhere = columns.has('status')
    ? `WHERE COALESCE(status, '') NOT IN (${INACTIVE_PRODUCT_STATUSES.map(() => '?').join(', ')})`
    : '';
  return db.prepare(`
    SELECT ${canonicalId} AS canonical_product_id, company, official_name, ${payload} AS payload
    FROM insurance_products
    ${statusWhere}
    ORDER BY company, official_name
  `).all(...(statusWhere ? INACTIVE_PRODUCT_STATUSES : [])).map((row) => ({
    canonicalProductId: clean(row.canonical_product_id),
    company: clean(row.company),
    officialName: clean(row.official_name),
    payload: parsePayload(row.payload),
  })).filter((row) => row.company && row.officialName);
}

function companyAliases(profile) {
  return [
    profile?.company,
    profile?.companyName,
    profile?.name,
    ...(Array.isArray(profile?.aliases) ? profile.aliases : []),
    ...(Array.isArray(profile?.companyAliases) ? profile.companyAliases : []),
  ].map(clean).filter(Boolean);
}

function resolveCompany(insurerText, companies, officialDomainProfiles) {
  if (!insurerText) return '';
  const target = comparable(insurerText);
  const exact = companies.filter((company) => comparable(company) === target);
  if (exact.length === 1) return exact[0];

  const matched = [];
  for (const profile of officialDomainProfiles) {
    if (!companyAliases(profile).some((alias) => comparable(alias) === target)) continue;
    const profileCompanies = companyAliases(profile)
      .flatMap((alias) => companies.filter((company) => comparable(company) === comparable(alias)));
    matched.push(...profileCompanies);
  }
  const unique = [...new Set(matched)];
  return unique.length === 1 ? unique[0] : null;
}

function approvedAliases(product) {
  if (clean(product.payload?.aliasReviewStatus) !== 'approved') return [];
  return (Array.isArray(product.payload?.aliases) ? product.payload.aliases : []).map(clean).filter(Boolean);
}

function canonicalProductForCatalogRow(row, products) {
  const identity = catalogProductIdentity(row.productName);
  return products.find((product) => product.company === row.company
    && catalogProductIdentity(product.officialName) === identity) || null;
}

function matchCandidate({ company, officialName, canonicalProductId = '', payload = {}, score = 0 }, productText) {
  const target = comparable(productText);
  const official = comparable(officialName);
  const targetIdentity = catalogProductIdentity(productText);
  const officialIdentity = catalogProductIdentity(officialName);
  let matchType = 'unique_high_confidence';
  let confidence = Math.max(0, Math.min(1, Number(score || 0) / 1000));

  if (official === target) {
    matchType = 'exact_official_name';
    confidence = 1;
  } else if (approvedAliases({ payload }).some((alias) => comparable(alias) === target)) {
    matchType = 'approved_alias';
    confidence = 1;
  } else if (targetIdentity && officialIdentity
    && (officialIdentity === targetIdentity || officialIdentity.includes(targetIdentity))) {
    matchType = 'company_scoped_normalized';
    confidence = 1;
  }

  return {
    canonicalProductId: clean(canonicalProductId),
    company: clean(company),
    officialName: clean(officialName),
    matchType,
    confidence,
  };
}

function boundedActiveProduct(activeProduct) {
  if (!activeProduct || typeof activeProduct !== 'object' || Array.isArray(activeProduct)) return null;
  const officialName = clean(activeProduct.officialName);
  const company = clean(activeProduct.company);
  if (!officialName || !company) return null;
  const matchType = MATCH_TYPES.has(activeProduct.matchType)
    ? activeProduct.matchType
    : 'exact_official_name';
  const confidence = Number(activeProduct.confidence);
  return {
    canonicalProductId: clean(activeProduct.canonicalProductId),
    company,
    officialName,
    matchType,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 1,
  };
}

function emptyResult(status) {
  return { status, entity: null, candidates: [] };
}

function mentionText(mentions, type) {
  const mention = (Array.isArray(mentions) ? mentions : []).find((item) => item?.type === type);
  return clean(mention?.rawText);
}

export function createAgentProductEntityResolver({ db, officialDomainProfiles = [] } = {}) {
  if (!db) throw new TypeError('db is required');
  const profiles = Array.isArray(officialDomainProfiles) ? officialDomainProfiles : [];

  return {
    resolve({ mentions = [], activeProduct = null } = {}) {
      const productText = mentionText(mentions, 'product');
      if (!productText) {
        const entity = boundedActiveProduct(activeProduct);
        return entity ? { status: 'resolved', entity, candidates: [] } : emptyResult('missing');
      }

      const insurerText = mentionText(mentions, 'insurer');
      const companies = listProductCatalogCompanies({ db, visibility: 'public' }).map((row) => row.company);
      const company = resolveCompany(insurerText, companies, profiles);
      if (insurerText && company === null) return emptyResult('not_found');

      const products = publicProductRows(db);
      const recalled = searchProductCatalog({
        db,
        company: company || '',
        query: productText,
        limit: 20,
        visibility: 'public',
      });
      const candidates = recalled.map((row) => {
        const canonical = canonicalProductForCatalogRow(row, products);
        return matchCandidate({
          company: canonical?.company || row.company,
          officialName: canonical?.officialName || row.productName,
          canonicalProductId: canonical?.canonicalProductId,
          payload: canonical?.payload,
          score: row.score,
        }, productText);
      });

      for (const product of products) {
        if (company && product.company !== company) continue;
        if (!approvedAliases(product).some((alias) => comparable(alias) === comparable(productText))) continue;
        if (candidates.some((candidate) => candidate.company === product.company
          && catalogProductIdentity(candidate.officialName) === catalogProductIdentity(product.officialName))) continue;
        candidates.push(matchCandidate(product, productText));
      }

      const ranked = candidates
        .filter((candidate) => candidate.confidence > 0)
        .sort((left, right) => right.confidence - left.confidence)
        .slice(0, 10);
      if (!ranked.length) return emptyResult('not_found');
      const first = ranked[0];
      const second = ranked[1];
      if (first.confidence >= 0.9 && (!second || first.confidence - second.confidence >= 0.15)) {
        return { status: 'resolved', entity: first, candidates: [] };
      }
      return { status: 'ambiguous', entity: null, candidates: ranked };
    },
  };
}
