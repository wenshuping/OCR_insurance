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

const EXCLUDED_VERSION_KEYS = new Set([
  'createdAt', 'updatedAt', 'generatedAt', 'sourceUpdatedAt',
  'ownerUserId', 'userId', 'idNumber', 'idNumberTail', 'phone', 'mobile', 'email',
  'birthday', 'applicant', 'insured',
  'salesMemory', 'salesMemoryContext', 'salesChat', 'salesChatContext',
  'uiState', 'uiExpanded', 'selected', 'expanded',
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

function versionSafe(value) {
  if (Array.isArray(value)) return value.map(versionSafe);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !EXCLUDED_VERSION_KEYS.has(key))
    .map(([key, child]) => [key, versionSafe(child)]));
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
  const versionInput = versionSafe({
    family: { notes: input.family?.notes || '' },
    members: (Array.isArray(input.members) ? input.members : []).map((member) => ({
      relationLabel: member.relationLabel || '',
      role: member.role || '',
      notes: member.notes || '',
    })),
    planningProfile: input.planningProfile || {},
    policies: input.policies || [],
    groupedCoverageIndicators: input.groupedCoverageIndicators || [],
    evidenceReferences: input.evidenceReferences || [],
  });
  const json = JSON.stringify(canonicalize(versionInput));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}
