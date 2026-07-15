import { createHash } from 'node:crypto';

const PLANNING_FIELDS = [
  'annualIncome',
  'annualExpense',
  'debt',
  'educationGoal',
  'parentSupportGoal',
  'availableAssets',
  'premiumBudget',
];

const STATUS_ITEM_KEYS = {
  not_found_in_recorded_policies: 'notFoundInRecordedPoliciesItems',
  not_identified: 'notIdentifiedItems',
  conflicted: 'conflictedItems',
  missing_source: 'missingSourceItems',
  not_applicable: 'notApplicableItems',
};

const FINDING_ASSESSMENTS = new Set([
  'confirmed_gap',
  'likely_insufficient',
  'needs_verification',
  'currently_reasonable',
]);

const VERSION_FACT_KEYS = new Set([
  'notes', 'relationLabel', 'role', 'birthday',
  ...PLANNING_FIELDS, 'status', 'value',
  'id', 'company', 'productName', 'annualPremium', 'coverageAmount', 'effectiveDate',
  'paymentPeriod', 'coveragePeriod', 'type', 'applicant', 'insured', 'responsibilities', 'evidence',
  'name', 'amount', 'condition', 'payout',
  'knowledgeEvidence', 'indicatorEvidence', 'optionalResponsibilityEvidence', 'policySourceEvidence',
  'productType', 'title', 'official', 'sourceKind', 'evidenceLevel', 'verificationStatus',
  'verificationLabel', 'referenceOnly', 'url', 'excerpt', 'coverageType', 'liability',
  'formulaText', 'unit', 'responsibilityScope', 'selectionStatus', 'quantificationStatus',
  'sourceUrl', 'sourceExcerpt',
  'memberRef', 'category', 'confirmedItems', 'notFoundInRecordedPoliciesItems',
  'notIdentifiedItems', 'conflictedItems', 'missingSourceItems', 'notApplicableItems', 'itemName',
  'evidenceReferences', 'policyRef',
]);

const REPORT_FACT_KEYS = new Set([
  'memberCount', 'policyCount', 'issueCount', 'annualPremium', 'totalCoverage', 'cashValueTotal',
  'futurePayoutTotal',
  'family', 'members', 'hiddenMembers', 'scores', 'member', 'name', 'relationLabel', 'role',
  'rows', 'key', 'label', 'amount', 'amountText', 'countText', 'status', 'conditionText',
  'sourcePolicies', 'sourcePolicyRefs', 'attentionItems', 'notes', 'gap', 'formulaText', 'liabilities',
  'score', 'effectiveAmount', 'effectiveAmountText', 'coveragePresent', 'policyCount',
  'adequacyRate', 'adequacyText', 'target', 'targetText', 'targetSource', 'gapText', 'note', 'amountDetails',
  'applicant', 'company', 'productName', 'typeLabel', 'coverageText', 'annualPremiumText',
  'coveragePeriod', 'paymentPeriod', 'policyStatusText', 'dataStatus',
  'memberReports', 'policies', 'policyRef', 'policyId', 'conclusion', 'cashflowRows',
  'annualCashflowRows', 'cashValueRows', 'aggregateRows', 'year', 'calendarYear', 'policyYear',
  'age', 'cashValueDate', 'cashValueDateLabel', 'premiumOutflow', 'payoutInflow',
  'cashValue', 'cashValueTime', 'cashValueReferenceType', 'cashValueIsNonAdditiveReference',
  'cashValueIsPreMaturityReference', 'cashValueNote', 'cashValueIncrease',
  'netCashflow', 'cumulativeNetCashflow', 'cumulativePayoutInflow',
  'cashValueTotal', 'totalValue', 'cumulative', 'liability', 'calculationText', 'details', 'type',
  'keyPoints', 'uncertaintyItems', 'uncertaintyNote', 'hasUncertainWealthFactors',
  'excludedCashflowRows', 'excludedCashValueRows', 'excludedPolicies', 'statisticsScopeNote',
  'value', 'unit', 'increase', 'reason', 'reasons', 'policyholder', 'isMaturityPayout',
  'isContractTerminatingPayout',
]);

