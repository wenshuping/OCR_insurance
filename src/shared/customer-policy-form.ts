import type {
  Policy,
  PolicyAnalysisResult,
  PolicyFormData,
  PolicyScanResult,
} from '../api/contracts/policy';
import { shouldKeepPolicyPlan } from '../policy-plan-filter.mjs';
import type { OptionalResponsibility } from '../api/contracts/responsibility';
import {
  normalizeBeneficiaryValue,
  normalizePolicyPlanRoleLabel,
  policyPlanRoleOrder,
} from './formatters';

export const FAMILY_MEMBER_RELATION_OPTIONS = [
  '本人',
  '配偶',
  '儿子',
  '女儿',
  '孙子',
  '孙女',
  '外孙',
  '外孙女',
  '父亲',
  '母亲',
  '外公',
  '外婆',
  '爷爷',
  '奶奶',
  '其他',
  '待确认',
];
export const POLICY_RELATION_OPTIONS = ['本人', '子女', '父母', '夫妻'];

export function normalizePolicyPlanListWithIndex(
  plans: PolicyFormData['plans'] = [],
  company = '',
  options: { keepEmpty?: boolean; assignRolesByRecognizedOrder?: boolean } = {},
) {
  const keepEmpty = Boolean(options.keepEmpty);
  const assignRolesByRecognizedOrder = Boolean(options.assignRolesByRecognizedOrder);
  const normalizedPlans: Array<NonNullable<PolicyFormData['plans']>[number] & { __originalIndex: number }> = [];
  (Array.isArray(plans) ? plans : []).forEach((plan, index) => {
    const name = String(plan?.name || plan?.matchedProductName || '').trim();
    const matchedProductName = String(plan?.matchedProductName || '').trim();
    if (!name && !matchedProductName && !keepEmpty) return;
    if (!keepEmpty && !shouldKeepPolicyPlan(plan)) return;
    const benefitRows = (Array.isArray(plan?.benefitRows) ? plan.benefitRows : [])
      .map((row) => ({
        responsibilityName: String(row?.responsibilityName || ''),
        amountText: String(row?.amountText || ''),
        amount: row?.amount === undefined || row?.amount === null || row?.amount === '' ? '' : String(row.amount),
        premium: row?.premium === undefined || row?.premium === null || row?.premium === '' ? '' : String(row.premium),
        coveragePeriod: String(row?.coveragePeriod || ''),
        paymentMode: String(row?.paymentMode || ''),
        paymentPeriod: String(row?.paymentPeriod || ''),
        paymentBasis: String(row?.paymentBasis || ''),
        benefitStandard: String(row?.benefitStandard || ''),
        deductible: String(row?.deductible || ''),
        ratio: String(row?.ratio || ''),
        evidence: String(row?.evidence || ''),
      }))
      .filter((row) => Object.values(row).some(Boolean));
    normalizedPlans.push({
      __originalIndex: index,
      company: String(plan?.company || company || '').trim(),
      role: String(assignRolesByRecognizedOrder ? (plan?.role || (index === 0 ? 'main' : 'rider')) : plan?.role || (index === 0 ? 'main' : 'rider')),
      name: name || matchedProductName,
      matchedProductName,
      canonicalProductId: String(plan?.canonicalProductId || '').trim(),
      productType: String(plan?.productType || '').trim(),
      amount: plan?.amount ? String(plan.amount) : '',
      coveragePeriod: String(plan?.coveragePeriod || ''),
      paymentMode: String(plan?.paymentMode || ''),
      paymentPeriod: String(plan?.paymentPeriod || ''),
      premium: plan?.premium ? String(plan.premium) : '',
      premiumText: String(plan?.premiumText || ''),
      matchScore: Number(plan?.matchScore || 0) || 0,
      matchReason: String(plan?.matchReason || ''),
      ...(benefitRows.length ? { benefitRows } : {}),
    });
  });
  return normalizedPlans
    .sort((left, right) => policyPlanRoleOrder(left.role) - policyPlanRoleOrder(right.role) || left.__originalIndex - right.__originalIndex);
}

