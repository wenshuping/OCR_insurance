import crypto from 'node:crypto';
import express from 'express';
import { buildFamilyReport } from '../../src/family-report-engine.mjs';
import {
  buildFamilySalesReviewInput,
  generateFamilySalesReview,
} from '../family-sales-review.service.mjs';
import {
  buildFamilySalesChatContext,
  generateFamilySalesChatReply,
} from '../family-sales-chat.service.mjs';
import {
  buildFamilySalesMemoryContext,
  extractFamilySalesMemories,
  upsertFamilySalesMemories,
} from '../family-sales-memory.service.mjs';
import {
  buildFamilyPolicyAnalysisInput,
  generateFamilyPolicyAnalysisReport,
} from '../family-policy-analysis-report.service.mjs';
import { sendError } from '../http/errors.mjs';
import {
  buildFamilySharePayload,
  cloneFamilySharePayload,
  familySharePolicyMatchesOwner,
  familyWithMembers,
  findOwnedFamily,
  resolveFamilyRequestOwner,
  sanitizeFamilyShareValue,
} from '../services/family-workflow.service.mjs';

export function createFamilyRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    archiveFamilyMember,
    archiveFamilyProfile,
    archiveFamilyGeneratedReports,
    allocateId,
    attachPolicyCoverageIndicators,
    attachPolicyFamilyDisplay,
    cashflowStore,
    cashValueStore,
    computeAndStoreCashflow,
    createFamilyMember,
    createFamilyProfile,
    ensureDefaultFamilyProfileForPrincipal,
    familyOwnerMatches,
    listFamilyMembers,
    listFamilyProfilesForOwner,
    normalizeFamilyRelation,
    normalizeGuestId,
    persistFamilyReportState,
    persistFamilyState,
    persistExtractedFamilySalesMemories,
    repairDuplicateFamilyMembers,
    requestOwner,
    resolveAuthUser,
    setFamilyCoreMember,
    mergePolicyDerivedResult,
    updateFamilyProfileName,
    updateFamilyMemberProfile,
    updateFamilyMemberNotes,
    updateFamilyMemberRelation,
    upsertFamilyMember,
    appendFamilyReportCorrections,
    appendFamilyReportIssues,
    assertUserReportRefreshAllowed,
    clientFamilyReportRecord,
    createFamilyReportRecord,
    generateFamilyReportQualityIssues,
    applyFamilyReportPolicyCorrections,
    familyReportEngineVersion = 0,
    trustedFamilyReportCorrections,
    syncFamilyReportRuleIssues,
    updateFamilyReportRecordReport,
    recordUserReportRefresh,
    generateFamilySalesReview: generateFamilySalesReviewImpl = generateFamilySalesReview,
    generateFamilySalesChatReply: generateFamilySalesChatReplyImpl = generateFamilySalesChatReply,
    extractFamilySalesMemories: extractFamilySalesMemoriesImpl = extractFamilySalesMemories,
    generateFamilyPolicyAnalysisReport: generateFamilyPolicyAnalysisReportImpl = generateFamilyPolicyAnalysisReport,
    nowIso = () => new Date().toISOString(),
    policyImports,
  } = context;
  const ownerResolverContext = { resolveAuthUser, requestOwner, state };
  const familyLookupContext = { familyOwnerMatches };
  const familyMembersContext = { listFamilyMembers };
  const familyShareContext = { attachPolicyFamilyDisplay: attachPolicyForFamilyReview, listFamilyMembers, normalizeGuestId };
  const familyPersistOptions = { refreshOptionalResponsibilityGovernance: false };
  const saveFamilyState = async ({ includePolicies = false } = {}) => {
    await persistFamilyState({ includePolicies });
  };
  const saveFamilyReportState = async () => {
    await persistFamilyReportState();
  };

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  function ownedActiveFamily(req, res) {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return null;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
      return null;
    }
    return { owner, family };
  }

  router.post('/family-profiles/:id/policy-imports', async (req, res) => {
    const scope = ownedActiveFamily(req, res);
    if (!scope) return undefined;
    try {
      const task = await policyImports.start({ ...scope, channel: 'web' });
      return res.status(201).json({ ok: true, task });
    } catch (error) { return sendError(res, error, error?.status || 500); }
  });

  router.get('/family-profiles/:id/policy-imports/:taskId', async (req, res) => {
    const scope = ownedActiveFamily(req, res);
    if (!scope) return undefined;
    try { return res.json({ ok: true, task: await policyImports.get({ familyId: scope.family.id, taskId: req.params.taskId, owner: scope.owner }) }); }
    catch (error) { return sendError(res, error, error?.status || 500); }
  });

  router.post('/family-profiles/:id/policy-imports/:taskId/files', async (req, res) => {
    const scope = ownedActiveFamily(req, res);
    if (!scope) return undefined;
    try {
      const task = await policyImports.append({ familyId: scope.family.id, taskId: req.params.taskId, owner: scope.owner, stateVersion: req.body?.stateVersion, files: req.body?.files });
      return res.json({ ok: true, task });
    } catch (error) { return sendError(res, error, error?.status || 500); }
  });

  router.post('/family-profiles/:id/policy-imports/:taskId/actions', async (req, res) => {
    const scope = ownedActiveFamily(req, res);
    if (!scope) return undefined;
    try {
      const task = await policyImports.action({ familyId: scope.family.id, taskId: req.params.taskId, owner: scope.owner, input: req.body || {} });
      return res.json({ ok: true, task });
    } catch (error) { return sendError(res, error, error?.status || 500); }
  });

  router.post('/family-profiles/:id/policy-imports/:taskId/finalize', async (req, res) => {
    const scope = ownedActiveFamily(req, res);
    if (!scope) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortOnClose = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abortOnClose);
    try {
      const result = await policyImports.finalize({ ...scope, taskId: Number(req.params.taskId), requestId: req.body?.requestId, stateVersion: req.body?.stateVersion, signal: controller.signal });
      return res.json({ ok: true, result });
    } catch (error) { return sendError(res, error, error?.status || 500); }
    finally { req.off('aborted', abort); res.off('close', abortOnClose); }
  });

  function isUserReportRefreshRequest(req) {
    return req.body?.userRefresh === true;
  }

  function archiveSalesReviewForFamily(familyId, owner = {}) {
    state.familySalesReviews = Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [];
    const shouldMatchOwner = Boolean(owner?.userId || owner?.guestId);
    for (const review of state.familySalesReviews) {
      if (Number(review?.familyId || 0) !== Number(familyId)) continue;
      if (shouldMatchOwner && !salesReviewMatchesOwner(review, owner)) continue;
      if (String(review?.status || 'active') !== 'active') continue;
      review.status = 'archived';
      review.updatedAt = new Date().toISOString();
    }
  }

  function archiveGeneratedReportsForFamily(familyId) {
    if (typeof archiveFamilyGeneratedReports !== 'function') return;
    archiveFamilyGeneratedReports(state, [familyId]);
  }

  function policyRolesForFamilyMember(policy, memberId) {
    const id = Number(memberId || 0);
    if (!id) return [];
    const roles = [];
    if (Number(policy?.applicantMemberId || 0) === id) roles.push('投保人');
    if (Number(policy?.insuredMemberId || 0) === id) roles.push('被保人');
    return roles;
  }

  function policySummaryForFamilyMember(policy, roles = []) {
    return {
      id: policy.id,
      company: policy.company || '',
      name: policy.name || '',
      policyNumber: policy.policyNumber || '',
      applicant: policy.applicant || '',
      insured: policy.insured || '',
      roles,
    };
  }

  function boundPolicyEntriesForMember({ family, member, owner }) {
    return (state.policies || [])
      .filter((policy) => (
        Number(policy?.familyId || 0) === Number(family.id) &&
        familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId })
      ))
      .map((policy) => ({ policy, roles: policyRolesForFamilyMember(policy, member.id) }))
      .filter((entry) => entry.roles.length > 0)
      .sort((left, right) => Number(left.policy.id || 0) - Number(right.policy.id || 0));
  }

  function assignIfChanged(target, key, value) {
    if (target[key] === value) return false;
    target[key] = value;
    return true;
  }

  async function recomputePolicyCashflow(policy) {
    if (typeof computeAndStoreCashflow !== 'function') return;
    try {
      await computeAndStoreCashflow(policy);
    } catch (error) {
      console.warn(`[family-member] Failed to recompute cashflow policy=${policy?.id || ''}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function syncFamilyMemberToPolicies({ family, member, owner }) {
    const entries = boundPolicyEntriesForMember({ family, member, owner });
    const name = String(member?.name || '').trim();
    const birthday = String(member?.birthday || '').trim();
    const relationLabel = String(member?.relationLabel || '').trim();
    const updatedAt = new Date().toISOString();
    const policies = [];

    for (const { policy, roles } of entries) {
      let changed = false;
      if (roles.includes('投保人')) {
        changed = assignIfChanged(policy, 'applicant', name) || changed;
        changed = assignIfChanged(policy, 'applicantBirthday', birthday) || changed;
        changed = assignIfChanged(policy, 'applicantMemberName', name) || changed;
        changed = assignIfChanged(policy, 'applicantRelation', relationLabel) || changed;
        changed = assignIfChanged(policy, 'applicantRelationLabel', relationLabel) || changed;
        changed = assignIfChanged(policy, 'applicantNameSnapshot', name) || changed;
        changed = assignIfChanged(policy, 'applicantRelationSnapshot', relationLabel) || changed;
      }
      if (roles.includes('被保人')) {
        changed = assignIfChanged(policy, 'insured', name) || changed;
        changed = assignIfChanged(policy, 'insuredBirthday', birthday) || changed;
        changed = assignIfChanged(policy, 'insuredMemberName', name) || changed;
        changed = assignIfChanged(policy, 'insuredRelation', relationLabel) || changed;
        changed = assignIfChanged(policy, 'insuredRelationLabel', relationLabel) || changed;
        changed = assignIfChanged(policy, 'insuredNameSnapshot', name) || changed;
        changed = assignIfChanged(policy, 'insuredRelationSnapshot', relationLabel) || changed;
      }
      if (!changed) continue;
      policy.participantReviewStatus = policy.applicant && policy.insured ? 'ok' : 'pending_review';
      policy.updatedAt = updatedAt;
      policies.push(policy);
      await recomputePolicyCashflow(policy);
    }

    if (policies.length) archiveGeneratedReportsForFamily(family.id);
    return {
      affectedPolicies: entries.map((entry) => policySummaryForFamilyMember(entry.policy, entry.roles)),
      policies,
    };
  }

  function ownerFields(owner = {}) {
    return {
      ownerUserId: Number(owner.userId || 0) || null,
      ownerGuestId: owner.userId ? '' : normalizeGuestId(owner.guestId),
    };
  }

  function salesReviewMatchesOwner(review = {}, owner = {}) {
    if (owner.userId) return Number(review.ownerUserId || 0) === Number(owner.userId);
    if (owner.guestId) return normalizeGuestId(review.ownerGuestId) === owner.guestId && !Number(review.ownerUserId || 0);
    return false;
  }

  function latestFamilySalesReview(familyId, owner, { includeArchivedFallback = false } = {}) {
    const matches = (Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [])
      .filter((review) => (
        Number(review?.familyId || 0) === Number(familyId) &&
        salesReviewMatchesOwner(review, owner)
      ))
      .sort((left, right) => (
        String(right.generatedAt || right.createdAt || '').localeCompare(String(left.generatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ));
    return matches.find((review) => String(review?.status || 'active') === 'active') ||
      (includeArchivedFallback ? matches.find((review) => String(review?.status || 'active') === 'archived') || null : null);
  }

  function latestFamilyReport(familyId, owner, { includeArchivedFallback = false } = {}) {
    const matches = (Array.isArray(state.familyReports) ? state.familyReports : [])
      .filter((record) => (
        Number(record?.familyId || 0) === Number(familyId) &&
        salesReviewMatchesOwner(record, owner)
      ))
      .sort((left, right) => (
        String(right.generatedAt || right.createdAt || '').localeCompare(String(left.generatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ));
    return matches.find((record) => String(record?.status || 'active') === 'active') ||
      (includeArchivedFallback ? matches.find((record) => String(record?.status || 'active') === 'archived') || null : null);
  }

  function policiesForFamilyReport(family, owner) {
    return (state.policies || [])
      .filter((policy) => (
        Number(policy?.familyId || 0) === Number(family.id) &&
        familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId })
      ))
      .map(attachPolicyForFamilyReview);
  }

  function policySummaryForFamily(family, owner) {
    const groupsByInsured = new Map();
    let policyCount = 0;
    let totalCoverage = 0;
    let annualPremium = 0;
    for (const policy of Array.isArray(state.policies) ? state.policies : []) {
      if (Number(policy?.familyId || 0) !== Number(family.id)) continue;
      if (!familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId })) continue;
      const insured = String(policy.insured || '').trim() || '未识别被保人';
      const group = groupsByInsured.get(insured) || {
        insured,
        policyCount: 0,
        totalCoverage: 0,
        annualPremium: 0,
        policyIds: [],
      };
      policyCount += 1;
      totalCoverage += Number(policy.amount || 0);
      annualPremium += Number(policy.firstPremium || 0);
      group.policyCount += 1;
      group.totalCoverage += Number(policy.amount || 0);
      group.annualPremium += Number(policy.firstPremium || 0);
      group.policyIds.push(policy.id);
      groupsByInsured.set(insured, group);
    }
    return {
      policyCount,
      totalCoverage,
      annualPremium,
      insuredGroups: [...groupsByInsured.values()].sort((left, right) => (
        right.policyCount - left.policyCount ||
        String(left.insured || '').localeCompare(String(right.insured || ''))
      )),
    };
  }

  function familyListItem(family, owner) {
    const policySummary = policySummaryForFamily(family, owner);
    return {
      ...familyWithMembers(state, family, familyMembersContext),
      policyCount: policySummary.policyCount,
      policySummary,
    };
  }

  function reportJson(value) {
    try {
      return JSON.stringify(value || null);
    } catch {
      return '';
    }
  }

  function refreshFamilyReportWithTrustedCorrections({ record, family, owner, members, policies, force = false } = {}) {
    if (!record || typeof trustedFamilyReportCorrections !== 'function' || typeof updateFamilyReportRecordReport !== 'function') {
      return false;
    }
    const corrections = trustedFamilyReportCorrections(state, { familyId: family.id, reportId: record.id });
    if (!force && !corrections.length) return false;
    const reportMembers = members || listFamilyMembers(state, family.id);
    const reportPolicies = typeof applyFamilyReportPolicyCorrections === 'function'
      ? applyFamilyReportPolicyCorrections(policies || policiesForFamilyReport(family, owner), corrections)
      : (policies || policiesForFamilyReport(family, owner));
    const nextReport = buildFamilyReport(reportPolicies, record.planningProfile || null, {
      familyId: family.id,
      corrections,
    });
    const draftRecord = { summary: record.summary || {} };
    updateFamilyReportRecordReport({
      record: draftRecord,
      members: reportMembers,
      policies: reportPolicies,
      report: nextReport,
    });
    let changed = false;
    if (reportJson(draftRecord.report) !== reportJson(record.report)) {
      updateFamilyReportRecordReport({
        record,
        members: reportMembers,
        policies: reportPolicies,
        report: nextReport,
      });
      changed = true;
    }
    if (typeof syncFamilyReportRuleIssues === 'function') {
      changed = syncFamilyReportRuleIssues({
        state,
        record,
        family,
        members: reportMembers,
        policies: reportPolicies,
        allocateId,
      }) || changed;
    }
    return changed;
  }

  function refreshStaleFamilyReportRecord({ record, family, owner } = {}) {
    if (!record || !familyReportEngineVersion) return false;
    const recordVersion = Number(record.engineVersion || 0);
    if (recordVersion >= familyReportEngineVersion) return false;
    return refreshFamilyReportWithTrustedCorrections({ record, family, owner, force: true });
  }

  async function repairFamilyMembersBeforeReview(family) {
    if (typeof repairDuplicateFamilyMembers !== 'function') return false;
    const repaired = repairDuplicateFamilyMembers(state, family);
    if (!repaired) return false;
    archiveGeneratedReportsForFamily(family.id);
    await saveFamilyState({ includePolicies: true });
    return true;
  }

  function clientSalesReview(review = null) {
    if (!review) return null;
    return {
      id: review.id,
      familyId: review.familyId,
      status: review.status || 'active',
      content: review.content || '',
      model: '',
      generatedAt: review.generatedAt || review.createdAt || '',
      inputSummary: review.inputSummary || {},
      createdAt: review.createdAt || '',
      updatedAt: review.updatedAt || '',
    };
  }

  function salesChatThreadMatchesOwner(thread = {}, owner = {}) {
    if (owner.userId) return Number(thread.ownerUserId || 0) === Number(owner.userId);
    if (owner.guestId) return normalizeGuestId(thread.ownerGuestId) === owner.guestId && !Number(thread.ownerUserId || 0);
    return false;
  }

  function clientSalesChatThread(thread = null, messages = []) {
    if (!thread) return null;
    const threadMessages = (Array.isArray(messages) ? messages : [])
      .filter((message) => Number(message?.threadId || 0) === Number(thread.id || 0));
    const latestMessage = threadMessages
      .slice()
      .sort((left, right) => (
        String(right.createdAt || '').localeCompare(String(left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ))[0] || null;
    return {
      id: Number(thread.id || 0),
      familyId: Number(thread.familyId || 0),
      status: String(thread.status || 'active'),
      title: String(thread.title || ''),
      createdAt: thread.createdAt || '',
      updatedAt: thread.updatedAt || thread.createdAt || '',
      messageCount: threadMessages.length,
      latestMessageAt: latestMessage?.createdAt || '',
      messages: threadMessages
        .slice()
        .sort((left, right) => (
          String(left.createdAt || '').localeCompare(String(right.createdAt || '')) ||
          Number(left.id || 0) - Number(right.id || 0)
        ))
        .map(clientSalesChatMessage)
        .filter(Boolean),
    };
  }

  function clientSalesChatMessage(message = null) {
    if (!message) return null;
    return {
      id: Number(message.id || 0),
      threadId: Number(message.threadId || 0),
      familyId: Number(message.familyId || 0),
      role: String(message.role || ''),
      content: String(message.content || ''),
      status: String(message.status || 'complete'),
      createdAt: message.createdAt || '',
      error: message.error || '',
    };
  }

  function salesChatThreadsForFamily(familyId, owner) {
    return (Array.isArray(state.familySalesChatThreads) ? state.familySalesChatThreads : [])
      .filter((thread) => (
        Number(thread?.familyId || 0) === Number(familyId || 0) &&
        String(thread?.status || 'active') === 'active' &&
        salesChatThreadMatchesOwner(thread, owner)
      ))
      .sort((left, right) => (
        String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ));
  }

  function salesChatMessagesForThread(threadId) {
    return (Array.isArray(state.familySalesChatMessages) ? state.familySalesChatMessages : [])
      .filter((message) => Number(message?.threadId || 0) === Number(threadId || 0))
      .sort((left, right) => (
        String(left.createdAt || '').localeCompare(String(right.createdAt || '')) ||
        Number(left.id || 0) - Number(right.id || 0)
      ));
  }

  function salesMemoryMatchesOwner(memory = {}, owner = {}) {
    if (owner.userId) return Number(memory.ownerUserId || 0) === Number(owner.userId);
    if (owner.guestId) return normalizeGuestId(memory.ownerGuestId) === owner.guestId && !Number(memory.ownerUserId || 0);
    return false;
  }

  function familySalesMemoriesForFamily(familyId, owner) {
    return (Array.isArray(state.familySalesMemories) ? state.familySalesMemories : [])
      .filter((memory) => (
        Number(memory?.familyId || 0) === Number(familyId || 0) &&
        String(memory?.status || 'active') === 'active' &&
        salesMemoryMatchesOwner(memory, owner)
      ))
      .sort((left, right) => (
        String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ));
  }

  function salesMemoryContextForFamily(familyId, owner) {
    return buildFamilySalesMemoryContext(familySalesMemoriesForFamily(familyId, owner));
  }

  function findSalesChatThread({ familyId, threadId, owner }) {
    return salesChatThreadsForFamily(familyId, owner)
      .find((thread) => Number(thread.id || 0) === Number(threadId || 0)) || null;
  }

  function salesChatTitleFromQuestion(question = '') {
    const title = String(question || '').trim().replace(/\s+/gu, ' ');
    return title ? title.slice(0, 32) : '销售建议续聊';
  }

  function selectedSalesChatMessageIdsForSalesReview(req) {
    const rawIds = Array.isArray(req.body?.salesChatMessageIds) ? req.body.salesChatMessageIds : [];
    const ids = rawIds
      .map((id) => Number(id || 0))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    return Array.from(new Set(ids)).slice(0, 6);
  }

  function salesChatContextForSalesReview(familyId, owner, messageIds = []) {
    const selectedIds = Array.isArray(messageIds) ? messageIds : [];
    if (!selectedIds.length) return null;
    const allowedThreads = new Set(salesChatThreadsForFamily(familyId, owner).map((thread) => Number(thread.id || 0)));
    if (!allowedThreads.size) return null;
    const selectedIdSet = new Set(selectedIds.map((id) => Number(id || 0)));
    const messages = (Array.isArray(state.familySalesChatMessages) ? state.familySalesChatMessages : [])
      .filter((message) => (
        selectedIdSet.has(Number(message?.id || 0)) &&
        Number(message?.familyId || 0) === Number(familyId || 0) &&
        allowedThreads.has(Number(message?.threadId || 0)) &&
        String(message?.status || 'complete') === 'complete'
      ))
      .sort((left, right) => (
        String(left.createdAt || '').localeCompare(String(right.createdAt || '')) ||
        Number(left.id || 0) - Number(right.id || 0)
      ))
      .slice(0, 6)
      .map((message) => ({
        role: String(message.role || ''),
        content: String(message.content || '').slice(0, 800),
        status: String(message.status || 'complete'),
        createdAt: message.createdAt || '',
      }))
      .filter((message) => message.content);
    if (!messages.length) return null;
    return {
      selectedMessageCount: messages.length,
      recentMessages: messages,
      usageHint: '这些是顾问明确选择用于重新生成销售建议的续聊内容。只吸收其中的客户异议、表达偏好、方案排序和下一步动作，不要把未选择的聊天内容写入新版报告。',
    };
  }

  function appendSalesChatMessage({ thread, role, content, status = 'complete', error = '', model = '', createdAt = nowIso() }) {
    const message = {
      id: allocateId(state),
      threadId: Number(thread.id),
      familyId: Number(thread.familyId),
      role,
      content,
      status,
      error,
      model,
      createdAt,
    };
    state.familySalesChatMessages = Array.isArray(state.familySalesChatMessages) ? state.familySalesChatMessages : [];
    state.familySalesChatMessages.push(message);
    thread.updatedAt = createdAt;
    return message;
  }

  function buildSalesChatRuntimeContext({ family, owner }) {
    const members = listFamilyMembers(state, family.id);
    const policies = policiesForFamilyReport(family, owner);
    const planningProfile = family.planningProfile || null;
    const familyReport = buildFamilyReport(policies, planningProfile, { familyId: family.id });
    const input = buildFamilySalesReviewInput({
      family,
      members,
      policies,
      familyReport,
      planningProfile,
      knowledgeRecords: state.knowledgeRecords || [],
      indicatorRecords: state.insuranceIndicatorRecords || [],
      optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
      generatedAt: nowIso(),
    });
    const context = buildFamilySalesChatContext({
      input,
      family,
      members,
      policies,
      familyReports: state.familyReports || [],
      familySalesReviews: state.familySalesReviews || [],
      generatedAt: nowIso(),
    });
    const salesMemoryContext = salesMemoryContextForFamily(family.id, owner);
    if (salesMemoryContext) context.salesMemoryContext = salesMemoryContext;
    return context;
  }

  async function rememberSalesChatTurn({ thread, family, owner, userMessage, assistantMessage }) {
    if (!assistantMessage || assistantMessage.model === 'identity_guard') return;
    try {
      const extractedMemories = await extractFamilySalesMemoriesImpl({
        familyId: family.id,
        threadId: thread.id,
        userMessage,
        assistantMessage,
        existingMemories: familySalesMemoriesForFamily(family.id, owner),
      });
      if (persistExtractedFamilySalesMemories) {
        await persistExtractedFamilySalesMemories({ familyId: family.id, owner: ownerFields(owner), sourceThreadId: thread.id, userMessage, extractedMemories, nowIso });
      } else {
        upsertFamilySalesMemories({ state, familyId: family.id, owner: ownerFields(owner), sourceThreadId: thread.id, userMessage, extractedMemories, allocateId, nowIso });
      }
    } catch (error) {
      console.warn(`[family-sales-memory] Failed to extract memories family=${family?.id || ''} thread=${thread?.id || ''}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function generateAndAppendSalesChatReply({ thread, family, owner, question, history, userMessage }) {
    const chatContext = buildSalesChatRuntimeContext({ family, owner });
    const reply = await generateFamilySalesChatReplyImpl({
      context: chatContext,
      history,
      question,
    });
    const assistantMessage = appendSalesChatMessage({
      thread,
      role: 'assistant',
      content: reply.content,
      model: reply.model,
      createdAt: reply.generatedAt || nowIso(),
    });
    await rememberSalesChatTurn({ thread, family, owner, userMessage, assistantMessage });
    return assistantMessage;
  }

  function clientFamilyPolicyAnalysisReport(record = null) {
    const report = record?.report?.familyPolicyAnalysisReport || null;
    if (!report) return null;
    return {
      status: report.status || 'complete',
      content: report.content || '',
      model: '',
      generatedAt: report.generatedAt || record.updatedAt || record.generatedAt || '',
      error: report.error || '',
      stale: String(record?.status || 'active') !== 'active',
    };
  }

  async function appendDeepSeekReportIssues({
    record,
    family,
    members,
    policies,
    report,
    planningProfile,
  }) {
    if (typeof appendFamilyReportIssues !== 'function' || typeof generateFamilyReportQualityIssues !== 'function') return [];
    try {
      const issues = await generateFamilyReportQualityIssues({
        family,
        members,
        policies,
        report,
        planningProfile,
        knowledgeRecords: state.knowledgeRecords || [],
        indicatorRecords: state.insuranceIndicatorRecords || [],
        optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
      });
      const issueInputs = Array.isArray(issues) ? issues : (issues?.issues || []);
      const correctionInputs = Array.isArray(issues) ? [] : (issues?.corrections || []);
      const issueRows = appendFamilyReportIssues({ state, record, issues: issueInputs, allocateId });
      const correctionRows = typeof appendFamilyReportCorrections === 'function'
        ? appendFamilyReportCorrections({ state, record, corrections: correctionInputs, issueRows, allocateId })
        : [];
      console.log(`[family-report] DeepSeek quality ${issueRows.length || correctionRows.length ? 'completed' : 'skipped'} family=${family?.id || ''} report=${record?.id || ''} issues=${issueRows.length} corrections=${correctionRows.length}`);
      return { issues: issueRows, corrections: correctionRows };
    } catch (error) {
      console.warn(`[family-report] DeepSeek quality failed family=${family?.id || ''} report=${record?.id || ''}: ${error instanceof Error ? error.message : error}`);
      const issueRows = appendFamilyReportIssues({
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
      return { issues: issueRows, corrections: [] };
    }
  }

  function findPolicyDerivedResult(policyId) {
    const id = Number(policyId || 0);
    if (!Number.isFinite(id) || id <= 0) return null;
    return (Array.isArray(state.policyDerivedResults) ? state.policyDerivedResults : [])
      .find((row) => Number(row?.policyId || 0) === id) || null;
  }

  function attachPolicyForFamilyReview(policy) {
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

  router.get('/family-profiles', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const ownerPolicies = (state.policies || []).filter((policy) => familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId }));
    let familiesForOwner = listFamilyProfilesForOwner(state, owner);
    const hasActiveFamily = familiesForOwner.some((family) => String(family?.status || 'active') === 'active');
    const needsDefaultMigration = (
      ownerPolicies.length > 0 &&
      !hasActiveFamily
    );
    if (needsDefaultMigration) {
      const beforeMarker = JSON.stringify({
        nextId: state.nextId,
        familyProfiles: state.familyProfiles,
        familyMembers: state.familyMembers,
        policyBindings: ownerPolicies.map((policy) => ({
          id: policy.id,
          familyId: policy.familyId,
          applicantMemberId: policy.applicantMemberId,
          insuredMemberId: policy.insuredMemberId,
          participantReviewStatus: policy.participantReviewStatus,
        })),
      });
      ensureDefaultFamilyProfileForPrincipal(state, owner);
      familiesForOwner = listFamilyProfilesForOwner(state, owner);
      const migratedPolicies = (state.policies || []).filter((policy) => familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId }));
      const afterMarker = JSON.stringify({
        nextId: state.nextId,
        familyProfiles: state.familyProfiles,
        familyMembers: state.familyMembers,
        policyBindings: migratedPolicies.map((policy) => ({
          id: policy.id,
          familyId: policy.familyId,
          applicantMemberId: policy.applicantMemberId,
          insuredMemberId: policy.insuredMemberId,
          participantReviewStatus: policy.participantReviewStatus,
        })),
      });
      if (afterMarker !== beforeMarker) await saveFamilyState({ includePolicies: true });
    }
    let repairedDuplicates = false;
    if (typeof repairDuplicateFamilyMembers === 'function') {
      for (const family of familiesForOwner) {
        repairedDuplicates = repairDuplicateFamilyMembers(state, family) || repairedDuplicates;
      }
      if (repairedDuplicates) await saveFamilyState({ includePolicies: true });
    }
    const families = familiesForOwner.map((family) => familyListItem(family, owner));
    return res.json({ ok: true, families });
  });

  router.post('/family-profiles', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    try {
      const family = createFamilyProfile(state, req.body || {}, owner);
      await saveFamilyState();
      return res.status(201).json({ ok: true, family, members: [] });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.post('/family-profiles/default', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    try {
      const family = ensureDefaultFamilyProfileForPrincipal(state, owner);
      await saveFamilyState({ includePolicies: true });
      return res.json({ ok: true, family, members: listFamilyMembers(state, family.id) });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.patch('/family-profiles/:id', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    try {
      const shouldArchiveSalesReview = hasOwn(req.body, 'notes') || hasOwn(req.body, 'planningProfile');
      updateFamilyProfileName(family, req.body || {});
      if (shouldArchiveSalesReview) archiveGeneratedReportsForFamily(family.id);
      await saveFamilyState();
      return res.json({ ok: true, family, members: listFamilyMembers(state, family.id) });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.delete('/family-profiles/:id', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    const result = archiveFamilyProfile(state, family, owner);
    await saveFamilyState({ includePolicies: true });
    return res.json({ ok: true, ...result });
  });

  router.post('/family-profiles/:id/members', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    try {
      const beforeMembersJson = reportJson(listFamilyMembers(state, family.id));
      const shouldSetAsCore = Boolean(req.body?.setAsCore);
      const memberInput = {
        ...(req.body || {}),
        ...(shouldSetAsCore ? { relationToCore: 'self', relationLabel: '本人', role: 'core' } : {}),
      };
      const member = typeof upsertFamilyMember === 'function'
        ? upsertFamilyMember(state, family, memberInput)
        : createFamilyMember(state, family.id, memberInput);
      if (shouldSetAsCore) {
        setFamilyCoreMember(state, family, member);
      } else {
        family.updatedAt = new Date().toISOString();
      }
      if (beforeMembersJson !== reportJson(listFamilyMembers(state, family.id))) {
        archiveGeneratedReportsForFamily(family.id);
      }
      await saveFamilyState();
      return res.status(201).json({ ok: true, member, family, members: listFamilyMembers(state, family.id) });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.patch('/family-profiles/:id/members/:memberId', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    try {
      const members = listFamilyMembers(state, family.id);
      const member = members.find((row) => Number(row.id) === Number(req.params.memberId || 0) && String(row.status || 'active') === 'active');
      if (!member) {
        const error = new Error('家庭成员不存在');
        error.code = 'FAMILY_MEMBER_NOT_FOUND';
        error.status = 400;
        throw error;
      }
      const hasRelationInput = hasOwn(req.body, 'relationLabel') || hasOwn(req.body, 'relationToCore') || hasOwn(req.body, 'relation');
      const hasNotesInput = hasOwn(req.body, 'notes');
      const hasProfileInput = hasOwn(req.body, 'name') || hasOwn(req.body, 'birthday') || hasOwn(req.body, 'birthDate') || hasOwn(req.body, 'idNumberTail') || hasOwn(req.body, 'idNumber') || hasOwn(req.body, 'identityNumber') || hasOwn(req.body, 'idCard');
      const syncBoundPolicies = req.body?.syncBoundPolicies === true;
      if (hasProfileInput) {
        if (typeof updateFamilyMemberProfile === 'function') {
          const beforeMemberUpdatedAt = member.updatedAt;
          updateFamilyMemberProfile(member, req.body || {});
          if (member.updatedAt !== beforeMemberUpdatedAt) {
            family.updatedAt = member.updatedAt;
            archiveGeneratedReportsForFamily(family.id);
          }
        }
      }
      if (hasRelationInput) {
        const relation = normalizeFamilyRelation(req.body?.relationLabel || req.body?.relationToCore || req.body?.relation);
        const beforeMemberUpdatedAt = member.updatedAt;
        if (relation.relationToCore === 'self') {
          setFamilyCoreMember(state, family, member);
        } else {
          if (Number(member.id) === Number(family.coreMemberId || 0)) {
            const error = new Error('顶梁柱关系固定为本人');
            error.code = 'FAMILY_CORE_RELATION_IMMUTABLE';
            error.status = 400;
            throw error;
          }
          updateFamilyMemberRelation(member, relation.relationLabel);
          family.updatedAt = new Date().toISOString();
        }
        if (member.updatedAt !== beforeMemberUpdatedAt) archiveGeneratedReportsForFamily(family.id);
      }
      if (hasNotesInput) {
        const beforeMemberUpdatedAt = member.updatedAt;
        updateFamilyMemberNotes(member, req.body?.notes);
        if (member.updatedAt !== beforeMemberUpdatedAt) family.updatedAt = member.updatedAt;
        archiveGeneratedReportsForFamily(family.id);
      }
      const affectedPolicies = boundPolicyEntriesForMember({ family, member, owner })
        .map((entry) => policySummaryForFamilyMember(entry.policy, entry.roles));
      const syncResult = syncBoundPolicies && (hasProfileInput || hasRelationInput)
        ? await syncFamilyMemberToPolicies({ family, member, owner })
        : { affectedPolicies, policies: [] };
      await saveFamilyState({ includePolicies: syncResult.policies.length > 0 });
      return res.json({
        ok: true,
        family,
        member,
        members: listFamilyMembers(state, family.id),
        affectedPolicies: syncResult.affectedPolicies,
        syncedPolicyCount: syncResult.policies.length,
        policies: syncResult.policies.map(attachPolicyForFamilyReview),
      });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.delete('/family-profiles/:id/members/:memberId', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    try {
      const members = listFamilyMembers(state, family.id);
      const member = members.find((row) => Number(row.id) === Number(req.params.memberId || 0) && String(row.status || 'active') === 'active');
      if (!member) {
        const error = new Error('家庭成员不存在');
        error.code = 'FAMILY_MEMBER_NOT_FOUND';
        error.status = 400;
        throw error;
      }
      const result = archiveFamilyMember(state, family, member);
      archiveGeneratedReportsForFamily(family.id);
      await saveFamilyState({ includePolicies: result.clearedPolicyCount > 0 });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.patch('/family-profiles/:id/core', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    try {
      const members = listFamilyMembers(state, family.id);
      const member = members.find((row) => Number(row.id) === Number(req.body?.memberId || 0) && String(row.status || 'active') === 'active');
      if (!member) {
        const error = new Error('家庭成员不存在');
        error.code = 'FAMILY_MEMBER_NOT_FOUND';
        error.status = 400;
        throw error;
      }
      setFamilyCoreMember(state, family, member);
      archiveGeneratedReportsForFamily(family.id);
      await saveFamilyState();
      return res.json({ ok: true, family, member, members: listFamilyMembers(state, family.id) });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.post('/family-profiles/:id/share', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }

    const now = new Date().toISOString();
    const share = {
      id: allocateId(state),
      token: crypto.randomUUID().replace(/-/g, ''),
      familyId: Number(family.id),
      createdAt: now,
      payload: buildFamilySharePayload(state, family, owner, now, familyShareContext),
    };
    state.familyReportShares.push(share);
    await saveFamilyState();
    return res.status(201).json({
      ok: true,
      share: {
        id: share.id,
        token: share.token,
        familyId: share.familyId,
        createdAt: share.createdAt,
      },
    });
  });

  router.get('/family-profiles/:id/sales-review', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    await repairFamilyMembersBeforeReview(family);
    return res.json({
      ok: true,
      review: clientSalesReview(latestFamilySalesReview(family.id, owner, { includeArchivedFallback: true })),
    });
  });

  router.get('/family-profiles/:id/report', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    const reportRecord = latestFamilyReport(family.id, owner, { includeArchivedFallback: true });
    if (reportRecord && String(reportRecord.status || 'active') === 'active' && (
      refreshStaleFamilyReportRecord({ record: reportRecord, family, owner }) ||
      refreshFamilyReportWithTrustedCorrections({ record: reportRecord, family, owner })
    )) {
      await saveFamilyReportState();
    }
    return res.json({ ok: true, reportRecord: clientFamilyReportRecord?.(reportRecord) || null });
  });

  router.get('/family-profiles/:id/policy-analysis-report', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    const reportRecord = latestFamilyReport(family.id, owner, { includeArchivedFallback: true });
    return res.json({ ok: true, analysisReport: clientFamilyPolicyAnalysisReport(reportRecord) });
  });

  router.post('/family-profiles/:id/report', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }

    try {
      const userRefresh = isUserReportRefreshRequest(req);
      const now = nowIso();
      if (userRefresh && typeof assertUserReportRefreshAllowed === 'function') {
        assertUserReportRefreshAllowed(state, owner, 'familyReport', { familyId: family.id, now });
      }
      await repairFamilyMembersBeforeReview(family);
      const members = listFamilyMembers(state, family.id);
      const policies = policiesForFamilyReport(family, owner);
      const familyReport = buildFamilyReport(policies, req.body?.planningProfile || null, { familyId: family.id });
      const { record } = createFamilyReportRecord({
        state,
        family,
        owner,
        members,
        policies,
        report: familyReport,
        planningProfile: req.body?.planningProfile || null,
        allocateId,
      });
      await appendDeepSeekReportIssues({
        record,
        family,
        members,
        policies,
        report: record.report,
        planningProfile: req.body?.planningProfile || null,
      });
      refreshFamilyReportWithTrustedCorrections({ record, family, owner, members, policies });
      if (userRefresh && typeof recordUserReportRefresh === 'function') {
        recordUserReportRefresh(state, owner, 'familyReport', {
          familyId: family.id,
          reportId: record.id,
          now,
          allocateId,
        });
      }
      await saveFamilyReportState();
      return res.json({ ok: true, reportRecord: clientFamilyReportRecord(record) });
    } catch (error) {
      return sendError(res, error, error?.status || 500);
    }
  });

  router.post('/family-profiles/:id/sales-review', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }

    try {
      const userRefresh = isUserReportRefreshRequest(req);
      const now = nowIso();
      if (userRefresh && typeof assertUserReportRefreshAllowed === 'function') {
        assertUserReportRefreshAllowed(state, owner, 'familySalesReview', { familyId: family.id, now });
      }
      await repairFamilyMembersBeforeReview(family);
      const members = listFamilyMembers(state, family.id);
      const policies = (state.policies || [])
        .filter((policy) => (
          Number(policy?.familyId || 0) === Number(family.id) &&
          familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId })
        ))
        .map(attachPolicyForFamilyReview);
      const planningProfile = family.planningProfile || null;
      const familyReport = buildFamilyReport(policies, planningProfile, { familyId: family.id });
      const input = buildFamilySalesReviewInput({
        family,
        members,
        policies,
        familyReport,
        planningProfile,
        knowledgeRecords: state.knowledgeRecords || [],
        indicatorRecords: state.insuranceIndicatorRecords || [],
        optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
      });
      const salesChatContext = salesChatContextForSalesReview(
        family.id,
        owner,
        selectedSalesChatMessageIdsForSalesReview(req),
      );
      const salesMemoryContext = salesMemoryContextForFamily(family.id, owner);
      if (salesMemoryContext) input.salesMemoryContext = salesMemoryContext;
      if (salesChatContext) input.salesChatContext = salesChatContext;
      const review = await generateFamilySalesReviewImpl({ input });
      const reviewOwner = ownerFields(owner);
      const reviewRecord = {
        id: allocateId(state),
        familyId: Number(family.id),
        ownerUserId: reviewOwner.ownerUserId,
        ownerGuestId: reviewOwner.ownerGuestId,
        status: 'active',
        content: review.content,
        model: review.model,
        generatedAt: review.generatedAt || now,
        createdAt: now,
        updatedAt: now,
        inputSummary: {
          ...(review.inputSummary || {}),
          familyId: Number(family.id),
        },
      };
      state.familySalesReviews = Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [];
      archiveSalesReviewForFamily(family.id, owner);
      state.familySalesReviews.push(reviewRecord);
      if (userRefresh && typeof recordUserReportRefresh === 'function') {
        recordUserReportRefresh(state, owner, 'familySalesReview', {
          familyId: family.id,
          reportId: reviewRecord.id,
          now,
          allocateId,
        });
      }
      await saveFamilyState();
      return res.json({ ok: true, review: clientSalesReview(reviewRecord) });
    } catch (error) {
      return sendError(res, error, error?.status || 500);
    }
  });

  router.get('/family-profiles/:id/sales-chat/threads', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    const messages = state.familySalesChatMessages || [];
    return res.json({
      ok: true,
      threads: salesChatThreadsForFamily(family.id, owner).map((thread) => clientSalesChatThread(thread, messages)),
    });
  });

  router.post('/family-profiles/:id/sales-chat/threads', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    await repairFamilyMembersBeforeReview(family);
    const now = nowIso();
    const ownerInfo = ownerFields(owner);
    const question = String(req.body?.message || req.body?.content || '').trim();
    const thread = {
      id: allocateId(state),
      familyId: Number(family.id),
      ownerUserId: ownerInfo.ownerUserId,
      ownerGuestId: ownerInfo.ownerGuestId,
      status: 'active',
      title: salesChatTitleFromQuestion(question),
      createdAt: now,
      updatedAt: now,
    };
    state.familySalesChatThreads = Array.isArray(state.familySalesChatThreads) ? state.familySalesChatThreads : [];
    state.familySalesChatThreads.push(thread);
    const createdMessages = [];
    try {
      if (question) {
        const userMessage = appendSalesChatMessage({ thread, role: 'user', content: question, createdAt: now });
        createdMessages.push(userMessage);
        const assistantMessage = await generateAndAppendSalesChatReply({
          thread,
          family,
          owner,
          question,
          history: [],
          userMessage,
        });
        createdMessages.push(assistantMessage);
      }
      await saveFamilyState();
      return res.status(201).json({
        ok: true,
        thread: clientSalesChatThread(thread, state.familySalesChatMessages),
        messages: salesChatMessagesForThread(thread.id).map(clientSalesChatMessage),
      });
    } catch (error) {
      const failedUserMessage = createdMessages.find((message) => message.role === 'user');
      if (failedUserMessage) {
        failedUserMessage.status = 'failed';
        failedUserMessage.error = error instanceof Error ? error.message : '续聊生成失败';
      }
      await saveFamilyState();
      return sendError(res, error, error?.status || 500);
    }
  });

  router.get('/family-profiles/:id/sales-chat/threads/:threadId', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    const thread = findSalesChatThread({ familyId: family.id, threadId: req.params.threadId, owner });
    if (!thread) {
      return res.status(404).json({ ok: false, code: 'FAMILY_SALES_CHAT_THREAD_NOT_FOUND', message: '续聊会话不存在' });
    }
    return res.json({
      ok: true,
      thread: clientSalesChatThread(thread, state.familySalesChatMessages),
      messages: salesChatMessagesForThread(thread.id).map(clientSalesChatMessage),
    });
  });

  router.post('/family-profiles/:id/sales-chat/threads/:threadId/messages', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    const thread = findSalesChatThread({ familyId: family.id, threadId: req.params.threadId, owner });
    if (!thread) {
      return res.status(404).json({ ok: false, code: 'FAMILY_SALES_CHAT_THREAD_NOT_FOUND', message: '续聊会话不存在' });
    }
    const question = String(req.body?.message || req.body?.content || '').trim();
    if (!question) {
      return res.status(400).json({ ok: false, code: 'FAMILY_SALES_CHAT_EMPTY_MESSAGE', message: '请输入要追问的内容' });
    }
    await repairFamilyMembersBeforeReview(family);
    const now = nowIso();
    const historyBeforeUserMessage = salesChatMessagesForThread(thread.id);
    const userMessage = appendSalesChatMessage({ thread, role: 'user', content: question, createdAt: now });
    try {
      const assistantMessage = await generateAndAppendSalesChatReply({
        thread,
        family,
        owner,
        question,
        history: historyBeforeUserMessage,
        userMessage,
      });
      await saveFamilyState();
      return res.json({
        ok: true,
        thread: clientSalesChatThread(thread, state.familySalesChatMessages),
        messages: [userMessage, assistantMessage].map(clientSalesChatMessage),
      });
    } catch (error) {
      userMessage.status = 'failed';
      userMessage.error = error instanceof Error ? error.message : '续聊生成失败';
      await saveFamilyState();
      return sendError(res, error, error?.status || 500);
    }
  });

  router.post('/family-profiles/:id/policy-analysis-report', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }

    try {
      await repairFamilyMembersBeforeReview(family);
      const members = listFamilyMembers(state, family.id);
      const policies = policiesForFamilyReport(family, owner);
      let reportRecord = latestFamilyReport(family.id, owner);
      const planningProfile = req.body?.planningProfile || family.planningProfile || reportRecord?.planningProfile || null;
      const familyReport = buildFamilyReport(policies, planningProfile, { familyId: family.id });
      if (!reportRecord) {
        const created = createFamilyReportRecord({
          state,
          family,
          owner,
          members,
          policies,
          report: familyReport,
          planningProfile,
          allocateId,
        });
        reportRecord = created.record;
      }
      if (
        refreshStaleFamilyReportRecord({ record: reportRecord, family, owner }) ||
        refreshFamilyReportWithTrustedCorrections({ record: reportRecord, family, owner })
      ) {
        await saveFamilyReportState();
        reportRecord = latestFamilyReport(family.id, owner);
      }

      const input = buildFamilyPolicyAnalysisInput({
        family,
        members,
        policies,
        familyReport,
        planningProfile,
        knowledgeRecords: state.knowledgeRecords || [],
        indicatorRecords: state.insuranceIndicatorRecords || [],
        optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
      });
      const analysisReport = await generateFamilyPolicyAnalysisReportImpl({ input });
      reportRecord.report = reportRecord.report || {};
      reportRecord.report.familyPolicyAnalysisReport = {
        status: analysisReport.status || 'complete',
        content: analysisReport.content || '',
        model: analysisReport.model || '',
        generatedAt: analysisReport.generatedAt || nowIso(),
      };
      reportRecord.updatedAt = nowIso();
      await saveFamilyReportState();
      return res.json({ ok: true, analysisReport: clientFamilyPolicyAnalysisReport(reportRecord) });
    } catch (error) {
      return sendError(res, error, error?.status || 500);
    }
  });

  router.get('/family-report-shares/:token', async (req, res) => {
    const token = String(req.params.token || '').trim();
    const share = (state.familyReportShares || []).find((row) => (
      String(row?.token || '') === token &&
      String(row?.status || 'active') === 'active'
    ));
    if (!share) {
      return res.status(404).json({ ok: false, code: 'SHARE_NOT_FOUND', message: '分享报告不存在' });
    }
    return res.json({ ok: true, ...sanitizeFamilyShareValue(cloneFamilySharePayload(share.payload || {})) });
  });

  return router;
}
