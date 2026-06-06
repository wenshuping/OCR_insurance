import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  CircleUserRound,
  Copy,
  Shield,
  Sparkles,
} from 'lucide-react';
import {
  ApiError,
  CashValueRow,
  CashValueScanResult,
  HealthStatus,
  OptionalResponsibility,
  Policy,
  PolicyAnalysisResult,
  PolicyCompanySuggestion,
  CoverageIndicator,
  FamilyMember,
  FamilyProfile,
  PolicyFormData,
  PolicyKnowledgeMatch,
  PolicyProductSuggestion,
  PolicyScanResult,
  Responsibility,
  UploadItem,
  analyzePolicy,
  confirmCashValue,
  createFamilyMember,
  createFamilyProfile,
  createFamilyReportShare,
  deletePolicy,
  getHealthStatus,
  getLocalPolicyAnalysisDraft,
  getPolicy,
  listPolicies,
  listFamilyProfiles,
  listPolicyResponsibilityCompanySuggestions,
  listPolicyResponsibilityProductSuggestions,
  logClientPerformance,
  logoutCustomer,
  matchPolicyResponsibilities,
  queryPolicyResponsibilities,
  register,
  regeneratePolicyReport,
  recognizePolicy,
  scanCashValue,
  scanPolicy,
  sendCode,
  setFamilyCoreMember,
  updateFamilyMemberRelation,
  updatePolicy,
} from '../../api';
import {
  FamilyReportPage,
} from '../../FamilyReport';
import {
  buildFamilyReport,
} from '../../family-report-engine.mjs';
import type {
  FamilyPlanningProfile,
} from '../../family-report-engine.mjs';
import {
  policyValidityClassName,
} from '../../policy-validity.mjs';
import {
  areSameParticipantName,
  formatCoverageAmount,
  formatNumberText,
  maskMobile,
} from '../../shared/formatters';
import {
  createCodedError,
  getErrorCode,
  getErrorMessage,
} from '../../shared/errors';
import {
  MAX_POLICY_UPLOAD_BYTES,
  type ClientPerformanceTimings,
  clientElapsedMs,
  clientPerfNow,
  fileToUploadItem,
} from '../../shared/image-utils';
import {
  downloadReportImage,
} from '../../features/report-export/report-export';
import {
  isPolicyReportGenerating,
} from '../../shared/policy-report-ui';
import {
  FamilyProfileManager,
} from '../../features/family-profile/FamilyProfileManager';
import {
  PolicyListItem,
  groupPoliciesByInsured,
} from '../../shared/customer-policy-list';
import { AnalysisReportPage, UploadPolicyPage } from '../../features/policy-entry/UploadPolicyPage';
import { PolicyDetailSheet } from '../../features/policy-detail/PolicyDetailSheet';
import { ResponsibilityAssistant } from '../../features/responsibility-assistant/ResponsibilityAssistant';
import { CustomerAccountSheet } from '../../features/customer-auth/CustomerAccountSheet';
import { PhoneVerificationDialog } from '../../features/customer-auth/PhoneVerificationDialog';
import {
  CustomerBottomTabs,
  type CustomerTab,
} from '../../features/customer-navigation/CustomerBottomTabs';
import { CashflowDetailPage } from '../../features/cashflow/CashflowDetailPage';
import { CashValueDialog } from '../../features/cash-value/CashValueDialog';
import { FamilyCoverageOverview } from '../../features/family-report/FamilyCoverageOverview';
import {
  readFamilyPlanningProfile,
  saveFamilyPlanningProfile,
} from '../../features/family-report/family-planning-storage';
import {
  buildPolicyUpdateData,
  hasAnalysisResult,
  mainProductIdentityKey,
  mergeScanToForm,
  normalizePolicyPlanList,
  normalizePolicyPlanListWithIndex,
  policyToForm,
  productLookupKey,
  sanitizeAmount,
  scanToForm,
  setMainPolicyPlanProduct,
  updateOptionalResponsibilityItems,
  validatePolicyEntryForm,
} from '../../shared/customer-policy-form';
import {
  makeManualCashValueRow,
  nextManualCashValueRow,
  normalizeCashValueRowsForEditing,
  normalizeCashValueRowsForSaving,
  parseNumericInput,
} from '../../shared/customer-cash-value';

const GUEST_ID_KEY = 'policy-ocr-app.guestId';
const TOKEN_KEY = 'policy-ocr-app.token';
const USER_MOBILE_KEY = 'policy-ocr-app.mobile';
const CLIENT_BOOTED_AT = new Date().toISOString();
const SHOULD_CHECK_STALE_DEV_CLIENT = window.location.port === '3014';

declare global {
  interface Window {
    __wxjs_environment?: string;
  }
}

const emptyForm: PolicyFormData = {
  company: '',
  name: '',
  canonicalProductId: '',
  applicant: '',
  beneficiary: '',
  applicantRelation: '',
  insured: '',
  insuredRelation: '',
  insuredIdNumber: '',
  insuredBirthday: '',
  date: '',
  paymentPeriod: '',
  coveragePeriod: '',
  amount: '',
  firstPremium: '',
  plans: [],
  familyId: null,
  applicantMemberId: null,
  insuredMemberId: null,
};

