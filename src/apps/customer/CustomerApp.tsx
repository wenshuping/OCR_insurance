import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  CircleUserRound,
  Copy,
  Download,
  MessageSquareText,
  SendHorizontal,
  Shield,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
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
  FamilyMemberPolicyReference,
  FamilyPolicyAnalysisReport,
  FamilyProfile,
  FamilyReportRecord,
  FamilySalesChatMessage,
  FamilySalesChatThread,
  FamilySalesReview,
  PolicyFormData,
  PolicyKnowledgeMatch,
  PolicyProductSuggestion,
  PolicyScanResult,
  Responsibility,
  UploadItem,
  analyzePolicy,
  confirmCashValue,
  createFamilyMember,
  createFamilyPolicyAnalysisReport,
  createFamilyProfile,
  createFamilyReportShare,
  createFamilySalesChatThread,
  createFamilySalesReview,
  deleteFamilyMember,
  deleteFamilyProfile,
  deletePolicy,
  getFamilyPolicyAnalysisReport,
  getFamilyReportRecord,
  getFamilySalesReview,
  listFamilySalesChatThreads,
  getHealthStatus,
  getLocalPolicyAnalysisDraft,
  getPolicy,
  getProductCustomerResponsibilitySummary,
  listPolicies,
  listFamilyProfiles,
  listPolicyResponsibilityCompanySuggestions,
  listPolicyResponsibilityProductSuggestions,
  logClientPerformance,
  logoutCustomer,
  matchPolicyResponsibilities,
  queryPolicyResponsibilities,
  register,
  regenerateFamilyReportRecord,
  regeneratePolicyReport,
  recognizePolicy,
  scanCashValue,
  scanPolicy,
  scanPolicyProductKnowledge,
  sendCode,
  sendFamilySalesChatMessage,
  setFamilyCoreMember,
  updateFamilyProfile,
  updateFamilyMember,
  updateFamilyMemberRelation,
  updatePolicy,
  CustomerResponsibilitySummary,
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
  buildUploadItemOrientationAttempts,
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
  CreateFamilyProfileDialog,
} from '../../features/family-profile/CreateFamilyProfileDialog';
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
  confirmMockMembershipOrder,
  createMembershipOrder,
  getMembershipStatus,
  startMembershipWechatOAuth,
  type MembershipStatus,
  type WechatPayParams,
} from '../../api/contracts/membership';
import { MembershipPurchaseDialog } from '../../features/customer-membership/MembershipPurchaseDialog';
import {
  CustomerBottomTabs,
  type CustomerTab,
} from '../../features/customer-navigation/CustomerBottomTabs';
import { CashflowDetailPage } from '../../features/cashflow/CashflowDetailPage';
import { CashValueDialog } from '../../features/cash-value/CashValueDialog';
import { FamilyCoverageOverview } from '../../features/family-report/FamilyCoverageOverview';
import { FamilySalesReviewMarkdown } from '../../features/family-report/FamilySalesReviewMarkdown';
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
  sharePolicyPersonInfo,
  syncMainPolicyPlanFields,
  updateOptionalResponsibilityItems,
  validatePolicyEntryForm,
} from '../../shared/customer-policy-form';
import {
  appendCashValueRowsSequentially,
  makeManualCashValueRow,
  nextManualCashValueRow,
  normalizeCashValueRowsForEditing,
  normalizeCashValueRowsForSaving,
  parseNumericInput,
} from '../../shared/customer-cash-value';

const GUEST_ID_KEY = 'policy-ocr-app.guestId';
const TOKEN_KEY = 'policy-ocr-app.token';
const USER_MOBILE_KEY = 'policy-ocr-app.mobile';
const FAMILY_SALES_REVIEW_RESTORE_KEY = 'policy-ocr-app.familySalesReviewFamilyId';
const CLIENT_BOOTED_AT = new Date().toISOString();
const CURRENT_CLIENT_ASSET_PATH = currentClientAssetPath();
const SHOULD_CHECK_STALE_CLIENT = Boolean(CURRENT_CLIENT_ASSET_PATH) || window.location.port === '3014';
const CASH_VALUE_ROTATION_RETRY_ERRORS = new Set(['CASH_VALUE_TABLE_NOT_DETECTED', 'PARSE_FAILED', 'POLICY_OCR_EMPTY']);

declare global {
  interface Window {
    __wxjs_environment?: string;
  }
}

function currentClientAssetPath() {
  const script = document.querySelector('script[src*="/assets/index-"]');
  return script?.getAttribute('src')?.split('?')[0] || '';
}