export function normalizePolicyPlanList(
  plans: PolicyFormData['plans'] = [],
  company = '',
  options: { keepEmpty?: boolean; assignRolesByRecognizedOrder?: boolean } = {},
) {
  return normalizePolicyPlanListWithIndex(plans, company, options)
    .map(({ __originalIndex, ...plan }) => plan) as NonNullable<PolicyFormData['plans']>;
}

function primaryPlanFromPolicyForm(form: PolicyFormData) {
  const plans = normalizePolicyPlanList(form.plans, form.company);
  return plans.find((plan) => plan.role === 'main') || plans[0] || null;
}

export function mainProductIdentityKey(form: PolicyFormData) {
  const primary = primaryPlanFromPolicyForm(form);
  if (!primary) return ['no-main', String(form.company || '').trim(), String(form.name || '').trim()].join('\u001f');
  return [
    String(primary.canonicalProductId || '').trim(),
    String(primary.matchedProductName || '').trim(),
    String(primary.company || form.company || '').trim(),
    String(primary.name || form.name || '').trim(),
  ].join('\u001f');
}

export function setMainPolicyPlanProduct(plans: PolicyFormData['plans'], company: string, name: string, canonicalProductId = '') {
  const normalizedPlans = normalizePolicyPlanList(plans, company, { keepEmpty: true });
  let updatedMain = false;
  const nextPlans = normalizedPlans.map((plan, index) => {
    const role = String(plan.role || (index === 0 ? 'main' : 'rider'));
    if (updatedMain || (role !== 'main' && index !== 0)) return plan;
    updatedMain = true;
    return {
      ...plan,
      company,
      role: 'main',
      name,
      matchedProductName: name,
      canonicalProductId,
    };
  });
  if (updatedMain) return nextPlans;
  return [
    {
      company,
      role: 'main',
      name,
      matchedProductName: name,
      canonicalProductId,
      productType: '',
      amount: '',
      coveragePeriod: '',
      paymentMode: '',
      paymentPeriod: '',
      premium: '',
      premiumText: '',
      matchScore: 0,
      matchReason: '',
    },
    ...nextPlans,
  ];
}

export function planProductDisplayName(plan: NonNullable<PolicyFormData['plans']>[number]) {
  return String(plan.matchedProductName || plan.name || '未命名险种');
}

export function policyToForm(policy: Policy): PolicyFormData {
  return {
    company: policy.company || '',
    name: policy.name || '',
    canonicalProductId: policy.canonicalProductId || '',
    applicant: policy.applicant || '',
    beneficiary: normalizeBeneficiaryValue(policy.beneficiary),
    applicantRelation: policy.applicantRelation || '',
    insured: policy.insured || '',
    insuredRelation: policy.insuredRelation || '',
    insuredIdNumber: policy.insuredIdNumber || '',
    insuredBirthday: policy.insuredBirthday || '',
    date: policy.date || '',
    paymentPeriod: policy.paymentPeriod || '',
    coveragePeriod: policy.coveragePeriod || '',
    amount: policy.amount ? String(policy.amount) : '',
    firstPremium: policy.firstPremium ? String(policy.firstPremium) : '',
    plans: normalizePolicyPlanList(policy.plans, policy.company),
    familyId: policy.familyId ?? null,
    applicantMemberId: policy.applicantMemberId ?? null,
    insuredMemberId: policy.insuredMemberId ?? null,
    familyName: policy.familyName || '',
    applicantMemberName: policy.applicantMemberName || '',
    applicantRelationLabel: policy.applicantRelationLabel || '',
    insuredMemberName: policy.insuredMemberName || '',
    insuredRelationLabel: policy.insuredRelationLabel || '',
  };
}

