import express from 'express';
import { sendError } from '../http/errors.mjs';
import {
  buildCustomerPolicyPhotoKnowledgeRecord,
  customerPolicyPhotoPendingMatch,
  mergeCustomerPolicyPhotoScans,
  normalizeCustomerPolicyPhotoUploadItems,
  sanitizeCustomerPolicyPhotoKnowledgeText,
} from '../customer-policy-photo-knowledge.service.mjs';
import { evidenceVerificationFields } from '../evidence-classification.service.mjs';

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
    findKnowledgeProductCandidates,
    withPolicyProductMatchStatus,
    upsertKnowledgeRecords,
    buildRawUploadSnapshot,
    storeGuestPendingScan,
    resolvePolicyScanInput,
    normalizeOptionalResponsibilities,
    buildOptionalResponsibilityReview,
    findPolicyCoverageIndicators,
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
    startPolicyReportGeneration,
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
    return buildPolicyDerivedResult({
      policy,
      indicatorRecords: state.insuranceIndicatorRecords,
      knowledgeRecords: state.knowledgeRecords,
      officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      optionalResponsibilityRecords: state.optionalResponsibilityRecords,
      productIndicatorVersions: state.productIndicatorVersions,
      now: typeof nowIso === 'function' ? nowIso() : new Date().toISOString(),
    });
  }

  function policyHasGeneratedResponsibility(policy) {
    return Boolean(
      routeText(policy?.report) ||
        (Array.isArray(policy?.responsibilities) && policy.responsibilities.length) ||
        (Array.isArray(policy?.responsibilityCards) && policy.responsibilityCards.length)
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
    if (derivedResult) {
      if (typeof mergePolicyDerivedResult === 'function') {
        return mergePolicyDerivedResult(displayed, derivedResult);
      }
      return {
        ...displayed,
        coverageIndicators: Array.isArray(derivedResult.coverageIndicators) ? derivedResult.coverageIndicators : [],
        optionalResponsibilities: Array.isArray(derivedResult.optionalResponsibilities) ? derivedResult.optionalResponsibilities : [],
      };
    }
    if (typeof attachPolicyCoverageIndicators === 'function') {
      const attached = attachPolicyCoverageIndicators(
        displayed,
        state.insuranceIndicatorRecords,
        state.knowledgeRecords,
        state.optionalResponsibilityRecords,
      );
      if (typeof mergePolicyDerivedResult === 'function') {
        return mergePolicyDerivedResult(attached, null);
      }
      return {
        ...attached,
        derivedStatus: 'stale',
        derivedStaleReason: 'missing',
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
    const entries = cashflowStore.getEntries(policy.id);
    const cashValues = cashValueStore.getValues(policy.id);
    const totalCashflow = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    let scenarioEntries = [];
    try {
      const policyIndicators = Array.isArray(policy.coverageIndicators)
        ? policy.coverageIndicators
        : findPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords);
      scenarioEntries = computeScenarioEntries(selectedCoverageIndicators(policyIndicators), policy);
    } catch (_err) {
      // non-fatal: scenarioEntries stays empty
    }
    return {
      ...policy,
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
      const analysis = buildRecognizedPolicyAnalysisDraft({
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
      const sanitizedText = sanitizeCustomerPolicyPhotoKnowledgeText({
        ocrText: mergedScan.ocrText,
        scan: mergedScan,
        manualData,
      });
      const knowledgeRecord = buildCustomerPolicyPhotoKnowledgeRecord({
        company: policyDraft.company,
        productName: policyDraft.name,
        pageText: sanitizedText,
        ownerUserId: user?.id,
        ownerGuestId: guestId,
        uploadItems,
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
      const coverageIndicators = findPolicyCoverageIndicators(policyDraftWithOptionalResponsibilities, state.insuranceIndicatorRecords);
      const rawResponsibilityCards = typeof buildResponsibilityCardsForPolicy === 'function'
        ? buildResponsibilityCardsForPolicy({
            policy: policyDraftWithOptionalResponsibilities,
            responsibilities: analysis?.coverageTable,
            coverageIndicators,
            knowledgeRecords: filteredKnowledgeRecordsForPolicy(policyDraftWithOptionalResponsibilities),
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
      const normalizedScan = await resolvePolicyScanInput({ scanner, body: req.body, state });
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
        startPolicyReportGeneration({
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
        startPolicyReportGeneration({
          state,
          policy,
          scan: buildPolicyReportScan(policy),
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
      if (policy.reportStatus === 'ready' && policyHasGeneratedResponsibility(policy)) {
        return res.json({
          ok: true,
          policy: attachPolicyCashflowData(attachPolicyCoverageIndicators(
            attachPolicyFamilyDisplay(policy, state),
            state.insuranceIndicatorRecords,
            state.knowledgeRecords,
            state.optionalResponsibilityRecords,
          )),
          skipped: true,
        });
      }
      if (policy.reportStatus !== 'generating') {
        policy.reportStatus = 'generating';
        policy.reportError = '';
        policy.responsibilities = [];
        policy.report = '';
        policy.sources = [];
        policy.updatedAt = new Date().toISOString();
        if (persistPolicyState) await persistPolicyState({ policy });
        else await persist(state);
        startPolicyReportGeneration({
          state,
          policy,
          scan: buildPolicyReportScan(policy),
          analyzer,
          persist: () => (persistPolicyState ? persistPolicyState({ policy }) : persist(state)),
          afterApply: () => refreshDerivedArtifactsForPolicy(policy),
          performanceLogger,
          requestMetrics: { inputOcrChars: String(policy.ocrText || '').length },
        });
      }
      res.status(202).json({
        ok: true,
        policy: attachPolicyCashflowData(attachPolicyCoverageIndicators(
          attachPolicyFamilyDisplay(policy, state),
          state.insuranceIndicatorRecords,
          state.knowledgeRecords,
          state.optionalResponsibilityRecords,
        )),
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
    res.json({ ok: true, policy: attachPolicyCashflowData(attachStoredPolicyDerivedResult(policy)) });
  });

  return router;
}
