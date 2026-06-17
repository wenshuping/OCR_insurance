import express from 'express';
import { sendError } from '../http/errors.mjs';

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
    archiveFamilyGeneratedReportsForPolicy,
    clearPolicyReportForRegeneration,
    buildPolicyReportScan,
    nowIso,
  } = context;
  const familyPersistOptions = { refreshOptionalResponsibilityGovernance: false };

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
      optionalResponsibilityRecords: state.optionalResponsibilityRecords,
      productIndicatorVersions: state.productIndicatorVersions,
      now: typeof nowIso === 'function' ? nowIso() : new Date().toISOString(),
    });
  }

  function attachStoredPolicyDerivedResult(policy, derivedResult = findPolicyDerivedResult(policy?.id)) {
    const displayed = attachPolicyFamilyDisplay(policy, state);
    if (typeof mergePolicyDerivedResult === 'function') {
      return mergePolicyDerivedResult(displayed, derivedResult || null);
    }
    if (derivedResult) {
      return {
        ...displayed,
        coverageIndicators: Array.isArray(derivedResult.coverageIndicators) ? derivedResult.coverageIndicators : [],
        optionalResponsibilities: Array.isArray(derivedResult.optionalResponsibilities) ? derivedResult.optionalResponsibilities : [],
      };
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
      const analysisWithOptionalResponsibilities = {
        ...analysis,
        optionalResponsibilities: buildOptionalResponsibilityReview(
          policyDraft,
          findPolicyCoverageIndicators(policyDraft, state.insuranceIndicatorRecords),
          state.knowledgeRecords,
          state.optionalResponsibilityRecords,
        ),
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
      const providedAnalysis = normalizeProvidedAnalysis(req.body?.analysis);
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

      if (!providedAnalysis) {
        startPolicyReportGeneration({
          state,
          policy,
          scan: normalizedScan,
          analyzer,
          persist: () => (persistPolicyState ? persistPolicyState({ policy }) : persist(state)),
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
      if (policy.reportStatus === 'ready') {
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