export function buildPolicyUpdateData(policy: Policy, data: PolicyFormData): PolicyFormData {
  const nextCompany = data.company.trim();
  const nextName = data.name.trim();
  const companyChanged = nextCompany !== String(policy.company || '').trim();
  const productChanged = nextName !== String(policy.name || '').trim();
  const plans = normalizePolicyPlanList(data.plans, nextCompany).map((plan, index) => {
    const role = String(plan.role || (index === 0 ? 'main' : 'rider'));
    if (role === 'main' || index === 0) {
      return {
        ...plan,
        company: nextCompany,
        name: productChanged ? nextName : plan.name,
        matchedProductName: productChanged ? '' : plan.matchedProductName,
        canonicalProductId: productChanged ? '' : plan.canonicalProductId,
      };
    }
    return {
      ...plan,
      company: companyChanged ? nextCompany : plan.company || nextCompany,
    };
  });
  return {
    ...data,
    company: nextCompany,
    name: nextName,
    canonicalProductId: productChanged ? '' : data.canonicalProductId,
    beneficiary: normalizeBeneficiaryValue(data.beneficiary),
    plans,
  };
}

export function scanToForm(scan: PolicyScanResult): PolicyFormData {
  const data = scan.data || {};
  const familyData = data as Partial<PolicyFormData>;
  return {
    company: String(data.company || ''),
    name: String(data.name || ''),
    canonicalProductId: String(data.canonicalProductId || ''),
    applicant: String(data.applicant || ''),
    beneficiary: normalizeBeneficiaryValue(data.beneficiary),
    applicantRelation: String(data.applicantRelation || ''),
    insured: String(data.insured || ''),
    insuredRelation: String(data.insuredRelation || ''),
    insuredIdNumber: String(data.insuredIdNumber || ''),
    insuredBirthday: String(data.insuredBirthday || ''),
    date: String(data.date || ''),
    paymentPeriod: String(data.paymentPeriod || ''),
    coveragePeriod: String(data.coveragePeriod || ''),
    amount: data.amount ? String(data.amount) : '',
    firstPremium: data.firstPremium ? String(data.firstPremium) : '',
    plans: normalizePolicyPlanList(data.plans, String(data.company || ''), { assignRolesByRecognizedOrder: true }),
    familyId: familyData.familyId ?? null,
    applicantMemberId: familyData.applicantMemberId ?? null,
    insuredMemberId: familyData.insuredMemberId ?? null,
  };
}

function canReuseParticipantValue(nextName: string, currentName: string) {
  const normalizedNextName = String(nextName || '').trim();
  const normalizedCurrentName = String(currentName || '').trim();
  return Boolean(normalizedNextName && normalizedCurrentName && normalizedNextName === normalizedCurrentName);
}

function canReuseParticipantMemberId(
  nextName: string,
  currentName: string,
  currentMemberId: number | null | undefined,
  currentMemberName: string | undefined,
) {
  if (!currentMemberId) return false;
  const normalizedCurrentMemberName = String(currentMemberName || '').trim();
  if (!canReuseParticipantValue(nextName, currentName)) return false;
  const normalizedCurrentName = String(currentName || '').trim();
  if (normalizedCurrentMemberName && normalizedCurrentMemberName !== normalizedCurrentName) return false;
  return true;
}

export function mergeScanToForm(scan: PolicyScanResult, current: PolicyFormData): PolicyFormData {
  const next = scanToForm(scan);
  const reuseApplicantFields = canReuseParticipantValue(next.applicant, current.applicant);
  const reuseInsuredFields = canReuseParticipantValue(next.insured, current.insured);
  return {
    ...next,
    beneficiary: next.beneficiary || current.beneficiary,
    applicantRelation: next.applicantRelation || (reuseApplicantFields ? current.applicantRelation : ''),
    insuredRelation: next.insuredRelation || (reuseInsuredFields ? current.insuredRelation : ''),
    insuredIdNumber: next.insuredIdNumber || (reuseInsuredFields ? current.insuredIdNumber : ''),
    insuredBirthday: next.insuredBirthday || (reuseInsuredFields ? current.insuredBirthday : ''),
    familyId: next.familyId ?? current.familyId ?? null,
    applicantMemberId: next.applicantMemberId ?? (
      canReuseParticipantMemberId(
        next.applicant,
        current.applicant,
        current.applicantMemberId,
        current.applicantMemberName,
      )
        ? current.applicantMemberId ?? null
        : null
    ),
    insuredMemberId: next.insuredMemberId ?? (
      canReuseParticipantMemberId(
        next.insured,
        current.insured,
        current.insuredMemberId,
        current.insuredMemberName,
      )
        ? current.insuredMemberId ?? null
        : null
    ),
  };
}

