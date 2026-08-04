import { buildExpertBackedSalesReviewContext } from './family-sales-context.service.mjs';

function completeStructuredExpertReport(report = null) {
  return Boolean(report && ['complete', 'completed', 'ready', 'success'].includes(String(report.status || '').toLowerCase())
    && report.structuredResult && typeof report.structuredResult === 'object' && String(report.expertInputVersion || '').trim());
}

function sectionItems(content, headingPattern, limit) {
  const source = String(content || '');
  const match = source.match(new RegExp(`^##[^\\n]*(?:${headingPattern})[^\\n]*\\n([\\s\\S]*?)(?=^##|(?![\\s\\S]))`, 'mu'));
  if (!match) return [];
  return match[1].split('\n').map((line) => line.replace(/^\s*[-*\d.、]+\s*/u, '').trim()).filter(Boolean).slice(0, limit);
}

function normalizedStrings(candidate, fallback = [], limit = 3) {
  const source = Array.isArray(candidate) ? candidate : fallback;
  return [...new Set(source.map((item) => String(item ?? '').trim()).filter(Boolean))].slice(0, limit);
}

function normalizedRefs(candidate = {}, allowed = {}) {
  return Object.fromEntries(['facts', 'indicators', 'policies'].map((key) => {
    const allowedRefs = new Set(normalizedStrings(allowed[key], [], Number.MAX_SAFE_INTEGER));
    return [key, normalizedStrings(candidate?.[key], [], Number.MAX_SAFE_INTEGER).filter((ref) => allowedRefs.has(ref))];
  }));
}

function buildStructuredSalesSummary(content = '', expertFindings = {}, candidate = {}) {
  const extracted = {
    conclusion: sectionItems(content, '销售结论摘要', 1)[0] || String(expertFindings.summary || '').trim(),
    verificationItems: sectionItems(content, '核实', 3),
    coverageConcerns: sectionItems(content, '保障缺口|保障关注点', 3),
    salesOpportunities: sectionItems(content, '销售机会|交叉销售', 3),
    meetingObjective: sectionItems(content, '面谈', 1)[0] || '',
    nextActions: sectionItems(content, '下一步销售动作', 3),
  };
  return {
    conclusion: String(candidate?.conclusion ?? '').trim() || extracted.conclusion,
    verificationItems: normalizedStrings(candidate?.verificationItems, extracted.verificationItems),
    coverageConcerns: normalizedStrings(candidate?.coverageConcerns, extracted.coverageConcerns),
    salesOpportunities: normalizedStrings(candidate?.salesOpportunities, extracted.salesOpportunities),
    meetingObjective: String(candidate?.meetingObjective ?? '').trim() || extracted.meetingObjective,
    nextActions: normalizedStrings(candidate?.nextActions, extracted.nextActions),
    refs: normalizedRefs(candidate?.refs || expertFindings.evidenceRefs, expertFindings.evidenceRefs),
  };
}

function stableBusinessSnapshot({ family, members, policies, expertReport }) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().filter((key) => !['createdAt', 'updatedAt', 'generatedAt'].includes(key)).map((key) => [key, canonical(value[key])]));
  };
  const memberFacts = (members || []).map((member) => Object.fromEntries([
    'id', 'name', 'relationLabel', 'relationToCore', 'role', 'birthday', 'notes', 'status',
  ].map((key) => [key, member?.[key]])));
  const policyFacts = (policies || []).map((policy) => Object.fromEntries([
    'id', 'company', 'name', 'productName', 'applicant', 'applicantMemberId', 'applicantMemberName',
    'insured', 'insuredMemberId', 'insuredMemberName', 'premium', 'annualPremium', 'firstPremium',
    'amount', 'coverage', 'effectiveDate', 'paymentPeriod', 'payPeriod', 'coveragePeriod',
    'insurancePeriod', 'status', 'policyStatus', 'policyState', 'contractStatus', 'validityStatus',
    'type', 'category', 'responsibilities', 'coverageIndicators',
  ].map((key) => [key, policy?.[key]])));
  return JSON.stringify(canonical({
    family: { id: family?.id, notes: family?.notes, planningProfile: family?.planningProfile },
    members: memberFacts, policies: policyFacts,
    expertReport: { id: expertReport?.id, expertInputVersion: expertReport?.expertInputVersion },
  }));
}

function inputDriftError() {
  const error = new Error('Family sales inputs changed during generation');
  error.code = 'FAMILY_SALES_INPUT_DRIFT';
  error.status = 409;
  return error;
}

