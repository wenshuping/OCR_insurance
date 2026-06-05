import type {
  Policy,
  PolicyAnalysisResult,
  PolicyFormData,
  PolicyScanResult,
} from '../api/contracts/policy';
import type { OptionalResponsibility } from '../api/contracts/responsibility';
import {
  normalizeBeneficiaryValue,
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

export function normalizePolicyPlanList(
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
    normalizedPlans.push({
      __originalIndex: index,
      company: String(plan?.company || company || '').trim(),
      role: String(assignRolesByRecognizedOrder ? (index === 0 ? 'main' : 'rider') : plan?.role || (index === 0 ? 'main' : 'rider')),
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
    });
  });
  return normalizedPlans
    .sort((left, right) => policyPlanRoleOrder(left.role) - policyPlanRoleOrder(right.role) || left.__originalIndex - right.__originalIndex)
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

export function mergeScanToForm(scan: PolicyScanResult, current: PolicyFormData): PolicyFormData {
  const next = scanToForm(scan);
  return {
    ...next,
    beneficiary: next.beneficiary || current.beneficiary,
    applicantRelation: next.applicantRelation || current.applicantRelation,
    insuredRelation: next.insuredRelation || current.insuredRelation,
    insuredIdNumber: next.insuredIdNumber || current.insuredIdNumber,
    insuredBirthday: next.insuredBirthday || current.insuredBirthday,
    familyId: next.familyId ?? current.familyId ?? null,
    applicantMemberId: next.applicantMemberId ?? current.applicantMemberId ?? null,
    insuredMemberId: next.insuredMemberId ?? current.insuredMemberId ?? null,
  };
}

export function sanitizeAmount(value: string) {
  return value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
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
