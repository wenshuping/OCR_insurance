import express from 'express';
import { sendError } from '../http/errors.mjs';
import {
  indicatorsFromResponsibilityCards,
  knowledgeRecordsFromResponsibilityAnalysis,
  materializeResponsibilityCardRows,
} from '../responsibility-lookup-artifacts.mjs';
import {
  EXTERNAL_REFERENCE_EVIDENCE_LABEL,
  EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
  evidenceVerificationFields,
} from '../evidence-classification.service.mjs';
import {
  productIdentityMatches,
  responsibilityCompanyIdentity,
} from '../product-responsibility-identity.mjs';
import { loadProjectionKnowledgeRecordsForPolicy } from '../policy-knowledge-projection.mjs';
import { standardizeResponsibilityIndicator } from '../responsibility-card-standardizer.mjs';

function uniqueSourceIdentityValues(values = []) {
  return [...new Set(values.map(trim).filter(Boolean))];
}

export function boundOfficialSourceIdentityForPolicy(policy = {}) {
  const responsibilitySources = [
    ...(Array.isArray(policy?.responsibilities) ? policy.responsibilities : []),
    ...(Array.isArray(policy?.optionalResponsibilities) ? policy.optionalResponsibilities : []),
  ];
  const responsibilityUrls = uniqueSourceIdentityValues(responsibilitySources.map((item) => item?.sourceUrl));
  const responsibilityDigests = uniqueSourceIdentityValues(responsibilitySources.map((item) => (
    item?.sourceDigest || item?.responsibilitySourceDigest
  )));
  if (responsibilityUrls.length === 1) {
    return {
      sourceUrl: responsibilityUrls[0],
      ...(responsibilityDigests.length === 1 ? { sourceDigest: responsibilityDigests[0] } : {}),
    };
  }

  const explicitlyBoundSources = (Array.isArray(policy?.sources) ? policy.sources : [])
    .filter((source) => /当前保单已绑定/u.test(trim(source?.snippet)));
  const explicitlyBoundUrls = uniqueSourceIdentityValues(explicitlyBoundSources.map((source) => (
    source?.url || source?.sourceUrl || source?.officialUrl
  )));
  if (explicitlyBoundUrls.length === 1) return { sourceUrl: explicitlyBoundUrls[0] };

  const directUrls = uniqueSourceIdentityValues([
    policy?.officialPdfUrl,
    policy?.sourceUrl,
    policy?.clauseUrl,
  ]);
  return directUrls.length === 1 ? { sourceUrl: directUrls[0] } : null;
}

function trim(value) {
  return String(value || '').trim();
}

function compact(value) {
  return trim(value).normalize('NFKC').replace(/\s+/gu, '');
}

function comparableProductName(value) {
  return trim(value).replace(/[\s《》（）()【】\[\]·,，。:：;；、-]/gu, '');
}

function productNameMatchesQuery(candidate, query) {
  const normalizedCandidate = comparableProductName(candidate);
  const normalizedQuery = comparableProductName(query);
  if (!normalizedCandidate || !normalizedQuery) return false;
  return normalizedCandidate === normalizedQuery
    || normalizedCandidate.includes(normalizedQuery)
    || normalizedQuery.includes(normalizedCandidate);
}

function positiveIntegerOrFallback(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.round(number), max);
}

