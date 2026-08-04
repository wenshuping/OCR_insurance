import express from 'express';
import { sendError } from '../http/errors.mjs';
import {
  buildCustomerPolicyPhotoKnowledgeRecord,
  customerPolicyPhotoPendingMatch,
  mergeCustomerPolicyPhotoScans,
  normalizeCustomerPolicyPhotoUploadItems,
  sanitizeCustomerPolicyPhotoOcrPage,
  sanitizeCustomerPolicyPhotoKnowledgeText,
} from '../customer-policy-photo-knowledge.service.mjs';
import { parseCustomerUploadResponsibilityArtifact } from '../customer-upload-responsibility-pipeline.service.mjs';
import {
  evidenceVerificationFields,
  isFormalResponsibilityEvidence,
} from '../evidence-classification.service.mjs';
import { hydratePolicyCoverageIndicators } from '../policy-ocr.domain.mjs';
import { isCurrentResponsibilityProjection } from '../policy-derived-results.service.mjs';
import { mergeResponsibilityCardIndicators } from '../responsibility-card-standardizer.mjs';
import {
  productIdentityMatches,
} from '../product-responsibility-identity.mjs';
import {
  derivedProjectionNeedsOfficialPayoutFactorRefresh,
  loadProjectionKnowledgeRecordsForPolicy,
} from '../policy-knowledge-projection.mjs';

function recognizePendingScanKey({ user, guestId }) {
  const userId = String(user?.id || '').trim();
  if (userId) return `user:${userId}:recognize`;
  return guestId;
}

function assertPolicyEntryAuthenticated(user, message = '录入或上传保单前需要先完成手机验证码') {
  if (user?.id) return;
  const error = new Error(message);
  error.code = 'REGISTRATION_REQUIRED';
  error.status = 401;
  error.registrationRequiredNext = true;
  throw error;
}