function trim(value) {
  return String(value ?? '').trim();
}

function invalidResult(message) {
  const error = new Error(message);
  error.code = 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT';
  error.status = 502;
  return error;
}

function referenceIds(items) {
  if (!Array.isArray(items)) return new Set();
  return new Set(items.map((item) => trim(typeof item === 'object' ? item?.id : item)).filter(Boolean));
}

function findingRefs(finding, key) {
  if (!Array.isArray(finding?.[key])) throw invalidResult(`priority finding ${key} must be an array`);
  return finding[key].map(trim).filter(Boolean);
}

export function parseFamilyPolicyAnalysisEnvelope(rawContent, expectedVersion) {
  let envelope;
  try {
    envelope = JSON.parse(trim(rawContent));
  } catch {
    throw invalidResult('family policy analysis result must be valid JSON');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw invalidResult('family policy analysis envelope is required');
  if (!trim(envelope.markdownContent)) throw invalidResult('markdownContent is required');
  if (!trim(expectedVersion) || trim(envelope.expertInputVersion) !== trim(expectedVersion)) throw invalidResult('expertInputVersion mismatch');

  const result = envelope.structuredResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalidResult('structuredResult is required');
  for (const key of ['summary', 'priorityFindings', 'confirmedFacts', 'verificationItems', 'memberFindings', 'evidenceRefs', 'dataQualityWarnings']) {
    if (!(key in result)) throw invalidResult(`structuredResult.${key} is required`);
  }
  for (const key of ['priorityFindings', 'confirmedFacts', 'verificationItems', 'memberFindings', 'dataQualityWarnings']) {
    if (!Array.isArray(result[key])) throw invalidResult(`structuredResult.${key} must be an array`);
  }
  if (!result.evidenceRefs || typeof result.evidenceRefs !== 'object' || Array.isArray(result.evidenceRefs)) throw invalidResult('structuredResult.evidenceRefs must be an object');

  const validRefs = {
    confirmedFactRefs: referenceIds(result.evidenceRefs.facts || result.confirmedFacts),
    indicatorRefs: referenceIds(result.evidenceRefs.indicators),
    policyRefs: referenceIds(result.evidenceRefs.policies),
  };
  for (const memberFinding of result.memberFindings) {
    if (memberFinding?.assessment !== undefined && !FINDING_ASSESSMENTS.has(memberFinding.assessment)) {
      throw invalidResult('member finding assessment is invalid');
    }
  }
  for (const finding of result.priorityFindings) {
    if (!finding || typeof finding !== 'object') throw invalidResult('priority finding must be an object');
    for (const key of ['memberRef', 'category', 'finding', 'assessment', 'confidence']) {
      if (!trim(finding[key])) throw invalidResult(`priority finding ${key} is required`);
    }
    if (!Array.isArray(finding.missingInformation) || !('nextVerification' in finding)) {
      throw invalidResult('priority finding verification fields are required');
    }
    if (!FINDING_ASSESSMENTS.has(finding.assessment)) throw invalidResult('priority finding assessment is invalid');
    const refs = Object.fromEntries(Object.keys(validRefs).map((key) => [key, findingRefs(finding, key)]));
    for (const [key, ids] of Object.entries(refs)) {
      if (ids.some((id) => !validRefs[key].has(id))) throw invalidResult(`priority finding contains invalid ${key}`);
    }
    const hasEvidence = Object.values(refs).some((ids) => ids.length);
    const hasVerification = trim(finding.nextVerification)
      || (Array.isArray(finding.missingInformation) && finding.missingInformation.some((item) => trim(item)));
    if (!hasEvidence && !(finding.assessment === 'needs_verification' && hasVerification)) {
      throw invalidResult('priority finding must reference evidence');
    }
  }
  return envelope;
}

function itemName(indicator = {}) {
  return trim(indicator.itemName || indicator.liability || indicator.name || indicator.title || indicator.coverageType);
}

function compactConfirmedItem(indicator = {}) {
  const item = { itemName: itemName(indicator) };
  for (const key of ['value', 'unit', 'amount', 'formulaText', 'responsibilityScope']) {
    const value = indicator[key];
    if (value !== undefined && value !== null && value !== '') item[key] = value;
  }
  return item;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function versionFacts(value) {
  if (Array.isArray(value)) return value.map(versionFacts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => VERSION_FACT_KEYS.has(key))
    .map(([key, child]) => [key, versionFacts(child)]));
}

function reportValueFacts(value) {
  if (Array.isArray(value)) return value.map(reportValueFacts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => REPORT_FACT_KEYS.has(key))
    .map(([key, child]) => [key, reportValueFacts(child)]));
}

