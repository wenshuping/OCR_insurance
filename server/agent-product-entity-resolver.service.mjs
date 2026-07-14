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
const MATCH_TYPE_PRIORITY = new Map([
  ['exact_official_name', 0],
  ['approved_alias', 1],
  ['company_scoped_normalized', 2],
  ['unique_high_confidence', 3],
]);
const HEURISTIC_CONFIDENCE_CEILING = 0.89;
const SCAN_DENYLIST = new Set([
  '保险', '产品', '险种', '寿险', '重疾险', '医疗险', '年金险', '意外险', '两全', '两全保险',
]);

function clean(value) {
  return String(value || '').trim();
}

function comparable(value) {
  return clean(value).normalize('NFKC').replace(/[\s《》（）()【】\[\]·,，。:：;；、-]/gu, '').toLowerCase();
}

function companyIdentity(value) {
  const withoutOrganization = comparable(value)
    .replace(/(?:股份有限公司|有限责任公司|有限公司|股份公司|公司)$/gu, '');
  return withoutOrganization.endsWith('再保险')
    ? withoutOrganization
    : withoutOrganization.replace(/保险$/gu, '');
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
  if (!columns.has('company') || !columns.has('official_name') || !columns.has('status')) return [];
  const canonicalId = columns.has('canonical_product_id') ? 'canonical_product_id' : "''";
  const payload = columns.has('payload') ? 'payload' : "'{}'";
  const statusWhere = `WHERE COALESCE(status, '') NOT IN (${INACTIVE_PRODUCT_STATUSES.map(() => '?').join(', ')})`;
  return db.prepare(`
    SELECT ${canonicalId} AS canonical_product_id, company, official_name, ${payload} AS payload
    FROM insurance_products
    ${statusWhere}
    ORDER BY company, official_name
  `).all(...INACTIVE_PRODUCT_STATUSES).map((row) => ({
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
  const normalized = companies.filter((company) => companyIdentity(company) === companyIdentity(insurerText));
  if (normalized.length === 1) return normalized[0];

  const matched = [];
  for (const profile of officialDomainProfiles) {
    if (!companyAliases(profile).some((alias) => (
      comparable(alias) === target || companyIdentity(alias) === companyIdentity(insurerText)
    ))) continue;
    const profileCompanies = companyAliases(profile)
      .flatMap((alias) => companies.filter((company) => (
        comparable(company) === comparable(alias) || companyIdentity(company) === companyIdentity(alias)
      )));
    matched.push(...profileCompanies);
  }
  const unique = [...new Set(matched)];
  return unique.length === 1 ? unique[0] : null;
}

function approvedAliases(product) {
  if (clean(product.payload?.aliasReviewStatus) !== 'approved') return [];
  return (Array.isArray(product.payload?.aliases) ? product.payload.aliases : []).map(clean).filter(Boolean);
}

function filingNames(product) {
  // These names are trusted only from the payload of an authoritative, active
  // insurance_products row selected by publicProductRows().
  return [
    product.payload?.filingName,
    ...(Array.isArray(product.payload?.filingNames) ? product.payload.filingNames : []),
  ].map(clean).filter(Boolean);
}

function termOccurrences(question, term) {
  const occurrences = [];
  let start = question.indexOf(term);
  while (start !== -1) {
    occurrences.push({ start, end: start + term.length });
    start = question.indexOf(term, start + 1);
  }
  return occurrences;
}

function scannableTerm(value, { approved = false } = {}) {
  const normalized = comparable(value);
  if (!normalized || SCAN_DENYLIST.has(normalized)) return '';
  return [...normalized].length >= (approved ? 2 : 4) ? normalized : '';
}

function canonicalProductForCatalogRow(row, products) {
  const identity = catalogProductIdentity(row.productName);
  const matches = products.filter((product) => product.company === row.company
    && catalogProductIdentity(product.officialName) === identity);
  const canonicalIds = new Set(matches.map((product) => product.canonicalProductId).filter(Boolean));
  return {
    product: matches.find((product) => product.canonicalProductId) || matches[0] || null,
    identityConflict: canonicalIds.size > 1,
  };
}

function matchCandidate({
  company,
  officialName,
  canonicalProductId = '',
  payload = {},
  score = 0,
  identityConflict = false,
}, productText) {
  const target = comparable(productText);
  const official = comparable(officialName);
  const targetIdentity = catalogProductIdentity(productText);
  const officialIdentity = catalogProductIdentity(officialName);
  let matchType = 'unique_high_confidence';
  let confidence = Math.max(0, Math.min(HEURISTIC_CONFIDENCE_CEILING, Number(score || 0) / 1000));

  if (official === target) {
    matchType = 'exact_official_name';
    confidence = 1;
  } else if (approvedAliases({ payload }).some((alias) => comparable(alias) === target)) {
    matchType = 'approved_alias';
    confidence = 1;
  } else if (targetIdentity && officialIdentity && officialIdentity === targetIdentity) {
    matchType = 'company_scoped_normalized';
    confidence = 1;
  }

  if (identityConflict) {
    canonicalProductId = '';
    matchType = 'unique_high_confidence';
    confidence = HEURISTIC_CONFIDENCE_CEILING;
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
    resolveAllFromText({ question, insurerMentions = [] } = {}) {
      const normalizedQuestion = comparable(clean(question).slice(0, 1_000));
      if (!normalizedQuestion) return { entities: [], overflow: false };
      const insurerText = mentionText(insurerMentions, 'insurer');
      if (insurerText.length > 200) return { entities: [], overflow: false };

      const companies = listProductCatalogCompanies({ db, visibility: 'public' }).map((row) => row.company);
      const company = resolveCompany(insurerText, companies, profiles);
      if (insurerText && company === null) return { entities: [], overflow: false };

      const matches = [];
      for (const product of publicProductRows(db)) {
        if (company && product.company !== company) continue;
        const officialIdentity = catalogProductIdentity(product.officialName);
        const hasSpecificOfficialIdentity = Boolean(scannableTerm(officialIdentity));
        const terms = [
          ...(hasSpecificOfficialIdentity ? [
            { value: product.officialName, matchType: 'exact_official_name' },
            { value: officialIdentity, matchType: 'company_scoped_normalized' },
          ] : []),
          ...filingNames(product).map((value) => ({ value, matchType: 'filing_name' })),
          ...approvedAliases(product).map((value) => ({ value, matchType: 'approved_alias', approved: true })),
        ];
        const canonicalProductId = clean(product.canonicalProductId);
        if (!canonicalProductId) continue;
        for (const term of terms) {
          const normalized = scannableTerm(term.value, { approved: term.approved });
          if (!normalized) continue;
          for (const span of termOccurrences(normalizedQuestion, normalized)) {
            matches.push({
              ...span,
              termLength: normalized.length,
              entity: {
                canonicalProductId,
                company: product.company,
                officialName: product.officialName,
                matchType: term.matchType,
                confidence: 1,
              },
            });
          }
        }
      }

      const retained = [];
      for (const match of matches.sort((left, right) => (
        right.termLength - left.termLength || left.start - right.start || left.end - right.end
      ))) {
        const containedByLonger = retained.some((candidate) => (
          candidate.entity.canonicalProductId !== match.entity.canonicalProductId
          && candidate.termLength > match.termLength
          && candidate.start <= match.start
          && candidate.end >= match.end
        ));
        if (!containedByLonger) retained.push(match);
      }

      const entities = [];
      const seen = new Set();
      for (const match of retained.sort((left, right) => (
        left.start - right.start || right.termLength - left.termLength
      ))) {
        if (seen.has(match.entity.canonicalProductId)) continue;
        seen.add(match.entity.canonicalProductId);
        entities.push(match.entity);
        if (entities.length > 8) return { entities: entities.slice(0, 8), overflow: true };
      }
      return { entities, overflow: false };
    },

    resolve({ mentions = [], activeProduct = null } = {}) {
      const productText = mentionText(mentions, 'product');
      const insurerText = mentionText(mentions, 'insurer');
      if (!productText) {
        const entity = boundedActiveProduct(activeProduct);
        if (!entity) return emptyResult('missing');
        if (insurerText) {
          const companies = listProductCatalogCompanies({ db, visibility: 'public' }).map((row) => row.company);
          const mentionedCompany = resolveCompany(insurerText, companies, profiles);
          const activeCompany = resolveCompany(entity.company, companies, profiles);
          if (!mentionedCompany || !activeCompany || mentionedCompany !== activeCompany) {
            return emptyResult('not_found');
          }
        }
        return { status: 'resolved', entity, candidates: [] };
      }

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
        const canonicalMatch = canonicalProductForCatalogRow(row, products);
        const canonical = canonicalMatch.product;
        return matchCandidate({
          company: canonical?.company || row.company,
          officialName: canonical?.officialName || row.productName,
          canonicalProductId: canonical?.canonicalProductId,
          payload: canonical?.payload,
          score: row.score,
          identityConflict: canonicalMatch.identityConflict,
        }, productText);
      });

      for (const product of products) {
        if (company && product.company !== company) continue;
        if (!approvedAliases(product).some((alias) => comparable(alias) === comparable(productText))) continue;
        if (candidates.some((candidate) => candidate.company === product.company
          && catalogProductIdentity(candidate.officialName) === catalogProductIdentity(product.officialName))) continue;
        const canonicalMatch = canonicalProductForCatalogRow({
          company: product.company,
          productName: product.officialName,
        }, products);
        candidates.push(matchCandidate({
          ...(canonicalMatch.product || product),
          identityConflict: canonicalMatch.identityConflict,
        }, productText));
      }

      const ranked = candidates
        .filter((candidate) => candidate.confidence > 0)
        .map((candidate, index) => ({ candidate, index }))
        .sort((left, right) => (
          (MATCH_TYPE_PRIORITY.get(left.candidate.matchType) ?? Number.MAX_SAFE_INTEGER)
            - (MATCH_TYPE_PRIORITY.get(right.candidate.matchType) ?? Number.MAX_SAFE_INTEGER)
          || right.candidate.confidence - left.candidate.confidence
          || left.index - right.index
        ))
        .slice(0, 10);
      if (!ranked.length) return emptyResult('not_found');
      const rankedCandidates = ranked.map((item) => item.candidate);
      const first = rankedCandidates[0];
      const second = rankedCandidates[1];
      if (first.confidence >= 0.9 && (!second || first.confidence - second.confidence >= 0.15)) {
        return { status: 'resolved', entity: first, candidates: [] };
      }
      return { status: 'ambiguous', entity: null, candidates: rankedCandidates };
    },
  };
}