export function createPolicyRoutes(context) {
  const router = express.Router();
  const {
    state,
    db,
    persist,
    persistPolicyScanSave,
    persistPendingScan,
    persistFamilyState,
    persistPolicyDerivedResult,
    persistPolicyState,
    persistPolicyDelete,
    persistResponsibilityLookupArtifacts,
    scanner,
    analyzer,
    adminPassword,
    performanceLogger,
    cashflowStore,
    cashValueStore,
    nowMs,
    elapsedMs,
    logPerformance,
    policyInputMetrics,
    resolveAuthUser,
    normalizeGuestId,
    assertUserCanSavePolicy,
    recognizePolicyInput,
    buildRecognizedPolicyAnalysisDraft,
    buildEffectiveOfficialDomainProfiles,
    buildKnowledgeSearchArtifacts,
    crawlOfficialKnowledge,
    findKnowledgeProductCandidates,
    withPolicyProductMatchStatus,
    upsertKnowledgeRecords,
    buildRawUploadSnapshot,
    storeGuestPendingScan,
    resolvePolicyScanInput,
    normalizeOptionalResponsibilities,
    buildOptionalResponsibilityReview,
    findPolicyCoverageIndicators,
    parseCustomerUploadResponsibility = parseCustomerUploadResponsibilityArtifact,
    normalizeProvidedAnalysis,
    requestOwner,
    familyInputHasBindingFields,
    buildPolicyFamilyBinding,
    normalizeFamilyBindingInput,
    ensureDefaultPolicyFamilyBinding,
    buildPolicyFromScan,
    recordPolicySourceRecords,
    clearGuestPendingScans,
    computeAndStoreCashflow,
    computeCurrentPolicyCashflow,
    computePolicyResponsibilityCalculations,
    hydrateCashflowIndicatorsFromCurrentProductIndex,
    loadCurrentPolicyIndicators,
    startPolicyReportGeneration,
    policyReportGenerationTimeoutMs,
    attachPolicyCoverageIndicators,
    buildPolicyDerivedResult,
    mergePolicyDerivedResult,
    buildResponsibilitySummaryReportFromCards,
    buildResponsibilityCardsForPolicy,
    isGeneratedResponsibilityCountReport,
    mergeCoverageTableWithCheckedRows,
    responsibilityRowsFromCards,
    attachPolicyFamilyDisplay,
    selectedCoverageIndicators,
    computeScenarioEntries,
    findPolicyForReportRequest,
    policyProductIdentity,
    normalizePolicyUpdateData,
    hasOwn,
    birthdayFromIdNumber,
    shouldRebuildPolicyFamilyBinding,
    familyBindingInputFromPolicyUpdate,
    policyOwner,
    allocateId,
    archiveFamilyGeneratedReportsForPolicy,
    clearPolicyReportForRegeneration,
    buildPolicyReportScan,
    nowIso,
  } = context;
  const familyPersistOptions = { refreshOptionalResponsibilityGovernance: false };
  const activePolicyReportGenerationIds = new Set();

  function startTrackedPolicyReportGeneration(input) {
    const generationId = Number(input?.policy?.id || 0);
    if (!generationId || input?.policy?.reportStatus === 'ready' || activePolicyReportGenerationIds.has(generationId)) {
      return false;
    }
    activePolicyReportGenerationIds.add(generationId);
    try {
      const onSettled = input.onSettled;
      startPolicyReportGeneration({
        ...input,
        generationTimeoutMs: policyReportGenerationTimeoutMs,
        onSettled: (result) => {
          activePolicyReportGenerationIds.delete(generationId);
          if (typeof onSettled === 'function') onSettled(result);
        },
      });
      return true;
    } catch (error) {
      activePolicyReportGenerationIds.delete(generationId);
      throw error;
    }
  }

  function recoverInterruptedPolicyGeneration(policy) {
    const generationId = Number(policy?.id || 0);
    if (policy?.reportStatus !== 'generating' || activePolicyReportGenerationIds.has(generationId)) return false;
    policy.reportStatus = 'failed';
    policy.reportError = '上一次保险责任生成任务已中断，请点击刷新重试';
    policy.updatedAt = new Date().toISOString();
    return true;
  }

  const refreshReportStateKeys = [
    'report',
    'responsibilities',
    'responsibilityCards',
    'coverageIndicators',
    'optionalResponsibilities',
    'sources',
    'reportStatus',
    'reportError',
    'updatedAt',
  ];

  function captureRefreshReportState(policy) {
    return refreshReportStateKeys.map((key) => ({
      key,
      exists: Object.prototype.hasOwnProperty.call(policy, key),
      value: structuredClone(policy[key]),
    }));
  }

  function restoreRefreshReportState(policy, snapshot) {
    for (const item of snapshot) {
      if (item.exists) policy[item.key] = structuredClone(item.value);
      else delete policy[item.key];
    }
  }

  function hasRefreshReportContent(policy) {
    return Boolean(
      routeText(policy?.report)
      || (Array.isArray(policy?.responsibilities) && policy.responsibilities.length)
      || (Array.isArray(policy?.responsibilityCards) && policy.responsibilityCards.length)
      || (Array.isArray(policy?.coverageIndicators) && policy.coverageIndicators.length),
    );
  }

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

  function archivedFamilyReportArtifactsChanged(result = {}) {
    return Boolean(
      Number(result.archivedReportCount || 0) ||
      Number(result.archivedReportIssueCount || 0) ||
      Number(result.archivedReportCorrectionCount || 0) ||
      Number(result.archivedShareCount || 0) ||
      Number(result.archivedSalesReviewCount || 0)
    );
  }

  async function archiveGeneratedFamilyReportsForPolicy(policy, { previousFamilyId = null } = {}) {
    if (typeof archiveFamilyGeneratedReportsForPolicy !== 'function') {
      return {
        archivedReportCount: 0,
        archivedReportIssueCount: 0,
        archivedReportCorrectionCount: 0,
        archivedShareCount: 0,
        archivedSalesReviewCount: 0,
      };
    }
    const result = archiveFamilyGeneratedReportsForPolicy(state, policy, { previousFamilyId });
    if (archivedFamilyReportArtifactsChanged(result)) {
      if (persistFamilyState) await persistFamilyState({ includePolicies: false });
      else await persist(state, familyPersistOptions);
    }
    return result;
  }

  function findPolicyDerivedResult(policyId) {
    const id = Number(policyId || 0);
    if (!Number.isFinite(id) || id <= 0) return null;
    return (Array.isArray(state.policyDerivedResults) ? state.policyDerivedResults : [])
      .find((row) => Number(row?.policyId || 0) === id) || null;
  }

  function replacePolicyDerivedResult(derivedResult) {
    if (!derivedResult?.policyId) return;
    if (!Array.isArray(state.policyDerivedResults)) state.policyDerivedResults = [];
    const policyId = Number(derivedResult.policyId);
    state.policyDerivedResults = state.policyDerivedResults
      .filter((row) => Number(row?.policyId || 0) !== policyId);
    state.policyDerivedResults.push(derivedResult);
  }

  function buildDerivedResultForPolicy(policy) {
    if (typeof buildPolicyDerivedResult !== 'function') return null;
    const projectionKnowledge = projectionKnowledgeRecordsForPolicy(policy);
    const projectionCompany = routeText(projectionKnowledge[0]?.company) || routeText(policy?.company);
    const projectionPolicy = projectionCompany === routeText(policy?.company)
      ? policy
      : { ...policy, company: projectionCompany };
    const currentIndicators = typeof loadCurrentPolicyIndicators === 'function'
      ? loadCurrentPolicyIndicators(projectionPolicy)
      : null;
    return buildPolicyDerivedResult({
      policy: projectionPolicy,
      indicatorRecords: Array.isArray(currentIndicators) ? currentIndicators : state.insuranceIndicatorRecords,
      knowledgeRecords: projectionKnowledge.length ? projectionKnowledge : state.knowledgeRecords,
      officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      optionalResponsibilityRecords: state.optionalResponsibilityRecords,
      productIndicatorVersions: state.productIndicatorVersions,
      now: typeof nowIso === 'function' ? nowIso() : new Date().toISOString(),
    });
  }

  function needsLiveCoverageProjection(derivedResult, policy = {}) {
    return Boolean(
      derivedResult
      && (
        (!isCurrentResponsibilityProjection(derivedResult)
          && !(Array.isArray(derivedResult.coverageIndicators) && derivedResult.coverageIndicators.length))
        || derivedProjectionNeedsOfficialPayoutFactorRefresh({
          derivedResult,
          knowledgeRecords: projectionKnowledgeRecordsForPolicy(policy),
        })
      ),
    );
  }

  async function refreshDerivedArtifactsForPolicy(policy) {
    const derivedResult = buildDerivedResultForPolicy(policy);
    if (derivedResult) {
      replacePolicyDerivedResult(derivedResult);
      if (persistPolicyDerivedResult) await persistPolicyDerivedResult({ derivedResult });
    }
    try {
      computeAndStoreCashflow(policy);
    } catch (cfError) {
      console.error('[cashflow] compute failed for policy', policy.id, cfError.message);
    }
    await archiveGeneratedFamilyReportsForPolicy(policy);
  }

  function filteredKnowledgeRecordsForPolicy(policyDraft) {
    if (typeof buildKnowledgeSearchArtifacts !== 'function') return [];
    return buildKnowledgeSearchArtifacts({
      policy: policyDraft,
      records: state.knowledgeRecords || [],
      officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
    }).records || [];
  }

  function projectionKnowledgeRecordsForPolicy(policyDraft) {
    const stateRecords = db?.prepare ? [] : (state?.knowledgeRecords || []).filter((record) => (
      productIdentityMatches(record, policyDraft)
      && (routeText(record?.url) || routeText(record?.pageText) || routeText(record?.snippet))
    ));
    return loadProjectionKnowledgeRecordsForPolicy({
      db,
      policy: policyDraft,
      filteredRecords: stateRecords,
      stateRecords,
    });
  }

  function policyNeedsOfficialFormulaDependencyRefresh(policyDraft) {
    const derivedResult = findPolicyDerivedResult(policyDraft?.id);
    const projectionText = JSON.stringify({
      report: policyDraft?.report,
      responsibilities: policyDraft?.responsibilities,
      responsibilityCards: policyDraft?.responsibilityCards,
      coverageIndicators: derivedResult?.coverageIndicators,
    });
    if (!/(?:monthly_conversion_factor|月领折算系数)/u.test(projectionText)) return false;
    return !projectionKnowledgeRecordsForPolicy(policyDraft).some((record) => (
      /月领折算系数(?:的数值)?为\s*(?:0(?:\.\d+)?|1(?:\.0+)?)/u.test(
        routeText(record?.pageText || record?.originalPageText || record?.sourceExcerpt),
      )
    ));
  }

  function boundOfficialSourcesForPolicy(policyDraft = {}) {
    const candidates = [
      ...(Array.isArray(policyDraft?.sources) ? policyDraft.sources : []),
      { url: policyDraft?.officialPdfUrl, title: policyDraft?.sourceTitle, official: true },
      { url: policyDraft?.sourceUrl, title: policyDraft?.sourceTitle, official: policyDraft?.official },
      { url: policyDraft?.clauseUrl, title: policyDraft?.sourceTitle, official: policyDraft?.official },
    ];
    const byUrl = new Map();
    for (const source of candidates) {
      const url = routeText(source?.url || source?.sourceUrl || source?.officialUrl);
      if (!url || source?.official === false) continue;
      if (!byUrl.has(url)) byUrl.set(url, { ...source, url });
    }
    return [...byUrl.values()];
  }

  async function refreshOfficialKnowledgeForPolicy(policyDraft, { includePlans = false, requireFresh = false } = {}) {
    const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
    const products = [{
      company: routeText(policyDraft?.company),
      name: routeText(policyDraft?.name || policyDraft?.productName),
      boundSources: boundOfficialSourcesForPolicy(policyDraft),
    }];
    if (includePlans) {
      for (const plan of Array.isArray(policyDraft?.plans) ? policyDraft.plans : []) {
        products.push({
          company: routeText(plan?.company || policyDraft?.company),
          name: routeText(plan?.matchedProductName || plan?.productName || plan?.name),
          boundSources: boundOfficialSourcesForPolicy(plan),
        });
      }
    }
    const productsByIdentity = new Map();
    for (const product of products.filter((item) => item.company && item.name)) {
      const key = `${compactPolicyText(product.company)}::${compactPolicyText(product.name)}`;
      const existing = productsByIdentity.get(key);
      if (!existing) {
        productsByIdentity.set(key, product);
        continue;
      }
      existing.boundSources = boundOfficialSourcesForPolicy({
        sources: [...existing.boundSources, ...product.boundSources],
      });
    }
    const uniqueProducts = [...productsByIdentity.values()];
    const available = [];
    const discovered = [];
    for (const product of uniqueProducts) {
      const boundUrls = new Set(product.boundSources.map((source) => routeText(source?.url)).filter(Boolean));
      const cachedRecords = projectionKnowledgeRecordsForPolicy(product).filter((record) => (
        isFormalResponsibilityEvidence(record)
        && record?.official !== false
        && routeText(record?.sourceType).toLowerCase() === 'pdf'
        && routeText(record?.url)
        && routeText(record?.sourceDigest || record?.source_digest || record?.pdfSha256)
        && (!boundUrls.size || boundUrls.has(routeText(record?.url)))
        && routeText(record?.pageText || record?.originalPageText)
      ));
      if (cachedRecords.length) {
        available.push(...cachedRecords);
        continue;
      }
      if (typeof crawlOfficialKnowledge !== 'function' || typeof upsertKnowledgeRecords !== 'function') {
        if (!requireFresh) continue;
        const error = new Error('当前无法重新获取官方资料，请稍后重试');
        error.code = 'POLICY_OFFICIAL_KNOWLEDGE_REFRESH_UNAVAILABLE';
        error.status = 503;
        throw error;
      }
      const records = await crawlOfficialKnowledge({ policy: product, officialDomainProfiles });
      if (requireFresh && !records.length) {
        const error = new Error(`未找到${product.name}的最新官方资料，未生成新的保单详情`);
        error.code = 'POLICY_OFFICIAL_KNOWLEDGE_REFRESH_EMPTY';
        error.status = 404;
        throw error;
      }
      discovered.push(...records);
    }
    const saved = discovered.length
      ? upsertKnowledgeRecords(state, discovered, { allocateId, officialDomainProfiles })
      : [];
    if (saved.length && typeof persistResponsibilityLookupArtifacts === 'function') {
      await persistResponsibilityLookupArtifacts({ knowledgeRecords: saved });
    }
    return [...available, ...saved];
  }

  function routeText(value) {
    return String(value ?? '').trim();
  }

  function compactPolicyText(value) {
    return routeText(value).normalize('NFKC').replace(/\s+/gu, '');
  }

  function withFallbackCardSources(cards = [], policyDraft = {}) {
    const cardRows = Array.isArray(cards) ? cards : [];
    if (!cardRows.length) return cardRows;
    const filteredKnowledge = filteredKnowledgeRecordsForPolicy(policyDraft);
    const knowledge = filteredKnowledge.find((record) => routeText(record?.url) || routeText(record?.pageText) || routeText(record?.snippet))
      || (state?.knowledgeRecords || []).find((record) => {
        const company = compactPolicyText(policyDraft.company);
        const productName = compactPolicyText(policyDraft.name || policyDraft.productName);
        const recordCompany = compactPolicyText(record?.company);
        const recordProductName = compactPolicyText(record?.productName || record?.name);
        return (
          company &&
          productName &&
          recordCompany === company &&
          (recordProductName === productName || recordProductName.includes(productName) || productName.includes(recordProductName)) &&
          (routeText(record?.url) || routeText(record?.pageText) || routeText(record?.snippet))
        );
      });
    if (!knowledge) return cardRows;
    return cardRows.map((card) => {
      if (routeText(card?.sourceUrl) && routeText(card?.sourceExcerpt)) return card;
      const sourceUrl = routeText(card?.sourceUrl) || routeText(knowledge.url);
      const sourceTitle = routeText(card?.sourceTitle) || routeText(knowledge.title);
      const sourceExcerpt = routeText(card?.sourceExcerpt) || routeText(knowledge.pageText) || routeText(knowledge.snippet);
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

  function policyProductMatchResponse({ policy, matches = [], message = '', savedRecordCount = 0 } = {}) {
    const resolved = typeof withPolicyProductMatchStatus === 'function'
      ? withPolicyProductMatchStatus({ policy, matches })
      : { status: matches.length ? 'candidates' : 'not_found', matches };
    return {
      status: resolved.status,
      matches: resolved.matches,
      message: message || (resolved.status === 'candidates'
        ? '已根据补充照片找到产品线索，请确认后继续'
        : '补充照片已识别，但仍未匹配到明确产品'),
      savedRecordCount,
    };
  }

  function buildManualScanFallback(body = {}) {
    const manualData = body?.manualData && typeof body.manualData === 'object' ? body.manualData : {};
    return {
      ocrText: String(body?.ocrText || '').trim(),
      data: {
        ...manualData,
        company: routeText(manualData.company || body.company),
        name: routeText(manualData.name || body.name),
      },
    };
  }

  const manualSaveOcrFailureCodes = new Set([
    'POLICY_OCR_FAILED',
    'POLICY_SCAN_FAILED',
    'POLICY_OCR_SERVICE_UNAVAILABLE',
    'POLICY_OCR_UPSTREAM_TIMEOUT',
  ]);

  function canFallbackToManualPolicySave(body = {}, error = null) {
    const manualData = body?.manualData && typeof body.manualData === 'object' ? body.manualData : {};
    return Boolean(
      body?.uploadItem
      && routeText(manualData.company || body.company)
      && routeText(manualData.name || body.name)
      && manualSaveOcrFailureCodes.has(routeText(error?.code || error?.message)),
    );
  }

  function hydrateProvidedAnalysisFromCards(analysis, policyDraft) {
    if (!analysis || typeof analysis !== 'object') return null;
    const responsibilityCards = withFallbackCardSources(analysis.responsibilityCards, policyDraft);
    if (!responsibilityCards.length) return analysis;
    const optionalResponsibilities = Array.isArray(analysis.optionalResponsibilities) ? analysis.optionalResponsibilities : [];
    const checkedCoverageTable = typeof responsibilityRowsFromCards === 'function'
      ? responsibilityRowsFromCards(responsibilityCards, { optionalResponsibilities })
      : [];
    const existingCoverageTable = Array.isArray(analysis.coverageTable) ? analysis.coverageTable : [];
    const effectiveCoverageTable = typeof mergeCoverageTableWithCheckedRows === 'function'
      ? mergeCoverageTableWithCheckedRows(existingCoverageTable, checkedCoverageTable)
      : (checkedCoverageTable.length ? checkedCoverageTable : existingCoverageTable);
    const hadExplicitResult = Boolean(
      routeText(analysis.report) ||
        existingCoverageTable.length ||
        optionalResponsibilities.length
    );
    if (!hadExplicitResult && !checkedCoverageTable.length) return null;
    return {
      ...analysis,
      report: responsibilityReportFor({
        current: analysis.report,
        rows: checkedCoverageTable,
        cards: responsibilityCards,
        optionalResponsibilities,
      }),
      coverageTable: effectiveCoverageTable,
      responsibilityCards,
    };
  }

  function attachStoredPolicyDerivedResult(policy, derivedResult = findPolicyDerivedResult(policy?.id)) {
    const displayed = attachPolicyFamilyDisplay(policy, state);
    const requiresLiveProjection = needsLiveCoverageProjection(derivedResult, displayed);
    const missingCoverageIndicators = Boolean(
      derivedResult
      && !isCurrentResponsibilityProjection(derivedResult)
      && !(Array.isArray(derivedResult.coverageIndicators) && derivedResult.coverageIndicators.length),
    );
    if (derivedResult && !requiresLiveProjection) {
      if (typeof mergePolicyDerivedResult === 'function') {
        return mergePolicyDerivedResult(displayed, derivedResult);
      }
      return {
        ...displayed,
        coverageIndicators: Array.isArray(derivedResult.coverageIndicators) ? derivedResult.coverageIndicators : [],
        optionalResponsibilities: Array.isArray(derivedResult.optionalResponsibilities) ? derivedResult.optionalResponsibilities : [],
      };
    }
    if (requiresLiveProjection) {
      const rebuilt = buildDerivedResultForPolicy(displayed);
      if (rebuilt && typeof mergePolicyDerivedResult === 'function') {
        return mergePolicyDerivedResult(displayed, {
          ...rebuilt,
          status: 'stale',
          staleReason: missingCoverageIndicators
            ? 'missing_coverage_indicators'
            : 'missing_official_payout_factor_evidence',
        });
      }
    }
    if (typeof attachPolicyCoverageIndicators === 'function') {
      const currentIndicators = typeof loadCurrentPolicyIndicators === 'function'
        ? loadCurrentPolicyIndicators(displayed)
        : null;
      const currentKnowledgeRecords = projectionKnowledgeRecordsForPolicy(displayed);
      const attached = attachPolicyCoverageIndicators(
        displayed,
        Array.isArray(currentIndicators) ? currentIndicators : state.insuranceIndicatorRecords,
        currentKnowledgeRecords.length ? currentKnowledgeRecords : (db?.prepare ? [] : state.knowledgeRecords),
        state.optionalResponsibilityRecords,
      );
      if (typeof mergePolicyDerivedResult === 'function') {
        return {
          ...mergePolicyDerivedResult(attached, null),
          derivedStaleReason: derivedResult ? 'missing_coverage_indicators' : 'missing',
        };
      }
      return {
        ...attached,
        derivedStatus: 'stale',
        derivedStaleReason: derivedResult ? 'missing_coverage_indicators' : 'missing',
      };
    }
    if (typeof mergePolicyDerivedResult === 'function') {
      return mergePolicyDerivedResult(displayed, null);
    }
    return {
      ...displayed,
      coverageIndicators: Array.isArray(displayed.coverageIndicators) ? displayed.coverageIndicators : [],
      optionalResponsibilities: Array.isArray(displayed.optionalResponsibilities) ? displayed.optionalResponsibilities : [],
    };
  }

  function attachPolicyCashflowData(policy) {
    const currentProductIndicators = typeof hydrateCashflowIndicatorsFromCurrentProductIndex === 'function'
      ? hydrateCashflowIndicatorsFromCurrentProductIndex(policy, policy.coverageIndicators)
      : policy.coverageIndicators;
    const currentIndicatorRecords = typeof loadCurrentPolicyIndicators === 'function'
      ? loadCurrentPolicyIndicators(policy)
      : null;
    const coverageIndicators = hydratePolicyCoverageIndicators(
      currentProductIndicators,
      Array.isArray(currentIndicatorRecords) ? currentIndicatorRecords : state.insuranceIndicatorRecords,
      policy.responsibilities,
    );
    const policyWithCurrentIndicators = {
      ...policy,
      coverageIndicators,
    };
    const shouldRebuildResponsibilityCards = !isCurrentResponsibilityProjection({
      responsibilityProjectionVersion: policy.derivedResponsibilityProjectionVersion,
    });
    const rebuiltResponsibilityCards = shouldRebuildResponsibilityCards && typeof buildResponsibilityCardsForPolicy === 'function'
      ? buildResponsibilityCardsForPolicy({
        policy: policyWithCurrentIndicators,
        responsibilities: policy.responsibilities,
        coverageIndicators,
        knowledgeRecords: projectionKnowledgeRecordsForPolicy(policyWithCurrentIndicators),
        optionalResponsibilityRecords: policy.optionalResponsibilities,
      })
      : [];
    const policyWithCurrentProjection = rebuiltResponsibilityCards.length
      ? {
          ...policyWithCurrentIndicators,
          coverageIndicators: mergeResponsibilityCardIndicators(coverageIndicators, rebuiltResponsibilityCards),
          responsibilityCards: rebuiltResponsibilityCards,
        }
      : policyWithCurrentIndicators;
    const responsibilityCalculations = typeof computePolicyResponsibilityCalculations === 'function'
      ? computePolicyResponsibilityCalculations(policyWithCurrentProjection, policyWithCurrentProjection.coverageIndicators)
      : [];
    const entries = typeof computeCurrentPolicyCashflow === 'function'
      ? computeCurrentPolicyCashflow(
          policyWithCurrentProjection,
          projectionKnowledgeRecordsForPolicy(policyWithCurrentProjection),
        )
      : cashflowStore.getEntries(policy.id);
    const cashValues = cashValueStore.getValues(policy.id);
    const totalCashflow = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    let scenarioEntries = [];
    try {
      const policyIndicators = policyWithCurrentProjection.coverageIndicators.length
        ? policyWithCurrentProjection.coverageIndicators
        : findPolicyCoverageIndicators(policyWithCurrentProjection, state.insuranceIndicatorRecords);
      scenarioEntries = computeScenarioEntries(selectedCoverageIndicators(policyIndicators), policyWithCurrentProjection);
    } catch (_err) {
      // non-fatal: scenarioEntries stays empty
    }
    return {
      ...policyWithCurrentProjection,
      responsibilityCalculations,
      cashflowEntries: entries.length ? entries : undefined,
      cashValues,
      scenarioEntries: scenarioEntries.length ? scenarioEntries : undefined,
      totalCashflow: entries.length ? totalCashflow : undefined,
    };
  }

  router.post('/policies/recognize', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const user = resolveAuthUser(req, state);
      assertPolicyEntryAuthenticated(user, '上传保单照片前需要先验证手机号');
      const guestId = normalizeGuestId(req.body?.guestId);
      const rawUpload = buildRawUploadSnapshot(req.body);
      const pendingScanKey = recognizePendingScanKey({ user, guestId });
      if (pendingScanKey) {
        storeGuestPendingScan(state, { guestId: pendingScanKey, scan: null, analysis: null, rawUpload });
        if (persistPendingScan) await persistPendingScan({ guestId: pendingScanKey });
        else await persist(state);
      }
      const ocrStartedAt = nowMs();
      const scan = await recognizePolicyInput({ scanner, body: req.body, state, applyManualData: false });
      logPerformance(performanceLogger, 'policy.recognize.ocr', {
        route: '/api/policies/recognize',
        durationMs: elapsedMs(ocrStartedAt),
        ...policyInputMetrics(req.body),
        outputOcrChars: String(scan?.ocrText || '').length,
      });
      const analysis = await buildRecognizedPolicyAnalysisDraft({
        state,
        scan,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      });
      if (pendingScanKey) {
        storeGuestPendingScan(state, { guestId: pendingScanKey, scan, analysis, rawUpload });
        if (persistPendingScan) await persistPendingScan({ guestId: pendingScanKey });
        else await persist(state);
      }
      logPerformance(performanceLogger, 'policy.recognize.complete', {
        route: '/api/policies/recognize',
        durationMs: elapsedMs(routeStartedAt),
        ...policyInputMetrics(req.body),
      });
      const payload = {
        ok: true,
        scan,
        registrationRequiredNext: false,
      };
      if (analysis) payload.analysis = analysis;
      res.json(payload);
    } catch (error) {
      console.error('[policy-recognize] failed', {
        code: error?.code || error?.message,
        message: error?.message,
        status: error?.status,
      });
      sendError(res, error);
    }
  });

  router.post('/policies/product-knowledge-scan', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const user = resolveAuthUser(req, state);
      assertPolicyEntryAuthenticated(user, '上传补充产品页前需要先验证手机号');
      const guestId = normalizeGuestId(req.body?.guestId);
      const uploadItems = normalizeCustomerPolicyPhotoUploadItems(req.body?.uploadItems);
      const manualData = {
        ...(req.body?.manualData && typeof req.body.manualData === 'object' ? req.body.manualData : {}),
        company: routeText(req.body?.manualData?.company || req.body?.company),
        name: routeText(req.body?.manualData?.name || req.body?.name),
      };
      const baseScan = req.body?.scan && typeof req.body.scan === 'object'
        ? await resolvePolicyScanInput({ scanner, body: { ...req.body, uploadItem: null, manualData }, state })
        : buildManualScanFallback({ ...req.body, manualData });

      const supplementScans = [];
      for (const uploadItem of uploadItems) {
        const scan = await recognizePolicyInput({
          scanner,
          body: {
            ...req.body,
            uploadItem,
            uploadItems: undefined,
            ocrText: '',
            ocrScenario: 'insurance_material',
            manualData,
          },
          state,
          applyManualData: false,
        });
        supplementScans.push(scan);
      }

      const mergedScan = mergeCustomerPolicyPhotoScans({
        baseScan,
        supplementScans,
        manualData,
        fallback: {
          company: req.body?.company,
          name: req.body?.name,
        },
      });
      const policyDraft = {
        ...(mergedScan.data || {}),
        ocrText: String(mergedScan.ocrText || '').trim(),
      };
      const ocrPages = supplementScans.map((scan, index) => ({
        pageNumber: index + 1,
        name: uploadItems[index]?.name || `第${index + 1}张`,
        ocrText: sanitizeCustomerPolicyPhotoOcrPage({
          ocrText: scan?.ocrText,
          scan,
          manualData,
        }),
      })).filter((page) => page.ocrText);
      const existingCoverageIndicators = findPolicyCoverageIndicators(policyDraft, state.insuranceIndicatorRecords);
      const reusablePipelineIndicators = existingCoverageIndicators.filter((indicator) => (
        String(indicator?.extractionMethod || '') === 'official_clause_deterministic_pipeline'
        && String(indicator?.responsibilityId || '').trim()
      ));
      const reuseExistingPipelineResult = reusablePipelineIndicators.length > 0;
      const responsibilityPipeline = reuseExistingPipelineResult
        ? {
            status: 'reused_library',
            pipelineVersion: 'official_clause_deterministic_pipeline',
            attempts: 0,
            normalizationPasses: 0,
            validationIssues: [],
            artifact: null,
          }
        : await parseCustomerUploadResponsibility({
            company: policyDraft.company,
            productName: policyDraft.name,
            ocrPages,
          });
      const sanitizedText = sanitizeCustomerPolicyPhotoKnowledgeText({
        ocrText: mergedScan.ocrText,
        scan: mergedScan,
        manualData,
      }) || ocrPages.map((page) => page.ocrText).join('\n').slice(0, 6000).trim();
      const knowledgeRecord = reuseExistingPipelineResult ? null : buildCustomerPolicyPhotoKnowledgeRecord({
        company: policyDraft.company,
        productName: policyDraft.name,
        pageText: sanitizedText,
        ownerUserId: user?.id,
        ownerGuestId: guestId,
        uploadItems,
        ocrPages,
        responsibilityPipeline,
      });
      const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
      const savedKnowledgeRecords = knowledgeRecord && typeof upsertKnowledgeRecords === 'function'
        ? upsertKnowledgeRecords(state, [knowledgeRecord], { allocateId, officialDomainProfiles })
        : [];
      if (savedKnowledgeRecords.length && typeof persistResponsibilityLookupArtifacts === 'function') {
        await persistResponsibilityLookupArtifacts({ knowledgeRecords: savedKnowledgeRecords });
      }

      const optionalResponsibilities = buildOptionalResponsibilityReview(
        policyDraft,
        findPolicyCoverageIndicators(policyDraft, state.insuranceIndicatorRecords),
        savedKnowledgeRecords,
        state.optionalResponsibilityRecords,
      );
      mergedScan.data = {
        ...(mergedScan.data || {}),
        optionalResponsibilities,
      };

      const policy = {
        company: routeText(mergedScan.data.company),
        name: routeText(mergedScan.data.name),
      };
      const localMatches = typeof findKnowledgeProductCandidates === 'function' && policy.company && policy.name
        ? findKnowledgeProductCandidates({
            policy,
            records: state.knowledgeRecords || [],
            officialDomainProfiles,
            maxResults: 3,
            minScore: 0.32,
          })
        : [];
      const pendingMatch = customerPolicyPhotoPendingMatch(savedKnowledgeRecords[0]);
      const matches = pendingMatch ? [...localMatches, pendingMatch] : localMatches;
      const matchPayload = policyProductMatchResponse({
        policy,
        matches,
        savedRecordCount: savedKnowledgeRecords.length,
      });

      logPerformance(performanceLogger, 'policy.product_knowledge_scan.complete', {
        route: '/api/policies/product-knowledge-scan',
        durationMs: elapsedMs(routeStartedAt),
        uploadBytes: uploadItems.reduce((sum, item) => sum + (Number(item?.size || 0) || 0), 0),
        hasUpload: true,
        uploadCount: uploadItems.length,
        outputOcrChars: String(mergedScan.ocrText || '').length,
        knowledgeRecordCount: savedKnowledgeRecords.length,
      });
      res.json({
        ok: true,
        scan: mergedScan,
        supplementOcrText: supplementScans.map((scan) => String(scan?.ocrText || '').trim()).filter(Boolean).join('\n'),
        optionalResponsibilities,
        knowledgeRecordIds: savedKnowledgeRecords.map((record) => record.id).filter(Boolean),
        uploadedCount: uploadItems.length,
        responsibilityPipelineStatus: responsibilityPipeline.status,
        responsibilityPipelineAttempts: responsibilityPipeline.attempts,
        responsibilityValidationIssues: responsibilityPipeline.validationIssues,
        reusedLibraryResponsibilityCount: reusablePipelineIndicators.length,
        ...matchPayload,
      });
    } catch (error) {
      console.error('[policy-product-knowledge-scan] failed', {
        code: error?.code || error?.message,
        message: error?.message,
        status: error?.status,
      });
      sendError(res, error);
    }
  });

  router.post('/policies/analyze', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const user = resolveAuthUser(req, state);
      assertPolicyEntryAuthenticated(user);
      const guestId = normalizeGuestId(req.body?.guestId);
      const rawUpload = buildRawUploadSnapshot(req.body);
      if (!user && guestId && !req.body?.scan) {
        storeGuestPendingScan(state, { guestId, scan: null, analysis: null, rawUpload });
        if (persistPendingScan) await persistPendingScan({ guestId });
        else await persist(state);
      }
      const scanStartedAt = nowMs();
      const normalizedScan = await resolvePolicyScanInput({ scanner, body: req.body, state });
      if (!req.body?.scan) {
        logPerformance(performanceLogger, 'policy.analyze.ocr', {
          route: '/api/policies/analyze',
          durationMs: elapsedMs(scanStartedAt),
          ...policyInputMetrics(req.body),
          outputOcrChars: String(normalizedScan?.ocrText || '').length,
        });
      }
      const analysisStartedAt = nowMs();
      const analysis = await analyzer({ scan: normalizedScan });
      const policyDraft = {
        ...(normalizedScan?.data || {}),
        ocrText: String(normalizedScan?.ocrText || '').trim(),
        responsibilities: Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : [],
        optionalResponsibilities: normalizeOptionalResponsibilities(analysis?.optionalResponsibilities),
      };
      const optionalResponsibilities = buildOptionalResponsibilityReview(
        policyDraft,
        findPolicyCoverageIndicators(policyDraft, state.insuranceIndicatorRecords),
        state.knowledgeRecords,
        state.optionalResponsibilityRecords,
      );
      const policyDraftWithOptionalResponsibilities = {
        ...policyDraft,
        optionalResponsibilities,
      };
      const projectionKnowledge = projectionKnowledgeRecordsForPolicy(policyDraftWithOptionalResponsibilities);
      const projectionCompany = routeText(projectionKnowledge[0]?.company) || routeText(policyDraftWithOptionalResponsibilities.company);
      const projectionPolicy = projectionCompany === routeText(policyDraftWithOptionalResponsibilities.company)
        ? policyDraftWithOptionalResponsibilities
        : { ...policyDraftWithOptionalResponsibilities, company: projectionCompany };
      const coverageIndicators = findPolicyCoverageIndicators(projectionPolicy, state.insuranceIndicatorRecords);
      const rawResponsibilityCards = typeof buildResponsibilityCardsForPolicy === 'function'
        ? buildResponsibilityCardsForPolicy({
            policy: projectionPolicy,
            responsibilities: analysis?.coverageTable,
            coverageIndicators,
            knowledgeRecords: projectionKnowledge,
            optionalResponsibilityRecords: optionalResponsibilities,
          })
        : [];
      const responsibilityCards = withFallbackCardSources(rawResponsibilityCards, policyDraftWithOptionalResponsibilities);
      const checkedCoverageTable = typeof responsibilityRowsFromCards === 'function'
        ? responsibilityRowsFromCards(responsibilityCards, { optionalResponsibilities })
        : [];
      const effectiveCoverageTable = typeof mergeCoverageTableWithCheckedRows === 'function'
        ? mergeCoverageTableWithCheckedRows(analysis?.coverageTable, checkedCoverageTable)
        : (checkedCoverageTable.length ? checkedCoverageTable : (Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : []));
      const analysisWithOptionalResponsibilities = {
        ...analysis,
        report: responsibilityReportFor({
          current: analysis?.report,
          rows: checkedCoverageTable,
          cards: responsibilityCards,
          optionalResponsibilities,
        }),
        coverageTable: effectiveCoverageTable,
        optionalResponsibilities,
        responsibilityCards,
      };
      logPerformance(performanceLogger, 'policy.analyze.analysis', {
        route: '/api/policies/analyze',
        durationMs: elapsedMs(analysisStartedAt),
        ...policyInputMetrics(req.body),
        outputOcrChars: String(normalizedScan?.ocrText || '').length,
        responsibilityCount: Array.isArray(analysis?.coverageTable) ? analysis.coverageTable.length : 0,
      });
      if (!user && guestId) {
        storeGuestPendingScan(state, {
          guestId,
          scan: normalizedScan,
          analysis: analysisWithOptionalResponsibilities,
          rawUpload,
        });
        if (persistPendingScan) await persistPendingScan({ guestId });
        else await persist(state);
      }
      logPerformance(performanceLogger, 'policy.analyze.complete', {
        route: '/api/policies/analyze',
        durationMs: elapsedMs(routeStartedAt),
        ...policyInputMetrics(req.body),
      });
      res.json({
        ok: true,
        scan: normalizedScan,
        analysis: analysisWithOptionalResponsibilities,
        registrationRequiredNext: false,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/policies/scan', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const user = resolveAuthUser(req, state);
      assertPolicyEntryAuthenticated(user, '保存保单前需要先验证手机号');
      const guestId = normalizeGuestId(req.body?.guestId);
      if (typeof assertUserCanSavePolicy === 'function') {
        assertUserCanSavePolicy(state, user, { now: typeof nowIso === 'function' ? nowIso() : undefined });
      }
      const scanStartedAt = nowMs();
      let normalizedScan;
      let ocrFallbackWarning = '';
      try {
        normalizedScan = await resolvePolicyScanInput({ scanner, body: req.body, state });
      } catch (error) {
        if (!canFallbackToManualPolicySave(req.body, error)) throw error;
        ocrFallbackWarning = '图片识别服务暂不可用，已按你填写的保单信息保存；图片内容建议稍后重新识别核对。';
        normalizedScan = {
          ...buildManualScanFallback(req.body),
          ocrWarnings: [ocrFallbackWarning],
        };
        console.warn('[policy-scan] OCR unavailable, saved verified manual input', {
          code: error?.code || error?.message || 'POLICY_OCR_FAILED',
          company: normalizedScan.data.company,
          productName: normalizedScan.data.name,
        });
      }
      if (!req.body?.scan) {
        logPerformance(performanceLogger, 'policy.scan.ocr', {
          route: '/api/policies/scan',
          durationMs: elapsedMs(scanStartedAt),
          ...policyInputMetrics(req.body),
          outputOcrChars: String(normalizedScan?.ocrText || '').length,
        });
      } else {
        logPerformance(performanceLogger, 'policy.scan.ocr', {
          route: '/api/policies/scan',
          durationMs: elapsedMs(scanStartedAt),
          ...policyInputMetrics(req.body),
          outputOcrChars: String(normalizedScan?.ocrText || '').length,
          reusedScan: true,
        });
      }
      const providedAnalysis = hydrateProvidedAnalysisFromCards(
        normalizeProvidedAnalysis(req.body?.analysis),
        normalizedScan?.data || {},
      );
      const providedAnalysisHasReportResult = Boolean(
        providedAnalysis?.report ||
          providedAnalysis?.coverageTable?.length ||
          providedAnalysis?.responsibilityCards?.length
      );
      if (providedAnalysis) {
        logPerformance(performanceLogger, 'policy.scan.analysis', {
          route: '/api/policies/scan',
          durationMs: 0,
          ...policyInputMetrics(req.body),
          outputOcrChars: String(normalizedScan?.ocrText || '').length,
          responsibilityCount: Array.isArray(providedAnalysis?.coverageTable) ? providedAnalysis.coverageTable.length : 0,
          reusedAnalysis: true,
        });
      }
      const familyInputSource = {
        ...(req.body || {}),
        ...(req.body?.manualData && typeof req.body.manualData === 'object' ? req.body.manualData : {}),
      };
      const owner = requestOwner(req, user);
      const familyBinding = familyInputHasBindingFields(familyInputSource)
        ? buildPolicyFamilyBinding(
            state,
            normalizeFamilyBindingInput(familyInputSource),
            owner,
            normalizedScan?.data || {},
          )
        : ensureDefaultPolicyFamilyBinding(state, owner, normalizedScan?.data || {});
      const policy = buildPolicyFromScan({
        state,
        userId: user?.id || null,
        guestId,
        scan: normalizedScan,
        analysis: providedAnalysis,
        familyBinding,
      });
      state.policies.push(policy);
      if (providedAnalysis) recordPolicySourceRecords(state, policy, providedAnalysis);
      const derivedResult = buildDerivedResultForPolicy(policy);
      if (derivedResult) replacePolicyDerivedResult(derivedResult);
      const clearPendingGuestId = recognizePendingScanKey({ user, guestId }) || '';
      if (clearPendingGuestId) clearGuestPendingScans(state, clearPendingGuestId);
      if (persistPolicyScanSave) {
        await persistPolicyScanSave({ policy, clearPendingGuestId });
      } else {
        await persist(state);
      }
      if (derivedResult && persistPolicyDerivedResult) {
        await persistPolicyDerivedResult({ derivedResult });
      }

      let cashflowEntries = [];
      let scenarioEntries = [];
      let totalCashflow = 0;
      try {
        const result = computeAndStoreCashflow(policy);
        cashflowEntries = result.cashflowEntries;
        scenarioEntries = result.scenarioEntries;
        totalCashflow = result.totalCashflow;
      } catch (cfError) {
        console.error('[cashflow] compute failed for policy', policy.id, cfError.message);
      }
      await archiveGeneratedFamilyReportsForPolicy(policy);

      if (!providedAnalysisHasReportResult) {
        startTrackedPolicyReportGeneration({
          state,
          policy,
          scan: normalizedScan,
          analyzer,
          persist: () => (persistPolicyState ? persistPolicyState({ policy }) : persist(state)),
          afterApply: () => refreshDerivedArtifactsForPolicy(policy),
          performanceLogger,
          requestMetrics: policyInputMetrics(req.body),
        });
      }
      logPerformance(performanceLogger, 'policy.scan.complete', {
        route: '/api/policies/scan',
        durationMs: elapsedMs(routeStartedAt),
        ...policyInputMetrics(req.body),
        outputOcrChars: String(normalizedScan?.ocrText || '').length,
        policyId: policy.id,
      });
      res.status(201).json({
        ok: true,
        ocrFallbackUsed: Boolean(ocrFallbackWarning),
        ocrWarning: ocrFallbackWarning,
        policy: {
          ...attachStoredPolicyDerivedResult(policy, derivedResult),
          cashflowEntries,
          scenarioEntries,
          totalCashflow,
        },
        registrationRequiredNext: false,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/policies', async (req, res) => {
    const user = resolveAuthUser(req, state);
    const guestId = normalizeGuestId(req.query?.guestId);
    if (!user && !guestId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
    }
    const policies = state.policies
      .filter((policy) => {
        if (user) return Number(policy.userId) === Number(user.id);
        return String(policy.guestId || '') === guestId && !policy.userId;
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const interruptedPolicies = policies.filter(recoverInterruptedPolicyGeneration);
    if (persistPolicyState && interruptedPolicies.length) {
      await Promise.all(interruptedPolicies.map((policy) => persistPolicyState({ policy })));
    } else if (interruptedPolicies.length) {
      await persist(state);
    }
    const policiesWithCashflow = policies
      .map((policy) => attachStoredPolicyDerivedResult(policy))
      .map((policy) => attachPolicyCashflowData(policy));
    res.json({ ok: true, policies: policiesWithCashflow });
  });

  router.patch('/policies/:id', async (req, res) => {
    try {
      const result = findPolicyForReportRequest(req, state, adminPassword);
      if (!result.policy) {
        return res.status(result.status).json(result.payload);
      }
      const { policy } = result;
      const previousFamilyId = Number(policy.familyId || 0) || null;
      const beforeIdentity = policyProductIdentity(policy);
      const updates = normalizePolicyUpdateData(req.body || {}, policy);
      if (!Object.keys(updates).length) {
        return res.status(400).json({ ok: false, code: 'POLICY_UPDATE_EMPTY', message: '没有可更新的保单数据' });
      }
      if (hasOwn(updates, 'insuredIdNumber') && !hasOwn(updates, 'insuredBirthday')) {
        updates.insuredBirthday = birthdayFromIdNumber(updates.insuredIdNumber);
      }
      const shouldPersistFamilyState = shouldRebuildPolicyFamilyBinding(updates, policy);
      if (shouldPersistFamilyState) {
        const familyBinding = buildPolicyFamilyBinding(
          state,
          familyBindingInputFromPolicyUpdate(updates, policy),
          policyOwner(policy),
          {
            applicant: hasOwn(updates, 'applicant') ? updates.applicant : policy.applicant,
            applicantBirthday: hasOwn(updates, 'applicantBirthday') ? updates.applicantBirthday : policy.applicantBirthday,
            insured: hasOwn(updates, 'insured') ? updates.insured : policy.insured,
            insuredBirthday: hasOwn(updates, 'insuredBirthday') ? updates.insuredBirthday : policy.insuredBirthday,
            insuredIdNumber: hasOwn(updates, 'insuredIdNumber') ? updates.insuredIdNumber : policy.insuredIdNumber,
          },
        );
        Object.assign(updates, familyBinding);
      }
      Object.assign(policy, updates);
      const identityChanged = beforeIdentity !== policyProductIdentity(policy);
      if (identityChanged) clearPolicyReportForRegeneration(state, policy);
      policy.updatedAt = new Date().toISOString();
      const derivedResult = buildDerivedResultForPolicy(policy);
      if (derivedResult) replacePolicyDerivedResult(derivedResult);
      if (persistPolicyState) await persistPolicyState({ policy, includeFamilyState: shouldPersistFamilyState });
      else await persist(state);
      if (derivedResult && persistPolicyDerivedResult) {
        await persistPolicyDerivedResult({ derivedResult });
      }

      try {
        computeAndStoreCashflow(policy);
      } catch (cfError) {
        console.error('[cashflow] compute failed for policy', policy.id, cfError.message);
      }
      await archiveGeneratedFamilyReportsForPolicy(policy, { previousFamilyId });

      if (identityChanged) {
        startTrackedPolicyReportGeneration({
          state,
          policy,
          scan: buildPolicyReportScan(attachStoredPolicyDerivedResult(policy)),
          analyzer,
          persist: () => (persistPolicyState ? persistPolicyState({ policy }) : persist(state)),
          afterApply: () => refreshDerivedArtifactsForPolicy(policy),
          performanceLogger,
          requestMetrics: { inputOcrChars: String(policy.ocrText || '').length },
        });
      }
      res.status(identityChanged ? 202 : 200).json({
        ok: true,
        policy: attachPolicyCashflowData(attachStoredPolicyDerivedResult(policy, derivedResult)),
        reportRegenerating: identityChanged,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/policies/:id', async (req, res) => {
    try {
      const result = findPolicyForReportRequest(req, state, adminPassword);
      if (!result.policy) {
        return res.status(result.status).json(result.payload);
      }
      const policy = result.policy;
      const policyId = Number(policy.id);
      cashflowStore.replaceEntries(policyId, []);
      cashValueStore.deleteValues(policyId);
      state.policies = (state.policies || []).filter((policy) => Number(policy.id) !== policyId);
      state.sourceRecords = (state.sourceRecords || []).filter((source) => Number(source.policyId) !== policyId);
      if (persistPolicyDelete) await persistPolicyDelete({ policyId });
      else await persist(state);
      await archiveGeneratedFamilyReportsForPolicy(policy);
      res.json({ ok: true, deletedId: policyId });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/policies/:id/report', async (req, res) => {
    try {
      const result = findPolicyForReportRequest(req, state, adminPassword);
      if (!result.policy) {
        return res.status(result.status).json(result.payload);
      }
      const { policy } = result;
      const forceFresh = req.body?.forceFresh === true;
      const refreshOfficialFormulaDependencies = !forceFresh && policyNeedsOfficialFormulaDependencyRefresh(policy);
      const generationId = Number(policy.id);
      if (!activePolicyReportGenerationIds.has(generationId)) {
        const previousReportState = hasRefreshReportContent(policy)
          ? captureRefreshReportState(policy)
          : null;
        policy.reportStatus = 'generating';
        policy.reportError = '';
        policy.updatedAt = new Date().toISOString();
        if (persistPolicyState) await persistPolicyState({ policy });
        else await persist(state);
        startTrackedPolicyReportGeneration({
          state,
          policy,
          scan: buildPolicyReportScan(attachStoredPolicyDerivedResult(policy)),
          analyzer,
          persist: () => (persistPolicyState ? persistPolicyState({ policy }) : persist(state)),
          beforeAnalyze: forceFresh || refreshOfficialFormulaDependencies
            ? () => refreshOfficialKnowledgeForPolicy(policy, {
                includePlans: forceFresh,
                requireFresh: forceFresh,
              })
            : undefined,
          analysisOptions: forceFresh
            ? { preferLocalKnowledgeAnswer: false, maxAttempts: 1 }
            : {},
          onFailure: previousReportState
            ? () => restoreRefreshReportState(policy, previousReportState)
            : undefined,
          afterApply: () => refreshDerivedArtifactsForPolicy(policy),
          performanceLogger,
          requestMetrics: { inputOcrChars: String(policy.ocrText || '').length },
        });
      }
      res.status(202).json({
        ok: true,
        ...(forceFresh ? { refreshMode: 'official_fresh' } : {}),
        policy: attachPolicyCashflowData(attachStoredPolicyDerivedResult(policy)),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/policies/:id', async (req, res) => {
    const user = resolveAuthUser(req, state);
    const guestId = normalizeGuestId(req.query?.guestId);
    if (!user && !guestId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
    }
    const policyId = Number(req.params.id);
    const policy = state.policies.find((row) => {
      if (Number(row.id) !== policyId) return false;
      if (user) return Number(row.userId) === Number(user.id);
      return String(row.guestId || '') === guestId && !row.userId;
    });
    if (!policy) return res.status(404).json({ ok: false, code: 'POLICY_NOT_FOUND', message: '保单不存在' });
    if (recoverInterruptedPolicyGeneration(policy)) {
      if (persistPolicyState) await persistPolicyState({ policy });
      else await persist(state);
    }
    res.json({ ok: true, policy: attachPolicyCashflowData(attachStoredPolicyDerivedResult(policy)) });
  });

  return router;
}