function reportVersionFacts(report = {}) {
  return {
    summary: reportValueFacts(report.summary || {}),
    radar: reportValueFacts(report.radar || {}),
    inventoryRows: reportValueFacts(report.inventoryRows || []),
    criticalIllness: reportValueFacts(report.criticalIllness || {}),
    accident: reportValueFacts(report.accident || {}),
    wealth: reportValueFacts(report.wealth || {}),
  };
}

export function buildExpertPlanningProfile(planning = {}) {
  return Object.fromEntries(PLANNING_FIELDS.map((key) => {
    const raw = planning?.[key];
    const missing = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    const number = Number(raw);
    return [key, missing || !Number.isFinite(number)
      ? { status: 'unknown', value: null }
      : { status: 'confirmed', value: number }];
  }));
}

export function groupExpertCoverageIndicators(indicators = []) {
  const groups = new Map();
  const confirmedKeys = new Map();
  for (const indicator of Array.isArray(indicators) ? indicators : []) {
    const memberRef = trim(indicator?.memberRef);
    const category = trim(indicator?.category || indicator?.coverageCategory || indicator?.coverageType);
    const key = `${memberRef}\u001f${category}`;
    if (!groups.has(key)) {
      groups.set(key, {
        memberRef,
        category,
        confirmedItems: [],
        notFoundInRecordedPoliciesItems: [],
        notIdentifiedItems: [],
        conflictedItems: [],
        missingSourceItems: [],
        notApplicableItems: [],
      });
      confirmedKeys.set(key, new Set());
    }
    const group = groups.get(key);
    const status = trim(indicator?.status || indicator?.indicatorStatus || 'confirmed');
    if (status === 'confirmed') {
      const item = compactConfirmedItem(indicator);
      if (!item.itemName) continue;
      const semanticKey = JSON.stringify(canonicalize(item));
      if (!confirmedKeys.get(key).has(semanticKey)) {
        confirmedKeys.get(key).add(semanticKey);
        group.confirmedItems.push(item);
      }
      continue;
    }
    const target = STATUS_ITEM_KEYS[status];
    const name = itemName(indicator);
    if (target && name && !group[target].includes(name)) group[target].push(name);
  }
  return [...groups.values()];
}

export function computeExpertInputVersion(input = {}) {
  const versionInput = {
    family: { notes: input.family?.notes || '' },
    members: (Array.isArray(input.members) ? input.members : []).map((member) => ({
      name: member.name || '',
      birthday: member.birthday || '',
      relationLabel: member.relationLabel || '',
      role: member.role || '',
      notes: member.notes || '',
    })),
    planningProfile: versionFacts(input.planningProfile || {}),
    policies: (Array.isArray(input.policies) ? input.policies : []).map(versionFacts),
    groupedCoverageIndicators: (Array.isArray(input.groupedCoverageIndicators)
      ? input.groupedCoverageIndicators : []).map(versionFacts),
    evidenceReferences: (Array.isArray(input.evidenceReferences) ? input.evidenceReferences : []).map(versionFacts),
    report: reportVersionFacts(input.report || {}),
  };
  const json = JSON.stringify(canonicalize(versionInput));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}
