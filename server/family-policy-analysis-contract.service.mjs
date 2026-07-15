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

const VERSION_FACT_KEYS = new Set([
  'notes', 'relationLabel', 'role',
  ...PLANNING_FIELDS, 'status', 'value',
  'id', 'company', 'productName', 'annualPremium', 'coverageAmount', 'effectiveDate',
  'paymentPeriod', 'coveragePeriod', 'type', 'responsibilities', 'evidence',
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

function trim(value) {
  return String(value ?? '').trim();
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
    }
    const group = groups.get(key);
    const status = trim(indicator?.status || indicator?.indicatorStatus || 'confirmed');
    if (status === 'confirmed') {
      group.confirmedItems.push(compactConfirmedItem(indicator));
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
      relationLabel: member.relationLabel || '',
      role: member.role || '',
      notes: member.notes || '',
    })),
    planningProfile: versionFacts(input.planningProfile || {}),
    policies: (Array.isArray(input.policies) ? input.policies : []).map(versionFacts),
    groupedCoverageIndicators: (Array.isArray(input.groupedCoverageIndicators)
      ? input.groupedCoverageIndicators : []).map(versionFacts),
    evidenceReferences: (Array.isArray(input.evidenceReferences) ? input.evidenceReferences : []).map(versionFacts),
  };
  const json = JSON.stringify(canonicalize(versionInput));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}
