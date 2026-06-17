import crypto from 'node:crypto';
import express from 'express';
import { buildFamilyReport } from '../../src/family-report-engine.mjs';
import {
  buildFamilySalesReviewInput,
  generateFamilySalesReview,
} from '../family-sales-review.service.mjs';
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
    nowIso = () => new Date().toISOString(),
  } = context;
  const ownerResolverContext = { resolveAuthUser, requestOwner, state };
  const familyLookupContext = { familyOwnerMatches };
  const familyMembersContext = { listFamilyMembers };
  const familyShareContext = { attachPolicyFamilyDisplay: attachPolicyForFamilyReview, listFamilyMembers, normalizeGuestId };
  const familyPersistOptions = { refreshOptionalResponsibilityGovernance: false };
  const saveFamilyState = async ({ includePolicies = false } = {}) => {
    if (persistFamilyState) {
      await persistFamilyState({ includePolicies });
      return;
    }
    await persist(state, familyPersistOptions);
  };
  const saveFamilyReportState = async () => {
    if (persistFamilyReportState) {
      await persistFamilyReportState();
      return;
    }
    await persist(state, familyPersistOptions);
  };

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  function isUserReportRefreshRequest(req) {
    return req.body?.userRefresh === true;
  }

  function archiveSalesReviewForFamily(familyId) {
    state.familySalesReviews = Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [];
    for (const review of state.familySalesReviews) {
      if (Number(review?.familyId || 0) !== Number(familyId)) continue;
      if (String(review?.status || 'active') !== 'active') continue;
      review.status = 'archived';
      review.updatedAt = new Date().toISOString();
    }
  }

  function archiveGeneratedReportsForFamily(familyId) {
    if (typeof archiveFamilyGeneratedReports !== 'function') return;
    archiveFamilyGeneratedReports(state, [familyId]);
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

  function latestFamilySalesReview(familyId, owner) {
    return (Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [])
      .filter((review) => (
        Number(review?.familyId || 0) === Number(familyId) &&
        String(review?.status || 'active') === 'active' &&
        salesReviewMatchesOwner(review, owner)
      ))
      .sort((left, right) => (
        String(right.generatedAt || right.createdAt || '').localeCompare(String(left.generatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ))[0] || null;
  }

  function latestFamilyReport(familyId, owner) {
    return (Array.isArray(state.familyReports) ? state.familyReports : [])
      .filter((record) => (
        Number(record?.familyId || 0) === Number(familyId) &&
        String(record?.status || 'active') === 'active' &&
        salesReviewMatchesOwner(record, owner)
      ))
      .sort((left, right) => (
        String(right.generatedAt || right.createdAt || '').localeCompare(String(left.generatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ))[0] || null;
  }

  function policiesForFamilyReport(family, owner) {
    return (state.policies || [])
      .filter((policy) => (
        Number(policy?.familyId || 0) === Number(family.id) &&
        familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId })
      ))
      .map(attachPolicyForFamilyReview);
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
      content: review.content || '',
      model: '',
      generatedAt: review.generatedAt || review.createdAt || '',
      inputSummary: review.inputSummary || {},
      createdAt: review.createdAt || '',
      updatedAt: review.updatedAt || '',
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
    const families = familiesForOwner.map((family) => familyWithMembers(state, family, familyMembersContext));
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
      const shouldArchiveSalesReview = hasOwn(req.body, 'notes');
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
      }
      if (hasNotesInput) {
        const beforeMemberUpdatedAt = member.updatedAt;
        updateFamilyMemberNotes(member, req.body?.notes);
        if (member.updatedAt !== beforeMemberUpdatedAt) family.updatedAt = member.updatedAt;
        archiveGeneratedReportsForFamily(family.id);
      }
      await saveFamilyState();
      return res.json({ ok: true, family, member, members: listFamilyMembers(state, family.id) });
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
    return res.json({ ok: true, review: clientSalesReview(latestFamilySalesReview(family.id, owner)) });
  });

  router.get('/family-profiles/:id/report', async (req, res) => {
    const owner = resolveFamilyRequestOwner(req, res, ownerResolverContext);
    if (!owner) return undefined;
    const family = findOwnedFamily(state, req.params.id, owner, familyLookupContext);
    if (!family) {
      return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    }
    const reportRecord = latestFamilyReport(family.id, owner);
    if (reportRecord && (
      refreshStaleFamilyReportRecord({ record: reportRecord, family, owner }) ||
      refreshFamilyReportWithTrustedCorrections({ record: reportRecord, family, owner })
    )) {
      await saveFamilyReportState();
    }
    return res.json({ ok: true, reportRecord: clientFamilyReportRecord?.(reportRecord) || null });
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
      const familyReport = buildFamilyReport(policies, null, { familyId: family.id });
      const input = buildFamilySalesReviewInput({
        family,
        members,
        policies,
        familyReport,
        knowledgeRecords: state.knowledgeRecords || [],
        indicatorRecords: state.insuranceIndicatorRecords || [],
        optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
      });
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
      archiveSalesReviewForFamily(family.id);
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