function scoreThresholdOrFallback(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function booleanFromBody(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isCustomerUploadRecord(record = {}) {
  return ['customer_policy_photo', 'customer_policy_terms'].includes(trim(record.sourceKind || record.source_kind));
}

function ownerMatches(record = {}, { userId = null, guestId = '' } = {}) {
  if (userId) return Number(record.ownerUserId || 0) === Number(userId);
  return Boolean(guestId)
    && !Number(record.ownerUserId || 0)
    && trim(record.ownerGuestId) === guestId;
}

function nowMs() {
  return Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, nowMs() - startedAt);
}

function responsibilityCardProjectionQuality(cards = []) {
  return (Array.isArray(cards) ? cards : []).reduce((score, card) => {
    const indicators = Array.isArray(card?.indicators) ? card.indicators : [];
    const status = trim(card?.calculationStatus || card?.calculation_status);
    const hasFormula = indicators.some((indicator) => trim(
      indicator?.formulaText || indicator?.formula || indicator?.normalizedFormula,
    ));
    return score
      + (trim(card?.title) ? 1 : 0)
      + indicators.length * 4
      + (hasFormula ? 3 : 0)
      + (['calculable', 'needs_table', 'claim_contingent', 'waiver_only'].includes(status) ? 1 : 0);
  }, 0);
}

export function selectResponsibilityCardProjection(existingCards = [], rebuiltCards = []) {
  const existing = Array.isArray(existingCards) ? existingCards : [];
  const rebuilt = Array.isArray(rebuiltCards) ? rebuiltCards : [];
  if (!rebuilt.length) return existing;
  return responsibilityCardProjectionQuality(rebuilt) > responsibilityCardProjectionQuality(existing)
    ? rebuilt
    : existing;
}

export function refreshExistingResponsibilityCardProjection(card = {}, policy = {}) {
  const originalIndicators = Array.isArray(card?.indicators) ? card.indicators : [];
  if (!originalIndicators.length) return card;
  const indicators = originalIndicators.map((indicator) => standardizeResponsibilityIndicator(indicator, { policy }));
  const primary = indicators.find((indicator) => compact(indicator?.liability) === compact(card?.title)) || indicators[0];
  const policyParameterBranch = indicators.some((indicator) => (
    trim(indicator?.branchSemanticContract) === 'official-policy-parameter-branches'
      && trim(indicator?.cashflowTreatment) === 'scheduled_cashflow'
  ));
  const payoutSummary = trim(card?.payoutSummary);
  const legacyPayoutSummary = !payoutSummary || /^(?:条款载明基准|以正式条款为准)$/u.test(payoutSummary);
  return {
    ...card,
    indicators,
    ...(legacyPayoutSummary && trim(primary?.formulaText) ? { payoutSummary: trim(primary.formulaText) } : {}),
    ...(policyParameterBranch ? {
      cashflowTreatment: 'scheduled_cashflow',
      calculationStatus: 'calculable',
      calculationReason: '',
    } : {}),
  };
}

export function createResponsibilityRoutes(context) {
  const router = express.Router();
  const {
    state,
    performanceLogger,
    logPerformance,
    assistantAnalyzer,
    normalizeResponsibilityQueryInput,
    normalizePolicyScanData,
    normalizePolicyPlans,
    normalizeOptionalResponsibilities,
    buildRecognizedPolicyAnalysisDraft,
    buildEffectiveOfficialDomainProfiles,
    buildKnowledgeSearchArtifacts,
    buildResponsibilitySummaryReportFromCards,
    buildResponsibilityCardsForPolicy,
    isGeneratedResponsibilityCountReport,
    mergeCoverageTableWithCheckedRows,
    responsibilityRowsFromCards,
    findPolicyCoverageIndicators,
    buildResponsibilityCompanySuggestions,
    buildResponsibilityProductSuggestions,
    findKnowledgeProductCandidates,
    legacyExternalProductReferenceRecords,
    withPolicyProductMatchStatus,
    crawlOfficialKnowledge,
    knowledgeFetchImpl,
    onlineResponsibilityProductMatcher,
    externalReferenceProductMatcher,
    upsertKnowledgeRecords,
    persistResponsibilityLookupArtifacts,
    allocateId,
    db,
    loadKnowledgeRecords,
    findProductCustomerResponsibilitySummary,
    persistProductCustomerResponsibilitySummary,
    persistProductCustomerSummaryGenerationRun,
    enqueueProductResponsibilityPipeline,
    generateProductCustomerResponsibilitySummary,
    buildCustomerResponsibilitySummaryFromCards,
    enrichCustomerResponsibilitySummaryWithMaterials,
    generateProductCustomerResponsibilitySummaryWithDeepSeek,
    generateCustomerResponsibilityMaterialSummaryWithDeepSeek,
    generateProductCustomerResponsibilityPlannerWithDeepSeek,
    retrieveCustomerResponsibilityMaterials,
    registerResponsibilityAssistantQuery,
    registerResponsibilityAssistantProductMatch,
    registerCustomerResponsibilitySummaryQuery,
    normalizeGuestId,
    resolveAuthUser,
  } = context;

  function responsibilityReportFor({ current = '', rows = [], cards = [], optionalResponsibilities = [] } = {}) {
    const existing = String(current || '').trim();
    const cardReport = typeof buildResponsibilitySummaryReportFromCards === 'function'
      ? buildResponsibilitySummaryReportFromCards(cards, { optionalResponsibilities })
      : '';
    const generatedCountReport = typeof isGeneratedResponsibilityCountReport === 'function'
      && isGeneratedResponsibilityCountReport(existing);
    const legacyCardReport = Boolean(existing && cardReport && existing === cardReport);
    return existing && !generatedCountReport && !legacyCardReport ? existing : '';
  }

  function filteredKnowledgeRecordsForPolicy(policyDraft) {
    if (typeof buildKnowledgeSearchArtifacts !== 'function') return [];
    return buildKnowledgeSearchArtifacts({
      policy: policyDraft,
      records: state?.knowledgeRecords || [],
      officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
    }).records || [];
  }

  function projectionKnowledgeRecordsForPolicy(policyDraft) {
    const filtered = filteredKnowledgeRecordsForPolicy(policyDraft);
    const stateRecords = (state?.knowledgeRecords || []).filter((record) => (
      productIdentityMatches(record, policyDraft)
      && (trim(record?.url) || trim(record?.pageText) || trim(record?.snippet))
    ));
    return loadProjectionKnowledgeRecordsForPolicy({
      db,
      policy: policyDraft,
      filteredRecords: filtered,
      stateRecords,
    });
  }

  function withFallbackCardSources(cards = [], policyDraft = {}) {
    if (
      Array.isArray(cards) &&
      cards.length &&
      cards.every((card) => trim(card?.sourceUrl) && trim(card?.sourceExcerpt))
    ) {
      return cards;
    }
    const filteredKnowledge = filteredKnowledgeRecordsForPolicy(policyDraft);
    const knowledge = filteredKnowledge.find((record) => trim(record?.url) || trim(record?.pageText) || trim(record?.snippet))
      || (state?.knowledgeRecords || []).find((record) => {
        const company = compact(policyDraft.company);
        const productName = compact(policyDraft.name || policyDraft.productName);
        const recordCompany = compact(record?.company);
        const recordProductName = compact(record?.productName || record?.name);
        return (
          company &&
          productName &&
          recordCompany === company &&
          (recordProductName === productName || recordProductName.includes(productName) || productName.includes(recordProductName)) &&
          (trim(record?.url) || trim(record?.pageText) || trim(record?.snippet))
        );
      });
    if (!knowledge) return cards;
    return (Array.isArray(cards) ? cards : []).map((card) => {
      if (trim(card?.sourceUrl) && trim(card?.sourceExcerpt)) return card;
      const sourceUrl = trim(card?.sourceUrl) || trim(knowledge.url);
      const sourceTitle = trim(card?.sourceTitle) || trim(knowledge.title);
      const sourceExcerpt = trim(card?.sourceExcerpt) || trim(knowledge.pageText) || trim(knowledge.snippet);
      const evidence = evidenceVerificationFields({
        ...knowledge,
        sourceKind: card?.sourceKind || knowledge.sourceKind,
        evidenceLevel: card?.evidenceLevel || knowledge.evidenceLevel,
        referenceOnly: card?.referenceOnly === true || knowledge.referenceOnly === true,
      });
      return {
        ...card,
        sourceUrl,
        sourceTitle,
        sourceExcerpt,
        sourceKind: card?.sourceKind || knowledge.sourceKind,
        evidenceLabel: card?.evidenceLabel || knowledge.evidenceLabel,
        evidenceLevel: card?.evidenceLevel || knowledge.evidenceLevel,
        verificationStatus: card?.verificationStatus || evidence.verificationStatus,
        verificationLabel: card?.verificationLabel || evidence.verificationLabel,
        referenceOnly: card?.referenceOnly === true || evidence.referenceOnly,
        official: card?.official === true || knowledge.official === true,
        confidence: sourceUrl && sourceExcerpt && card?.confidence === 'low' ? 'medium' : card?.confidence,
      };
    });
  }

  function productNameFromResponsibilityCardRow(row = {}) {
    const payload = parseJsonObject(row?.payload);
    return trim(row?.product_name || payload.productName || payload.product_name || row?.name || row?.title);
  }

  function cardFromProductResponsibilityRow(row = {}) {
    const payload = parseJsonObject(row?.payload);
    const indicators = Array.isArray(payload.indicators) ? payload.indicators : [];
    const indicatorSourceDigests = new Set(indicators
      .map((indicator) => trim(indicator?.sourceDigest || indicator?.source_digest || indicator?.responsibilitySourceDigest))
      .filter(Boolean));
    return {
      ...payload,
      id: trim(row.id || payload.id),
      productKey: trim(row.product_key || payload.productKey || payload.product_key),
      canonicalProductId: trim(payload.canonicalProductId || payload.canonical_product_id),
      company: trim(row.company || payload.company),
      productName: trim(row.product_name || payload.productName || payload.product_name),
      title: trim(row.title || payload.title),
      category: trim(row.category || payload.category),
      sourceUrl: trim(row.source_url || payload.sourceUrl || payload.source_url),
      sourceTitle: trim(payload.sourceTitle || payload.source_title),
      sourceExcerpt: trim(payload.sourceExcerpt || payload.source_excerpt),
      sourceDigest: trim(
        row.source_digest
        || payload.sourceDigest
        || payload.source_digest
        || payload.responsibilitySourceDigest
        || (indicatorSourceDigests.size === 1 ? [...indicatorSourceDigests][0] : ''),
      ),
      indicators,
    };
  }

  function cardsFromProductResponsibilityRows(rows = [], { company, productName, productKey, canonicalProductId } = {}) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => cardFromProductResponsibilityRow(row))
      .filter((card) => {
        const hasProductColumns = trim(card.company) || trim(card.productName);
        return (
          trim(card.title) &&
          (
            (responsibilityCompanyIdentity(card.company) === responsibilityCompanyIdentity(company)
              && productNameMatchesQuery(card.productName, productName)) ||
            (canonicalProductId && trim(card.canonicalProductId) === canonicalProductId) ||
            (!hasProductColumns && trim(card.productKey) === productKey)
          )
        );
      });
  }

  function loadExistingProductResponsibilityCards(policyDraft = {}) {
    const company = trim(policyDraft.company);
    const productName = trim(policyDraft.name || policyDraft.productName);
    const canonicalProductId = trim(policyDraft.canonicalProductId);
    if (!db || !company || !productName) return [];
    const productKey = canonicalProductId
      ? `canonical:${canonicalProductId}`
      : `company_product:${company}:${productName}`;
    try {
      if (canonicalProductId) {
        const canonicalRows = db.prepare(`
          SELECT *
          FROM product_responsibility_cards
          WHERE product_key = ?
          ORDER BY title ASC, id ASC
        `).all(productKey);
        const canonicalCards = cardsFromProductResponsibilityRows(canonicalRows, {
          company, productName, productKey, canonicalProductId,
        });
        if (canonicalCards.length) return canonicalCards;
      }
      const companyNames = new Set([company]);
      if (typeof buildEffectiveOfficialDomainProfiles === 'function') {
        const companyIdentity = responsibilityCompanyIdentity(company);
        for (const profile of buildEffectiveOfficialDomainProfiles(state) || []) {
          const aliases = [
            profile?.company,
            ...(Array.isArray(profile?.aliases) ? profile.aliases : []),
            ...(Array.isArray(profile?.companyAliases) ? profile.companyAliases : []),
          ].map(trim).filter(Boolean);
          if (aliases.some((alias) => responsibilityCompanyIdentity(alias) === companyIdentity)) {
            aliases.forEach((alias) => companyNames.add(alias));
          }
        }
      }
      const legalCompanyPrefix = productName.match(
        /^[\u4e00-\u9fff]{2,12}(?:人寿保险|财产保险|健康保险|养老保险|保险)(?:股份)?有限公司/u,
      )?.[0] || '';
      if (legalCompanyPrefix) companyNames.add(legalCompanyPrefix);
      const productSearchNames = new Set([productName]);
      for (const companyName of companyNames) {
        if (productName.startsWith(companyName) && productName.length > companyName.length) {
          productSearchNames.add(productName.slice(companyName.length));
        }
      }
      if (legalCompanyPrefix && productName.startsWith(legalCompanyPrefix)) {
        productSearchNames.add(productName.slice(legalCompanyPrefix.length));
      }

      const exactRows = [];
      for (const companyName of companyNames) {
        exactRows.push(...db.prepare(`
          SELECT *
          FROM product_responsibility_cards
          WHERE company = ? AND product_name = ?
          ORDER BY title ASC, id ASC
        `).all(companyName, productName));
      }
      const exactCards = cardsFromProductResponsibilityRows(exactRows, {
        company, productName, productKey, canonicalProductId,
      });
      if (exactCards.length) return exactCards;

      const fuzzyRows = [];
      for (const companyName of companyNames) {
        for (const searchName of productSearchNames) {
          fuzzyRows.push(...db.prepare(`
            SELECT DISTINCT company, product_name
            FROM product_responsibility_cards
            WHERE company = ? AND product_name LIKE ?
            LIMIT 200
          `).all(companyName, `%${searchName}%`));
        }
      }
      const rowsByProduct = new Map();
      for (const row of fuzzyRows) {
        const rowProductName = productNameFromResponsibilityCardRow(row);
        if (responsibilityCompanyIdentity(row.company) !== responsibilityCompanyIdentity(company)
          || !productNameMatchesQuery(rowProductName, productName)) continue;
        const key = comparableProductName(rowProductName);
        if (!key) continue;
        if (!rowsByProduct.has(key)) rowsByProduct.set(key, row);
      }
      if (rowsByProduct.size !== 1) return [];
      const matchedProduct = [...rowsByProduct.values()][0];
      const matchedRows = db.prepare(`
        SELECT *
        FROM product_responsibility_cards
        WHERE company = ? AND product_name = ?
        ORDER BY title ASC, id ASC
      `).all(matchedProduct.company, matchedProduct.product_name);
      return cardsFromProductResponsibilityRows(matchedRows, {
        company, productName, productKey, canonicalProductId,
      });
    } catch {
      return [];
    }
  }

  function reviewedResponsibilityCardProductSuggestions({ company = '', productName = '' } = {}) {
    if (!db || !company || productName.length < 2) return [];
    try {
      const companyIdentity = responsibilityCompanyIdentity(company);
      const companyNames = new Set([company]);
      if (typeof buildEffectiveOfficialDomainProfiles === 'function') {
        for (const profile of buildEffectiveOfficialDomainProfiles(state) || []) {
          const aliases = [
            profile?.company,
            ...(Array.isArray(profile?.aliases) ? profile.aliases : []),
            ...(Array.isArray(profile?.companyAliases) ? profile.companyAliases : []),
          ].map(trim).filter(Boolean);
          if (aliases.some((alias) => responsibilityCompanyIdentity(alias) === companyIdentity)) {
            aliases.forEach((alias) => companyNames.add(alias));
          }
        }
      }
      const legalCompanyPrefix = productName.match(
        /^[\u4e00-\u9fff]{2,12}(?:人寿保险|财产保险|健康保险|养老保险|保险)(?:股份)?有限公司/u,
      )?.[0] || '';
      if (legalCompanyPrefix) companyNames.add(legalCompanyPrefix);
      const productSearchNames = new Set([productName]);
      for (const companyName of companyNames) {
        if (productName.startsWith(companyName) && productName.length > companyName.length) {
          productSearchNames.add(productName.slice(companyName.length));
        }
      }
      if (legalCompanyPrefix && productName.startsWith(legalCompanyPrefix)) {
        productSearchNames.add(productName.slice(legalCompanyPrefix.length));
      }

      const rowsById = new Map();
      for (const companyName of companyNames) {
        for (const searchName of productSearchNames) {
          const rows = db.prepare(`
            SELECT *
            FROM product_responsibility_cards
            WHERE company = ? AND product_name LIKE ?
            ORDER BY product_name ASC, title ASC, id ASC
            LIMIT 200
          `).all(companyName, `%${searchName}%`);
          for (const row of rows) rowsById.set(trim(row.id), row);
        }
      }
      const productsByKey = new Map();
      for (const row of rowsById.values()) {
        const card = cardFromProductResponsibilityRow(row);
        if (responsibilityCompanyIdentity(card.company) !== companyIdentity
          || !productNameMatchesQuery(card.productName, productName)) continue;
        const key = `${card.company}\u001f${card.productName}`;
        const product = productsByKey.get(key) || {
          company: card.company,
          productName: card.productName,
          sourceDigests: new Set(),
          sourceUrls: new Set(),
          cardCount: 0,
        };
        product.sourceDigests.add(card.sourceDigest);
        product.sourceUrls.add(card.sourceUrl);
        product.cardCount += 1;
        productsByKey.set(key, product);
      }
      const normalizedQuery = comparableProductName(productName);
      return [...productsByKey.values()]
        .filter((product) => (
          product.sourceDigests.size === 1
          && product.sourceUrls.size === 1
          && !product.sourceDigests.has('')
          && !product.sourceUrls.has('')
        ))
        .sort((left, right) => {
          const leftName = comparableProductName(left.productName);
          const rightName = comparableProductName(right.productName);
          return leftName.indexOf(normalizedQuery) - rightName.indexOf(normalizedQuery)
            || leftName.length - rightName.length
            || left.productName.localeCompare(right.productName, 'zh-CN');
        })
        .map((product) => ({
          company: product.company,
          productName: product.productName,
          recordCount: product.cardCount,
          matchType: 'responsibility_card',
        }));
    } catch {
      return [];
    }
  }

  function hydrateExistingCardIndicators(cards = [], coverageIndicators = [], policyDraft = {}) {
    if (!Array.isArray(cards) || !cards.length) return [];
    const indicators = Array.isArray(coverageIndicators) ? coverageIndicators : [];
    return cards.map((card) => {
      if (Array.isArray(card?.indicators) && card.indicators.length) {
        return refreshExistingResponsibilityCardProjection(card, policyDraft);
      }
      const title = compact(card?.title);
      if (!title) return card;
      const matchedIndicators = indicators.filter((indicator) => {
        const liability = compact(indicator?.liability || indicator?.coverageType);
        return liability && (liability === title || liability.includes(title) || title.includes(liability));
      });
      return matchedIndicators.length
        ? refreshExistingResponsibilityCardProjection({ ...card, indicators: matchedIndicators }, policyDraft)
        : card;
    });
  }

  function sourcesFromResponsibilityCards(cards = []) {
    const seen = new Set();
    return (Array.isArray(cards) ? cards : [])
      .map((card) => {
        const url = trim(card?.sourceUrl);
        if (!url || seen.has(url)) return null;
        seen.add(url);
        return {
          title: trim(card?.sourceTitle) || trim(card?.productName) || trim(card?.title) || url,
          url,
          snippet: trim(card?.sourceExcerpt),
          evidenceLabel: trim(card?.evidenceLabel),
          evidenceLevel: trim(card?.evidenceLevel),
          verificationStatus: trim(card?.verificationStatus),
          verificationLabel: trim(card?.verificationLabel),
          referenceOnly: card?.referenceOnly === true,
          official: card?.official !== false,
          sourceType: trim(card?.sourceType),
          sourceKind: trim(card?.sourceKind),
        };
      })
      .filter(Boolean)
      .slice(0, 5);
  }

  function existingResponsibilityCardAnalysis(policyDraft = {}) {
    const knowledgeRecords = projectionKnowledgeRecordsForPolicy(policyDraft);
    const projectionCompany = trim(knowledgeRecords[0]?.company) || trim(policyDraft.company);
    const projectionPolicy = projectionCompany === trim(policyDraft.company)
      ? policyDraft
      : { ...policyDraft, company: projectionCompany };
    const coverageIndicators = typeof findPolicyCoverageIndicators === 'function'
      ? findPolicyCoverageIndicators(projectionPolicy, state?.insuranceIndicatorRecords || [])
      : [];
    const responsibilityCards = withFallbackCardSources(
      hydrateExistingCardIndicators(loadExistingProductResponsibilityCards(policyDraft), coverageIndicators, projectionPolicy),
      policyDraft,
    );
    if (!responsibilityCards.length) return null;
    const coverageTable = typeof responsibilityRowsFromCards === 'function'
      ? responsibilityRowsFromCards(responsibilityCards, { optionalResponsibilities: [] })
      : [];
    return {
      report: responsibilityReportFor({
        rows: coverageTable,
        cards: responsibilityCards,
        optionalResponsibilities: [],
      }),
      coverageTable,
      responsibilityCards,
      notes: ['本结果直接返回库内已生成的保险责任卡片和指标，未重新拆分保险责任正文。'],
      sources: sourcesFromResponsibilityCards(responsibilityCards),
      rawAnalysis: {
        generatedBy: 'existing_responsibility_cards_fast_path',
        reusedExistingResponsibilityCards: true,
        reusedResponsibilityCardCount: responsibilityCards.length,
      },
      modelOutput: null,
    };
  }

  function existingResponsibilityCardProductMatch(policyDraft = {}) {
    const cards = loadExistingProductResponsibilityCards(policyDraft);
    const firstCard = cards[0];
    if (!firstCard) return null;
    const company = trim(firstCard.company || policyDraft.company);
    const productName = trim(firstCard.productName || policyDraft.name || policyDraft.productName);
    const sourceUrl = trim(firstCard.sourceUrl);
    return {
      company,
      productName,
      resolvedProductName: productName,
      canonicalProductId: trim(firstCard.canonicalProductId),
      title: trim(firstCard.title) || productName,
      score: 1,
      matchReason: '已命中库内保险责任卡',
      evidenceLabel: '本地保险责任库',
      evidenceLevel: 'insurer_official',
      verificationStatus: trim(firstCard.verificationStatus),
      verificationLabel: trim(firstCard.verificationLabel),
      sourceKind: 'insurer_official',
      referenceOnly: false,
      responsibilityDeferred: false,
      sourceCount: cards.length,
      needsConfirmation: false,
      bestSource: {
        title: trim(firstCard.sourceTitle) || trim(firstCard.title) || productName,
        url: sourceUrl,
        sourceType: trim(firstCard.sourceType),
        materialType: trim(firstCard.materialType) || 'terms',
        sourceKind: 'insurer_official',
        evidenceLevel: 'insurer_official',
        verificationStatus: trim(firstCard.verificationStatus),
        verificationLabel: trim(firstCard.verificationLabel),
        responsibilityDeferred: false,
        referenceOnly: false,
      },
    };
  }

  function attachResponsibilityCards(analysis, policyDraft, optionalResponsibilityRecords = state?.optionalResponsibilityRecords) {
    if (!analysis || typeof analysis !== 'object') return analysis;
    const knowledgeRecords = projectionKnowledgeRecordsForPolicy(policyDraft);
    const projectionCompany = trim(knowledgeRecords[0]?.company) || trim(policyDraft.company);
    const projectionPolicy = projectionCompany === trim(policyDraft.company)
      ? policyDraft
      : { ...policyDraft, company: projectionCompany };
    const coverageIndicators = typeof findPolicyCoverageIndicators === 'function'
      ? findPolicyCoverageIndicators(policyDraft, state?.insuranceIndicatorRecords || [])
      : [];
    const suppliedResponsibilityCards = Array.isArray(analysis.responsibilityCards)
      && analysis.responsibilityCards.length > 0;
    const existingResponsibilityCards = hydrateExistingCardIndicators(
      suppliedResponsibilityCards
        ? analysis.responsibilityCards
        : loadExistingProductResponsibilityCards(policyDraft),
      coverageIndicators,
      projectionPolicy,
    );
    const rebuiltResponsibilityCards = typeof buildResponsibilityCardsForPolicy === 'function'
      ? buildResponsibilityCardsForPolicy({
          policy: projectionPolicy,
          responsibilities: analysis.coverageTable,
          coverageIndicators,
          knowledgeRecords,
          optionalResponsibilityRecords: optionalResponsibilityRecords || [],
        })
      : [];
    const rawResponsibilityCards = selectResponsibilityCardProjection(
      existingResponsibilityCards,
      rebuiltResponsibilityCards,
    );
    const responsibilityCards = withFallbackCardSources(rawResponsibilityCards, policyDraft);
    const checkedCoverageTable = typeof responsibilityRowsFromCards === 'function'
      ? responsibilityRowsFromCards(responsibilityCards, { optionalResponsibilities: analysis.optionalResponsibilities || [] })
      : [];
    const effectiveCoverageTable = typeof mergeCoverageTableWithCheckedRows === 'function'
      ? mergeCoverageTableWithCheckedRows(analysis.coverageTable, checkedCoverageTable)
      : (checkedCoverageTable.length ? checkedCoverageTable : analysis.coverageTable);
    return {
      ...analysis,
      report: responsibilityReportFor({
        current: analysis.report,
        rows: checkedCoverageTable,
        cards: responsibilityCards,
        optionalResponsibilities: analysis.optionalResponsibilities || [],
      }),
      coverageTable: effectiveCoverageTable,
      responsibilityCards,
      rawAnalysis: !suppliedResponsibilityCards
        && rawResponsibilityCards === existingResponsibilityCards
        && existingResponsibilityCards.length
        ? {
            ...(analysis.rawAnalysis && typeof analysis.rawAnalysis === 'object' ? analysis.rawAnalysis : {}),
            reusedExistingResponsibilityCards: true,
            reusedResponsibilityCardCount: responsibilityCards.length,
          }
        : analysis.rawAnalysis,
    };
  }

  function upsertResponsibilityIndicators(indicators = []) {
    if (!state) return [];
    if (!Array.isArray(state.insuranceIndicatorRecords)) state.insuranceIndicatorRecords = [];
    const saved = [];
    for (const indicator of Array.isArray(indicators) ? indicators : []) {
      const id = trim(indicator?.id);
      if (!id) continue;
      const existing = state.insuranceIndicatorRecords.find((row) => trim(row?.id) === id);
      if (existing) {
        Object.assign(existing, indicator);
        saved.push(existing);
        continue;
      }
      state.insuranceIndicatorRecords.push(indicator);
      saved.push(indicator);
    }
    return saved;
  }

  async function persistLookupArtifacts({ knowledgeRecords = [], indicatorRecords = [], responsibilityCards = [] } = {}) {
    if (typeof persistResponsibilityLookupArtifacts !== 'function') {
      return {
        knowledgeRecordCount: knowledgeRecords.length,
        indicatorRecordCount: indicatorRecords.length,
        responsibilityCardCount: responsibilityCards.length,
      };
    }
    return persistResponsibilityLookupArtifacts({
      knowledgeRecords,
      indicatorRecords,
      responsibilityCards,
    });
  }

  function saveKnowledgeRecords(records = [], officialDomainProfiles = []) {
    if (typeof upsertKnowledgeRecords !== 'function') return [];
    return upsertKnowledgeRecords(state, records, {
      officialDomainProfiles,
      allocateId: typeof allocateId === 'function' ? (targetState) => allocateId(targetState || state) : undefined,
    });
  }

  async function persistResponsibilityAnalysisArtifacts(policy, analysis, officialDomainProfiles = []) {
    const now = new Date().toISOString();
    const knowledgeRecords = knowledgeRecordsFromResponsibilityAnalysis({ analysis, policy });
    const savedKnowledgeRecords = saveKnowledgeRecords(knowledgeRecords, officialDomainProfiles);
    const cardRows = materializeResponsibilityCardRows({
      policy,
      cards: analysis?.responsibilityCards || [],
      now,
    });
    const indicators = indicatorsFromResponsibilityCards({
      policy,
      cards: analysis?.responsibilityCards || [],
      existingIndicators: state?.insuranceIndicatorRecords || [],
      now,
    });
    const savedIndicators = upsertResponsibilityIndicators(indicators);
    const persisted = await persistLookupArtifacts({
      knowledgeRecords: savedKnowledgeRecords,
      indicatorRecords: savedIndicators,
      responsibilityCards: cardRows,
    });
    return {
      knowledgeRecordCount: persisted?.knowledgeRecordCount ?? savedKnowledgeRecords.length,
      indicatorRecordCount: persisted?.indicatorRecordCount ?? savedIndicators.length,
      responsibilityCardCount: persisted?.responsibilityCardCount ?? cardRows.length,
    };
  }

  function externalKnowledgeRecordsFromAnalysisSources({ analysis = {}, policy = {} } = {}) {
    const company = trim(policy.company);
    const productName = trim(policy.name || policy.productName);
    if (!company || !productName) return [];
    return (Array.isArray(analysis.sources) ? analysis.sources : [])
      .map((source) => {
        const url = trim(source?.url);
        if (!url) return null;
        const record = {
          company,
          productName,
          title: trim(source?.title) || productName,
          url,
          snippet: trim(source?.snippet),
          pageText: trim(source?.snippet),
          sourceType: trim(source?.sourceType),
          materialType: 'external_reference',
          official: false,
          sourceKind: trim(source?.sourceKind) || 'open_web_reference',
          evidenceLabel: trim(source?.evidenceLabel) || EXTERNAL_REFERENCE_EVIDENCE_LABEL,
          evidenceLevel: EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
          referenceOnly: true,
          responsibilityDeferred: true,
          parser: 'external_review_query_source',
        };
        return {
          ...record,
          ...evidenceVerificationFields(record),
        };
      })
      .filter(Boolean);
  }

  async function persistExternalReviewAnalysisArtifacts(policy, analysis, officialDomainProfiles = []) {
    const knowledgeRecords = externalKnowledgeRecordsFromAnalysisSources({ analysis, policy });
    const savedKnowledgeRecords = saveKnowledgeRecords(knowledgeRecords, officialDomainProfiles);
    const persisted = await persistLookupArtifacts({ knowledgeRecords: savedKnowledgeRecords });
    return {
      knowledgeRecordCount: persisted?.knowledgeRecordCount ?? savedKnowledgeRecords.length,
      indicatorRecordCount: 0,
      responsibilityCardCount: 0,
    };
  }

  function withExternalReviewWarning(analysis) {
    if (!analysis || typeof analysis !== 'object') return analysis;
    const warning = '非官方资料待保险公司确认';
    return {
      ...analysis,
      coverageTable: (Array.isArray(analysis.coverageTable) ? analysis.coverageTable : []).map((row) => {
        const note = trim(row?.note);
        const evidence = evidenceVerificationFields({
          sourceKind: row?.sourceKind || 'open_web_reference',
          evidenceLevel: EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
          referenceOnly: true,
        });
        return {
          ...row,
          note: note.includes(warning) ? note : [note, warning].filter(Boolean).join('；'),
          sourceKind: row?.sourceKind || 'open_web_reference',
          evidenceLabel: row?.evidenceLabel || EXTERNAL_REFERENCE_EVIDENCE_LABEL,
          evidenceLevel: EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
          verificationStatus: evidence.verificationStatus,
          verificationLabel: evidence.verificationLabel,
          referenceOnly: true,
          official: false,
        };
      }),
      sources: (Array.isArray(analysis.sources) ? analysis.sources : []).map((source) => {
        const evidence = evidenceVerificationFields({
          ...source,
          sourceKind: source?.sourceKind || 'open_web_reference',
          evidenceLevel: EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
          referenceOnly: true,
        });
        return {
          ...source,
          sourceKind: source?.sourceKind || 'open_web_reference',
          evidenceLabel: source?.evidenceLabel || EXTERNAL_REFERENCE_EVIDENCE_LABEL,
          evidenceLevel: EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
          verificationStatus: evidence.verificationStatus,
          verificationLabel: evidence.verificationLabel,
          referenceOnly: true,
          official: false,
        };
      }),
      notes: Array.from(new Set([...(Array.isArray(analysis.notes) ? analysis.notes.map(trim).filter(Boolean) : []), warning])),
      disclaimer: trim(analysis.disclaimer) || '本结果基于非官方公开资料线索生成，仅供建档和沟通参考，需以保险公司确认或补发合同条款为准。',
    };
  }

  function matchResponse({ policy, matches = [], status = '', message = '', savedRecordCount = 0 } = {}) {
    const resolved = typeof withPolicyProductMatchStatus === 'function'
      ? withPolicyProductMatchStatus({ policy, matches })
      : { status: matches.length ? 'candidates' : 'not_found', matches };
    const effectiveStatus = status === 'source_review_required' && !resolved.matches.length
      ? 'source_review_required'
      : resolved.status;
    const fallbackMessage = (() => {
      if (effectiveStatus === 'exact') return '已按官方产品名称校正，可继续查询保险责任。';
      if (effectiveStatus === 'candidates') return '请先确认最接近的官方产品或条款名，再生成保险责任。';
      if (effectiveStatus === 'source_review_required') return '金融产品查询平台需要人工验证或暂时不可用，请核对合同条款名称/上传条款页。';
      return '未找到匹配产品，请使用保险合同上的具体条款名称/险种名称重新输入，或上传条款页。';
    })();
    return {
      ok: true,
      status: effectiveStatus,
      matches: resolved.matches,
      message: message || fallbackMessage,
      savedRecordCount,
    };
  }

  function matchMergeKey(match = {}) {
    return [
      compact(match.company),
      compact(match.resolvedProductName || match.productName),
    ].join('\n');
  }

  function mergePolicyProductMatches(groups = [], maxResults = 8) {
    const merged = new Map();
    for (const match of groups.flatMap((group) => (Array.isArray(group) ? group : []))) {
      const key = matchMergeKey(match);
      if (!key.trim()) continue;
      const existing = merged.get(key);
      if (!existing || Number(match.score || 0) > Number(existing.score || 0)) {
        merged.set(key, match);
      }
    }
    return Array.from(merged.values())
      .sort((left, right) =>
        Number(right.score || 0) - Number(left.score || 0) ||
        String(left.productName || '').localeCompare(String(right.productName || ''), 'zh-Hans-CN'),
      )
      .slice(0, maxResults);
  }

  async function refreshExternalResponsibilityDetails(policy, officialDomainProfiles) {
    if (typeof externalReferenceProductMatcher !== 'function') return 0;
    const requestedYear = policy.name.match(/20\d{2}/u)?.[0] || String(new Date().getFullYear());
    const reusableCachedEvidence = (state?.knowledgeRecords || []).some((record) => {
      if (compact(record?.company) !== compact(policy.company)) return false;
      if (!productNameMatchesQuery(record?.productName, policy.name)) return false;
      const externalReference = record?.referenceOnly === true
        || ['external_reference', 'external_legacy_reference'].includes(trim(record?.evidenceLevel));
      return externalReference && trim(record?.pageText).length >= 500;
    });
    if (reusableCachedEvidence) return 0;
    const recentDetailRecord = (state?.knowledgeRecords || []).some((record) => {
      if (trim(record?.parser) !== 'responsibility_detail_enrichment_v4') return false;
      if (compact(record?.company) !== compact(policy.company)) return false;
      if (!productNameMatchesQuery(record?.productName, policy.name)) return false;
      const fetchedAt = Date.parse(trim(record?.lastFetchedAt || record?.updatedAt));
      return Number.isFinite(fetchedAt) && nowMs() - fetchedAt < 24 * 60 * 60 * 1_000;
    });
    if (recentDetailRecord) return 0;
    try {
      const detailSeedRecords = (state?.knowledgeRecords || [])
        .filter((record) => compact(record?.company) === compact(policy.company))
        .filter((record) => productNameMatchesQuery(record?.productName, policy.name))
        .filter((record) => trim(record?.url) && trim(record?.title).includes(requestedYear))
        .filter((record) => /(?:理赔须知|保障计划|投保须知|保障方案|投保手册)/u.test(trim(record?.title)))
        .sort((left, right) => {
          const score = (record) => Number(/理赔须知/u.test(trim(record?.title))) * 4
            + Number(/保障计划|保障方案/u.test(trim(record?.title))) * 3
            + Number(/投保须知|投保手册/u.test(trim(record?.title))) * 2
            + Number(Boolean(trim(record?.pageText)));
          return score(right) - score(left);
        })
        .slice(0, 4);
      const detailResult = await externalReferenceProductMatcher({
        policy,
        maxResults: 8,
        fetchImpl: knowledgeFetchImpl,
        officialDomainProfiles,
        seedRecords: detailSeedRecords,
        searchPlan: {
          queries: [
            `${requestedYear} ${policy.company} ${policy.name} 完整保障范围 起付线 免赔额 报销比例 年度限额`,
            `${requestedYear} ${policy.name} 保障责任 赔付比例 限额 住院津贴 特药`,
            `${requestedYear} ${policy.name} 投保须知 理赔须知 既往症 断保 就诊要求`,
            `${requestedYear} ${policy.name} 产品类型 主要作用`,
            `${requestedYear} ${policy.name} 责任免除 不予赔付 增值服务 健康服务`,
          ],
          preferredDomains: [],
        },
      });
      const detailRecords = (Array.isArray(detailResult?.records) ? detailResult.records : []).map((record) => ({
        ...record,
        parser: 'responsibility_detail_enrichment_v4',
      }));
      const saved = saveKnowledgeRecords(detailRecords, officialDomainProfiles);
      if (saved.length) await persistLookupArtifacts({ knowledgeRecords: saved });
      return saved.length;
    } catch {
      return 0;
    }
  }

  async function queryResponsibilityAssistant({
    company,
    name,
    canonicalProductId = '',
    preferLocalKnowledgeAnswer = true,
    allowExternalReferences = false,
  } = {}) {
    const routeStartedAt = nowMs();
    const input = normalizeResponsibilityQueryInput({ company, name });
    const policy = { company: input.company, name: input.name, canonicalProductId: trim(canonicalProductId) };
    const scan = { ocrText: `${input.company} ${input.name}`, data: input };
    const analysisStartedAt = nowMs();
    if (allowExternalReferences) {
      await refreshExternalResponsibilityDetails(policy, buildEffectiveOfficialDomainProfiles(state));
    }
    let hasLocalResponsibilityText = false;
    if (!allowExternalReferences && preferLocalKnowledgeAnswer && typeof loadKnowledgeRecords === 'function') {
      try {
        const records = await loadKnowledgeRecords({ company: input.company, productName: input.name });
        hasLocalResponsibilityText = (Array.isArray(records) ? records : []).some((record) => /保险责任/u.test(
          `${trim(record?.pageText)} ${trim(record?.snippet)}`,
        ));
      } catch {
        // The analyzer retains the existing fallback behavior if scoped lookup is unavailable.
      }
    }
    const existingCardAnalysis = !allowExternalReferences && preferLocalKnowledgeAnswer && !hasLocalResponsibilityText
      ? existingResponsibilityCardAnalysis(policy)
      : null;
    const analysis = existingCardAnalysis || await assistantAnalyzer({ scan, preferLocalKnowledgeAnswer, allowExternalReferences });
    const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
    const isLocalResponsibilityText = analysis?.rawAnalysis?.generatedBy === 'local_knowledge_fast_path';
    const analysisWithCards = allowExternalReferences
      ? analysis
      : attachResponsibilityCards(analysis, policy);
    const effectiveAnalysis = allowExternalReferences ? withExternalReviewWarning(analysisWithCards) : analysisWithCards;
    const reusedResponsibilityCardCount = Number(effectiveAnalysis?.rawAnalysis?.reusedResponsibilityCardCount || 0);
    const persistence = reusedResponsibilityCardCount
      ? {
          knowledgeRecordCount: 0,
          indicatorRecordCount: 0,
          responsibilityCardCount: 0,
          reusedResponsibilityCardCount,
        }
      : isLocalResponsibilityText
      ? {
          knowledgeRecordCount: 0,
          indicatorRecordCount: 0,
          responsibilityCardCount: 0,
        }
      : allowExternalReferences
      ? await persistExternalReviewAnalysisArtifacts(policy, effectiveAnalysis, officialDomainProfiles)
      : await persistResponsibilityAnalysisArtifacts(policy, effectiveAnalysis, officialDomainProfiles);
    logPerformance(performanceLogger, 'policy.responsibility.assistant.analysis', {
      route: '/api/policy-responsibilities/query',
      durationMs: elapsedMs(analysisStartedAt),
      inputOcrChars: scan.ocrText.length,
      outputOcrChars: scan.ocrText.length,
      responsibilityCount: Array.isArray(effectiveAnalysis?.coverageTable) ? effectiveAnalysis.coverageTable.length : 0,
    });
    logPerformance(performanceLogger, 'policy.responsibility.assistant.complete', {
      route: '/api/policy-responsibilities/query',
      durationMs: elapsedMs(routeStartedAt),
      inputOcrChars: scan.ocrText.length,
    });
    return { analysis: effectiveAnalysis, persistence };
  }

  if (typeof registerResponsibilityAssistantQuery === 'function') {
    registerResponsibilityAssistantQuery(queryResponsibilityAssistant);
  }

  router.post('/query', async (req, res) => {
    try {
      const input = normalizeResponsibilityQueryInput(req.body);
      const result = await queryResponsibilityAssistant({
        company: input.company,
        name: input.name,
        canonicalProductId: req.body?.canonicalProductId,
        preferLocalKnowledgeAnswer: req.body?.preferLocalKnowledgeAnswer !== false,
        allowExternalReferences: booleanFromBody(req.body?.allowExternalReferences),
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/local-draft', async (req, res) => {
    try {
      const manualData = req.body?.manualData && typeof req.body.manualData === 'object' ? req.body.manualData : req.body;
      const data = normalizePolicyScanData(manualData || {});
      const scan = {
        ocrText: trim(req.body?.ocrText) || `${data.company} ${data.name}`.trim(),
        data: {
          ...data,
          plans: normalizePolicyPlans(manualData?.plans, data.company),
          optionalResponsibilities: normalizeOptionalResponsibilities(manualData?.optionalResponsibilities),
        },
      };
      const analysis = await buildRecognizedPolicyAnalysisDraft({
        state,
        scan,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      });
      res.json({
        ok: true,
        analysis: attachResponsibilityCards(
          analysis,
          { ...data, plans: scan.data.plans },
          analysis?.optionalResponsibilities,
        ),
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get('/company-suggestions', async (req, res) => {
    const q = trim(req.query?.q);
    const limit = Number(req.query?.limit);
    let suggestionState = state;
    // Knowledge records are intentionally lazy at startup.  Build the small
    // company-only index on demand so the dropdown does not depend on the
    // in-memory full knowledge corpus (or trigger a payload scan).
    if (db?.prepare && q) {
      try {
        const companyPrefix = q.replace(/(?:人寿|财产|健康|养老)?保险.*$/u, '') || q;
        const companyRows = db.prepare(`
          SELECT DISTINCT company, 1 AS record_count
          FROM knowledge_records
          WHERE company IS NOT NULL AND TRIM(company) <> ''
            AND (company GLOB ? OR instr(company, ?) > 0 OR instr(?, company) > 0)
          ORDER BY company ASC
          LIMIT 500
        `).all(`${companyPrefix}*`, q, q);
        if (companyRows.length) {
          const records = [
            ...(Array.isArray(state?.knowledgeRecords) ? state.knowledgeRecords : []),
            ...companyRows.map((row) => ({
              company: trim(row.company),
              productName: '',
            })),
          ];
          suggestionState = { ...state, knowledgeRecords: records };
        }
      } catch {
        // Keep the in-memory/policy fallback for test stores and legacy DBs.
      }
    }
    res.json({
      ok: true,
      suggestions: buildResponsibilityCompanySuggestions(suggestionState, q, Number.isFinite(limit) && limit > 0 ? limit : undefined),
    });
  });

  router.get('/product-suggestions', async (req, res) => {
    const company = trim(req.query?.company);
    const q = trim(req.query?.q);
    const limit = Number(req.query?.limit);
    const maxResults = Number.isFinite(limit) && limit > 0 ? limit : undefined;
    const cardSuggestions = q ? reviewedResponsibilityCardProductSuggestions({ company, productName: q }) : [];
    let knowledgeRecords = state.knowledgeRecords || [];
    if (q && typeof loadKnowledgeRecords === 'function') {
      try {
        knowledgeRecords = await loadKnowledgeRecords({ company, productName: q });
      } catch {
        // Keep the in-memory fallback for test stores and legacy runtimes.
      }
    }
    const knowledgeSuggestions = buildResponsibilityProductSuggestions(state, {
        company,
        query: q,
        maxResults,
        knowledgeRecords,
      });
    const suggestions = [...cardSuggestions, ...knowledgeSuggestions].filter((item, index, rows) => (
      rows.findIndex((candidate) => (
        candidate.company === item.company && candidate.productName === item.productName
      )) === index
    ));
    res.json({
      ok: true,
      suggestions: maxResults ? suggestions.slice(0, maxResults) : suggestions,
    });
  });

  async function queryCustomerResponsibilitySummary(
    { company, name, canonicalProductId },
    { privateSourceRecords = [], policyDerivedResult = null, boundSourceIdentity = null } = {},
  ) {
    const routeStartedAt = nowMs();
    const privateRecord = privateSourceRecords[0];
    const input = normalizeResponsibilityQueryInput(privateRecord ? {
      company: privateRecord.company,
      name: privateRecord.productName,
    } : { company, name });
    const usesPrivateSource = privateSourceRecords.length > 0;

    let summaryState = state;
    if (!usesPrivateSource && typeof loadKnowledgeRecords === 'function') {
      try {
        const scopedKnowledgeRecords = await loadKnowledgeRecords({
          company: input.company,
          productName: input.name,
        });
        summaryState = { ...state, knowledgeRecords: scopedKnowledgeRecords };
      } catch {
        // Keep the in-memory fallback for test stores and legacy runtimes.
      }
    }
    if (!usesPrivateSource && !boundSourceIdentity && typeof buildCustomerResponsibilitySummaryFromCards === 'function') {
      const cardSummary = buildCustomerResponsibilitySummaryFromCards({
        db,
        company: input.company,
        productName: input.name,
        canonicalProductId,
        sourceRecords: summaryState.knowledgeRecords,
        requireSourceDigest: true,
        responsibilityCards: policyDerivedResult?.status === 'ready'
          && Array.isArray(policyDerivedResult.responsibilityCards)
          ? policyDerivedResult.responsibilityCards
          : null,
        requireSourceDigest: true,
      });
      if (cardSummary) {
        return {
          ok: true,
          source: 'database',
          summary: cardSummary,
        };
      }
    }
    const result = await generateProductCustomerResponsibilitySummary({
      state: summaryState,
      db,
      input: { ...input, canonicalProductId },
      findSummary: usesPrivateSource ? undefined : findProductCustomerResponsibilitySummary,
      persistSummary: usesPrivateSource ? undefined : persistProductCustomerResponsibilitySummary,
      persistGenerationRun: !usesPrivateSource && typeof persistProductCustomerSummaryGenerationRun === 'function'
        ? (run) => persistProductCustomerSummaryGenerationRun({ state, run })
        : undefined,
      privateSourceRecords,
      boundSourceIdentity,
      requireApprovedPipelineArtifact: !usesPrivateSource
        && !boundSourceIdentity
        && typeof enqueueProductResponsibilityPipeline === 'function',
      enqueueProductResponsibilityPipeline: usesPrivateSource ? undefined : enqueueProductResponsibilityPipeline,
      officialDomainProfiles: buildEffectiveOfficialDomainProfiles(summaryState),
      generateWithDeepSeek: generateProductCustomerResponsibilitySummaryWithDeepSeek,
      generatePlannerWithDeepSeek: generateProductCustomerResponsibilityPlannerWithDeepSeek,
      generateOfficialAnalysis: async ({ company: insurer, productName }) => assistantAnalyzer({
        scan: {
          ocrText: `${insurer} ${productName}`,
          data: { company: insurer, name: productName },
        },
        preferLocalKnowledgeAnswer: false,
      }),
    });
    if (usesPrivateSource && result?.ok) result.source = 'customer_upload';
    if (!usesPrivateSource && result?.source !== 'database' && result?.ok && result?.summary
      && typeof retrieveCustomerResponsibilityMaterials === 'function'
      && typeof enrichCustomerResponsibilitySummaryWithMaterials === 'function') {
      try {
        const evidencePackage = await retrieveCustomerResponsibilityMaterials({
          company: result.summary.company || input.company,
          productName: result.summary.productName || input.name,
        });
        result.summary = await enrichCustomerResponsibilitySummaryWithMaterials({
          summary: result.summary,
          evidencePackage,
          generateWithDeepSeek: generateCustomerResponsibilityMaterialSummaryWithDeepSeek,
        });
      } catch {
        // Uploaded material enrichment is optional; keep the canonical official summary available.
      }
    }
    logPerformance(performanceLogger, 'policy.responsibility.customer_summary.complete', {
      route: '/api/policy-responsibilities/customer-summary',
      durationMs: elapsedMs(routeStartedAt),
      source: result?.source || result?.status || '',
    });
    return result;
  }

  if (typeof registerCustomerResponsibilitySummaryQuery === 'function') {
    registerCustomerResponsibilitySummaryQuery(queryCustomerResponsibilitySummary);
  }

  router.post('/customer-summary', async (req, res) => {
    try {
      const input = normalizeResponsibilityQueryInput(req.body);
      const policyId = Number(req.body?.policyId || 0);
      let privateSourceRecords = [];
      let policyDerivedResult = null;
      let boundSourceIdentity = null;
      if (policyId > 0) {
        const user = resolveAuthUser(req, state);
        const guestId = normalizeGuestId(req.body?.guestId);
        if (!user && !guestId) {
          return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '请先登录' });
        }
        const policy = (state.policies || []).find((row) => (
          Number(row.id) === policyId
          && (user
            ? Number(row.userId || 0) === Number(user.id)
            : !Number(row.userId || 0) && normalizeGuestId(row.guestId) === guestId)
        ));
        if (!policy) {
          return res.status(404).json({ ok: false, code: 'POLICY_NOT_FOUND', message: '保单不存在' });
        }
        boundSourceIdentity = boundOfficialSourceIdentityForPolicy(policy);
        policyDerivedResult = (state.policyDerivedResults || []).find((row) => (
          Number(row?.policyId) === policyId
        )) || null;
        const owner = user ? { userId: Number(user.id), guestId: '' } : { userId: null, guestId };
        privateSourceRecords = (state.knowledgeRecords || [])
          .filter((record) => isCustomerUploadRecord(record))
          .filter((record) => trim(record.reviewStatus) === 'pending')
          .filter((record) => ownerMatches(record, owner))
          .filter((record) => productNameMatchesQuery(record.productName, input.name))
          .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))
          .slice(0, 6);
      }
      const result = await queryCustomerResponsibilitySummary({
        ...input,
        canonicalProductId: trim(req.body?.canonicalProductId),
      }, { privateSourceRecords, policyDerivedResult, boundSourceIdentity });
      res.json(result);
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  async function matchResponsibilityAssistantProducts(body = {}, { allowMissingCompany = false } = {}) {
    const company = trim(body?.company).slice(0, 80);
    const name = trim(body?.name).slice(0, 160);
    const input = allowMissingCompany && !company && name
      ? { company: '', name }
      : normalizeResponsibilityQueryInput(body);
    const policy = { company: input.company, name: input.name };
    const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
    const maxResults = positiveIntegerOrFallback(body?.limit, 3, 50);
    const minScore = scoreThresholdOrFallback(body?.minScore, 0.32);
    const includeOnline = booleanFromBody(body?.includeOnline);
    const existingCardMatch = existingResponsibilityCardProductMatch(policy);
    if (existingCardMatch) {
      return matchResponse({ policy, matches: [existingCardMatch] });
    }
    let scopedKnowledgeRecords = state.knowledgeRecords || [];
    if (typeof loadKnowledgeRecords === 'function') {
      try {
        scopedKnowledgeRecords = await loadKnowledgeRecords({
          company: input.company,
          productName: input.name,
        });
      } catch {
        // Keep the in-memory fallback for test stores and legacy runtimes.
      }
    }
    let savedRecordCount = 0;
    let matches = findKnowledgeProductCandidates({
        policy,
        records: scopedKnowledgeRecords,
        officialDomainProfiles,
        maxResults,
        minScore,
      });
      const localStatus = typeof withPolicyProductMatchStatus === 'function'
        ? withPolicyProductMatchStatus({ policy, matches }).status
        : (matches.length ? 'candidates' : 'not_found');
      if (localStatus !== 'exact') {
        const customerPhotoMatches = findKnowledgeProductCandidates({
          policy,
          records: scopedKnowledgeRecords,
          officialDomainProfiles,
          maxResults,
          minScore,
          requirePageText: false,
          includeCustomerPolicyPhotoRecords: true,
        });
        matches = mergePolicyProductMatches([matches, customerPhotoMatches], maxResults);
      }
      if (!includeOnline || localStatus === 'exact') {
        return matchResponse({ policy, matches });
      }

      const cachedExternalMatches = findKnowledgeProductCandidates({
        policy,
        records: scopedKnowledgeRecords,
        officialDomainProfiles,
        maxResults,
        minScore,
        requirePageText: false,
        includeExternalReferences: true,
      }).filter((match) => match.referenceOnly === true);
      if (cachedExternalMatches.length) {
        savedRecordCount += await refreshExternalResponsibilityDetails(policy, officialDomainProfiles);
        return matchResponse({
          policy,
          matches: mergePolicyProductMatches([matches, cachedExternalMatches], maxResults),
          message: '已找到此前保存的开放网页外部线索；非官方资料需保险公司确认后再使用责任信息。',
          savedRecordCount,
        });
      }

      const officialResultPromise = typeof crawlOfficialKnowledge === 'function'
        ? Promise.resolve(crawlOfficialKnowledge({
            policy,
            officialDomainProfiles,
            fetchImpl: knowledgeFetchImpl,
          })).catch(() => [])
        : Promise.resolve([]);
      const onlineResultPromise = typeof onlineResponsibilityProductMatcher === 'function'
        ? Promise.resolve(onlineResponsibilityProductMatcher({
          policy,
          maxResults,
          minScore,
        })).catch((error) => ({
          status: 'source_review_required',
          records: [],
          message: error?.message || '',
        }))
        : Promise.resolve({ status: 'not_found', records: [], message: '' });
      const externalResultPromise = typeof externalReferenceProductMatcher === 'function'
        ? Promise.resolve(externalReferenceProductMatcher({
          policy,
          maxResults,
          minScore,
          fetchImpl: knowledgeFetchImpl,
          officialDomainProfiles,
        })).catch((error) => ({
          status: 'not_found',
          records: [],
          message: error?.message || '',
        }))
        : Promise.resolve({ status: 'not_found', records: [], message: '' });

      {
        const discovered = await officialResultPromise;
        try {
          const saved = saveKnowledgeRecords(
            (Array.isArray(discovered) ? discovered : []).map((record) => ({
              ...record,
              sourceKind: 'insurer_official',
              evidenceLabel: record.evidenceLabel || '保险公司官方资料',
              evidenceLevel: record.evidenceLevel || 'insurer_official',
            })),
            officialDomainProfiles,
          );
          if (saved.length) {
            savedRecordCount += saved.length;
            await persistLookupArtifacts({ knowledgeRecords: saved });
            scopedKnowledgeRecords = [...scopedKnowledgeRecords, ...saved];
            matches = findKnowledgeProductCandidates({
              policy,
              records: scopedKnowledgeRecords,
              officialDomainProfiles,
              maxResults,
              minScore,
            });
            const officialStatus = typeof withPolicyProductMatchStatus === 'function'
              ? withPolicyProductMatchStatus({ policy, matches }).status
              : (matches.length ? 'candidates' : 'not_found');
            if (officialStatus === 'exact') {
              return matchResponse({ policy, matches, savedRecordCount });
            }
          }
        } catch {
          // The regulatory fallback below still gives the customer a conservative next step.
        }
      }

      let onlineResult = await onlineResultPromise;
      {
        const onlineRecords = Array.isArray(onlineResult?.records) ? onlineResult.records : [];
        const saved = saveKnowledgeRecords(onlineRecords, officialDomainProfiles);
        if (saved.length) {
          savedRecordCount += saved.length;
          await persistLookupArtifacts({ knowledgeRecords: saved });
          const onlineMatches = findKnowledgeProductCandidates({
            policy,
            records: saved,
            officialDomainProfiles,
            maxResults,
            minScore,
            requirePageText: false,
          });
          matches = mergePolicyProductMatches([matches, onlineMatches], maxResults);
          if (matches.length) {
            return matchResponse({
              policy,
              matches,
              message: onlineResult.message,
              savedRecordCount,
            });
          }
        }
      }

      {
        const externalResult = await externalResultPromise;
        const externalRecords = Array.isArray(externalResult?.records) ? externalResult.records : [];
        const saved = saveKnowledgeRecords(externalRecords, officialDomainProfiles);
        if (saved.length) {
          savedRecordCount += saved.length;
          await persistLookupArtifacts({ knowledgeRecords: saved });
          const externalMatches = findKnowledgeProductCandidates({
            policy,
            records: saved,
            officialDomainProfiles,
            maxResults,
            minScore,
            requirePageText: false,
            includeExternalReferences: true,
          });
          matches = mergePolicyProductMatches([matches, externalMatches], maxResults);
          if (externalMatches.length) {
            return matchResponse({
              policy,
              matches,
              message: externalResult.message || '已找到开放网页线索；非官方资料需保险公司确认后再使用责任信息。',
              savedRecordCount,
            });
          }
        }
      }

      if (typeof legacyExternalProductReferenceRecords === 'function') {
        const legacyRecords = legacyExternalProductReferenceRecords({ policy });
        const saved = saveKnowledgeRecords(legacyRecords, officialDomainProfiles);
        if (saved.length) {
          savedRecordCount += saved.length;
          await persistLookupArtifacts({ knowledgeRecords: saved });
          const legacyMatches = findKnowledgeProductCandidates({
            policy,
            records: saved,
            officialDomainProfiles,
            maxResults,
            minScore,
            requirePageText: false,
            includeExternalReferences: true,
          });
          matches = mergePolicyProductMatches([matches, legacyMatches], maxResults);
          if (legacyMatches.length) {
            return matchResponse({
              policy,
              matches,
              message: '已找到历史老产品外部线索，资料为非官方来源，需客户确认并向保险公司核实后再使用责任信息。',
              savedRecordCount,
            });
          }
        }
      }

      if (matches.length) {
        return matchResponse({
          policy,
          matches,
          message: onlineResult?.message,
          savedRecordCount,
        });
      }

    return matchResponse({
      policy,
      matches: [],
      status: onlineResult?.status === 'source_review_required' ? 'source_review_required' : 'not_found',
      message: onlineResult?.message,
      savedRecordCount,
    });
  }

  if (typeof registerResponsibilityAssistantProductMatch === 'function') {
    registerResponsibilityAssistantProductMatch((body) => (
      matchResponsibilityAssistantProducts(body, { allowMissingCompany: true })
    ));
  }

  router.post('/matches', async (req, res) => {
    try {
      res.json(await matchResponsibilityAssistantProducts(req.body));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
