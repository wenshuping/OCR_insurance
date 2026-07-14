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

function nowMs() {
  return Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, nowMs() - startedAt);
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
    findProductCustomerResponsibilitySummary,
    persistProductCustomerResponsibilitySummary,
    persistProductCustomerSummaryGenerationRun,
    generateProductCustomerResponsibilitySummary,
    generateProductCustomerResponsibilitySummaryWithDeepSeek,
    generateProductCustomerResponsibilityPlannerWithDeepSeek,
    registerResponsibilityAssistantQuery,
    registerCustomerResponsibilitySummaryQuery,
  } = context;

  function responsibilityReportFor({ current = '', rows = [], cards = [], optionalResponsibilities = [] } = {}) {
    const existing = String(current || '').trim();
    if (existing && !(typeof isGeneratedResponsibilityCountReport === 'function' && isGeneratedResponsibilityCountReport(existing))) {
      return existing;
    }
    const cardReport = typeof buildResponsibilitySummaryReportFromCards === 'function'
      ? buildResponsibilitySummaryReportFromCards(cards, { optionalResponsibilities })
      : '';
    if (cardReport) return cardReport;
    return rows.length ? `已整理 ${rows.length} 项保险责任。` : existing;
  }

  function filteredKnowledgeRecordsForPolicy(policyDraft) {
    if (typeof buildKnowledgeSearchArtifacts !== 'function') return [];
    return buildKnowledgeSearchArtifacts({
      policy: policyDraft,
      records: state?.knowledgeRecords || [],
      officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
    }).records || [];
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
    return {
      ...payload,
      id: trim(row.id || payload.id),
      productKey: trim(row.product_key || payload.productKey || payload.product_key),
      company: trim(row.company || payload.company),
      productName: trim(row.product_name || payload.productName || payload.product_name),
      title: trim(row.title || payload.title),
      category: trim(row.category || payload.category),
      sourceUrl: trim(row.source_url || payload.sourceUrl || payload.source_url),
      sourceTitle: trim(payload.sourceTitle || payload.source_title),
      sourceExcerpt: trim(payload.sourceExcerpt || payload.source_excerpt),
      indicators: Array.isArray(payload.indicators) ? payload.indicators : [],
    };
  }

  function cardsFromProductResponsibilityRows(rows = [], { company, productName, productKey } = {}) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => cardFromProductResponsibilityRow(row))
      .filter((card) => {
        const hasProductColumns = trim(card.company) || trim(card.productName);
        return (
          trim(card.title) &&
          (
            (trim(card.company) === company && productNameMatchesQuery(card.productName, productName)) ||
            (!hasProductColumns && trim(card.productKey) === productKey)
          )
        );
      });
  }

  function loadExistingProductResponsibilityCards(policyDraft = {}) {
    const company = trim(policyDraft.company);
    const productName = trim(policyDraft.name || policyDraft.productName);
    if (!db || !company || !productName) return [];
    const productKey = `company_product:${company}:${productName}`;
    try {
      const exactRows = db.prepare(`
        SELECT *
        FROM product_responsibility_cards
        WHERE company = ? AND product_name = ?
        ORDER BY title ASC, id ASC
      `).all(company, productName);
      const exactCards = cardsFromProductResponsibilityRows(exactRows, { company, productName, productKey });
      if (exactCards.length) return exactCards;

      const fuzzyRows = db.prepare(`
        SELECT *
        FROM product_responsibility_cards
        WHERE company = ?
          AND (
            product_name LIKE ?
            OR ? LIKE '%' || product_name || '%'
          )
        ORDER BY product_name ASC, title ASC, id ASC
      `).all(company, `%${productName}%`, productName);
      const rowsByProduct = new Map();
      for (const row of fuzzyRows) {
        const rowProductName = productNameFromResponsibilityCardRow(row);
        if (!productNameMatchesQuery(rowProductName, productName)) continue;
        const key = comparableProductName(rowProductName);
        if (!key) continue;
        if (!rowsByProduct.has(key)) rowsByProduct.set(key, []);
        rowsByProduct.get(key).push(row);
      }
      if (rowsByProduct.size !== 1) return [];
      return cardsFromProductResponsibilityRows([...rowsByProduct.values()][0], { company, productName, productKey });
    } catch {
      return [];
    }
  }

  function hydrateExistingCardIndicators(cards = [], coverageIndicators = []) {
    if (!Array.isArray(cards) || !cards.length) return [];
    const indicators = Array.isArray(coverageIndicators) ? coverageIndicators : [];
    return cards.map((card) => {
      if (Array.isArray(card?.indicators) && card.indicators.length) return card;
      const title = compact(card?.title);
      if (!title) return card;
      const matchedIndicators = indicators.filter((indicator) => {
        const liability = compact(indicator?.liability || indicator?.coverageType);
        return liability && (liability === title || liability.includes(title) || title.includes(liability));
      });
      return matchedIndicators.length ? { ...card, indicators: matchedIndicators } : card;
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
    const coverageIndicators = typeof findPolicyCoverageIndicators === 'function'
      ? findPolicyCoverageIndicators(policyDraft, state?.insuranceIndicatorRecords || [])
      : [];
    const responsibilityCards = withFallbackCardSources(
      hydrateExistingCardIndicators(loadExistingProductResponsibilityCards(policyDraft), coverageIndicators),
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

  function attachResponsibilityCards(analysis, policyDraft, optionalResponsibilityRecords = state?.optionalResponsibilityRecords) {
    if (!analysis || typeof analysis !== 'object') return analysis;
    if (Array.isArray(analysis.responsibilityCards)) {
      return {
        ...analysis,
        responsibilityCards: withFallbackCardSources(analysis.responsibilityCards, policyDraft),
      };
    }
    const coverageIndicators = typeof findPolicyCoverageIndicators === 'function'
      ? findPolicyCoverageIndicators(policyDraft, state?.insuranceIndicatorRecords || [])
      : [];
    const existingResponsibilityCards = hydrateExistingCardIndicators(
      loadExistingProductResponsibilityCards(policyDraft),
      coverageIndicators,
    );
    const rawResponsibilityCards = existingResponsibilityCards.length
      ? existingResponsibilityCards
      : (
          typeof buildResponsibilityCardsForPolicy === 'function'
            ? buildResponsibilityCardsForPolicy({
                policy: policyDraft,
                responsibilities: analysis.coverageTable,
                coverageIndicators,
                knowledgeRecords: filteredKnowledgeRecordsForPolicy(policyDraft),
                optionalResponsibilityRecords: optionalResponsibilityRecords || [],
              })
            : []
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
      rawAnalysis: existingResponsibilityCards.length
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

  async function queryResponsibilityAssistant({
    company,
    name,
    preferLocalKnowledgeAnswer = true,
    allowExternalReferences = false,
  } = {}) {
    const routeStartedAt = nowMs();
    const input = normalizeResponsibilityQueryInput({ company, name });
    const policy = { company: input.company, name: input.name };
    const scan = { ocrText: `${input.company} ${input.name}`, data: input };
    const analysisStartedAt = nowMs();
    const existingCardAnalysis = !allowExternalReferences && preferLocalKnowledgeAnswer
      ? existingResponsibilityCardAnalysis(policy)
      : null;
    const analysis = existingCardAnalysis || await assistantAnalyzer({ scan, preferLocalKnowledgeAnswer, allowExternalReferences });
    const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
    const analysisWithCards = allowExternalReferences || existingCardAnalysis ? analysis : attachResponsibilityCards(analysis, policy);
    const effectiveAnalysis = allowExternalReferences ? withExternalReviewWarning(analysisWithCards) : analysisWithCards;
    const reusedResponsibilityCardCount = Number(effectiveAnalysis?.rawAnalysis?.reusedResponsibilityCardCount || 0);
    const persistence = reusedResponsibilityCardCount
      ? {
          knowledgeRecordCount: 0,
          indicatorRecordCount: 0,
          responsibilityCardCount: 0,
          reusedResponsibilityCardCount,
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
        preferLocalKnowledgeAnswer: req.body?.preferLocalKnowledgeAnswer !== false,
        allowExternalReferences: booleanFromBody(req.body?.allowExternalReferences),
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/local-draft', (req, res) => {
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
      const analysis = buildRecognizedPolicyAnalysisDraft({
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
    res.json({
      ok: true,
      suggestions: buildResponsibilityCompanySuggestions(state, q, Number.isFinite(limit) && limit > 0 ? limit : undefined),
    });
  });

  router.get('/product-suggestions', async (req, res) => {
    const company = trim(req.query?.company);
    const q = trim(req.query?.q);
    const limit = Number(req.query?.limit);
    res.json({
      ok: true,
      suggestions: buildResponsibilityProductSuggestions(state, {
        company,
        query: q,
        maxResults: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    });
  });

  async function queryCustomerResponsibilitySummary({ company, name }) {
    const routeStartedAt = nowMs();
    const input = normalizeResponsibilityQueryInput({ company, name });
    const result = await generateProductCustomerResponsibilitySummary({
      state,
      db,
      input,
      findSummary: findProductCustomerResponsibilitySummary,
      persistSummary: persistProductCustomerResponsibilitySummary,
      persistGenerationRun: typeof persistProductCustomerSummaryGenerationRun === 'function'
        ? (run) => persistProductCustomerSummaryGenerationRun({ state, run })
        : undefined,
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
      const result = await queryCustomerResponsibilitySummary(input);
      res.json(result);
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/matches', async (req, res) => {
    try {
      const input = normalizeResponsibilityQueryInput(req.body);
      const policy = { company: input.company, name: input.name };
      const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
      const maxResults = positiveIntegerOrFallback(req.body?.limit, 3, 50);
      const minScore = scoreThresholdOrFallback(req.body?.minScore, 0.32);
      const includeOnline = booleanFromBody(req.body?.includeOnline);
      let savedRecordCount = 0;
      let matches = findKnowledgeProductCandidates({
        policy,
        records: state.knowledgeRecords || [],
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
          records: state.knowledgeRecords || [],
          officialDomainProfiles,
          maxResults,
          minScore,
          requirePageText: false,
          includeCustomerPolicyPhotoRecords: true,
        });
        matches = mergePolicyProductMatches([matches, customerPhotoMatches], maxResults);
      }
      if (!includeOnline || localStatus === 'exact') {
        res.json(matchResponse({ policy, matches }));
        return;
      }

      if (typeof crawlOfficialKnowledge === 'function') {
        try {
          const discovered = await crawlOfficialKnowledge({
            policy,
            officialDomainProfiles,
            fetchImpl: knowledgeFetchImpl,
          });
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
            matches = findKnowledgeProductCandidates({
              policy,
              records: state.knowledgeRecords || [],
              officialDomainProfiles,
              maxResults,
              minScore,
            });
            const officialStatus = typeof withPolicyProductMatchStatus === 'function'
              ? withPolicyProductMatchStatus({ policy, matches }).status
              : (matches.length ? 'candidates' : 'not_found');
            if (officialStatus === 'exact') {
              res.json(matchResponse({ policy, matches, savedRecordCount }));
              return;
            }
          }
        } catch {
          // The regulatory fallback below still gives the customer a conservative next step.
        }
      }

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
            res.json(matchResponse({
              policy,
              matches,
              message: onlineResult.message,
              savedRecordCount,
            }));
            return;
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
            res.json(matchResponse({
              policy,
              matches,
              message: externalResult.message || '已找到开放网页线索；非官方资料需保险公司确认后再使用责任信息。',
              savedRecordCount,
            }));
            return;
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
            res.json(matchResponse({
              policy,
              matches,
              message: '已找到历史老产品外部线索，资料为非官方来源，需客户确认并向保险公司核实后再使用责任信息。',
              savedRecordCount,
            }));
            return;
          }
        }
      }

      if (matches.length) {
        res.json(matchResponse({
          policy,
          matches,
          message: onlineResult?.message,
          savedRecordCount,
        }));
        return;
      }

      res.json(matchResponse({
        policy,
        matches: [],
        status: onlineResult?.status === 'source_review_required' ? 'source_review_required' : 'not_found',
        message: onlineResult?.message,
        savedRecordCount,
      }));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
