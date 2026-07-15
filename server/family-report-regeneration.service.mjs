import { buildExpertBackedSalesReviewContext } from './family-sales-context.service.mjs';

function completeStructuredExpertReport(report = null) {
  return Boolean(report && ['complete', 'completed', 'ready', 'success'].includes(String(report.status || '').toLowerCase())
    && report.structuredResult && typeof report.structuredResult === 'object' && String(report.expertInputVersion || '').trim());
}

function sectionItems(content, headingPattern, limit) {
  const source = String(content || '');
  const match = source.match(new RegExp(`^##[^\\n]*(?:${headingPattern})[^\\n]*\\n([\\s\\S]*?)(?=^##|$)`, 'mu'));
  if (!match) return [];
  return match[1].split('\n').map((line) => line.replace(/^\s*[-*\d.、]+\s*/u, '').trim()).filter(Boolean).slice(0, limit);
}

function buildStructuredSalesSummary(content = '', expertFindings = {}) {
  const conclusion = sectionItems(content, '销售结论摘要', 1)[0] || String(expertFindings.summary || '').trim();
  const verificationItems = sectionItems(content, '核实', 3);
  const coverageConcerns = sectionItems(content, '保障缺口|保障关注点', 3);
  const salesOpportunities = sectionItems(content, '销售机会|交叉销售', 3);
  const meetingObjective = sectionItems(content, '面谈', 1)[0] || '';
  const nextActions = sectionItems(content, '下一步销售动作', 3);
  return { conclusion, verificationItems, coverageConcerns, salesOpportunities, meetingObjective, nextActions, refs: expertFindings.evidenceRefs || {} };
}

export function createFamilyReportRegenerationService(deps = {}) {
  const {
    state, allocateId, listFamilyMembers, policiesForFamilyReport, policiesForSalesReview,
    repairFamilyMembersBeforeReview, refreshFamilyCashflowsForAnalysis, buildFamilyReport,
    createFamilyReportRecord, appendDeepSeekReportIssues, refreshFamilyReportWithTrustedCorrections,
    buildFamilyPolicyAnalysisInput,
    generateFamilySalesReview, archiveSalesReviewForFamily,
    ownerFields, persistFamilyReportState, persistFamilyState, familyPolicyAnalysisOrchestrator,
    getExpertReportRecord, nowIso = () => new Date().toISOString(),
  } = deps;

  async function regenerateCoverage({ family, owner, planningProfile = null, stateSnapshot = state, system = false } = {}) {
    await repairFamilyMembersBeforeReview(family, { stateSnapshot });
    refreshFamilyCashflowsForAnalysis(family, owner, stateSnapshot);
    const members = listFamilyMembers(stateSnapshot, family.id);
    const policies = policiesForFamilyReport(family, owner, stateSnapshot);
    const report = buildFamilyReport(policies, planningProfile, { familyId: family.id });
    const expertInputVersion = buildFamilyPolicyAnalysisInput({
      family,
      members,
      policies,
      familyReport: report,
      planningProfile,
      knowledgeRecords: stateSnapshot.knowledgeRecords || [],
      indicatorRecords: stateSnapshot.insuranceIndicatorRecords || [],
      optionalResponsibilityRecords: stateSnapshot.optionalResponsibilityRecords || [],
    }).expertInputVersion;
    const { record } = createFamilyReportRecord({
      state: stateSnapshot, family, owner, members, policies, report, planningProfile, expertInputVersion, allocateId, allowEmptyPolicies: system,
    });
    if (stateSnapshot === state) {
      await appendDeepSeekReportIssues({ record, family, members, policies, report: record.report, planningProfile });
      refreshFamilyReportWithTrustedCorrections({ record, family, owner, members, policies });
    }
    await persistFamilyReportState(stateSnapshot);
    return record;
  }

  async function regenerateSalesReview({ family, owner, salesChatContext = null, salesMemoryContext = null, stateSnapshot = state } = {}) {
    await repairFamilyMembersBeforeReview(family, { stateSnapshot });
    refreshFamilyCashflowsForAnalysis(family, owner, stateSnapshot);
    if (typeof getExpertReportRecord === 'function' && !getExpertReportRecord(family, owner, stateSnapshot)) {
      await regenerateCoverage({ family, owner, planningProfile: family.planningProfile || null, stateSnapshot, system: true });
    }
    const members = listFamilyMembers(stateSnapshot, family.id);
    const policies = policiesForSalesReview(family, owner, stateSnapshot);
    if (typeof familyPolicyAnalysisOrchestrator?.ensureFresh !== 'function') throw new Error('FAMILY_POLICY_ANALYSIS_ORCHESTRATOR_REQUIRED');
    const ensuredReport = await familyPolicyAnalysisOrchestrator.ensureFresh({ family, owner, explicitRefresh: false });
    if (!completeStructuredExpertReport(ensuredReport)) throw new Error('FAMILY_POLICY_ANALYSIS_STRUCTURED_RESULT_REQUIRED');
    const expertRecord = typeof getExpertReportRecord === 'function' ? getExpertReportRecord(family, owner, stateSnapshot) : null;
    const expertReport = { ...ensuredReport, id: expertRecord?.id ?? ensuredReport.id ?? null };
    const input = buildExpertBackedSalesReviewContext({
      family, members, policies, expertReport, salesMemoryContext, salesChatContext, generatedAt: nowIso(),
    });
    const review = await generateFamilySalesReview({ input });
    const ownership = ownerFields(owner);
    const now = nowIso();
    const record = {
      id: allocateId(stateSnapshot), familyId: Number(family.id), ownerUserId: ownership.ownerUserId, ownerGuestId: ownership.ownerGuestId,
      status: 'active', content: review.content, model: review.model, generatedAt: review.generatedAt || now, createdAt: now, updatedAt: now,
      inputSummary: { ...(review.inputSummary || {}), familyId: Number(family.id) },
      expertReportId: expertReport.id,
      expertInputVersion: expertReport.expertInputVersion,
      structuredSummary: review.structuredSummary || buildStructuredSalesSummary(review.content, expertReport.structuredResult),
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
