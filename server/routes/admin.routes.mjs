import express from 'express';
import { sendError } from '../http/errors.mjs';
import { approveCustomerPolicyPhotoKnowledgeRecord } from '../customer-policy-photo-knowledge.service.mjs';
import {
  RESPONSIBILITY_GENERATION_GOVERNANCE_STATE_KEY,
  getResponsibilityGenerationGovernanceConfig,
  normalizeResponsibilityGenerationGovernanceConfig,
} from '../responsibility-generation-governance.service.mjs';
import {
  AGENT_QUESTION_POLICIES,
  chooseAgentQuestionPolicy,
  validateAgentQuestionPolicy,
} from '../agent-question-policy.service.mjs';

export function createAdminRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    persistFamilyReportState,
    persistAdminSession,
    persistMembershipConfig,
    persistStateDocument,
    persistOfficialDomainProfiles,
    persistResponsibilityLookupArtifacts,
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
    nowIso,
    agentQuestionPolicyStore,
  } = context;

  const policyActor = (session) => `admin:${Number(session?.userId || 0) || 'session'}`;
  const policyTimestamp = () => typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  const strictObject = (value, allowed, label = 'body') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
    const extra = Object.keys(value).filter((key) => !allowed.includes(key));
    if (extra.length) throw new TypeError(`${label} contains unsupported fields`);
    return value;
  };
  const POLICY_FIELDS = ['key', 'intent', 'decision', 'handler', 'operation', 'confirmation', 'outputMode', 'tool', 'enabled', 'confidenceThreshold'];
  const validatePolicyItemSchema = (policy) => {
    strictObject(policy, POLICY_FIELDS, 'policy');
    if (Object.hasOwn(policy, 'enabled') && typeof policy.enabled !== 'boolean') throw new TypeError('policy enabled must be boolean');
    if (Object.hasOwn(policy, 'confidenceThreshold') && (typeof policy.confidenceThreshold !== 'number' || !Number.isFinite(policy.confidenceThreshold) || policy.confidenceThreshold < 0 || policy.confidenceThreshold > 1)) {
      throw new TypeError('policy confidenceThreshold must be a number between 0 and 1');
    }
  };
  const validatePolicySet = (policies) => {
    if (!Array.isArray(policies) || !policies.length) throw new TypeError('policies must be a non-empty array');
    for (const policy of policies) { validatePolicyItemSchema(policy); validateAgentQuestionPolicy(policy); }
    for (const field of ['key', 'intent']) {
      const values = policies.map((policy) => String(policy[field]).trim().toLowerCase().replace(/[\s-]+/gu, '_'));
      if (new Set(values).size !== values.length) throw new TypeError(`duplicate policy ${field}`);
    }
    for (const key of ['unknown_read', 'unknown_write']) {
      const fallback = policies.find((policy) => policy.key === key && policy.enabled !== false);
      if (!fallback || fallback.operation !== (key === 'unknown_write' ? 'write' : 'read')) throw new TypeError(`safe enabled ${key} fallback is required`);
    }
    return policies;
  };
  const validateDraftPolicies = (policies) => {
    if (!Array.isArray(policies) || !policies.length) throw new TypeError('policies must be a non-empty array');
    for (const policy of policies) { validatePolicyItemSchema(policy); validateAgentQuestionPolicy(policy); }
    return policies;
  };
  const sendPolicyError = (res, error) => {
    const status = /must be a draft|rollback source must be/iu.test(String(error?.message)) ? 409 : /not found/iu.test(String(error?.message)) ? 404 : 400;
    error.status = status;
    sendError(res, error, status);
  };

  router.get('/agent-question-policies', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword); if (!session) return;
    try {
      const history = await agentQuestionPolicyStore.listAgentQuestionPolicyVersions();
      res.json({ ok: true, published: history.find((row) => row.status === 'published') || null, drafts: history.filter((row) => row.status === 'draft'), history, templates: AGENT_QUESTION_POLICIES.map((row) => ({ ...row })) });
    } catch (error) { sendPolicyError(res, error); }
  });

  router.post('/agent-question-policies/drafts', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword); if (!session) return;
    try {
      const body = strictObject(req.body, ['policies']);
      validateDraftPolicies(body.policies);
      const versions = await agentQuestionPolicyStore.listAgentQuestionPolicyVersions();
      const draft = await agentQuestionPolicyStore.createAgentQuestionPolicyDraft({ version: Math.max(0, ...versions.map((row) => row.version)) + 1, policies: body.policies, actor: policyActor(session), createdAt: policyTimestamp() });
      res.status(201).json({ ok: true, draft });
    } catch (error) { sendPolicyError(res, error); }
  });

  router.patch('/agent-question-policies/drafts/:id', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword); if (!session) return;
    try {
      const body = strictObject(req.body, ['policies']); validateDraftPolicies(body.policies);
      const draft = await agentQuestionPolicyStore.updateAgentQuestionPolicyDraft({ id: req.params.id, policies: body.policies, actor: policyActor(session) });
      res.json({ ok: true, draft });
    } catch (error) { sendPolicyError(res, error); }
  });

  router.post('/agent-question-policies/drafts/:id/publish', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword); if (!session) return;
    try {
      strictObject(req.body || {}, []);
      const draft = await agentQuestionPolicyStore.getAgentQuestionPolicyVersion({ id: req.params.id });
      if (!draft) throw new Error('Agent question policy version not found');
      validatePolicySet(draft.policies);
      const published = await agentQuestionPolicyStore.publishAgentQuestionPolicyVersion({ id: draft.id, actor: policyActor(session), publishedAt: policyTimestamp() });
      res.json({ ok: true, published });
    } catch (error) { sendPolicyError(res, error); }
  });

  router.post('/agent-question-policies/versions/:id/rollback', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword); if (!session) return;
    try {
      strictObject(req.body || {}, []);
      const source = await agentQuestionPolicyStore.getAgentQuestionPolicyVersion({ id: req.params.id });
      if (!source) throw new Error('Agent question policy version not found');
      if (!['published', 'archived'].includes(source.status)) throw new Error('Agent question policy rollback source must be published or archived');
      validatePolicySet(source.policies);
      const versions = await agentQuestionPolicyStore.listAgentQuestionPolicyVersions();
      const draft = await agentQuestionPolicyStore.createAgentQuestionPolicyDraft({ version: Math.max(0, ...versions.map((row) => row.version)) + 1, policies: source.policies, actor: policyActor(session), createdAt: policyTimestamp() });
      const published = await agentQuestionPolicyStore.publishAgentQuestionPolicyVersion({ id: draft.id, actor: policyActor(session), publishedAt: policyTimestamp() });
      res.json({ ok: true, sourceVersionId: source.id, draft, published });
    } catch (error) { sendPolicyError(res, error); }
  });

  router.post('/agent-question-policies/simulate', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword); if (!session) return;
    try {
      const body = strictObject(req.body, ['draftId', 'candidate']);
      const candidate = strictObject(body.candidate, ['intent', 'requestedOperation', 'confidence', 'question']);
      if (typeof candidate.intent !== 'string' || candidate.intent.length > 80 || !['read', 'write'].includes(candidate.requestedOperation || 'read')) throw new TypeError('invalid simulation candidate');
      const hasDraftId = Object.hasOwn(body, 'draftId');
      if (hasDraftId && (!Number.isInteger(body.draftId) || body.draftId <= 0)) throw new TypeError('draftId must be a positive integer');
      const version = hasDraftId ? await agentQuestionPolicyStore.getAgentQuestionPolicyVersion({ id: body.draftId }) : await agentQuestionPolicyStore.getPublishedAgentQuestionPolicyVersion();
      if (hasDraftId && !version) throw new Error('Agent question policy draft not found');
      if (hasDraftId && version.status !== 'draft') throw new Error('Agent question policy version must be a draft');
      const policies = version?.policies || AGENT_QUESTION_POLICIES;
      validatePolicySet(policies);
      const policy = chooseAgentQuestionPolicy(candidate, policies);
      const fallback = ['unknown_read', 'unknown_write'].includes(policy.key);
      const policySource = fallback ? 'built_in' : version ? version.status : 'built_in';
      const explanation = fallback
        ? `Fallback ${policy.key} for requestedOperation ${candidate.requestedOperation || 'read'} from built-in policy.`
        : `Selected ${policy.key} from ${policySource} policy for intent ${candidate.intent}.`;
      res.json({ ok: true, previewOnly: true, decision: { policyKey: policy.key, policySource, intent: policy.intent, decision: policy.decision, handler: policy.handler, operation: policy.operation, tool: policy.tool, confirmationRequired: policy.confirmation === 'required', outputMode: policy.outputMode, fallback, explanation } });
    } catch (error) { sendPolicyError(res, error); }
  });

  router.get('/agent-unknown-questions', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword); if (!session) return;
    try {
      const rows = await agentQuestionPolicyStore.listAgentUnknownQuestions({ limit: req.query.limit, offset: req.query.offset });
      const redact = (text) => String(text || '').replace(/1\d{10}/gu, '[手机号已脱敏]').replace(/\d{17}[\dXx]/gu, '[证件号已脱敏]');
      res.json({ ok: true, items: rows.map((row) => ({ id: row.id, userRef: `user_${String(row.userId).slice(-2).padStart(2, '0')}`, question: redact(row.question), status: row.status, createdAt: row.createdAt })), total: Number(rows.total || 0), limit: Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20)), offset: Math.max(0, Number.parseInt(req.query.offset, 10) || 0) });
    } catch (error) { sendPolicyError(res, error); }
  });

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

  router.post('/knowledge-records/:id/review', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const id = Number(req.params.id || 0);
      const existing = (state.knowledgeRecords || []).find((record) => Number(record?.id || 0) === id) || null;
      if (!existing) {
        const error = new Error('知识记录不存在');
        error.code = 'KNOWLEDGE_RECORD_NOT_FOUND';
        error.status = 404;
        throw error;
      }
      const action = String(req.body?.action || req.body?.reviewStatus || '').trim();
      const reviewed = approveCustomerPolicyPhotoKnowledgeRecord(existing, {
        approved: action !== 'rejected',
      });
      if (!reviewed) {
        const error = new Error('只支持审核客户补充照片线索');
        error.code = 'KNOWLEDGE_RECORD_REVIEW_UNSUPPORTED';
        error.status = 400;
        throw error;
      }
      reviewed.id = existing.id;
      const saved = upsertKnowledgeRecords(state, [reviewed], {
        allocateId,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      });
      if (typeof persistResponsibilityLookupArtifacts === 'function') {
        await persistResponsibilityLookupArtifacts({ knowledgeRecords: saved });
      }
      res.json({
        ok: true,
        record: saved[0] || reviewed,
        records: buildAdminKnowledgeRecords(state),
      });
    } catch (error) {
      sendError(res, error, error?.status || 400);
    }
  });

  router.get('/responsibility-generation-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({
      ok: true,
      config: getResponsibilityGenerationGovernanceConfig(state),
    });
  });

  router.patch('/responsibility-generation-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const current = getResponsibilityGenerationGovernanceConfig(state);
      const body = req.body || {};
      const patch = {};
      if (Object.hasOwn(body, 'enabled')) patch.enabled = body.enabled === true;
      if (Object.hasOwn(body, 'promptRules')) patch.promptRules = body.promptRules;
      if (Object.hasOwn(body, 'blockedResponsibilityTitles')) patch.blockedResponsibilityTitles = body.blockedResponsibilityTitles;
      if (Object.hasOwn(body, 'failureExamples')) patch.failureExamples = body.failureExamples;
      if (Object.hasOwn(body, 'fallbackMode')) patch.fallbackMode = body.fallbackMode;
      if (Object.hasOwn(body, 'plannerMode')) patch.plannerMode = body.plannerMode;
      const config = normalizeResponsibilityGenerationGovernanceConfig(
        { ...current, ...patch, updatedAt: typeof nowIso === 'function' ? nowIso() : new Date().toISOString() },
      );
      state[RESPONSIBILITY_GENERATION_GOVERNANCE_STATE_KEY] = config;
      if (typeof persistStateDocument === 'function') {
        await persistStateDocument({
          key: RESPONSIBILITY_GENERATION_GOVERNANCE_STATE_KEY,
          value: config,
        });
      }
      res.json({ ok: true, config });
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