function clientAssetPathFromHtml(html: string) {
  return html.match(/\/assets\/index-[^"']+\.js/u)?.[0] || '';
}

function reloadOnceForClientAsset(latestAssetPath: string) {
  const marker = `policy-ocr-app.reload:${latestAssetPath}`;
  if (sessionStorage.getItem(marker)) return false;
  sessionStorage.setItem(marker, '1');
  window.location.reload();
  return true;
}

function shouldRetryCashValueScanWithRotatedImage(result: CashValueScanResult | null) {
  if (!result || result.ok) return false;
  const error = String(result.error || '');
  const message = String(result.message || '');
  return CASH_VALUE_ROTATION_RETRY_ERRORS.has(error)
    || /未检测到现金价值表表头|解析结果不可靠|未识别到有效行|POLICY_OCR_EMPTY/u.test(message);
}

function normalizeProductCode(value: unknown) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{1,23}$/u.test(text) ? text : '';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendProductCodeDisplayName(name: string, code: string) {
  const normalizedName = String(name || '').trim();
  const normalizedCode = normalizeProductCode(code);
  if (!normalizedName || !normalizedCode) return normalizedName;
  if (new RegExp(`[（(]\\s*${escapeRegExp(normalizedCode)}\\s*[)）]`, 'u').test(normalizedName)) return normalizedName;
  return `${normalizedName}（${normalizedCode}）`;
}

function productSuggestionDisplayName(suggestion: PolicyProductSuggestion) {
  return appendProductCodeDisplayName(suggestion.productName, suggestion.productCode || suggestion.productCodes?.[0] || '');
}

function policyKnowledgeMatchDisplayName(match: PolicyKnowledgeMatch) {
  return appendProductCodeDisplayName(
    match.resolvedProductName || match.productName,
    match.productCode || match.productCodes?.[0] || match.bestSource?.productCode || match.bestSource?.productCodes?.[0] || '',
  );
}

function productSuggestionToKnowledgeMatch(
  suggestion: PolicyProductSuggestion,
  queryName: string,
  index: number,
): PolicyKnowledgeMatch {
  const productName = suggestion.productName.trim();
  const recordCount = Number(suggestion.recordCount || 0);
  const exactNameMatch = productName === queryName.trim();
  return {
    company: suggestion.company.trim(),
    productName,
    canonicalProductId: suggestion.canonicalProductId,
    productCode: suggestion.productCode,
    productCodes: suggestion.productCodes,
    title: productName,
    score: exactNameMatch ? 1 : Math.max(0.5, 0.72 - index * 0.04),
    matchReason: exactNameMatch ? '产品名称高度匹配' : '本地产品候选',
    evidenceLabel: '本地产品库',
    sourceCount: recordCount > 0 ? recordCount : 1,
    bestSource: {
      title: '本地产品资料',
      productCode: suggestion.productCode,
      productCodes: suggestion.productCodes,
    },
  };
}

function isExternalResponsibilityReference(match: PolicyKnowledgeMatch) {
  return Boolean(
    match.responsibilityDeferred ||
      match.referenceOnly ||
      match.bestSource?.responsibilityDeferred ||
      match.bestSource?.referenceOnly ||
      match.verificationStatus === 'pending_review' ||
      match.bestSource?.verificationStatus === 'pending_review' ||
      match.evidenceLevel === 'external_legacy_reference' ||
      match.bestSource?.evidenceLevel === 'external_legacy_reference' ||
      match.sourceKind === 'legacy_external_reference' ||
      match.sourceKind === 'open_web_reference',
  );
}

function assistantMatchKey(match: PolicyKnowledgeMatch) {
  return [
    match.company.trim(),
    (match.resolvedProductName || match.productName).trim(),
    match.sourceKind || '',
    match.bestSource?.url || '',
  ].join('\u001f');
}

const emptyForm: PolicyFormData = {
  company: '',
  name: '',
  canonicalProductId: '',
  applicant: '',
  applicantBirthday: '',
  beneficiary: '',
  beneficiaryRelation: '',
  beneficiaryBirthday: '',
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

function chooseFamilyMemberByName(members: FamilyMember[], name: string, coreMemberId?: number | null) {
  const normalizedName = name.trim();
  if (!normalizedName) return null;
  const matches = (Array.isArray(members) ? members : []).filter((member) => (
    member.status === 'active' &&
    areSameParticipantName(member.name, normalizedName)
  ));
  return matches.sort((left, right) => (
    (Number(right.id) === Number(coreMemberId || 0) ? 1 : 0) -
      (Number(left.id) === Number(coreMemberId || 0) ? 1 : 0) ||
    (right.relationLabel && right.relationLabel !== '待确认' ? 1 : 0) -
      (left.relationLabel && left.relationLabel !== '待确认' ? 1 : 0) ||
    (right.birthday ? 1 : 0) - (left.birthday ? 1 : 0) ||
    (right.idNumberTail ? 1 : 0) - (left.idNumberTail ? 1 : 0) ||
    Number(left.id || 0) - Number(right.id || 0)
  ))[0] || null;
}

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

function policyAnalysisReportFromRecord(record: FamilyReportRecord | null): FamilyPolicyAnalysisReport | null {
  const report = record?.report?.familyPolicyAnalysisReport;
  if (!report) return null;
  return {
    status: report.status || 'complete',
    content: report.content || '',
    model: report.model || '',
    generatedAt: report.generatedAt || record.updatedAt || record.generatedAt || '',
    error: report.error || '',
  };
}

export function CustomerApp() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const productKnowledgeFileInputRef = useRef<HTMLInputElement | null>(null);
  const productKnowledgeReplaceIndexRef = useRef<number | null>(null);
  const familySalesReviewReportRef = useRef<HTMLDivElement | null>(null);
  const formProductDraftRequestRef = useRef(0);
  const membershipStatusRequestRef = useRef(0);
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
  const [policiesLoaded, setPoliciesLoaded] = useState(false);
  const [familyProfiles, setFamilyProfiles] = useState<FamilyProfile[]>([]);
  const [familyCreateDialogOpen, setFamilyCreateDialogOpen] = useState(false);
  const [familyCreateLoading, setFamilyCreateLoading] = useState(false);
  const [familyCreateMessage, setFamilyCreateMessage] = useState('');
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
  const [authMessage, setAuthMessage] = useState('录入或上传保单前需要先验证手机号');
  const [authLoading, setAuthLoading] = useState(false);
  const [authDevCode, setAuthDevCode] = useState('');
  const [membershipStatus, setMembershipStatus] = useState<MembershipStatus | null>(null);
  const [showMembershipDialog, setShowMembershipDialog] = useState(false);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipMessage, setMembershipMessage] = useState('');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantCompany, setAssistantCompany] = useState('');
  const [assistantName, setAssistantName] = useState('');
  const [assistantAnalysis, setAssistantAnalysis] = useState<PolicyAnalysisResult | null>(null);
  const [assistantCustomerSummary, setAssistantCustomerSummary] = useState<CustomerResponsibilitySummary | null>(null);
  const [assistantCustomerSummaryLoading, setAssistantCustomerSummaryLoading] = useState(false);
  const [assistantCustomerSummaryMessage, setAssistantCustomerSummaryMessage] = useState('');
  const [assistantMatches, setAssistantMatches] = useState<PolicyKnowledgeMatch[]>([]);
  const [assistantSelectedMatchKey, setAssistantSelectedMatchKey] = useState('');
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
  const [formProductMatchStatus, setFormProductMatchStatus] = useState<'exact' | 'candidates' | 'not_found' | 'source_review_required' | ''>('');
  const [productKnowledgeUploading, setProductKnowledgeUploading] = useState(false);
  const [productKnowledgeUploadCount, setProductKnowledgeUploadCount] = useState(0);
  const [productKnowledgeUploadItems, setProductKnowledgeUploadItems] = useState<UploadItem[]>([]);
  const [baseScanResult, setBaseScanResult] = useState<PolicyScanResult | null>(null);
  const [baseAnalysisDraft, setBaseAnalysisDraft] = useState<PolicyAnalysisResult | null>(null);
  const [confirmedProductMatchKey, setConfirmedProductMatchKey] = useState('');
  const [cashflowMember, setCashflowMember] = useState<string | null>(null);
  const [showFamilyReport, setShowFamilyReport] = useState(false);
  const [savedFamilyReportRecord, setSavedFamilyReportRecord] = useState<FamilyReportRecord | null>(null);
  const [familyReportLoading, setFamilyReportLoading] = useState(false);
  const [familyPolicyAnalysisReport, setFamilyPolicyAnalysisReport] = useState<FamilyPolicyAnalysisReport | null>(null);
  const [familyPolicyAnalysisLoading, setFamilyPolicyAnalysisLoading] = useState(false);
  const [familySalesReviewOpen, setFamilySalesReviewOpen] = useState(false);
  const [familySalesReviewFamilyId, setFamilySalesReviewFamilyId] = useState<number | null>(null);
  const [familySalesReview, setFamilySalesReview] = useState<FamilySalesReview | null>(null);
  const [familySalesReviewLoading, setFamilySalesReviewLoading] = useState(false);
  const familySalesReviewLoadingRef = useRef(false);
  const familySalesReviewRestoreAttemptRef = useRef(false);
  const [familySalesReviewProgress, setFamilySalesReviewProgress] = useState(0);
  const [familySalesReviewMessage, setFamilySalesReviewMessage] = useState('');
  const [familySalesChatThreads, setFamilySalesChatThreads] = useState<FamilySalesChatThread[]>([]);
  const [familySalesChatThread, setFamilySalesChatThread] = useState<FamilySalesChatThread | null>(null);
  const [familySalesChatMessages, setFamilySalesChatMessages] = useState<FamilySalesChatMessage[]>([]);
  const [familySalesChatInput, setFamilySalesChatInput] = useState('');
  const [familySalesChatLoading, setFamilySalesChatLoading] = useState(false);
  const [familySalesChatMessage, setFamilySalesChatMessage] = useState('');
  const [familySalesChatReviewMessageIds, setFamilySalesChatReviewMessageIds] = useState<number[]>([]);
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
  const selectedFamily = useMemo(
    () => familyProfiles.find((family) => Number(family.id) === Number(selectedFamilyId)) || null,
    [familyProfiles, selectedFamilyId],
  );
  const selectedFamilyPolicySummary = selectedFamily?.policySummary || null;
  const familyPolicyCount = Number(selectedFamilyPolicySummary?.policyCount ?? selectedFamilyPolicies.length);
  const familyTotalCoverage = Number(selectedFamilyPolicySummary?.totalCoverage ?? selectedFamilyPolicies.reduce((sum, policy) => sum + Number(policy.amount || 0), 0));
  const familyPolicyGroups = useMemo(() => groupPoliciesByInsured(selectedFamilyPolicies), [selectedFamilyPolicies]);
  const familyReport = useMemo(
    () => buildFamilyReport(selectedFamilyPolicies, familyPlanningProfile, { familyId: selectedFamilyId }),
    [selectedFamilyPolicies, familyPlanningProfile, selectedFamilyId],
  );
  const displayFamilyReport = savedFamilyReportRecord?.report || familyReport;
  const familySalesReviewFamily = useMemo(
    () => familyProfiles.find((family) => Number(family.id) === Number(familySalesReviewFamilyId)) || null,
    [familyProfiles, familySalesReviewFamilyId],
  );
  useEffect(() => {
    if (!selectedFamily?.planningProfile) return;
    setFamilyPlanningProfile(saveFamilyPlanningProfile(selectedFamily.planningProfile));
  }, [selectedFamily?.planningProfile]);
  useEffect(() => {
    if (familySalesReviewRestoreAttemptRef.current || familySalesReviewOpen) return;
    const restoredFamilyId = Number(sessionStorage.getItem(FAMILY_SALES_REVIEW_RESTORE_KEY) || 0);
    if (!restoredFamilyId) return;
    if (!familyProfiles.length) return;
    const canRestoreFamily = familyProfiles.some((family) => Number(family.id || 0) === restoredFamilyId);
    if (!canRestoreFamily) {
      familySalesReviewRestoreAttemptRef.current = true;
      sessionStorage.removeItem(FAMILY_SALES_REVIEW_RESTORE_KEY);
      return;
    }
    familySalesReviewRestoreAttemptRef.current = true;
    void openFamilySalesReview(restoredFamilyId);
  }, [familyProfiles, familySalesReviewOpen, guestId, token]);

  function familyReportGenerationMessage(reportRecord: FamilyReportRecord, actionText: string) {
    return String(reportRecord?.source || '').includes('deepseek')
      ? `家庭保障分析报告已${actionText}，DeepSeek质检已完成`
      : `家庭保障分析报告已${actionText}，当前为本地规则结果`;
  }

  const entryFamilyId = formData.familyId ?? selectedFamilyId ?? null;
  const entrySelectedFamily = useMemo(
    () => familyProfiles.find((family) => Number(family.id) === Number(entryFamilyId)) || null,
    [entryFamilyId, familyProfiles],
  );
  const familyPolicyCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    const hasFamilyPolicySummaries = familyProfiles.some((family) => typeof family.policyCount === 'number');
    for (const family of familyProfiles) {
      const familyId = Number(family.id || 0);
      if (!familyId) continue;
      counts[familyId] = (!policiesLoaded && hasFamilyPolicySummaries)
        ? Number(family.policySummary?.policyCount ?? family.policyCount ?? 0)
        : 0;
    }
    if (!policiesLoaded && hasFamilyPolicySummaries) {
      return counts;
    }
    for (const policy of policies) {
      const familyId = Number(policy.familyId || 0);
      if (!familyId) continue;
      counts[familyId] = (counts[familyId] || 0) + 1;
    }
    return counts;
  }, [familyProfiles, policies, policiesLoaded]);
  const familyPolicyMemberIds = useMemo(() => {
    const memberIds: Record<number, number[]> = {};
    for (const policy of policies) {
      const familyId = Number(policy.familyId || 0);
      if (!familyId) continue;
      const ids = memberIds[familyId] || [];
      for (const candidate of [policy.applicantMemberId, policy.insuredMemberId]) {
        const memberId = Number(candidate || 0);
        if (memberId && !ids.includes(memberId)) ids.push(memberId);
      }
      memberIds[familyId] = ids;
    }
    return memberIds;
  }, [policies]);
  const familyMemberPolicyRefs = useMemo(() => {
    const refs: Record<number, Record<number, FamilyMemberPolicyReference[]>> = {};
    for (const policy of policies) {
      const familyId = Number(policy.familyId || 0);
      if (!familyId) continue;
      refs[familyId] = refs[familyId] || {};
      const rolesByMemberId: Record<number, string[]> = {};
      const applicantMemberId = Number(policy.applicantMemberId || 0);
      const insuredMemberId = Number(policy.insuredMemberId || 0);
      if (applicantMemberId) rolesByMemberId[applicantMemberId] = [...(rolesByMemberId[applicantMemberId] || []), '投保人'];
      if (insuredMemberId) rolesByMemberId[insuredMemberId] = [...(rolesByMemberId[insuredMemberId] || []), '被保人'];
      for (const [memberIdText, roles] of Object.entries(rolesByMemberId)) {
        const memberId = Number(memberIdText);
        refs[familyId][memberId] = [
          ...(refs[familyId][memberId] || []),
          {
            id: policy.id,
            company: policy.company || '',
            name: policy.name || '',
            policyNumber: '',
            applicant: policy.applicant || '',
            insured: policy.insured || '',
            roles,
          },
        ];
      }
    }
    return refs;
  }, [policies]);
  useEffect(() => {
    if (!familySalesReviewLoading) return undefined;
    setFamilySalesReviewProgress((current) => (current > 0 ? current : 12));
    const progressTimer = window.setInterval(() => {
      setFamilySalesReviewProgress((current) => {
        if (current >= 92) return current;
        if (current < 38) return current + 8;
        if (current < 68) return current + 5;
        return current + 2;
      });
    }, 900);
    return () => window.clearInterval(progressTimer);
  }, [familySalesReviewLoading]);
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
    setSavedFamilyReportRecord(null);
  }

  async function refreshPolicies(nextToken = token) {
    const payload = await listPolicies({ token: nextToken || undefined, guestId: nextToken ? undefined : guestId });
    setPolicies(payload.policies);
    setPoliciesLoaded(true);
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
    return families;
  }

  async function refreshMembershipStatus(nextToken = token) {
    const requestId = membershipStatusRequestRef.current + 1;
    membershipStatusRequestRef.current = requestId;
    if (!nextToken) {
      setMembershipStatus(null);
      return null;
    }
    const payload = await getMembershipStatus(nextToken);
    if (membershipStatusRequestRef.current === requestId && localStorage.getItem(TOKEN_KEY) === nextToken) {
      setMembershipStatus(payload);
    }
    return payload;
  }

  function invokeWechatPay(payParams: WechatPayParams) {
    return new Promise<'ok' | 'cancel' | 'fail'>((resolve) => {
      const bridge = (window as Window & {
        WeixinJSBridge?: {
          invoke: (name: string, params: WechatPayParams, cb: (res: { err_msg?: string }) => void) => void;
        };
      }).WeixinJSBridge;
      if (!bridge) {
        resolve('fail');
        return;
      }
      bridge.invoke('getBrandWCPayRequest', payParams, (res) => {
        const bridgeMessage = String(res?.err_msg || '');
        if (bridgeMessage.includes(':ok')) resolve('ok');
        else if (bridgeMessage.includes(':cancel')) resolve('cancel');
        else resolve('fail');
      });
    });
  }

  function membershipPurchaseErrorMessage(error: unknown) {
    if (error instanceof ApiError) {
      if (error.code === 'WECHAT_PAY_NOT_CONFIGURED') return '会员支付暂未开放';
      if (error.code === 'MEMBERSHIP_PURCHASE_DISABLED') return '会员购买暂未开放';
      if (error.code === 'WECHAT_BROWSER_REQUIRED') return '请在微信内打开公众号页面完成支付';
    }
    return error instanceof Error ? error.message : '会员购买失败';
  }

  async function handleMembershipPurchase() {
    if (!token || membershipLoading) return;
    setMembershipLoading(true);
    setMembershipMessage('正在创建会员订单');
    try {
      const created = await createMembershipOrder(token);
      if (created.payParams.appId === 'mock-wechat-appid') {
        await confirmMockMembershipOrder(token, created.order.id);
        await refreshMembershipStatus(token);
        setMembershipMessage('会员已开通');
        return;
      }
      setMembershipMessage('请在微信中确认支付');
      const result = await invokeWechatPay(created.payParams);
      setMembershipMessage(result === 'ok' ? '支付确认中，请稍候刷新' : result === 'cancel' ? '已取消支付' : '支付未完成，请重试');
      await refreshMembershipStatus(token);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WECHAT_OPENID_REQUIRED') {
        const started = await startMembershipWechatOAuth(token, `${window.location.pathname}${window.location.hash}`);
        window.location.href = started.authorizeUrl;
        return;
      }
      setMembershipMessage(membershipPurchaseErrorMessage(error));
    } finally {
      setMembershipLoading(false);
    }
  }

  function clearCustomerSession(nextMessage = '已退出登录，当前为游客模式') {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_MOBILE_KEY);
    sessionStorage.removeItem(FAMILY_SALES_REVIEW_RESTORE_KEY);
    setToken('');
    setMobile('');
    setAuthMobile('');
    setAuthCode('');
    setAuthDevCode('');
    setShowAuthDialog(false);
    setShowAccountSheet(false);
    membershipStatusRequestRef.current += 1;
    setMembershipStatus(null);
    setShowMembershipDialog(false);
    setMembershipMessage('');
    setSelectedPolicy(null);
    setPolicies([]);
    setPoliciesLoaded(false);
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
    setPoliciesLoaded(false);
    Promise.all([refreshPolicies(), refreshFamilyProfiles(), refreshMembershipStatus()]).catch((error) => {
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
    if (!SHOULD_CHECK_STALE_CLIENT) return;
    let cancelled = false;
    const checkClientFreshness = async () => {
      try {
        if (CURRENT_CLIENT_ASSET_PATH) {
          const response = await fetch(`/?clientFreshness=${Date.now()}`, { cache: 'no-store' });
          const latestAssetPath = clientAssetPathFromHtml(await response.text());
          if (cancelled) return;
          if (latestAssetPath && latestAssetPath !== CURRENT_CLIENT_ASSET_PATH) {
            if (reloadOnceForClientAsset(latestAssetPath)) return;
            setStaleClientHealth({ ok: true, service: 'policy-ocr-app', startedAt: CLIENT_BOOTED_AT });
            return;
          }
        }
        if (window.location.port === '3014') {
          const health = await getHealthStatus();
          if (cancelled) return;
          const serverStartedAt = Date.parse(String(health.startedAt || ''));
          const clientStartedAt = Date.parse(CLIENT_BOOTED_AT);
          if (Number.isFinite(serverStartedAt) && Number.isFinite(clientStartedAt) && serverStartedAt > clientStartedAt + 1000) {
            setStaleClientHealth(health);
            return;
          }
        }
        if (!cancelled) {
          setStaleClientHealth(null);
        }
      } catch {
        if (cancelled) return;
        if (window.location.port === '3014') {
          setStaleClientHealth(null);
          return;
        }
      }
    };

    void checkClientFreshness();
    const timer = window.setInterval(() => {
      void checkClientFreshness();
    }, window.location.port === '3014' ? 5000 : 30000);
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
      setFormProductMatchStatus('');
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setFormProductMatchLoading(true);
      setFormProductMatchMessage('');
      try {
        const payload = await matchPolicyResponsibilities({ company, name });
        if (cancelled) return;
        let matches = Array.isArray(payload.matches) ? payload.matches : [];
        const matchStatus = payload.status || (matches.length ? 'candidates' : 'not_found');
        if (!matches.length) {
          const suggestionPayload = await listPolicyResponsibilityProductSuggestions({ company, q: name, limit: 3 });
          if (cancelled) return;
          matches = (Array.isArray(suggestionPayload.suggestions) ? suggestionPayload.suggestions : [])
            .slice(0, 3)
            .map((suggestion, index) => productSuggestionToKnowledgeMatch(suggestion, name, index));
        }
        setFormProductMatches(matches);
        setFormProductMatchStatus(matchStatus);
        setFormProductMatchMessage(matches.length ? '' : '本地暂无匹配候选，生成时将继续查找官方资料');
      } catch (error) {
        if (cancelled) return;
        setFormProductMatches([]);
        setFormProductMatchStatus('');
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
      if (['amount', 'firstPremium', 'coveragePeriod', 'paymentPeriod'].includes(key)) {
        const nextValue = key === 'amount' || key === 'firstPremium' ? sanitizeAmount(String(value || '')) : String(value || '');
        return {
          ...current,
          [key]: nextValue,
          plans: syncMainPolicyPlanFields(current.plans, current.company, { [key]: nextValue }),
        };
      }
      if (key !== 'company' && key !== 'name') {
        const next = { ...current, [key]: value };
        if (['applicant', 'insured', 'beneficiary', 'applicantBirthday', 'insuredBirthday', 'beneficiaryBirthday', 'insuredIdNumber'].includes(key)) {
          return autoBindEntryMembersByName(next);
        }
        return next;
      }
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
	        ...(key === 'name' ? { matchedProductName: '', canonicalProductId: '', productCode: '', productCodes: [] } : {}),
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
    const productCode = normalizeProductCode(suggestion.productCode || suggestion.productCodes?.[0] || '');
    const productCodes = Array.isArray(suggestion.productCodes) ? suggestion.productCodes.map(normalizeProductCode).filter(Boolean) : [];
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
        productCode,
        productCodes: productCodes.length ? productCodes : productCode ? [productCode] : [],
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
    setFormProductMatchStatus('');
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
    setSavedFamilyReportRecord(null);
    setFamilyPolicyAnalysisReport(null);
    const family = familyProfiles.find((item) => Number(item.id) === Number(familyId || 0));
    if (family?.planningProfile) {
      setFamilyPlanningProfile(saveFamilyPlanningProfile(family.planningProfile));
    }
    setFormData((current) => ({
      ...current,
      familyId,
      applicantMemberId: familyId === current.familyId ? current.applicantMemberId ?? null : null,
      insuredMemberId: familyId === current.familyId ? current.insuredMemberId ?? null : null,
    }));
  }

  async function openFamilyReport(familyId: number) {
    handleSelectFamily(familyId);
    setFamilyReportLoading(true);
    setMessage('正在加载家庭保障分析报告');
    setShowFamilyReport(true);
    try {
      const loaded = await getFamilyReportRecord({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId,
      });
      if (!loaded.reportRecord) {
        setMessage('暂无已保存家庭保障分析报告，可在报告页点击重新生成');
        return;
      }
      setSavedFamilyReportRecord(loaded.reportRecord);
      const analysis = await getFamilyPolicyAnalysisReport({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId,
      });
      setFamilyPolicyAnalysisReport(analysis.analysisReport);
      setMessage(familyReportGenerationMessage(loaded.reportRecord, '加载'));
    } catch (error) {
      setSavedFamilyReportRecord(null);
      setFamilyPolicyAnalysisReport(null);
      setMessage(error instanceof Error ? error.message : '家庭报告加载失败，已展示本地预览');
    } finally {
      setFamilyReportLoading(false);
    }
  }

  async function regenerateFamilyReport() {
    if (!selectedFamilyId) {
      setMessage('请先选择家庭档案');
      return;
    }
    if (familyReportLoading) return;
    setFamilyReportLoading(true);
    setMessage('正在重新生成家庭保障分析报告');
    try {
      const generated = await regenerateFamilyReportRecord({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId: selectedFamilyId,
        planningProfile: familyPlanningProfile,
        userRefresh: true,
      });
      setSavedFamilyReportRecord(generated.reportRecord);
      setFamilyPolicyAnalysisReport(policyAnalysisReportFromRecord(generated.reportRecord));
      setMessage(familyReportGenerationMessage(generated.reportRecord, '重新生成'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '家庭报告重新生成失败');
    } finally {
      setFamilyReportLoading(false);
    }
  }

  async function generateFamilyPolicyAnalysisReport() {
    if (!selectedFamilyId) {
      setMessage('请先选择家庭档案');
      return;
    }
    if (familyPolicyAnalysisLoading) return;
    setFamilyPolicyAnalysisLoading(true);
    setMessage('正在生成家庭保单分析报告');
    try {
      setFamilyPolicyAnalysisReport(null);
      const generated = await createFamilyPolicyAnalysisReport({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId: selectedFamilyId,
        planningProfile: familyPlanningProfile,
      });
      setFamilyPolicyAnalysisReport(generated.analysisReport);
      setMessage('家庭保单分析报告已生成');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '家庭保单分析报告生成失败';
      setFamilyPolicyAnalysisReport({
        status: 'failed',
        content: '',
        generatedAt: new Date().toISOString(),
        error: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      setFamilyPolicyAnalysisLoading(false);
    }
  }

  async function handleShareFamilyReport(familyId = selectedFamilyId) {
    if (!familyId) {
      setMessage('请先选择家庭档案');
      return;
    }
    try {
      const created = await createFamilyReportShare({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId,
      });
      const shareUrl = `${window.location.origin}${window.location.pathname}#/family-share/${created.share.token}`;
      await navigator.clipboard.writeText(shareUrl);
      setMessage(`分享链接：${shareUrl}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '家庭报告分享失败');
    }
  }

  function viewFamilyPolicies(familyId: number) {
    handleSelectFamily(familyId);
    setShowFamilyPolicies(true);
  }

  function closeFamilySalesReview() {
    sessionStorage.removeItem(FAMILY_SALES_REVIEW_RESTORE_KEY);
    setFamilySalesReviewOpen(false);
  }

  function familySalesReviewFailureMessage(error: unknown) {
    const text = error instanceof Error ? error.message : '';
    if (/DeepSeek|API Key|FAMILY_SALES_REVIEW_PROVIDER_NOT_READY|未配置/iu.test(text)) {
      return '专家分析服务暂不可用，请联系管理员完成专家系统配置';
    }
    if (/timeout|超时/iu.test(text)) return '专家研判耗时较长，请稍后重试';
    return text ? `专家分析暂时未完成：${text}` : '专家分析暂时未完成，请稍后重试';
  }

  function setFamilySalesReviewBusy(loading: boolean) {
    familySalesReviewLoadingRef.current = loading;
    setFamilySalesReviewLoading(loading);
    setFamilySalesReviewProgress((current) => {
      if (loading) return current > 0 && current < 100 ? current : 12;
      return current >= 92 ? 100 : current;
    });
  }

  async function openFamilySalesReview(familyId: number) {
    sessionStorage.setItem(FAMILY_SALES_REVIEW_RESTORE_KEY, String(familyId));
    if (familySalesReviewLoadingRef.current) {
      handleSelectFamily(familyId);
      setFamilySalesReviewFamilyId(familyId);
      setFamilySalesReviewOpen(true);
      setFamilySalesReviewMessage('专家系统仍在生成中，完成后会自动保存');
      return;
    }
    handleSelectFamily(familyId);
    setFamilySalesReviewFamilyId(familyId);
    setFamilySalesReviewOpen(true);
    setFamilySalesReview(null);
    setFamilySalesChatThreads([]);
    setFamilySalesChatThread(null);
    setFamilySalesChatMessages([]);
    setFamilySalesChatInput('');
    setFamilySalesChatMessage('');
    setFamilySalesChatReviewMessageIds([]);
    setFamilySalesReviewProgress(0);
    setFamilySalesReviewMessage('正在读取已保存的专家报告');
    try {
      const authInput = {
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId,
      };
      const saved = await getFamilySalesReview(authInput);
      if (saved.review?.content) {
        setFamilySalesReview(saved.review);
        setFamilySalesReviewMessage('已读取最近一次专家研判');
        await loadFamilySalesChatThreads(familyId);
        return;
      }
      setFamilySalesReviewMessage('暂无已保存销售建议，可点击生成');
      await loadFamilySalesChatThreads(familyId);
    } catch (error) {
      setFamilySalesReviewMessage(familySalesReviewFailureMessage(error));
    } finally {
      setFamilySalesReviewBusy(false);
    }
  }

  async function regenerateFamilySalesReview() {
    if (familySalesReviewLoadingRef.current) {
      setFamilySalesReviewMessage('专家系统仍在生成中，完成后会自动保存');
      return;
    }
    if (!familySalesReviewFamilyId) {
      setFamilySalesReviewMessage('请先选择家庭档案');
      return;
    }
    setFamilySalesReviewBusy(true);
    setFamilySalesReviewMessage('正在请求专家系统生成策略简报');
    try {
      const payload = await createFamilySalesReview({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId: familySalesReviewFamilyId,
        userRefresh: true,
        salesChatMessageIds: familySalesChatReviewMessageIds,
      });
      setFamilySalesReview(payload.review);
      setFamilySalesReviewMessage(familySalesChatReviewMessageIds.length ? '专家研判已按所选续聊内容重算并保存' : '专家研判已完成并保存');
      await loadFamilySalesChatThreads(familySalesReviewFamilyId);
    } catch (error) {
      setFamilySalesReviewMessage(familySalesReviewFailureMessage(error));
    } finally {
      setFamilySalesReviewBusy(false);
    }
  }

  async function loadFamilySalesChatThreads(familyId: number) {
    try {
      const payload = await listFamilySalesChatThreads({
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId,
      });
      setFamilySalesChatThreads(payload.threads || []);
      const latestThread = (payload.threads || [])[0] || null;
      setFamilySalesChatThread(latestThread);
      setFamilySalesChatMessages(Array.isArray(latestThread?.messages) ? latestThread.messages : []);
      setFamilySalesChatReviewMessageIds([]);
      setFamilySalesChatMessage(latestThread ? '已读取最近一次续聊' : '可以围绕这份销售建议继续追问');
    } catch (error) {
      setFamilySalesChatThreads([]);
      setFamilySalesChatThread(null);
      setFamilySalesChatMessages([]);
      setFamilySalesChatReviewMessageIds([]);
      setFamilySalesChatMessage(error instanceof Error ? error.message : '续聊记录读取失败');
    }
  }

  async function submitFamilySalesChat(messageText = familySalesChatInput) {
    const content = messageText.trim();
    if (!content || !familySalesReviewFamilyId || familySalesChatLoading) return;
    setFamilySalesChatLoading(true);
    setFamilySalesChatMessage('正在生成续聊回复');
    setFamilySalesChatInput('');
    try {
      const authInput = {
        token: token || undefined,
        guestId: token ? undefined : guestId,
        familyId: familySalesReviewFamilyId,
      };
      const payload = familySalesChatThread?.id
        ? await sendFamilySalesChatMessage({
          ...authInput,
          threadId: familySalesChatThread.id,
          message: content,
        })
        : await createFamilySalesChatThread({
          ...authInput,
          message: content,
        });
      setFamilySalesChatThread(payload.thread);
      setFamilySalesChatMessages((current) => {
        const byId = new Map(current.map((item) => [Number(item.id), item]));
        for (const item of payload.messages || []) byId.set(Number(item.id), item);
        return Array.from(byId.values()).sort((left, right) => (
          String(left.createdAt || '').localeCompare(String(right.createdAt || '')) ||
          Number(left.id || 0) - Number(right.id || 0)
        ));
      });
      setFamilySalesChatThreads((current) => {
        const next = [payload.thread, ...current.filter((thread) => Number(thread.id) !== Number(payload.thread.id))];
        return next.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
      });
      setFamilySalesChatMessage('续聊回复已生成');
    } catch (error) {
      setFamilySalesChatInput(content);
      setFamilySalesChatMessage(error instanceof Error ? error.message : '续聊生成失败');
    } finally {
      setFamilySalesChatLoading(false);
    }
  }

  async function copyFamilySalesChatMessage(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setFamilySalesChatMessage('已复制续聊内容');
    } catch {
      setFamilySalesChatMessage('复制失败，请手动选择文本复制');
    }
  }

  function toggleFamilySalesChatReviewMessage(messageId: number) {
    setFamilySalesChatReviewMessageIds((current) => {
      if (current.includes(messageId)) return current.filter((id) => id !== messageId);
      if (current.length >= 6) {
        setFamilySalesChatMessage('最多选择 6 条续聊内容用于重算');
        return current;
      }
      return [...current, messageId];
    });
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

  function openFamilyCreateDialog() {
    setFamilyCreateMessage('');
    setFamilyCreateDialogOpen(true);
  }

  async function submitFamilyCreateDialog(familyName: string) {
    setFamilyCreateLoading(true);
    setFamilyCreateMessage('');
    try {
      const family = await createFamilyProfileByName(familyName);
      if (!family) return;
      setFamilyCreateDialogOpen(false);
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : '创建家庭档案失败';
      setFamilyCreateMessage(nextMessage);
      setMessage(nextMessage);
      if (error instanceof ApiError && error.status === 401) {
        clearCustomerSession('登录已失效，请重新验证手机号');
      }
    } finally {
      setFamilyCreateLoading(false);
    }
  }

  function findFamilyMemberByName(name: string) {
    return chooseFamilyMemberByName(entrySelectedFamilyMembers, name, entrySelectedFamily?.coreMemberId);
  }

  function relationLabelForEntryMember(member: FamilyMember) {
    if (Number(member.id) === Number(entrySelectedFamily?.coreMemberId || 0)) return '本人';
    return member.relationLabel || '待确认';
  }

  function namedPolicyPerson(value: unknown) {
    const name = String(value || '').trim();
    return name && name !== '法定' ? name : '';
  }

  function entryPersonInfoByName(familyId: number) {
    const people = new Map<string, { birthday?: string; insuredIdNumber?: string; relationLabel?: string }>();
    const remember = (nameValue: unknown, info: { birthday?: unknown; insuredIdNumber?: unknown; relationLabel?: unknown } = {}) => {
      const name = namedPolicyPerson(nameValue);
      if (!name) return;
      const existing = people.get(name) || {};
      const birthday = String(info.birthday || '').trim();
      const insuredIdNumber = String(info.insuredIdNumber || '').trim();
      const relationLabel = String(info.relationLabel || '').trim();
      if (birthday && !existing.birthday) existing.birthday = birthday;
      if (insuredIdNumber && !existing.insuredIdNumber) existing.insuredIdNumber = insuredIdNumber;
      if (relationLabel && relationLabel !== '待确认' && !existing.relationLabel) existing.relationLabel = relationLabel;
      people.set(name, existing);
    };

    for (const member of entrySelectedFamilyMembers) {
      if (member.status !== 'active') continue;
      remember(member.name, { birthday: member.birthday, relationLabel: relationLabelForEntryMember(member) });
    }
    for (const policy of policies) {
      if (Number(policy.familyId || 0) !== Number(familyId)) continue;
      remember(policy.applicant, {
        birthday: policy.applicantBirthday,
        relationLabel: policy.applicantRelationLabel || policy.applicantRelation,
      });
      remember(policy.insured, {
        birthday: policy.insuredBirthday,
        insuredIdNumber: policy.insuredIdNumber,
        relationLabel: policy.insuredRelationLabel || policy.insuredRelation,
      });
      remember(policy.beneficiary, {
        birthday: policy.beneficiaryBirthday,
        relationLabel: policy.beneficiaryRelation,
      });
    }
    return people;
  }

  function fillEntryPersonInfo(data: PolicyFormData): PolicyFormData {
    const familyId = Number(data.familyId || entryFamilyId || 0);
    const next = sharePolicyPersonInfo(data);
    if (!familyId) return next;
    const people = entryPersonInfoByName(familyId);
    const applicantInfo = people.get(namedPolicyPerson(next.applicant));
    const insuredInfo = people.get(namedPolicyPerson(next.insured));
    const beneficiaryInfo = people.get(namedPolicyPerson(next.beneficiary));
    if (!String(next.applicantBirthday || '').trim() && applicantInfo?.birthday) next.applicantBirthday = applicantInfo.birthday;
    if (!String(next.insuredBirthday || '').trim() && insuredInfo?.birthday) next.insuredBirthday = insuredInfo.birthday;
    if (!String(next.insuredIdNumber || '').trim() && insuredInfo?.insuredIdNumber) next.insuredIdNumber = insuredInfo.insuredIdNumber;
    if (!String(next.beneficiaryBirthday || '').trim() && beneficiaryInfo?.birthday) next.beneficiaryBirthday = beneficiaryInfo.birthday;
    if (!String(next.beneficiaryRelation || '').trim() && beneficiaryInfo?.relationLabel) next.beneficiaryRelation = beneficiaryInfo.relationLabel;
    return sharePolicyPersonInfo(next);
  }

  function autoBindEntryMembersByName(data: PolicyFormData): PolicyFormData {
    const familyId = Number(data.familyId || entryFamilyId || 0);
    const syncedData = fillEntryPersonInfo(data);
    if (!familyId || Number(entrySelectedFamily?.id || 0) !== familyId) return syncedData;
    const applicantMember = findFamilyMemberByName(syncedData.applicant || '');
    const insuredMember = findFamilyMemberByName(syncedData.insured || '');
    const sameParticipant = areSameParticipantName(syncedData.applicant || '', syncedData.insured || '');
    const sharedMember = sameParticipant ? applicantMember || insuredMember : null;
    const finalApplicantMember = sharedMember || applicantMember;
    const finalInsuredMember = sharedMember || insuredMember;
    return {
      ...syncedData,
      familyId,
      ...(finalApplicantMember ? {
        applicantMemberId: finalApplicantMember.id,
        applicantRelation: relationLabelForEntryMember(finalApplicantMember),
        applicantRelationLabel: relationLabelForEntryMember(finalApplicantMember),
        applicantBirthday: syncedData.applicantBirthday || finalApplicantMember.birthday || '',
      } : {}),
      ...(finalInsuredMember ? {
        insuredMemberId: finalInsuredMember.id,
        insuredRelation: relationLabelForEntryMember(finalInsuredMember),
        insuredRelationLabel: relationLabelForEntryMember(finalInsuredMember),
        insuredBirthday: syncedData.insuredBirthday || finalInsuredMember.birthday || '',
      } : {}),
    };
  }

  async function ensureFamilyBeforeSave() {
    if (entrySelectedFamily) return entrySelectedFamily;
    const payload = await createFamilyProfile({ token: token || undefined, guestId: token ? undefined : guestId, familyName: '默认家庭' });
    const family = { ...payload.family, members: payload.members };
    setFamilyProfiles((current) => [family, ...current.filter((item) => Number(item.id) !== Number(family.id))]);
    handleSelectFamily(family.id);
    return family;
  }

  async function createFamilyMemberForFamily(family: FamilyProfile, input: { name: string; relationLabel: string; birthday?: string; notes?: string; setAsCore?: boolean }) {
    const name = input.name.trim();
    if (!name) return null;
    const payload = await createFamilyMember({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      name,
      relationLabel: input.relationLabel || '待确认',
      birthday: input.birthday,
      notes: input.notes,
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

  async function updateFamilyMemberNotesForFamily(family: FamilyProfile, member: FamilyMember, notes: string) {
    const payload = await updateFamilyMemberRelation({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      memberId: member.id,
      notes,
    });
    setMessage(`已更新${payload.member.name}的备注`);
    return replaceFamilyProfile(payload.family, payload.members);
  }

  async function updateFamilyMemberForFamily(family: FamilyProfile, member: FamilyMember, input: { name: string; birthday?: string; relationLabel?: string; notes?: string; syncBoundPolicies?: boolean }) {
    const payload = await updateFamilyMember({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      memberId: member.id,
      name: input.name,
      birthday: input.birthday,
      relationLabel: input.relationLabel,
      notes: input.notes,
      syncBoundPolicies: input.syncBoundPolicies,
    });
    if (Array.isArray(payload.policies) && payload.policies.length) {
      const updatedPolicies = new Map(payload.policies.map((policy) => [Number(policy.id), policy]));
      setPolicies((current) => current.map((policy) => updatedPolicies.get(Number(policy.id)) || policy));
    } else {
      setPolicies((current) => current.map((policy) => {
        if (Number(policy.familyId || 0) !== Number(family.id)) return policy;
        const nextPolicy = { ...policy };
        if (Number(nextPolicy.applicantMemberId || 0) === Number(member.id)) {
          nextPolicy.applicantMemberName = payload.member.name;
          if (input.syncBoundPolicies) {
            nextPolicy.applicant = payload.member.name;
            nextPolicy.applicantBirthday = payload.member.birthday || '';
            nextPolicy.applicantRelation = payload.member.relationLabel || '';
            nextPolicy.applicantRelationLabel = payload.member.relationLabel || '';
          }
        }
        if (Number(nextPolicy.insuredMemberId || 0) === Number(member.id)) {
          nextPolicy.insuredMemberName = payload.member.name;
          if (input.syncBoundPolicies) {
            nextPolicy.insured = payload.member.name;
            nextPolicy.insuredBirthday = payload.member.birthday || '';
            nextPolicy.insuredRelation = payload.member.relationLabel || '';
            nextPolicy.insuredRelationLabel = payload.member.relationLabel || '';
          }
        }
        return nextPolicy;
      }));
    }
    const syncedPolicyCount = Number(payload.syncedPolicyCount || 0);
    setMessage(syncedPolicyCount ? `已更新成员：${payload.member.name}，同步${syncedPolicyCount}张保单` : `已更新成员：${payload.member.name}`);
    return replaceFamilyProfile(payload.family, payload.members);
  }

  async function deleteFamilyMemberForFamily(family: FamilyProfile, member: FamilyMember) {
    const payload = await deleteFamilyMember({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      memberId: member.id,
    });
    if (payload.clearedPolicyCount) await refreshPolicies();
    setMessage(`已删除成员：${member.name}`);
    return replaceFamilyProfile(payload.family, payload.members);
  }

  async function updateFamilyForFamily(family: FamilyProfile, input: { familyName: string; notes?: string; planningProfile?: FamilyPlanningProfile | null }) {
    const payload = await updateFamilyProfile({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      familyName: input.familyName,
      notes: input.notes,
      planningProfile: input.planningProfile,
    });
    if (Number(payload.family.id) === Number(selectedFamilyId || 0)) {
      setFamilyPlanningProfile(saveFamilyPlanningProfile(payload.family.planningProfile || {}));
      setSavedFamilyReportRecord(null);
      setFamilyPolicyAnalysisReport(null);
    }
    setMessage(`已保存家庭档案：${payload.family.familyName}`);
    return replaceFamilyProfile(payload.family, payload.members);
  }

  async function updateFamilyNameForFamily(family: FamilyProfile, familyName: string) {
    return updateFamilyForFamily(family, { familyName, notes: family.notes || '' });
  }

  async function updateFamilyNotesForFamily(family: FamilyProfile, notes: string) {
    const payload = await updateFamilyProfile({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
      notes,
    });
    setMessage('已更新家庭备注');
    return replaceFamilyProfile(payload.family, payload.members);
  }

  function clearFamilyPolicyBinding(policy: Policy, familyId: number): Policy {
    if (Number(policy.familyId || 0) !== Number(familyId)) return policy;
    return {
      ...policy,
      familyId: null,
      familyName: '',
      familyBindingSource: '',
      applicantMemberId: null,
      insuredMemberId: null,
      applicantMemberName: '',
      insuredMemberName: '',
      applicantRelation: '',
      insuredRelation: '',
      applicantRelationLabel: '',
      insuredRelationLabel: '',
      applicantNameSnapshot: '',
      insuredNameSnapshot: '',
      applicantRelationSnapshot: '',
      insuredRelationSnapshot: '',
      participantReviewStatus: 'pending_review',
    };
  }

  async function deleteFamilyForFamily(family: FamilyProfile) {
    const payload = await deleteFamilyProfile({
      token: token || undefined,
      guestId: token ? undefined : guestId,
      familyId: family.id,
    });
    setFamilyProfiles((current) => current.filter((item) => Number(item.id) !== Number(family.id)));
    setPolicies((current) => current.map((policy) => clearFamilyPolicyBinding(policy, family.id)));
    setSelectedPolicy((current) => (current ? clearFamilyPolicyBinding(current, family.id) : current));
    if (Number(selectedFamilyId || 0) === Number(family.id)) {
      setSelectedFamilyId(null);
      setShowFamilyReport(false);
      setShowFamilyPolicies(false);
    }
    setFormData((current) => Number(current.familyId || 0) === Number(family.id)
      ? { ...current, familyId: null, applicantMemberId: null, insuredMemberId: null }
      : current);
    setMessage(`已删除家庭档案，清理${payload.clearedPolicyCount}张保单的家庭关系`);
  }

  function handleOcrTextChange(value: string) {
    setOcrText(value);
    setScanResult((current) => (current ? { ...current, ocrText: value } : current));
    clearOptionalResponsibilitySelections();
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
  }

  function openPhoneVerificationDialog(nextMessage = '录入或上传保单前需要先验证手机号') {
    setAuthMessage(nextMessage);
    setAuthMobile((current) => current || mobile);
    setAuthDevCode('');
    setShowAuthDialog(true);
  }

  function blockPolicyEntryIfUnauthenticated(reason = '录入或上传保单前需要先验证手机号') {
    if (token) return false;
    openPhoneVerificationDialog(reason);
    return true;
  }

  function handleRegistrationRequiredError(error: unknown) {
    if (error instanceof ApiError && error.code === 'REGISTRATION_REQUIRED') {
      openPhoneVerificationDialog(error.message || '录入或上传保单前需要先验证手机号');
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
    productKnowledgeReplaceIndexRef.current = null;
    setUploadItem(item);
    setScanResult(null);
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey('');
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    setFormProductMatchStatus('');
    setProductKnowledgeUploadItems([]);
    setProductKnowledgeUploadCount(0);
    setBaseScanResult(null);
    setBaseAnalysisDraft(null);
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
    setFormData((current) => autoBindEntryMembersByName(mergeScanToForm(payload.scan, current)));
    setOcrText(payload.scan.ocrText || '');
    setScanResult(payload.scan);
    setBaseScanResult(payload.scan);
    const recognizedAnalysis = payload.analysis || null;
    if (hasAnalysisResult(recognizedAnalysis)) {
      const nextAnalysis = withRememberedOptionalResponsibilitySelections(recognizedAnalysis);
      setAnalysisDraft(nextAnalysis);
      setBaseAnalysisDraft(nextAnalysis);
      setShowAnalysisReport(false);
      const reviewSuffix = scanReviewMessageSuffix(payload.scan);
      setMessage(recognizedAnalysis?.optionalResponsibilities?.length
        ? `OCR 已完成，已匹配本地保险责任${reviewSuffix}，请确认可选责任后保存`
        : `OCR 已完成，已匹配本地保险责任${reviewSuffix}，请确认后保存`);
    } else {
      setBaseAnalysisDraft(null);
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
    if (blockPolicyEntryIfUnauthenticated('上传保单照片前需要先验证手机号')) return;
    fileInputRef.current?.click();
  }

  function handleProductKnowledgeScanClick() {
    if (blockPolicyEntryIfUnauthenticated('上传补充产品页前需要先验证手机号')) return;
    if (!uploadItem || !baseScanResult) {
      setMessage('请先上传保单基本信息页照片');
      return;
    }
    productKnowledgeReplaceIndexRef.current = null;
    productKnowledgeFileInputRef.current?.click();
  }

  function handleReplaceProductKnowledgeUpload(index: number) {
    if (productKnowledgeUploading) return;
    if (!productKnowledgeUploadItems[index]) return;
    productKnowledgeReplaceIndexRef.current = index;
    productKnowledgeFileInputRef.current?.click();
  }

  async function rescanProductKnowledgeUploads(input: {
    items: UploadItem[];
    startedAt: number;
    originalBytes: number;
    successMessage: string;
  }) {
    const { items, startedAt, originalBytes, successMessage } = input;
    if (!baseScanResult) {
      setMessage('请先上传保单基本信息页照片');
      return;
    }
    if (!items.length) {
      setProductKnowledgeUploadItems([]);
      setProductKnowledgeUploadCount(0);
      setScanResult(baseScanResult);
      setOcrText(baseScanResult.ocrText || '');
      setAnalysisDraft(baseAnalysisDraft);
      setShowAnalysisReport(false);
      setFormProductMatches([]);
      setFormProductMatchStatus('');
      setFormProductMatchMessage('');
      setMessage('已删除补充照片，已恢复保单基本页 OCR');
      return;
    }
    setProductKnowledgeUploading(true);
    try {
      const payload = await scanPolicyProductKnowledge({
        token,
        guestId,
        company: formData.company,
        name: formData.name,
        manualData: formData,
        scan: baseScanResult,
        uploadItems: items,
      });
      setProductKnowledgeUploadItems(items);
      setProductKnowledgeUploadCount(items.length);
      setScanResult(payload.scan);
      setOcrText(payload.scan.ocrText || '');
      setFormProductMatches(Array.isArray(payload.matches) ? payload.matches : []);
      setFormProductMatchStatus(payload.status || '');
      setFormProductMatchMessage(payload.message || '');
      setShowAnalysisReport(false);
      if (Array.isArray(payload.optionalResponsibilities) && payload.optionalResponsibilities.length) {
        setAnalysisDraft((current) => withRememberedOptionalResponsibilitySelections({
          ...(current || baseAnalysisDraft || { report: '', coverageTable: [] }),
          optionalResponsibilities: payload.optionalResponsibilities,
        }));
      } else {
        setAnalysisDraft(baseAnalysisDraft);
      }
      reportClientPerformance('client.product_knowledge_scan.complete', {
        durationMs: clientElapsedMs(startedAt),
        requestMs: clientElapsedMs(startedAt),
        originalBytes,
        uploadBytes: items.reduce((sum, item) => sum + item.size, 0),
        hasUpload: true,
        outputOcrChars: String(payload.scan?.ocrText || '').length,
      });
      setMessage(payload.message || successMessage);
    } catch (error) {
      reportClientPerformance('client.product_knowledge_scan.error', {
        durationMs: clientElapsedMs(startedAt),
        hasUpload: true,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
      });
      if (handleRegistrationRequiredError(error)) return;
      setMessage(error instanceof Error ? error.message : '补充产品页识别失败，请稍后重试');
    } finally {
      setProductKnowledgeUploading(false);
    }
  }

  async function handleDeleteProductKnowledgeUpload(index: number) {
    if (productKnowledgeUploading) return;
    const nextItems = productKnowledgeUploadItems.filter((_, itemIndex) => itemIndex !== index);
    if (nextItems.length === productKnowledgeUploadItems.length) return;
    const startedAt = clientPerfNow();
    await rescanProductKnowledgeUploads({
      items: nextItems,
      startedAt,
      originalBytes: 0,
      successMessage: '已删除补充照片并重新整理 OCR',
    });
  }

  function handleDeleteBaseUpload() {
    if (loading || productKnowledgeUploading) return;
    const nextFamilyId = entryFamilyId;
    productKnowledgeReplaceIndexRef.current = null;
    setFormData({
      ...emptyForm,
      familyId: nextFamilyId,
    });
    setOcrText('');
    setUploadItem(null);
    setBaseScanResult(null);
    setBaseAnalysisDraft(null);
    setScanResult(null);
    setAnalysisDraft(null);
    setProductKnowledgeUploadItems([]);
    setProductKnowledgeUploadCount(0);
    clearOptionalResponsibilitySelections();
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey('');
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    setFormProductMatchStatus('');
    setMessage('已删除保单基本页，请重新上传保单基本信息页');
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
      const payload = await register({ mobile: normalizedMobile, code: normalizedCode, guestId, includePolicies: false });
      localStorage.setItem(TOKEN_KEY, payload.token);
      localStorage.setItem(USER_MOBILE_KEY, payload.user.mobile);
      setToken(payload.token);
      setMobile(payload.user.mobile);
      if (!payload.policiesDeferred) {
        setPolicies([...payload.policies].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
        setPoliciesLoaded(true);
      } else {
        setPoliciesLoaded(false);
      }
      void refreshMembershipStatus(payload.token).catch(() => undefined);
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
    if (blockPolicyEntryIfUnauthenticated('上传保单照片前需要先验证手机号')) {
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

  async function handleProductKnowledgeFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    if (!files.length || productKnowledgeUploading) return;
    if (blockPolicyEntryIfUnauthenticated('上传补充产品页前需要先验证手机号')) {
      if (productKnowledgeFileInputRef.current) productKnowledgeFileInputRef.current.value = '';
      return;
    }
    if (!uploadItem || !baseScanResult) {
      setMessage('请先上传保单基本信息页照片');
      if (productKnowledgeFileInputRef.current) productKnowledgeFileInputRef.current.value = '';
      return;
    }
    const replaceIndex = productKnowledgeReplaceIndexRef.current;
    const isReplacing = replaceIndex !== null;
    const remaining = isReplacing ? 1 : Math.max(0, 5 - productKnowledgeUploadItems.length);
    const selectedFiles = files.slice(0, remaining);
    if (!selectedFiles.length) {
      setMessage('补充照片最多上传 5 张保险产品页面');
      if (productKnowledgeFileInputRef.current) productKnowledgeFileInputRef.current.value = '';
      return;
    }
    const startedAt = clientPerfNow();
    setProductKnowledgeUploading(true);
    setMessage(isReplacing ? '正在替换并识别补充产品页' : '正在识别补充产品页');
    try {
      const preparedItems: UploadItem[] = [];
      let originalBytes = 0;
      const timings: ClientPerformanceTimings = {};
      for (const file of selectedFiles) {
        originalBytes += file.size;
        const item = await fileToUploadItem(file, timings);
        if (item.size > MAX_POLICY_UPLOAD_BYTES) {
          throw createCodedError('图片太大，请压缩到 12MB 以内后重新上传', 'UPLOAD_TOO_LARGE');
        }
        preparedItems.push(item);
      }
      const nextItems = isReplacing
        ? productKnowledgeUploadItems.map((item, index) => (index === replaceIndex ? preparedItems[0] : item))
        : [...productKnowledgeUploadItems, ...preparedItems];
      await rescanProductKnowledgeUploads({
        items: nextItems,
        startedAt,
        originalBytes,
        successMessage: isReplacing ? '补充照片已替换并重新识别' : '补充产品页已识别，知识线索待后台审核',
      });
    } catch (error) {
      reportClientPerformance('client.product_knowledge_scan.error', {
        durationMs: clientElapsedMs(startedAt),
        hasUpload: true,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
      });
      if (handleRegistrationRequiredError(error)) return;
      setMessage(error instanceof Error ? error.message : '补充产品页识别失败，请稍后重试');
    } finally {
      productKnowledgeReplaceIndexRef.current = null;
      setProductKnowledgeUploading(false);
      if (productKnowledgeFileInputRef.current) productKnowledgeFileInputRef.current.value = '';
    }
  }

  async function handleGenerateAnalysis() {
    if (!canSubmit || loading) return;
    if (blockPolicyEntryIfUnauthenticated()) return;
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
      setFormData((current) => autoBindEntryMembersByName(mergeScanToForm(payload.scan, current)));
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

  function resetAssistantCustomerSummary(message = '') {
    setAssistantCustomerSummary(null);
    setAssistantCustomerSummaryLoading(false);
    setAssistantCustomerSummaryMessage(message);
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
    resetAssistantCustomerSummary('');
    setAssistantMatches([]);
    setAssistantSelectedMatchKey('');
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
      const exactMatch = matched.status === 'exact'
        ? matches.find((match) => match.needsConfirmation === false) || matches[0]
        : null;
      if (exactMatch && exactMatch.needsConfirmation === false) {
        const resolvedCompany = exactMatch.company.trim();
        const resolvedName = (exactMatch.resolvedProductName || exactMatch.productName).trim();
        const displayName = policyKnowledgeMatchDisplayName(exactMatch) || resolvedName;
        setAssistantCompany(resolvedCompany);
        setAssistantName(displayName);
        setAssistantMessage(`已按官方名称校正为：${displayName}`);
        await loadAssistantResponsibilities({ company: resolvedCompany, name: resolvedName, startedAt });
        return;
      }
      if (matches.length) {
        setAssistantMatches(matches);
        setAssistantMessage(matched.message || `本地找到 ${matches.length} 个相近产品，请选择确认`);
        reportClientPerformance('client.responsibility.assistant.match', {
          durationMs: clientElapsedMs(startedAt),
          requestMs: clientElapsedMs(startedAt),
          hasUpload: false,
          inputOcrChars: `${company} ${name}`.length,
          responsibilityCount: 0,
        });
        return;
      }
      setAssistantMessage(matched.message || '本地库未找到匹配产品');
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
      setAssistantSelectedMatchKey('');
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

  async function loadAssistantResponsibilities(input: {
    company: string;
    name: string;
    startedAt: number;
    preferLocalKnowledgeAnswer?: boolean;
    allowExternalReferences?: boolean;
    keepMatches?: boolean;
    selectedMatchKey?: string;
  }) {
    const payload = await queryPolicyResponsibilities({
      company: input.company,
      name: input.name,
      preferLocalKnowledgeAnswer: input.preferLocalKnowledgeAnswer,
      allowExternalReferences: input.allowExternalReferences,
    });
    setAssistantAnalysis(payload.analysis);
    if (!input.keepMatches) setAssistantMatches([]);
    setAssistantSelectedMatchKey(input.keepMatches ? input.selectedMatchKey || '' : '');
    setAssistantLocalSearched(false);
    const responsibilityCount = payload.analysis?.coverageTable?.length || 0;
    if (input.allowExternalReferences) {
      setAssistantCustomerSummary(null);
      setAssistantCustomerSummaryLoading(false);
      setAssistantCustomerSummaryMessage('');
      setAssistantMessage(responsibilityCount ? `已生成 ${responsibilityCount} 项待核实责任` : '外部线索未提取到责任明细');
      reportClientPerformance('client.responsibility.assistant.request', {
        durationMs: clientElapsedMs(input.startedAt),
        requestMs: clientElapsedMs(input.startedAt),
        hasUpload: false,
        inputOcrChars: `${input.company} ${input.name}`.length,
        responsibilityCount,
      });
      return;
    }
    setAssistantMessage('正在生成客户可读摘要');
    setAssistantCustomerSummaryLoading(true);
    setAssistantCustomerSummary(null);
    setAssistantCustomerSummaryMessage('');
    try {
      const summaryPayload = await getProductCustomerResponsibilitySummary({
        company: input.company,
        name: input.name,
      });
      if (summaryPayload.ok) {
        setAssistantCustomerSummary(summaryPayload.summary);
        setAssistantCustomerSummaryMessage('');
        const summaryCount = Array.isArray(summaryPayload.summary.mainResponsibilities)
          ? summaryPayload.summary.mainResponsibilities.filter((item) => item?.title || item?.plainText || item?.howItPays).length
          : 0;
        setAssistantMessage(summaryCount ? `已生成 ${summaryCount} 项责任摘要` : '已生成客户可读摘要');
      } else {
        setAssistantCustomerSummary(null);
        setAssistantCustomerSummaryMessage(summaryPayload.message || '这个产品还需要补充保险责任资料');
        setAssistantMessage(summaryPayload.message || '客户摘要生成失败，请稍后重试');
      }
    } catch (error) {
      setAssistantCustomerSummary(null);
      setAssistantCustomerSummaryMessage(error instanceof Error ? error.message : '客户摘要生成失败，请稍后重试');
      setAssistantMessage(error instanceof Error ? error.message : '客户摘要生成失败，请稍后重试');
    } finally {
      setAssistantCustomerSummaryLoading(false);
    }
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
    const name = (match.resolvedProductName || match.productName).trim();
    const displayName = policyKnowledgeMatchDisplayName(match) || name;
    if (!company || !name) return;
    if (isExternalResponsibilityReference(match)) {
      const startedAt = clientPerfNow();
      const selectedKey = assistantMatchKey(match);
      setAssistantCompany(company);
      setAssistantName(displayName);
      setAssistantAnalysis(null);
      setAssistantSelectedMatchKey(selectedKey);
      resetAssistantCustomerSummary('');
      setAssistantLoading(true);
      setAssistantMessage('正在基于外部线索生成待核实责任');
      try {
        await loadAssistantResponsibilities({
          company,
          name,
          startedAt,
          preferLocalKnowledgeAnswer: false,
          allowExternalReferences: true,
          keepMatches: true,
          selectedMatchKey: selectedKey,
        });
      } catch (error) {
        setAssistantAnalysis(null);
        resetAssistantCustomerSummary('外部资料未提取到可展示责任；请通过客服、寿险APP或柜面核实。');
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
      return;
    }
    const startedAt = clientPerfNow();
    setAssistantCompany(company);
    setAssistantName(displayName);
    setAssistantAnalysis(null);
    setAssistantSelectedMatchKey('');
    resetAssistantCustomerSummary('');
    setAssistantMatches([]);
    setAssistantLoading(true);
    setAssistantMessage('正在查询所选产品');
    try {
      await loadAssistantResponsibilities({ company, name, startedAt });
    } catch (error) {
      setAssistantAnalysis(null);
      resetAssistantCustomerSummary(error instanceof Error ? error.message : '客户摘要生成失败，请稍后重试');
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
    resetAssistantCustomerSummary('');
    setAssistantMatches([]);
    setAssistantSelectedMatchKey('');
    setAssistantLocalSearched(true);
    setAssistantMessage('正在联网查找候选产品');
    try {
      const matched = await matchPolicyResponsibilities({
        company,
        name,
        limit: 20,
        minScore: 0.1,
        includeOnline: true,
      });
      const matches = Array.isArray(matched.matches) ? matched.matches : [];
      const exactMatch = matched.status === 'exact'
        ? matches.find((match) => match.needsConfirmation === false) || matches[0]
        : null;
      if (exactMatch && exactMatch.needsConfirmation === false) {
        const resolvedCompany = exactMatch.company.trim();
        const resolvedName = (exactMatch.resolvedProductName || exactMatch.productName).trim();
        setAssistantCompany(resolvedCompany);
        setAssistantName(resolvedName);
        setAssistantMessage(`已按官方名称校正为：${resolvedName}`);
        await loadAssistantResponsibilities({
          company: resolvedCompany,
          name: resolvedName,
          startedAt,
          preferLocalKnowledgeAnswer: false,
        });
        return;
      }
      if (matches.length) {
        setAssistantMatches(matches);
        setAssistantMessage(matched.message || `联网找到 ${matches.length} 个候选产品，请选择确认`);
        reportClientPerformance('client.responsibility.assistant.match_online', {
          durationMs: clientElapsedMs(startedAt),
          requestMs: clientElapsedMs(startedAt),
          hasUpload: false,
          inputOcrChars: `${company} ${name}`.length,
          responsibilityCount: 0,
        });
        return;
      }
      setAssistantMessage(matched.message || '未找到匹配产品，请核对合同条款名称或上传条款页');
    } catch (error) {
      setAssistantAnalysis(null);
      resetAssistantCustomerSummary('');
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
    if (blockPolicyEntryIfUnauthenticated('保存保单前需要先验证手机号')) return;
    const familyAlignedData = Number(entryFamilyId || 0) && Number(formData.familyId || 0) !== Number(entryFamilyId)
      ? {
          ...formData,
          familyId: entryFamilyId,
          applicantMemberId: null,
          insuredMemberId: null,
        }
      : formData;
    const submitBaseData = autoBindEntryMembersByName(familyAlignedData);
    if (submitBaseData !== formData) setFormData(submitBaseData);
    const mustSelectExistingFamily = familyProfiles.some((family) => String(family.status || 'active') === 'active');
    const familyHasCoreMember = Boolean(entrySelectedFamily?.coreMemberId);
    const validationErrors = validatePolicyEntryForm(submitBaseData, {
      requireFamily: mustSelectExistingFamily,
      requireParticipantRelations: familyHasCoreMember,
    });
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
      const findActiveMemberByName = (name: string) =>
        chooseFamilyMemberByName(submitFamilyMembers, name, submitFamily.coreMemberId);
      const createSubmitMember = async (input: { name: string; relationLabel: string; birthday?: string; setAsCore?: boolean }) => {
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
        birthday?: string;
        setAsCoreOnCreate?: boolean;
      }) => {
        const normalizedName = input.name.trim();
        if (!normalizedName) return null;
        if (input.memberId) {
          const selectedMember = findActiveMemberById(input.memberId);
          if (selectedMember && areSameParticipantName(selectedMember.name, normalizedName)) return selectedMember;
        }
        const exactMember =
          findActiveMemberByName(normalizedName) ||
          (Number(submitFamily.id) === Number(selectedFamilyId) ? findFamilyMemberByName(normalizedName) : null);
        if (exactMember) return exactMember;
        return createSubmitMember({
          name: normalizedName,
          relationLabel: input.setAsCoreOnCreate ? '本人' : input.relationLabel || '待确认',
          birthday: input.birthday,
          setAsCore: input.setAsCoreOnCreate,
        });
      };

      const applicantName = submitBaseData.applicant.trim();
      const insuredName = submitBaseData.insured.trim();
      const applicantBirthday = String(submitBaseData.applicantBirthday || '').trim();
      const insuredBirthday = String(submitBaseData.insuredBirthday || '').trim();
      const participantNamesMatch = areSameParticipantName(applicantName, insuredName);
      const applicantRelationForSubmit = submitBaseData.applicantRelationLabel || submitBaseData.applicantRelation || '待确认';
      const insuredRelationForSubmit = submitBaseData.insuredRelationLabel || submitBaseData.insuredRelation || '待确认';
      const applicantShouldBeCore = applicantRelationForSubmit === '本人';
      const insuredShouldBeCore = insuredRelationForSubmit === '本人';
      if (!submitFamily.coreMemberId && applicantShouldBeCore && insuredShouldBeCore && applicantName && insuredName && !participantNamesMatch) {
        setMessage('家庭顶梁柱只能选择一个');
        return;
      }
      let applicantMember = await resolveSubmitMember({
        name: applicantName,
        memberId: submitBaseData.applicantMemberId,
        relationLabel: applicantRelationForSubmit,
        birthday: applicantBirthday,
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
      let insuredMember = participantNamesMatch
        ? applicantMember
        : await resolveSubmitMember({
          name: insuredName,
          memberId: submitBaseData.insuredMemberId,
          relationLabel: insuredRelationForSubmit,
          birthday: insuredBirthday,
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
      setSelectedFamilyId(submitFamily.id);
      setFormData({
        ...emptyForm,
        familyId: submitFamily.id,
      });
      setOcrText('');
      setUploadItem(null);
      setBaseScanResult(null);
      setBaseAnalysisDraft(null);
      setScanResult(null);
      setAnalysisDraft(null);
      setProductKnowledgeUploadItems([]);
      setProductKnowledgeUploadCount(0);
      clearOptionalResponsibilitySelections();
      setShowAnalysisReport(false);
      setConfirmedProductMatchKey('');
      setFormProductMatches([]);
      setFormProductMatchMessage('');
      setFormProductMatchStatus('');
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
      setMessage(isPolicyReportGenerating(payload.policy) ? '保单已保存，报告正在后台生成' : '保单已保存到我的保单');
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
      if (error instanceof ApiError && error.code === 'MEMBERSHIP_REQUIRED') {
        setShowMembershipDialog(true);
        void refreshMembershipStatus().catch(() => undefined);
        setMessage(error.message || '免费额度已用完，请开通会员继续录入');
        return;
      }
      setMessage(error instanceof Error ? error.message : '识别失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  async function handleCashValueFileChange(e: ChangeEvent<HTMLInputElement>, mode: 'replace' | 'append' = 'replace') {
    const file = e.target.files?.[0];
    if (!file || cashValuePolicyId === null) return;
    e.target.value = '';

    setCashValueLoading(true);
    setCashValueMessage(mode === 'append' ? '正在识别剩余现金价值表...' : '正在识别现金价值表...');

    try {
      const uploadItem = await fileToUploadItem(file);
      const uploadAttempts = await buildUploadItemOrientationAttempts(uploadItem);
      let result: CashValueScanResult = { ok: false, rows: [], error: 'PARSE_FAILED' };
      let usedRotatedImage = false;
      for (let attemptIndex = 0; attemptIndex < uploadAttempts.length; attemptIndex++) {
        const attemptUploadItem = uploadAttempts[attemptIndex];
        if (attemptIndex > 0) {
          setCashValueMessage(`正在尝试第 ${attemptIndex + 1} 个图片方向...`);
        }
        result = await scanCashValue({
          token,
          guestId,
          policyId: cashValuePolicyId,
          uploadItem: attemptUploadItem,
        });
        if (result.ok && result.rows?.length) {
          usedRotatedImage = attemptIndex > 0;
          break;
        }
        if (!shouldRetryCashValueScanWithRotatedImage(result)) break;
      }

      if (result.ok && result.rows?.length) {
        const nextRows = mode === 'append'
          ? appendCashValueRowsSequentially(cashValueEditRows, result.rows, result.source || 'ocr')
          : result.rows;
        const nextTableType = mode === 'append' && (cashValueScanResult?.tableType === 3 || result.tableType === 3)
          ? 3
          : result.tableType;
        const appendedCount = Math.max(0, nextRows.length - cashValueEditRows.length);
        setCashValueScanResult({
          ...result,
          tableType: nextTableType,
          rows: nextRows,
          rowCount: nextRows.length,
        });
        setCashValueEditRows(nextRows);
        setCashValueMessage(
          mode === 'append'
            ? `已追加 ${appendedCount} 行现金价值，请确认后保存`
            : usedRotatedImage
              ? '已自动校正图片方向，请确认后保存'
              : '',
        );
      } else {
        const noCashValueHeader = result.error === 'CASH_VALUE_TABLE_NOT_DETECTED'
          || /未检测到现金价值表表头/u.test(String(result.message || ''));
        setCashValueMessage(noCashValueHeader
          ? '未检测到现金价值列，请上传包含“现金价值/现金价值表”的页面；保单利益摘要、生存金/身故利益表不会录入为现金价值'
          : result.message || '未能识别现金价值表，请确保照片清晰且包含完整表格');
        if (mode !== 'append') {
          setCashValueScanResult(null);
          setCashValueEditRows([]);
        }
      }
    } catch (error) {
      setCashValueMessage(error instanceof Error ? error.message : '识别失败');
      if (mode !== 'append') {
        setCashValueScanResult(null);
        setCashValueEditRows([]);
      }
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

  function handleAddCashValueRow(afterRowIndex?: number) {
    setCashValueEditRows((prev) => {
      if (afterRowIndex === undefined || afterRowIndex < 0 || afterRowIndex >= prev.length) {
        return [...prev, nextManualCashValueRow(prev)];
      }

      const baseRow = prev[afterRowIndex];
      const basePolicyYear = parseNumericInput(baseRow?.policyYear);
      const baseAge = baseRow?.age === null || baseRow?.age === undefined ? null : parseNumericInput(baseRow.age);
      const insertedRow = basePolicyYear === null
        ? nextManualCashValueRow(prev)
        : makeManualCashValueRow(basePolicyYear + 1, baseAge === null ? null : baseAge + 1);
      return [
        ...prev.slice(0, afterRowIndex + 1),
        insertedRow,
        ...prev.slice(afterRowIndex + 1),
      ];
    });
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
      const [latestPayload] = await Promise.all([
        getPolicy({ token: token || undefined, guestId: token ? undefined : guestId, id: payload.policy.id }),
        payload.policy.familyId ? refreshFamilyProfiles() : Promise.resolve([]),
      ]);
      setSelectedPolicy(latestPayload.policy);
      setPolicies((current) => current.map((row) => (Number(row.id) === Number(latestPayload.policy.id) ? latestPayload.policy : row)));
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
    setBaseScanResult(null);
    setBaseAnalysisDraft(null);
    setScanResult(null);
    setAnalysisDraft(null);
    setProductKnowledgeUploadItems([]);
    setProductKnowledgeUploadCount(0);
    clearOptionalResponsibilitySelections();
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey('');
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    setFormProductMatchStatus('');
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
      onFileChange={(e, mode) => { void handleCashValueFileChange(e, mode); }}
      onRemoveRow={handleRemoveCashValueRow}
      onResetForRescan={() => {
        setCashValueScanResult(null);
        setCashValueEditRows([]);
        setCashValueMessage('');
      }}
      onStartManualEntry={startManualCashValueEntry}
    />
  );

  const familyCreateDialog = (
    <CreateFamilyProfileDialog
      loading={familyCreateLoading}
      message={familyCreateMessage}
      open={familyCreateDialogOpen}
      onClose={() => {
        if (familyCreateLoading) return;
        setFamilyCreateDialogOpen(false);
      }}
      onSubmit={submitFamilyCreateDialog}
    />
  );

  const familySalesReviewSteps = [
    {
      label: '家庭成员画像',
      detail: '整理成员关系、年龄结构与无保单成员',
      signal: '成员图谱',
      icon: BrainCircuit,
      iconClass: 'bg-cyan-300/15 text-cyan-100 ring-cyan-300/25',
      railClass: 'w-[72%] bg-cyan-300',
      pulseClass: 'from-cyan-300 via-cyan-100 to-transparent',
    },
    {
      label: '保障责任校验',
      detail: '对照保单字段、条款证据与有效状态',
      signal: '责任核验',
      icon: ShieldCheck,
      iconClass: 'bg-emerald-300/15 text-emerald-100 ring-emerald-300/25',
      railClass: 'w-[64%] bg-emerald-300',
      pulseClass: 'from-emerald-300 via-emerald-100 to-transparent',
    },
    {
      label: '财富线索识别',
      detail: '读取现金价值、现金流与传承机会',
      signal: '财富路径',
      icon: TrendingUp,
      iconClass: 'bg-amber-300/15 text-amber-100 ring-amber-300/25',
      railClass: 'w-[58%] bg-amber-300',
      pulseClass: 'from-amber-300 via-amber-100 to-transparent',
    },
    {
      label: '行动清单生成',
      detail: '输出可跟进、可核实、可成交的销售动作',
      signal: '跟进行动',
      icon: Target,
      iconClass: 'bg-indigo-300/15 text-indigo-100 ring-indigo-300/25',
      railClass: 'w-[46%] bg-indigo-300',
      pulseClass: 'from-indigo-300 via-indigo-100 to-transparent',
    },
  ];
  const familySalesReviewExportTitle = `${familySalesReviewFamily?.familyName || '当前家庭'}销售建议报告`;
  const familySalesReviewFamilyMembers = Array.isArray(familySalesReviewFamily?.members) ? familySalesReviewFamily.members : [];
  const familySalesReviewPolicyCount = familySalesReviewFamilyId
    ? Number(familySalesReviewFamily?.policySummary?.policyCount ?? familySalesReviewFamily?.policyCount ?? policies.filter((policy) => Number(policy.familyId) === Number(familySalesReviewFamilyId)).length)
    : familyPolicyCount;
  const familySalesReviewSignals = [
    {
      label: '成员画像',
      value: `${familySalesReview?.inputSummary?.memberCount ?? familySalesReviewFamilyMembers.length}`,
      detail: '关系与年龄结构',
      className: 'bg-cyan-300/10 text-cyan-100 ring-cyan-300/20',
    },
    {
      label: '保单样本',
      value: `${familySalesReview?.inputSummary?.policyCount ?? familySalesReviewPolicyCount}`,
      detail: '有效合同样本',
      className: 'bg-emerald-300/10 text-emerald-100 ring-emerald-300/20',
    },
    {
      label: '待覆盖成员',
      value: `${familySalesReview?.inputSummary?.membersWithoutPolicyCount ?? '扫描中'}`,
      detail: '缺口优先级',
      className: 'bg-amber-300/10 text-amber-100 ring-amber-300/20',
      pendingLabel: '扫描中',
    },
    {
      label: '条款证据',
      value: `${familySalesReview?.inputSummary?.officialProductCount ?? '校验中'}`,
      detail: '官网责任依据',
      className: 'bg-indigo-300/10 text-indigo-100 ring-indigo-300/20',
      pendingLabel: '校验中',
    },
  ];
  const familySalesReviewProgressStages = [
    { label: '读取档案', threshold: 18 },
    { label: '核验责任', threshold: 42 },
    { label: '识别缺口', threshold: 68 },
    { label: '生成报告', threshold: 90 },
  ];
  const familySalesChatQuickPrompts = [
    '帮我改成微信话术',
    '客户说预算不够怎么回应',
    '这份方案优先讲哪三点',
    '生成二次面谈提纲',
  ];

  const familySalesReviewPage = familySalesReviewOpen ? (
    <div className="family-report-shell min-h-screen bg-[#EEF3F7] pb-10 text-[#102033]">
      <section className="min-h-screen">
        <header className="no-print fixed inset-x-0 top-0 z-30 border-b border-[#DDE6EE] bg-white/95 backdrop-blur">
          <div className="family-report-content grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3">
            <button
              type="button"
              className="-ml-2 flex h-10 w-10 items-center justify-center rounded-full text-[#42566B] active:bg-[#EEF3F7]"
              onClick={closeFamilySalesReview}
              aria-label="返回家庭档案"
              title="返回家庭档案"
            >
              <ArrowLeft size={22} />
            </button>
            <div className="min-w-0 text-center">
              <h1 className="family-report-heading truncate text-lg font-black text-[#102033]">家庭保障策略简报</h1>
              <p className="family-report-kicker mt-0.5 hidden text-[11px] text-[#72849A] sm:block">Expert Intelligence</p>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2">
              {familySalesReview?.content ? (
                <button
                  type="button"
                  className="flex h-10 items-center justify-center gap-1.5 rounded-full bg-blue-50 px-3 text-xs font-black text-[#0B72B9] active:bg-blue-100"
                  aria-label="下载销售建议报告"
                  title="下载销售建议报告"
                  onClick={() => void downloadReportImage(familySalesReviewReportRef.current, familySalesReviewExportTitle)}
                >
                  <Download size={18} />
                  <span>图片</span>
                </button>
              ) : null}
                <button
                  type="button"
                  className={`flex h-10 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-black transition ${
                    familySalesReviewLoading
                      ? 'cursor-wait bg-blue-50 text-[#0B72B9] ring-1 ring-blue-100'
                      : 'bg-gradient-to-r from-blue-600 via-sky-500 to-cyan-500 text-white shadow-sm shadow-sky-900/20 active:opacity-90'
                  }`}
                  aria-busy={familySalesReviewLoading}
                  onClick={() => void regenerateFamilySalesReview()}
                >
                  <Sparkles className={familySalesReviewLoading ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
                  <span>{familySalesReviewLoading ? '生成中' : familySalesReview?.content ? (familySalesChatReviewMessageIds.length ? `按${familySalesChatReviewMessageIds.length}条续聊重算` : '重算') : '生成'}</span>
                </button>
            </div>
          </div>
        </header>
        <div className="no-print h-[65px]" aria-hidden="true" />
        <div className="family-report-content py-4 md:py-5">
          {familySalesReviewMessage ? (
            <div className={`mb-3 flex items-center gap-2 rounded-2xl px-3 py-2.5 text-xs font-black ring-1 ${
              familySalesReviewLoading
                ? 'bg-cyan-50 text-cyan-800 ring-cyan-100'
                : familySalesReview?.content
                  ? 'bg-emerald-50 text-emerald-800 ring-emerald-100'
                  : 'bg-amber-50 text-amber-800 ring-amber-100'
            }`}
            >
              {familySalesReviewLoading ? <Sparkles className="h-4 w-4 animate-pulse" /> : familySalesReview?.content ? <CheckCircle2 size={16} /> : <Shield size={16} />}
              <span>{familySalesReviewMessage}</span>
            </div>
          ) : null}
          {familySalesReview?.content ? (
            <section ref={familySalesReviewReportRef} className="print-policy-report overflow-hidden rounded-[24px] border border-[#D7E2EA] bg-[#F8FBFE] shadow-[0_18px_48px_-36px_rgba(15,23,42,0.38)]">
              <div className="border-b border-[#BDE2F5] bg-gradient-to-br from-blue-600 via-sky-500 to-cyan-500 px-4 py-4 text-white md:px-6 md:py-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="h-8 w-1.5 shrink-0 rounded-full bg-white/75" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="family-report-kicker text-[11px] uppercase text-white/72">Expert Intelligence</p>
                    <h2 className="family-report-heading min-w-0 break-words text-xl font-black leading-tight text-white">家庭保障策略简报</h2>
                    <p className="mt-1 truncate text-xs font-semibold text-white/72">
                      {familySalesReviewFamily?.familyName || '当前家庭'} · 公司专家分析系统
                    </p>
                  </div>
                </div>
                <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-white/78">
                  面向销售跟进的保障缺口、财富机会与下一步沟通建议。
                </p>
                {familySalesReview.inputSummary ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-4">
                    <div className="rounded-[16px] border border-white/25 bg-white/12 px-3 py-2.5">
                      <p className="text-[11px] font-bold text-white/68">家庭成员</p>
                      <p className="mt-1 text-sm font-black text-white">{familySalesReview.inputSummary.memberCount ?? 0}</p>
                    </div>
                    <div className="rounded-[16px] border border-white/25 bg-white/12 px-3 py-2.5">
                      <p className="text-[11px] font-bold text-white/68">有效样本</p>
                      <p className="mt-1 text-sm font-black text-white">{familySalesReview.inputSummary.policyCount ?? 0}</p>
                    </div>
                    <div className="rounded-[16px] border border-white/25 bg-white/12 px-3 py-2.5">
                      <p className="text-[11px] font-bold text-white/68">待覆盖成员</p>
                      <p className="mt-1 text-sm font-black text-white">{familySalesReview.inputSummary.membersWithoutPolicyCount ?? 0}</p>
                    </div>
                    <div className="rounded-[16px] border border-white/25 bg-white/12 px-3 py-2.5">
                      <p className="text-[11px] font-bold text-white/68">条款证据</p>
                      <p className="mt-1 text-sm font-black text-white">{familySalesReview.inputSummary.officialProductCount ?? 0}</p>
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="px-4 py-4 md:px-6 md:py-5">
                <article className="family-policy-analysis-document mx-auto max-w-[980px] rounded-[18px] border border-[#DCE7F1] bg-white px-4 py-4 shadow-[0_16px_36px_-30px_rgba(15,23,42,0.3)] md:px-7 md:py-6">
                  <FamilySalesReviewMarkdown content={familySalesReview.content} />
                </article>
              </div>
            </section>
          ) : null}
          {familySalesReview?.content ? (
            <section className="no-print mt-4 rounded-[24px] border border-[#D7E2EA] bg-white p-4 shadow-[0_18px_48px_-36px_rgba(15,23,42,0.28)] md:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-700 ring-1 ring-blue-100">
                    <MessageSquareText size={20} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-base font-black text-[#102033]">继续追问销售建议</h3>
                    <p className="mt-1 text-xs font-semibold leading-5 text-[#72849A]">
                      基于当前家庭、保单、家庭报告和这份销售建议继续生成话术、面谈提纲和异议处理。
                    </p>
                  </div>
                </div>
                <div className="rounded-full bg-slate-50 px-3 py-1.5 text-[11px] font-black text-slate-500 ring-1 ring-slate-200">
                  {familySalesChatThread ? `会话 ${familySalesChatThread.id}` : '新会话'}
                  {familySalesChatThreads.length > 1 ? ` · ${familySalesChatThreads.length} 组记录` : ''}
                </div>
              </div>
              {familySalesChatMessage ? (
                <p className={`mt-3 rounded-2xl px-3 py-2 text-xs font-black ${
                  familySalesChatLoading ? 'bg-blue-50 text-blue-700' : 'bg-slate-50 text-slate-500'
                }`}
                >
                  {familySalesChatMessage}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {familySalesChatQuickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={familySalesChatLoading}
                    className="rounded-full bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 ring-1 ring-blue-100 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void submitFamilySalesChat(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-col gap-2 rounded-2xl bg-slate-50 px-3 py-3 text-xs font-semibold text-slate-500 ring-1 ring-slate-100 sm:flex-row sm:items-center sm:justify-between">
                <span>重算报告默认不带入聊天，勾选关键消息后再点击上方重算。</span>
                <span className="shrink-0 font-black text-slate-700">已选 {familySalesChatReviewMessageIds.length}/6 条</span>
              </div>
              <div className="mt-4 max-h-[520px] space-y-3 overflow-y-auto rounded-[18px] bg-slate-50 p-3 ring-1 ring-slate-100">
                {familySalesChatMessages.length ? (
                  familySalesChatMessages.map((chatMessage) => {
                    const fromUser = chatMessage.role === 'user';
                    const selectedForReview = familySalesChatReviewMessageIds.includes(Number(chatMessage.id));
                    return (
                      <article
                        key={chatMessage.id}
                        className={`max-w-[92%] rounded-[18px] px-3 py-3 text-sm leading-6 shadow-sm ring-1 ${
                          fromUser
                            ? 'ml-auto bg-blue-600 text-white ring-blue-600'
                            : 'family-sales-chat-message mr-auto bg-white text-slate-700 ring-slate-200'
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`text-[11px] font-black ${fromUser ? 'text-blue-100' : 'text-slate-400'}`}>
                              {fromUser ? '顾问追问' : '续聊 Agent'}
                            </span>
                            <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-black ring-1 ${
                              fromUser
                                ? 'bg-white/10 text-blue-50 ring-white/20'
                                : selectedForReview
                                  ? 'bg-blue-50 text-blue-700 ring-blue-100'
                                  : 'bg-slate-50 text-slate-500 ring-slate-200'
                            }`}
                            >
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 accent-blue-600"
                                checked={selectedForReview}
                                onChange={() => toggleFamilySalesChatReviewMessage(Number(chatMessage.id))}
                              />
                              用于重算
                            </label>
                          </div>
                          {!fromUser ? (
                            <button
                              type="button"
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-500 ring-1 ring-slate-200 transition hover:bg-slate-100"
                              aria-label="复制续聊回复"
                              title="复制续聊回复"
                              onClick={() => void copyFamilySalesChatMessage(chatMessage.content)}
                            >
                              <Copy size={14} />
                            </button>
                          ) : null}
                        </div>
                        {fromUser ? (
                          <p className="whitespace-pre-wrap break-words font-semibold">{chatMessage.content}</p>
                        ) : (
                          <FamilySalesReviewMarkdown content={chatMessage.content} />
                        )}
                        {chatMessage.status === 'failed' && chatMessage.error ? (
                          <p className={fromUser ? 'mt-2 text-xs font-black text-blue-100' : 'mt-2 text-xs font-black text-rose-600'}>{chatMessage.error}</p>
                        ) : null}
                      </article>
                    );
                  })
                ) : (
                  <div className="rounded-[16px] border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm font-bold text-slate-400">
                    暂无续聊记录，可以从上方快捷问题开始。
                  </div>
                )}
                {familySalesChatLoading ? (
                  <div className="mr-auto rounded-[18px] bg-white px-3 py-3 text-sm font-black text-blue-700 ring-1 ring-blue-100">
                    <Sparkles className="mr-2 inline h-4 w-4 animate-pulse" />
                    正在整理回复
                  </div>
                ) : null}
              </div>
              <form
                className="mt-3 flex flex-col gap-2 sm:flex-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitFamilySalesChat();
                }}
              >
                <textarea
                  value={familySalesChatInput}
                  onChange={(event) => setFamilySalesChatInput(event.target.value)}
                  placeholder="继续追问，例如：帮我把这段建议改成更温和的微信话术"
                  rows={2}
                  className="min-h-[52px] flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold leading-5 text-slate-900 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
                />
                <button
                  type="submit"
                  disabled={!familySalesChatInput.trim() || familySalesChatLoading}
                  className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 text-sm font-black text-white shadow-sm shadow-blue-900/15 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-55 sm:h-auto"
                >
                  <SendHorizontal size={17} />
                  <span>{familySalesChatLoading ? '生成中' : '发送'}</span>
                </button>
              </form>
            </section>
          ) : (
            <div className={familySalesReviewLoading ? 'overflow-hidden rounded-[24px] bg-slate-950 text-white shadow-xl shadow-cyan-950/20 ring-1 ring-cyan-200/30' : 'rounded-[22px] bg-white p-4 ring-1 ring-slate-200'}>
              {familySalesReviewLoading ? (
                <div className="relative overflow-hidden px-4 py-4 sm:px-5 sm:py-5">
                  <div className="pointer-events-none absolute inset-0 opacity-35 [background-image:linear-gradient(rgba(34,211,238,0.16)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.16)_1px,transparent_1px)] [background-size:26px_26px]" />
                  <div className="pointer-events-none absolute left-0 right-0 top-14 h-px animate-pulse bg-gradient-to-r from-transparent via-cyan-200 to-transparent" />
                  <div className="relative space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-300/15 text-cyan-100 ring-1 ring-cyan-200/35">
                          <Sparkles className="h-5 w-5 animate-pulse" />
                          <span className="absolute inset-1 rounded-2xl border border-cyan-200/20" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-base font-black text-white">专家研判控制台</p>
                            <span className="rounded-full bg-cyan-300/12 px-2.5 py-1 text-[11px] font-black text-cyan-100 ring-1 ring-cyan-200/25">实时生成中</span>
                          </div>
                          <p className="mt-1 text-xs font-semibold leading-5 text-slate-300">正在交叉研判家庭成员、保障缺口、条款证据与财富线索。</p>
                        </div>
                      </div>
                      <div className="rounded-2xl bg-white/8 px-3 py-2 ring-1 ring-white/10">
                        <p className="text-[11px] font-black text-slate-400">策略生成进度</p>
                        <p className="mt-1 text-lg font-black text-cyan-100">{familySalesReviewProgress}%</p>
                      </div>
                    </div>

                    <div className="rounded-2xl bg-white/[0.07] px-4 py-4 ring-1 ring-white/10">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-black text-white">报告生成进度条</p>
                          <p className="mt-1 text-xs font-semibold text-slate-400">生成完成后会自动保存到家庭档案</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-cyan-300/12 px-3 py-1.5 text-xs font-black text-cyan-100 ring-1 ring-cyan-200/25">
                          {familySalesReviewProgress}%
                        </span>
                      </div>
                      <div
                        className="h-3 overflow-hidden rounded-full bg-white/10"
                        role="progressbar"
                        aria-label="专家报告生成进度"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={familySalesReviewProgress}
                      >
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-300 transition-all duration-700 ease-out"
                          style={{ width: `${familySalesReviewProgress}%` }}
                        />
                      </div>
                      <div className="mt-3 grid grid-cols-4 gap-2">
                        {familySalesReviewProgressStages.map((stage) => {
                          const active = familySalesReviewProgress >= stage.threshold;
                          return (
                            <div key={stage.label} className="min-w-0">
                              <div className={`h-1.5 rounded-full ${active ? 'bg-cyan-200' : 'bg-white/10'}`} />
                              <p className={`mt-1 truncate text-[10px] font-black ${active ? 'text-cyan-100' : 'text-slate-500'}`}>{stage.label}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="overflow-hidden rounded-2xl bg-white/8 ring-1 ring-white/10">
                      <div className="h-1.5 bg-white/10">
                        <div className="h-full w-[68%] animate-pulse bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-300" />
                      </div>
                      <div className="grid grid-cols-2 gap-px bg-white/10 sm:grid-cols-4">
                        {familySalesReviewSignals.map((item) => (
                          <div key={item.label} className={`relative overflow-hidden bg-slate-950/80 px-3 py-3 ${item.pendingLabel ? 'ring-1 ring-inset ring-white/10' : ''}`}>
                            {item.pendingLabel ? (
                              <div className="pointer-events-none absolute inset-x-0 top-0 h-px animate-pulse bg-gradient-to-r from-transparent via-cyan-100 to-transparent" />
                            ) : null}
                            <div className={`inline-flex rounded-full px-2 py-1 text-[11px] font-black ring-1 ${item.className}`}>
                              {item.label}
                            </div>
                            {item.pendingLabel ? (
                              <div
                                className="mt-2 flex items-center gap-2"
                                aria-live="polite"
                                aria-label={`${item.label}${item.pendingLabel}`}
                              >
                                <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                                  <span className="absolute h-full w-full animate-ping rounded-full bg-cyan-200/35" />
                                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-100/30 border-t-cyan-100" />
                                </span>
                                <span className="text-lg font-black text-white">{item.value}</span>
                                <span className="flex gap-0.5" aria-hidden="true">
                                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-100" />
                                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-100 [animation-delay:120ms]" />
                                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-100 [animation-delay:240ms]" />
                                </span>
                              </div>
                            ) : (
                              <p className="mt-2 text-lg font-black text-white">{item.value}</p>
                            )}
                            <p className="mt-0.5 text-[11px] font-semibold text-slate-400">{item.detail}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      {familySalesReviewSteps.map((step) => {
                        const StepIcon = step.icon;
                        return (
                          <div key={step.label} className="relative overflow-hidden rounded-2xl bg-white/[0.07] px-3 py-3 ring-1 ring-white/10">
                            <div className={`absolute left-0 right-0 top-0 h-px animate-pulse bg-gradient-to-r ${step.pulseClass}`} />
                            <div className="flex items-start gap-3">
                              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ${step.iconClass}`}>
                                <StepIcon size={18} />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="min-w-0 text-sm font-black text-white">{step.label}</p>
                                  <span className="shrink-0 rounded-full bg-white/8 px-2 py-1 text-[10px] font-black text-slate-300 ring-1 ring-white/10">{step.signal}</span>
                                </div>
                                <p className="mt-1 text-xs font-semibold leading-5 text-slate-300">{step.detail}</p>
                                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                                  <div className={`h-full animate-pulse rounded-full ${step.railClass}`} />
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="rounded-2xl bg-white/[0.07] px-4 py-4 ring-1 ring-white/10">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="text-sm font-black text-white">研判信号矩阵</p>
                        <span className="rounded-full bg-emerald-300/10 px-2.5 py-1 text-[11px] font-black text-emerald-100 ring-1 ring-emerald-200/20">自动保存报告</span>
                      </div>
                      <div className="grid gap-2 text-xs font-semibold text-slate-300 sm:grid-cols-3">
                        <div className="rounded-xl bg-slate-900/80 px-3 py-2 ring-1 ring-white/10">
                          <span className="text-cyan-100">数据清洗</span>
                          <p className="mt-1 text-slate-400">脱敏关系、年龄、投保人与被保人结构</p>
                        </div>
                        <div className="rounded-xl bg-slate-900/80 px-3 py-2 ring-1 ring-white/10">
                          <span className="text-emerald-100">责任比对</span>
                          <p className="mt-1 text-slate-400">重疾、医疗、寿险、意外与年金责任</p>
                        </div>
                        <div className="rounded-xl bg-slate-900/80 px-3 py-2 ring-1 ring-white/10">
                          <span className="text-amber-100">机会建模</span>
                          <p className="mt-1 text-slate-400">保障缺口、理财险切入点与跟进动作</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center">
                  <p className="text-sm font-black text-slate-900">销售建议尚未生成</p>
                  <p className="mx-auto mt-2 max-w-md text-xs font-semibold leading-5 text-slate-500">
                    有已保存内容会直接展示；没有保存内容时可点击上方或下方按钮生成。
                  </p>
                  <button
                    type="button"
                    className="mt-5 inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-cyan-300 px-5 text-sm font-black text-slate-950 shadow-lg shadow-cyan-950/10 transition hover:bg-cyan-200"
                    onClick={() => void regenerateFamilySalesReview()}
                  >
                    <Sparkles className="h-4 w-4" />
                    <span>生成销售建议</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  ) : null;

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
      membershipStatus={membershipStatus}
      mobile={mobile}
      policyCount={policies.length}
      onClose={() => setShowAccountSheet(false)}
      onOpenMembership={() => {
        setShowAccountSheet(false);
        setShowMembershipDialog(true);
        if (token) void refreshMembershipStatus(token).catch(() => undefined);
      }}
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
  const membershipDialog = showMembershipDialog ? (
    <MembershipPurchaseDialog
      loading={membershipLoading}
      message={membershipMessage}
      membershipStatus={membershipStatus}
      onClose={() => setShowMembershipDialog(false)}
      onPurchase={handleMembershipPurchase}
      onRefresh={() => {
        setMembershipMessage('正在刷新会员状态');
        void refreshMembershipStatus()
          .then(() => setMembershipMessage('会员状态已刷新'))
          .catch((error) => setMembershipMessage(error instanceof Error ? error.message : '刷新失败'));
      }}
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
      customerSummary={assistantCustomerSummary}
      customerSummaryLoading={assistantCustomerSummaryLoading}
      customerSummaryMessage={assistantCustomerSummaryMessage}
      localSearched={assistantLocalSearched}
      loading={assistantLoading}
      matches={assistantMatches}
      message={assistantMessage}
      name={assistantName}
      productSuggestionLoading={assistantProductSuggestionLoading}
      productSuggestions={assistantProductSuggestions}
      selectedMatchKey={assistantSelectedMatchKey}
      onChangeCompany={(value) => {
        setAssistantCompany(value);
        setAssistantAnalysis(null);
        resetAssistantCustomerSummary('');
        setAssistantMatches([]);
        setAssistantSelectedMatchKey('');
        setAssistantLocalSearched(false);
        setAssistantMessage('输入保司和产品名称');
      }}
      onChangeName={(value) => {
        setAssistantName(value);
        setAssistantAnalysis(null);
        resetAssistantCustomerSummary('');
        setAssistantMatches([]);
        setAssistantSelectedMatchKey('');
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
        resetAssistantCustomerSummary('');
        setAssistantMatches([]);
        setAssistantSelectedMatchKey('');
        setAssistantLocalSearched(false);
        setAssistantMessage('输入保司和产品名称');
      }}
      onSelectMatch={(match) => void handleAssistantSelectMatch(match)}
      onSelectProduct={(suggestion, displayName) => {
        setAssistantCompany(suggestion.company);
        setAssistantName(displayName || productSuggestionDisplayName(suggestion) || suggestion.productName);
        setAssistantAnalysis(null);
        resetAssistantCustomerSummary('');
        setAssistantMatches([]);
        setAssistantSelectedMatchKey('');
        setAssistantLocalSearched(false);
        setAssistantMessage('输入保司和产品名称');
      }}
      open={assistantOpen}
    />
    );
  }
  const responsibilityAssistant = renderResponsibilityAssistant('bottom-24');

  if (familySalesReviewOpen) {
    return (
      <>
        {familySalesReviewPage}
        {authDialog}
        {accountSheet}
        {membershipDialog}
        {cashValueDialog}
        {familyCreateDialog}
      </>
    );
  }

  if (showFamilyReport) {
    return (
      <>
        <FamilyReportPage
          report={displayFamilyReport}
          planningProfile={familyPlanningProfile}
          policyAnalysisReport={familyPolicyAnalysisReport}
          policyAnalysisLoading={familyPolicyAnalysisLoading}
          onPlanningProfileChange={handleFamilyPlanningProfileChange}
          onBack={() => setShowFamilyReport(false)}
          onExport={(target, title) => void downloadReportImage(target, title)}
          onRegenerate={regenerateFamilyReport}
          onGeneratePolicyAnalysisReport={generateFamilyPolicyAnalysisReport}
          regenerating={familyReportLoading}
        />
        {familyReportLoading || familyPolicyAnalysisLoading ? (
          <div className="no-print fixed bottom-40 right-4 z-30 rounded-full bg-white px-4 py-2 text-xs font-black text-slate-600 shadow-lg shadow-slate-950/10">
            {familyPolicyAnalysisLoading ? '保单分析报告生成中...' : '报告加载中...'}
          </div>
        ) : null}
        {authDialog}
        {accountSheet}
        {membershipDialog}
        {cashValueDialog}
        {familyCreateDialog}
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
        {membershipDialog}
        {cashValueDialog}
        {familyCreateDialog}
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
          productKnowledgeUploading={productKnowledgeUploading}
          productKnowledgeUploadCount={productKnowledgeUploadCount}
          productKnowledgeUploadItems={productKnowledgeUploadItems}
          showProductKnowledgeSupplement={formProductMatchStatus === 'not_found' || formProductMatchStatus === 'source_review_required'}
          optionalResponsibilities={analysisDraft?.optionalResponsibilities || []}
          selectedFamilyId={entryFamilyId}
          selectedFamilyMembers={Array.isArray(entrySelectedFamily?.members) ? entrySelectedFamily.members : []}
          onFileChange={handleFileChange}
          onProductKnowledgeFileChange={handleProductKnowledgeFileChange}
          onDeleteBaseUpload={handleDeleteBaseUpload}
          onDeleteProductKnowledgeUpload={(index) => void handleDeleteProductKnowledgeUpload(index)}
          onReplaceBaseUpload={handleScanClick}
          onReplaceProductKnowledgeUpload={handleReplaceProductKnowledgeUpload}
          onCreateFamily={openFamilyCreateDialog}
          onOcrTextChange={handleOcrTextChange}
          onScanClick={handleScanClick}
          onProductKnowledgeScanClick={handleProductKnowledgeScanClick}
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
          productKnowledgeFileInputRef={productKnowledgeFileInputRef}
          staleClientDetected={Boolean(staleClientHealth)}
          onReloadForLatestVersion={() => window.location.reload()}
        />
        {renderResponsibilityAssistant('bottom-24')}
        {authDialog}
        {accountSheet}
        {membershipDialog}
        {cashValueDialog}
        {familyCreateDialog}
      </>
    );
  }

  if (cashflowMember) {
    return (
      <>
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
        {authDialog}
        {accountSheet}
        {membershipDialog}
        {familyCreateDialog}
      </>
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
                  <p className="mt-1 text-xl font-black">{familyPolicyCount} 张</p>
                </div>
                <div className="rounded-2xl bg-white/15 px-4 py-3">
                  <p className="text-xs text-white/70">总保额</p>
                  <p className="mt-1 text-xl font-black">{formatCoverageAmount(familyTotalCoverage)}</p>
                </div>
              </div>
            </div>
          </div>

          <FamilyCoverageOverview
            report={displayFamilyReport}
            policies={selectedFamilyPolicies}
          />

          {familyPolicyCount ? (
            <section className="px-4 pt-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <button
                  type="button"
                  className="flex min-w-0 items-center justify-between rounded-[20px] border border-[#D9E6F4] bg-white px-4 py-3 text-left shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]"
                  onClick={() => selectedFamilyId ? void openFamilyReport(selectedFamilyId) : undefined}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-black text-[#0F172A]">家庭保障分析报告</span>
                    <span className="mt-1 block text-xs font-semibold text-[#7890AA]">全家统计、保单清单、重疾、意外、财富分析</span>
                  </span>
                  <span className="ml-3 shrink-0 rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-600">查看</span>
                </button>
                <button
                  type="button"
                  className="flex min-h-[64px] items-center justify-center rounded-[20px] border border-[#D9E6F4] bg-white px-4 text-xs font-black text-blue-600 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]"
                  onClick={() => void handleShareFamilyReport(selectedFamilyId)}
                  aria-label="分享家庭报告"
                  title="分享家庭报告"
                >
                  <span>分享</span>
                </button>
              </div>
            </section>
          ) : null}

          <section className="space-y-4 p-4">
            {!familyPolicyCount ? (
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

        <CustomerBottomTabs
          activeTab="families"
          onChange={(tab) => {
            if (tab === 'entry') {
              setShowFamilyPolicies(false);
              startEntryForm({ preserveSelectedFamily: true });
            }
          }}
        />

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
        {membershipDialog}
        {cashValueDialog}
        {familyCreateDialog}
      </div>
    );
  }

  if (activeTab === 'families') {
    return (
      <>
        <FamilyProfileManager
          familyProfiles={familyProfiles}
          familyPolicyCounts={familyPolicyCounts}
          familyPolicyMemberIds={familyPolicyMemberIds}
          familyMemberPolicyRefs={familyMemberPolicyRefs}
          selectedFamilyId={selectedFamilyId}
          onSelectFamily={(familyId) => handleSelectFamily(familyId)}
          onCreateFamily={openFamilyCreateDialog}
          onCreateFamilyMember={createFamilyMemberForFamily}
          onUpdateFamily={updateFamilyForFamily}
          onDeleteFamily={deleteFamilyForFamily}
          onSetCoreMember={setCoreMemberForCurrentFamily}
          onUpdateFamilyMember={updateFamilyMemberForFamily}
          onUpdateFamilyMemberRelation={updateFamilyMemberRelationForFamily}
          onDeleteFamilyMember={deleteFamilyMemberForFamily}
          onBackToEntry={() => {
            startEntryForm({ preserveSelectedFamily: true });
          }}
          onOpenReport={openFamilyReport}
          onOpenSalesReview={(familyId) => void openFamilySalesReview(familyId)}
          onViewFamilyPolicies={viewFamilyPolicies}
        />
        <CustomerBottomTabs activeTab={activeTab} onChange={setActiveTab} />
        {authDialog}
        {accountSheet}
        {membershipDialog}
        {cashValueDialog}
        {familyCreateDialog}
      </>
    );
  }

  return null;
}
