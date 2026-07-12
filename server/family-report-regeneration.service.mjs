export function createFamilyReportRegenerationService(deps = {}) {
  const {
    state, allocateId, listFamilyMembers, policiesForFamilyReport, policiesForSalesReview,
    repairFamilyMembersBeforeReview, refreshFamilyCashflowsForAnalysis, buildFamilyReport,
    createFamilyReportRecord, appendDeepSeekReportIssues, refreshFamilyReportWithTrustedCorrections,
    buildFamilySalesReviewInput, generateFamilySalesReview, archiveSalesReviewForFamily,
    ownerFields, persistFamilyReportState, persistFamilyState, nowIso = () => new Date().toISOString(),
  } = deps;

  async function regenerateCoverage({ family, owner, planningProfile = null, stateSnapshot = state, system = false } = {}) {
    await repairFamilyMembersBeforeReview(family);
    refreshFamilyCashflowsForAnalysis(family, owner, stateSnapshot);
    const members = listFamilyMembers(stateSnapshot, family.id);
    const policies = policiesForFamilyReport(family, owner, stateSnapshot);
    const report = buildFamilyReport(policies, planningProfile, { familyId: family.id });
    const { record } = createFamilyReportRecord({ state: stateSnapshot, family, owner, members, policies, report, planningProfile, allocateId, allowEmptyPolicies: system });
    if (stateSnapshot === state) {
      await appendDeepSeekReportIssues({ record, family, members, policies, report: record.report, planningProfile });
      refreshFamilyReportWithTrustedCorrections({ record, family, owner, members, policies });
    }
    await persistFamilyReportState(stateSnapshot);
    return record;
  }

  async function regenerateSalesReview({ family, owner, salesChatContext = null, salesMemoryContext = null, stateSnapshot = state } = {}) {
    await repairFamilyMembersBeforeReview(family);
    refreshFamilyCashflowsForAnalysis(family, owner, stateSnapshot);
    const members = listFamilyMembers(stateSnapshot, family.id);
    const policies = policiesForSalesReview(family, owner, stateSnapshot);
    const planningProfile = family.planningProfile || null;
    const familyReport = buildFamilyReport(policies, planningProfile, { familyId: family.id });
    const input = buildFamilySalesReviewInput({
      family, members, policies, familyReport, planningProfile,
      knowledgeRecords: stateSnapshot.knowledgeRecords || [], indicatorRecords: stateSnapshot.insuranceIndicatorRecords || [],
      optionalResponsibilityRecords: stateSnapshot.optionalResponsibilityRecords || [],
    });
    if (salesMemoryContext) input.salesMemoryContext = salesMemoryContext;
    if (salesChatContext) input.salesChatContext = salesChatContext;
    const review = await generateFamilySalesReview({ input });
    const ownership = ownerFields(owner);
    const now = nowIso();
    const record = {
      id: allocateId(stateSnapshot), familyId: Number(family.id), ownerUserId: ownership.ownerUserId, ownerGuestId: ownership.ownerGuestId,
      status: 'active', content: review.content, model: review.model, generatedAt: review.generatedAt || now, createdAt: now, updatedAt: now,
      inputSummary: { ...(review.inputSummary || {}), familyId: Number(family.id) },
    };
    stateSnapshot.familySalesReviews = Array.isArray(stateSnapshot.familySalesReviews) ? stateSnapshot.familySalesReviews : [];
    if (stateSnapshot === state) archiveSalesReviewForFamily(family.id, owner);
    else for (const existing of stateSnapshot.familySalesReviews) {
      if (Number(existing?.familyId) === Number(family.id) && Number(existing?.ownerUserId || 0) === Number(ownership.ownerUserId || 0) && String(existing?.status || 'active') === 'active') existing.status = 'archived';
    }
    stateSnapshot.familySalesReviews.push(record);
    await persistFamilyState(stateSnapshot);
    return record;
  }

  return { regenerateCoverage, regenerateSalesReview };
}
