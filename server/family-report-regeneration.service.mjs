export function createFamilyReportRegenerationService(deps = {}) {
  const {
    state, allocateId, listFamilyMembers, policiesForFamilyReport, policiesForSalesReview,
    repairFamilyMembersBeforeReview, refreshFamilyCashflowsForAnalysis, buildFamilyReport,
    createFamilyReportRecord, appendDeepSeekReportIssues, refreshFamilyReportWithTrustedCorrections,
    buildFamilySalesReviewInput, generateFamilySalesReview, archiveSalesReviewForFamily,
    ownerFields, persistFamilyReportState, persistFamilyState, nowIso = () => new Date().toISOString(),
  } = deps;

  async function regenerateCoverage({ family, owner, planningProfile = null } = {}) {
    await repairFamilyMembersBeforeReview(family);
    refreshFamilyCashflowsForAnalysis(family, owner);
    const members = listFamilyMembers(state, family.id);
    const policies = policiesForFamilyReport(family, owner);
    const report = buildFamilyReport(policies, planningProfile, { familyId: family.id });
    const { record } = createFamilyReportRecord({ state, family, owner, members, policies, report, planningProfile, allocateId });
    await appendDeepSeekReportIssues({ record, family, members, policies, report: record.report, planningProfile });
    refreshFamilyReportWithTrustedCorrections({ record, family, owner, members, policies });
    await persistFamilyReportState();
    return record;
  }

  async function regenerateSalesReview({ family, owner, salesChatContext = null, salesMemoryContext = null } = {}) {
    await repairFamilyMembersBeforeReview(family);
    refreshFamilyCashflowsForAnalysis(family, owner);
    const members = listFamilyMembers(state, family.id);
    const policies = policiesForSalesReview(family, owner);
    const planningProfile = family.planningProfile || null;
    const familyReport = buildFamilyReport(policies, planningProfile, { familyId: family.id });
    const input = buildFamilySalesReviewInput({
      family, members, policies, familyReport, planningProfile,
      knowledgeRecords: state.knowledgeRecords || [], indicatorRecords: state.insuranceIndicatorRecords || [],
      optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
    });
    if (salesMemoryContext) input.salesMemoryContext = salesMemoryContext;
    if (salesChatContext) input.salesChatContext = salesChatContext;
    const review = await generateFamilySalesReview({ input });
    const ownership = ownerFields(owner);
    const now = nowIso();
    const record = {
      id: allocateId(state), familyId: Number(family.id), ownerUserId: ownership.ownerUserId, ownerGuestId: ownership.ownerGuestId,
      status: 'active', content: review.content, model: review.model, generatedAt: review.generatedAt || now, createdAt: now, updatedAt: now,
      inputSummary: { ...(review.inputSummary || {}), familyId: Number(family.id) },
    };
    state.familySalesReviews = Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [];
    archiveSalesReviewForFamily(family.id, owner);
    state.familySalesReviews.push(record);
    await persistFamilyState();
    return record;
  }

  return { regenerateCoverage, regenerateSalesReview };
}
