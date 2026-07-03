import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createAdminRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    persistFamilyReportState,
    persistAdminSession,
    persistMembershipConfig,
    persistOfficialDomainProfiles,
    adminPassword,
    adminSessionTtlMs,
    requireAdmin,
    createAdminSession,
    buildAdminOverview,
    buildAdminReportIssueDetail,
    buildAdminReportIssueSummaries,
    buildOptionalResponsibilityGaps,
    clientFamilyReportRecord,
    applyFamilyReportPolicyCorrections,
    trustedFamilyReportCorrections,
    syncFamilyReportRuleIssues,
    updateFamilyReportCorrectionStatus,
    updateFamilyReportRecordReport,
    appendFamilyReportCorrections,
    appendFamilyReportIssues,
    buildFamilyReport,
    createFamilyReportRecord,
    generateFamilyReportQualityIssues,
    attachPolicyCoverageIndicators,
    attachPolicyFamilyDisplay,
    mergePolicyDerivedResult,
    cashflowStore,
    cashValueStore,
    listFamilyMembers,
    rebuildOptionalResponsibilityGovernance,
    buildAdminOfficialDomainProfiles,
    getDefaultOfficialDomainProfiles,
    normalizeAdminOfficialDomainProfileInput,
    buildAdminKnowledgeRecords,
    normalizeAdminKnowledgeCrawlInput,
    crawlOfficialKnowledge,
    buildEffectiveOfficialDomainProfiles,
    knowledgeFetchImpl,
    upsertKnowledgeRecords,
    getMembershipConfig,
    updateMembershipConfig,
    allocateId,
    archiveFamilyGeneratedReports,
  } = context;

  function archivedFamilyReportArtifactsChanged(result = {}) {
    return Boolean(
      Number(result.archivedReportCount || 0) ||
      Number(result.archivedReportIssueCount || 0) ||
      Number(result.archivedReportCorrectionCount || 0) ||
      Number(result.archivedShareCount || 0) ||
      Number(result.archivedSalesReviewCount || 0)
    );
  }

  function findPolicyDerivedResult(policyId) {
    const id = Number(policyId || 0);
    if (!Number.isFinite(id) || id <= 0) return null;
    return (Array.isArray(state.policyDerivedResults) ? state.policyDerivedResults : [])
      .find((row) => Number(row?.policyId || 0) === id) || null;
  }

  function attachPolicyForFamilyReport(policy) {
    let displayed = typeof attachPolicyFamilyDisplay === 'function'
      ? attachPolicyFamilyDisplay(policy, state)
      : { ...policy };
    const derivedResult = findPolicyDerivedResult(policy?.id);
    if (typeof mergePolicyDerivedResult === 'function' && derivedResult) {
      displayed = mergePolicyDerivedResult(displayed, derivedResult);
    } else if (typeof attachPolicyCoverageIndicators === 'function') {
      displayed = attachPolicyCoverageIndicators(
        displayed,
        state.insuranceIndicatorRecords,
        state.knowledgeRecords,
        state.optionalResponsibilityRecords,
      );
    }
    const cashflowEntries = typeof cashflowStore?.getEntries === 'function'
      ? cashflowStore.getEntries(policy.id)
      : [];
    const cashValues = typeof cashValueStore?.getValues === 'function'
      ? cashValueStore.getValues(policy.id)
      : [];
    return {
      ...displayed,
      ...(cashflowEntries.length ? { cashflowEntries } : {}),
      ...(cashValues.length ? { cashValues } : {}),
    };
  }

  function adminPolicySources(policy = {}) {
    if (Array.isArray(policy.sources) && policy.sources.length) return policy.sources;
    return (Array.isArray(state.sourceRecords) ? state.sourceRecords : [])
      .filter((record) => Number(record?.policyId || 0) === Number(policy.id || 0))
      .sort((left, right) => String(right.lastUsedAt || right.discoveredAt || '').localeCompare(String(left.lastUsedAt || left.discoveredAt || '')));
  }

  function adminPolicyDetail(policy) {
    return attachPolicyForFamilyReport({
      ...policy,
      sources: adminPolicySources(policy),
    });
  }

  function clientOptionalResponsibilityGap(gap = {}) {
    return {
      ...gap,
      sourceExcerpt: gap.sourceExcerpt ? String(gap.sourceExcerpt).slice(0, 240) : '',
    };
  }

  function reportJson(value) {
    try {
      return JSON.stringify(value || null);
    } catch {
      return '';
    }
  }

  function familyReportPolicies(report = {}) {
    return (state.policies || [])
      .filter((policy) => Number(policy?.familyId || 0) === Number(report.familyId || 0))
      .map(attachPolicyForFamilyReport);
  }

  function policiesForAdminFamilyReport(familyId) {
    return (state.policies || [])
      .filter((policy) => Number(policy?.familyId || 0) === Number(familyId || 0))
      .map(attachPolicyForFamilyReport);
  }

  async function appendAdminDeepSeekReportIssues({
    record,
    family,
    members,
    policies,
    report,
    planningProfile,
  }) {
    if (typeof appendFamilyReportIssues !== 'function' || typeof generateFamilyReportQualityIssues !== 'function') return;
    try {
      const result = await generateFamilyReportQualityIssues({
        family,
        members,
        policies,
        report,
        planningProfile,
        knowledgeRecords: state.knowledgeRecords || [],
        indicatorRecords: state.insuranceIndicatorRecords || [],
        optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
      });
      const issues = Array.isArray(result) ? result : (result?.issues || []);
      const corrections = Array.isArray(result) ? [] : (result?.corrections || []);
      const issueRows = appendFamilyReportIssues({ state, record, issues, allocateId });
      if (typeof appendFamilyReportCorrections === 'function') {
        appendFamilyReportCorrections({ state, record, corrections, issueRows, allocateId });
      }
    } catch (error) {
      appendFamilyReportIssues({
        state,
        record,
        allocateId,
        issues: [{
          severity: 'info',
          category: 'deepseek_quality_failed',
          title: 'DeepSeek质检未完成',
          detail: error instanceof Error ? error.message : 'DeepSeek质检服务暂不可用',
          suggestion: '报告已按代码规则生成；请稍后重新生成报告或检查DeepSeek配置。',
          source: 'deepseek',
          correctionStatus: 'not_corrected',
          correctionLabel: '未修正：DeepSeek质检未完成',
          correctionReason: 'DeepSeek质检服务暂不可用',
        }],
      });
    }
  }

  function refreshReportWithTrustedCorrections(report = null) {
    if (!report) return false;
    if (
      typeof trustedFamilyReportCorrections !== 'function' ||
      typeof updateFamilyReportRecordReport !== 'function' ||
      typeof buildFamilyReport !== 'function'
    ) {
      return false;
    }
    const family = (state.familyProfiles || [])
      .find((row) => Number(row.id || 0) === Number(report.familyId || 0)) || {};
    const members = typeof listFamilyMembers === 'function' ? listFamilyMembers(state, report.familyId) : [];
    const policies = familyReportPolicies(report);
    const corrections = trustedFamilyReportCorrections(state, { familyId: report.familyId, reportId: report.id });
    let reportPolicies = policies;
    let changed = false;
    if (corrections.length) {
      reportPolicies = typeof applyFamilyReportPolicyCorrections === 'function'
        ? applyFamilyReportPolicyCorrections(policies, corrections)
        : policies;
      const nextReport = buildFamilyReport(reportPolicies, report.planningProfile || null, {
        familyId: family.id || report.familyId,
        corrections,
      });
      const draftRecord = { summary: report.summary || {} };
      updateFamilyReportRecordReport({
        record: draftRecord,
        members,
        policies: reportPolicies,
        report: nextReport,
      });
      if (reportJson(draftRecord.report) !== reportJson(report.report)) {
        updateFamilyReportRecordReport({
          record: report,
          members,
          policies: reportPolicies,
          report: nextReport,
        });
        changed = true;
      }
    }
    if (typeof syncFamilyReportRuleIssues === 'function') {
      changed = syncFamilyReportRuleIssues({
        state,
        record: report,
        family,
        members,
        policies: reportPolicies,
        allocateId,
      }) || changed;
    }
    return changed;
  }

  function refreshActiveReportsWithTrustedCorrections() {
    let changed = false;
    for (const report of state.familyReports || []) {
      if (String(report.status || 'active') !== 'active') continue;
      changed = refreshReportWithTrustedCorrections(report) || changed;
    }
    return changed;
  }

  function adminFamilySummary(family) {
    const members = typeof listFamilyMembers === 'function' ? listFamilyMembers(state, family.id) : [];
    const policies = (Array.isArray(state.policies) ? state.policies : [])
      .filter((policy) => Number(policy?.familyId || 0) === Number(family.id));
    const coreMember = members.find((member) => Number(member.id) === Number(family.coreMemberId || 0)) || null;
    const latestPolicyAt = policies
      .map((policy) => String(policy?.createdAt || policy?.updatedAt || ''))
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left))[0] || '';
    return {
      ...family,
      members,
      memberCount: members.length,
      policyCount: policies.length,
      coreMemberName: coreMember?.name || '待设置',
      latestPolicyAt,
    };
  }

  function clientSalesReview(review = null) {
    if (!review) return null;
    return {
      id: Number(review.id || 0) || undefined,
      familyId: Number(review.familyId || 0) || undefined,
      status: String(review.status || 'active'),
      content: String(review.content || ''),
      model: String(review.model || ''),
      generatedAt: review.generatedAt,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      inputSummary: review.inputSummary || undefined,
    };
  }

  function latestAdminFamilySalesReview(familyId) {
    return (Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [])
      .filter((review) => (
        Number(review?.familyId || 0) === Number(familyId) &&
        String(review?.status || 'active') === 'active'
      ))
      .sort((left, right) => (
        String(right.generatedAt || right.createdAt || '').localeCompare(String(left.generatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ))[0] || null;
  }

  function adminSalesChatThreads(familyId) {
    return (Array.isArray(state.familySalesChatThreads) ? state.familySalesChatThreads : [])
      .filter((thread) => (
        Number(thread?.familyId || 0) === Number(familyId || 0) &&
        String(thread?.status || 'active') === 'active'
      ))
      .sort((left, right) => (
        String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ));
  }

  function adminSalesChatMessages(threadId) {
    return (Array.isArray(state.familySalesChatMessages) ? state.familySalesChatMessages : [])
      .filter((message) => Number(message?.threadId || 0) === Number(threadId || 0))
      .sort((left, right) => (
        String(left.createdAt || '').localeCompare(String(right.createdAt || '')) ||
        Number(left.id || 0) - Number(right.id || 0)
      ));
  }

  function clientSalesChatThread(thread = null) {
    if (!thread) return null;
    const messages = adminSalesChatMessages(thread.id);
    return {
      id: Number(thread.id || 0),
      familyId: Number(thread.familyId || 0),
      status: String(thread.status || 'active'),
      title: String(thread.title || ''),
      createdAt: thread.createdAt || '',
      updatedAt: thread.updatedAt || thread.createdAt || '',
      messageCount: messages.length,
      latestMessageAt: messages[messages.length - 1]?.createdAt || '',
      messages: messages.map((message) => ({
        id: Number(message.id || 0),
        threadId: Number(message.threadId || 0),
        familyId: Number(message.familyId || 0),
        role: String(message.role || ''),
        content: String(message.content || ''),
        status: String(message.status || 'complete'),
        createdAt: message.createdAt || '',
        error: message.error || '',
      })),
    };
  }

  function latestAdminFamilyReport(familyId) {
    return (Array.isArray(state.familyReports) ? state.familyReports : [])
      .filter((report) => (
        Number(report?.familyId || 0) === Number(familyId) &&
        String(report?.status || 'active') === 'active'
      ))
      .sort((left, right) => (
        String(right.generatedAt || right.createdAt || '').localeCompare(String(left.generatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ))[0] || null;
  }

  async function handleReportCorrectionStatus(req, res, status) {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return undefined;
    try {
      if (typeof updateFamilyReportCorrectionStatus !== 'function') {
        return res.status(503).json({ ok: false, code: 'REPORT_CORRECTION_UNAVAILABLE', message: '报告修正服务不可用' });
      }
      const correction = updateFamilyReportCorrectionStatus(state, req.params.correctionId, status);
      const report = (state.familyReports || []).find((row) => Number(row.id || 0) === Number(correction.reportId || 0)) || null;
      refreshReportWithTrustedCorrections(report);
      if (typeof persistFamilyReportState === 'function') await persistFamilyReportState();
      else await persist(state, { refreshOptionalResponsibilityGovernance: false });
      const detail = typeof buildAdminReportIssueDetail === 'function'
        ? buildAdminReportIssueDetail(state, correction.reportId)
        : null;
      return res.json({ ok: true, ...(detail || { report: null, issues: [], corrections: [] }) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  router.post('/login', async (req, res) => {
    try {
      if (!adminPassword) {
        const error = new Error('后台密码未配置');
        error.code = 'ADMIN_PASSWORD_NOT_CONFIGURED';
        error.status = 503;
        throw error;
      }
      if (String(req.body?.password || '') !== adminPassword) {
        const error = new Error('后台密码不正确');
        error.code = 'INVALID_ADMIN_PASSWORD';
        error.status = 401;
        throw error;
      }
      const token = createAdminSession(state);
      const session = (state.adminSessions || []).find((row) => String(row?.token || '') === token) || null;
      if (persistAdminSession) await persistAdminSession({ session });
      else await persist(state, { refreshOptionalResponsibilityGovernance: false });
      res.json({ ok: true, token, expiresInSeconds: Math.floor(adminSessionTtlMs / 1000) });
    } catch (error) {
      sendError(res, error, 401);
    }
  });

  router.get('/overview', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({ ok: true, ...buildAdminOverview(state) });
  });

  router.get('/policies/:policyId', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const policyId = Number(req.params.policyId || 0);
    const policy = (Array.isArray(state.policies) ? state.policies : [])
      .find((row) => Number(row?.id || 0) === policyId) || null;
    if (!policy) {
      return res.status(404).json({ ok: false, code: 'ADMIN_POLICY_NOT_FOUND', message: '保单不存在' });
    }
    return res.json({ ok: true, policy: adminPolicyDetail(policy) });
  });

  router.get('/users/:userId/families', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const userId = Number(req.params.userId || 0);
    const user = (Array.isArray(state.users) ? state.users : [])
      .find((row) => Number(row?.id || 0) === userId) || null;
    if (!user) {
      return res.status(404).json({ ok: false, code: 'ADMIN_USER_NOT_FOUND', message: '用户不存在' });
    }
    const userPolicyFamilyIds = new Set(
      (Array.isArray(state.policies) ? state.policies : [])
        .filter((policy) => Number(policy?.userId || 0) === userId)
        .map((policy) => Number(policy?.familyId || 0))
        .filter(Boolean),
    );
    const families = (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
      .filter((family) => {
        if (String(family?.status || 'active') !== 'active') return false;
        if (Number(family?.ownerUserId || 0) === userId) return true;
        return !Number(family?.ownerUserId || 0) && userPolicyFamilyIds.has(Number(family?.id || 0));
      })
      .map(adminFamilySummary)
      .sort((left, right) => (
        String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ));
    return res.json({
      ok: true,
      user: {
        id: Number(user.id),
        mobile: String(user.mobile || ''),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      families,
    });
  });

  router.get('/families/:familyId/sales-review', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const familyId = Number(req.params.familyId || 0);
    const family = (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
      .find((row) => Number(row?.id || 0) === familyId && String(row?.status || 'active') === 'active') || null;
    if (!family) {
      return res.status(404).json({ ok: false, code: 'ADMIN_FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    return res.json({ ok: true, review: clientSalesReview(latestAdminFamilySalesReview(familyId)) });
  });

  router.get('/families/:familyId/sales-chat/threads', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const familyId = Number(req.params.familyId || 0);
    const family = (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
      .find((row) => Number(row?.id || 0) === familyId && String(row?.status || 'active') === 'active') || null;
    if (!family) {
      return res.status(404).json({ ok: false, code: 'ADMIN_FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    return res.json({ ok: true, threads: adminSalesChatThreads(familyId).map(clientSalesChatThread) });
  });

  router.get('/families/:familyId/report', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const familyId = Number(req.params.familyId || 0);
    const family = (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
      .find((row) => Number(row?.id || 0) === familyId && String(row?.status || 'active') === 'active') || null;
    if (!family) {
      return res.status(404).json({ ok: false, code: 'ADMIN_FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    const reportRecord = latestAdminFamilyReport(familyId);
    return res.json({ ok: true, reportRecord: clientFamilyReportRecord?.(reportRecord) || null });
  });

  router.post('/families/:familyId/report', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const familyId = Number(req.params.familyId || 0);
      const family = (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
        .find((row) => Number(row?.id || 0) === familyId && String(row?.status || 'active') === 'active') || null;
      if (!family) {
        return res.status(404).json({ ok: false, code: 'ADMIN_FAMILY_NOT_FOUND', message: '家庭档案不存在' });
      }
      const members = typeof listFamilyMembers === 'function' ? listFamilyMembers(state, familyId) : [];
      const policies = policiesForAdminFamilyReport(familyId);
      const planningProfile = req.body?.planningProfile || null;
      const report = buildFamilyReport(policies, planningProfile, { familyId });
      const { record } = createFamilyReportRecord({
        state,
        family,
        owner: {
          userId: family.ownerUserId,
          guestId: family.ownerGuestId,
        },
        members,
        policies,
        report,
        planningProfile,
        allocateId,
      });
      await appendAdminDeepSeekReportIssues({
        record,
        family,
        members,
        policies,
        report: record.report,
        planningProfile,
      });
      refreshReportWithTrustedCorrections(record);
      if (typeof persistFamilyReportState === 'function') await persistFamilyReportState();
      else await persist(state, { refreshOptionalResponsibilityGovernance: false });
      return res.json({ ok: true, reportRecord: clientFamilyReportRecord?.(record) || null });
    } catch (error) {
      return sendError(res, error, error?.status || 500);
    }
  });

  router.get('/report-issues', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    if (refreshActiveReportsWithTrustedCorrections()) {
      if (typeof persistFamilyReportState === 'function') await persistFamilyReportState();
      else await persist(state, { refreshOptionalResponsibilityGovernance: false });
    }
    res.json({
      ok: true,
      reports: typeof buildAdminReportIssueSummaries === 'function'
        ? buildAdminReportIssueSummaries(state)
        : [],
    });
  });

  router.get('/report-issues/:reportId', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const report = (state.familyReports || []).find((row) => Number(row.id || 0) === Number(req.params.reportId || 0)) || null;
    if (refreshReportWithTrustedCorrections(report)) {
      if (typeof persistFamilyReportState === 'function') await persistFamilyReportState();
      else await persist(state, { refreshOptionalResponsibilityGovernance: false });
    }
    const detail = typeof buildAdminReportIssueDetail === 'function'
      ? buildAdminReportIssueDetail(state, req.params.reportId)
      : null;
    if (!detail) {
      return res.status(404).json({ ok: false, code: 'REPORT_ISSUES_NOT_FOUND', message: '报告问题不存在' });
    }
    res.json({ ok: true, ...detail });
  });

  router.get('/optional-responsibility-gaps', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const gaps = typeof buildOptionalResponsibilityGaps === 'function'
      ? buildOptionalResponsibilityGaps({
        optionalResponsibilityRecords: state.optionalResponsibilityRecords,
        policies: state.policies,
      }).map(clientOptionalResponsibilityGap)
      : [];
    res.json({ ok: true, gaps });
  });

  router.post('/report-corrections/:correctionId/accept', async (req, res) => (
    handleReportCorrectionStatus(req, res, 'accepted')
  ));

  router.post('/report-corrections/:correctionId/reject', async (req, res) => (
    handleReportCorrectionStatus(req, res, 'rejected')
  ));

  router.post('/optional-responsibilities/:id/not-quantifiable', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const id = String(req.params.id || '').trim();
      const record = (state.optionalResponsibilityRecords || []).find((row) => String(row.id || '') === id);
      if (!record) {
        return res.status(404).json({ ok: false, code: 'OPTIONAL_RESPONSIBILITY_NOT_FOUND', message: '可选责任不存在' });
      }
      record.quantificationStatus = 'not_quantifiable';
      record.quantificationReason = String(req.body?.reason || '不进入量化计算').trim();
      record.updatedAt = new Date().toISOString();
      const affectedFamilyIds = new Set();
      const affectedPolicyIds = new Set();
      for (const policy of Array.isArray(state.policies) ? state.policies : []) {
        if (!Number(policy?.familyId || 0)) continue;
        const selected = (Array.isArray(policy.optionalResponsibilities) ? policy.optionalResponsibilities : [])
          .some((item) => String(item?.id || '').trim() === id && String(item?.selectionStatus || '') === 'selected');
        if (!selected) continue;
        affectedFamilyIds.add(Number(policy.familyId));
        if (Number(policy?.id || 0)) affectedPolicyIds.add(Number(policy.id));
      }
      if (affectedPolicyIds.size && Array.isArray(state.policyDerivedResults)) {
        state.policyDerivedResults = state.policyDerivedResults
          .filter((row) => !affectedPolicyIds.has(Number(row?.policyId || 0)));
      }
      const archiveResult = typeof archiveFamilyGeneratedReports === 'function'
        ? archiveFamilyGeneratedReports(state, [...affectedFamilyIds])
        : null;
      await persist(state, { refreshOptionalResponsibilityGovernance: false });
      res.json({
        ok: true,
        record,
        archivedReportCount: archiveResult?.archivedReportCount || 0,
        archivedReportIssueCount: archiveResult?.archivedReportIssueCount || 0,
        archivedReportCorrectionCount: archiveResult?.archivedReportCorrectionCount || 0,
        reportArchived: archivedFamilyReportArtifactsChanged(archiveResult),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/optional-responsibilities/reextract', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      Object.assign(state, rebuildOptionalResponsibilityGovernance(state));
      await persist(state);
      res.json({
        ok: true,
        optionalResponsibilityCount: (state.optionalResponsibilityRecords || []).length,
        optionalIndicatorCount: (state.insuranceIndicatorRecords || []).filter((row) => row.responsibilityScope === 'optional').length,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/official-domain-profiles', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({
      ok: true,
      profiles: buildAdminOfficialDomainProfiles(state),
      defaultCount: getDefaultOfficialDomainProfiles().length,
      customCount: (state.officialDomainProfiles || []).length,
    });
  });

  router.post('/official-domain-profiles', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const profile = normalizeAdminOfficialDomainProfileInput(state, req.body);
      state.officialDomainProfiles.push(profile);
      if (persistOfficialDomainProfiles) await persistOfficialDomainProfiles();
      else await persist(state, { refreshOptionalResponsibilityGovernance: false });
      res.status(201).json({ ok: true, profile, profiles: buildAdminOfficialDomainProfiles(state) });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/official-domain-profiles/:id', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const id = String(req.params.id || '').trim();
      const existing = (state.officialDomainProfiles || []).find((profile) => String(profile.id || '') === id) || null;
      const profile = normalizeAdminOfficialDomainProfileInput(state, { ...req.body, createdAt: existing?.createdAt }, id);
      state.officialDomainProfiles = (state.officialDomainProfiles || []).filter((row) => String(row.id || '') !== id);
      state.officialDomainProfiles.push(profile);
      if (persistOfficialDomainProfiles) await persistOfficialDomainProfiles();
      else await persist(state, { refreshOptionalResponsibilityGovernance: false });
      res.json({ ok: true, profile, profiles: buildAdminOfficialDomainProfiles(state) });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.delete('/official-domain-profiles/:id', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const id = String(req.params.id || '').trim();
    state.officialDomainProfiles = (state.officialDomainProfiles || []).filter((row) => String(row.id || '') !== id);
    if (persistOfficialDomainProfiles) await persistOfficialDomainProfiles();
    else await persist(state, { refreshOptionalResponsibilityGovernance: false });
    res.json({ ok: true, profiles: buildAdminOfficialDomainProfiles(state) });
  });

  router.get('/knowledge-records', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const records = buildAdminKnowledgeRecords(state);
    res.json({
      ok: true,
      records,
      summary: {
        count: records.length,
        officialCount: records.filter((record) => record.official).length,
      },
    });
  });

  router.post('/knowledge-crawl', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const policy = normalizeAdminKnowledgeCrawlInput(req.body);
      const discovered = await crawlOfficialKnowledge({
        policy,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
        fetchImpl: knowledgeFetchImpl,
      });
      const saved = upsertKnowledgeRecords(state, discovered, {
        allocateId,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      });
      await persist(state);
      res.json({
        ok: true,
        policy,
        savedCount: saved.length,
        records: buildAdminKnowledgeRecords(state),
        discovered,
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get('/membership-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({ ok: true, config: getMembershipConfig(state) });
  });

  router.patch('/membership-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const patch = {};
      if (Object.hasOwn(req.body || {}, 'enabled')) patch.enabled = req.body.enabled;
      if (Object.hasOwn(req.body || {}, 'registeredFreePolicyQuota')) {
        patch.registeredFreePolicyQuota = req.body.registeredFreePolicyQuota;
      }
      if (Object.hasOwn(req.body || {}, 'familyReportDailyRefreshLimit')) {
        patch.familyReportDailyRefreshLimit = req.body.familyReportDailyRefreshLimit;
      }
      if (Object.hasOwn(req.body || {}, 'familySalesReviewDailyRefreshLimit')) {
        patch.familySalesReviewDailyRefreshLimit = req.body.familySalesReviewDailyRefreshLimit;
      }
      const config = updateMembershipConfig(state, patch);
      if (persistMembershipConfig) await persistMembershipConfig({ config });
      else await persist(state, { refreshOptionalResponsibilityGovernance: false });
      res.json({ ok: true, config });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