export function sanitizeAmount(value: string) {
  return value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
}

function hasRequiredText(value: unknown) {
  return Boolean(String(value || '').trim());
}

function hasPlanPremiumEvidence(plan: NonNullable<PolicyFormData['plans']>[number]) {
  return hasRequiredText(plan.premium) || /整单合计保费|保单未列逐险种保费/.test(String(plan.premiumText || ''));
}

function hasConfirmedRelation(value: unknown) {
  const relation = String(value || '').trim();
  return Boolean(relation && relation !== '待确认');
}

export function validatePolicyEntryForm(data: PolicyFormData) {
  const errors: string[] = [];
  const applicantRelation = String(data.applicantRelationLabel || data.applicantRelation || '').trim();
  const insuredRelation = String(data.insuredRelationLabel || data.insuredRelation || '').trim();

  if (!data.familyId) errors.push('选择家庭档案');
  if (!hasRequiredText(data.company)) errors.push('保险公司');
  if (!hasRequiredText(data.name)) errors.push('保险名称');
  if (!hasRequiredText(data.applicant)) errors.push('投保人姓名');
  if (!hasConfirmedRelation(applicantRelation)) errors.push('投保人与核心人员家庭关系');
  if (!hasRequiredText(data.insured)) errors.push('被保险人姓名');
  if (!hasConfirmedRelation(insuredRelation)) errors.push('被保险人与核心人员家庭关系');
  if (!hasRequiredText(data.beneficiary)) errors.push('受益人');
  if (!hasRequiredText(data.insuredBirthday)) errors.push('被保险人生日');
  if (!hasRequiredText(data.date)) errors.push('投保时间');
  if (!hasRequiredText(data.paymentPeriod)) errors.push('缴费期间');
  if (!hasRequiredText(data.coveragePeriod)) errors.push('保障期间');
  if (!hasRequiredText(data.amount)) errors.push('保额');
  if (!hasRequiredText(data.firstPremium)) errors.push('首期保费');

  const riderPlans = normalizePolicyPlanListWithIndex(data.plans, data.company, { keepEmpty: true })
    .filter((plan) => String(plan.role || '') !== 'main');
  riderPlans.forEach((plan, index) => {
    const prefix = `${normalizePolicyPlanRoleLabel(String(plan.role || ''))}${index + 1}`;
    if (!hasRequiredText(plan.name)) errors.push(`${prefix}险种名称`);
    if (!hasRequiredText(plan.amount)) errors.push(`${prefix}保额`);
    if (!hasPlanPremiumEvidence(plan)) errors.push(`${prefix}保费`);
    if (!hasRequiredText(plan.coveragePeriod)) errors.push(`${prefix}保障期间`);
    if (!hasRequiredText(plan.paymentPeriod)) errors.push(`${prefix}缴费期间`);
  });

  return errors;
}

export function productLookupKey(company: string, name: string) {
  return `${company.trim()}::${name.trim()}`;
}

export function hasAnalysisResult(analysis: PolicyAnalysisResult | null | undefined) {
  return Boolean(analysis?.report?.trim() || analysis?.coverageTable?.length || analysis?.optionalResponsibilities?.length);
}

export function updateOptionalResponsibilityItems(
  items: OptionalResponsibility[] | undefined,
  id: string,
  selectionStatus: OptionalResponsibility['selectionStatus'],
) {
  return (Array.isArray(items) ? items : []).map((item) =>
    item.id === id
      ? {
          ...item,
          selectionStatus,
          selectionEvidence: 'manual',
        }
      : item,
  );
}