function boundExpertReport(record, fallback) {
  if (!record) return fallback;
  const nested = record?.report?.familyPolicyAnalysisReport;
  return nested ? { ...nested, id: record.id ?? nested.id ?? null } : record;
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
  const salesReviewInFlight = new Map();
  const salesReviewLocks = new Map();

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

  async function regenerateSalesReviewOnce({ family, owner, salesChatContext = null, salesMemoryContext = null, stateSnapshot = state } = {}) {
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
    const sourceSnapshot = stableBusinessSnapshot({ family, members, policies, expertReport });
    const input = buildExpertBackedSalesReviewContext({
      family, members, policies, expertReport, salesMemoryContext, salesChatContext, generatedAt: nowIso(),
    });
    const review = await generateFamilySalesReview({ input });
    const currentExpertRecord = boundExpertReport(
      typeof getExpertReportRecord === 'function' ? getExpertReportRecord(family, owner, stateSnapshot) : null,
      expertReport,
    );
    const currentSnapshot = stableBusinessSnapshot({
      family,
      members: listFamilyMembers(stateSnapshot, family.id),
      policies: policiesForSalesReview(family, owner, stateSnapshot),
      expertReport: currentExpertRecord,
    });
    if (currentSnapshot !== sourceSnapshot) throw inputDriftError();
    const ownership = ownerFields(owner);
    const now = nowIso();
    const record = {
      id: allocateId(stateSnapshot), familyId: Number(family.id), ownerUserId: ownership.ownerUserId, ownerGuestId: ownership.ownerGuestId,
      status: 'active', content: review.content, model: review.model, generatedAt: review.generatedAt || now, createdAt: now, updatedAt: now,
      inputSummary: { ...(review.inputSummary || {}), familyId: Number(family.id) },
      expertReportId: expertReport.id,
      expertInputVersion: expertReport.expertInputVersion,
      structuredSummary: buildStructuredSalesSummary(review.content, expertReport.structuredResult, review.structuredSummary),
    };
    const hadReviews = Array.isArray(stateSnapshot.familySalesReviews);
    stateSnapshot.familySalesReviews = hadReviews ? stateSnapshot.familySalesReviews : [];
    const reviews = stateSnapshot.familySalesReviews;
    const previousReviews = [...reviews];
    const previousMetadata = new Map(previousReviews.map((existing) => [existing, {
      status: existing?.status,
      updatedAt: existing?.updatedAt,
    }]));
    if (stateSnapshot === state) archiveSalesReviewForFamily(family.id, owner);
    else for (const existing of reviews) {
      const sameOwner = Number(ownership.ownerUserId || 0)
        ? Number(existing?.ownerUserId || 0) === Number(ownership.ownerUserId) && !String(existing?.ownerGuestId || '').trim()
        : !Number(existing?.ownerUserId || 0) && String(existing?.ownerGuestId || '').trim() === String(ownership.ownerGuestId || '').trim();
      if (Number(existing?.familyId) === Number(family.id) && sameOwner && String(existing?.status || 'active') === 'active') existing.status = 'archived';
    }
    reviews.push(record);
    try {
      await persistFamilyState(stateSnapshot);
    } catch (error) {
      for (const [existing, metadata] of previousMetadata) {
        if (metadata.status === undefined) delete existing.status;
        else existing.status = metadata.status;
        if (metadata.updatedAt === undefined) delete existing.updatedAt;
        else existing.updatedAt = metadata.updatedAt;
      }
      reviews.splice(0, reviews.length, ...previousReviews);
      if (!hadReviews) delete stateSnapshot.familySalesReviews;
      throw error;
    }
    return record;
  }

  function regenerateSalesReview(request = {}) {
    const familyId = Number(request.family?.id || 0);
    const ownerKey = Number(request.owner?.userId || 0)
      ? `user:${Number(request.owner.userId)}`
      : `guest:${String(request.owner?.guestId || '').trim()}`;
    const lockKey = `${ownerKey}|family:${familyId}`;
    const inputKey = `${lockKey}|${JSON.stringify([request.salesChatContext || null, request.salesMemoryContext || null])}`;
    if (salesReviewInFlight.has(inputKey)) return salesReviewInFlight.get(inputKey);
    const previous = salesReviewLocks.get(lockKey) || Promise.resolve();
    const work = previous.catch(() => {}).then(() => regenerateSalesReviewOnce(request));
    salesReviewInFlight.set(inputKey, work);
    salesReviewLocks.set(lockKey, work);
    work.finally(() => {
      if (salesReviewInFlight.get(inputKey) === work) salesReviewInFlight.delete(inputKey);
      if (salesReviewLocks.get(lockKey) === work) salesReviewLocks.delete(lockKey);
    }).catch(() => {});
    return work;
  }

  return { regenerateCoverage, regenerateSalesReview };
}
