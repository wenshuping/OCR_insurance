function trim(value) {
  return String(value || '').trim();
}

function policyRef(policy = {}) {
  return trim(policy.policyRef) || `policy:${policy.id}`;
}

function findingPolicyRefs(findings = {}) {
  const refs = new Set(findings?.evidenceRefs?.policies || []);
  for (const collection of [findings?.priorityFindings, findings?.memberFindings, findings?.verificationItems]) {
    for (const item of Array.isArray(collection) ? collection : []) {
      for (const ref of Array.isArray(item?.policyRefs) ? item.policyRefs : []) refs.add(trim(ref));
    }
  }
  refs.delete('');
  return refs;
}

function planningSummary(family = {}) {
  const profile = family.planningProfile || {};
  return Object.fromEntries([
    'annualIncome', 'annualExpense', 'debt', 'educationGoal', 'parentSupportGoal', 'availableAssets', 'premiumBudget',
  ].map((key) => [key, profile[key] === undefined ? null : profile[key]]));
}

export function buildExpertBackedSalesReviewContext({
  family = {}, members = [], policies = [], expertReport = {}, generatedAt = new Date().toISOString(),
  salesMemoryContext = null, salesChatContext = null,
} = {}) {
  const activeMembers = (Array.isArray(members) ? members : []).filter((member) => String(member?.status || 'active') === 'active');
  const memberRefs = new Map(activeMembers.map((member, index) => [Number(member.id), `{{member_${index + 1}}}`]));
  const findings = expertReport.structuredResult || {};
  const referenced = findingPolicyRefs(findings);
  const allPolicies = Array.isArray(policies) ? policies : [];
  const selectedPolicies = referenced.size
    ? allPolicies.filter((policy) => referenced.has(policyRef(policy)))
    : allPolicies.slice(0, 3);
  return {
    generatedAt,
    expertReportId: expertReport.id ?? null,
    expertInputVersion: trim(expertReport.expertInputVersion),
    family: {
      coreMemberRef: memberRefs.get(Number(family.coreMemberId || 0)) || '',
      notes: trim(family.notes),
      planningSummary: planningSummary(family),
    },
    members: activeMembers.map((member) => ({
      memberRef: memberRefs.get(Number(member.id)),
      relationLabel: trim(member.relationLabel),
      role: trim(member.role),
      notes: trim(member.notes),
    })),
    policyIndex: selectedPolicies.map((policy) => ({
      policyRef: policyRef(policy),
      company: trim(policy.company),
      productName: trim(policy.name || policy.productName),
      insuredMemberRef: memberRefs.get(Number(policy.insuredMemberId || 0)) || '',
      validityStatus: trim(policy.validityStatus || policy.status),
    })),
    expertFindings: findings,
    ...(salesMemoryContext ? { salesMemoryContext } : {}),
    ...(salesChatContext ? { salesChatContext } : {}),
  };
}
