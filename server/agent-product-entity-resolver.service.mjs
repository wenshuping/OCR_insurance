import {
  catalogProductIdentity,
  listProductCatalogCompanies,
  searchProductCatalog,
} from './product-catalog-search.mjs';

const MATCH_TYPES = new Set([
  'exact_official_name',
  'filing_name',
  'approved_alias',
  'company_scoped_normalized',
  'unique_high_confidence',
]);
const MATCH_TYPE_PRIORITY = new Map([
  ['exact_official_name', 0],
  ['filing_name', 1],
  ['approved_alias', 2],
  ['company_scoped_normalized', 3],
  ['unique_high_confidence', 4],
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
  const productCode = columns.has('product_code') ? 'product_code' : "''";
  const payload = columns.has('payload') ? 'payload' : "'{}'";
  const statusWhere = "WHERE LOWER(TRIM(COALESCE(status, ''))) = 'active'";
  return db.prepare(`
    SELECT ${canonicalId} AS canonical_product_id, company, official_name,
      ${productCode} AS product_code, ${payload} AS payload
    FROM insurance_products
    ${statusWhere}
    ORDER BY company, official_name
  `).all().map((row) => ({
    canonicalProductId: clean(row.canonical_product_id),
    company: clean(row.company),
    officialName: clean(row.official_name),
    productCode: clean(row.product_code),
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

function filingIdentifiers(product) {
  return [
    ...filingNames(product),
    product.productCode,
    product.payload?.clauseCode,
  ].map(clean).filter(Boolean);
}

function exactFilingCandidates(products, productText, company) {
  const target = comparable(productText);
  const candidates = [];
  const seen = new Set();
  for (const product of products) {
    if (company && product.company !== company) continue;
    if (!filingIdentifiers(product).some((value) => comparable(value) === target)) continue;
    const key = [product.canonicalProductId, product.company, product.officialName].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      canonicalProductId: product.canonicalProductId,
      company: product.company,
      officialName: product.officialName,
      matchType: product.canonicalProductId ? 'filing_name' : 'unique_high_confidence',
      confidence: product.canonicalProductId ? 1 : HEURISTIC_CONFIDENCE_CEILING,
    });
  }
  return candidates;
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
  const canonicalProductId = clean(activeProduct.canonicalProductId);
  if (!officialName || !company || !canonicalProductId) return null;
  const matchType = MATCH_TYPES.has(activeProduct.matchType)
    ? activeProduct.matchType
    : 'exact_official_name';
  const confidence = Number(activeProduct.confidence);
  return {
    canonicalProductId,
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

function insurerCompaniesInQuestion({ normalizedQuestion, companies, officialDomainProfiles }) {
  const resolved = new Set();
  const terms = [
    ...companies,
    ...officialDomainProfiles.flatMap((profile) => companyAliases(profile)),
  ];
  for (const value of new Set(terms)) {
    const normalized = comparable(value);
    if ([...normalized].length < 2 || SCAN_DENYLIST.has(normalized)) continue;
    if (!normalizedQuestion.includes(normalized)) continue;
    const company = resolveCompany(value, companies, officialDomainProfiles);
    if (company) resolved.add(company);
  }
  return resolved;
}

export function createAgentProductEntityResolver({ db, officialDomainProfiles = [] } = {}) {
  if (!db) throw new TypeError('db is required');
  const profiles = Array.isArray(officialDomainProfiles) ? officialDomainProfiles : [];

  return {
    resolveAllFromText({ question, insurerMentions = [] } = {}) {
      const normalizedQuestion = comparable(clean(question).slice(0, 1_000));
      if (!normalizedQuestion) return { entities: [], overflow: false };
      const companies = listProductCatalogCompanies({ db, visibility: 'public' }).map((row) => row.company);
      const mentionedCompanies = insurerCompaniesInQuestion({
        normalizedQuestion,
        companies,
        officialDomainProfiles: profiles,
      });
      for (const mention of (Array.isArray(insurerMentions) ? insurerMentions : [])) {
        if (mention?.type !== 'insurer') continue;
        const insurerText = clean(mention.rawText);
        if (!insurerText || insurerText.length > 200) {
          return { entities: [], overflow: false, invalid: true, status: 'invalid_insurer' };
        }
        const company = resolveCompany(insurerText, companies, profiles);
        if (!company) return { entities: [], overflow: false, invalid: true, status: 'invalid_insurer' };
        mentionedCompanies.add(company);
      }

      const matches = [];
      for (const product of publicProductRows(db)) {
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
              normalizedTerm: normalized,
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

      const occurrenceCompanies = new Map();
      for (const match of matches) {
        const key = `${match.start}:${match.end}:${match.normalizedTerm}`;
        if (!occurrenceCompanies.has(key)) occurrenceCompanies.set(key, new Set());
        occurrenceCompanies.get(key).add(match.entity.company);
      }
      const scopedMatches = matches.filter((match) => {
        if (mentionedCompanies.size !== 1) return true;
        const key = `${match.start}:${match.end}:${match.normalizedTerm}`;
        if (occurrenceCompanies.get(key).size < 2) return true;
        return mentionedCompanies.has(match.entity.company);
      });

      const retained = [];
      for (const match of scopedMatches.sort((left, right) => (
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
      const exactFiling = exactFilingCandidates(products, productText, company);
      if (exactFiling.length === 1 && exactFiling[0].confidence === 1) {
        return { status: 'resolved', entity: exactFiling[0], candidates: [] };
      }
      if (exactFiling.length) {
        return { status: 'ambiguous', entity: null, candidates: exactFiling.slice(0, 10) };
      }
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
        if (!canonical?.canonicalProductId && !canonicalMatch.identityConflict) return null;
        return matchCandidate({
          company: canonical?.company || row.company,
          officialName: canonical?.officialName || row.productName,
          canonicalProductId: canonical?.canonicalProductId,
          payload: canonical?.payload,
          score: row.score,
          identityConflict: canonicalMatch.identityConflict,
        }, productText);
      }).filter(Boolean);

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
