function trimText(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim();
}

// Kept here as the public context-selection entry point for callers that build
// sales context without invoking the chat provider.
export { selectSalesTopicPack } from './family-sales-chat.service.mjs';

function policyRef(policy = {}) {
  return trimText(policy.policyRef) || `policy:${policy.id}`;
}

function findingPolicyRefs(findings = {}) {
  const refs = new Set(findings?.evidenceRefs?.policies || []);
  for (const collection of [findings?.priorityFindings, findings?.memberFindings, findings?.verificationItems]) {
    for (const item of Array.isArray(collection) ? collection : []) {
      for (const ref of Array.isArray(item?.policyRefs) ? item.policyRefs : []) refs.add(trimText(ref));
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

function finiteAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function allowedAmountFacts(policyIndex = [], findings = {}) {
  const facts = [];
  for (const policy of policyIndex) {
    for (const [kind, label, value] of [
      ['coverageAmount', '保额', policy.coverageAmount],
      ['annualPremium', '年交保费', policy.annualPremium],
    ]) {
      const amount = finiteAmount(value);
      if (amount !== null && amount > 0) facts.push({ kind, label, amount, policyRef: policy.policyRef });
    }
  }
  for (const fact of Array.isArray(findings?.confirmedFacts) ? findings.confirmedFacts : []) {
    const amount = finiteAmount(fact?.amount ?? fact?.value);
    const unit = trimText(fact?.unit);
    if (amount === null || amount <= 0 || (unit && !/元|万/u.test(unit))) continue;
    facts.push({
      kind: 'expertConfirmedAmount',
      label: trimText(fact.label ?? fact.title ?? fact.name ?? fact.itemName) || '专家确认金额',
      amount: unit && /^万/u.test(unit) ? amount * 10_000 : amount,
      factRef: trimText(fact.id),
    });
  }
  return facts;
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
  const policyIndex = selectedPolicies.map((policy) => ({
    policyRef: policyRef(policy),
    company: trimText(policy.company),
    productName: trimText(policy.name ?? policy.productName),
    insuredMemberRef: memberRefs.get(Number(policy.insuredMemberId || 0)) || '',
    validityStatus: trimText(policy.validityStatus ?? policy.status),
    coverageAmount: policy.amount ?? null,
    annualPremium: policy.firstPremium ?? policy.annualPremium ?? null,
  }));
  return {
    generatedAt,
    expertReportId: expertReport.id ?? null,
    expertInputVersion: trimText(expertReport.expertInputVersion) || '',
    family: {
      coreMemberRef: memberRefs.get(Number(family.coreMemberId || 0)) || '',
      notes: trimText(family.notes),
      planningSummary: planningSummary(family),
    },
    members: activeMembers.map((member) => ({
      memberRef: memberRefs.get(Number(member.id)),
      relationLabel: trimText(member.relationLabel),
      role: trimText(member.role),
      notes: trimText(member.notes),
      age: member.age ?? null,
    })),
    policyIndex,
    allowedAmountFacts: allowedAmountFacts(policyIndex, findings),
    expertFindings: findings,
    ...(salesMemoryContext ? { salesMemoryContext } : {}),
    ...(salesChatContext ? { salesChatContext } : {}),
  };
}