function createGuestId() {
  if (crypto.randomUUID) return `guest-${crypto.randomUUID()}`;
  return `guest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateGuestId() {
  const existing = localStorage.getItem(GUEST_ID_KEY);
  if (existing) return existing;
  const next = createGuestId();
  localStorage.setItem(GUEST_ID_KEY, next);
  return next;
}

function resolvePolicyMemberKey(policy: Policy) {
  return String(policy.insured || '').trim() || '未识别被保人';
}

function buildMemberBirthdayMap(policies: Policy[]) {
  const birthdays = new Map<string, string>();
  for (const policy of policies) {
    const member = resolvePolicyMemberKey(policy);
    const birthday = String(policy.insuredBirthday || '').trim();
    if (birthday || !birthdays.has(member)) birthdays.set(member, birthday);
  }
  return birthdays;
}

function parseAmountFromText(value: string) {
  const text = String(value || '').replace(/[,，\s]/gu, '');
  const wan = text.match(/(\d+(?:\.\d+)?)万/u);
  if (wan?.[1]) return Math.round(Number(wan[1]) * 10000);
  const yuan = text.match(/(\d+(?:\.\d+)?)(?:元|圆)/u);
  if (yuan?.[1]) return Number(yuan[1]);
  return 0;
}

function normalizeOverviewText(value: unknown) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
}

function indicatorOverviewText(indicator: CoverageIndicator) {
  return [
    indicator.coverageType,
    indicator.liability,
    indicator.formulaText,
    indicator.condition,
    indicator.basis,
    indicator.sourceExcerpt,
    indicator.productName,
  ].map((value) => String(value || '')).join(' ');
}

function indicatorCoreText(indicator: CoverageIndicator) {
  return [
    indicator.coverageType,
    indicator.liability,
    indicator.formulaText,
    indicator.condition,
    indicator.basis,
  ].map((value) => String(value || '')).join(' ');
}

function resolveCashflowLiabilityFromText(value: string) {
  const text = normalizeOverviewText(value);
  if (/满期生存保险金|满期保险金|满期金|满期/u.test(text)) return '满期生存保险金';
  if (/养老年金|养老保险金|养老金/u.test(text)) return '养老年金';
  if (/生存保险金|生存金/u.test(text)) return '生存保险金';
  if (/教育年金|教育金/u.test(text)) return '教育金';
  if (/祝寿金|祝贺金/u.test(text)) return '祝寿金';
  if (/关爱年金|关爱金/u.test(text)) return '关爱金';
  if (/年金/u.test(text)) return '年金';
  return '领取现金流';
}

function isCashflowPayoutIndicator(indicator: CoverageIndicator) {
  if (String(indicator.coverageType || '').trim() !== '现金流') return false;
  const text = normalizeOverviewText(indicatorOverviewText(indicator));
  return /生存保险金|生存金|满期生存保险金|满期保险金|满期金|年金|养老年金|养老金|教育金|祝寿金|祝贺金|关爱金|婚嫁金|领取金额|实际交纳的保险费|已交保险费|所交保险费/u.test(text);
}

function isNonPayoutCashflowIndicator(indicator: CoverageIndicator) {
  if (String(indicator.coverageType || '').trim() !== '现金流') return false;
  const text = normalizeOverviewText(indicatorCoreText(indicator));
  return /领取起始年龄|开始领取年龄|领取年龄|等待期/u.test(text);
}

function findPlanForIndicator(policy: Policy, indicator: CoverageIndicator) {
  const productName = normalizeOverviewText(indicator.productName);
  const plans = Array.isArray(policy.plans) ? policy.plans : [];
  if (productName) {
    const matched = plans.find((plan) =>
      [plan.matchedProductName, plan.name].some((value) => normalizeOverviewText(value) === productName),
    );
    if (matched) return matched;
  }
  return plans.find((plan) => String(plan.role || '') === 'main') || plans[0] || null;
}

function parsePaymentYears(value: unknown) {
  const text = normalizeOverviewText(value);
  if (!text) return 0;
  if (/趸交|一次交清/u.test(text)) return 1;
  const year = text.match(/(\d+(?:\.\d+)?)年/u);
  if (year?.[1]) return Number(year[1]);
  const period = text.match(/(\d+(?:\.\d+)?)期/u);
  if (period?.[1]) return Number(period[1]);
  return 0;
}

function planOrPolicyAmount(policy: Policy, indicator: CoverageIndicator) {
  const plan = findPlanForIndicator(policy, indicator);
  return Number(plan?.amount || policy.amount || 0) || 0;
}

function planOrPolicyPremiumParts(policy: Policy, indicator: CoverageIndicator) {
  const plan = findPlanForIndicator(policy, indicator);
  const premium = Number(plan?.premium || policy.firstPremium || 0) || 0;
  const years = parsePaymentYears(plan?.paymentPeriod || policy.paymentPeriod) || 1;
  return { premium, years, total: premium * years };
}

function planOrPolicyTotalPremium(policy: Policy, indicator: CoverageIndicator) {
  return planOrPolicyPremiumParts(policy, indicator).total;
}

function normalizeIndicatorFormulaText(indicator: CoverageIndicator) {
  const coreText = normalizeOverviewText(indicatorCoreText(indicator));
  const text = normalizeOverviewText(indicatorOverviewText(indicator));
  if (/满期生存保险金|满期保险金|满期金|满期/u.test(text) && /实际交纳的保险费|已交保险费|所交保险费/u.test(text)) {
    return '满期生存保险金 = 实际交纳保险费';
  }
  if (/养老年金|养老保险金|养老金/u.test(coreText) && /保单账户价值/u.test(coreText)) {
    const valueText = String(indicator.valueText ?? indicator.value ?? '').trim();
    return valueText ? `养老年金 = 保单账户价值 × ${valueText}%` : '养老年金 = 按保单账户价值约定比例领取';
  }
  return String(indicator.formulaText || '').trim();
}

function resolveIndicatorAmount(indicator: CoverageIndicator, policy: Policy) {
  if (isNonPayoutCashflowIndicator(indicator)) return 0;
  const text = normalizeOverviewText(indicatorCoreText(indicator));
  const overviewText = normalizeOverviewText(indicatorOverviewText(indicator));
  if (/实际交纳的保险费|已交保险费|所交保险费/u.test(text)) return planOrPolicyTotalPremium(policy, indicator);
  const value = Number(indicator.value);
  const unit = String(indicator.unit || '').trim();
  const basis = normalizeOverviewText(indicator.basis);
  if (!Number.isFinite(value) || value <= 0) {
    if (/基本保险金额|基本保额/u.test(text) && /给付|领取|生存|年金/u.test(overviewText)) return planOrPolicyAmount(policy, indicator);
    return 0;
  }
  if (/%/u.test(unit) && /基本保险金额|基本保额|保险金额/u.test(basis)) {
    return planOrPolicyAmount(policy, indicator) * value / 100;
  }
  if (/倍/u.test(unit) && /基本保险金额|基本保额|保险金额/u.test(basis)) {
    return planOrPolicyAmount(policy, indicator) * value;
  }
  if (/基本保险金额|基本保额|保险金额/u.test(basis) && /^公式$/u.test(unit)) return planOrPolicyAmount(policy, indicator);
  return 0;
}

function formatIndicatorCalculation(indicator: CoverageIndicator, policy: Policy) {
  const amount = resolveIndicatorAmount(indicator, policy);
  const planAmount = planOrPolicyAmount(policy, indicator);
  const premiumParts = planOrPolicyPremiumParts(policy, indicator);
  const value = Number(indicator.value);
  const valueText = String(indicator.valueText ?? indicator.value ?? '').trim();
  const unit = String(indicator.unit || '').trim();
  const basis = normalizeOverviewText(indicator.basis);
  const text = normalizeOverviewText(indicatorCoreText(indicator));
  if (isNonPayoutCashflowIndicator(indicator)) return formatCoverageIndicator(indicator);
  if (amount <= 0) return normalizeIndicatorFormulaText(indicator);
  if (/实际交纳的保险费|已交保险费|所交保险费/u.test(text)) {
    if (premiumParts.years > 1) return `年交保费 × 缴费年期 = ${formatNumberText(premiumParts.premium)} × ${formatNumberText(premiumParts.years)}`;
    return `保费 = ${formatNumberText(premiumParts.total)}元`;
  }
  if (Number.isFinite(value) && value > 0 && /%/u.test(unit) && /基本保险金额|基本保额|保险金额/u.test(basis)) {
    return `基本保额 × 比例 = ${formatNumberText(planAmount)} × ${valueText || value}%`;
  }
  if (Number.isFinite(value) && value > 0 && /倍/u.test(unit) && /基本保险金额|基本保额|保险金额/u.test(basis)) {
    return `基本保额 × 倍数 = ${formatNumberText(planAmount)} × ${valueText || value}`;
  }
  if (/基本保险金额|基本保额/u.test(normalizeOverviewText(indicatorOverviewText(indicator)))) return `基本保额 = ${formatNumberText(planAmount)}元`;
  const formulaText = normalizeIndicatorFormulaText(indicator);
  if (formulaText) return formulaText;
  return [valueText ? `${valueText}${unit}` : unit, indicator.basis].filter(Boolean).join(' / ');
}

function formatCoverageIndicator(indicator: CoverageIndicator, policy?: Policy) {
  if (policy) {
    const amount = resolveIndicatorAmount(indicator, policy);
    const formulaText = normalizeIndicatorFormulaText(indicator);
    if (amount > 0) return `${formatNumberText(amount)}元`;
    if (formulaText) return formulaText;
  }
  const formulaText = String(indicator.formulaText || '').trim();
  if (formulaText) return formulaText;
  const valueText = String(indicator.valueText ?? indicator.value ?? '').trim();
  const unit = String(indicator.unit || '').trim();
  const basis = String(indicator.basis || '').trim();
  return [valueText ? `${valueText}${unit}` : unit, basis].filter(Boolean).join(' / ') || '按指标库';
}

function classifyCoverageLiability(row: Responsibility, policy: Policy) {
  const text = `${row.coverageType || ''} ${row.scenario || ''} ${row.payout || ''} ${row.note || ''} ${policy.name || ''}`;
  if (/重疾|重大疾病|重度疾病/u.test(text)) return { coverageType: '疾病保障', liability: '重疾(首次给付)' };
  if (/中症|中度疾病/u.test(text)) return { coverageType: '疾病保障', liability: '中症(首次给付)' };
  if (/轻症|轻度疾病/u.test(text)) return { coverageType: '疾病保障', liability: '轻症(首次给付)' };
  if (/特定疾病|恶性肿瘤|癌/u.test(text)) return { coverageType: '疾病保障', liability: '特定疾病(首次给付)' };
  if (/护理|失能/u.test(text)) return { coverageType: '疾病保障', liability: '护理' };
  if (/医疗|住院|门诊|药品|质子重离子|报销|费用补偿/u.test(text)) return { coverageType: '医疗保障', liability: '医疗保障' };
  if (/意外|伤残|残疾|交通|航空|驾乘/u.test(text)) {
    if (/医疗/u.test(text)) return { coverageType: '意外保障', liability: '意外医疗' };
    return { coverageType: '意外保障', liability: /伤残|残疾/u.test(text) ? '意外伤残' : '意外身故/全残' };
  }
  if (/年金|养老金|教育金|生存金|生存保险金|满期保险金|满期生存保险金|祝寿金|祝贺金|关爱金/u.test(text)) {
    return { coverageType: '现金流', liability: resolveCashflowLiabilityFromText(text) };
  }
  if (/全残|身体全残/u.test(text)) return { coverageType: '人寿保障', liability: /疾病/u.test(text) ? '疾病全残' : '身故/全残' };
  if (/身故/u.test(text)) return { coverageType: '人寿保障', liability: /疾病/u.test(text) ? '疾病身故' : '身故/全残' };
  return { coverageType: '人寿保障', liability: '身故/全残' };
}

function resolveCoverageAmount(row: Responsibility, policy: Policy) {
  const direct = parseAmountFromText(`${row.payout || ''} ${row.scenario || ''}`);
  if (direct > 0) return direct;
  const text = `${row.payout || ''} ${row.scenario || ''}`;
  if (/基本保险金额|基本保额|保险金额|保额/u.test(text)) return Number(policy.amount || 0) || 0;
  return 0;
}

type PolicyUploadSource = 'file-input';

function getNetworkType() {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; type?: string } }).connection;
  return connection?.effectiveType || connection?.type || '';
}

function getUserAgentKind() {
  const userAgent = navigator.userAgent || '';
  if (/MicroMessenger/i.test(userAgent)) return 'wechat';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (/Mobi/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

function reportClientPerformance(event: string, payload: Record<string, unknown> = {}) {
  logClientPerformance({
    event,
    networkType: getNetworkType(),
    userAgentKind: getUserAgentKind(),
    ...payload,
  });
}

export function CustomerApp() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const formProductDraftRequestRef = useRef(0);
  const optionalResponsibilitySelectionRef = useRef<Map<string, OptionalResponsibility['selectionStatus']>>(new Map());
  const [guestId] = useState(getOrCreateGuestId);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [mobile, setMobile] = useState(() => localStorage.getItem(USER_MOBILE_KEY) || '');
  const [formData, setFormData] = useState<PolicyFormData>(emptyForm);
  const [ocrText, setOcrText] = useState('');
  const [uploadItem, setUploadItem] = useState<UploadItem | null>(null);
  const [scanResult, setScanResult] = useState<PolicyScanResult | null>(null);
  const [analysisDraft, setAnalysisDraft] = useState<PolicyAnalysisResult | null>(null);
  const [showAnalysisReport, setShowAnalysisReport] = useState(false);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [familyProfiles, setFamilyProfiles] = useState<FamilyProfile[]>([]);
  const [selectedFamilyId, setSelectedFamilyId] = useState<number | null>(null);
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [activeTab, setActiveTab] = useState<CustomerTab>('entry');
  const [message, setMessage] = useState('可以直接录入保单');
  const [loading, setLoading] = useState(false);
  const [retryingPolicyId, setRetryingPolicyId] = useState<number | null>(null);
  const [savingPolicyId, setSavingPolicyId] = useState<number | null>(null);
  const [deletingPolicyId, setDeletingPolicyId] = useState<number | null>(null);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [showAccountSheet, setShowAccountSheet] = useState(false);
  const [authMobile, setAuthMobile] = useState(() => localStorage.getItem(USER_MOBILE_KEY) || '');
  const [authCode, setAuthCode] = useState('');
  const [authMessage, setAuthMessage] = useState('第二次录入需要先完成手机验证码');
  const [authLoading, setAuthLoading] = useState(false);
  const [authDevCode, setAuthDevCode] = useState('');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantCompany, setAssistantCompany] = useState('');
  const [assistantName, setAssistantName] = useState('');
  const [assistantAnalysis, setAssistantAnalysis] = useState<PolicyAnalysisResult | null>(null);
  const [assistantMatches, setAssistantMatches] = useState<PolicyKnowledgeMatch[]>([]);
  const [assistantCompanySuggestions, setAssistantCompanySuggestions] = useState<PolicyCompanySuggestion[]>([]);
  const [assistantCompanySuggestionLoading, setAssistantCompanySuggestionLoading] = useState(false);
  const [assistantProductSuggestions, setAssistantProductSuggestions] = useState<PolicyProductSuggestion[]>([]);
  const [assistantProductSuggestionLoading, setAssistantProductSuggestionLoading] = useState(false);
  const [assistantLocalSearched, setAssistantLocalSearched] = useState(false);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantMessage, setAssistantMessage] = useState('输入保司和产品名称');
  const [formCompanySuggestions, setFormCompanySuggestions] = useState<PolicyCompanySuggestion[]>([]);
  const [formCompanySuggestionLoading, setFormCompanySuggestionLoading] = useState(false);
  const [formProductSuggestions, setFormProductSuggestions] = useState<PolicyProductSuggestion[]>([]);
  const [formProductSuggestionLoading, setFormProductSuggestionLoading] = useState(false);
  const [formPlanProductQuery, setFormPlanProductQuery] = useState<{ index: number | null; company: string; q: string }>({ index: null, company: '', q: '' });
  const [formPlanProductSuggestions, setFormPlanProductSuggestions] = useState<PolicyProductSuggestion[]>([]);
  const [formPlanProductSuggestionLoading, setFormPlanProductSuggestionLoading] = useState(false);
  const [formProductMatches, setFormProductMatches] = useState<PolicyKnowledgeMatch[]>([]);
  const [formProductMatchLoading, setFormProductMatchLoading] = useState(false);
  const [formProductMatchMessage, setFormProductMatchMessage] = useState('');
  const [confirmedProductMatchKey, setConfirmedProductMatchKey] = useState('');
  const [cashflowMember, setCashflowMember] = useState<string | null>(null);
  const [showFamilyReport, setShowFamilyReport] = useState(false);
  const [familyPlanningProfile, setFamilyPlanningProfile] = useState<FamilyPlanningProfile>(readFamilyPlanningProfile);

  // Cash value upload dialog state
  const [cashValueDialogOpen, setCashValueDialogOpen] = useState(false);
  const [cashValuePolicyId, setCashValuePolicyId] = useState<number | null>(null);
  const [cashValueScanResult, setCashValueScanResult] = useState<CashValueScanResult | null>(null);
  const [cashValueEditRows, setCashValueEditRows] = useState<CashValueRow[]>([]);
  const [cashValueLoading, setCashValueLoading] = useState(false);
  const [cashValueMessage, setCashValueMessage] = useState('');
  const [showFamilyPolicies, setShowFamilyPolicies] = useState(false);
  const [staleClientHealth, setStaleClientHealth] = useState<HealthStatus | null>(null);

  const canSubmit = Boolean(uploadItem || ocrText.trim() || formData.company.trim() || formData.name.trim());
  const totalCoverage = useMemo(() => policies.reduce((sum, policy) => sum + Number(policy.amount || 0), 0), [policies]);
  const policyGroups = useMemo(() => groupPoliciesByInsured(policies), [policies]);
  const selectedFamilyPolicies = useMemo(
    () => selectedFamilyId ? policies.filter((policy) => Number(policy.familyId) === Number(selectedFamilyId)) : policies,
    [policies, selectedFamilyId],
  );
  const familyTotalCoverage = useMemo(() => selectedFamilyPolicies.reduce((sum, policy) => sum + Number(policy.amount || 0), 0), [selectedFamilyPolicies]);
  const familyPolicyGroups = useMemo(() => groupPoliciesByInsured(selectedFamilyPolicies), [selectedFamilyPolicies]);
  const familyReport = useMemo(
    () => buildFamilyReport(selectedFamilyPolicies, familyPlanningProfile, { familyId: selectedFamilyId }),
    [selectedFamilyPolicies, familyPlanningProfile, selectedFamilyId],
  );
  const selectedFamily = useMemo(
    () => familyProfiles.find((family) => Number(family.id) === Number(selectedFamilyId)) || null,
    [familyProfiles, selectedFamilyId],
  );
  const entryFamilyId = formData.familyId ?? selectedFamilyId ?? null;
  const entrySelectedFamily = useMemo(
    () => familyProfiles.find((family) => Number(family.id) === Number(entryFamilyId)) || null,
    [entryFamilyId, familyProfiles],
  );
  const familyPolicyCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const policy of policies) {
      const familyId = Number(policy.familyId || 0);
      if (!familyId) continue;
      counts[familyId] = (counts[familyId] || 0) + 1;
    }
    return counts;
  }, [policies]);
  const selectedFamilyMembers = useMemo(
    () => (Array.isArray(selectedFamily?.members) ? selectedFamily.members : []),
    [selectedFamily],
  );
  const entrySelectedFamilyMembers = useMemo(
    () => (Array.isArray(entrySelectedFamily?.members) ? entrySelectedFamily.members : []),
    [entrySelectedFamily],
  );
  const isLoggedIn = Boolean(token);

  function clearOptionalResponsibilitySelections() {
    optionalResponsibilitySelectionRef.current.clear();
  }

  function rememberOptionalResponsibilitySelections(items: OptionalResponsibility[] | undefined) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const id = String(item?.id || '').trim();
      if (!id || item.selectionEvidence !== 'manual') continue;
      optionalResponsibilitySelectionRef.current.set(id, item.selectionStatus || 'unknown');
    }
  }

  function applyRememberedOptionalResponsibilitySelections(items: OptionalResponsibility[] | undefined) {
    const remembered = optionalResponsibilitySelectionRef.current;
    if (!Array.isArray(items) || !items.length || !remembered.size) return items;
    let changed = false;
    const nextItems = items.map((item) => {
      const id = String(item?.id || '').trim();
      const selectionStatus = id ? remembered.get(id) : undefined;
      if (!selectionStatus) return item;
      if (item.selectionStatus === selectionStatus && item.selectionEvidence === 'manual') return item;
      changed = true;
      return {
        ...item,
        selectionStatus,
        selectionEvidence: 'manual',
      };
    });
    return changed ? nextItems : items;
  }

  function withRememberedOptionalResponsibilitySelections(analysis: PolicyAnalysisResult | null | undefined) {
    if (!analysis) return null;
    const optionalResponsibilities = applyRememberedOptionalResponsibilitySelections(analysis.optionalResponsibilities);
    return optionalResponsibilities === analysis.optionalResponsibilities
      ? analysis
      : {
          ...analysis,
          optionalResponsibilities,
        };
  }

  function handleFamilyPlanningProfileChange(next: FamilyPlanningProfile) {
    setFamilyPlanningProfile(saveFamilyPlanningProfile(next));
  }

  async function refreshPolicies(nextToken = token) {
    const payload = await listPolicies({ token: nextToken || undefined, guestId: nextToken ? undefined : guestId });
    setPolicies(payload.policies);
    setSelectedPolicy((current) => {
      if (!current) return current;
      return payload.policies.find((policy) => Number(policy.id) === Number(current.id)) || current;
    });
  }

  async function refreshFamilyProfiles(nextToken = token) {
    const payload = await listFamilyProfiles({ token: nextToken || undefined, guestId: nextToken ? undefined : guestId });
    const families = Array.isArray(payload.families) ? payload.families : [];
    setFamilyProfiles(families);
    setSelectedFamilyId((current) => {
      const nextId = current && families.some((family) => Number(family.id) === Number(current))
        ? current
        : families[0]?.id ?? null;
      setFormData((currentForm) => ({ ...currentForm, familyId: nextId }));
      return nextId;
    });
  }

  function clearCustomerSession(nextMessage = '已退出登录，当前为游客模式') {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_MOBILE_KEY);
    setToken('');
    setMobile('');
    setAuthMobile('');
    setAuthCode('');
    setAuthDevCode('');
    setShowAuthDialog(false);
    setShowAccountSheet(false);
    setSelectedPolicy(null);
    setPolicies([]);
    setFamilyProfiles([]);
    setSelectedFamilyId(null);
    setMessage(nextMessage);
  }

  async function handleCustomerLogout() {
    const currentToken = token;
    clearCustomerSession();
    if (!currentToken) return;
    try {
      await logoutCustomer(currentToken);
    } catch {
      // Local logout should still complete if the server session is already gone.
    }
  }

  useEffect(() => {
    Promise.all([refreshPolicies(), refreshFamilyProfiles()]).catch((error) => {
      if (error instanceof ApiError && error.status === 401) {
        clearCustomerSession('登录已失效，请重新验证手机号');
      }
    });
  }, [token, guestId]);

  useEffect(() => {
    if (!policies.some(isPolicyReportGenerating)) return;
    const timer = window.setInterval(() => {
      refreshPolicies().catch((error) => {
        if (error instanceof ApiError && error.status === 401) {
          clearCustomerSession('登录已失效，请重新验证手机号');
        }
      });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [policies, token, guestId]);

  useEffect(() => {
    if (!isPolicyReportGenerating(selectedPolicy)) return;
    let cancelled = false;
    async function refreshSelectedPolicy() {
      if (!selectedPolicy) return;
      try {
        const payload = await getPolicy({ token: token || undefined, guestId: token ? undefined : guestId, id: selectedPolicy.id });
        if (cancelled) return;
        setSelectedPolicy(payload.policy);
        setPolicies((current) => current.map((policy) => (Number(policy.id) === Number(payload.policy.id) ? payload.policy : policy)));
        if (payload.policy.reportStatus === 'ready') setMessage('保险责任已生成');
        if (payload.policy.reportStatus === 'failed') setMessage(payload.policy.reportError || '报告生成失败');
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : '保单详情加载失败');
      }
    }
    void refreshSelectedPolicy();
    const timer = window.setInterval(() => {
      void refreshSelectedPolicy();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedPolicy?.id, selectedPolicy?.reportStatus, token, guestId]);

  useEffect(() => {
    if (!SHOULD_CHECK_STALE_DEV_CLIENT) return;
    let cancelled = false;
    const checkClientFreshness = async () => {
      try {
        const health = await getHealthStatus();
        if (cancelled) return;
        const serverStartedAt = Date.parse(String(health.startedAt || ''));
        const clientStartedAt = Date.parse(CLIENT_BOOTED_AT);
        if (Number.isFinite(serverStartedAt) && Number.isFinite(clientStartedAt) && serverStartedAt > clientStartedAt + 1000) {
          setStaleClientHealth(health);
          return;
        }
        setStaleClientHealth(null);
      } catch {
        if (!cancelled) setStaleClientHealth(null);
      }
    };

    void checkClientFreshness();
    const timer = window.setInterval(() => {
      void checkClientFreshness();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const q = assistantCompany.trim();
    if (!assistantOpen || !q) {
      setAssistantCompanySuggestions([]);
      setAssistantCompanySuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setAssistantCompanySuggestions([]);
      setAssistantCompanySuggestionLoading(true);
      listPolicyResponsibilityCompanySuggestions({ q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setAssistantCompanySuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setAssistantCompanySuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setAssistantCompanySuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [assistantOpen, assistantCompany]);

  useEffect(() => {
    const company = assistantCompany.trim();
    const q = assistantName.trim();
    if (!assistantOpen || !company) {
      setAssistantProductSuggestions([]);
      setAssistantProductSuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setAssistantProductSuggestions([]);
      setAssistantProductSuggestionLoading(true);
      listPolicyResponsibilityProductSuggestions({ company, q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setAssistantProductSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setAssistantProductSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setAssistantProductSuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [assistantOpen, assistantCompany, assistantName]);

  useEffect(() => {
    const q = formData.company.trim();
    if (activeTab !== 'entry' || !q) {
      setFormCompanySuggestions([]);
      setFormCompanySuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFormCompanySuggestions([]);
      setFormCompanySuggestionLoading(true);
      listPolicyResponsibilityCompanySuggestions({ q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setFormCompanySuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setFormCompanySuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setFormCompanySuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, formData.company]);

  useEffect(() => {
    const company = formData.company.trim();
    const q = formData.name.trim();
    if (activeTab !== 'entry' || !company) {
      setFormProductSuggestions([]);
      setFormProductSuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFormProductSuggestions([]);
      setFormProductSuggestionLoading(true);
      listPolicyResponsibilityProductSuggestions({ company, q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setFormProductSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setFormProductSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setFormProductSuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, formData.company, formData.name]);

  useEffect(() => {
    const index = formPlanProductQuery.index;
    const company = formPlanProductQuery.company.trim();
    const q = formPlanProductQuery.q.trim();
    if (activeTab !== 'entry' || index === null || !company) {
      setFormPlanProductSuggestions([]);
      setFormPlanProductSuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFormPlanProductSuggestions([]);
      setFormPlanProductSuggestionLoading(true);
      listPolicyResponsibilityProductSuggestions({ company, q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setFormPlanProductSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setFormPlanProductSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setFormPlanProductSuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, formPlanProductQuery]);

  useEffect(() => {
    const company = formData.company.trim();
    const name = formData.name.trim();
    const lookupKey = productLookupKey(company, name);
    if (activeTab !== 'entry' || !company || name.length < 2 || confirmedProductMatchKey === lookupKey) {
      setFormProductMatches([]);
      setFormProductMatchLoading(false);
      setFormProductMatchMessage('');
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setFormProductMatchLoading(true);
      setFormProductMatchMessage('');
      try {
        const payload = await matchPolicyResponsibilities({ company, name });
        if (cancelled) return;
        const matches = Array.isArray(payload.matches) ? payload.matches : [];
        setFormProductMatches(matches);
        setFormProductMatchMessage(matches.length ? '' : '本地暂无匹配候选，生成时将继续查找官方资料');
      } catch (error) {
        if (cancelled) return;
        setFormProductMatches([]);
        setFormProductMatchMessage(error instanceof Error ? error.message : '本地产品匹配失败');
      } finally {
        if (!cancelled) setFormProductMatchLoading(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, confirmedProductMatchKey, formData.company, formData.name]);

  async function loadFormProductAnalysisDraft(nextData: PolicyFormData, fallbackMessage: string) {
    const company = nextData.company.trim();
    const name = nextData.name.trim();
    if (!company || !name) return;
    const requestId = formProductDraftRequestRef.current + 1;
    formProductDraftRequestRef.current = requestId;
    const existingOptionalResponsibilitySource = analysisDraft?.optionalResponsibilities?.length
      ? analysisDraft.optionalResponsibilities
      : nextData.optionalResponsibilities;
    rememberOptionalResponsibilitySelections(existingOptionalResponsibilitySource);
    const existingOptionalResponsibilities = applyRememberedOptionalResponsibilitySelections(existingOptionalResponsibilitySource);
    const manualData = existingOptionalResponsibilities?.length
      ? { ...nextData, optionalResponsibilities: existingOptionalResponsibilities }
      : nextData;
    try {
      const payload = await getLocalPolicyAnalysisDraft({
        manualData,
        ocrText: ocrText || `${company} ${name}`,
      });
      if (formProductDraftRequestRef.current !== requestId) return;
      const nextAnalysis = withRememberedOptionalResponsibilitySelections(payload.analysis);
      if (hasAnalysisResult(nextAnalysis)) {
        setAnalysisDraft(nextAnalysis);
        setShowAnalysisReport(false);
        setMessage(nextAnalysis?.optionalResponsibilities?.length
          ? '已匹配本地保险责任，请确认可选责任后保存'
          : '已匹配本地保险责任，请确认后保存');
      } else {
        setAnalysisDraft(null);
        setShowAnalysisReport(false);
        setMessage(fallbackMessage);
      }
    } catch {
      if (formProductDraftRequestRef.current !== requestId) return;
      setAnalysisDraft(null);
      setShowAnalysisReport(false);
      setMessage(fallbackMessage);
    }
  }

  function updateForm(key: keyof PolicyFormData, value: PolicyFormData[keyof PolicyFormData]) {
    setShowAnalysisReport(false);
    if (key === 'company' || key === 'name') {
      clearOptionalResponsibilitySelections();
      setAnalysisDraft(null);
      formProductDraftRequestRef.current += 1;
      setConfirmedProductMatchKey('');
    }
    setFormData((current) => {
      if (key !== 'company' && key !== 'name') return { ...current, [key]: value };
      const nextCompany = key === 'company' ? String(value || '') : current.company;
      const nextName = key === 'name' ? String(value || '') : current.name;
      const plans = normalizePolicyPlanList(current.plans, nextCompany, { keepEmpty: true }).map((plan, index) => {
        const role = String(plan.role || (index === 0 ? 'main' : 'rider'));
        if (role !== 'main' && index !== 0) return plan;
        return {
          ...plan,
          company: nextCompany,
          ...(key === 'name' ? { name: nextName, matchedProductName: '', canonicalProductId: '' } : { canonicalProductId: '' }),
        };
      });
      return {
        ...current,
        [key]: value,
        canonicalProductId: '',
        plans,
      };
    });
  }

  function updatePolicyPlan(index: number, key: string, value: string) {
    setShowAnalysisReport(false);
    const plans = normalizePolicyPlanList(formData.plans, formData.company, { keepEmpty: true });
    const existing = plans[index];
    if (!existing) return;
    const nextPlans = plans.map((plan, planIndex) => {
      if (planIndex !== index) return plan;
      return {
        ...plan,
        [key]: key === 'amount' || key === 'premium' ? sanitizeAmount(value) : value,
        ...(key === 'name' ? { matchedProductName: '', canonicalProductId: '' } : {}),
      };
    });
    const primary = nextPlans.find((plan) => plan.role === 'main') || nextPlans[0] || null;
    const totalPremium = nextPlans.reduce((sum, plan) => sum + Number(plan.premium || 0), 0);
    const nextData = {
      ...formData,
      plans: nextPlans,
      name: primary?.matchedProductName || primary?.name || formData.name,
      canonicalProductId: primary?.canonicalProductId || '',
      amount: primary?.amount ? String(primary.amount) : formData.amount,
      coveragePeriod: primary?.coveragePeriod || formData.coveragePeriod,
      paymentPeriod: primary?.paymentPeriod || formData.paymentPeriod,
      firstPremium: totalPremium ? String(totalPremium) : formData.firstPremium,
    };
    setFormData(nextData);
    if (['role', 'name', 'productType'].includes(key)) {
      setMessage('已更新险种明细，正在重新带出可选责任');
      void loadFormProductAnalysisDraft(nextData, '已更新险种明细');
    }
  }

  function updatePolicyPlanProductQuery(index: number, company: string, q: string) {
    setFormPlanProductQuery({ index, company: company || formData.company, q });
  }

  function selectPolicyPlanProduct(index: number, suggestion: PolicyProductSuggestion) {
    const company = suggestion.company.trim();
    const name = suggestion.productName.trim();
    const canonicalProductId = String(suggestion.canonicalProductId || '').trim();
    if (!company || !name) return;
    setShowAnalysisReport(false);
    setFormPlanProductQuery({ index: null, company: '', q: '' });
    setFormPlanProductSuggestions([]);
    const plans = normalizePolicyPlanList(formData.plans, formData.company, { keepEmpty: true });
    const existing = plans[index];
    if (!existing) return;
    const nextPlans = plans.map((plan, planIndex) => {
      if (planIndex !== index) return plan;
      return {
        ...plan,
        company,
        name,
        matchedProductName: name,
        canonicalProductId,
      };
    });
    const primary = nextPlans.find((plan) => plan.role === 'main') || nextPlans[0] || null;
    const totalPremium = nextPlans.reduce((sum, plan) => sum + Number(plan.premium || 0), 0);
    const nextData = {
      ...formData,
      plans: nextPlans,
      name: primary?.matchedProductName || primary?.name || formData.name,
      canonicalProductId: primary?.canonicalProductId || '',
      amount: primary?.amount ? String(primary.amount) : formData.amount,
      coveragePeriod: primary?.coveragePeriod || formData.coveragePeriod,
      paymentPeriod: primary?.paymentPeriod || formData.paymentPeriod,
      firstPremium: totalPremium ? String(totalPremium) : formData.firstPremium,
    };
    setFormData(nextData);
    setMessage(`已选择附加险产品：${name}，正在重新带出可选责任`);
    void loadFormProductAnalysisDraft(nextData, `已选择附加险产品：${name}`);
  }

  function addPolicyPlan() {
    setShowAnalysisReport(false);
    setFormData((current) => ({
      ...current,
      plans: [
        ...normalizePolicyPlanList(current.plans, current.company, { keepEmpty: true }),
        {
          company: current.company,
          role: 'rider',
          name: '',
          matchedProductName: '',
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
      ],
    }));
  }

  function removePolicyPlan(index: number) {
    setShowAnalysisReport(false);
    const current = formData;
    const beforeMainProductKey = mainProductIdentityKey(formData);
    const indexedPlans = normalizePolicyPlanListWithIndex(current.plans, current.company, { keepEmpty: true });
    const removedPlan = indexedPlans.find((plan) => plan.__originalIndex === index);
    if (!removedPlan) return;
    const mainPlan = indexedPlans.find((plan) => plan.role === 'main') || indexedPlans[0] || null;
    const removingMainPlan = Boolean(mainPlan && removedPlan.__originalIndex === mainPlan.__originalIndex);
    const plans = indexedPlans
      .filter((plan) => plan.__originalIndex !== index)
      .map(({ __originalIndex, ...plan }) => plan);
    const primary = plans.find((plan) => plan.role === 'main') || plans[0] || null;
    const nextData = {
      ...formData,
      plans,
      name: primary ? primary.matchedProductName || primary.name || formData.name : '',
      canonicalProductId: primary?.canonicalProductId || '',
      ...(primary
        ? {
            amount: primary.amount ? String(primary.amount) : formData.amount,
            coveragePeriod: primary.coveragePeriod || formData.coveragePeriod,
            paymentPeriod: primary.paymentPeriod || formData.paymentPeriod,
          }
        : {}),
    };
    const afterMainProductKey = mainProductIdentityKey(nextData);
    setFormData(nextData);
    if (beforeMainProductKey !== afterMainProductKey) {
      setMessage('已删除险种，正在重新带出可选责任');
      void loadFormProductAnalysisDraft(nextData, '已删除险种，已重新带出可选责任');
      return;
    }
    if (removingMainPlan) {
      setMessage('已删除险种，正在重新带出可选责任');
      void loadFormProductAnalysisDraft(nextData, '已删除险种，已重新带出可选责任');
      return;
    }
    setMessage('已删除附加险');
  }

  function selectFormProductMatch(match: PolicyKnowledgeMatch) {
    const company = match.company.trim();
    const name = match.productName.trim();
    const canonicalProductId = String(match.canonicalProductId || '').trim();
    if (!company || !name) return;
    clearOptionalResponsibilitySelections();
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey(productLookupKey(company, name));
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    const nextData = {
      ...formData,
      company,
      name,
      canonicalProductId,
      plans: setMainPolicyPlanProduct(formData.plans, company, name, canonicalProductId),
    };
    setFormData((current) => ({
      ...current,
      company,
      name,
      canonicalProductId,
      plans: setMainPolicyPlanProduct(current.plans, company, name, canonicalProductId),
    }));
    setScanResult((current) =>
      current
        ? {
            ...current,
            data: {
              ...current.data,
              company,
              name,
              canonicalProductId: String(match.canonicalProductId || '').trim(),
            },
          }
        : current,
    );
    setMessage(`已选择本地产品：${name}，正在带出可选责任`);
    void loadFormProductAnalysisDraft(nextData, `已选择本地产品：${name}`);
  }

  function selectFormProductSuggestion(suggestion: PolicyProductSuggestion) {
    const company = suggestion.company.trim();
    const name = suggestion.productName.trim();
    const canonicalProductId = String(suggestion.canonicalProductId || '').trim();
    if (!company || !name) return;
    clearOptionalResponsibilitySelections();
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey(productLookupKey(company, name));
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    const nextData = {
      ...formData,
      company,
      name,
      canonicalProductId,
      plans: setMainPolicyPlanProduct(formData.plans, company, name, canonicalProductId),
    };
    setFormData((current) => ({
      ...current,
      company,
      name,
      canonicalProductId,
      plans: setMainPolicyPlanProduct(current.plans, company, name, canonicalProductId),
    }));
    setScanResult((current) =>
      current
        ? {
            ...current,
            data: {
              ...current.data,
              company,
              name,
              canonicalProductId: String(suggestion.canonicalProductId || '').trim(),
            },
          }
        : current,
    );
    setMessage(`已选择保险产品：${name}，正在带出可选责任`);
    void loadFormProductAnalysisDraft(nextData, `已选择保险产品：${name}`);
  }

  function handleSelectFamily(familyId: number | null) {
    setSelectedFamilyId(familyId);
    setFormData((current) => ({
      ...current,
      familyId,
      applicantMemberId: familyId === current.familyId ? current.applicantMemberId ?? null : null,
      insuredMemberId: familyId === current.familyId ? current.insuredMemberId ?? null : null,
    }));
  }

  function openFamilyReport(familyId: number) {
    handleSelectFamily(familyId);
    setShowFamilyReport(true);
  }

  function viewFamilyPolicies(familyId: number) {
    handleSelectFamily(familyId);
    setShowFamilyPolicies(true);
  }

  async function handleShareFamilyReport() {
    if (!selectedFamilyId) {
      setMessage('请先选择家庭档案');
      return;
    }
    try {
      const payload = await createFamilyReportShare({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId: selectedFamilyId,
      });
      const shareUrl = `${window.location.origin}${window.location.pathname}#/family-share/${payload.share.token}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        setMessage('家庭报告分享链接已复制');
      } catch {
        setMessage(`分享链接：${shareUrl}`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '家庭报告分享失败');
    }
  }

  async function createFamilyProfileByName(familyName: string) {
    const normalizedFamilyName = familyName.trim();
    if (!normalizedFamilyName) return null;
    const payload = await createFamilyProfile({ token: token || undefined, guestId: token ? undefined : guestId, familyName: normalizedFamilyName });
    const family = { ...payload.family, members: payload.members };
    setFamilyProfiles((current) => [family, ...current.filter((item) => Number(item.id) !== Number(family.id))]);
    handleSelectFamily(family.id);
    setMessage(`已创建家庭档案：${family.familyName}`);
    return family;
  }

  async function handleCreateFamilyProfile() {
    const familyName = window.prompt('请输入家庭档案名称', '默认家庭')?.trim();
    if (!familyName) return null;
    return createFamilyProfileByName(familyName);
  }

  function findFamilyMemberByName(name: string) {
    const normalizedName = name.trim();
    if (!normalizedName) return null;
    const matches = entrySelectedFamilyMembers.filter((member) => member.status === 'active' && member.name.trim() === normalizedName);
    return matches.length === 1 ? matches[0] : null;
  }

  async function ensureFamilyBeforeSave() {
    if (entrySelectedFamily) return entrySelectedFamily;
    const payload = await createFamilyProfile({ token: token || undefined, guestId: token ? undefined : guestId, familyName: '默认家庭' });
    const family = { ...payload.family, members: payload.members };
    setFamilyProfiles((current) => [family, ...current.filter((item) => Number(item.id) !== Number(family.id))]);
    handleSelectFamily(family.id);
    return family;
  }

  async function createFamilyMemberForFamily(family: FamilyProfile, input: { name: string; relationLabel: string; setAsCore?: boolean }) {
    const name = input.name.trim();
    if (!name) return null;
    const payload = await createFamilyMember({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      name,
      relationLabel: input.relationLabel || '待确认',
      setAsCore: input.setAsCore,
    });
    await refreshFamilyProfiles();
    return payload.member;
  }

  function replaceFamilyProfile(family: FamilyProfile, members: FamilyMember[]) {
    const nextFamily = { ...family, members };
    setFamilyProfiles((current) => [nextFamily, ...current.filter((item) => Number(item.id) !== Number(nextFamily.id))]);
    setSelectedFamilyId(nextFamily.id);
    setFormData((current) => ({ ...current, familyId: nextFamily.id }));
    return nextFamily;
  }

  async function setCoreMemberForCurrentFamily(family: FamilyProfile, member: FamilyMember) {
    const payload = await setFamilyCoreMember({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      memberId: member.id,
    });
    return replaceFamilyProfile(payload.family, payload.members);
  }

  async function updateFamilyMemberRelationForFamily(family: FamilyProfile, member: FamilyMember, relationLabel: string) {
    const payload = await updateFamilyMemberRelation({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      memberId: member.id,
      relationLabel,
    });
    return replaceFamilyProfile(payload.family, payload.members);
  }

  function handleOcrTextChange(value: string) {
    setOcrText(value);
    setScanResult((current) => (current ? { ...current, ocrText: value } : current));
    clearOptionalResponsibilitySelections();
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
  }

  function openPhoneVerificationDialog(nextMessage = '第二次录入需要先完成手机验证码') {
    setAuthMessage(nextMessage);
    setAuthMobile((current) => current || mobile);
    setAuthDevCode('');
    setShowAuthDialog(true);
  }

  function blockSecondGuestPolicyIfNeeded() {
    if (token || policies.length < 1) return false;
    openPhoneVerificationDialog('第一次录入不用验证码；第二次录入请先验证手机号');
    return true;
  }

  function handleRegistrationRequiredError(error: unknown) {
    if (error instanceof ApiError && error.code === 'REGISTRATION_REQUIRED') {
      openPhoneVerificationDialog(error.message || '第二次录入需要先完成手机验证码');
      return true;
    }
    return false;
  }

  function scanReviewMessageSuffix(scan: PolicyScanResult | null | undefined) {
    return Array.isArray(scan?.ocrWarnings) && scan.ocrWarnings.length ? '，部分 OCR 字段建议确认' : '';
  }

  async function recognizePreparedUpload(input: {
    item: UploadItem;
    originalBytes: number;
    flowStartedAt: number;
    source: PolicyUploadSource;
  }) {
    const { item, originalBytes, flowStartedAt, source } = input;
    clearOptionalResponsibilitySelections();
    setUploadItem(item);
    setScanResult(null);
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey('');
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    setMessage('正在上传并 OCR 识别保单信息');
    const recognizeStartedAt = clientPerfNow();
    const payload = await recognizePolicy({
      token,
      guestId,
      ocrText,
      uploadItem: item,
      manualData: formData,
    });
    reportClientPerformance('client.recognize.request', {
      durationMs: clientElapsedMs(recognizeStartedAt),
      requestMs: clientElapsedMs(recognizeStartedAt),
      source,
      originalBytes,
      uploadBytes: item.size,
      hasUpload: true,
      outputOcrChars: String(payload.scan?.ocrText || '').length,
    });
    setFormData((current) => mergeScanToForm(payload.scan, current));
    setOcrText(payload.scan.ocrText || '');
    setScanResult(payload.scan);
    const recognizedAnalysis = payload.analysis || null;
    if (hasAnalysisResult(recognizedAnalysis)) {
      setAnalysisDraft(withRememberedOptionalResponsibilitySelections(recognizedAnalysis));
      setShowAnalysisReport(false);
      const reviewSuffix = scanReviewMessageSuffix(payload.scan);
      setMessage(recognizedAnalysis?.optionalResponsibilities?.length
        ? `OCR 已完成，已匹配本地保险责任${reviewSuffix}，请确认可选责任后保存`
        : `OCR 已完成，已匹配本地保险责任${reviewSuffix}，请确认后保存`);
    } else {
      setMessage(`OCR 已完成${scanReviewMessageSuffix(payload.scan)}，可生成保险责任或直接保存`);
    }
    reportClientPerformance('client.recognize.complete', {
      durationMs: clientElapsedMs(flowStartedAt),
      source,
      originalBytes,
      uploadBytes: item.size,
      hasUpload: true,
      outputOcrChars: String(payload.scan?.ocrText || '').length,
    });
  }

  function handleScanClick() {
    if (blockSecondGuestPolicyIfNeeded()) return;
    fileInputRef.current?.click();
  }

  async function handleSendAuthCode() {
    if (authLoading) return;
    const normalizedMobile = authMobile.trim();
    if (!normalizedMobile) {
      setAuthMessage('请输入手机号');
      return;
    }
    setAuthLoading(true);
    setAuthMessage('正在发送验证码');
    try {
      const payload = await sendCode(normalizedMobile);
      setAuthDevCode(payload.devCode || '');
      setAuthMessage(payload.devCode ? `验证码已生成：${payload.devCode}` : '验证码已发送，请查看手机短信');
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : '验证码发送失败');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleVerifyAuthCode() {
    if (authLoading) return;
    const normalizedMobile = authMobile.trim();
    const normalizedCode = authCode.trim();
    if (!normalizedMobile || !normalizedCode) {
      setAuthMessage('请输入手机号和验证码');
      return;
    }
    setAuthLoading(true);
    setAuthMessage('正在验证手机号');
    try {
      const payload = await register({ mobile: normalizedMobile, code: normalizedCode, guestId });
      localStorage.setItem(TOKEN_KEY, payload.token);
      localStorage.setItem(USER_MOBILE_KEY, payload.user.mobile);
      setToken(payload.token);
      setMobile(payload.user.mobile);
      setPolicies([...payload.policies].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
      setAuthCode('');
      setAuthDevCode('');
      setShowAuthDialog(false);
      setMessage('手机号验证完成，可以继续录入保单');
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : '手机号验证失败');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const flowStartedAt = clientPerfNow();
    const file = event.target.files?.[0] || null;
    if (!file) return;
    if (blockSecondGuestPolicyIfNeeded()) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setLoading(true);
    setMessage('正在读取并压缩保单图片');
    try {
      const prepareStartedAt = clientPerfNow();
      const timings: ClientPerformanceTimings = {};
      const item = await fileToUploadItem(file, timings);
      if (item.size > MAX_POLICY_UPLOAD_BYTES) {
        throw createCodedError('图片太大，请压缩到 12MB 以内后重新上传', 'UPLOAD_TOO_LARGE');
      }
      reportClientPerformance('client.upload.prepare', {
        durationMs: clientElapsedMs(prepareStartedAt),
        source: 'file-input',
        originalBytes: file.size,
        uploadBytes: item.size,
        hasUpload: true,
        ...timings,
      });
      await recognizePreparedUpload({
        item,
        originalBytes: file.size,
        flowStartedAt,
        source: 'file-input',
      });
    } catch (error) {
      reportClientPerformance('client.recognize.error', {
        durationMs: clientElapsedMs(flowStartedAt),
        source: 'file-input',
        originalBytes: file.size,
        hasUpload: true,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
      });
      if (handleRegistrationRequiredError(error)) return;
      setMessage(error instanceof Error ? error.message : '识别失败，请稍后重试');
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleGenerateAnalysis() {
    if (!canSubmit || loading) return;
    if (blockSecondGuestPolicyIfNeeded()) return;
    const startedAt = clientPerfNow();
    setLoading(true);
    setMessage('正在生成保险责任');
    try {
      const payload = await analyzePolicy({
        token,
        guestId,
        ocrText,
        uploadItem: scanResult ? null : uploadItem,
        manualData: formData,
        scan: scanResult,
      });
      reportClientPerformance('client.analyze.request', {
        durationMs: clientElapsedMs(startedAt),
        requestMs: clientElapsedMs(startedAt),
        uploadBytes: uploadItem?.size || 0,
        hasUpload: Boolean(uploadItem),
        reusedScan: Boolean(scanResult),
        outputOcrChars: String(payload.scan?.ocrText || '').length,
        responsibilityCount: payload.analysis?.coverageTable?.length || 0,
      });
      setScanResult(payload.scan);
      setFormData((current) => mergeScanToForm(payload.scan, current));
      setOcrText(payload.scan.ocrText || '');
      setAnalysisDraft(withRememberedOptionalResponsibilitySelections(payload.analysis));
      setShowAnalysisReport(true);
      setMessage('保险责任已生成，保存时会直接使用');
    } catch (error) {
      reportClientPerformance('client.analyze.error', {
        durationMs: clientElapsedMs(startedAt),
        uploadBytes: uploadItem?.size || 0,
        hasUpload: Boolean(uploadItem),
        reusedScan: Boolean(scanResult),
      });
      if (handleRegistrationRequiredError(error)) return;
      setMessage(error instanceof Error ? error.message : '保险责任生成失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  function updateAnalysisOptionalResponsibility(id: string, selectionStatus: OptionalResponsibility['selectionStatus']) {
    optionalResponsibilitySelectionRef.current.set(id, selectionStatus);
    setAnalysisDraft((current) => current
      ? {
          ...current,
          optionalResponsibilities: updateOptionalResponsibilityItems(current.optionalResponsibilities, id, selectionStatus),
        }
      : current,
    );
  }

  function openResponsibilityAssistant() {
    setAssistantCompany((current) => current || formData.company.trim());
    setAssistantName((current) => current || formData.name.trim());
    setAssistantOpen(true);
  }

  async function handleAssistantQuery() {
    const company = assistantCompany.trim();
    const name = assistantName.trim();
    if (!company || !name || assistantLoading) {
      setAssistantMessage('请输入保险公司和保险名称');
      return;
    }
    const startedAt = clientPerfNow();
    setAssistantLoading(true);
    setAssistantAnalysis(null);
    setAssistantMatches([]);
    setAssistantLocalSearched(false);
    setAssistantMessage('正在匹配本地产品');
    try {
      const matched = await matchPolicyResponsibilities({
        company,
        name,
        limit: 20,
        minScore: 0.1,
      });
      const matches = Array.isArray(matched.matches) ? matched.matches : [];
      setAssistantLocalSearched(true);
      if (matches.length) {
        setAssistantMatches(matches);
        setAssistantMessage(`本地找到 ${matches.length} 个相近产品`);
        reportClientPerformance('client.responsibility.assistant.match', {
          durationMs: clientElapsedMs(startedAt),
          requestMs: clientElapsedMs(startedAt),
          hasUpload: false,
          inputOcrChars: `${company} ${name}`.length,
          responsibilityCount: 0,
        });
        return;
      }
      setAssistantMessage('本地库未找到匹配产品');
      reportClientPerformance('client.responsibility.assistant.match', {
        durationMs: clientElapsedMs(startedAt),
        requestMs: clientElapsedMs(startedAt),
        hasUpload: false,
        inputOcrChars: `${company} ${name}`.length,
        responsibilityCount: 0,
      });
    } catch (error) {
      setAssistantAnalysis(null);
      setAssistantMatches([]);
      setAssistantLocalSearched(false);
      setAssistantMessage(error instanceof Error ? error.message : '查询失败，请稍后重试');
      reportClientPerformance('client.responsibility.assistant.error', {
        durationMs: clientElapsedMs(startedAt),
        hasUpload: false,
        inputOcrChars: `${company} ${name}`.length,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
      });
    } finally {
      setAssistantLoading(false);
    }
  }

  async function loadAssistantResponsibilities(input: { company: string; name: string; startedAt: number; preferLocalKnowledgeAnswer?: boolean }) {
    const payload = await queryPolicyResponsibilities({
      company: input.company,
      name: input.name,
      preferLocalKnowledgeAnswer: input.preferLocalKnowledgeAnswer,
    });
    setAssistantAnalysis(payload.analysis);
    setAssistantMatches([]);
    setAssistantLocalSearched(false);
    const responsibilityCount = payload.analysis?.coverageTable?.length || 0;
    setAssistantMessage(responsibilityCount ? `已找到 ${responsibilityCount} 项责任` : '未查询到责任明细');
    reportClientPerformance('client.responsibility.assistant.request', {
      durationMs: clientElapsedMs(input.startedAt),
      requestMs: clientElapsedMs(input.startedAt),
      hasUpload: false,
      inputOcrChars: `${input.company} ${input.name}`.length,
      responsibilityCount,
    });
  }

  async function handleAssistantSelectMatch(match: PolicyKnowledgeMatch) {
    if (assistantLoading) return;
    const company = match.company.trim();
    const name = match.productName.trim();
    if (!company || !name) return;
    const startedAt = clientPerfNow();
    setAssistantCompany(company);
    setAssistantName(name);
    setAssistantAnalysis(null);
    setAssistantMatches([]);
    setAssistantLoading(true);
    setAssistantMessage('正在查询所选产品');
    try {
      await loadAssistantResponsibilities({ company, name, startedAt });
    } catch (error) {
      setAssistantAnalysis(null);
      setAssistantMessage(error instanceof Error ? error.message : '查询失败，请稍后重试');
      reportClientPerformance('client.responsibility.assistant.error', {
        durationMs: clientElapsedMs(startedAt),
        hasUpload: false,
        inputOcrChars: `${company} ${name}`.length,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
      });
    } finally {
      setAssistantLoading(false);
    }
  }

  async function handleAssistantSearchMore() {
    const company = assistantCompany.trim();
    const name = assistantName.trim();
    if (!company || !name || assistantLoading) {
      setAssistantMessage('请输入保险公司和保险名称');
      return;
    }
    const startedAt = clientPerfNow();
    setAssistantLoading(true);
    setAssistantAnalysis(null);
    setAssistantMessage('正在联网查询官方资料');
    try {
      await loadAssistantResponsibilities({
        company,
        name,
        startedAt,
        preferLocalKnowledgeAnswer: false,
      });
    } catch (error) {
      setAssistantAnalysis(null);
      setAssistantMessage(error instanceof Error ? error.message : '查询失败，请稍后重试');
      reportClientPerformance('client.responsibility.assistant.error', {
        durationMs: clientElapsedMs(startedAt),
        hasUpload: false,
        inputOcrChars: `${company} ${name}`.length,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
      });
    } finally {
      setAssistantLoading(false);
    }
  }

  async function handleSubmit() {
    if (loading) return;
    if (blockSecondGuestPolicyIfNeeded()) return;
    const submitBaseData = Number(entryFamilyId || 0) && Number(formData.familyId || 0) !== Number(entryFamilyId)
      ? {
          ...formData,
          familyId: entryFamilyId,
          applicantMemberId: null,
          insuredMemberId: null,
        }
      : formData;
    if (submitBaseData !== formData) setFormData(submitBaseData);
    const validationErrors = validatePolicyEntryForm(submitBaseData);
    if (validationErrors.length) {
      const message = `以下必录项未填写：\n${validationErrors.map((item) => `- ${item}`).join('\n')}`;
      window.alert(message);
      setMessage('请先补全必录项后再保存');
      return;
    }
    rememberOptionalResponsibilitySelections(analysisDraft?.optionalResponsibilities);
    const analysisForSubmit = withRememberedOptionalResponsibilitySelections(analysisDraft);
    const hasGeneratedAnalysis = hasAnalysisResult(analysisForSubmit);
    const isNewPolicy = !policies.some((p) => Number(p.id) === Number((formData as any).id));
    const startedAt = clientPerfNow();
    setLoading(true);
    setMessage(hasGeneratedAnalysis ? '正在保存保单信息' : '正在保存保单信息，报告将在后台生成');
    try {
      let submitFamily = await ensureFamilyBeforeSave();
      let submitFamilyMembers = Array.isArray(submitFamily.members) ? [...submitFamily.members] : [...entrySelectedFamilyMembers];
      const findActiveMemberById = (id: number | null | undefined) =>
        submitFamilyMembers.find((member) => member.status === 'active' && Number(member.id) === Number(id || 0)) || null;
      const findActiveSingleMemberByName = (name: string) => {
        const normalizedName = name.trim();
        if (!normalizedName) return null;
        const matches = submitFamilyMembers.filter((member) => member.status === 'active' && member.name.trim() === normalizedName);
        return matches.length === 1 ? matches[0] : null;
      };
      const createSubmitMember = async (input: { name: string; relationLabel: string; setAsCore?: boolean }) => {
        const member = await createFamilyMemberForFamily(submitFamily, input);
        if (member) {
          submitFamilyMembers = [member, ...submitFamilyMembers.filter((item) => Number(item.id) !== Number(member.id))];
          if (input.setAsCore) submitFamily = { ...submitFamily, coreMemberId: member.id };
        }
        return member;
      };
      const resolveSubmitMember = async (input: {
        name: string;
        memberId?: number | null;
        relationLabel?: string;
        setAsCoreOnCreate?: boolean;
      }) => {
        const normalizedName = input.name.trim();
        if (!normalizedName) return null;
        if (input.memberId) {
          const selectedMember = findActiveMemberById(input.memberId);
          if (selectedMember && areSameParticipantName(selectedMember.name, normalizedName)) return selectedMember;
        }
        const exactMember =
          findActiveSingleMemberByName(normalizedName) ||
          (Number(submitFamily.id) === Number(selectedFamilyId) ? findFamilyMemberByName(normalizedName) : null);
        if (exactMember) return exactMember;
        return createSubmitMember({
          name: normalizedName,
          relationLabel: input.setAsCoreOnCreate ? '本人' : input.relationLabel || '待确认',
          setAsCore: input.setAsCoreOnCreate,
        });
      };

      const applicantName = submitBaseData.applicant.trim();
      const insuredName = submitBaseData.insured.trim();
      const participantNamesMatch = areSameParticipantName(applicantName, insuredName);
      const applicantRelationForSubmit = submitBaseData.applicantRelationLabel || submitBaseData.applicantRelation || '待确认';
      const insuredRelationForSubmit = submitBaseData.insuredRelationLabel || submitBaseData.insuredRelation || '待确认';
      const applicantShouldBeCore = applicantRelationForSubmit === '本人';
      const insuredShouldBeCore = insuredRelationForSubmit === '本人';
      if (!submitFamily.coreMemberId && applicantShouldBeCore && insuredShouldBeCore && applicantName && insuredName && !participantNamesMatch) {
        setMessage('家庭核心人员只能选择一个');
        return;
      }
      let applicantMember = await resolveSubmitMember({
        name: applicantName,
        memberId: submitBaseData.applicantMemberId,
        relationLabel: applicantRelationForSubmit,
        setAsCoreOnCreate: applicantShouldBeCore && !submitFamily.coreMemberId,
      });
      if (!applicantMember) {
        window.alert('投保人姓名未找到可绑定的家庭成员，请先检查投保人姓名');
        setMessage('请先补全必录项后再保存');
        return;
      }
      const refreshSubmitFamilyMembers = () => {
        submitFamilyMembers = Array.isArray(submitFamily.members) ? [...submitFamily.members] : submitFamilyMembers;
      };
      const findSubmitMemberById = (id: number | null | undefined) =>
        submitFamilyMembers.find((member) => member.status === 'active' && Number(member.id) === Number(id || 0)) || null;
      const setSubmitCoreMember = async (member: FamilyMember) => {
        if (Number(submitFamily.coreMemberId || 0) === Number(member.id)) return findSubmitMemberById(member.id) || member;
        submitFamily = await setCoreMemberForCurrentFamily(submitFamily, member);
        refreshSubmitFamilyMembers();
        return findSubmitMemberById(member.id) || member;
      };
      const syncSubmitMemberRelation = async (member: FamilyMember, relationLabel: string) => {
        if (!relationLabel || relationLabel === '本人' || member.relationLabel === relationLabel) return member;
        submitFamily = await updateFamilyMemberRelationForFamily(submitFamily, member, relationLabel);
        refreshSubmitFamilyMembers();
        return findSubmitMemberById(member.id) || member;
      };
      let insuredMember = await resolveSubmitMember({
        name: insuredName,
        memberId: submitBaseData.insuredMemberId,
        relationLabel: insuredRelationForSubmit,
        setAsCoreOnCreate: insuredShouldBeCore && !submitFamily.coreMemberId,
      });
      if (!insuredMember) {
        window.alert('被保险人姓名未找到可绑定的家庭成员，请先检查被保险人姓名');
        setMessage('请先补全必录项后再保存');
        return;
      }
      const shouldPersistAsCore = (member: FamilyMember, relationLabel: string) => (
        relationLabel === '本人' &&
        (!submitFamily.coreMemberId || Number(member.id) === Number(submitFamily.coreMemberId))
      );
      const relationLabelForMember = (member: FamilyMember, relationLabel: string) => {
        if (shouldPersistAsCore(member, relationLabel)) return '本人';
        if (relationLabel !== '本人') return relationLabel || '待确认';
        return member.relationLabel && member.relationLabel !== '本人' ? member.relationLabel : '待确认';
      };
      const applicantFinalRelation = relationLabelForMember(applicantMember, applicantRelationForSubmit);
      const insuredFinalRelation = relationLabelForMember(insuredMember, insuredRelationForSubmit);
      if (applicantFinalRelation === '本人') applicantMember = await setSubmitCoreMember(applicantMember);
      if (insuredFinalRelation === '本人') insuredMember = await setSubmitCoreMember(insuredMember);
      if (applicantFinalRelation !== '本人') applicantMember = await syncSubmitMemberRelation(applicantMember, applicantFinalRelation);
      if (insuredFinalRelation !== '本人') insuredMember = await syncSubmitMemberRelation(insuredMember, insuredFinalRelation);
      const submitData: PolicyFormData = {
        ...submitBaseData,
        familyId: submitFamily.id,
        applicantMemberId: applicantMember.id,
        insuredMemberId: insuredMember.id,
        applicantRelation: applicantFinalRelation,
        insuredRelation: insuredFinalRelation,
        applicantRelationLabel: applicantFinalRelation,
        insuredRelationLabel: insuredFinalRelation,
      };
      setFormData(submitData);
      const payload = await scanPolicy({
        token,
        guestId,
        ocrText,
        uploadItem: scanResult ? null : uploadItem,
        manualData: submitData,
        scan: scanResult,
        analysis: hasGeneratedAnalysis ? analysisForSubmit : null,
      });
      reportClientPerformance('client.scan.request', {
        durationMs: clientElapsedMs(startedAt),
        requestMs: clientElapsedMs(startedAt),
        uploadBytes: uploadItem?.size || 0,
        hasUpload: Boolean(uploadItem),
        usedUpload: Boolean(uploadItem && !scanResult),
        reusedScan: Boolean(scanResult),
        reusedAnalysis: hasGeneratedAnalysis,
        reportStatus: payload.policy?.reportStatus || 'ready',
        outputOcrChars: String(payload.policy?.ocrText || '').length,
        responsibilityCount: payload.policy?.responsibilities?.length || 0,
      });
      setFormData({
        ...emptyForm,
        familyId: submitFamily.id,
      });
      setOcrText('');
      setUploadItem(null);
      setScanResult(null);
      setAnalysisDraft(null);
      clearOptionalResponsibilitySelections();
      setShowAnalysisReport(false);
      setConfirmedProductMatchKey('');
      setFormProductMatches([]);
      setFormProductMatchMessage('');
      setPolicies((current) => {
        const withoutDuplicate = current.filter((policy) => policy.id !== payload.policy.id);
        return [payload.policy, ...withoutDuplicate];
      });
      setSelectedPolicy(payload.policy);
      setActiveTab('families');
      setShowFamilyPolicies(true);

      // Trigger cash value dialog for newly saved policies without cash values
      const hasExistingCashValues = (payload.policy.cashValues?.length ?? 0) > 0;
      if (!hasExistingCashValues && isNewPolicy) {
        setCashValuePolicyId(payload.policy.id);
        setCashValueDialogOpen(true);
      }
      const suffix = payload.registrationRequiredNext ? '；第二次录入需要手机验证码' : '';
      setMessage(isPolicyReportGenerating(payload.policy) ? `保单已保存，报告正在后台生成${suffix}` : `保单已保存到我的保单${suffix}`);
    } catch (error) {
      reportClientPerformance('client.scan.error', {
        durationMs: clientElapsedMs(startedAt),
        uploadBytes: uploadItem?.size || 0,
        hasUpload: Boolean(uploadItem),
        reusedScan: Boolean(scanResult),
        reusedAnalysis: hasGeneratedAnalysis,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
      });
      if (handleRegistrationRequiredError(error)) return;
      setMessage(error instanceof Error ? error.message : '识别失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  async function handleCashValueFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || cashValuePolicyId === null) return;
    e.target.value = '';

    setCashValueLoading(true);
    setCashValueMessage('正在识别现金价值表...');

    try {
      const uploadItem = await fileToUploadItem(file);
      const result = await scanCashValue({
        token,
        guestId,
        policyId: cashValuePolicyId,
        uploadItem,
      });

      if (result.ok && result.rows?.length) {
        setCashValueScanResult(result);
        setCashValueEditRows(result.rows);
        setCashValueMessage('');
      } else {
        setCashValueMessage(result.message || '未能识别现金价值表，请确保照片清晰且包含完整表格');
        setCashValueScanResult(null);
        setCashValueEditRows([]);
      }
    } catch (error) {
      setCashValueMessage(error instanceof Error ? error.message : '识别失败');
      setCashValueScanResult(null);
      setCashValueEditRows([]);
    } finally {
      setCashValueLoading(false);
    }
  }

  async function handleCashValueConfirm() {
    if (cashValuePolicyId === null || cashValueEditRows.length === 0) return;
    const savedPolicyId = cashValuePolicyId;
    const savedRows = normalizeCashValueRowsForSaving(cashValueEditRows, cashValueScanResult?.source || 'manual');
    if (!savedRows.length) {
      setCashValueMessage('请至少录入一行现金价值');
      return;
    }
    setCashValueLoading(true);
    setCashValueMessage('正在保存...');

    try {
      await confirmCashValue({
        token,
        guestId,
        policyId: savedPolicyId,
        rows: savedRows,
      });

      // Refresh the policy data
      const updated = policies.map((p) =>
        p.id === savedPolicyId ? { ...p, cashValues: savedRows } : p
      );
      setPolicies(updated);
      const savedPolicy = updated.find((p) => Number(p.id) === Number(savedPolicyId))
        || (selectedPolicy?.id === savedPolicyId ? { ...selectedPolicy, cashValues: savedRows } : null);
      if (savedPolicy) {
        finishCashValueFlow(savedPolicy, `现金价值表已保存（${savedRows.length} 行）`);
      }
    } catch (error) {
      setCashValueMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setCashValueLoading(false);
    }
  }

  function handleCashValueCellEdit(rowIndex: number, field: 'policyYear' | 'age' | 'cashValue', value: string) {
    setCashValueEditRows((prev) => {
      const updated = [...prev];
      const num = parseNumericInput(value);
      if (field === 'age') {
        updated[rowIndex] = { ...updated[rowIndex], age: num };
      } else if (num !== null) {
        updated[rowIndex] = { ...updated[rowIndex], [field]: num };
      }
      return updated;
    });
  }

  function handleAddCashValueRow() {
    setCashValueEditRows((prev) => [...prev, nextManualCashValueRow(prev)]);
  }

  function handleRemoveCashValueRow(rowIndex: number) {
    setCashValueEditRows((prev) => {
      const nextRows = prev.filter((_, index) => index !== rowIndex);
      return nextRows.length ? nextRows : [makeManualCashValueRow()];
    });
  }

  function closeCashValueDialog() {
    const currentPolicy = cashValuePolicyId === null
      ? null
      : policies.find((row) => Number(row.id) === Number(cashValuePolicyId)) || null;
    if (currentPolicy) {
      finishCashValueFlow(currentPolicy, '已跳过现金价值录入');
      return;
    }
    setCashValueDialogOpen(false);
    setCashValueScanResult(null);
    setCashValueEditRows([]);
    setCashValuePolicyId(null);
    setCashValueMessage('');
  }

  function openManualCashValueEditor(policy: Policy) {
    const rows = normalizeCashValueRowsForEditing(policy.cashValues);
    setCashValuePolicyId(policy.id);
    setCashValueEditRows(rows);
    setCashValueScanResult({
      ok: true,
      source: 'manual',
      tableType: 3,
      rows,
      rowCount: rows.length,
    });
    setCashValueMessage('');
    setCashValueDialogOpen(true);
  }

  function startManualCashValueEntry() {
    if (cashValuePolicyId === null) return;
    const policy = policies.find((row) => Number(row.id) === Number(cashValuePolicyId));
    const rows = normalizeCashValueRowsForEditing(policy?.cashValues);
    setCashValueEditRows(rows);
    setCashValueScanResult({
      ok: true,
      source: 'manual',
      tableType: 3,
      rows,
      rowCount: rows.length,
    });
    setCashValueMessage('');
  }

  function finishCashValueFlow(policy: Policy, nextMessage?: string) {
    setCashValueDialogOpen(false);
    setCashValueScanResult(null);
    setCashValueEditRows([]);
    setCashValuePolicyId(null);
    setCashValueMessage('');
    setCashflowMember(null);
    setActiveTab('families');
    setShowFamilyPolicies(true);
    setSelectedPolicy(policy);
    if (nextMessage) setMessage(nextMessage);
  }

  async function openPolicy(policy: Policy) {
    setSelectedPolicy(policy);
    try {
      const payload = await getPolicy({ token: token || undefined, guestId: token ? undefined : guestId, id: policy.id });
      setSelectedPolicy(payload.policy);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保单详情加载失败');
    }
  }

  async function handleUpdatePolicy(policy: Policy, nextData: PolicyFormData) {
    if (savingPolicyId) return;
    setSavingPolicyId(policy.id);
    setMessage('正在保存保单修改');
    try {
      const normalizedData = buildPolicyUpdateData(policy, nextData);
      const payload = await updatePolicy({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        id: policy.id,
        policy: normalizedData,
      });
      setSelectedPolicy(payload.policy);
      setPolicies((current) => current.map((row) => (Number(row.id) === Number(payload.policy.id) ? payload.policy : row)));
      setMessage(payload.reportRegenerating ? '保单已修改，保险责任正在重新生成' : '保单已修改，保险责任保持不变');
      return payload;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保单修改失败');
      throw error;
    } finally {
      setSavingPolicyId(null);
    }
  }

  async function handleUpdateOptionalResponsibility(policy: Policy, id: string, selectionStatus: OptionalResponsibility['selectionStatus']) {
    if (savingPolicyId) return;
    const optionalResponsibilities = updateOptionalResponsibilityItems(policy.optionalResponsibilities, id, selectionStatus);
    setSavingPolicyId(policy.id);
    setMessage('正在保存可选责任');
    try {
      const payload = await updatePolicy({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        id: policy.id,
        policy: { optionalResponsibilities },
      });
      setSelectedPolicy(payload.policy);
      setPolicies((current) => current.map((row) => (Number(row.id) === Number(payload.policy.id) ? payload.policy : row)));
      setMessage('可选责任已更新');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '可选责任保存失败');
      throw error;
    } finally {
      setSavingPolicyId(null);
    }
  }

  async function handleDeletePolicy(policy: Policy) {
    if (deletingPolicyId) return;
    setDeletingPolicyId(policy.id);
    setMessage('正在删除保单');
    try {
      await deletePolicy({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        id: policy.id,
      });
      setPolicies((current) => current.filter((row) => Number(row.id) !== Number(policy.id)));
      setSelectedPolicy(null);
      setMessage('保单已删除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保单删除失败');
    } finally {
      setDeletingPolicyId(null);
    }
  }

  async function retryPolicyReport(policy: Policy) {
    if (retryingPolicyId) return;
    setRetryingPolicyId(policy.id);
    setMessage('正在重新生成保险责任报告');
    try {
      const payload = await regeneratePolicyReport({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        id: policy.id,
      });
      setSelectedPolicy(payload.policy);
      setPolicies((current) => current.map((row) => (Number(row.id) === Number(payload.policy.id) ? payload.policy : row)));
      setMessage(payload.skipped ? '保险责任报告已存在' : '已开始重新生成报告');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重新生成报告失败');
    } finally {
      setRetryingPolicyId(null);
    }
  }

  function startEntryForm(options: { preserveSelectedFamily?: boolean } = {}) {
    const preserveSelectedFamily = options.preserveSelectedFamily ?? true;
    const nextFamilyId = preserveSelectedFamily ? selectedFamilyId : null;
    setFormData({
      ...emptyForm,
      familyId: nextFamilyId,
    });
    setOcrText('');
    setUploadItem(null);
    setScanResult(null);
    setAnalysisDraft(null);
    clearOptionalResponsibilitySelections();
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey('');
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    setActiveTab('entry');
    setMessage('可以继续录入保单');
  }

  // Cash Value Upload Dialog
  const cashValueDialog = (
    <CashValueDialog
      editRows={cashValueEditRows}
      loading={cashValueLoading}
      message={cashValueMessage}
      open={cashValueDialogOpen}
      scanResult={cashValueScanResult}
      onAddRow={handleAddCashValueRow}
      onCancel={closeCashValueDialog}
      onCellEdit={handleCashValueCellEdit}
      onConfirm={() => { void handleCashValueConfirm(); }}
      onFileChange={(e) => { void handleCashValueFileChange(e); }}
      onRemoveRow={handleRemoveCashValueRow}
      onResetForRescan={() => {
        setCashValueScanResult(null);
        setCashValueEditRows([]);
        setCashValueMessage('');
      }}
      onStartManualEntry={startManualCashValueEntry}
    />
  );

  const authDialog = showAuthDialog ? (
    <PhoneVerificationDialog
      code={authCode}
      devCode={authDevCode}
      loading={authLoading}
      message={authMessage}
      mobile={authMobile}
      onChangeCode={setAuthCode}
      onChangeMobile={setAuthMobile}
      onClose={() => setShowAuthDialog(false)}
      onSendCode={() => void handleSendAuthCode()}
      onVerify={() => void handleVerifyAuthCode()}
    />
  ) : null;
  const accountSheet = showAccountSheet ? (
    <CustomerAccountSheet
      insuredCount={policyGroups.length}
      isLoggedIn={isLoggedIn}
      mobile={mobile}
      policyCount={policies.length}
      onClose={() => setShowAccountSheet(false)}
      onOpenPolicies={() => {
        setShowAccountSheet(false);
        setActiveTab('families');
      }}
      onLogin={() => {
        setShowAccountSheet(false);
        openPhoneVerificationDialog('验证手机号后可查看账号名下所有保单');
      }}
      onLogout={() => void handleCustomerLogout()}
    />
  ) : null;
  function renderResponsibilityAssistant(anchorClassName?: string) {
    return (
    <ResponsibilityAssistant
      analysis={assistantAnalysis}
      anchorClassName={anchorClassName}
      company={assistantCompany}
      companySuggestionLoading={assistantCompanySuggestionLoading}
      companySuggestions={assistantCompanySuggestions}
      localSearched={assistantLocalSearched}
      loading={assistantLoading}
      matches={assistantMatches}
      message={assistantMessage}
      name={assistantName}
      productSuggestionLoading={assistantProductSuggestionLoading}
      productSuggestions={assistantProductSuggestions}
      onChangeCompany={(value) => {
        setAssistantCompany(value);
        setAssistantAnalysis(null);
        setAssistantMatches([]);
        setAssistantLocalSearched(false);
        setAssistantMessage('输入保司和产品名称');
      }}
      onChangeName={(value) => {
        setAssistantName(value);
        setAssistantAnalysis(null);
        setAssistantMatches([]);
        setAssistantLocalSearched(false);
        setAssistantMessage('输入保司和产品名称');
      }}
      onClose={() => setAssistantOpen(false)}
      onOpen={openResponsibilityAssistant}
      onQuery={() => void handleAssistantQuery()}
      onSearchMore={() => void handleAssistantSearchMore()}
      onSelectCompany={(company) => {
        setAssistantCompany(company);
        setAssistantAnalysis(null);
        setAssistantMatches([]);
        setAssistantLocalSearched(false);
        setAssistantMessage('输入保司和产品名称');
      }}
      onSelectMatch={(match) => void handleAssistantSelectMatch(match)}
      onSelectProduct={(suggestion) => {
        setAssistantCompany(suggestion.company);
        setAssistantName(suggestion.productName);
        setAssistantAnalysis(null);
        setAssistantMatches([]);
        setAssistantLocalSearched(false);
        setAssistantMessage('输入保司和产品名称');
      }}
      open={assistantOpen}
    />
    );
  }
  const responsibilityAssistant = renderResponsibilityAssistant('bottom-24');

  if (showFamilyReport) {
    return (
      <>
        <FamilyReportPage
          report={familyReport}
          planningProfile={familyPlanningProfile}
          onPlanningProfileChange={handleFamilyPlanningProfileChange}
          onBack={() => setShowFamilyReport(false)}
          onExport={(target, title) => void downloadReportImage(target, title, { rawTarget: true, preservePageStyle: true })}
        />
        <button
          type="button"
          onClick={() => void handleShareFamilyReport()}
          className="no-print fixed bottom-24 right-4 z-30 flex h-12 items-center justify-center gap-2 rounded-full bg-slate-950 px-4 text-sm font-black text-white shadow-xl shadow-slate-950/20 active:scale-[0.98]"
          aria-label="分享家庭报告"
          title="分享家庭报告"
        >
          <Copy size={18} />
          <span>分享</span>
        </button>
      </>
    );
  }

  if (activeTab === 'entry' && showAnalysisReport && analysisDraft) {
    return (
      <>
        <AnalysisReportPage
          analysis={analysisDraft}
          canSave={true}
          formData={formData}
          loading={loading}
          message={message}
          onBack={() => setShowAnalysisReport(false)}
          onSave={handleSubmit}
          onUpdateOptionalResponsibility={updateAnalysisOptionalResponsibility}
        />
        {renderResponsibilityAssistant('bottom-24')}
        {authDialog}
        {accountSheet}
        {cashValueDialog}
      </>
    );
  }

  if (activeTab === 'entry') {
    return (
      <>
        <UploadPolicyPage
          canSubmit={canSubmit}
          familyProfiles={familyProfiles}
          formData={formData}
          formCompanySuggestionLoading={formCompanySuggestionLoading}
          formCompanySuggestions={formCompanySuggestions}
          formProductSuggestionLoading={formProductSuggestionLoading}
          formProductSuggestions={formProductSuggestions}
          formPlanProductSuggestionLoading={formPlanProductSuggestionLoading}
          formPlanProductSuggestions={formPlanProductSuggestions}
          formPlanProductSuggestionTargetIndex={formPlanProductQuery.index}
          loading={loading}
          message={message}
          ocrText={ocrText}
          ocrWarnings={scanResult?.ocrWarnings || []}
          productMatchLoading={formProductMatchLoading}
          productMatchMessage={formProductMatchMessage}
          productMatches={formProductMatches}
          optionalResponsibilities={analysisDraft?.optionalResponsibilities || []}
          selectedFamilyId={entryFamilyId}
          selectedFamilyMembers={Array.isArray(entrySelectedFamily?.members) ? entrySelectedFamily.members : []}
          onFileChange={handleFileChange}
          onCreateFamily={() => void handleCreateFamilyProfile()}
          onOcrTextChange={handleOcrTextChange}
          onScanClick={handleScanClick}
          onSelectFamily={handleSelectFamily}
          onSelectFormCompany={(company) => updateForm('company', company)}
          onSelectFormProduct={(suggestion) => selectFormProductSuggestion(suggestion)}
          onSelectPlanProduct={selectPolicyPlanProduct}
          onSelectProductMatch={selectFormProductMatch}
          onSubmit={handleSubmit}
          onAddPlan={addPolicyPlan}
          onRemovePlan={removePolicyPlan}
          onUpdatePlan={updatePolicyPlan}
          onUpdatePlanProductQuery={updatePolicyPlanProductQuery}
          onUpdateForm={updateForm}
          onUpdateOptionalResponsibility={updateAnalysisOptionalResponsibility}
          isLoggedIn={isLoggedIn}
          mobile={mobile}
          onOpenAccount={() => setShowAccountSheet(true)}
          onOpenFamilies={() => setActiveTab('families')}
          uploadItem={uploadItem}
          fileInputRef={fileInputRef}
          staleClientDetected={Boolean(staleClientHealth)}
          onReloadForLatestVersion={() => window.location.reload()}
        />
        {renderResponsibilityAssistant('bottom-24')}
        {authDialog}
        {accountSheet}
        {cashValueDialog}
      </>
    );
  }

  if (cashflowMember) {
    return (
      <CashflowDetailPage
        member={cashflowMember}
        policies={policies}
        cashValueDialog={cashValueDialog}
        onBack={() => setCashflowMember(null)}
        onUploadCashValue={(policyId) => {
          setCashValuePolicyId(policyId);
          setCashValueDialogOpen(true);
        }}
      />
    );
  }

  if (showFamilyPolicies) {
    return (
      <div className="min-h-screen bg-slate-50 pb-28">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white/80 px-4 py-4 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:bg-slate-200"
              onClick={() => setShowFamilyPolicies(false)}
            >
              <ArrowLeft size={16} />
              返回
            </button>
          </div>
          <button
            className="flex max-w-[148px] items-center gap-2 rounded-full bg-slate-100 px-3 py-2 text-xs font-black text-slate-700 transition-colors hover:bg-slate-200"
            type="button"
            onClick={() => setShowAccountSheet(true)}
            aria-label="查看账号"
          >
            <CircleUserRound size={18} />
            <span className="truncate">{isLoggedIn ? maskMobile(mobile) : '游客'}</span>
          </button>
        </header>

        <main className="overflow-y-auto">
          <div className="px-4 pt-4">
            <div className="w-full overflow-hidden rounded-[28px] bg-gradient-to-br from-sky-600 via-cyan-500 to-emerald-400 p-5 text-left text-white shadow-[0_18px_40px_-18px_rgba(14,165,233,0.75)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase text-white/70">Policy OCR</p>
                  <h2 className="mt-2 text-2xl font-black leading-tight">家庭保单</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-white/85">{message}</p>
                </div>
                <div className="rounded-2xl bg-white/15 p-3">
                  <Sparkles size={28} />
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-white/15 px-4 py-3">
                  <p className="text-xs text-white/70">已录入</p>
                  <p className="mt-1 text-xl font-black">{selectedFamilyPolicies.length} 张</p>
                </div>
                <div className="rounded-2xl bg-white/15 px-4 py-3">
                  <p className="text-xs text-white/70">总保额</p>
                  <p className="mt-1 text-xl font-black">{formatCoverageAmount(familyTotalCoverage)}</p>
                </div>
              </div>
            </div>
          </div>

          <FamilyCoverageOverview
            report={familyReport}
            policies={selectedFamilyPolicies}
          />

          {selectedFamilyPolicies.length ? (
            <section className="px-4 pt-3">
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-[20px] border border-[#D9E6F4] bg-white px-4 py-3 text-left shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]"
                onClick={() => setShowFamilyReport(true)}
              >
                <span>
                  <span className="block text-sm font-black text-[#0F172A]">家庭保障分析报告</span>
                  <span className="mt-1 block text-xs font-semibold text-[#7890AA]">全家统计、保单清单、重疾、意外、财富分析</span>
                </span>
                <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-600">查看</span>
              </button>
            </section>
          ) : null}

          <section className="space-y-4 p-4">
            {!selectedFamilyPolicies.length ? (
              <div className="rounded-[24px] border border-dashed border-[#D6E4F5] bg-white px-5 py-10 text-center shadow-[0_18px_34px_-30px_rgba(15,23,42,0.12)]">
                <p className="text-base font-semibold text-[#0F172A]">还没有家庭保单</p>
                <p className="mt-2 text-sm leading-6 text-[#6C87A5]">录入保单并绑定家庭后，会在这里统一查看家庭保单责任和保障明细。</p>
                <button
                  className="mt-5 rounded-2xl bg-blue-500 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/20"
                  type="button"
                  onClick={() => startEntryForm()}
                >
                  去录入第一张保单
                </button>
              </div>
            ) : null}
            {familyPolicyGroups.map((group) => (
              <section key={group.insured} className="rounded-[24px] border border-[#D9E6F4] bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-black text-[#0F172A]">{group.insured}</h3>
                    <p className="mt-1 text-xs font-medium text-[#7890AA]">
                      {group.policies.length} 张保单 · 总保额 {formatCoverageAmount(group.totalCoverage)}
                    </p>
                  </div>
                  <span className="rounded-full bg-[#EEF4FF] px-3 py-1 text-xs font-bold text-[#1152D4]">被保人</span>
                </div>
                <div className="space-y-3">
                  {group.policies.map((policy, index) => (
                    <PolicyListItem
                      key={policy.id}
                      policy={policy}
                      index={index}
                      onOpen={() => void openPolicy(policy)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>
        </main>

        {selectedPolicy ? (
          <PolicyDetailSheet
            policy={selectedPolicy}
            onClose={() => setSelectedPolicy(null)}
            onRetryReport={retryPolicyReport}
            retrying={retryingPolicyId === selectedPolicy.id}
            onUpdatePolicy={handleUpdatePolicy}
            onUpdateOptionalResponsibility={handleUpdateOptionalResponsibility}
            updating={savingPolicyId === selectedPolicy.id}
            onDeletePolicy={handleDeletePolicy}
            deleting={deletingPolicyId === selectedPolicy.id}
            onEditCashValue={openManualCashValueEditor}
          />
        ) : null}
        {authDialog}
        {accountSheet}
        {cashValueDialog}
      </div>
    );
  }

  if (activeTab === 'families') {
    return (
      <>
        <FamilyProfileManager
          familyProfiles={familyProfiles}
          familyPolicyCounts={familyPolicyCounts}
          selectedFamilyId={selectedFamilyId}
          onSelectFamily={(familyId) => handleSelectFamily(familyId)}
          onCreateFamily={async (familyName) => {
            await createFamilyProfileByName(familyName);
          }}
          onSetCoreMember={setCoreMemberForCurrentFamily}
          onUpdateFamilyMemberRelation={updateFamilyMemberRelationForFamily}
          onBackToEntry={() => {
            startEntryForm({ preserveSelectedFamily: true });
          }}
          onOpenReport={openFamilyReport}
          onViewFamilyPolicies={viewFamilyPolicies}
        />
        <CustomerBottomTabs activeTab={activeTab} onChange={setActiveTab} />
        {authDialog}
        {accountSheet}
        {cashValueDialog}
      </>
    );
  }

  return null;
}
