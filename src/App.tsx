import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Camera,
  CheckCircle2,
  ChevronLeft,
  CircleUserRound,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileText,
  LayoutDashboard,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  SendHorizontal,
  Shield,
  Sparkles,
  Trash2,
  UploadCloud,
  Users,
  X,
} from 'lucide-react';
import {
  AdminOcrConfig,
  AdminOfficialDomainProfile,
  AdminOverview,
  ApiError,
  CashValueRow,
  CashValueScanResult,
  CashflowEntry,
  KnowledgeRecord,
  MemberAnnualSummary,
  MemberYearEntry,
  OptionalResponsibility,
  OptionalResponsibilityGap,
  Policy,
  PolicyAnalysisResult,
  PolicyCashflowPlan,
  PolicyCompanySuggestion,
  CoverageIndicator,
  PolicyFormData,
  PolicyKnowledgeMatch,
  PolicyProductSuggestion,
  PolicyScanResult,
  Responsibility,
  ScenarioEntry,
  UploadItem,
  adminLogin,
  analyzePolicy,
  confirmCashValue,
  crawlAdminKnowledge,
  createAdminOfficialDomainProfile,
  deleteAdminOfficialDomainProfile,
  deletePolicy,
  getAdminOfficialDomainProfiles,
  getAdminKnowledgeRecords,
  getAdminOcrConfig,
  getAdminOverview,
  getPolicy,
  listPolicies,
  listPolicyResponsibilityCompanySuggestions,
  listPolicyResponsibilityProductSuggestions,
  logClientPerformance,
  logoutCustomer,
  matchPolicyResponsibilities,
  markOptionalResponsibilityNotQuantifiable,
  queryPolicyResponsibilities,
  register,
  regeneratePolicyReport,
  reextractOptionalResponsibilities,
  recognizePolicy,
  scanCashValue,
  scanPolicy,
  sendCode,
  updateAdminOfficialDomainProfile,
  updateAdminOcrConfig,
  updatePolicy,
} from './api';
import {
  buildMemberAnnualSummaries,
  fillCashflowYears,
} from './cashflow-engine.mjs';
import { FamilyReportPage } from './FamilyReport';
import { buildFamilyReport } from './family-report-engine.mjs';
import type { FamilyPlanningProfile } from './family-report-engine.mjs';
import { policyValidityClassName, resolvePolicyValidityStatus } from './policy-validity.mjs';

const GUEST_ID_KEY = 'policy-ocr-app.guestId';
const TOKEN_KEY = 'policy-ocr-app.token';
const USER_MOBILE_KEY = 'policy-ocr-app.mobile';
const ADMIN_TOKEN_KEY = 'policy-ocr-app.adminToken';
const FAMILY_PLANNING_PROFILE_KEY = 'policy-ocr-app.familyPlanningProfile';
const MAX_POLICY_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_OCR_IMAGE_DIMENSION = 3600;
const OCR_IMAGE_JPEG_QUALITY = 0.96;
const OCR_IMAGE_DIRECT_UPLOAD_BYTES = 8 * 1024 * 1024;
const OCR_MODE_LABELS: Record<string, string> = {
  existing_default: '系统默认',
  macos_vision_local: '快速本机 OCR',
  paddleocr_local: 'PaddleOCR 稳定识别',
  qwen25_vl_3b_instruct_mlx_vlm: 'Qwen2.5-VL',
  paddleocr_vl_1_5: 'PaddleOCR-VL',
  minicpm_v_4x_local: 'MiniCPM-V',
};
const POLICY_RELATION_OPTIONS = ['本人', '子女', '父母', '夫妻'];

declare global {
  interface Window {
    __wxjs_environment?: string;
  }
}

const emptyForm: PolicyFormData = {
  company: '',
  name: '',
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

function normalizePlanningProfile(value: unknown): FamilyPlanningProfile {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  return {
    annualExpense: Math.max(0, Number(source.annualExpense) || 0),
    debt: Math.max(0, Number(source.debt) || 0),
    educationGoal: Math.max(0, Number(source.educationGoal) || 0),
    retirementGoal: Math.max(0, Number(source.retirementGoal) || 0),
    availableAssets: Math.max(0, Number(source.availableAssets) || 0),
  };
}

function readFamilyPlanningProfile(): FamilyPlanningProfile {
  try {
    const raw = localStorage.getItem(FAMILY_PLANNING_PROFILE_KEY);
    return raw ? normalizePlanningProfile(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function saveFamilyPlanningProfile(profile: FamilyPlanningProfile) {
  const normalized = normalizePlanningProfile(profile);
  localStorage.setItem(FAMILY_PLANNING_PROFILE_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizePolicyPlanRoleLabel(role: string) {
  if (role === 'main') return '主险';
  if (role === 'linked_account') return '万能账户';
  if (role === 'rider') return '附加险';
  return '未分类';
}

function policyPlanRoleOrder(role: string) {
  if (role === 'main') return 0;
  if (role === 'rider') return 1;
  if (role === 'linked_account') return 2;
  return 3;
}

function normalizePolicyPlanList(
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

function planProductDisplayName(plan: NonNullable<PolicyFormData['plans']>[number]) {
  return String(plan.matchedProductName || plan.name || '未命名险种');
}

function normalizeBeneficiaryValue(value: string | undefined | null) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const text = raw.replace(/\s+/gu, '').replace(/^(身故保险金受益人|身故受益人|受益人)[:：]?/u, '');
  if (/^(?:被保险人)?的?法定(?:继承人|继本人|维承人|受益人)?$/u.test(text)) return '法定';
  if (/法定(?:继承人|继本人|维承人|受益人)/u.test(text)) return '法定';
  return raw;
}

function formatBeneficiaryValue(value: string | undefined | null) {
  return normalizeBeneficiaryValue(value) || '-';
}

function policyToForm(policy: Policy): PolicyFormData {
  return {
    company: policy.company || '',
    name: policy.name || '',
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
  };
}

function buildPolicyUpdateData(policy: Policy, data: PolicyFormData): PolicyFormData {
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
    beneficiary: normalizeBeneficiaryValue(data.beneficiary),
    plans,
  };
}

function scanToForm(scan: PolicyScanResult): PolicyFormData {
  const data = scan.data || {};
  return {
    company: String(data.company || ''),
    name: String(data.name || ''),
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
  };
}

function mergeScanToForm(scan: PolicyScanResult, current: PolicyFormData): PolicyFormData {
  const next = scanToForm(scan);
  return {
    ...next,
    beneficiary: next.beneficiary || current.beneficiary,
    applicantRelation: next.applicantRelation || current.applicantRelation,
    insuredRelation: next.insuredRelation || current.insuredRelation,
    insuredIdNumber: next.insuredIdNumber || current.insuredIdNumber,
    insuredBirthday: next.insuredBirthday || current.insuredBirthday,
  };
}

function formatCoverageAmount(value: number) {
  const amount = Number(value || 0);
  if (!amount) return '-';
  return `${(amount / 10000).toFixed(2)}万`;
}

function formatCurrency(value: number) {
  const amount = Number(value || 0);
  if (!amount) return '¥0';
  return `¥${amount.toLocaleString('zh-CN')}`;
}

function summarizeCashValues(cashValues?: CashValueRow[]) {
  const rows = Array.isArray(cashValues)
    ? [...cashValues].filter((row) => Number.isFinite(Number(row.policyYear)) && Number.isFinite(Number(row.cashValue)))
    : [];
  if (!rows.length) return null;
  rows.sort((left, right) => Number(left.policyYear) - Number(right.policyYear));
  return {
    count: rows.length,
    first: rows[0],
    last: rows[rows.length - 1],
  };
}

function parseNumericInput(value: string | number | null | undefined) {
  const normalized = String(value ?? '').replace(/[,，\s元¥￥]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function makeManualCashValueRow(policyYear = 1, age: number | null = null): CashValueRow {
  return { policyYear, age, cashValue: 0, source: 'manual' };
}

function normalizeCashValueRowsForEditing(cashValues?: CashValueRow[]) {
  const rows: CashValueRow[] = [];
  if (Array.isArray(cashValues)) {
    for (const row of cashValues) {
      const policyYear = parseNumericInput(row.policyYear);
      const age = row.age === null || row.age === undefined ? null : parseNumericInput(row.age);
      const cashValue = parseNumericInput(row.cashValue);
      if (policyYear === null || cashValue === null) continue;
      rows.push({
        policyYear,
        age,
        cashValue,
        source: row.source || 'manual',
      });
    }
    rows.sort((left, right) => left.policyYear - right.policyYear);
  }
  return rows.length ? rows : [makeManualCashValueRow()];
}

function nextManualCashValueRow(rows: CashValueRow[]) {
  const sortedRows = [...rows]
    .filter((row) => Number.isFinite(Number(row.policyYear)))
    .sort((left, right) => Number(left.policyYear) - Number(right.policyYear));
  const last = sortedRows[sortedRows.length - 1];
  const nextPolicyYear = Number(last?.policyYear || 0) + 1 || 1;
  const nextAge = last?.age === null || last?.age === undefined ? null : Number(last.age) + 1;
  return makeManualCashValueRow(nextPolicyYear, Number.isFinite(Number(nextAge)) ? nextAge : null);
}

function normalizeCashValueRowsForSaving(rows: CashValueRow[], source = 'manual') {
  const normalized: CashValueRow[] = [];
  for (const row of rows) {
    const policyYear = parseNumericInput(row.policyYear);
    const age = row.age === null || row.age === undefined ? null : parseNumericInput(row.age);
    const cashValue = parseNumericInput(row.cashValue);
    if (policyYear === null || policyYear <= 0 || cashValue === null || cashValue < 0) continue;
    normalized.push({
      policyYear,
      age,
      cashValue,
      source: row.source || source,
    });
  }
  normalized.sort((left, right) => left.policyYear - right.policyYear);
  const byPolicyYear = new Map<number, CashValueRow>();
  for (const row of normalized) byPolicyYear.set(row.policyYear, row);
  return [...byPolicyYear.values()];
}

type ResponsibilitySourceLink = {
  title: string;
  url: string;
  official: boolean;
  sourceType?: string;
};

function formatSourceUrlHost(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch (_error) {
    return url;
  }
}

function getPolicyResponsibilitySourceLinks(policy: Policy): ResponsibilitySourceLink[] {
  const links: ResponsibilitySourceLink[] = [];
  const seenUrls = new Set<string>();
  const pushLink = (source: { title?: string; url?: string; official?: boolean; evidenceLevel?: string; sourceType?: string; liability?: string; productName?: string } | null | undefined) => {
    const url = String(source?.url || '').trim();
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    links.push({
      title: String(source?.title || source?.liability || source?.productName || formatSourceUrlHost(url)).trim(),
      url,
      official: Boolean(source?.official) || String(source?.evidenceLevel || '') === 'insurer_official',
      sourceType: source?.sourceType,
    });
  };

  (policy.sources || []).forEach(pushLink);
  (policy.coverageIndicators || []).forEach((indicator) => {
    pushLink({
      title: indicator.liability || indicator.productName,
      url: indicator.sourceUrl,
      official: true,
      evidenceLevel: 'insurer_official',
    });
  });
  (policy.responsibilities || []).forEach((responsibility) => {
    pushLink({
      title: responsibility.sourceTitle || responsibility.coverageType,
      url: responsibility.sourceUrl,
      official: true,
      evidenceLevel: 'insurer_official',
    });
  });

  return links
    .sort((left, right) => Number(right.official) - Number(left.official))
    .slice(0, 5);
}

function formatDateLabel(value: string) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text.slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function maskMobile(mobile: string) {
  return mobile ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : '游客模式';
}

function formatOcrModeLabel(mode: string) {
  return OCR_MODE_LABELS[mode] || mode || '未配置';
}

function sanitizeAmount(value: string) {
  return value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
}

function productLookupKey(company: string, name: string) {
  return `${company.trim()}::${name.trim()}`;
}

function hasAnalysisResult(analysis: PolicyAnalysisResult | null) {
  return Boolean(analysis?.report?.trim() || analysis?.coverageTable?.length);
}

const OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS: Array<{ value: OptionalResponsibility['selectionStatus']; label: string }> = [
  { value: 'selected', label: '已投保' },
  { value: 'not_selected', label: '未投保' },
  { value: 'unknown', label: '不确定' },
];

function optionalResponsibilityStatusLabel(status?: string) {
  if (status === 'selected') return '已投保';
  if (status === 'not_selected') return '未投保';
  return '待核对';
}

function optionalResponsibilityQuantificationLabel(status?: string) {
  if (status === 'quantified') return '已量化';
  if (status === 'not_quantifiable') return '不进入量化';
  return '待量化';
}

function optionalResponsibilityHasQuantificationGap(item: OptionalResponsibility) {
  return item.selectionStatus === 'selected' && item.quantificationStatus !== 'quantified';
}

function optionalResponsibilityEvidenceLabel(evidence?: string) {
  if (evidence === 'manual') return '人工确认';
  if (evidence === 'policy_ocr') return '保单识别';
  if (evidence === 'policy_plan') return '险种明细';
  if (evidence === 'official_terms') return '官网条款';
  return '待核对';
}

function isSelectedCoverageIndicator(indicator: CoverageIndicator) {
  const scope = String(indicator.responsibilityScope || 'basic');
  const status = indicator.selectionStatus || (scope === 'optional' ? 'unknown' : 'selected');
  const quantificationStatus = indicator.quantificationStatus || 'pending_review';
  return scope !== 'optional' || (status === 'selected' && quantificationStatus === 'quantified');
}

function selectedCoverageIndicators(indicators?: CoverageIndicator[]) {
  return (Array.isArray(indicators) ? indicators : []).filter(isSelectedCoverageIndicator);
}

function updateOptionalResponsibilityItems(
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

function getPolicyReportStatus(policy: Policy | null | undefined) {
  return String(policy?.reportStatus || 'ready');
}

function isPolicyReportGenerating(policy: Policy | null | undefined) {
  return getPolicyReportStatus(policy) === 'generating';
}

function isPolicyReportFailed(policy: Policy | null | undefined) {
  return getPolicyReportStatus(policy) === 'failed';
}

function getReportPlaceholder(policy: Policy) {
  if (isPolicyReportGenerating(policy)) return '报告正在生成中。保单已经保存，完整保险责任会自动刷新。';
  if (isPolicyReportFailed(policy)) return policy.reportError || '报告生成失败，请稍后重新生成或联系管理员。';
  const responsibilityCount = Array.isArray(policy.responsibilities) ? policy.responsibilities.length : 0;
  return policy.report || (responsibilityCount ? `已生成 ${responsibilityCount} 项保险责任。` : '暂无保险责任解析。');
}

function splitReportIntoParagraphs(value: string) {
  const raw = String(value || '').replace(/\r/g, '').trim();
  if (!raw) return ['暂无解析报告'];
  const normalized = raw
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([。！？!?；;])\s*(?=(保险责任|基本|特定|此外|保单|给付系数|红利|若|该产品|产品|保障))/g, '$1\n\n')
    .replace(/\s*(?=([一二三四五六七八九十]+[、.]|\d+、|\d+\.\s))/g, '\n\n');

  return normalized
    .split(/\n{1,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((paragraph) => {
      if (paragraph.length <= 120) return [paragraph];
      const sentences = paragraph.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [paragraph];
      const groups: string[] = [];
      let current = '';
      for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
        if (current && `${current}${sentence}`.length > 140) {
          groups.push(current);
          current = sentence;
        } else {
          current = `${current}${sentence}`;
        }
      }
      if (current) groups.push(current);
      return groups;
    });
}

function normalizePdfFileName(value: string) {
  return String(value || '保单解析报告')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function exportCurrentReportAsPdf(title: string) {
  const previousTitle = document.title;
  document.title = normalizePdfFileName(title);
  window.print();
  window.setTimeout(() => {
    document.title = previousTitle;
  }, 500);
}

type PrintableInfoRow = {
  label: string;
  value: string;
};

type PrintableResponsibilityRow = {
  title: string;
  paragraphs: string[];
};

function normalizePrintableInlineText(value: string) {
  return String(value || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function normalizePrintableBlockText(value: string) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitPrintableParagraphs(value: string) {
  return normalizePrintableBlockText(value)
    .split(/\n{1,}/)
    .map((row) => row.trim())
    .filter(Boolean);
}

function appendUniqueInfoRow(rows: PrintableInfoRow[], label: string, value: string) {
  const normalizedLabel = normalizePrintableInlineText(label).replace(/[：:]\s*$/u, '');
  const normalizedValue = normalizePrintableInlineText(value);
  if (!normalizedLabel || !normalizedValue) return;
  if (rows.some((row) => row.label === normalizedLabel)) return;
  rows.push({ label: normalizedLabel, value: normalizedValue });
}

function extractInfoRowFromParagraph(paragraph: HTMLParagraphElement) {
  const strong = paragraph.querySelector('strong');
  if (!strong) return null;
  const label = normalizePrintableInlineText(strong.textContent || '').replace(/[：:]\s*$/u, '');
  const clone = paragraph.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('strong').forEach((node) => node.remove());
  const value = normalizePrintableInlineText(clone.textContent || '').replace(/^[：:\s]+/u, '');
  if (!label || !value) return null;
  return { label, value };
}

function extractPrintableInfoRows(target: HTMLElement) {
  const rows: PrintableInfoRow[] = [];
  target.querySelectorAll('.print-policy-grid p').forEach((node) => {
    if (!(node instanceof HTMLParagraphElement)) return;
    const row = extractInfoRowFromParagraph(node);
    if (row) appendUniqueInfoRow(rows, row.label, row.value);
  });
  if (rows.length) return rows;

  target.querySelectorAll('section div').forEach((node) => {
    if (!(node instanceof HTMLElement) || node.closest('.no-print')) return;
    const paragraphChildren = Array.from(node.children).filter(
      (child): child is HTMLParagraphElement => child instanceof HTMLParagraphElement,
    );
    if (paragraphChildren.length < 2) return;
    const label = normalizePrintableInlineText(paragraphChildren[0]?.textContent || '');
    const value = normalizePrintableInlineText(paragraphChildren[1]?.textContent || '');
    if (label.length > 14 || value.length > 80) return;
    appendUniqueInfoRow(rows, label, value);
  });
  return rows;
}

function findPrintableInfoValue(rows: PrintableInfoRow[], labels: string[]) {
  return rows.find((row) => labels.includes(row.label))?.value || '';
}

function extractPrintableGeneratedAt(target: HTMLElement) {
  const generatedText = Array.from(target.querySelectorAll('.print-only p'))
    .map((node) => normalizePrintableInlineText(node.textContent || ''))
    .find((text) => /^生成时间[:：]/u.test(text));
  return generatedText?.replace(/^生成时间[:：]\s*/u, '') || new Date().toLocaleString('zh-CN', { hour12: false });
}

function extractPrintableResponsibilities(target: HTMLElement) {
  const matchedSections = Array.from(target.querySelectorAll('section')).filter((section) => {
    if (!(section instanceof HTMLElement) || section.closest('.no-print')) return false;
    const headingText = normalizePrintableInlineText(
      Array.from(section.querySelectorAll('h2,h3'))
        .map((heading) => heading.textContent || '')
        .join(' '),
    );
    return /保险责任|责任解析/u.test(headingText);
  });
  const articles = new Set<HTMLElement>();
  for (const section of matchedSections) {
    section.querySelectorAll('article').forEach((article) => {
      if (article instanceof HTMLElement && !article.closest('.no-print')) articles.add(article);
    });
  }
  if (!articles.size) {
    target.querySelectorAll('article').forEach((article) => {
      if (article instanceof HTMLElement && !article.closest('.no-print')) articles.add(article);
    });
  }

  return Array.from(articles)
    .map((article) => {
      const title = normalizePrintableInlineText(article.querySelector('h4')?.textContent || '保险责任');
      const paragraphs = Array.from(article.querySelectorAll('p'))
        .flatMap((paragraph) => splitPrintableParagraphs(paragraph.textContent || ''))
        .filter((paragraph) => paragraph && paragraph !== title);
      return { title, paragraphs };
    })
    .filter((row) => row.paragraphs.length && !/暂无|正在生成/u.test(row.paragraphs.join(' ')));
}

function createPdfElement<K extends keyof HTMLElementTagNameMap>(tagName: K, style: string, text = '') {
  const element = document.createElement(tagName);
  element.setAttribute('style', style);
  if (text) element.textContent = text;
  return element;
}

function appendPdfSectionTitle(parent: HTMLElement, title: string) {
  const heading = createPdfElement(
    'h2',
    [
      'margin:0 0 14px',
      'font-size:18px',
      'line-height:1.35',
      'font-weight:800',
      'color:#0f172a',
      'letter-spacing:0',
    ].join(';'),
    title,
  );
  parent.appendChild(heading);
}

function appendPrintableInfoGrid(parent: HTMLElement, rows: PrintableInfoRow[]) {
  const grid = createPdfElement(
    'div',
    [
      'display:grid',
      'grid-template-columns:repeat(2,minmax(0,1fr))',
      'border:1px solid #dbe4ef',
      'border-radius:8px',
      'overflow:hidden',
      'background:#ffffff',
    ].join(';'),
  );
  rows.forEach((row, index) => {
    const item = createPdfElement(
      'div',
      [
        'min-height:54px',
        'padding:10px 12px',
        'box-sizing:border-box',
        index % 2 === 0 ? 'border-right:1px solid #e5edf7' : '',
        index < rows.length - 2 ? 'border-bottom:1px solid #e5edf7' : '',
      ]
        .filter(Boolean)
        .join(';'),
    );
    item.appendChild(createPdfElement('p', 'margin:0 0 4px;font-size:11px;line-height:1.4;font-weight:700;color:#64748b', row.label));
    item.appendChild(createPdfElement('p', 'margin:0;font-size:14px;line-height:1.55;font-weight:700;color:#0f172a;word-break:break-word', row.value));
    grid.appendChild(item);
  });
  parent.appendChild(grid);
}

function appendPrintableResponsibilities(parent: HTMLElement, responsibilities: PrintableResponsibilityRow[]) {
  const list = createPdfElement('div', 'display:grid;gap:12px');
  responsibilities.forEach((row, index) => {
    const article = createPdfElement(
      'article',
      [
        'display:grid',
        'grid-template-columns:32px minmax(0,1fr)',
        'gap:12px',
        'border:1px solid #dbe4ef',
        'border-left:4px solid #2563eb',
        'border-radius:8px',
        'background:#ffffff',
        'padding:14px',
        'break-inside:avoid',
      ].join(';'),
    );
    article.appendChild(
      createPdfElement(
        'div',
        [
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'width:28px',
          'height:28px',
          'border-radius:999px',
          'background:#eff6ff',
          'color:#1d4ed8',
          'font-size:13px',
          'font-weight:800',
        ].join(';'),
        String(index + 1),
      ),
    );
    const content = createPdfElement('div', 'min-width:0');
    content.appendChild(
      createPdfElement('h3', 'margin:0 0 8px;font-size:16px;line-height:1.45;font-weight:800;color:#0f172a', row.title || '保险责任'),
    );
    row.paragraphs.forEach((paragraph, paragraphIndex) => {
      content.appendChild(
        createPdfElement(
          'p',
          [
            `margin:${paragraphIndex === 0 ? 0 : 8}px 0 0`,
            'font-size:13px',
            'line-height:1.8',
            'font-weight:500',
            'color:#334155',
            'word-break:break-word',
            'white-space:pre-wrap',
          ].join(';'),
          paragraph,
        ),
      );
    });
    article.appendChild(content);
    list.appendChild(article);
  });
  parent.appendChild(list);
}

function appendPrintableCashflowTable(
  parent: HTMLElement,
  entries: CashflowEntry[],
  plan: { effectiveDate: string; insuredBirthday: string; policyId: number; productName: string },
) {
  if (!entries.length) return;
  const effectiveYear = plan.effectiveDate ? new Date(plan.effectiveDate).getFullYear() : 0;
  const birthYear = plan.insuredBirthday ? new Date(plan.insuredBirthday).getFullYear() : 0;
  const lastEntryYear = entries.length ? entries[entries.length - 1].year : 0;
  const endYear = Math.max(lastEntryYear, effectiveYear + 50, birthYear + 85);
  const allEntries = (effectiveYear && birthYear)
    ? fillCashflowYears(entries, effectiveYear, birthYear, endYear, { policyId: plan.policyId, productName: plan.productName })
    : entries;

  const section = document.createElement('section');
  section.setAttribute('style', 'margin-bottom:20px;break-inside:avoid');

  const title = document.createElement('h2');
  title.setAttribute('style', 'margin:0 0 14px;font-size:18px;line-height:1.35;font-weight:800;color:#0f172a');
  title.textContent = `现金流明细（${allEntries.length}年）`;
  section.appendChild(title);

  const table = document.createElement('table');
  table.setAttribute('style', 'width:100%;border-collapse:collapse;font-size:12px;line-height:1.6');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['年份', '领取金额', '累计领取', '现金价值'].forEach((label) => {
    const th = document.createElement('th');
    th.setAttribute('style', 'background:#2563eb;color:#fff;padding:8px 10px;text-align:left;font-weight:700');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  allEntries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.setAttribute('style', i % 2 === 0 ? '' : 'background:#f8fafc');
    const hasAmount = entry.amount > 0;
    const isLastAndMaturity = hasAmount && /满期/.test(entry.liability);
    if (isLastAndMaturity) tr.setAttribute('style', 'background:#fff7ed;font-weight:800;border-left:4px solid #f97316');

    const cells = [
      `${entry.year}/${entry.age}`,
      hasAmount ? entry.amount.toLocaleString('zh-CN') : '—',
      hasAmount ? entry.cumulative.toLocaleString('zh-CN') : '—',
      entry.cashValue != null ? entry.cashValue.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '—',
    ];
    cells.forEach((text, ci) => {
      const td = document.createElement('td');
      td.setAttribute('style', `padding:6px 10px;border-bottom:1px solid #e2e8f0;${ci > 0 ? 'text-align:right' : ''}`);
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);
  parent.appendChild(section);
}

function appendPrintableScenarioTable(parent: HTMLElement, entries: ScenarioEntry[]) {
  if (!entries.length) return;
  const section = document.createElement('section');
  section.setAttribute('style', 'margin-bottom:20px');

  const title = document.createElement('h2');
  title.setAttribute('style', 'margin:0 0 14px;font-size:18px;line-height:1.35;font-weight:800;color:#0f172a');
  title.textContent = `保障责任明细（${entries.length}项）`;
  section.appendChild(title);

  const table = document.createElement('table');
  table.setAttribute('style', 'width:100%;border-collapse:collapse;font-size:12px;line-height:1.6');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['场景', '计算公式', '金额'].forEach((label) => {
    const th = document.createElement('th');
    th.setAttribute('style', 'background:#2563eb;color:#fff;padding:8px 10px;text-align:left;font-weight:700');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.setAttribute('style', i % 2 === 0 ? '' : 'background:#f8fafc');
    const isBold = entry.amount >= 1000000;

    [
      { text: entry.scenario, style: `${entry.condition ? 'padding-left:24px;' : ''}${isBold ? 'font-weight:800' : ''}` },
      { text: entry.formula, style: 'color:#64748b' },
      { text: entry.amount.toLocaleString('zh-CN'), style: `text-align:right;${isBold ? 'font-weight:800;color:#1e40af' : ''}` },
    ].forEach(({ text, style }) => {
      const td = document.createElement('td');
      td.setAttribute('style', `padding:6px 10px;border-bottom:1px solid #e2e8f0;${style}`);
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);
  parent.appendChild(section);
}

function createPrintableReportNode(target: HTMLElement, title: string, policy?: Policy) {
  const infoRows = extractPrintableInfoRows(target);
  const responsibilities = extractPrintableResponsibilities(target);
  const generatedAt = extractPrintableGeneratedAt(target);
  const company = findPrintableInfoValue(infoRows, ['保险公司']) || normalizePrintableInlineText(target.querySelector('section p')?.textContent || '');
  const productName = findPrintableInfoValue(infoRows, ['产品名称']) || normalizePrintableInlineText(target.querySelector('section h2')?.textContent || title);
  const insured = findPrintableInfoValue(infoRows, ['被保人', '被保险人']) || '-';
  const amount = findPrintableInfoValue(infoRows, ['保障额度', '保额']) || '-';
  const period = findPrintableInfoValue(infoRows, ['保障期间']) || '-';
  const premium = findPrintableInfoValue(infoRows, ['首期保费', '年度保费']) || '-';

  const report = createPdfElement(
    'main',
    [
      'box-sizing:border-box',
      'width:760px',
      'min-height:1040px',
      'padding:34px 38px',
      'background:#ffffff',
      'color:#0f172a',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif',
      'letter-spacing:0',
      'line-height:1.5',
      'overflow:visible',
    ].join(';'),
  );

  const header = createPdfElement(
    'header',
    [
      'display:flex',
      'align-items:flex-start',
      'justify-content:space-between',
      'gap:24px',
      'border-bottom:3px solid #2563eb',
      'padding-bottom:16px',
      'margin-bottom:22px',
    ].join(';'),
  );
  const headerText = createPdfElement('div', 'min-width:0;flex:1');
  headerText.appendChild(createPdfElement('p', 'margin:0 0 6px;font-size:11px;line-height:1.4;font-weight:800;color:#2563eb', 'POLICY OCR'));
  headerText.appendChild(createPdfElement('h1', 'margin:0;font-size:30px;line-height:1.22;font-weight:900;color:#0f172a', '保单解析报告'));
  header.appendChild(headerText);
  const generated = createPdfElement(
    'div',
    'flex-shrink:0;text-align:right;color:#64748b;font-size:12px;line-height:1.6;font-weight:600',
    `生成时间\n${generatedAt}`,
  );
  generated.setAttribute('style', `${generated.getAttribute('style')};white-space:pre-line`);
  header.appendChild(generated);
  report.appendChild(header);

  const hero = createPdfElement(
    'section',
    [
      'border:1px solid #cfe0f4',
      'border-radius:10px',
      'background:#f8fbff',
      'padding:18px 20px',
      'margin-bottom:18px',
      'break-inside:avoid',
    ].join(';'),
  );
  hero.appendChild(createPdfElement('p', 'margin:0 0 7px;font-size:12px;line-height:1.5;font-weight:800;color:#2563eb', company || '保险公司'));
  hero.appendChild(createPdfElement('h2', 'margin:0;font-size:23px;line-height:1.42;font-weight:900;color:#0f172a;word-break:break-word', productName || title));
  const summaryGrid = createPdfElement(
    'div',
    'display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:15px',
  );
  [
    ['被保人', insured],
    ['保障额度', amount],
    ['保障期间', period],
    ['首期保费', premium],
  ].forEach(([label, value]) => {
    const chip = createPdfElement('div', 'border:1px solid #dbe4ef;border-radius:8px;background:#ffffff;padding:9px 10px;min-width:0');
    chip.appendChild(createPdfElement('p', 'margin:0 0 3px;font-size:10px;line-height:1.3;font-weight:700;color:#64748b', label));
    chip.appendChild(createPdfElement('p', 'margin:0;font-size:13px;line-height:1.45;font-weight:800;color:#0f172a;word-break:break-word', value || '-'));
    summaryGrid.appendChild(chip);
  });
  hero.appendChild(summaryGrid);
  report.appendChild(hero);

  if (infoRows.length) {
    const infoSection = createPdfElement('section', 'margin-bottom:20px;break-inside:avoid');
    appendPdfSectionTitle(infoSection, '保单信息');
    appendPrintableInfoGrid(infoSection, infoRows);
    report.appendChild(infoSection);
  }

  const responsibilitySection = createPdfElement('section', 'margin-bottom:20px');
  appendPdfSectionTitle(responsibilitySection, `保险责任${responsibilities.length ? `（${responsibilities.length}项）` : ''}`);
  if (responsibilities.length) {
    appendPrintableResponsibilities(responsibilitySection, responsibilities);
  } else {
    responsibilitySection.appendChild(
      createPdfElement('p', 'margin:0;border:1px dashed #cbd5e1;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;color:#64748b', '暂无保险责任解析。'),
    );
  }
  report.appendChild(responsibilitySection);

  // 现金流明细（如果有）
  if (policy) {
    const p = policy;
    const cashflowPlans: PolicyCashflowPlan[] = [{
      policyId: p.id,
      productName: p.name || '',
      company: p.company || '',
      insured: p.insured || '',
      insuredBirthday: p.insuredBirthday || '',
      effectiveDate: p.date || '',
      annualEntries: p.cashflowEntries || [],
      scenarioEntries: p.scenarioEntries || [],
      totalDeterministicCashflow: p.totalCashflow ?? 0,
      expired: resolvePolicyValidityStatus(p.coveragePeriod, {
        effectiveDate: p.date,
        insuredBirthday: p.insuredBirthday,
      }).tone === 'expired',
    }];
    for (const plan of cashflowPlans) {
      if (plan.annualEntries.length) {
        appendPrintableCashflowTable(report, plan.annualEntries, {
          effectiveDate: plan.effectiveDate,
          insuredBirthday: plan.insuredBirthday,
          policyId: plan.policyId,
          productName: plan.productName,
        });
      }
      if (plan.scenarioEntries.length) {
        appendPrintableScenarioTable(report, plan.scenarioEntries);
      }
    }
  }

  report.appendChild(
    createPdfElement(
      'footer',
      'border-top:1px solid #e2e8f0;margin-top:22px;padding-top:12px;font-size:11px;line-height:1.7;color:#64748b',
      '本报告依据保单 OCR 识别信息及保险责任解析结果生成，请以保险合同条款和保险公司官方资料为准。',
    ),
  );

  return report;
}

type ReportExportOptions = { rawTarget?: boolean; preservePageStyle?: boolean };

function createPdfRenderTarget(target: HTMLElement, title: string, policy?: Policy, options?: ReportExportOptions) {
  const wrapper = document.createElement('div');
  const width = options?.preservePageStyle ? 1120 : 760;
  wrapper.setAttribute(
    'style',
    [
      'position:fixed',
      'left:-100000px',
      'top:0',
      `width:${width}px`,
      'min-height:1px',
      'background:#ffffff',
      'color:#0f172a',
      'z-index:-1',
      'overflow:visible',
      'pointer-events:none',
    ].join(';'),
  );

  const reportNode = options?.rawTarget ? (target.cloneNode(true) as HTMLElement) : createPrintableReportNode(target, title, policy);
  reportNode.classList?.add?.('print-policy-report');
  wrapper.appendChild(reportNode);
  document.body.appendChild(wrapper);

  if (options?.rawTarget && options.preservePageStyle) {
    preparePageStyleReportNode(reportNode, width);
  } else if (options?.rawTarget) {
    reportNode.querySelectorAll<HTMLElement>('[data-pdf-table-wrap]').forEach((node) => {
      node.style.overflow = 'visible';
      node.style.width = 'max-content';
      node.style.maxWidth = 'none';
    });
    const rawTargetWidth = Math.max(width, reportNode.scrollWidth || 0);
    wrapper.style.width = `${rawTargetWidth}px`;
    reportNode.style.width = `${rawTargetWidth}px`;
  }

  return {
    node: reportNode,
    width,
    captureWidth: options?.preservePageStyle ? width : Math.max(width, reportNode.scrollWidth || 0),
    cleanup() {
      wrapper.remove();
    },
  };
}

function preparePageStyleReportNode(reportNode: HTMLElement, width: number) {
  reportNode.classList.add('family-report-pdf-target');
  reportNode.classList.add('html2canvas-safe-export');
  reportNode.style.boxSizing = 'border-box';
  reportNode.style.width = `${width}px`;
  reportNode.style.maxWidth = 'none';
  reportNode.style.minHeight = '1px';
  reportNode.style.overflow = 'visible';
  reportNode.style.background = '#F4F8FC';
  reportNode.style.padding = '24px';

  reportNode.querySelectorAll<HTMLElement>('[data-family-report-raw-note], [data-report-canvas-skip], [data-report-export-table]').forEach((node) => {
    node.remove();
  });
  reportNode.querySelectorAll<HTMLElement>('[data-report-export-cards]').forEach((node) => {
    node.classList.remove('hidden', 'md:hidden');
    node.style.setProperty('display', 'block', 'important');
    node.style.setProperty('width', '100%', 'important');
  });
  reportNode.querySelectorAll<HTMLElement>('.print-only').forEach((node) => {
    node.style.display = 'none';
  });
  reportNode.querySelectorAll<HTMLElement>('[data-pdf-table-wrap]').forEach((node) => {
    node.style.overflow = 'visible';
    node.style.width = '100%';
    node.style.maxWidth = '100%';
  });
  reportNode.querySelectorAll<HTMLElement>('table').forEach((table) => {
    table.style.width = '100%';
    table.style.minWidth = '0';
    table.style.tableLayout = 'fixed';
  });
  reportNode.querySelectorAll<HTMLElement>('th,td').forEach((cell) => {
    cell.style.minWidth = '0';
    cell.style.whiteSpace = 'normal';
    cell.style.wordBreak = 'break-word';
    cell.style.verticalAlign = 'top';
  });
}

function escapeHtml(value: string) {
  return String(value || '').replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char] || char;
  });
}

function shouldOpenPdfPreviewWindow() {
  const userAgent = navigator.userAgent || '';
  return (
    /MicroMessenger|Mobi|Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth <= 820)
  );
}

function shouldUseInPageReportExport() {
  const userAgent = navigator.userAgent || '';
  return /MicroMessenger|Mobi|Android|iPhone|iPad|iPod/i.test(userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth <= 820);
}

function getReportExportControlText() {
  return shouldUseInPageReportExport() ? '长图' : 'PDF';
}

function getReportExportControlTitle() {
  return shouldUseInPageReportExport() ? '生成完整报告长图' : '导出 PDF';
}

function getPdfRenderScale() {
  const deviceScale = window.devicePixelRatio || 1;
  return shouldOpenPdfPreviewWindow() ? Math.min(1.35, deviceScale) : Math.min(1.6, deviceScale);
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function triggerPdfBlobDownload(pdfBlob: Blob, fileName: string) {
  const pdfUrl = URL.createObjectURL(pdfBlob);
  const link = document.createElement('a');
  link.href = pdfUrl;
  link.download = `${fileName}.pdf`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60 * 1000);
}

function triggerImageBlobDownload(imageBlob: Blob, fileName: string) {
  const imageUrl = URL.createObjectURL(imageBlob);
  const link = document.createElement('a');
  link.href = imageUrl;
  link.download = `${fileName}.jpg`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(imageUrl), 60 * 1000);
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.92) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('REPORT_IMAGE_BLOB_UNAVAILABLE'));
      }
    }, type, quality);
  });
}

function addCanvasPagesToPdf(pdf: import('jspdf').jsPDF, canvas: HTMLCanvasElement) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const pageCanvasHeight = Math.max(1, Math.floor((canvas.width * pageHeight) / pageWidth));
  const pageCanvas = document.createElement('canvas');
  const pageContext = pageCanvas.getContext('2d');
  if (!pageContext) throw new Error('PDF_PAGE_CANVAS_CONTEXT_UNAVAILABLE');

  pageCanvas.width = canvas.width;
  for (let sourceY = 0, pageIndex = 0; sourceY < canvas.height; sourceY += pageCanvasHeight, pageIndex += 1) {
    const sliceHeight = Math.min(pageCanvasHeight, canvas.height - sourceY);
    pageCanvas.height = sliceHeight;
    pageContext.fillStyle = '#ffffff';
    pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    pageContext.drawImage(canvas, 0, sourceY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

    if (pageIndex > 0) pdf.addPage();
    const imageHeight = (sliceHeight * pageWidth) / canvas.width;
    const imageData = pageCanvas.toDataURL('image/jpeg', 0.88);
    pdf.addImage(imageData, 'JPEG', 0, 0, pageWidth, imageHeight, undefined, 'FAST');
  }
}

function fitCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const value = String(text || '').trim();
  if (context.measureText(value).width <= maxWidth) return value;
  let next = '';
  for (const char of Array.from(value)) {
    if (context.measureText(`${next}${char}...`).width > maxWidth) break;
    next += char;
  }
  return `${next || value.slice(0, 8)}...`;
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const rows: string[] = [];
  let current = '';
  for (const char of Array.from(normalized)) {
    const next = `${current}${char}`;
    if (current && context.measureText(next).width > maxWidth) {
      rows.push(current);
      current = char.trimStart();
    } else {
      current = next;
    }
  }
  if (current) rows.push(current);
  return rows;
}

type ReportCanvasBlockKind = 'meta' | 'section' | 'heading' | 'item' | 'body';

type ReportCanvasBlock = {
  kind: ReportCanvasBlockKind;
  text: string;
};

function normalizeReportCanvasText(value: string) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\s*：\s*/g, '：').trim();
}

function truncateReportCanvasText(value: string, maxLength: number) {
  const normalized = normalizeReportCanvasText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactReportCanvasText(kind: ReportCanvasBlockKind, value: string) {
  const normalized = normalizeReportCanvasText(value);
  if (kind === 'section' || kind === 'heading' || kind === 'meta') return normalized;
  return truncateReportCanvasText(normalized, kind === 'item' ? 64 : 78);
}

function shouldSkipReportCanvasText(value: string) {
  return [
    '保单解析报告',
    '阅读确认后保存保单',
    '保存后会进入“我的保单”详情。',
    '以下内容来自本次 OCR 识别和责任解析。',
    '暂无 OCR 原文',
  ].includes(value);
}

function pushReportCanvasBlock(blocks: ReportCanvasBlock[], kind: ReportCanvasBlockKind, text: string) {
  const normalized = compactReportCanvasText(kind, text);
  if (!normalized || shouldSkipReportCanvasText(normalized)) return;
  if (/^生成时间：/.test(normalized)) return;
  const previous = blocks[blocks.length - 1];
  if (previous?.kind === kind && previous.text === normalized) return;
  blocks.push({ kind, text: normalized });
}

function extractReportBlocksForCanvas(target: HTMLElement) {
  const clone = target.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.no-print, script, style, svg, button, input, textarea, select, [data-family-report-raw-note], [data-report-canvas-skip]').forEach((node) => node.remove());
  const blocks: ReportCanvasBlock[] = [
    {
      kind: 'meta',
      text: `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    },
  ];
  const consumed = new WeakSet<Element>();
  const elements = Array.from(clone.querySelectorAll('h1,h2,h3,h4,p,li'));
  for (const element of elements) {
    if (consumed.has(element)) continue;
    const tagName = element.tagName.toLowerCase();
    const text = normalizeReportCanvasText(element.textContent || '');
    if (!text) continue;

    if (tagName === 'p') {
      const parent = element.parentElement;
      const siblingParagraphs = parent
        ? Array.from(parent.children).filter((child) => child.tagName.toLowerCase() === 'p')
        : [];
      if (siblingParagraphs.length === 2 && siblingParagraphs[0] === element) {
        const label = normalizeReportCanvasText(siblingParagraphs[0].textContent || '');
        const value = normalizeReportCanvasText(siblingParagraphs[1].textContent || '');
        consumed.add(siblingParagraphs[1]);
        pushReportCanvasBlock(blocks, 'item', value ? `${label}：${value}` : label);
        continue;
      }
      if (element.querySelector('strong')) {
        pushReportCanvasBlock(blocks, 'item', text);
        continue;
      }
      pushReportCanvasBlock(blocks, 'body', text);
      continue;
    }

    if (tagName === 'li') {
      pushReportCanvasBlock(blocks, 'body', `• ${text}`);
    } else if (tagName === 'h2' || tagName === 'h3') {
      pushReportCanvasBlock(blocks, 'section', text);
    } else if (tagName === 'h4') {
      pushReportCanvasBlock(blocks, 'heading', text);
    }
  }
  return blocks;
}

function drawRoundedCanvasRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

type ReportCanvasBlockStyle = {
  fontSize: number;
  fontWeight: 400 | 600 | 700;
  lineHeight: number;
  before: number;
  after: number;
  color: string;
  indent: number;
};

type PreparedReportCanvasBlock = {
  block: ReportCanvasBlock;
  style: ReportCanvasBlockStyle;
  wrapped: string[];
  verticalPadding: number;
  blockHeight: number;
};

function getReportCanvasBlockStyle(kind: ReportCanvasBlockKind): ReportCanvasBlockStyle {
  if (kind === 'section') {
    return { fontSize: 39, fontWeight: 700, lineHeight: 56, before: 26, after: 16, color: '#1d4ed8', indent: 0 };
  }
  if (kind === 'heading') {
    return { fontSize: 35, fontWeight: 700, lineHeight: 51, before: 20, after: 10, color: '#0f172a', indent: 0 };
  }
  if (kind === 'item') {
    return { fontSize: 33, fontWeight: 600, lineHeight: 50, before: 10, after: 10, color: '#0f172a', indent: 0 };
  }
  if (kind === 'meta') {
    return { fontSize: 31, fontWeight: 400, lineHeight: 46, before: 4, after: 24, color: '#64748b', indent: 0 };
  }
  return { fontSize: 35, fontWeight: 400, lineHeight: 54, before: 10, after: 18, color: '#0f172a', indent: 0 };
}

function prepareReportCanvasBlocks(
  context: CanvasRenderingContext2D,
  blocks: ReportCanvasBlock[],
  maxTextWidth: number,
): PreparedReportCanvasBlock[] {
  return blocks.map((block) => {
    const style = getReportCanvasBlockStyle(block.kind);
    context.font = `${style.fontWeight} ${style.fontSize}px Arial, sans-serif`;
    const textWidth = block.kind === 'item' ? maxTextWidth - 36 : maxTextWidth - style.indent;
    const wrapped = wrapCanvasText(context, block.text, textWidth);
    const verticalPadding = block.kind === 'item' ? 16 : 0;
    const blockHeight = style.before + wrapped.length * style.lineHeight + verticalPadding * 2 + style.after;
    return { block, style, wrapped, verticalPadding, blockHeight };
  });
}

function drawPreparedReportCanvasBlock(
  context: CanvasRenderingContext2D,
  prepared: PreparedReportCanvasBlock,
  y: number,
  marginX: number,
  maxTextWidth: number,
) {
  const { block, style, wrapped, verticalPadding } = prepared;
  let nextY = y + style.before;

  if (block.kind === 'section') {
    context.fillStyle = '#2563eb';
    drawRoundedCanvasRect(context, marginX, nextY - 27, 8, 30, 4);
    context.fill();
  }

  if (block.kind === 'item') {
    context.fillStyle = '#f8fbff';
    drawRoundedCanvasRect(
      context,
      marginX - 14,
      nextY - 24,
      maxTextWidth + 28,
      wrapped.length * style.lineHeight + verticalPadding * 2,
      14,
    );
    context.fill();
    nextY += verticalPadding;
  }

  context.font = `${style.fontWeight} ${style.fontSize}px Arial, sans-serif`;
  context.fillStyle = style.color;
  for (const row of wrapped) {
    context.fillText(row, marginX + style.indent, nextY);
    nextY += style.lineHeight;
  }
  if (block.kind === 'item') nextY += verticalPadding;
  return nextY + style.after;
}

function renderReportToLongImage(target: HTMLElement, fileName: string) {
  const pageWidth = 900;
  const marginX = 58;
  const headerHeight = 74;
  const contentTopPadding = 34;
  const footerHeight = 58;
  const maxTextWidth = pageWidth - marginX * 2;
  const blocks = extractReportBlocksForCanvas(target);
  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  if (!measureContext) throw new Error('REPORT_CANVAS_CONTEXT_UNAVAILABLE');
  const preparedBlocks = prepareReportCanvasBlocks(measureContext, blocks, maxTextWidth);
  const contentHeight = preparedBlocks.reduce((sum, block) => sum + block.blockHeight, 0);
  const canvasHeight = Math.max(420, Math.ceil(headerHeight + contentTopPadding + contentHeight + footerHeight));
  const canvas = document.createElement('canvas');
  canvas.width = pageWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('REPORT_CANVAS_CONTEXT_UNAVAILABLE');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pageWidth, canvasHeight);
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, pageWidth, headerHeight);
  context.fillStyle = '#0f172a';
  context.font = '700 24px Arial, sans-serif';
  context.fillText(fitCanvasText(context, fileName, pageWidth - marginX * 2), marginX, 46);

  let y = headerHeight + contentTopPadding;
  for (const block of preparedBlocks) {
    y = drawPreparedReportCanvasBlock(context, block, y, marginX, maxTextWidth);
  }

  context.fillStyle = '#94a3b8';
  context.font = '400 20px Arial, sans-serif';
  context.fillText('完整报告长图', marginX, canvasHeight - 24);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function createInPageReportExportPanel(fileName: string) {
  document.getElementById('pdf-inpage-export')?.remove();
  const previousOverflow = document.body.style.overflow;
  const objectUrls: string[] = [];
  const overlay = document.createElement('div');
  overlay.id = 'pdf-inpage-export';
  overlay.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'z-index:10000',
      'background:#f8fafc',
      'color:#0f172a',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'overflow:auto',
      '-webkit-overflow-scrolling:touch',
      'box-sizing:border-box',
    ].join(';'),
  );
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  function close() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    document.body.style.overflow = previousOverflow;
    overlay.remove();
  }

  function setHtml(html: string) {
    overlay.innerHTML = html;
  }

  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.dataset.action === 'close') close();
  });

  setHtml(`
    <main style="min-height:100%;box-sizing:border-box;padding:24px 16px 36px">
      <section style="margin:0 auto;max-width:520px;border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:22px;text-align:center;box-sizing:border-box">
        <h1 style="margin:0 0 8px;font-size:20px;line-height:1.35">正在生成报告</h1>
        <p style="margin:0;color:#64748b;font-size:14px;line-height:1.8">微信里不再跳转新窗口，请停留在当前页面。</p>
      </section>
    </main>
  `);

  return {
    close,
    update(message: string, detail = '请稍候，报告较长时需要几秒钟。') {
      setHtml(`
        <main style="min-height:100%;box-sizing:border-box;padding:24px 16px 36px">
          <section style="margin:0 auto;max-width:520px;border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:22px;text-align:center;box-sizing:border-box">
            <h1 style="margin:0 0 8px;font-size:20px;line-height:1.35">${escapeHtml(message)}</h1>
            <p style="margin:0;color:#64748b;font-size:14px;line-height:1.8">${escapeHtml(detail)}</p>
          </section>
        </main>
      `);
    },
    showResult(reportImage: string) {
      const safeFileName = escapeHtml(fileName);
      setHtml(`
        <main style="box-sizing:border-box;padding:16px 14px 32px">
          <section style="position:sticky;top:0;z-index:1;margin:0 auto 14px;max-width:520px;border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:18px;box-shadow:0 12px 30px rgba(15,23,42,.08);box-sizing:border-box">
            <h1 style="margin:0;font-size:20px;line-height:1.35">完整报告长图已生成</h1>
            <p style="margin:6px 0 0;color:#64748b;font-size:13px;line-height:1.7">${safeFileName}</p>
            <div style="display:flex;gap:10px;margin-top:14px">
              <button type="button" style="flex:1;border:0;border-radius:12px;background:#2563eb;color:#fff;padding:12px;text-align:center;font-size:15px;font-weight:800">长按完整长图保存</button>
              <button data-action="close" type="button" style="flex:1;border:0;border-radius:12px;background:#eef2ff;color:#1d4ed8;padding:12px;text-align:center;font-size:15px;font-weight:800">返回报告</button>
            </div>
            <p style="margin:10px 0 0;color:#64748b;font-size:12px;line-height:1.7">下面只有一张图，包含整份报告。微信内长按这张长图，选择保存到手机。</p>
          </section>
          <section style="margin:0 auto;max-width:520px">
            <figure style="margin:14px 0 0">
              <img src="${reportImage}" alt="完整报告长图" style="display:block;width:100%;border:1px solid #dbe4ef;border-radius:12px;background:#fff;box-sizing:border-box" />
              <figcaption style="margin-top:6px;color:#64748b;font-size:12px;text-align:center">完整报告长图，长按图片可保存整份报告</figcaption>
            </figure>
          </section>
        </main>
      `);
    },
    showError(message = '报告生成失败') {
      setHtml(`
        <main style="min-height:100%;box-sizing:border-box;padding:24px 16px 36px">
          <section style="margin:0 auto;max-width:520px;border:1px solid #fee2e2;border-radius:18px;background:#fff;padding:22px;text-align:center;box-sizing:border-box">
            <h1 style="margin:0 0 8px;font-size:20px;line-height:1.35;color:#dc2626">${escapeHtml(message)}</h1>
            <p style="margin:0;color:#64748b;font-size:14px;line-height:1.8">请返回原页面后使用手机截图保存当前报告。</p>
            <button data-action="close" type="button" style="margin-top:16px;border:0;border-radius:12px;background:#2563eb;color:#fff;padding:12px 18px;font-size:15px;font-weight:800">返回报告</button>
          </section>
        </main>
      `);
    },
  };
}

async function exportReportInCurrentPage(target: HTMLElement, fileName: string) {
  const panel = createInPageReportExportPanel(fileName);
  let reportImage = '';
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    panel.update('正在生成完整报告长图', '微信里不再打开浏览器，生成完成后会在本页显示一张完整长图。');
    reportImage = renderReportToLongImage(target, fileName);
    panel.showResult(reportImage);
  } catch (error) {
    console.error('[policy-ocr-app] in-page report image export failed', error);
    if (reportImage) {
      panel.showResult(reportImage);
    } else {
      panel.showError();
    }
  }
}

function openPdfPreviewWindow(fileName: string) {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) return null;
  const safeFileName = escapeHtml(fileName);
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeFileName}</title>
    <style>
      body{margin:0;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px;text-align:center;box-sizing:border-box}
      h1{margin:0 0 10px;font-size:20px;line-height:1.35}
      p{margin:0;color:#64748b;font-size:14px;line-height:1.8}
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>正在生成 PDF</h1>
        <p>请保持这个页面打开，生成完成后会显示保存入口。</p>
      </section>
    </main>
  </body>
</html>`);
  previewWindow.document.close();
  return previewWindow;
}

function showPdfExportFeedback(message = '正在生成 PDF') {
  const existing = document.getElementById('pdf-export-feedback');
  existing?.remove();
  const node = document.createElement('div');
  node.id = 'pdf-export-feedback';
  node.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'z-index:9999',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:24px',
      'background:rgba(15,23,42,0.36)',
      'box-sizing:border-box',
    ].join(';'),
  );
  const content = document.createElement('div');
  content.setAttribute(
    'style',
    [
      'width:min(320px,100%)',
      'border-radius:18px',
      'background:#ffffff',
      'padding:22px',
      'text-align:center',
      'box-shadow:0 24px 60px rgba(15,23,42,0.22)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    ].join(';'),
  );
  content.innerHTML = `<h2 style="margin:0 0 8px;font-size:18px;line-height:1.4;color:#0f172a">${escapeHtml(message)}</h2><p style="margin:0;font-size:13px;line-height:1.7;color:#64748b">请稍候，报告较长时需要几秒钟。</p>`;
  node.appendChild(content);
  document.body.appendChild(node);
  return {
    close(delay = 0) {
      window.setTimeout(() => node.remove(), delay);
    },
    update(nextMessage: string, detail = '请按页面提示保存或预览报告。') {
      content.innerHTML = `<h2 style="margin:0 0 8px;font-size:18px;line-height:1.4;color:#0f172a">${escapeHtml(nextMessage)}</h2><p style="margin:0;font-size:13px;line-height:1.7;color:#64748b">${escapeHtml(detail)}</p>`;
    },
  };
}

function writePdfPreviewWindow(previewWindow: Window, pdfUrl: string, fileName: string, fileSize = '') {
  const safePdfUrl = escapeHtml(pdfUrl);
  const safeFileName = escapeHtml(fileName);
  const safeFileSize = escapeHtml(fileSize);
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeFileName}</title>
    <style>
      html,body{min-height:100%;margin:0;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      body{display:flex;align-items:center;justify-content:center;padding:28px;box-sizing:border-box}
      main{width:min(420px,100%);border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:22px;box-shadow:0 20px 45px rgba(15,23,42,.08);box-sizing:border-box}
      h1{margin:0;font-size:20px;line-height:1.35}
      p{margin:8px 0 0;color:#64748b;font-size:13px;line-height:1.7}
      .meta{margin-top:12px;border-radius:12px;background:#f8fafc;padding:10px 12px;color:#334155;font-size:12px;line-height:1.6}
      .actions{display:flex;flex-direction:column;gap:10px;margin-top:18px}
      a{border-radius:12px;padding:12px;text-align:center;text-decoration:none;font-size:15px;font-weight:800}
      .primary{background:#2563eb;color:#fff}
      .secondary{background:#eff6ff;color:#1d4ed8}
    </style>
  </head>
  <body>
    <main>
      <h1>PDF 已生成</h1>
      <p>${safeFileName}</p>
      ${safeFileSize ? `<div class="meta">文件大小：${safeFileSize}</div>` : ''}
      <div class="actions">
        <a class="primary" href="${safePdfUrl}" download="${safeFileName}.pdf">保存 PDF</a>
        <a class="secondary" href="${safePdfUrl}" target="_blank" rel="noopener">备用打开</a>
      </div>
      <p>微信里优先点“保存 PDF”。如果备用打开一直转圈，请返回本页重新点保存，或用右上角在浏览器打开。</p>
    </main>
  </body>
</html>`);
  previewWindow.document.close();
}

function writePdfPreviewError(previewWindow: Window, fileName: string) {
  const safeFileName = escapeHtml(fileName);
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeFileName}</title>
    <style>
      body{margin:0;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px;text-align:center;box-sizing:border-box}
      h1{margin:0 0 10px;font-size:20px;line-height:1.35}
      p{margin:0;color:#64748b;font-size:14px;line-height:1.8}
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>PDF 生成失败</h1>
        <p>请返回原页面后重试，或使用手机系统截图/分享保存当前报告。</p>
      </section>
    </main>
  </body>
</html>`);
  previewWindow.document.close();
}

async function downloadReportPdf(target: HTMLElement | null, title: string, policy?: Policy, options?: ReportExportOptions) {
  if (!target) {
    exportCurrentReportAsPdf(title);
    return;
  }
  const fileName = normalizePdfFileName(title);
  if (shouldUseInPageReportExport()) {
    await exportReportInCurrentPage(target, fileName);
    return;
  }
  const previousTitle = document.title;
  const shouldUsePreviewWindow = shouldOpenPdfPreviewWindow();
  const previewWindow = shouldUsePreviewWindow ? openPdfPreviewWindow(fileName) : null;
  const feedback = shouldUsePreviewWindow ? showPdfExportFeedback() : null;
  let renderTarget: ReturnType<typeof createPdfRenderTarget> | null = null;
  try {
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
    document.title = fileName;
    document.body.classList.add(options?.preservePageStyle ? 'pdf-page-style-export-mode' : 'pdf-export-mode');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderTarget = createPdfRenderTarget(target, fileName, policy, options);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const renderWidth = renderTarget.captureWidth || renderTarget.node.scrollWidth || renderTarget.width;
    const renderHeight = renderTarget.node.scrollHeight || renderTarget.node.offsetHeight;
    const canvas = await html2canvas(renderTarget.node, {
      backgroundColor: '#ffffff',
      scale: getPdfRenderScale(),
      useCORS: false,
      width: renderWidth,
      height: renderHeight,
      windowWidth: renderWidth,
      windowHeight: renderHeight,
    });
    renderTarget.cleanup();
    renderTarget = null;
    const pdf = new jsPDF(options?.preservePageStyle ? 'l' : 'p', 'mm', 'a4');
    addCanvasPagesToPdf(pdf, canvas);
    if (shouldUsePreviewWindow) {
      const pdfBlob = pdf.output('blob');
      const pdfUrl = URL.createObjectURL(pdfBlob);
      window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 5 * 60 * 1000);
      if (previewWindow && !previewWindow.closed) {
        writePdfPreviewWindow(previewWindow, pdfUrl, fileName, formatFileSize(pdfBlob.size));
        feedback?.update('PDF 已生成', '请在刚打开的页面里点“保存 PDF”。');
        feedback?.close(900);
      } else {
        triggerPdfBlobDownload(pdfBlob, fileName);
        feedback?.update('PDF 已生成', '已尝试调起系统保存。');
        feedback?.close(1200);
      }
      return;
    }
    pdf.save(`${fileName}.pdf`);
  } catch (error) {
    console.error('[policy-ocr-app] PDF export failed', error);
    if (previewWindow && !previewWindow.closed) {
      writePdfPreviewError(previewWindow, fileName);
    }
    feedback?.update('PDF 生成失败', '正在尝试调用系统打印功能。');
    feedback?.close(1200);
    exportCurrentReportAsPdf(fileName);
  } finally {
    renderTarget?.cleanup();
    if (!shouldUsePreviewWindow) feedback?.close();
    document.body.classList.remove('pdf-export-mode');
    document.body.classList.remove('pdf-page-style-export-mode');
    document.title = previousTitle;
  }
}

async function downloadReportImage(target: HTMLElement | null, title: string, options?: ReportExportOptions) {
  const imageTarget = target || document.querySelector<HTMLElement>('.print-policy-report');
  if (!imageTarget) {
    const feedback = showPdfExportFeedback('图片生成失败');
    feedback.update('图片生成失败', '没有找到可导出的报告内容，请刷新后重试。');
    feedback.close(1600);
    return;
  }
  const fileName = normalizePdfFileName(title);
  if (shouldUseInPageReportExport()) {
    await exportReportInCurrentPage(imageTarget, fileName);
    return;
  }

  const previousTitle = document.title;
  const feedback = showPdfExportFeedback('正在生成图片');
  let renderTarget: ReturnType<typeof createPdfRenderTarget> | null = null;
  try {
    const { default: html2canvas } = await import('html2canvas');
    document.title = fileName;
    document.body.classList.add('pdf-page-style-export-mode');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderTarget = createPdfRenderTarget(imageTarget, fileName, undefined, { rawTarget: true, preservePageStyle: true, ...options });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const renderWidth = renderTarget.captureWidth || renderTarget.node.scrollWidth || renderTarget.width;
    const renderHeight = renderTarget.node.scrollHeight || renderTarget.node.offsetHeight;
    const canvas = await html2canvas(renderTarget.node, {
      backgroundColor: '#F4F8FC',
      scale: getPdfRenderScale(),
      useCORS: false,
      width: renderWidth,
      height: renderHeight,
      windowWidth: renderWidth,
      windowHeight: renderHeight,
    });
    renderTarget.cleanup();
    renderTarget = null;
    const imageBlob = await canvasToBlob(canvas);
    triggerImageBlobDownload(imageBlob, fileName);
    feedback.update('图片已生成', '已下载为 JPG 长图。');
    feedback.close(900);
  } catch (error) {
    console.error('[policy-ocr-app] report image export failed', error);
    feedback.update('图片生成失败', '请刷新报告页后重试。');
    feedback.close(1800);
  } finally {
    renderTarget?.cleanup();
    document.body.classList.remove('pdf-page-style-export-mode');
    document.title = previousTitle;
  }
}

function buildDraftReportTitle(formData: PolicyFormData) {
  return `${formData.insured || '客户'}-${formData.name || '保单'}-解析报告`;
}

function buildPolicyReportTitle(policy: Policy) {
  return `${policy.insured || '客户'}-${policy.name || '保单'}-解析报告`;
}

type CustomerTab = 'entry' | 'policies';

type OfficialDomainForm = {
  id: string;
  company: string;
  aliasesText: string;
  siteDomainsText: string;
  officialDomainsText: string;
};

type KnowledgeCrawlForm = {
  company: string;
  name: string;
};

const emptyOfficialDomainForm: OfficialDomainForm = {
  id: '',
  company: '',
  aliasesText: '',
  siteDomainsText: '',
  officialDomainsText: '',
};

const emptyKnowledgeCrawlForm: KnowledgeCrawlForm = {
  company: '',
  name: '',
};

function listToText(values: string[] = []) {
  return values.filter(Boolean).join('\n');
}

function textToList(value: string) {
  return String(value || '')
    .split(/[\n,，;；\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function profileToOfficialDomainForm(profile: AdminOfficialDomainProfile): OfficialDomainForm {
  return {
    id: profile.id,
    company: profile.company || '',
    aliasesText: listToText(profile.aliases || []),
    siteDomainsText: listToText(profile.siteDomains || []),
    officialDomainsText: listToText(profile.officialDomains || []),
  };
}

function formToOfficialDomainPayload(form: OfficialDomainForm) {
  return {
    company: form.company,
    aliases: textToList(form.aliasesText),
    siteDomains: textToList(form.siteDomainsText),
    officialDomains: textToList(form.officialDomainsText),
  };
}

type PolicyGroup = {
  insured: string;
  policies: Policy[];
  totalCoverage: number;
  annualPremium: number;
};

type FamilyCoverageCell = {
  amount: number;
  displayText: string;
  calculationText: string;
  labels: string[];
  missingCashflowDetail: boolean;
};

type FamilyCoverageOverviewRow = {
  coverageType: string;
  liability: string;
  cells: Record<string, FamilyCoverageCell>;
};

type FamilyCoverageOverviewData = {
  members: string[];
  rows: FamilyCoverageOverviewRow[];
  notes: string[];
};

function groupPoliciesByInsured(policies: Policy[]): PolicyGroup[] {
  const groups = new Map<string, PolicyGroup>();
  for (const policy of policies) {
    const insured = String(policy.insured || '').trim() || '未识别被保人';
    const existing = groups.get(insured) || {
      insured,
      policies: [],
      totalCoverage: 0,
      annualPremium: 0,
    };
    existing.policies.push(policy);
    existing.totalCoverage += Number(policy.amount || 0);
    existing.annualPremium += Number(policy.firstPremium || 0);
    groups.set(insured, existing);
  }
  return [...groups.values()].sort((left, right) => right.policies.length - left.policies.length || left.insured.localeCompare(right.insured));
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

function formatNumberText(value: number) {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
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

function buildFamilyCoverageOverview(policies: Policy[]): FamilyCoverageOverviewData {
  const members = Array.from(new Set(policies.map(resolvePolicyMemberKey))).filter(Boolean);
  const rowMap = new Map<string, FamilyCoverageOverviewRow>();
  const notes = new Set<string>();

  for (const policy of policies) {
    const member = resolvePolicyMemberKey(policy);
    const indicators = selectedCoverageIndicators(policy.coverageIndicators);

    for (const indicator of indicators) {
      const coverageType = String(indicator.coverageType || '').trim() || '人寿保障';
      if (coverageType === '现金流' && (!isCashflowPayoutIndicator(indicator) || isNonPayoutCashflowIndicator(indicator))) continue;
      const liability = coverageType === '现金流'
        ? resolveCashflowLiabilityFromText(indicatorOverviewText(indicator))
        : String(indicator.liability || '').trim() || '身故/全残';
      const key = `${coverageType}\u001f${liability}`;
      const row = rowMap.get(key) || {
        coverageType,
        liability,
        cells: {},
      };
      const current = row.cells[member] || { amount: 0, displayText: '', calculationText: '', labels: [], missingCashflowDetail: false };
      const amount = resolveIndicatorAmount(indicator, policy);
      const displayText = formatCoverageIndicator(indicator, policy);
      const calculationText = formatIndicatorCalculation(indicator, policy);
      current.amount += amount;
      current.displayText = current.displayText
        ? Array.from(new Set([...current.displayText.split('；'), displayText])).filter(Boolean).join('；')
        : displayText;
      current.calculationText = current.calculationText
        ? Array.from(new Set([...current.calculationText.split('；'), calculationText])).filter(Boolean).join('；')
        : calculationText;
      current.labels.push(policy.name || indicator.productName || '保单');
      if (coverageType === '现金流' && amount <= 0 && /账户价值|分红|红利/u.test(indicatorOverviewText(indicator))) {
        current.missingCashflowDetail = true;
        notes.add(`${member}的${policy.name || indicator.productName || '保单'}含账户价值/分红类领取，缺少账户价值或红利明细，暂不生成确定现金流曲线。`);
      }
      row.cells[member] = current;
      rowMap.set(key, row);
    }

    if (indicators.length) {
      if (!policy.insuredBirthday) {
        notes.add(`${member}缺少被保险人生日，现金流年龄轴需补充后生成。`);
      }
      continue;
    }

    const responsibilities = Array.isArray(policy.responsibilities) && policy.responsibilities.length
      ? policy.responsibilities
      : [{
          coverageType: policy.name || '保单责任',
          scenario: policy.coveragePeriod || '',
          payout: Number(policy.amount || 0) > 0 ? `基本保险金额${Number(policy.amount).toLocaleString('zh-CN')}元` : '',
          note: '',
        }];

    if (!policy.insuredBirthday) {
      notes.add(`${member}缺少被保险人生日，现金流年龄轴需补充后生成。`);
    }

    for (const responsibility of responsibilities) {
      const classified = classifyCoverageLiability(responsibility, policy);
      const key = `${classified.coverageType}\u001f${classified.liability}`;
      const row = rowMap.get(key) || {
        coverageType: classified.coverageType,
        liability: classified.liability,
        cells: {},
      };
      const current = row.cells[member] || { amount: 0, displayText: '', calculationText: '', labels: [], missingCashflowDetail: false };
      const amount = resolveCoverageAmount(responsibility, policy);
      current.amount += amount;
      current.labels.push(policy.name || responsibility.coverageType || '保单');
      const combinedText = `${responsibility.coverageType || ''} ${responsibility.scenario || ''} ${responsibility.payout || ''}`;
      if (classified.coverageType === '现金流' && amount <= 0 && !/基本保险金额|基本保额|元|万|实际交纳|已交保险费|所交保险费/u.test(combinedText)) {
        current.missingCashflowDetail = true;
        notes.add(`${member}的${policy.name || '保单'}缺少年金/生存金领取金额明细，暂不生成确定现金流曲线。`);
      }
      row.cells[member] = current;
      rowMap.set(key, row);
    }
  }

  const order = ['人寿保障', '疾病保障', '医疗保障', '意外保障', '现金流'];
  return {
    members,
    rows: [...rowMap.values()].sort(
      (left, right) =>
        order.indexOf(left.coverageType) - order.indexOf(right.coverageType) ||
        left.liability.localeCompare(right.liability, 'zh-CN'),
    ),
    notes: [...notes],
  };
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function dataUrlByteSize(dataUrl: string) {
  const payload = String(dataUrl || '').split(',')[1] || '';
  return Math.round((payload.length * 3) / 4);
}

function createCodedError(message: string, code: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function getErrorCode(error: unknown) {
  if (error instanceof ApiError) return error.code || 'API_ERROR';
  return String((error as { code?: string } | null)?.code || 'CLIENT_ERROR');
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function isWeChatBrowser() {
  return /MicroMessenger/i.test(navigator.userAgent || '');
}

function isWeChatMiniProgramWebView() {
  return window.__wxjs_environment === 'miniprogram' || /miniProgram/i.test(navigator.userAgent || '');
}

function getWechatUploadLabel() {
  if (isWeChatMiniProgramWebView()) return '系统相册/拍照上传';
  if (isWeChatBrowser()) return '系统拍照/相册上传';
  return '点击拍照上传';
}

type ClientPerformanceTimings = {
  fileReadMs?: number;
  imageDecodeMs?: number;
  imageCompressMs?: number;
};

type PolicyUploadSource = 'file-input';

function clientPerfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function clientElapsedMs(startedAt: number) {
  return Math.max(0, Math.round(clientPerfNow() - startedAt));
}

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

async function compressImageForOcr(file: File, timings: ClientPerformanceTimings = {}): Promise<UploadItem | null> {
  if (!file.type.startsWith('image/')) return null;
  const readStartedAt = clientPerfNow();
  const originalDataUrl = await readFileAsDataUrl(file);
  timings.fileReadMs = clientElapsedMs(readStartedAt);
  const decodeStartedAt = clientPerfNow();
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => reject(new Error('图片解析失败'));
    node.src = originalDataUrl;
  });
  timings.imageDecodeMs = clientElapsedMs(decodeStartedAt);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const maxDimension = Math.max(width, height);
  if (!width || !height || (maxDimension <= MAX_OCR_IMAGE_DIMENSION && file.size <= OCR_IMAGE_DIRECT_UPLOAD_BYTES)) {
    return {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: originalDataUrl,
    };
  }
  const scale = Math.min(1, MAX_OCR_IMAGE_DIMENSION / maxDimension);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    return {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: originalDataUrl,
    };
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  const compressStartedAt = clientPerfNow();
  const dataUrl = canvas.toDataURL('image/jpeg', OCR_IMAGE_JPEG_QUALITY);
  timings.imageCompressMs = clientElapsedMs(compressStartedAt);
  return {
    name: file.name.replace(/\.[^.]+$/, '') || file.name,
    type: 'image/jpeg',
    size: dataUrlByteSize(dataUrl),
    dataUrl,
  };
}

async function fileToUploadItem(file: File, timings: ClientPerformanceTimings = {}): Promise<UploadItem> {
  const compressed = await compressImageForOcr(file, timings).catch(() => null);
  if (compressed) return compressed;
  const readStartedAt = clientPerfNow();
  const dataUrl = await readFileAsDataUrl(file);
  timings.fileReadMs = timings.fileReadMs || clientElapsedMs(readStartedAt);
  return {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    dataUrl,
  };
}

export default function App() {
  if (window.location.pathname.startsWith('/admin')) {
    return <AdminApp />;
  }
  return <CustomerApp />;
}

function CustomerApp() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const cashValueInputRef = useRef<HTMLInputElement | null>(null);

  const canSubmit = Boolean(uploadItem || ocrText.trim() || formData.company.trim() || formData.name.trim());
  const totalCoverage = useMemo(() => policies.reduce((sum, policy) => sum + Number(policy.amount || 0), 0), [policies]);
  const annualPremium = useMemo(() => policies.reduce((sum, policy) => sum + Number(policy.firstPremium || 0), 0), [policies]);
  const policyGroups = useMemo(() => groupPoliciesByInsured(policies), [policies]);
  const familyCoverageOverview = useMemo(() => buildFamilyCoverageOverview(policies), [policies]);
  const familyReport = useMemo(() => buildFamilyReport(policies, familyPlanningProfile), [policies, familyPlanningProfile]);
  const isLoggedIn = Boolean(token);

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
    refreshPolicies().catch((error) => {
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
    if (!assistantOpen || assistantCompanySuggestions.length) return;
    let cancelled = false;
    setAssistantCompanySuggestionLoading(true);
    listPolicyResponsibilityCompanySuggestions({ limit: 50 })
      .then((payload) => {
        if (!cancelled) setAssistantCompanySuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
      })
      .catch(() => {
        if (!cancelled) setAssistantCompanySuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setAssistantCompanySuggestionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assistantOpen, assistantCompanySuggestions.length]);

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
    if (activeTab !== 'entry' || formCompanySuggestions.length) return;
    let cancelled = false;
    setFormCompanySuggestionLoading(true);
    listPolicyResponsibilityCompanySuggestions({ limit: 50 })
      .then((payload) => {
        if (!cancelled) setFormCompanySuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
      })
      .catch(() => {
        if (!cancelled) setFormCompanySuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setFormCompanySuggestionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, formCompanySuggestions.length]);

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

  function updateForm(key: keyof PolicyFormData, value: string) {
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    if (key === 'company' || key === 'name') {
      setConfirmedProductMatchKey('');
    }
    setFormData((current) => ({ ...current, [key]: value }));
  }

  function updatePolicyPlan(index: number, key: string, value: string) {
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setFormData((current) => {
      const plans = normalizePolicyPlanList(current.plans, current.company, { keepEmpty: true });
      const existing = plans[index];
      if (!existing) return current;
      const nextPlans = plans.map((plan, planIndex) => {
        if (planIndex !== index) return plan;
        return {
          ...plan,
          [key]: key === 'amount' || key === 'premium' ? sanitizeAmount(value) : value,
          ...(key === 'name' ? { matchedProductName: '' } : {}),
        };
      });
      const primary = nextPlans.find((plan) => plan.role === 'main') || nextPlans[0] || null;
      return {
        ...current,
        plans: nextPlans,
        name: primary?.matchedProductName || primary?.name || current.name,
        amount: primary?.amount ? String(primary.amount) : current.amount,
        coveragePeriod: primary?.coveragePeriod || current.coveragePeriod,
        paymentPeriod: primary?.paymentPeriod || current.paymentPeriod,
        firstPremium: nextPlans.reduce((sum, plan) => sum + Number(plan.premium || 0), 0)
          ? String(nextPlans.reduce((sum, plan) => sum + Number(plan.premium || 0), 0))
          : current.firstPremium,
      };
    });
  }

  function addPolicyPlan() {
    setAnalysisDraft(null);
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
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setFormData((current) => {
      const plans = normalizePolicyPlanList(current.plans, current.company, { keepEmpty: true }).filter((_plan, planIndex) => planIndex !== index);
      const primary = plans.find((plan) => plan.role === 'main') || plans[0] || null;
      return {
        ...current,
        plans,
        ...(primary
          ? {
              name: primary.matchedProductName || primary.name || current.name,
              amount: primary.amount ? String(primary.amount) : current.amount,
              coveragePeriod: primary.coveragePeriod || current.coveragePeriod,
              paymentPeriod: primary.paymentPeriod || current.paymentPeriod,
            }
          : {}),
      };
    });
  }

  function selectFormProductMatch(match: PolicyKnowledgeMatch) {
    const company = match.company.trim();
    const name = match.productName.trim();
    if (!company || !name) return;
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey(productLookupKey(company, name));
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    setFormData((current) => ({ ...current, company, name }));
    setScanResult((current) =>
      current
        ? {
            ...current,
            data: {
              ...current.data,
              company,
              name,
            },
          }
        : current,
    );
    setMessage(`已选择本地产品：${name}`);
  }

  function selectFormProductSuggestion(suggestion: PolicyProductSuggestion) {
    const company = suggestion.company.trim();
    const name = suggestion.productName.trim();
    if (!company || !name) return;
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey(productLookupKey(company, name));
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    setFormData((current) => ({ ...current, company, name }));
    setScanResult((current) =>
      current
        ? {
            ...current,
            data: {
              ...current.data,
              company,
              name,
            },
          }
        : current,
    );
    setMessage(`已选择保险产品：${name}`);
  }

  function handleOcrTextChange(value: string) {
    setOcrText(value);
    setScanResult((current) => (current ? { ...current, ocrText: value } : current));
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

  async function recognizePreparedUpload(input: {
    item: UploadItem;
    originalBytes: number;
    flowStartedAt: number;
    source: PolicyUploadSource;
  }) {
    const { item, originalBytes, flowStartedAt, source } = input;
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
    reportClientPerformance('client.recognize.complete', {
      durationMs: clientElapsedMs(flowStartedAt),
      source,
      originalBytes,
      uploadBytes: item.size,
      hasUpload: true,
      outputOcrChars: String(payload.scan?.ocrText || '').length,
    });
    setMessage('OCR 已完成，可生成保险责任或直接保存');
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
    if (file.size > MAX_POLICY_UPLOAD_BYTES) {
      setUploadItem(null);
      setMessage('图片太大，请压缩到 12MB 以内后重新上传');
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
      setAnalysisDraft(payload.analysis);
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
      const matched = await matchPolicyResponsibilities({ company, name });
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
    if (!canSubmit || loading) return;
    if (blockSecondGuestPolicyIfNeeded()) return;
    const hasGeneratedAnalysis = hasAnalysisResult(analysisDraft);
    const isNewPolicy = !policies.some((p) => Number(p.id) === Number((formData as any).id));
    const startedAt = clientPerfNow();
    setLoading(true);
    setMessage(hasGeneratedAnalysis ? '正在保存保单信息' : '正在保存保单信息，报告将在后台生成');
    try {
      const payload = await scanPolicy({
        token,
        guestId,
        ocrText,
        uploadItem: scanResult ? null : uploadItem,
        manualData: formData,
        scan: scanResult,
        analysis: hasGeneratedAnalysis ? analysisDraft : null,
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
      setFormData(policyToForm(payload.policy));
      setScanResult(null);
      setAnalysisDraft(null);
      setShowAnalysisReport(false);
      setConfirmedProductMatchKey('');
      setFormProductMatches([]);
      setFormProductMatchMessage('');
      setPolicies((current) => {
        const withoutDuplicate = current.filter((policy) => policy.id !== payload.policy.id);
        return [payload.policy, ...withoutDuplicate];
      });
      setSelectedPolicy(payload.policy);

      // Trigger cash value dialog for newly saved policies without cash values
      const hasExistingCashValues = (payload.policy.cashValues?.length ?? 0) > 0;
      if (!hasExistingCashValues && isNewPolicy) {
        setCashValuePolicyId(payload.policy.id);
        setCashValueDialogOpen(true);
      } else {
        setActiveTab('policies');
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
      });
      if (handleRegistrationRequiredError(error)) return;
      setMessage(error instanceof Error ? error.message : '识别失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  async function handleCashValueFileChange(e: React.ChangeEvent<HTMLInputElement>) {
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
      if (selectedPolicy?.id === savedPolicyId) {
        setSelectedPolicy({ ...selectedPolicy, cashValues: savedRows });
      }

      setCashValueDialogOpen(false);
      setCashValueScanResult(null);
      setCashValueEditRows([]);
      setCashValuePolicyId(null);
      setCashValueMessage('');
      setCashflowMember(null);
      setActiveTab('policies');
      setMessage(`现金价值表已保存（${savedRows.length} 行）`);
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
    setCashValueDialogOpen(false);
    setCashValueScanResult(null);
    setCashValueEditRows([]);
    setCashValuePolicyId(null);
    setCashValueMessage('');
    setActiveTab('policies');
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

  function startEntryForm() {
    setFormData(emptyForm);
    setOcrText('');
    setUploadItem(null);
    setScanResult(null);
    setAnalysisDraft(null);
    setShowAnalysisReport(false);
    setConfirmedProductMatchKey('');
    setFormProductMatches([]);
    setFormProductMatchMessage('');
    setActiveTab('entry');
    setMessage('可以继续录入保单');
  }

  // Cash Value Upload Dialog
  const cashValueDialog = cashValueDialogOpen ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        {!cashValueScanResult ? (
          /* Step 1: Upload prompt */
          <div className="text-center">
            <h3 className="mb-2 text-lg font-bold text-slate-800">
              录入保单现金价值
            </h3>
            <p className="mb-5 text-sm text-slate-500">
              拍照上传保单的现金价值页面，系统将自动识别并录入
            </p>
            {cashValueMessage && (
              <p className="mb-3 text-sm text-red-500">{cashValueMessage}</p>
            )}
            {cashValueLoading && (
              <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-left" aria-live="polite">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-black text-blue-700">现金价值表识别中</span>
                  <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-blue-100"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuetext="正在识别现金价值表"
                >
                  <div className="h-full w-1/2 rounded-full bg-blue-500 animate-[cash-value-progress_1.35s_ease-in-out_infinite]" />
                </div>
              </div>
            )}
            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                className="rounded-lg bg-[#0B72B9] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                disabled={cashValueLoading}
                onClick={() => cashValueInputRef.current?.click()}
              >
                拍照上传
              </button>
              <button
                type="button"
                className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                disabled={cashValueLoading}
                onClick={startManualCashValueEntry}
              >
                手动录入
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600"
                onClick={closeCashValueDialog}
              >
                暂时跳过
              </button>
            </div>
            <input
              ref={cashValueInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => { void handleCashValueFileChange(e); }}
            />
          </div>
        ) : (
          /* Step 2: Preview and edit results */
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-slate-800">
                {cashValueScanResult.source === 'manual' ? '录入现金价值' : '现金价值表识别结果'}
              </h3>
              <span className="text-xs text-slate-400">
                {cashValueScanResult.source === 'manual' ? '手动录入' : cashValueScanResult.source === 'macos_vision' ? '本机Vision' : cashValueScanResult.source === 'vision_llm' ? 'AI识别' : 'Paddle OCR'}
                {cashValueScanResult.confidence != null && ` · 置信度 ${Math.round(cashValueScanResult.confidence * 100)}%`}
              </span>
            </div>
            {cashValueMessage && (
              <p className="mb-2 text-sm text-red-500">{cashValueMessage}</p>
            )}
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 ring-1 ring-emerald-100"
                onClick={handleAddCashValueRow}
              >
                <Plus size={14} />
                添加年度
              </button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="px-2 py-1.5 text-left font-bold text-slate-600">保单年度</th>
                    {cashValueScanResult.tableType === 3 && (
                      <th className="px-2 py-1.5 text-left font-bold text-slate-600">年龄</th>
                    )}
                    <th className="px-2 py-1.5 text-left font-bold text-slate-600">现金价值(元)</th>
                    <th className="w-10 px-2 py-1.5 text-right font-bold text-slate-600">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {cashValueEditRows.map((row, i) => (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="px-1 py-0.5">
                        <input
                          type="text"
                          className="w-16 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                          defaultValue={row.policyYear}
                          onBlur={(e) => handleCashValueCellEdit(i, 'policyYear', e.target.value)}
                        />
                      </td>
                      {cashValueScanResult.tableType === 3 && (
                        <td className="px-1 py-0.5">
                          <input
                            type="text"
                            className="w-14 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                            defaultValue={row.age ?? ''}
                            onBlur={(e) => handleCashValueCellEdit(i, 'age', e.target.value)}
                          />
                        </td>
                      )}
                      <td className="px-1 py-0.5">
                        <input
                          type="text"
                          className="w-24 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                          defaultValue={row.cashValue.toLocaleString('zh-CN')}
                          onBlur={(e) => handleCashValueCellEdit(i, 'cashValue', e.target.value)}
                        />
                      </td>
                      <td className="px-1 py-0.5 text-right">
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-50 text-slate-400 active:bg-red-50 active:text-red-500"
                          onClick={() => handleRemoveCashValueRow(i)}
                          aria-label="删除现金价值行"
                        >
                          <X size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex gap-2 justify-center">
              <button
                type="button"
                className="rounded-lg bg-[#0B72B9] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                disabled={cashValueLoading || cashValueEditRows.length === 0}
                onClick={() => { void handleCashValueConfirm(); }}
              >
                确认保存
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 disabled:opacity-50"
                disabled={cashValueLoading}
                onClick={() => {
                  setCashValueScanResult(null);
                  setCashValueEditRows([]);
                  setCashValueMessage('');
                  cashValueInputRef.current?.click();
                }}
              >
                {cashValueScanResult.source === 'manual' ? '拍照识别' : '重新拍照'}
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-400"
                onClick={closeCashValueDialog}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>
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
      mobile={mobile}
      policyCount={policies.length}
      onClose={() => setShowAccountSheet(false)}
      onLogin={() => {
        setShowAccountSheet(false);
        openPhoneVerificationDialog('验证手机号后可查看账号名下所有保单');
      }}
      onLogout={() => void handleCustomerLogout()}
    />
  ) : null;
  const responsibilityAssistant = (
    <ResponsibilityAssistant
      analysis={assistantAnalysis}
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

  if (showFamilyReport) {
    return (
      <FamilyReportPage
        report={familyReport}
        planningProfile={familyPlanningProfile}
        onPlanningProfileChange={handleFamilyPlanningProfileChange}
        onBack={() => setShowFamilyReport(false)}
        onExport={(target, title) => void downloadReportImage(target, title, { rawTarget: true, preservePageStyle: true })}
      />
    );
  }

  if (activeTab === 'entry' && showAnalysisReport && analysisDraft) {
    return (
      <>
        <AnalysisReportPage
          analysis={analysisDraft}
          canSave={canSubmit}
          formData={formData}
          loading={loading}
          message={message}
          onBack={() => setShowAnalysisReport(false)}
          onSave={handleSubmit}
          onUpdateOptionalResponsibility={updateAnalysisOptionalResponsibility}
        />
        {responsibilityAssistant}
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
          formData={formData}
          formCompanySuggestionLoading={formCompanySuggestionLoading}
          formCompanySuggestions={formCompanySuggestions}
          formProductSuggestionLoading={formProductSuggestionLoading}
          formProductSuggestions={formProductSuggestions}
          loading={loading}
          message={message}
          ocrText={ocrText}
          productMatchLoading={formProductMatchLoading}
          productMatchMessage={formProductMatchMessage}
          productMatches={formProductMatches}
          activeTab={activeTab}
          onBack={() => setActiveTab('policies')}
          onChangeTab={setActiveTab}
          onFileChange={handleFileChange}
          onGenerateAnalysis={() => void handleGenerateAnalysis()}
          onOcrTextChange={handleOcrTextChange}
          onScanClick={handleScanClick}
          onSelectFormCompany={(company) => updateForm('company', company)}
          onSelectFormProduct={(suggestion) => selectFormProductSuggestion(suggestion)}
          onSelectProductMatch={selectFormProductMatch}
          onSubmit={handleSubmit}
          onAddPlan={addPolicyPlan}
          onRemovePlan={removePolicyPlan}
          onUpdatePlan={updatePolicyPlan}
          onUpdateForm={updateForm}
          isLoggedIn={isLoggedIn}
          mobile={mobile}
          onOpenAccount={() => setShowAccountSheet(true)}
          onOpenReport={() => setShowFamilyReport(true)}
          uploadItem={uploadItem}
          fileInputRef={fileInputRef}
        />
        {responsibilityAssistant}
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

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white/80 px-4 py-4 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <Shield className="text-blue-500" size={24} />
          <div>
            <h1 className="text-xl font-bold tracking-tight">保障管理</h1>
            <p className="text-[11px] font-medium text-slate-400">{maskMobile(mobile)}</p>
          </div>
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
                <h2 className="mt-2 text-2xl font-black leading-tight">保单分析</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-white/85">{message}</p>
              </div>
              <div className="rounded-2xl bg-white/15 p-3">
                <Sparkles size={28} />
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white/15 px-4 py-3">
                <p className="text-xs text-white/70">已录入</p>
                <p className="mt-1 text-xl font-black">{policies.length} 张</p>
              </div>
              <div className="rounded-2xl bg-white/15 px-4 py-3">
                <p className="text-xs text-white/70">总保额</p>
                <p className="mt-1 text-xl font-black">{formatCoverageAmount(totalCoverage)}</p>
              </div>
            </div>
          </div>
        </div>

        <FamilyCoverageOverview
          overview={familyCoverageOverview}
          policies={policies}
          onViewCashflow={(member) => setCashflowMember(member)}
          onViewReport={() => setShowFamilyReport(true)}
        />

        {policies.length ? (
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
          {!policies.length ? (
            <div className="rounded-[24px] border border-dashed border-[#D6E4F5] bg-white px-5 py-10 text-center shadow-[0_18px_34px_-30px_rgba(15,23,42,0.12)]">
              <p className="text-base font-semibold text-[#0F172A]">还没有录入保单</p>
              <p className="mt-2 text-sm leading-6 text-[#6C87A5]">录入后会在这里统一查看你的保单责任和保障明细。</p>
              <button
                className="mt-5 rounded-2xl bg-blue-500 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/20"
                type="button"
                onClick={startEntryForm}
              >
                去录入第一张保单
              </button>
            </div>
          ) : null}
          {policyGroups.map((group) => (
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

      <CustomerBottomTabs activeTab={activeTab} onChange={setActiveTab} onOpenReport={() => setShowFamilyReport(true)} />
      {!selectedPolicy ? responsibilityAssistant : null}

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

function CashflowAnnualTable({ entries, effectiveYear, birthYear, endYear, policyId, productName, cashValues }: {
  entries: CashflowEntry[];
  effectiveYear: number;
  birthYear: number;
  endYear: number;
  policyId: number;
  productName: string;
  cashValues?: CashValueRow[];
}) {
  const allEntries = fillCashflowYears(entries, effectiveYear, birthYear, endYear, { policyId, productName });

  // Overlay OCR cash values onto entries
  const cashValueMap = new Map<number, number>();
  if (cashValues) {
    for (const cv of cashValues) {
      const calendarYear = effectiveYear + cv.policyYear;
      cashValueMap.set(calendarYear, cv.cashValue);
    }
  }
  const enrichedEntries = allEntries.map((entry) => {
    const ocrCashValue = cashValueMap.get(entry.year);
    if (ocrCashValue != null) {
      return { ...entry, cashValue: ocrCashValue };
    }
    return entry;
  });

  if (!enrichedEntries.length) return null;
  const columnSize = 14;
  const columns: CashflowEntry[][] = [];
  for (let i = 0; i < enrichedEntries.length; i += columnSize) {
    columns.push(enrichedEntries.slice(i, i + columnSize));
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-black text-slate-800">个人现金流明细</h4>
        <span className="text-xs text-slate-400">(单位:元)</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex gap-3 min-w-max">
          {columns.map((col, colIndex) => (
            <table key={colIndex} className="border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className="rounded-tl-lg bg-[#0B72B9] px-2 py-1 text-white font-bold">年份</th>
                  <th className="bg-[#0B72B9] px-2 py-1 text-white font-bold">领取金额</th>
                  <th className="bg-[#0B72B9] px-2 py-1 text-white font-bold">累计领取</th>
                  <th className="rounded-tr-lg bg-[#0B72B9] px-2 py-1 text-white font-bold">现金价值</th>
                </tr>
              </thead>
              <tbody>
                {col.map((entry) => {
                  const hasAmount = entry.amount > 0;
                  const isLastAndMaturity = hasAmount && /满期/.test(entry.liability);
                  return (
                    <tr key={entry.year} className={isLastAndMaturity ? 'bg-orange-50 font-black' : ''}>
                      <td className="px-2 py-1 font-bold text-slate-600 ring-1 ring-slate-100">
                        {entry.year}/{entry.age}
                      </td>
                      <td className="px-2 py-1 text-right ring-1 ring-slate-100">
                        {hasAmount ? (
                          <span className={`inline-block rounded px-1 text-[10px] font-bold ${/满期/.test(entry.liability) ? 'text-orange-600 bg-orange-50' : /养老/.test(entry.liability) ? 'text-emerald-600 bg-emerald-50' : 'text-blue-600 bg-blue-50'}`}>
                            {entry.amount.toLocaleString('zh-CN')}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-semibold text-slate-500 ring-1 ring-slate-100">
                        {hasAmount ? entry.cumulative.toLocaleString('zh-CN') : '—'}
                      </td>
                      <td className="px-2 py-1 text-right text-slate-400 ring-1 ring-slate-100">
                        {entry.cashValue != null ? entry.cashValue.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScenarioDetailTable({ entries }: { entries: ScenarioEntry[] }) {
  if (!entries.length) return null;

  const depthColor = (amount: number) => {
    if (amount >= 2000000) return 'text-blue-800 font-black';
    if (amount >= 1000000) return 'text-blue-700 font-bold';
    if (amount >= 500000) return 'text-blue-600 font-semibold';
    return 'text-slate-700';
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-black text-slate-800">保障责任明细</h4>
        <span className="text-xs text-slate-400">(单位:元)</span>
      </div>
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="rounded-tl-lg bg-[#0B72B9] px-3 py-2 text-left font-bold text-white">场景</th>
            <th className="bg-[#0B72B9] px-3 py-2 text-left font-bold text-white">计算公式</th>
            <th className="rounded-tr-lg bg-[#0B72B9] px-3 py-2 text-right font-bold text-white">金额</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={i} className={entry.condition ? 'bg-slate-50' : ''}>
              <td className={`px-3 py-2 ring-1 ring-slate-100 ${entry.condition ? 'pl-6' : ''}`}>
                <span className="font-bold text-slate-800">{entry.scenario}</span>
                {entry.condition ? (
                  <span className="ml-1 text-[10px] text-slate-400">({entry.condition})</span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-slate-500 ring-1 ring-slate-100">{entry.formula}</td>
              <td className={`px-3 py-2 text-right ring-1 ring-slate-100 ${depthColor(entry.amount)}`}>
                {entry.amount.toLocaleString('zh-CN')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberAnnualSummaryTable({ summary }: { summary: MemberAnnualSummary }) {
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const columnSize = 12;
  const columns: MemberYearEntry[][] = [];
  for (let i = 0; i < summary.entries.length; i += columnSize) {
    columns.push(summary.entries.slice(i, i + columnSize));
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-3 min-w-max">
        {columns.map((col, colIndex) => (
          <table key={colIndex} className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="rounded-tl-lg bg-blue-600 px-2 py-1 text-white font-bold">年份/年龄</th>
                <th className="bg-blue-600 px-2 py-1 text-white font-bold">领取</th>
                <th className="rounded-tr-lg bg-blue-600 px-2 py-1 text-white font-bold">累计</th>
              </tr>
            </thead>
            <tbody>
              {col.map((entry) => (
                <tr
                  key={entry.year}
                  className="cursor-pointer hover:bg-blue-50"
                  onClick={() => setExpandedYear(expandedYear === entry.year ? null : entry.year)}
                >
                  <td className="px-2 py-1 font-bold text-slate-600 ring-1 ring-slate-100">
                    {entry.year}/{entry.age}
                  </td>
                  <td className="px-2 py-1 text-right font-black text-slate-800 ring-1 ring-slate-100">
                    {entry.totalAmount.toLocaleString('zh-CN')}
                  </td>
                  <td className="px-2 py-1 text-right font-semibold text-slate-500 ring-1 ring-slate-100">
                    {entry.cumulative.toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
      {expandedYear !== null ? (
        <div className="mt-1">
          {summary.entries.filter((e) => e.year === expandedYear).map((entry) => (
            <div key={entry.year} className="rounded-lg bg-blue-50 px-3 py-2 ring-1 ring-blue-100">
              {entry.details.map((d, i) => (
                <p key={i} className="text-[11px] text-blue-700">
                  {d.productName} - {d.liability}: {d.amount.toLocaleString('zh-CN')}元
                </p>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CashflowDetailPage({
  member, policies, onBack, cashValueDialog, onUploadCashValue,
}: {
  member: string;
  policies: Policy[];
  onBack: () => void;
  cashValueDialog?: React.ReactNode;
  onUploadCashValue?: (policyId: number) => void;
}) {
  const memberPolicies = policies.filter((p) => (p.insured || '').trim() === member);
  const plans: PolicyCashflowPlan[] = memberPolicies.map(p => ({
    policyId: p.id,
    productName: p.name || '',
    company: p.company || '',
    insured: p.insured || '',
    insuredBirthday: p.insuredBirthday || '',
    effectiveDate: p.date || '',
    annualEntries: p.cashflowEntries || [],
    scenarioEntries: p.scenarioEntries || [],
    totalDeterministicCashflow: p.totalCashflow ?? 0,
    expired: resolvePolicyValidityStatus(p.coveragePeriod, {
      effectiveDate: p.date,
      insuredBirthday: p.insuredBirthday,
    }).tone === 'expired',
  }));
  const summaries = buildMemberAnnualSummaries(plans);
  const summary = summaries[0];
  const notes: string[] = [];

  for (const plan of plans) {
    if (!plan.insuredBirthday) notes.push(`${plan.productName}缺少被保险人生日，年度现金流无法生成。`);
    if (!plan.effectiveDate) notes.push(`${plan.productName}缺少生效日，年度现金流无法生成。`);
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-100 bg-white/80 px-4 py-4 backdrop-blur-md">
        <button type="button" onClick={onBack} className="rounded-full p-1 hover:bg-slate-100">
          <ChevronLeft size={20} className="text-slate-600" />
        </button>
        <div>
          <h1 className="text-lg font-black text-slate-900">{member} · 现金流明细</h1>
          <p className="text-[11px] font-medium text-slate-400">{plans.length} 张保单</p>
        </div>
      </header>

      <main className="space-y-4 p-4">
        {notes.length ? (
          <div className="space-y-1 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
            {notes.map((n) => <p key={n}>* {n}</p>)}
          </div>
        ) : null}

        {plans.map((plan) => (
          <section key={plan.policyId} className="rounded-[20px] border border-[#D9E6F4] bg-white p-4 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.12)]">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-black text-slate-900">{plan.productName}</h3>
                <p className="mt-1 text-xs text-slate-400">{plan.company}</p>
              </div>
              {plan.expired ? (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-400">已过期</span>
              ) : null}
            </div>
            <div className="mb-3 flex flex-wrap gap-2 text-xs text-slate-500">
              {plan.effectiveDate ? <span>生效 {plan.effectiveDate}</span> : null}
              {plan.insuredBirthday ? <span>生日 {plan.insuredBirthday}</span> : null}
            </div>

            {plan.annualEntries.length ? (() => {
              const effectiveYear = plan.effectiveDate ? new Date(plan.effectiveDate).getFullYear() : 0;
              const birthYear = plan.insuredBirthday ? new Date(plan.insuredBirthday).getFullYear() : 0;
              const lastEntryYear = plan.annualEntries.length ? plan.annualEntries[plan.annualEntries.length - 1].year : 0;
              const endYear = Math.max(lastEntryYear, effectiveYear + 50, birthYear + 85);
              return (
                <div className="mb-3">
                  <CashflowAnnualTable
                    entries={plan.annualEntries}
                    effectiveYear={effectiveYear}
                    birthYear={birthYear}
                    endYear={endYear}
                    policyId={plan.policyId}
                    productName={plan.productName}
                    cashValues={memberPolicies.find(p => p.id === plan.policyId)?.cashValues}
                  />
                  <p className="mt-2 text-right text-sm font-black text-slate-800">
                    确定现金流合计: {plan.totalDeterministicCashflow.toLocaleString('zh-CN')}元
                  </p>
                  {onUploadCashValue ? (
                    <button
                      className="mt-2 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      onClick={() => onUploadCashValue(plan.policyId)}
                    >
                      上传现金价值表
                    </button>
                  ) : null}
                </div>
              );
            })() : null}

            {plan.scenarioEntries.length ? (
              <ScenarioDetailTable entries={plan.scenarioEntries} />
            ) : null}

            {!plan.annualEntries.length && !plan.scenarioEntries.length ? (
              <p className="py-6 text-center text-sm text-slate-400">暂无现金流或保障责任数据</p>
            ) : null}
          </section>
        ))}

        {summary && summary.entries.length ? (
          <section className="rounded-[20px] border-2 border-blue-200 bg-white p-4 shadow-[0_12px_24px_-20px_rgba(37,99,235,0.16)]">
            <h3 className="mb-3 text-base font-black text-blue-700">年度现金流汇总</h3>
            <MemberAnnualSummaryTable summary={summary} />
            <p className="mt-2 text-right text-sm font-black text-blue-800">
              合计: {summary.totalCashflow.toLocaleString('zh-CN')}元
            </p>
          </section>
        ) : null}
      </main>
      {cashValueDialog}
    </div>
  );
}

function FamilyCoverageOverview({
  overview,
  policies,
  onViewCashflow,
  onViewReport,
}: {
  overview: FamilyCoverageOverviewData;
  policies: Policy[];
  onViewCashflow: (member: string) => void;
  onViewReport: () => void;
}) {
  if (!policies.length) return null;
  const displayedRows = overview.rows.slice(0, 10);
  const memberBirthdays = buildMemberBirthdayMap(policies);

  return (
    <section className="p-4 pb-0">
      <div className="rounded-[24px] border border-[#D9E6F4] bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase text-[#7890AA]">Family Report</p>
            <h2 className="mt-1 text-lg font-black text-[#0F172A]">家庭保障总览</h2>
          </div>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-blue-50 px-3 py-2 text-xs font-black text-blue-600 ring-1 ring-blue-100 hover:bg-blue-100 active:bg-blue-100"
            onClick={onViewReport}
            aria-label="查看家庭保障分析报告"
          >
            <FileText size={14} />
            <span>查看报告</span>
          </button>
        </div>

        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          {overview.members.map((member) => {
            const memberPoliciesForPlan = policies.filter((p) => (p.insured || '').trim() === member);
            const memberPlans: PolicyCashflowPlan[] = memberPoliciesForPlan.map(p => ({
              policyId: p.id,
              productName: p.name || '',
              company: p.company || '',
              insured: p.insured || '',
              insuredBirthday: p.insuredBirthday || '',
              effectiveDate: p.date || '',
              annualEntries: p.cashflowEntries || [],
              scenarioEntries: p.scenarioEntries || [],
              totalDeterministicCashflow: p.totalCashflow ?? 0,
              expired: resolvePolicyValidityStatus(p.coveragePeriod, {
                effectiveDate: p.date,
                insuredBirthday: p.insuredBirthday,
              }).tone === 'expired',
            }));
            const hasCashflow = memberPlans.some((p) => p.annualEntries.length > 0 || p.scenarioEntries.length > 0);
            return (
              <div key={member} className="rounded-2xl bg-[#F8FBFF] px-3 py-2 ring-1 ring-[#E1EAF5]">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-black text-slate-900">{member}</p>
                  {hasCashflow ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-600 hover:bg-blue-100"
                      onClick={() => onViewCashflow(member)}
                    >
                      现金流 →
                    </button>
                  ) : null}
                </div>
                <p className="mt-1 text-xs font-bold text-[#7890AA]">
                  生日 {memberBirthdays.get(member) || '待识别'}
                </p>
              </div>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-[1] rounded-tl-2xl bg-[#0B72B9] px-3 py-2 font-black text-white">保障类型</th>
                <th className="bg-[#0B72B9] px-3 py-2 font-black text-white">责任类别</th>
                {overview.members.map((member, index) => (
                  <th key={member} className={`bg-[#0B72B9] px-3 py-2 font-black text-white ${index === overview.members.length - 1 ? 'rounded-tr-2xl' : ''}`}>
                    {member}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row) => (
                <tr key={`${row.coverageType}-${row.liability}`}>
                  <td className="sticky left-0 bg-white px-3 py-3 font-black text-[#176B94] ring-1 ring-[#E1EAF5]">{row.coverageType}</td>
                  <td className="bg-white px-3 py-3 font-bold text-slate-700 ring-1 ring-[#E1EAF5]">{row.liability}</td>
                  {overview.members.map((member) => {
                    const cell = row.cells[member];
                    return (
                      <td key={member} className="min-w-[120px] bg-white px-3 py-3 font-semibold text-slate-700 ring-1 ring-[#E1EAF5]">
                        {cell ? (
                          <span className="block">
                            <span className="block text-sm font-black text-slate-800">
                              {cell.displayText || (cell.amount > 0 ? `${cell.amount.toLocaleString('zh-CN')}元` : cell.missingCashflowDetail ? '待领取明细' : '按条款公式')}
                            </span>
                            {cell.calculationText && cell.calculationText !== cell.displayText ? (
                              <span className="mt-1 block text-[11px] font-bold leading-4 text-slate-400">{cell.calculationText}</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {overview.notes.length ? (
          <div className="mt-3 space-y-1 rounded-2xl bg-[#FFF7ED] px-3 py-2 text-xs font-semibold leading-5 text-[#9A3412]">
            {overview.notes.slice(0, 3).map((note) => (
              <p key={note}>* {note}</p>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AdminApp() {
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || '');
  const [password, setPassword] = useState('');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [ocrConfig, setOcrConfig] = useState<AdminOcrConfig | null>(null);
  const [officialDomainProfiles, setOfficialDomainProfiles] = useState<AdminOfficialDomainProfile[]>([]);
  const [officialDomainForm, setOfficialDomainForm] = useState<OfficialDomainForm>(emptyOfficialDomainForm);
  const [knowledgeRecords, setKnowledgeRecords] = useState<KnowledgeRecord[]>([]);
  const [knowledgeCrawlForm, setKnowledgeCrawlForm] = useState<KnowledgeCrawlForm>(emptyKnowledgeCrawlForm);
  const [query, setQuery] = useState('');
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [selectedAdminUserId, setSelectedAdminUserId] = useState<number | null>(null);
  const [message, setMessage] = useState('输入后台密码进入平台只读管理台');
  const [loading, setLoading] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [officialDomainLoading, setOfficialDomainLoading] = useState(false);
  const [officialDomainSaving, setOfficialDomainSaving] = useState(false);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeCrawling, setKnowledgeCrawling] = useState(false);
  const [retryingPolicyId, setRetryingPolicyId] = useState<number | null>(null);

  async function loadOverview(token = adminToken) {
    if (!token) return;
    setLoading(true);
    try {
      const payload = await getAdminOverview(token);
      setOverview(payload);
      setSelectedPolicy((current) => {
        if (!current) return current;
        return payload.policies.find((policy) => Number(policy.id) === Number(current.id)) || current;
      });
      setMessage('平台数据已加载');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        setAdminToken('');
      }
      setMessage(error instanceof Error ? error.message : '后台数据加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadOcrConfig(token = adminToken) {
    if (!token) return;
    setOcrLoading(true);
    try {
      const payload = await getAdminOcrConfig(token);
      setOcrConfig(payload);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        setAdminToken('');
      }
      setMessage(error instanceof Error ? error.message : 'OCR 方式读取失败');
    } finally {
      setOcrLoading(false);
    }
  }

  async function loadOfficialDomainProfiles(token = adminToken) {
    if (!token) return;
    setOfficialDomainLoading(true);
    try {
      const payload = await getAdminOfficialDomainProfiles(token);
      setOfficialDomainProfiles(payload.profiles);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        setAdminToken('');
      }
      setMessage(error instanceof Error ? error.message : '官方域名白名单读取失败');
    } finally {
      setOfficialDomainLoading(false);
    }
  }

  async function loadKnowledgeRecords(token = adminToken) {
    if (!token) return;
    setKnowledgeLoading(true);
    try {
      const payload = await getAdminKnowledgeRecords(token);
      setKnowledgeRecords(payload.records);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        setAdminToken('');
      }
      setMessage(error instanceof Error ? error.message : '本地知识库读取失败');
    } finally {
      setKnowledgeLoading(false);
    }
  }

  useEffect(() => {
    if (!adminToken) return;
    void loadOverview(adminToken);
    void loadOcrConfig(adminToken);
    void loadOfficialDomainProfiles(adminToken);
    void loadKnowledgeRecords(adminToken);
  }, [adminToken]);

  useEffect(() => {
    if (!adminToken || !overview?.policies.some(isPolicyReportGenerating)) return;
    const timer = window.setInterval(() => {
      void loadOverview(adminToken);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [adminToken, overview]);

  async function handleAdminLogin() {
    if (loading || !password.trim()) return;
    setLoading(true);
    setMessage('正在登录管理后台');
    try {
      const payload = await adminLogin(password);
      localStorage.setItem(ADMIN_TOKEN_KEY, payload.token);
      setAdminToken(payload.token);
      setPassword('');
      setMessage('登录成功');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '后台登录失败');
    } finally {
      setLoading(false);
    }
  }

  function logoutAdmin() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    setAdminToken('');
    setOverview(null);
    setOcrConfig(null);
    setOfficialDomainProfiles([]);
    setOfficialDomainForm(emptyOfficialDomainForm);
    setKnowledgeRecords([]);
    setKnowledgeCrawlForm(emptyKnowledgeCrawlForm);
    setSelectedPolicy(null);
    setSelectedAdminUserId(null);
    setMessage('已退出管理后台');
  }

  async function handleOcrModeChange(mode: string) {
    if (!adminToken || ocrLoading || !mode || mode === ocrConfig?.config.mode) return;
    setOcrLoading(true);
    setMessage('正在切换 OCR 识别方式');
    try {
      const payload = await updateAdminOcrConfig(adminToken, mode);
      setOcrConfig(payload);
      setMessage(`OCR 已切换为 ${payload.runtime.providerLabel}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'OCR 方式切换失败');
    } finally {
      setOcrLoading(false);
    }
  }

  async function retryAdminPolicyReport(policy: Policy) {
    if (!adminToken || retryingPolicyId) return;
    setRetryingPolicyId(policy.id);
    setMessage('正在重新生成保险责任报告');
    try {
      const payload = await regeneratePolicyReport({ token: adminToken, id: policy.id });
      setSelectedPolicy(payload.policy);
      setOverview((current) => {
        if (!current) return current;
        return {
          ...current,
          policies: current.policies.map((row) => (Number(row.id) === Number(payload.policy.id) ? payload.policy : row)),
        };
      });
      setMessage(payload.skipped ? '保险责任报告已存在' : '已开始重新生成报告');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重新生成报告失败');
    } finally {
      setRetryingPolicyId(null);
    }
  }

  async function saveOfficialDomainProfile() {
    if (!adminToken || officialDomainSaving || !officialDomainForm.company.trim() || !officialDomainForm.officialDomainsText.trim()) return;
    setOfficialDomainSaving(true);
    setMessage('正在保存保险公司官方域名白名单');
    try {
      const payload = officialDomainForm.id
        ? await updateAdminOfficialDomainProfile(adminToken, officialDomainForm.id, formToOfficialDomainPayload(officialDomainForm))
        : await createAdminOfficialDomainProfile(adminToken, formToOfficialDomainPayload(officialDomainForm));
      setOfficialDomainProfiles(payload.profiles);
      setOfficialDomainForm(emptyOfficialDomainForm);
      setMessage('官方域名白名单已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '官方域名白名单保存失败');
    } finally {
      setOfficialDomainSaving(false);
    }
  }

  async function removeOfficialDomainProfile(profile: AdminOfficialDomainProfile) {
    if (!adminToken || officialDomainSaving || profile.source !== 'custom') return;
    setOfficialDomainSaving(true);
    setMessage('正在删除官方域名白名单');
    try {
      const payload = await deleteAdminOfficialDomainProfile(adminToken, profile.id);
      setOfficialDomainProfiles(payload.profiles);
      if (officialDomainForm.id === profile.id) setOfficialDomainForm(emptyOfficialDomainForm);
      setMessage('官方域名白名单已删除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '官方域名白名单删除失败');
    } finally {
      setOfficialDomainSaving(false);
    }
  }

  async function crawlKnowledgeRecords() {
    if (!adminToken || knowledgeCrawling || !knowledgeCrawlForm.company.trim() || !knowledgeCrawlForm.name.trim()) return;
    setKnowledgeCrawling(true);
    setMessage('正在爬取保险公司官网资料');
    try {
      const payload = await crawlAdminKnowledge(adminToken, {
        company: knowledgeCrawlForm.company.trim(),
        name: knowledgeCrawlForm.name.trim(),
      });
      setKnowledgeRecords(payload.records);
      await loadOverview(adminToken);
      setMessage(payload.savedCount ? `已写入 ${payload.savedCount} 条官方资料` : '未找到官方资料，未写入知识库');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '官网资料爬取失败');
    } finally {
      setKnowledgeCrawling(false);
    }
  }

  async function handleMarkOptionalNotQuantifiable(gap: OptionalResponsibilityGap) {
    if (!adminToken || loading) return;
    setLoading(true);
    setMessage('正在标记可选责任不可量化');
    try {
      await markOptionalResponsibilityNotQuantifiable(adminToken, gap.id, '该责任暂不进入金额量化计算');
      await loadOverview(adminToken);
      setMessage('可选责任已标记为不可量化');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '标记失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleReextractOptionalResponsibilities() {
    if (!adminToken || loading) return;
    setLoading(true);
    setMessage('正在重新拆解可选责任');
    try {
      await reextractOptionalResponsibilities(adminToken);
      await loadOverview(adminToken);
      setMessage('可选责任拆解已刷新');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重新拆解失败');
    } finally {
      setLoading(false);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const selectedAdminUser = useMemo(
    () => (overview?.users || []).find((user) => Number(user.id) === Number(selectedAdminUserId)) || null,
    [overview, selectedAdminUserId],
  );

  useEffect(() => {
    if (!selectedAdminUserId || selectedAdminUser || !overview) return;
    setSelectedAdminUserId(null);
  }, [overview, selectedAdminUser, selectedAdminUserId]);

  function matchesAdminQuery(values: Array<unknown>) {
    if (!normalizedQuery) return true;
    return values
      .filter((value) => value !== undefined && value !== null)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery));
  }

  const filteredPolicies = useMemo(() => {
    const rows = overview?.policies || [];
    return rows.filter((policy) => {
      if (selectedAdminUserId && String(policy.userMobile || '') !== String(selectedAdminUser?.mobile || '')) {
        return false;
      }
      return matchesAdminQuery([
        policy.userMobile,
        policy.company,
        policy.name,
        policy.applicant,
        policy.insured,
        policy.date,
        policy.paymentPeriod,
        policy.coveragePeriod,
      ]);
    });
  }, [overview, normalizedQuery, selectedAdminUser?.mobile, selectedAdminUserId]);

  const filteredUsers = useMemo(() => {
    const rows = overview?.users || [];
    if (!normalizedQuery) return rows;
    return rows.filter((user) =>
      matchesAdminQuery([
        user.mobile,
        maskMobile(user.mobile),
        user.id,
        `${user.policyCount} 保单`,
        `${user.insuredCount} 被保人`,
      ]),
    );
  }, [overview, normalizedQuery]);

  function formatAdminMobile(mobileValue: string) {
    return String(mobileValue || '').trim() || '未绑定手机号';
  }

  const filteredInsureds = useMemo(() => {
    const rows = overview?.insureds || [];
    return rows.filter((row) => {
      if (selectedAdminUserId && Number(row.userId) !== Number(selectedAdminUserId)) return false;
      return matchesAdminQuery([row.userMobile, maskMobile(row.userMobile), row.insured]);
    });
  }, [overview, normalizedQuery, selectedAdminUserId]);

  if (!adminToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#EEF3F8] px-6">
        <section className="w-full max-w-md rounded-[26px] border border-white bg-white p-8 shadow-[0_24px_80px_-50px_rgba(15,23,42,0.45)]">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <LayoutDashboard size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-950">平台管理后台</h1>
              <p className="mt-1 text-sm text-slate-500">只读查看账号、被保人和保单</p>
            </div>
          </div>
          <TextField label="后台密码" value={password} onChange={setPassword} type="password" placeholder="请输入后台密码" />
          <button
            className="mt-5 flex h-12 w-full items-center justify-center rounded-2xl bg-slate-950 text-sm font-black text-white disabled:opacity-60"
            type="button"
            disabled={loading || !password.trim()}
            onClick={() => void handleAdminLogin()}
          >
            {loading ? '登录中...' : '进入后台'}
          </button>
          <p className="mt-4 text-sm font-medium text-slate-500">{message}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] text-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-950 text-white shadow-[0_14px_38px_-24px_rgba(15,23,42,0.8)]">
              <LayoutDashboard size={21} />
            </div>
            <div>
              <h1 className="text-[19px] font-black leading-tight">P 端保单运营台</h1>
              <p className="mt-0.5 text-xs font-medium text-slate-500">{message}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-[460px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索注册用户手机号 / 被保人 / 保司 / 产品"
                className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-4 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
              />
            </div>
            <button
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 shadow-sm transition hover:border-slate-300"
              type="button"
              onClick={() => {
                void loadOverview();
                void loadOcrConfig();
                void loadOfficialDomainProfiles();
                void loadKnowledgeRecords();
              }}
            >
              刷新
            </button>
            <button className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-bold text-white shadow-[0_14px_36px_-24px_rgba(15,23,42,0.9)]" type="button" onClick={logoutAdmin}>
              退出
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-6 py-5">
        <section className="mb-5 grid grid-cols-5 gap-3">
          <AdminStatCard label="注册账号" value={`${overview?.summary.userCount || 0}`} />
          <AdminStatCard label="被保人数" value={`${overview?.summary.insuredCount || 0}`} />
          <AdminStatCard label="保单总数" value={`${overview?.summary.policyCount || 0}`} />
          <AdminStatCard label="知识库资料" value={`${overview?.summary.knowledgeRecordCount || knowledgeRecords.length || 0}`} />
          <AdminStatCard label="总保额" value={formatCoverageAmount(overview?.summary.totalCoverage || 0)} />
        </section>

        <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-5">
          <aside className="space-y-4">
            <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-black">
                    <Users size={16} />
                    注册用户
                  </div>
                  <p className="mt-1 text-xs font-medium text-slate-400">搜索手机号，点击用户筛选保单</p>
                </div>
                {selectedAdminUser ? (
                  <button
                    className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500 transition hover:bg-slate-200"
                    type="button"
                    onClick={() => setSelectedAdminUserId(null)}
                  >
                    全部
                  </button>
                ) : (
                  <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-400">{filteredUsers.length}</span>
                )}
              </div>
              <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
                {filteredUsers.map((user) => {
                  const active = Number(user.id) === Number(selectedAdminUserId);
                  return (
                    <button
                      key={user.id}
                      className={[
                        'w-full rounded-[18px] border px-4 py-3 text-left transition',
                        active
                          ? 'border-slate-950 bg-slate-950 text-white shadow-[0_18px_42px_-28px_rgba(15,23,42,0.9)]'
                          : 'border-slate-100 bg-slate-50 text-slate-950 hover:border-slate-200 hover:bg-white',
                      ].join(' ')}
                      type="button"
                      onClick={() => setSelectedAdminUserId(Number(user.id))}
                    >
                      <p className="font-mono text-[20px] font-black leading-none tracking-normal">{formatAdminMobile(user.mobile)}</p>
                      <div className="mt-3 flex items-center justify-between text-xs font-bold">
                        <span className={active ? 'text-white/65' : 'text-slate-500'}>{user.insuredCount} 被保人</span>
                        <span className={active ? 'rounded-full bg-white/10 px-2.5 py-1 text-white/80' : 'rounded-full bg-white px-2.5 py-1 text-slate-500'}>
                          {user.policyCount} 保单
                        </span>
                      </div>
                    </button>
                  );
                })}
                {!filteredUsers.length ? <p className="rounded-[18px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">没有匹配的注册用户</p> : null}
              </div>
            </section>

            <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-black">被保人</p>
                  <p className="mt-1 text-xs font-medium text-slate-400">{selectedAdminUser ? '当前注册用户名下' : '全部账号下的被保人'}</p>
                </div>
                <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-400">{filteredInsureds.length}</span>
              </div>
              <div className="max-h-[260px] space-y-2 overflow-auto pr-1">
                {filteredInsureds.map((row) => (
                  <div key={row.key} className="rounded-[16px] border border-slate-100 bg-slate-50 px-3 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 truncate font-black">{row.insured}</p>
                      <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-black text-slate-500">{row.policyCount}</span>
                    </div>
                    <p className="mt-1 font-mono text-xs text-slate-500">{formatAdminMobile(row.userMobile)}</p>
                  </div>
                ))}
                {!filteredInsureds.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">没有匹配的被保人</p> : null}
              </div>
            </section>

            <AdminOcrModePanel
              config={ocrConfig}
              loading={ocrLoading}
              onRefresh={() => void loadOcrConfig()}
              onChange={(mode) => void handleOcrModeChange(mode)}
            />

            <AdminOfficialDomainPanel
              profiles={officialDomainProfiles}
              form={officialDomainForm}
              loading={officialDomainLoading}
              saving={officialDomainSaving}
              onChange={setOfficialDomainForm}
              onEdit={(profile) => setOfficialDomainForm(profileToOfficialDomainForm(profile))}
              onReset={() => setOfficialDomainForm(emptyOfficialDomainForm)}
              onRefresh={() => void loadOfficialDomainProfiles()}
              onSave={() => void saveOfficialDomainProfile()}
              onDelete={(profile) => void removeOfficialDomainProfile(profile)}
            />

            <AdminOptionalResponsibilityGapPanel
              gaps={overview?.optionalResponsibilityGaps || []}
              loading={loading}
              onMarkNotQuantifiable={(gap) => void handleMarkOptionalNotQuantifiable(gap)}
              onReextract={() => void handleReextractOptionalResponsibilities()}
            />

            <AdminKnowledgePanel
              records={knowledgeRecords}
              form={knowledgeCrawlForm}
              loading={knowledgeLoading}
              crawling={knowledgeCrawling}
              onChange={setKnowledgeCrawlForm}
              onRefresh={() => void loadKnowledgeRecords()}
              onCrawl={() => void crawlKnowledgeRecords()}
            />
          </aside>

          <section className="min-w-0 rounded-[22px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.42)]">
            <div className="mb-4 flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-xl font-black">{selectedAdminUser ? '注册用户保单' : '全部保单'}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {selectedAdminUser ? `当前只看 ${formatAdminMobile(selectedAdminUser.mobile)} 名下的被保人和保单。` : '只读列表，点击查看 OCR 原文和责任解析。'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selectedAdminUser ? (
                  <button
                    className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-black text-white"
                    type="button"
                    onClick={() => setSelectedAdminUserId(null)}
                  >
                    清除用户筛选
                  </button>
                ) : null}
                <span className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-500">{filteredPolicies.length} 条</span>
              </div>
            </div>

            <div className="overflow-hidden rounded-[18px] border border-slate-200">
              <div className="grid grid-cols-[1.05fr_1.45fr_0.9fr_0.85fr_0.8fr_0.8fr] bg-slate-50 px-4 py-3 text-xs font-black text-slate-500">
                <div>注册用户</div>
                <div>产品</div>
                <div>被保人</div>
                <div>保司</div>
                <div>保额</div>
                <div>录入时间</div>
              </div>
              <div className="max-h-[720px] divide-y divide-slate-100 overflow-auto">
                {filteredPolicies.map((policy) => {
                  const reportSummary = isPolicyReportGenerating(policy)
                    ? '报告生成中'
                    : isPolicyReportFailed(policy)
                      ? policy.reportError || '报告生成失败'
                      : policy.report || `已生成 ${Array.isArray(policy.responsibilities) ? policy.responsibilities.length : 0} 项保险责任`;
                  return (
                    <button
                      key={policy.id}
                      type="button"
                      onClick={() => setSelectedPolicy(policy)}
                      className="grid w-full grid-cols-[1.05fr_1.45fr_0.9fr_0.85fr_0.8fr_0.8fr] items-center px-4 py-3 text-left text-sm transition hover:bg-slate-50"
                    >
                      <div className="font-mono font-bold text-slate-600">{formatAdminMobile(policy.userMobile || '')}</div>
                      <div className="min-w-0 pr-3 font-black text-slate-950">
                        <span className="block truncate">{policy.name}</span>
                        <span className="mt-1 block truncate text-xs font-medium text-slate-500">{reportSummary}</span>
                      </div>
                      <div className="truncate pr-3">{policy.insured || '未识别'}</div>
                      <div className="truncate pr-3">{policy.company}</div>
                      <div className="font-bold">{formatCoverageAmount(Number(policy.amount || 0))}</div>
                      <div className="text-slate-500">{formatDateLabel(policy.createdAt)}</div>
                    </button>
                  );
                })}
                {!filteredPolicies.length ? (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm font-black text-slate-500">没有匹配的保单</p>
                    <p className="mt-1 text-xs font-medium text-slate-400">可以换一个手机号、被保人或产品关键词搜索。</p>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </main>

      {selectedPolicy ? (
        <AdminPolicyDetail
          policy={selectedPolicy}
          onClose={() => setSelectedPolicy(null)}
          onRetryReport={retryAdminPolicyReport}
          retrying={retryingPolicyId === selectedPolicy.id}
        />
      ) : null}
    </div>
  );
}

function AdminStatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[22px] border border-slate-200 bg-white p-4">
      <p className="text-xs font-black uppercase text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
    </div>
  );
}

function AdminOptionalResponsibilityGapPanel({
  gaps,
  loading,
  onMarkNotQuantifiable,
  onReextract,
}: {
  gaps: OptionalResponsibilityGap[];
  loading: boolean;
  onMarkNotQuantifiable: (gap: OptionalResponsibilityGap) => void;
  onReextract: () => void;
}) {
  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black">可选责任量化缺口</p>
          <p className="mt-1 text-xs font-medium text-slate-400">已识别但未完成结构化指标的可选责任</p>
        </div>
        <button type="button" disabled={loading} onClick={onReextract} className="rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-black text-white disabled:opacity-50">
          重新拆解
        </button>
      </div>
      <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
        {gaps.map((gap) => (
          <article key={gap.id} className="rounded-[16px] border border-amber-100 bg-amber-50 px-3 py-2.5 text-xs">
            <p className="font-black text-amber-900">{gap.productName}</p>
            <p className="mt-1 font-semibold text-amber-800">{gap.company} · {gap.liability}</p>
            <p className="mt-1 leading-5 text-amber-700">{gap.quantificationReason}</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="rounded-full bg-white px-2.5 py-1 font-black text-amber-700">{gap.recentPolicyCount} 张相关保单</span>
              <button type="button" disabled={loading} onClick={() => onMarkNotQuantifiable(gap)} className="rounded-full bg-white px-2.5 py-1 font-black text-slate-700 ring-1 ring-amber-100 disabled:opacity-50">
                标记不可量化
              </button>
            </div>
          </article>
        ))}
        {!gaps.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无量化缺口</p> : null}
      </div>
    </section>
  );
}

function AdminOfficialDomainPanel({
  profiles,
  form,
  loading,
  saving,
  onChange,
  onEdit,
  onReset,
  onRefresh,
  onSave,
  onDelete,
}: {
  profiles: AdminOfficialDomainProfile[];
  form: OfficialDomainForm;
  loading: boolean;
  saving: boolean;
  onChange: (form: OfficialDomainForm) => void;
  onEdit: (profile: AdminOfficialDomainProfile) => void;
  onReset: () => void;
  onRefresh: () => void;
  onSave: () => void;
  onDelete: (profile: AdminOfficialDomainProfile) => void;
}) {
  const customCount = profiles.filter((profile) => profile.source === 'custom').length;
  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black">
            <Shield size={16} />
            保险公司官方域名
          </div>
          <p className="mt-1 text-xs font-medium text-slate-400">维护报告检索使用的官网白名单</p>
        </div>
        <button className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500" type="button" onClick={onRefresh}>
          {loading ? '读取中' : '刷新'}
        </button>
      </div>

      <div className="space-y-2">
        <input
          className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.company}
          onChange={(event) => onChange({ ...form, company: event.target.value })}
          placeholder="保险公司名称"
        />
        <textarea
          className="min-h-[64px] w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.aliasesText}
          onChange={(event) => onChange({ ...form, aliasesText: event.target.value })}
          placeholder="别名，一行一个，例如：平安保险"
        />
        <textarea
          className="min-h-[72px] w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.officialDomainsText}
          onChange={(event) => onChange({ ...form, officialDomainsText: event.target.value })}
          placeholder="官方域名，一行一个，例如：life.pingan.com"
        />
        <textarea
          className="min-h-[56px] w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.siteDomainsText}
          onChange={(event) => onChange({ ...form, siteDomainsText: event.target.value })}
          placeholder="搜索域名，可留空，默认同官方域名"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-60"
          type="button"
          disabled={saving || !form.company.trim() || !form.officialDomainsText.trim()}
          onClick={onSave}
        >
          {saving ? '保存中' : '保存白名单'}
        </button>
        <button className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-500" type="button" onClick={onReset}>
          新增
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs font-black text-slate-400">
        <span>{profiles.length} 条白名单</span>
        <span>{customCount} 条自定义</span>
      </div>
      <div className="mt-2 max-h-[260px] space-y-2 overflow-auto pr-1">
        {profiles.map((profile) => {
          const custom = profile.source === 'custom';
          return (
            <div key={profile.id} className="rounded-[16px] border border-slate-100 bg-slate-50 px-3 py-2.5 text-sm">
              <div className="flex items-start justify-between gap-2">
                <button className="min-w-0 text-left" type="button" onClick={() => onEdit(profile)}>
                  <p className="truncate font-black text-slate-900">{profile.company}</p>
                  <p className="mt-1 truncate text-xs font-medium text-slate-500">{(profile.officialDomains || []).join(' / ')}</p>
                </button>
                <span className={custom ? 'shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700' : 'shrink-0 rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-400'}>
                  {custom ? '自定义' : '系统'}
                </span>
              </div>
              {custom ? (
                <button className="mt-2 text-xs font-black text-red-500" type="button" disabled={saving} onClick={() => onDelete(profile)}>
                  删除
                </button>
              ) : null}
            </div>
          );
        })}
        {!profiles.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无白名单配置</p> : null}
      </div>
    </section>
  );
}

function AdminKnowledgePanel({
  records,
  form,
  loading,
  crawling,
  onChange,
  onRefresh,
  onCrawl,
}: {
  records: KnowledgeRecord[];
  form: KnowledgeCrawlForm;
  loading: boolean;
  crawling: boolean;
  onChange: (form: KnowledgeCrawlForm) => void;
  onRefresh: () => void;
  onCrawl: () => void;
}) {
  const officialCount = records.filter((record) => record.official).length;
  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black">
            <Database size={16} />
            本地产品知识库
          </div>
          <p className="mt-1 text-xs font-medium text-slate-400">先爬官网入库，生成报告优先用本地资料</p>
        </div>
        <button className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500" type="button" disabled={loading} onClick={onRefresh}>
          {loading ? '读取中' : '刷新'}
        </button>
      </div>

      <div className="space-y-2">
        <input
          className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.company}
          onChange={(event) => onChange({ ...form, company: event.target.value })}
          placeholder="保险公司，例如：新华保险"
        />
        <input
          className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
          placeholder="产品名称，例如：盛世荣耀臻享版终身寿险（分红型）"
        />
      </div>

      <button
        className="mt-3 flex w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-60"
        type="button"
        disabled={crawling || !form.company.trim() || !form.name.trim()}
        onClick={onCrawl}
      >
        {crawling ? '爬取中...' : '爬取并写入知识库'}
      </button>

      <div className="mt-4 flex items-center justify-between text-xs font-black text-slate-400">
        <span>{records.length} 条资料</span>
        <span>{officialCount} 条官方</span>
      </div>
      <div className="mt-2 max-h-[260px] space-y-2 overflow-auto pr-1">
        {records.slice(0, 30).map((record) => (
          <a
            key={`${record.id}-${record.url}`}
            className="block rounded-[16px] border border-slate-100 bg-slate-50 px-3 py-2.5 text-sm transition hover:border-blue-100 hover:bg-blue-50"
            href={record.url}
            target="_blank"
            rel="noreferrer"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate font-black text-slate-900">{record.productName || record.title}</p>
              <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-500">
                {record.sourceType || 'html'}
              </span>
            </div>
            <p className="mt-1 truncate text-xs font-medium text-slate-500">{record.company}</p>
            <p className="mt-1 truncate text-xs text-slate-400">{record.url}</p>
          </a>
        ))}
        {!records.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无本地知识库资料</p> : null}
      </div>
    </section>
  );
}

function AdminOcrModePanel({
  config,
  loading,
  onRefresh,
  onChange,
}: {
  config: AdminOcrConfig | null;
  loading: boolean;
  onRefresh: () => void;
  onChange: (mode: string) => void;
}) {
  const currentMode = config?.config.mode || '';
  const updatedAt = config?.config.updatedAt ? formatDateLabel(config.config.updatedAt) : '';

  return (
    <section className="rounded-[22px] border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black">
            <Sparkles size={16} />
            OCR 识别方式
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">{config ? config.runtime.providerLabel : '正在读取配置'}</p>
        </div>
        <button className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-50" type="button" disabled={loading} onClick={onRefresh}>
          刷新
        </button>
      </div>

      <div className="space-y-2">
        {(config?.options || []).map((option) => {
          const active = option.value === currentMode;
          return (
            <button
              key={option.value}
              type="button"
              disabled={loading || active || !option.selectable}
              onClick={() => onChange(option.value)}
              className={[
                'w-full rounded-2xl border px-3 py-3 text-left transition disabled:cursor-not-allowed',
                active
                  ? 'border-slate-950 bg-slate-950 text-white'
                  : option.selectable
                    ? 'border-slate-200 bg-slate-50 hover:border-slate-400'
                    : 'border-slate-100 bg-slate-50 text-slate-400',
              ].join(' ')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-black">{formatOcrModeLabel(option.value)}</span>
                <span className={active ? 'text-xs font-black text-white/70' : 'text-xs font-black text-slate-400'}>
                  {active ? '当前' : option.selectable ? '可切换' : '不可用'}
                </span>
              </div>
              <p className={active ? 'mt-1 text-xs font-medium leading-5 text-white/70' : 'mt-1 text-xs font-medium leading-5 text-slate-500'}>{option.description}</p>
            </button>
          );
        })}
        {!config ? <div className="rounded-2xl bg-slate-50 px-3 py-4 text-sm font-bold text-slate-500">{loading ? '加载中...' : '暂无 OCR 配置'}</div> : null}
      </div>

      <p className="mt-3 text-xs font-medium text-slate-400">
        当前模式：{formatOcrModeLabel(currentMode)}
        {updatedAt ? ` · ${updatedAt}` : ''}
      </p>
      {config?.runtime.localVisionFallback ? (
        <p className="mt-2 rounded-2xl bg-blue-50 px-3 py-2 text-xs font-bold leading-5 text-blue-700">
          本地视觉兜底：
          {config.runtime.localVisionFallback.enabled
            ? '已启用（仅图片，不处理 PDF）'
            : '未启用（仅图片，不处理 PDF）'}
        </p>
      ) : null}
    </section>
  );
}

function AdminPolicyDetail({
  policy,
  onClose,
  onRetryReport,
  retrying = false,
}: {
  policy: Policy;
  onClose: () => void;
  onRetryReport?: (policy: Policy) => void | Promise<void>;
  retrying?: boolean;
}) {
  const reportRef = useRef<HTMLElement | null>(null);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const exportTitle = buildPolicyReportTitle(policy);
  const reportGenerating = isPolicyReportGenerating(policy);
  const reportFailed = isPolicyReportFailed(policy);
  const responsibilities = Array.isArray(policy.responsibilities) ? policy.responsibilities : [];
  const policySources = Array.isArray(policy.sources) ? policy.sources : [];
  const responsibilitySourceLinks = getPolicyResponsibilitySourceLinks(policy);
  const exportControlTitle = getReportExportControlTitle();

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/25">
      <aside className="ml-auto flex h-full w-[560px] flex-col bg-white shadow-2xl">
        <header className="no-print flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <p className="text-xs font-black uppercase text-slate-400">保单详情</p>
            <h2 className="mt-1 text-xl font-black">{policy.name}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-bold ${
                reportGenerating ? 'bg-slate-100 text-slate-300' : 'bg-blue-50 text-blue-700'
              }`}
              type="button"
              disabled={reportGenerating}
              onClick={() => void downloadReportPdf(reportRef.current, exportTitle, policy)}
            >
              <Download size={17} />
              {exportControlTitle}
            </button>
            <button className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-bold" type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>
        <main ref={reportRef} className="print-policy-report flex-1 space-y-5 overflow-auto p-6">
          <section className="print-only">
            <h1>保单解析报告</h1>
            <p>生成时间：{generatedAt}</p>
          </section>

          {policy.report?.trim() ? (
            <section className="print-only print-policy-section">
              <h2>保险责任说明</h2>
              <ReportText text={policy.report} />
            </section>
          ) : null}

          {reportGenerating || reportFailed ? (
            <section className={`rounded-2xl border px-4 py-3 text-sm ${
              reportFailed ? 'border-red-100 bg-red-50 text-red-700' : 'border-orange-100 bg-orange-50 text-orange-700'
            }`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black">{reportFailed ? '报告生成失败' : '报告正在后台生成'}</p>
                  <p className="mt-1 text-xs leading-5">{reportFailed ? policy.reportError || '请稍后刷新查看。' : '保单已经保存，完整责任解析完成后会更新。'}</p>
                </div>
                {reportFailed && onRetryReport ? (
                  <button
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-60"
                    type="button"
                    disabled={retrying}
                    onClick={() => void onRetryReport(policy)}
                  >
                    <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} />
                    {retrying ? '提交中' : '重新生成报告'}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="grid grid-cols-2 gap-3">
            <MetricBox label="账号" value={maskMobile(policy.userMobile || '')} />
            <MetricBox label="被保人" value={policy.insured || '-'} />
            <MetricBox label="投保人关系" value={policy.applicantRelation || '-'} />
            <MetricBox label="被保人关系" value={policy.insuredRelation || '-'} />
            <MetricBox label="保险公司" value={policy.company || '-'} />
            <MetricBox label="生效日期" value={policy.date || '-'} />
            <MetricBox label="保额" value={formatCoverageAmount(Number(policy.amount || 0))} />
            <MetricBox label="首期保费" value={formatCurrency(Number(policy.firstPremium || 0))} />
          </section>
          <section>
            <h3 className="mb-3 text-sm font-black">责任解析</h3>
            <div className="space-y-3">
              {responsibilitySourceLinks.length ? (
                <div className="rounded-2xl border border-blue-100 bg-blue-50 px-3 py-3">
                  <p className="text-xs font-black text-blue-700">官网地址</p>
                  <div className="mt-2 space-y-2">
                    {responsibilitySourceLinks.map((source) => (
                      <a
                        key={`${source.title}-${source.url}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-start gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold leading-5 text-blue-700"
                      >
                        <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0">
                          <span className="block truncate font-black">{source.title || formatSourceUrlHost(source.url)}</span>
                          <span className="block break-all text-blue-500">{source.url}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
              {responsibilities.length ? (
                responsibilities.map((row, index) => (
                  <article key={`${row.coverageType}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <h4 className="font-black">{row.coverageType}</h4>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{row.scenario}</p>
                    <p className="mt-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-blue-700">{row.payout}</p>
                    {row.note ? <p className="mt-2 text-xs text-slate-500">{row.note}</p> : null}
                  </article>
                ))
              ) : (
                <article className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  {reportGenerating ? '正在生成完整保险责任解析。' : '暂无责任解析。'}
                </article>
              )}
            </div>
          </section>
          {policySources.length ? (
            <section className="no-print">
              <h3 className="mb-3 text-sm font-black">资料来源</h3>
              <div className="space-y-2">
                {policySources.map((source, index) => (
                  <a
                    key={`${source.url}-${index}`}
                    className="block rounded-2xl border border-slate-200 bg-white p-3 text-sm transition hover:border-blue-200 hover:bg-blue-50"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-black text-slate-800">{source.title || source.url}</span>
                      <span className={source.official ? 'shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700' : 'shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-black text-slate-500'}>
                        {source.official ? '官方' : source.evidenceLabel || '辅助'}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">{source.url}</p>
                  </a>
                ))}
              </div>
            </section>
          ) : null}
          <section className="no-print">
            <h3 className="mb-3 text-sm font-black">OCR 原文</h3>
            <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded-2xl bg-slate-950 p-4 text-xs leading-5 text-slate-100">{policy.ocrText || '暂无 OCR 原文'}</pre>
          </section>
        </main>
      </aside>
    </div>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[88px] flex-col justify-between rounded-[18px] border border-[#E4ECF8] bg-[#F8FBFF] px-4 py-3.5">
      <p className="text-[12px] font-medium leading-none text-[#8EA3BB]">{label}</p>
      <p className="mt-3 break-words text-[18px] font-semibold leading-7 text-[#0F172A]">{value}</p>
    </div>
  );
}

function ReportText({
  text,
  compact = false,
  inverted = false,
}: {
  text: string;
  compact?: boolean;
  inverted?: boolean;
}) {
  const paragraphs = splitReportIntoParagraphs(text);
  const paragraphClassName = inverted
    ? compact
      ? 'break-words text-base leading-7 text-white/80'
      : 'break-words text-lg leading-9 text-white/85'
    : compact
      ? 'break-words text-base leading-7 text-slate-600'
      : 'break-words text-lg leading-9 text-slate-700';

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {paragraphs.map((paragraph, index) => (
        <p key={`${paragraph.slice(0, 24)}-${index}`} className={paragraphClassName}>
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function normalizeSuggestionQuery(value: string) {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function renderHighlightedSuggestion(value: string, query: string) {
  const normalizedQuery = normalizeSuggestionQuery(query);
  if (!normalizedQuery) return value;
  const index = value.toLowerCase().indexOf(normalizedQuery);
  if (index < 0) return value;
  return (
    <>
      {value.slice(0, index)}
      <mark className="rounded bg-yellow-100 px-0.5 font-black text-blue-700">{value.slice(index, index + normalizedQuery.length)}</mark>
      {value.slice(index + normalizedQuery.length)}
    </>
  );
}

function ResponsibilityAssistant(props: {
  analysis: PolicyAnalysisResult | null;
  company: string;
  companySuggestionLoading: boolean;
  companySuggestions: PolicyCompanySuggestion[];
  localSearched: boolean;
  loading: boolean;
  matches: PolicyKnowledgeMatch[];
  message: string;
  name: string;
  productSuggestionLoading: boolean;
  productSuggestions: PolicyProductSuggestion[];
  onChangeCompany: (value: string) => void;
  onChangeName: (value: string) => void;
  onClose: () => void;
  onOpen: () => void;
  onQuery: () => void;
  onSearchMore: () => void;
  onSelectCompany: (company: string) => void;
  onSelectMatch: (match: PolicyKnowledgeMatch) => void;
  onSelectProduct: (suggestion: PolicyProductSuggestion) => void;
  open: boolean;
}) {
  const {
    analysis,
    company,
    companySuggestionLoading,
    companySuggestions,
    localSearched,
    loading,
    matches,
    message,
    name,
    productSuggestionLoading,
    productSuggestions,
    onChangeCompany,
    onChangeName,
    onClose,
    onOpen,
    onQuery,
    onSearchMore,
    onSelectCompany,
    onSelectMatch,
    onSelectProduct,
    open,
  } = props;
  const [companyFocused, setCompanyFocused] = useState(false);
  const [productFocused, setProductFocused] = useState(false);
  const responsibilities = Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : [];
  const sources = Array.isArray(analysis?.sources) ? analysis.sources : [];
  const productMatches = Array.isArray(matches) ? matches : [];
  const canQuery = Boolean(company.trim() && name.trim() && !loading);
  const canSearchMore = Boolean(localSearched && company.trim() && name.trim() && !responsibilities.length);
  const companyQuery = company.trim();
  const productQuery = name.trim();
  const visibleCompanySuggestions = useMemo(() => {
    const normalizedQuery = normalizeSuggestionQuery(companyQuery);
    if (!normalizedQuery) return [];
    return (Array.isArray(companySuggestions) ? companySuggestions : [])
      .map((suggestion) => {
        const normalizedCompany = normalizeSuggestionQuery(suggestion.company);
        return {
          ...suggestion,
          matchIndex: normalizedCompany.indexOf(normalizedQuery),
          startsWith: normalizedCompany.startsWith(normalizedQuery),
        };
      })
      .filter((suggestion) => suggestion.matchIndex >= 0 && suggestion.company !== companyQuery)
      .sort(
        (left, right) =>
          Number(right.startsWith) - Number(left.startsWith) ||
          left.matchIndex - right.matchIndex ||
          Number(right.recordCount || 0) - Number(left.recordCount || 0) ||
          left.company.localeCompare(right.company, 'zh-CN'),
      )
      .slice(0, 8);
  }, [companyQuery, companySuggestions]);
  const showCompanySuggestions = companyFocused && companyQuery && (companySuggestionLoading || visibleCompanySuggestions.length);
  const visibleProductSuggestions = useMemo(() => {
    const normalizedCompany = normalizeSuggestionQuery(companyQuery);
    const normalizedQuery = normalizeSuggestionQuery(productQuery);
    if (!normalizedCompany) return [];
    return (Array.isArray(productSuggestions) ? productSuggestions : [])
      .map((suggestion) => {
        const normalizedSuggestionCompany = normalizeSuggestionQuery(suggestion.company);
        const normalizedProduct = normalizeSuggestionQuery(suggestion.productName);
        return {
          ...suggestion,
          companyMatches:
            normalizedSuggestionCompany === normalizedCompany ||
            normalizedSuggestionCompany.includes(normalizedCompany) ||
            normalizedCompany.includes(normalizedSuggestionCompany),
          matchIndex: normalizedQuery ? normalizedProduct.indexOf(normalizedQuery) : 0,
          startsWith: normalizedQuery ? normalizedProduct.startsWith(normalizedQuery) : true,
        };
      })
      .filter((suggestion) => suggestion.companyMatches && (!normalizedQuery || suggestion.matchIndex >= 0) && suggestion.productName !== productQuery)
      .sort(
        (left, right) =>
          Number(right.startsWith) - Number(left.startsWith) ||
          left.matchIndex - right.matchIndex ||
          Number(right.recordCount || 0) - Number(left.recordCount || 0) ||
          left.productName.localeCompare(right.productName, 'zh-CN'),
      )
      .slice(0, 8);
  }, [companyQuery, productQuery, productSuggestions]);
  const showProductSuggestions = productFocused && Boolean(companyQuery) && (productSuggestionLoading || visibleProductSuggestions.length);

  return (
    <div className="no-print fixed bottom-6 right-4 z-[70] flex flex-col-reverse items-end sm:right-6">
      <button
        type="button"
        onClick={open ? onClose : onOpen}
        className={
          open
            ? 'flex h-14 w-14 items-center justify-center rounded-full bg-blue-500 text-white shadow-[0_18px_35px_-16px_rgba(37,99,235,0.75)] ring-4 ring-white transition hover:bg-blue-600 active:scale-95'
            : 'flex h-14 max-w-[calc(100vw-2rem)] items-center justify-center gap-2 rounded-full bg-blue-500 px-4 pr-5 text-white shadow-[0_18px_35px_-16px_rgba(37,99,235,0.75)] ring-4 ring-white transition hover:bg-blue-600 active:scale-95'
        }
        aria-label={open ? '关闭保险责任助手' : '打开保险责任助手'}
        title={open ? '关闭保险责任助手' : '打开保险责任助手'}
      >
        {open ? (
          <X size={23} />
        ) : (
          <>
            <Bot className="shrink-0" size={22} />
            <span className="whitespace-nowrap text-sm font-black leading-none">输入保险名称查责任</span>
          </>
        )}
      </button>

      {open ? (
        <section className="mb-3 flex max-h-[calc(100vh-10rem)] w-[calc(100vw-2rem)] max-w-[420px] flex-col overflow-hidden rounded-[24px] border border-[#D7E5F6] bg-white shadow-[0_26px_70px_-30px_rgba(15,23,42,0.42)]">
          <header className="flex items-center justify-between gap-3 border-b border-slate-100 bg-[#F8FBFF] px-4 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-500 text-white shadow-lg shadow-blue-500/25">
                <Bot size={21} />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-base font-black text-slate-950">保险责任助手</h2>
                <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">{message}</p>
              </div>
            </div>
            <button
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-slate-500 ring-1 ring-slate-200 transition-colors hover:bg-slate-100"
              type="button"
              onClick={onClose}
              aria-label="关闭保险责任助手"
            >
              <X size={18} />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="grid gap-3">
              <label className="relative block">
                <span className="mb-1.5 block text-xs font-black text-slate-500">保险公司</span>
                <input
                  value={company}
                  onChange={(event) => onChangeCompany(event.target.value)}
                  onFocus={() => setCompanyFocused(true)}
                  onBlur={() => window.setTimeout(() => setCompanyFocused(false), 120)}
                  placeholder="例如：中国平安"
                  autoComplete="off"
                  className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
                />
                {showCompanySuggestions ? (
                  <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="保险公司候选">
                    {companySuggestionLoading ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在加载保险公司
                      </div>
                    ) : (
                      visibleCompanySuggestions.map((suggestion) => (
                        <button
                          key={suggestion.company}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                          role="option"
                          aria-selected={false}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            onSelectCompany(suggestion.company);
                            setCompanyFocused(false);
                          }}
                        >
                          <span className="min-w-0 truncate">{renderHighlightedSuggestion(suggestion.company, companyQuery)}</span>
                          <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </label>
              <label className="relative block">
                <span className="mb-1.5 block text-xs font-black text-slate-500">保险产品</span>
                <input
                  value={name}
                  onChange={(event) => onChangeName(event.target.value)}
                  placeholder="例如：平安福"
                  onFocus={() => setProductFocused(true)}
                  onBlur={() => window.setTimeout(() => setProductFocused(false), 120)}
                  autoComplete="off"
                  className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
                />
                {showProductSuggestions ? (
                  <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="保险产品候选">
                    {productSuggestionLoading ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在加载保险产品
                      </div>
                    ) : (
                      visibleProductSuggestions.map((suggestion) => (
                        <button
                          key={`${suggestion.company}-${suggestion.productName}`}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                          role="option"
                          aria-selected={false}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            onSelectProduct(suggestion);
                            setProductFocused(false);
                          }}
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{renderHighlightedSuggestion(suggestion.productName, productQuery)}</span>
                            {suggestion.company !== companyQuery ? (
                              <span className="mt-0.5 block truncate text-[11px] font-bold text-slate-400">{suggestion.company}</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </label>
              <button
                type="button"
                disabled={!canQuery}
                onClick={onQuery}
                className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-blue-500 text-sm font-black text-white shadow-lg shadow-blue-500/25 transition hover:bg-blue-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {loading ? <Loader2 className="animate-spin" size={18} /> : <SendHorizontal size={18} />}
                {loading ? '查询中...' : '查询保险责任'}
              </button>
            </div>

            {productMatches.length ? (
              <section className="mt-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-black text-slate-950">请选择产品</h3>
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-black text-emerald-700">
                    {productMatches.length} 个匹配
                  </span>
                </div>
                <div className="space-y-2.5">
                  {productMatches.map((match, index) => (
                    <button
                      key={`${match.company}-${match.productName}-${index}`}
                      type="button"
                      disabled={loading}
                      onClick={() => onSelectMatch(match)}
                      className="block w-full rounded-[18px] border border-[#DDE8F5] bg-white p-3.5 text-left shadow-[0_14px_30px_-28px_rgba(15,23,42,0.35)] transition hover:border-blue-200 hover:bg-[#F8FBFF] active:scale-[0.99] disabled:opacity-60"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[11px] font-black text-blue-600">{match.company}</p>
                          <h4 className="mt-1 break-words text-sm font-black leading-6 text-slate-950">{match.productName}</h4>
                          <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">
                            {match.bestSource?.title || match.title || match.matchReason}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700">
                          {Math.round(match.score * 100)}%
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-black text-slate-400">
                        <span className="rounded-full bg-slate-50 px-2 py-1">{match.matchReason}</span>
                        <span className="rounded-full bg-slate-50 px-2 py-1">{match.evidenceLabel}</span>
                        <span className="rounded-full bg-slate-50 px-2 py-1">{match.sourceCount} 份资料</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {canSearchMore ? (
              <section className="mt-4 rounded-[18px] border border-blue-100 bg-[#F8FBFF] p-3.5">
                <button
                  type="button"
                  disabled={loading}
                  onClick={onSearchMore}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-blue-200 bg-white text-sm font-black text-blue-700 shadow-sm transition hover:bg-blue-50 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {loading ? <Loader2 className="animate-spin" size={17} /> : <Search size={17} />}
                  查找更多保单
                </button>
              </section>
            ) : null}

            <section className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-black text-slate-950">保险责任</h3>
                {responsibilities.length ? (
                  <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-700">{responsibilities.length} 项</span>
                ) : null}
              </div>
              <div className="space-y-2.5">
                {responsibilities.length ? (
                  responsibilities.map((row, index) => (
                    <article key={`${row.coverageType}-${index}`} className="rounded-[18px] border border-[#DDE8F5] bg-[#F8FBFF] p-3.5">
                      <div className="flex items-start gap-3">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-white text-xs font-black text-blue-600 ring-1 ring-blue-100">
                          {index + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="break-words text-sm font-black leading-6 text-slate-950">{row.coverageType || '保险责任'}</h4>
                          {row.scenario ? <p className="mt-1 whitespace-pre-wrap break-words text-xs font-semibold leading-5 text-slate-500">{row.scenario}</p> : null}
                          {row.payout ? <p className="mt-2 break-words rounded-xl bg-white px-3 py-2 text-xs font-black leading-5 text-blue-700">{row.payout}</p> : null}
                          {row.note ? <p className="mt-2 break-words text-xs font-medium leading-5 text-slate-500">{row.note}</p> : null}
                        </div>
                      </div>
                    </article>
                  ))
                ) : productMatches.length ? (
                  <div className="rounded-[18px] border border-dashed border-blue-100 bg-blue-50/50 px-4 py-6 text-center text-sm font-bold text-blue-500">
                    点击上方产品后输出保险责任
                  </div>
                ) : localSearched ? (
                  <div className="rounded-[18px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-bold text-slate-400">
                    本地库未找到匹配产品
                  </div>
                ) : (
                  <div className="rounded-[18px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-bold text-slate-400">
                    暂无查询结果
                  </div>
                )}
              </div>
            </section>

            {sources.length ? (
              <section className="mt-4">
                <h3 className="mb-2 text-sm font-black text-slate-950">资料来源</h3>
                <div className="space-y-2">
                  {sources.slice(0, 3).map((source, index) => (
                    <a
                      key={`${source.url}-${index}`}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-[16px] border border-slate-200 bg-white px-3 py-2.5 text-xs transition hover:border-blue-200 hover:bg-blue-50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-black text-slate-700">{source.title || source.url}</span>
                        <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 font-black text-blue-700">{source.evidenceLabel || (source.official ? '官方资料' : '资料')}</span>
                      </div>
                      <p className="mt-1 truncate font-medium text-slate-400">{source.url}</p>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </section>
      ) : null}

    </div>
  );
}

function PolicyListItem({ policy, index, onOpen }: { policy: Policy; index: number; onOpen: () => void }) {
  const reportGenerating = isPolicyReportGenerating(policy);
  const reportFailed = isPolicyReportFailed(policy);
  const cashValueSummary = summarizeCashValues(policy.cashValues);
  const validityStatus = resolvePolicyValidityStatus(policy.coveragePeriod, {
    effectiveDate: policy.date,
    insuredBirthday: policy.insuredBirthday,
  });
  const validityStatusClassName = policyValidityClassName(validityStatus.tone);
  const reportStatusClassName = reportGenerating
    ? 'bg-[#FFF7ED] text-[#C2410C] ring-[#FED7AA]'
    : reportFailed
      ? 'bg-[#FEF2F2] text-[#DC2626] ring-[#FECACA]'
      : 'bg-[#EFF6FF] text-[#1D4ED8] ring-[#DBEAFE]';
  const reportStatusLabel = reportGenerating ? '报告生成中' : reportFailed ? '报告失败' : 'OCR 已识别';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group block w-full cursor-pointer rounded-[20px] border border-[#E3ECF8] bg-[linear-gradient(180deg,rgba(17,82,212,0.045)_0%,rgba(248,251,255,0.96)_100%)] px-4 py-4 text-left transition hover:border-[#BCD1EE] active:scale-[0.995]"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] border border-[#CFE0F4] bg-white text-[#1152D4] shadow-[0_10px_22px_-20px_rgba(17,82,212,0.45)]">
          <FileText className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-[#68829F] ring-1 ring-[#DFE8F4]">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${validityStatusClassName}`}>{validityStatus.label}</span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${reportStatusClassName}`}>{reportStatusLabel}</span>
          </div>
          <p
            className="mt-2 text-[16px] font-semibold leading-[1.45] text-[#0F172A]"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {policy.name}
          </p>
          <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[12px] font-medium text-[#5E7A98] ring-1 ring-[#DCE7F4]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#1152D4]/45" />
            <span className="truncate">{policy.company}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
            <span className="rounded-xl bg-white px-3 py-2 text-[#5E7A98] ring-1 ring-[#E1EAF5]">保额 {formatCoverageAmount(Number(policy.amount || 0))}</span>
            <span className="rounded-xl bg-white px-3 py-2 text-[#5E7A98] ring-1 ring-[#E1EAF5]">保费 {formatCurrency(Number(policy.firstPremium || 0))}</span>
          </div>
          {cashValueSummary ? (
            <div className="mt-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-[12px] font-semibold text-emerald-700">
              现金价值已录入 {cashValueSummary.count} 年 · 首年 {formatCurrency(cashValueSummary.first.cashValue)} · {cashValueSummary.last.policyYear}年末 {formatCurrency(cashValueSummary.last.cashValue)}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function CustomerBottomTabs({
  activeTab,
  onChange,
  onOpenReport,
  fixed = true,
}: {
  activeTab: CustomerTab;
  onChange: (tab: CustomerTab) => void;
  onOpenReport?: () => void;
  fixed?: boolean;
}) {
  const tabs: Array<{ key: CustomerTab; label: string; icon: typeof UploadCloud }> = [
    { key: 'entry', label: '录入保单', icon: UploadCloud },
    { key: 'policies', label: '我的保单', icon: FileText },
  ];
  return (
    <nav className={fixed ? 'pb-safe fixed bottom-0 left-0 right-0 z-40 border-t border-slate-100 bg-white px-4 pt-2 shadow-[0_-10px_20px_-12px_rgba(15,23,42,0.12)]' : ''}>
      <div className={`grid gap-2 ${onOpenReport ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={`flex h-12 items-center justify-center gap-2 rounded-2xl text-sm font-black transition ${
                active ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-50 text-slate-500'
              }`}
            >
              <Icon size={18} />
              {tab.label}
            </button>
          );
        })}
        {onOpenReport ? (
          <button
            type="button"
            onClick={onOpenReport}
            className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-blue-50 text-sm font-black text-blue-600 ring-1 ring-blue-100 transition hover:bg-blue-100 active:bg-blue-100"
            aria-label="查看家庭保障分析报告"
          >
            <LayoutDashboard size={18} />
            查看报告
          </button>
        ) : null}
      </div>
    </nav>
  );
}

function CustomerAccountSheet(props: {
  insuredCount: number;
  isLoggedIn: boolean;
  mobile: string;
  onClose: () => void;
  onLogin: () => void;
  onLogout: () => void;
  policyCount: number;
}) {
  const { insuredCount, isLoggedIn, mobile, onClose, onLogin, onLogout, policyCount } = props;
  return (
    <div className="fixed inset-0 z-[75] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-500 text-white shadow-lg shadow-blue-500/25">
              <CircleUserRound size={24} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-950">我的账号</h2>
              <p className="mt-1 truncate text-sm font-semibold text-slate-500">{isLoggedIn ? mobile : '游客模式'}</p>
            </div>
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
            aria-label="关闭账号"
          >
            <X size={18} />
          </button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-black text-slate-400">登录账号</p>
          <p className="mt-2 break-all text-xl font-black text-slate-950">{isLoggedIn ? mobile : '未登录'}</p>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-black text-slate-400">我的保单</p>
            <p className="mt-2 text-2xl font-black text-slate-950">{policyCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-black text-slate-400">被保人</p>
            <p className="mt-2 text-2xl font-black text-slate-950">{insuredCount}</p>
          </div>
        </div>

        {isLoggedIn ? (
          <button
            className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 text-base font-black text-red-600 transition-colors hover:bg-red-100"
            type="button"
            onClick={onLogout}
          >
            <LogOut size={19} />
            退出账号
          </button>
        ) : (
          <button className="mt-5 flex h-12 w-full items-center justify-center rounded-xl bg-blue-500 text-base font-black text-white shadow-lg shadow-blue-500/25" type="button" onClick={onLogin}>
            验证手机号
          </button>
        )}
      </section>
    </div>
  );
}

function PhoneVerificationDialog(props: {
  code: string;
  devCode: string;
  loading: boolean;
  message: string;
  mobile: string;
  onChangeCode: (value: string) => void;
  onChangeMobile: (value: string) => void;
  onClose: () => void;
  onSendCode: () => void;
  onVerify: () => void;
}) {
  const { code, devCode, loading, message, mobile, onChangeCode, onChangeMobile, onClose, onSendCode, onVerify } = props;
  return (
    <div className="fixed inset-0 z-[80] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-black text-slate-950">手机验证码</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">第一张保单可直接录入，第二张开始需要验证手机号。</p>
          </div>
          <button className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500" type="button" onClick={onClose}>
            稍后
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-black text-slate-500">手机号</span>
            <input
              value={mobile}
              onChange={(event) => onChangeMobile(event.target.value.replace(/[^\d]/g, '').slice(0, 11))}
              inputMode="tel"
              placeholder="请输入手机号"
              className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-blue-500"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-black text-slate-500">验证码</span>
            <div className="flex gap-2">
              <input
                value={code}
                onChange={(event) => onChangeCode(event.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder="6 位验证码"
                className="h-12 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-blue-500"
              />
              <button
                className="h-12 rounded-xl bg-blue-500 px-4 text-sm font-black text-white shadow-lg shadow-blue-500/20 transition-colors hover:bg-blue-600 disabled:opacity-50"
                type="button"
                disabled={loading || mobile.trim().length !== 11}
                onClick={onSendCode}
              >
                发验证码
              </button>
            </div>
          </label>
        </div>

        <p className="mt-3 rounded-xl bg-blue-50 px-4 py-3 text-sm font-bold leading-6 text-blue-700">{devCode ? `本地验证码：${devCode}` : message}</p>

        <button
          className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-blue-500 text-base font-black text-white shadow-lg shadow-blue-500/25 disabled:opacity-60"
          type="button"
          disabled={loading || mobile.trim().length !== 11 || code.trim().length !== 6}
          onClick={onVerify}
        >
          {loading ? '处理中...' : '验证并继续录入'}
        </button>
      </section>
    </div>
  );
}

function ProductMatchSelectPanel(props: {
  loading: boolean;
  matches: PolicyKnowledgeMatch[];
  message: string;
  onSelect: (match: PolicyKnowledgeMatch) => void;
}) {
  const matches = Array.isArray(props.matches) ? props.matches : [];
  const statusMessage = props.loading ? '正在匹配本地产品' : props.message;
  if (!props.loading && !matches.length && !statusMessage) return null;

  return (
    <section className="mt-2 overflow-hidden rounded-xl border border-[#DDE8F5] bg-[#F8FBFF]" aria-label="保险产品匹配候选">
      <div className="flex items-center justify-between gap-3 border-b border-blue-100/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Search className="h-4 w-4 shrink-0 text-blue-500" />
          <span className="truncate text-xs font-black text-slate-700">相似产品</span>
        </div>
        {props.loading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
        ) : matches.length ? (
          <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-black text-blue-700">{matches.length} 个</span>
        ) : null}
      </div>

      {matches.length ? (
        <div className="max-h-[260px] overflow-y-auto p-2" role="listbox" aria-label="选择本地匹配产品">
          {matches.map((match, index) => (
            <button
              key={`${match.company}-${match.productName}-${index}`}
              type="button"
              onClick={() => props.onSelect(match)}
              className="block w-full rounded-lg px-3 py-2.5 text-left transition hover:bg-white active:scale-[0.99]"
              role="option"
              aria-selected={false}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-black text-blue-600">{match.company}</p>
                  <p className="mt-0.5 break-words text-sm font-black leading-5 text-slate-950">{match.productName}</p>
                  <p className="mt-1 line-clamp-2 break-words text-xs font-medium leading-5 text-slate-500">
                    {match.bestSource?.title || match.title || match.matchReason}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[11px] font-black text-blue-700 ring-1 ring-blue-100">
                  {Math.round(match.score * 100)}%
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-black text-slate-400">
                <span className="rounded-full bg-white px-2 py-0.5">{match.matchReason}</span>
                <span className="rounded-full bg-white px-2 py-0.5">{match.sourceCount} 份资料</span>
              </div>
            </button>
          ))}
        </div>
      ) : statusMessage ? (
        <p className="px-3 py-3 text-xs font-semibold leading-5 text-slate-500">{statusMessage}</p>
      ) : null}
    </section>
  );
}

function UploadPolicyPage(props: {
  activeTab: CustomerTab;
  canSubmit: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  formData: PolicyFormData;
  formCompanySuggestionLoading: boolean;
  formCompanySuggestions: PolicyCompanySuggestion[];
  formProductSuggestionLoading: boolean;
  formProductSuggestions: PolicyProductSuggestion[];
  isLoggedIn: boolean;
  loading: boolean;
  message: string;
  mobile: string;
  ocrText: string;
  productMatchLoading: boolean;
  productMatchMessage: string;
  productMatches: PolicyKnowledgeMatch[];
  onBack: () => void;
  onChangeTab: (tab: CustomerTab) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onGenerateAnalysis: () => void;
  onOcrTextChange: (value: string) => void;
  onOpenAccount: () => void;
  onOpenReport: () => void;
  onScanClick: () => void;
  onSelectFormCompany: (company: string) => void;
  onSelectFormProduct: (suggestion: PolicyProductSuggestion) => void;
  onSelectProductMatch: (match: PolicyKnowledgeMatch) => void;
  onSubmit: () => void;
  onAddPlan: () => void;
  onRemovePlan: (index: number) => void;
  onUpdatePlan: (index: number, key: string, value: string) => void;
  onUpdateForm: (key: keyof PolicyFormData, value: string) => void;
  uploadItem: UploadItem | null;
}) {
  const {
    activeTab,
    canSubmit,
    fileInputRef,
    formData,
    formCompanySuggestionLoading,
    formCompanySuggestions,
    formProductSuggestionLoading,
    formProductSuggestions,
    isLoggedIn,
    loading,
    message,
    mobile,
    ocrText,
    productMatchLoading,
    productMatchMessage,
    productMatches,
    onBack,
    onChangeTab,
    onFileChange,
    onGenerateAnalysis,
    onOcrTextChange,
    onOpenAccount,
    onOpenReport,
    onScanClick,
    onSelectFormCompany,
    onSelectFormProduct,
    onSelectProductMatch,
    onSubmit,
    onAddPlan,
    onRemovePlan,
    onUpdatePlan,
    onUpdateForm,
    uploadItem,
  } = props;
  const [ocrCopyMessage, setOcrCopyMessage] = useState('');
  const [companyFocused, setCompanyFocused] = useState(false);
  const [productFocused, setProductFocused] = useState(false);
  const companyQuery = formData.company.trim();
  const productQuery = formData.name.trim();
  const visibleCompanySuggestions = useMemo(() => {
    const normalizedQuery = normalizeSuggestionQuery(companyQuery);
    if (!normalizedQuery) return [];
    return (Array.isArray(formCompanySuggestions) ? formCompanySuggestions : [])
      .map((suggestion) => {
        const normalizedCompany = normalizeSuggestionQuery(suggestion.company);
        return {
          ...suggestion,
          matchIndex: normalizedCompany.indexOf(normalizedQuery),
          startsWith: normalizedCompany.startsWith(normalizedQuery),
        };
      })
      .filter((suggestion) => suggestion.matchIndex >= 0 && suggestion.company !== companyQuery)
      .sort(
        (left, right) =>
          Number(right.startsWith) - Number(left.startsWith) ||
          left.matchIndex - right.matchIndex ||
          Number(right.recordCount || 0) - Number(left.recordCount || 0) ||
          left.company.localeCompare(right.company, 'zh-CN'),
      )
      .slice(0, 8);
  }, [companyQuery, formCompanySuggestions]);
  const visibleProductSuggestions = useMemo(() => {
    const normalizedCompany = normalizeSuggestionQuery(companyQuery);
    const normalizedQuery = normalizeSuggestionQuery(productQuery);
    if (!normalizedCompany) return [];
    return (Array.isArray(formProductSuggestions) ? formProductSuggestions : [])
      .map((suggestion) => {
        const normalizedSuggestionCompany = normalizeSuggestionQuery(suggestion.company);
        const normalizedProduct = normalizeSuggestionQuery(suggestion.productName);
        return {
          ...suggestion,
          companyMatches:
            normalizedSuggestionCompany === normalizedCompany ||
            normalizedSuggestionCompany.includes(normalizedCompany) ||
            normalizedCompany.includes(normalizedSuggestionCompany),
          matchIndex: normalizedQuery ? normalizedProduct.indexOf(normalizedQuery) : 0,
          startsWith: normalizedQuery ? normalizedProduct.startsWith(normalizedQuery) : true,
        };
      })
      .filter((suggestion) => suggestion.companyMatches && (!normalizedQuery || suggestion.matchIndex >= 0) && suggestion.productName !== productQuery)
      .sort(
        (left, right) =>
          Number(right.startsWith) - Number(left.startsWith) ||
          left.matchIndex - right.matchIndex ||
          Number(right.recordCount || 0) - Number(left.recordCount || 0) ||
          left.productName.localeCompare(right.productName, 'zh-CN'),
      )
      .slice(0, 8);
  }, [companyQuery, formProductSuggestions, productQuery]);
  const showCompanySuggestions = companyFocused && companyQuery && (formCompanySuggestionLoading || visibleCompanySuggestions.length);
  const showProductSuggestions = productFocused && companyQuery && (formProductSuggestionLoading || visibleProductSuggestions.length);

  async function handleCopyOcrText() {
    const text = ocrText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setOcrCopyMessage('已复制 OCR 原文');
    } catch {
      setOcrCopyMessage('复制失败，请手动选择文本');
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-slate-100 bg-white px-4 py-4">
        <div></div>
        <h1 className="text-lg font-bold">录入保单</h1>
        <div className="flex justify-end">
          <div className="flex items-center gap-2">
            <button
              className="flex h-10 items-center gap-1.5 rounded-full bg-blue-50 px-3 text-xs font-black text-blue-600 ring-1 ring-blue-100 transition-colors hover:bg-blue-100"
              type="button"
              onClick={onOpenReport}
              aria-label="查看家庭保障分析报告"
            >
              <LayoutDashboard size={18} />
              <span className="hidden sm:inline">查看报告</span>
            </button>
            <button
              className="flex h-10 max-w-[128px] items-center gap-1.5 rounded-full bg-slate-100 px-3 text-xs font-black text-slate-700 transition-colors hover:bg-slate-200"
              type="button"
              onClick={onOpenAccount}
              aria-label="查看账号"
            >
              <CircleUserRound size={18} />
              <span className="truncate">{isLoggedIn ? maskMobile(mobile) : '游客'}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto pb-44">
        <section className="p-4">
          <div className="mb-3">
            <h2 className="text-lg font-bold">拍照自动识别</h2>
            <p className="mt-1 text-xs text-slate-500">先做 OCR 识别，再按保司和产品生成保险责任</p>
          </div>
          <button
            onClick={onScanClick}
            className={`relative flex aspect-[2/1] w-full cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 border-dashed transition-transform active:scale-[0.98] ${
              loading ? 'border-blue-400 bg-blue-100 shadow-[0_18px_45px_-28px_rgba(37,99,235,0.55)]' : 'border-blue-300 bg-blue-50'
            }`}
            type="button"
            aria-busy={loading}
          >
            {loading ? (
              <div className="absolute inset-x-8 top-1/2 h-px -translate-y-1/2 bg-blue-400/60 shadow-[0_0_22px_rgba(37,99,235,0.45)] motion-safe:animate-pulse" />
            ) : null}
            <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-blue-100 text-blue-500">
              {loading ? (
                <Loader2 size={30} className="animate-spin" />
              ) : (
                <Camera size={28} />
              )}
            </div>
            <span className="max-w-[80%] truncate text-center text-base font-bold text-blue-600">{loading ? 'OCR 识别中' : uploadItem ? uploadItem.name : getWechatUploadLabel()}</span>
            <p className="px-4 text-center text-xs text-blue-400" aria-live="polite">{loading ? '正在读取保单信息' : uploadItem ? 'OCR 已完成，可继续生成保险责任' : '上传保单基本信息页照片'}</p>
            <div className="absolute left-3 top-3 h-4 w-4 rounded-tl border-l-2 border-t-2 border-blue-500"></div>
            <div className="absolute right-3 top-3 h-4 w-4 rounded-tr border-r-2 border-t-2 border-blue-500"></div>
            <div className="absolute bottom-3 left-3 h-4 w-4 rounded-bl border-b-2 border-l-2 border-blue-500"></div>
            <div className="absolute bottom-3 right-3 h-4 w-4 rounded-br border-b-2 border-r-2 border-blue-500"></div>
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />

          <div className="mt-4 rounded-xl border border-blue-100 bg-white px-4 py-3 text-sm font-medium text-blue-700">{message}</div>

          <details className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">查看或粘贴 OCR 文本</summary>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-xs font-bold text-slate-400">
                {ocrText.trim() ? `${ocrText.trim().length} 字 OCR 原文` : '暂无 OCR 原文'}
              </span>
              <button
                type="button"
                disabled={!ocrText.trim()}
                onClick={() => void handleCopyOcrText()}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-blue-50 px-3 text-xs font-black text-blue-600 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Copy size={14} />
                复制原文
              </button>
            </div>
            <textarea
              value={ocrText}
              onChange={(event) => onOcrTextChange(event.target.value)}
              rows={8}
              placeholder="本地测试可粘贴：保司名称 险种名称 基本保险金额30万 20年交 终身"
              className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-sm leading-6 text-slate-700 selection:bg-blue-200 focus:border-blue-500 focus:ring-blue-500"
            />
            {ocrCopyMessage ? <p className="mt-2 text-xs font-bold text-slate-500">{ocrCopyMessage}</p> : null}
          </details>
        </section>

        <div className="flex items-center gap-4 px-4 py-2">
          <div className="h-px flex-1 bg-slate-200"></div>
          <span className="text-xs font-medium text-slate-400">或 手动输入保单信息</span>
          <div className="h-px flex-1 bg-slate-200"></div>
        </div>

        <form className="space-y-4 p-4" onSubmit={(event) => event.preventDefault()}>
          <div className="space-y-4">
            <label className="relative block">
              <span className="mb-1.5 block text-sm font-bold text-slate-700">保险公司</span>
              <input
                value={formData.company}
                onChange={(event) => onUpdateForm('company', event.target.value)}
                onFocus={() => setCompanyFocused(true)}
                onBlur={() => window.setTimeout(() => setCompanyFocused(false), 120)}
                placeholder="输入保险公司，可模糊匹配"
                autoComplete="off"
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
              />
              {showCompanySuggestions ? (
                <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="录入保险公司候选">
                  {formCompanySuggestionLoading ? (
                    <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      正在加载保险公司
                    </div>
                  ) : (
                    visibleCompanySuggestions.map((suggestion) => (
                      <button
                        key={suggestion.company}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                        role="option"
                        aria-selected={false}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          onSelectFormCompany(suggestion.company);
                          setCompanyFocused(false);
                        }}
                      >
                        <span className="min-w-0 truncate">{renderHighlightedSuggestion(suggestion.company, companyQuery)}</span>
                        <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </label>
            <div>
              <label className="relative block">
                <span className="mb-1.5 block text-sm font-bold text-slate-700">保险名称</span>
                <input
                  value={formData.name}
                  onChange={(event) => onUpdateForm('name', event.target.value)}
                  onFocus={() => setProductFocused(true)}
                  onBlur={() => window.setTimeout(() => setProductFocused(false), 120)}
                  placeholder="输入保单上的险种全称"
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
                />
                {showProductSuggestions ? (
                  <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="录入保险产品候选">
                    {formProductSuggestionLoading ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在加载保险产品
                      </div>
                    ) : (
                      visibleProductSuggestions.map((suggestion) => (
                        <button
                          key={`${suggestion.company}-${suggestion.productName}`}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                          role="option"
                          aria-selected={false}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            onSelectFormProduct(suggestion);
                            setProductFocused(false);
                          }}
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{renderHighlightedSuggestion(suggestion.productName, productQuery)}</span>
                            <span className="mt-0.5 block truncate text-[11px] font-bold text-slate-400">{suggestion.company}</span>
                          </span>
                          <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </label>
              <ProductMatchSelectPanel
                loading={productMatchLoading}
                matches={productMatches}
                message={productMatchMessage}
                onSelect={onSelectProductMatch}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <TextField label="投保人" value={formData.applicant} onChange={(value) => onUpdateForm('applicant', value)} placeholder="姓名" />
            <TextField label="被保险人" value={formData.insured} onChange={(value) => onUpdateForm('insured', value)} placeholder="姓名" />
          </div>

          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm font-bold text-slate-700">法定受益人</span>
              <input
                type="checkbox"
                checked={formData.beneficiary === '法定'}
                onChange={(event) => onUpdateForm('beneficiary', event.target.checked ? '法定' : '')}
                className="h-5 w-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
            </label>
            {formData.beneficiary === '法定' ? (
              <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700">受益人：法定</div>
            ) : (
              <TextField
                label="受益人姓名"
                value={formData.beneficiary}
                onChange={(value) => onUpdateForm('beneficiary', value)}
                placeholder="请输入受益人姓名"
              />
            )}
          </div>

          <TextField
            label="被保险人生日"
            value={formData.insuredBirthday}
            onChange={(value) => onUpdateForm('insuredBirthday', value)}
            type="date"
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              label="投保人和录入人的关系"
              value={formData.applicantRelation}
              onChange={(value) => onUpdateForm('applicantRelation', value)}
              options={POLICY_RELATION_OPTIONS}
              placeholder="请选择关系"
            />
            <SelectField
              label="被保险人和录入人的关系"
              value={formData.insuredRelation}
              onChange={(value) => onUpdateForm('insuredRelation', value)}
              options={POLICY_RELATION_OPTIONS}
              placeholder="请选择关系"
            />
          </div>

          <TextField label="投保时间" value={formData.date} onChange={(value) => onUpdateForm('date', value)} type="date" />

          <div className="grid grid-cols-2 gap-4">
            <TextField label="缴费期间" value={formData.paymentPeriod} onChange={(value) => onUpdateForm('paymentPeriod', value)} placeholder="如 10年交 或 趸交" />
            <TextField label="保障期间" value={formData.coveragePeriod} onChange={(value) => onUpdateForm('coveragePeriod', value)} placeholder="如 终身、30年、至70岁" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <TextField label="保额 (元)" value={formData.amount} onChange={(value) => onUpdateForm('amount', sanitizeAmount(value))} inputMode="decimal" placeholder="0.00" />
            <TextField
              label="首期保费 (元)"
              value={formData.firstPremium}
              onChange={(value) => onUpdateForm('firstPremium', sanitizeAmount(value))}
              inputMode="decimal"
              placeholder="0.00"
            />
          </div>

          <PolicyPlanEditor
            company={formData.company}
            plans={normalizePolicyPlanList(formData.plans, formData.company, { keepEmpty: true })}
            onAdd={onAddPlan}
            onRemove={onRemovePlan}
            onUpdate={onUpdatePlan}
          />
        </form>
      </main>

      <div className="pb-safe fixed bottom-0 left-0 right-0 z-50 border-t border-slate-100 bg-white p-4 shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.05)]">
        <p className="mb-3 text-center text-xs text-slate-500">确认信息后保存保单</p>
        <div className="flex gap-3">
          <button
            onClick={onBack}
            type="button"
            className="h-12 flex-[0.8] rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700 transition-transform active:scale-[0.98]"
          >
            取消
          </button>
          <button
            onClick={onGenerateAnalysis}
            disabled={loading || !canSubmit}
            type="button"
            className="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl border border-blue-100 bg-blue-50 px-2 text-sm font-bold text-blue-700 transition-transform active:scale-[0.98] disabled:opacity-60"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : <Search size={18} />}
            生成责任
          </button>
          <button
            onClick={onSubmit}
            disabled={loading || !canSubmit}
            className="flex h-12 flex-[1.25] items-center justify-center gap-2 rounded-xl bg-blue-500 px-2 text-sm font-bold text-white shadow-lg shadow-blue-500/30 transition-transform active:scale-[0.98] disabled:opacity-60"
          >
            <CheckCircle2 size={20} />
            {loading ? '保存中...' : '保存保单'}
          </button>
        </div>
        <div className="mt-3">
          <CustomerBottomTabs activeTab={activeTab} onChange={onChangeTab} onOpenReport={onOpenReport} fixed={false} />
        </div>
      </div>
    </div>
  );
}

function AnalysisReportPage(props: {
  analysis: PolicyAnalysisResult;
  canSave: boolean;
  formData: PolicyFormData;
  loading: boolean;
  message: string;
  onBack: () => void;
  onSave: () => void;
  onUpdateOptionalResponsibility: (id: string, status: OptionalResponsibility['selectionStatus']) => void;
}) {
  const reportRef = useRef<HTMLElement | null>(null);
  const { analysis, canSave, formData, loading, message, onBack, onSave, onUpdateOptionalResponsibility } = props;
  const responsibilities = Array.isArray(analysis.coverageTable) ? analysis.coverageTable : [];
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const exportTitle = buildDraftReportTitle(formData);
  const exportControlText = getReportExportControlText();
  const exportControlTitle = getReportExportControlTitle();
  const hasReportText = Boolean(analysis.report?.trim());

  return (
    <div className="min-h-screen bg-[#F4F8FC] pb-32">
      <header className="no-print sticky top-0 z-20 flex items-center justify-between border-b border-slate-100 bg-white/90 px-4 py-4 backdrop-blur">
        <button onClick={onBack} className="-ml-2 rounded-full p-2 text-slate-700 active:bg-slate-100" type="button">
          <ChevronLeft size={24} />
        </button>
        <div className="text-center">
          <h1 className="text-lg font-black text-slate-950">保险责任</h1>
          <p className="mt-0.5 text-[11px] font-medium text-slate-400">阅读确认后保存保单</p>
        </div>
        <button
          type="button"
          onClick={() => void downloadReportPdf(reportRef.current, exportTitle)}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-600 active:bg-blue-100"
          aria-label={exportControlTitle}
          title={exportControlTitle}
        >
          <Download size={19} />
        </button>
      </header>

      <main ref={reportRef} className="print-policy-report space-y-4 p-4">
        <section className="print-only">
          <h1>保险责任解析</h1>
          <p>生成时间：{generatedAt}</p>
        </section>

        <section className="rounded-[28px] bg-gradient-to-br from-blue-600 via-sky-500 to-cyan-400 p-5 text-white shadow-[0_20px_44px_-22px_rgba(37,99,235,0.72)]">
          <p className="text-xs font-semibold text-white/75">{formData.company || '待补充保险公司'}</p>
          <h2 className="mt-2 text-[24px] font-black leading-tight">{formData.name || '未命名保单'}</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-white/15 px-4 py-3">
              <p className="text-xs text-white/70">被保人</p>
              <p className="mt-1 truncate text-base font-black">{formData.insured || '-'}</p>
            </div>
            <div className="rounded-2xl bg-white/15 px-4 py-3">
              <p className="text-xs text-white/70">责任项</p>
              <p className="mt-1 text-base font-black">{responsibilities.length} 项</p>
            </div>
          </div>
        </section>

        <section className="print-only print-policy-section">
          <h2>保单信息</h2>
          <div className="print-policy-grid">
            <p><strong>保险公司：</strong>{formData.company || '-'}</p>
            <p><strong>产品名称：</strong>{formData.name || '-'}</p>
            <p><strong>投保人：</strong>{formData.applicant || '-'}</p>
            <p><strong>受益人：</strong>{formatBeneficiaryValue(formData.beneficiary)}</p>
            <p><strong>投保人和录入人的关系：</strong>{formData.applicantRelation || '-'}</p>
            <p><strong>被保人：</strong>{formData.insured || '-'}</p>
            <p><strong>被保险人和录入人的关系：</strong>{formData.insuredRelation || '-'}</p>
            <p><strong>生效日期：</strong>{formData.date || '-'}</p>
            <p><strong>缴费期间：</strong>{formData.paymentPeriod || '-'}</p>
            <p><strong>保障期间：</strong>{formData.coveragePeriod || '-'}</p>
            <p><strong>保障额度：</strong>{formatCoverageAmount(Number(formData.amount || 0))}</p>
            <p><strong>首期保费：</strong>{formatCurrency(Number(formData.firstPremium || 0))}</p>
          </div>
        </section>

        <PolicyPlanSummary
          plans={normalizePolicyPlanList(formData.plans, formData.company)}
          effectiveDate={formData.date}
          insuredBirthday={formData.insuredBirthday}
        />

        <OptionalResponsibilityReview
          items={analysis.optionalResponsibilities}
          disabled={loading}
          onChange={onUpdateOptionalResponsibility}
        />

        {hasReportText ? (
          <section className="rounded-[24px] border border-[#DCE8F5] bg-white p-5 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-blue-600" />
              <h3 className="text-base font-black text-slate-950">保险责任说明</h3>
            </div>
            <ReportText text={analysis.report} />
          </section>
        ) : null}

        <section className="space-y-3">
          <div className="flex items-end justify-between">
            <div>
              <h3 className="text-base font-black text-slate-950">保险责任</h3>
              <p className="mt-1 text-xs text-slate-500">保存后会进入“我的保单”详情。</p>
            </div>
            <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-600">{responsibilities.length} 项</span>
          </div>

          {responsibilities.map((row, index) => (
            <article key={`${row.coverageType}-${index}`} className="rounded-[22px] border border-[#D9E6F4] bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-[#EEF6FF] text-sm font-black text-blue-600">
                  {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-lg font-black leading-7 text-slate-950">{row.coverageType || '保险责任'}</h4>
                  {row.scenario ? <p className="mt-1 whitespace-pre-wrap text-base leading-7 text-slate-500">{row.scenario}</p> : null}
                  {row.payout ? <p className="mt-2 rounded-xl bg-[#F8FBFF] px-3 py-2 text-base font-bold leading-7 text-blue-700">{row.payout}</p> : null}
                  {row.note ? <p className="mt-2 text-base leading-7 text-slate-500">{row.note}</p> : null}
                </div>
              </div>
            </article>
          ))}
        </section>

        <div className="no-print rounded-xl border border-blue-100 bg-white px-4 py-3 text-sm font-medium text-blue-700">{message}</div>
      </main>

      <div className="no-print pb-safe fixed bottom-0 left-0 right-0 z-50 border-t border-slate-100 bg-white p-4 shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.05)]">
        <div className="flex gap-3">
          <button
            onClick={() => void downloadReportPdf(reportRef.current, exportTitle)}
            type="button"
            className="flex h-12 items-center justify-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 text-sm font-bold text-blue-700 transition-transform active:scale-[0.98]"
          >
            <Download size={18} />
            {exportControlText}
          </button>
          <button
            onClick={onBack}
            type="button"
            className="h-12 flex-1 rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700 transition-transform active:scale-[0.98]"
          >
            返回修改
          </button>
          <button
            onClick={onSave}
            disabled={loading || !canSave}
            className="flex h-12 flex-[1.45] items-center justify-center gap-2 rounded-xl bg-blue-500 text-base font-bold text-white shadow-lg shadow-blue-500/30 transition-transform active:scale-[0.98] disabled:opacity-60"
          >
            <CheckCircle2 size={20} />
            {loading ? '保存中...' : '保存保单信息'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'tel';
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-bold text-slate-700">{props.label}</label>
      <input
        type={props.type || 'text'}
        inputMode={props.inputMode}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
      />
    </div>
  );
}

function OptionalResponsibilityReview({
  items = [],
  disabled = false,
  saving = false,
  title = '可选责任确认',
  description = '未投保或不确定的可选责任不会进入保障金额和现金流计算。',
  onChange,
}: {
  items?: OptionalResponsibility[];
  disabled?: boolean;
  saving?: boolean;
  title?: string;
  description?: string;
  onChange?: (id: string, status: OptionalResponsibility['selectionStatus']) => void;
}) {
  const visibleItems = (Array.isArray(items) ? items : []).filter((item) => item?.id);
  if (!visibleItems.length) return null;

  return (
    <section className="rounded-[24px] border border-amber-100 bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-amber-600" />
            <h3 className="text-base font-black text-slate-950">{title}</h3>
          </div>
          <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{description}</p>
        </div>
        <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-black text-amber-700">
          {visibleItems.length} 项
        </span>
      </div>

      <div className="mt-3 space-y-3">
        {visibleItems.map((item) => {
          const status = item.selectionStatus || 'unknown';
          return (
            <article key={item.id} className="rounded-[18px] border border-slate-100 bg-slate-50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black leading-6 text-slate-900">
                    {item.liability || item.coverageType || '可选责任'}
                  </p>
                  <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">
                    {[item.productName, item.coverageType].filter(Boolean).join(' · ') || '产品责任'}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-slate-600 ring-1 ring-slate-200">
                    {optionalResponsibilityEvidenceLabel(item.selectionEvidence)}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${
                    status === 'selected'
                      ? 'bg-emerald-50 text-emerald-700'
                      : status === 'not_selected'
                        ? 'bg-slate-100 text-slate-600'
                        : 'bg-amber-50 text-amber-700'
                  }`}>
                    {optionalResponsibilityStatusLabel(status)}
                  </span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-slate-600 ring-1 ring-slate-200">
                    量化状态：{optionalResponsibilityQuantificationLabel(item.quantificationStatus)}
                  </span>
                </div>
              </div>
              {item.sourceExcerpt ? (
                <p className="mt-2 line-clamp-2 text-xs font-medium leading-5 text-slate-500">{item.sourceExcerpt}</p>
              ) : null}
              {optionalResponsibilityHasQuantificationGap(item) ? (
                <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-black leading-5 text-amber-700 ring-1 ring-amber-100">
                  该可选责任已确认投保，但尚未完成指标量化，暂不进入家庭报告计算。
                </p>
              ) : null}
              {onChange ? (
                <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label={`${item.liability || item.coverageType || '可选责任'}投保状态`}>
                  {OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS.map((option) => {
                    const active = status === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={disabled || saving}
                        onClick={() => onChange(item.id, option.value)}
                        className={`h-9 rounded-xl px-2 text-xs font-black transition-colors disabled:opacity-50 ${
                          active
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'bg-white text-slate-600 ring-1 ring-slate-200 active:bg-blue-50'
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PolicyPlanEditor(props: {
  company: string;
  plans: NonNullable<PolicyFormData['plans']>;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, key: string, value: string) => void;
}) {
  const { company, plans, onAdd, onRemove, onUpdate } = props;
  const editablePlans = plans
    .map((plan, originalIndex) => ({ ...plan, originalIndex }))
    .filter((plan) => String(plan.role || '') !== 'main');
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-4 space-y-3">
        <h3 className="text-sm font-black text-slate-900">险种明细</h3>
        <p className="text-xs font-medium leading-5 text-slate-500">附加险或万能账户会按保险公司分别匹配产品。</p>
        <button
          className="flex h-11 w-full items-center justify-center rounded-xl bg-blue-500 px-4 text-sm font-black text-white shadow-lg shadow-blue-500/20 active:bg-blue-600"
          type="button"
          onClick={onAdd}
        >
          手动添加附加险
        </button>
      </div>

      {editablePlans.length ? (
        <div className="space-y-3">
          {editablePlans.map((plan) => (
            <article key={`${plan.name}-${plan.originalIndex}`} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-slate-600 ring-1 ring-slate-200">
                  {normalizePolicyPlanRoleLabel(String(plan.role || ''))}
                </span>
                {editablePlans.length > 0 ? (
                  <button className="text-xs font-black text-red-500" type="button" onClick={() => onRemove(plan.originalIndex)}>
                    删除
                  </button>
                ) : null}
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <SelectField
                    label="类型"
                    value={String(plan.role || '')}
                    onChange={(value) => onUpdate(plan.originalIndex, 'role', value)}
                    options={[
                      { value: 'rider', label: '附加险' },
                      { value: 'linked_account', label: '万能账户' },
                      { value: 'unknown', label: '未分类' },
                    ]}
                    placeholder="请选择"
                  />
                  <TextField label="产品分类" value={String(plan.productType || '')} onChange={(value) => onUpdate(plan.originalIndex, 'productType', value)} placeholder="如 年金险" />
                </div>
                <TextField label="险种名称" value={String(plan.name || '')} onChange={(value) => onUpdate(plan.originalIndex, 'name', value)} placeholder="保单上的险种全称" />
                {plan.matchedProductName ? (
                  <p className="rounded-xl bg-white px-3 py-2 text-xs font-bold leading-5 text-blue-700 ring-1 ring-blue-100">
                    已按 {plan.company || company || '保险公司'} 匹配：{plan.matchedProductName}
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <TextField label="保额 (元)" value={String(plan.amount || '')} onChange={(value) => onUpdate(plan.originalIndex, 'amount', value)} inputMode="decimal" placeholder="0.00" />
                  <TextField label="保费 (元)" value={String(plan.premium || '')} onChange={(value) => onUpdate(plan.originalIndex, 'premium', value)} inputMode="decimal" placeholder="0.00" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <TextField label="保障期间" value={String(plan.coveragePeriod || '')} onChange={(value) => onUpdate(plan.originalIndex, 'coveragePeriod', value)} placeholder="如 终身" />
                  <TextField label="缴费期间" value={String(plan.paymentPeriod || '')} onChange={(value) => onUpdate(plan.originalIndex, 'paymentPeriod', value)} placeholder="如 10年交" />
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <article className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm font-medium leading-6 text-slate-500">
          附加险或万能账户为可选项；如保单包含但 OCR 未带出，可点击上方按钮补充。
        </article>
      )}
    </section>
  );
}

function PolicyPlanSummary({
  plans,
  effectiveDate,
  insuredBirthday,
}: {
  plans: NonNullable<PolicyFormData['plans']>;
  effectiveDate?: string;
  insuredBirthday?: string;
}) {
  const visiblePlans = normalizePolicyPlanList(plans);
  if (!visiblePlans.length) return null;
  return (
    <section className="mt-4 rounded-[22px] border border-[#D9E6F4] bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-base font-black text-slate-950">险种明细</h3>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-600">{visiblePlans.length} 个险种</span>
      </div>
      <div className="space-y-3">
        {visiblePlans.map((plan, index) => {
          const validityStatus = resolvePolicyValidityStatus(plan.coveragePeriod, {
            effectiveDate,
            insuredBirthday,
          });
          const validityStatusClassName = policyValidityClassName(validityStatus.tone);
          return (
            <article key={`${planProductDisplayName(plan)}-${index}`} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <h4 className="min-w-0 flex-1 break-words text-sm font-black leading-5 text-slate-900">{planProductDisplayName(plan)}</h4>
                <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-slate-600 ring-1 ring-slate-200">
                  {normalizePolicyPlanRoleLabel(String(plan.role || ''))}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs font-bold leading-5 text-slate-500">
                <p>分类：{plan.productType || '-'}</p>
                <p>保额：{formatCoverageAmount(Number(plan.amount || 0))}</p>
                <p>保费：{formatCurrency(Number(plan.premium || 0))}</p>
                <p>期间：{plan.coveragePeriod || '-'}</p>
                <p>缴费：{plan.paymentPeriod || plan.paymentMode || '-'}</p>
                <p>
                  状态：
                  <span className={`ml-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-black ring-1 ${validityStatusClassName}`}>
                    {validityStatus.label}
                  </span>
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SelectField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<string | { value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-bold text-slate-700">{props.label}</label>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 focus:border-blue-500 focus:ring-blue-500"
      >
        <option value="">{props.placeholder || '请选择'}</option>
        {props.options.map((option) => {
          const normalizedOption = typeof option === 'string' ? { value: option, label: option } : option;
          return (
          <option key={normalizedOption.value} value={normalizedOption.value}>
            {normalizedOption.label || normalizedOption.value}
          </option>
          );
        })}
      </select>
    </div>
  );
}

function PolicyDetailSheet({
  policy,
  onClose,
  onRetryReport,
  retrying = false,
  onUpdatePolicy,
  onUpdateOptionalResponsibility,
  updating = false,
  onDeletePolicy,
  deleting = false,
  onEditCashValue,
}: {
  policy: Policy;
  onClose: () => void;
  onRetryReport?: (policy: Policy) => void | Promise<void>;
  retrying?: boolean;
  onUpdatePolicy?: (policy: Policy, data: PolicyFormData) => Promise<{ reportRegenerating: boolean } | void>;
  onUpdateOptionalResponsibility?: (policy: Policy, id: string, status: OptionalResponsibility['selectionStatus']) => void | Promise<void>;
  updating?: boolean;
  onDeletePolicy?: (policy: Policy) => void | Promise<void>;
  deleting?: boolean;
  onEditCashValue?: (policy: Policy) => void;
}) {
  const reportRef = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const exportTitle = buildPolicyReportTitle(policy);
  const reportGenerating = isPolicyReportGenerating(policy);
  const reportFailed = isPolicyReportFailed(policy);
  const responsibilities = Array.isArray(policy.responsibilities) ? policy.responsibilities : [];
  const optionalResponsibilities = Array.isArray(policy.optionalResponsibilities) ? policy.optionalResponsibilities : [];
  const exportControlTitle = getReportExportControlTitle();
  const cashValueSummary = summarizeCashValues(policy.cashValues);
  const responsibilitySourceLinks = getPolicyResponsibilitySourceLinks(policy);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-slate-50">
      <header className="no-print sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-4">
        <button onClick={onClose} className="-ml-2 rounded-full p-2 text-slate-700 active:bg-slate-100" type="button">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-lg font-bold">保单详情</h1>
        <div className="flex items-center gap-2">
          {onUpdatePolicy ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={updating || deleting}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600 active:bg-slate-200 disabled:text-slate-300"
              aria-label="修改保单"
              title="修改保单"
            >
              <Pencil size={18} />
            </button>
          ) : null}
          {onDeletePolicy ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={updating || deleting}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600 active:bg-red-100 disabled:text-red-200"
              aria-label="删除保单"
              title="删除保单"
            >
              <Trash2 size={18} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void downloadReportPdf(reportRef.current, exportTitle)}
            disabled={reportGenerating}
            className={`flex h-10 w-10 items-center justify-center rounded-full active:bg-blue-100 ${
              reportGenerating ? 'bg-slate-100 text-slate-300' : 'bg-blue-50 text-blue-600'
            }`}
            aria-label={exportControlTitle}
            title={exportControlTitle}
          >
            <Download size={19} />
          </button>
        </div>
      </header>
      <main ref={reportRef} className="print-policy-report flex-1 overflow-y-auto p-4 pb-10">
        <section className="print-only">
          <h1>保单解析报告</h1>
          <p>生成时间：{generatedAt}</p>
        </section>

        <section className="rounded-[28px] bg-gradient-to-br from-blue-600 to-cyan-500 p-5 text-white shadow-[0_18px_40px_-18px_rgba(37,99,235,0.75)]">
          <p className="text-xs font-semibold text-white/70">{policy.company}</p>
          <h2 className="mt-2 text-2xl font-black leading-tight">{policy.name}</h2>
          {policy.report?.trim() ? (
            <div className="mt-3">
              <ReportText text={policy.report} compact inverted />
            </div>
          ) : (
            <p className="mt-3 text-sm font-semibold leading-6 text-white/85">{getReportPlaceholder(policy)}</p>
          )}
        </section>

        {onUpdatePolicy || onDeletePolicy ? (
          <section className="no-print mt-4 grid grid-cols-2 gap-3">
            {onUpdatePolicy ? (
              <button
                className="flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-500 text-sm font-black text-white shadow-lg shadow-blue-500/20 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
                type="button"
                onClick={() => setEditing(true)}
                disabled={updating || deleting}
              >
                <Pencil size={18} />
                修改保单
              </button>
            ) : null}
            {onDeletePolicy ? (
              <button
                className="flex h-12 items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 text-sm font-black text-red-600 transition-colors hover:bg-red-100 disabled:text-red-200"
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={updating || deleting}
              >
                <Trash2 size={18} />
                删除保单
              </button>
            ) : null}
          </section>
        ) : null}

        {reportGenerating || reportFailed ? (
          <section className={`mt-4 rounded-[22px] border px-4 py-3 ${
            reportFailed ? 'border-red-100 bg-red-50 text-red-700' : 'border-orange-100 bg-orange-50 text-orange-700'
          }`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black">{reportFailed ? '报告生成失败' : '报告正在后台生成'}</p>
                <p className="mt-1 text-xs font-medium leading-5">
                  {reportFailed ? policy.reportError || '可以稍后刷新查看，或重新生成报告。' : '保单信息已经保存，完整保险责任生成后会自动刷新。'}
                </p>
              </div>
              {reportFailed && onRetryReport ? (
                <button
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-60"
                  type="button"
                  disabled={retrying}
                  onClick={() => void onRetryReport(policy)}
                >
                  <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} />
                  {retrying ? '提交中' : '重新生成报告'}
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className="mt-4 grid grid-cols-2 gap-3">
          <MetricBox label="被保人" value={policy.insured || '-'} />
          <MetricBox label="投保人" value={policy.applicant || '-'} />
          <MetricBox label="受益人" value={formatBeneficiaryValue(policy.beneficiary)} />
          <MetricBox label="被保人生日" value={policy.insuredBirthday || '-'} />
          <MetricBox label="保单生效日期" value={formatDateLabel(policy.date)} />
          <MetricBox label="投保人关系" value={policy.applicantRelation || '-'} />
          <MetricBox label="被保人关系" value={policy.insuredRelation || '-'} />
        </section>

        {cashValueSummary || onEditCashValue ? (
          <section className={`mt-4 rounded-[22px] border px-4 py-3 ${
            cashValueSummary ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-blue-100 bg-blue-50 text-blue-800'
          }`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black">保单现金价值</p>
                <p className="mt-1 text-xs font-semibold leading-5">
                  {cashValueSummary
                    ? `已录入 ${cashValueSummary.count} 年现金价值，首年 ${formatCurrency(cashValueSummary.first.cashValue)}，${cashValueSummary.last.policyYear}年末 ${formatCurrency(cashValueSummary.last.cashValue)}。`
                    : '未录入现金价值。'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {cashValueSummary ? (
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-emerald-700">
                    已入库
                  </span>
                ) : null}
                {onEditCashValue ? (
                  <button
                    type="button"
                    className="no-print rounded-full bg-white px-3 py-1.5 text-xs font-black text-blue-700 ring-1 ring-blue-100 active:bg-blue-50"
                    onClick={() => onEditCashValue(policy)}
                  >
                    {cashValueSummary ? '修改现金价值' : '录入现金价值'}
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        <section className="print-only print-policy-section">
          <h2>保单信息</h2>
          <div className="print-policy-grid">
            <p><strong>保险公司：</strong>{policy.company || '-'}</p>
            <p><strong>产品名称：</strong>{policy.name || '-'}</p>
            <p><strong>投保人：</strong>{policy.applicant || '-'}</p>
            <p><strong>受益人：</strong>{formatBeneficiaryValue(policy.beneficiary)}</p>
            <p><strong>投保人和录入人的关系：</strong>{policy.applicantRelation || '-'}</p>
            <p><strong>被保人：</strong>{policy.insured || '-'}</p>
            <p><strong>被保险人和录入人的关系：</strong>{policy.insuredRelation || '-'}</p>
            <p><strong>被保险人生日：</strong>{policy.insuredBirthday || '-'}</p>
            <p><strong>生效日期：</strong>{policy.date || '-'}</p>
            <p><strong>缴费期间：</strong>{policy.paymentPeriod || '-'}</p>
            <p><strong>保障期间：</strong>{policy.coveragePeriod || '-'}</p>
            <p><strong>保障额度：</strong>{formatCoverageAmount(Number(policy.amount || 0))}</p>
            <p><strong>首期保费：</strong>{formatCurrency(Number(policy.firstPremium || 0))}</p>
          </div>
        </section>

        <PolicyPlanSummary
          plans={normalizePolicyPlanList(policy.plans, policy.company)}
          effectiveDate={policy.date}
          insuredBirthday={policy.insuredBirthday}
        />

        {optionalResponsibilities.length ? (
          <div className="mt-4">
            <OptionalResponsibilityReview
              items={optionalResponsibilities}
              disabled={updating || deleting}
              saving={updating}
              onChange={onUpdateOptionalResponsibility ? (id, status) => void onUpdateOptionalResponsibility(policy, id, status) : undefined}
              description="未投保或不确定的可选责任不会进入当前保单和家庭报告的量化计算。"
            />
          </div>
        ) : null}

        <section className="mt-4 space-y-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">保险责任</h3>
            <p className="mt-1 text-xs text-slate-500">以下内容来自本次 OCR 识别和责任解析。</p>
          </div>
          {responsibilitySourceLinks.length ? (
            <div className="rounded-[18px] border border-blue-100 bg-blue-50/70 px-3 py-3">
              <p className="text-xs font-black text-blue-700">官网地址</p>
              <div className="mt-2 space-y-2">
                {responsibilitySourceLinks.map((source) => (
                  <a
                    key={`${source.title}-${source.url}`}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold leading-5 text-blue-700 ring-1 ring-blue-100"
                  >
                    <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate font-black">{source.title || formatSourceUrlHost(source.url)}</span>
                      <span className="block break-all text-blue-500">{source.url}</span>
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ) : null}
          {responsibilities.length ? (
            responsibilities.map((row, index) => (
              <article key={`${row.coverageType}-${index}`} className="rounded-[22px] border border-[#D9E6F4] bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-blue-50 text-blue-600">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-lg font-bold leading-7 text-slate-900">{row.coverageType}</h4>
                    <p className="mt-1 whitespace-pre-wrap text-base leading-7 text-slate-500">{row.scenario}</p>
                    <p className="mt-2 rounded-xl bg-[#F8FBFF] px-3 py-2 text-base font-bold leading-7 text-blue-700">{row.payout}</p>
                    {row.note ? <p className="mt-2 text-base leading-7 text-slate-500">{row.note}</p> : null}
                  </div>
                </div>
              </article>
            ))
          ) : (
            <article className="rounded-[22px] border border-dashed border-[#D9E6F4] bg-white p-4 text-sm leading-6 text-slate-500">
              {reportGenerating ? '正在生成完整保险责任解析，请稍后。' : '暂无保险责任解析。'}
            </article>
          )}
        </section>

        <details className="no-print mt-4 rounded-xl border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">查看原始 OCR 文本</summary>
          <pre className="mt-3 whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">{policy.ocrText || '暂无 OCR 原文'}</pre>
        </details>
      </main>
      {editing && onUpdatePolicy ? (
        <PolicyEditDialog
          policy={policy}
          loading={updating}
          onClose={() => setEditing(false)}
          onSave={async (nextData) => {
            const result = await onUpdatePolicy(policy, nextData);
            if (result?.reportRegenerating) {
              setEditing(false);
              return;
            }
            setEditing(false);
          }}
        />
      ) : null}
      {confirmingDelete && onDeletePolicy ? (
        <PolicyDeleteDialog
          policy={policy}
          loading={deleting}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={() => void onDeletePolicy(policy)}
        />
      ) : null}
    </div>
  );
}

function PolicyEditDialog({
  policy,
  loading,
  onClose,
  onSave,
}: {
  policy: Policy;
  loading: boolean;
  onClose: () => void;
  onSave: (data: PolicyFormData) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PolicyFormData>(() => policyToForm(policy));
  const [companyFocused, setCompanyFocused] = useState(false);
  const [productFocused, setProductFocused] = useState(false);
  const [editCompanySuggestions, setEditCompanySuggestions] = useState<PolicyCompanySuggestion[]>([]);
  const [editCompanySuggestionLoading, setEditCompanySuggestionLoading] = useState(false);
  const [editProductSuggestions, setEditProductSuggestions] = useState<PolicyProductSuggestion[]>([]);
  const [editProductSuggestionLoading, setEditProductSuggestionLoading] = useState(false);
  const updateDraft = (key: keyof PolicyFormData, value: string) => {
    setDraft((current) => ({ ...current, [key]: key === 'amount' || key === 'firstPremium' ? sanitizeAmount(value) : value }));
  };
  const canSave = Boolean(draft.company.trim() && draft.name.trim());
  const companyQuery = draft.company.trim();
  const productQuery = draft.name.trim();
  const visibleCompanySuggestions = useMemo(() => {
    const normalizedQuery = normalizeSuggestionQuery(companyQuery);
    if (!normalizedQuery) return [];
    return editCompanySuggestions
      .map((suggestion) => {
        const normalizedCompany = normalizeSuggestionQuery(suggestion.company);
        return {
          ...suggestion,
          matchIndex: normalizedCompany.indexOf(normalizedQuery),
          startsWith: normalizedCompany.startsWith(normalizedQuery),
        };
      })
      .filter((suggestion) => suggestion.matchIndex >= 0 && suggestion.company !== companyQuery)
      .sort(
        (left, right) =>
          Number(right.startsWith) - Number(left.startsWith) ||
          left.matchIndex - right.matchIndex ||
          Number(right.recordCount || 0) - Number(left.recordCount || 0) ||
          left.company.localeCompare(right.company, 'zh-CN'),
      )
      .slice(0, 8);
  }, [companyQuery, editCompanySuggestions]);
  const visibleProductSuggestions = useMemo(() => {
    const normalizedCompany = normalizeSuggestionQuery(companyQuery);
    const normalizedQuery = normalizeSuggestionQuery(productQuery);
    if (!normalizedCompany) return [];
    return editProductSuggestions
      .map((suggestion) => {
        const normalizedSuggestionCompany = normalizeSuggestionQuery(suggestion.company);
        const normalizedProduct = normalizeSuggestionQuery(suggestion.productName);
        return {
          ...suggestion,
          companyMatches:
            normalizedSuggestionCompany === normalizedCompany ||
            normalizedSuggestionCompany.includes(normalizedCompany) ||
            normalizedCompany.includes(normalizedSuggestionCompany),
          matchIndex: normalizedQuery ? normalizedProduct.indexOf(normalizedQuery) : 0,
          startsWith: normalizedQuery ? normalizedProduct.startsWith(normalizedQuery) : true,
        };
      })
      .filter((suggestion) => suggestion.companyMatches && (!normalizedQuery || suggestion.matchIndex >= 0) && suggestion.productName !== productQuery)
      .sort(
        (left, right) =>
          Number(right.startsWith) - Number(left.startsWith) ||
          left.matchIndex - right.matchIndex ||
          Number(right.recordCount || 0) - Number(left.recordCount || 0) ||
          left.productName.localeCompare(right.productName, 'zh-CN'),
      )
      .slice(0, 8);
  }, [companyQuery, editProductSuggestions, productQuery]);
  const showCompanySuggestions = companyFocused && companyQuery && (editCompanySuggestionLoading || visibleCompanySuggestions.length);
  const showProductSuggestions = productFocused && companyQuery && (editProductSuggestionLoading || visibleProductSuggestions.length);

  useEffect(() => {
    let cancelled = false;
    setEditCompanySuggestionLoading(true);
    listPolicyResponsibilityCompanySuggestions({ limit: 50 })
      .then((payload) => {
        if (!cancelled) setEditCompanySuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
      })
      .catch(() => {
        if (!cancelled) setEditCompanySuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setEditCompanySuggestionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const company = draft.company.trim();
    const q = draft.name.trim();
    if (!company) {
      setEditProductSuggestions([]);
      setEditProductSuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setEditProductSuggestionLoading(true);
      listPolicyResponsibilityProductSuggestions({ company, q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setEditProductSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setEditProductSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setEditProductSuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft.company, draft.name]);

  return (
    <div className="fixed inset-0 z-[80] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="max-h-[88vh] w-full overflow-y-auto rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-black text-slate-950">修改保单</h2>
            <p className="mt-1 text-xs font-bold leading-5 text-slate-500">修改保险公司或产品名称后会重新生成保险责任。</p>
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
            aria-label="关闭修改"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <label className="relative block">
            <span className="mb-1.5 block text-sm font-bold text-slate-700">保险公司</span>
            <input
              value={draft.company}
              onChange={(event) => updateDraft('company', event.target.value)}
              onFocus={() => setCompanyFocused(true)}
              onBlur={() => window.setTimeout(() => setCompanyFocused(false), 120)}
              placeholder="输入保险公司，可模糊匹配"
              autoComplete="off"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
            />
            {showCompanySuggestions ? (
              <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="修改保险公司候选">
                {editCompanySuggestionLoading ? (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载保险公司
                  </div>
                ) : (
                  visibleCompanySuggestions.map((suggestion) => (
                    <button
                      key={suggestion.company}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDraft((current) => ({ ...current, company: suggestion.company }));
                        setCompanyFocused(false);
                      }}
                    >
                      <span className="min-w-0 truncate">{renderHighlightedSuggestion(suggestion.company, companyQuery)}</span>
                      <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </label>
          <label className="relative block">
            <span className="mb-1.5 block text-sm font-bold text-slate-700">保险产品</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft('name', event.target.value)}
              onFocus={() => setProductFocused(true)}
              onBlur={() => window.setTimeout(() => setProductFocused(false), 120)}
              placeholder="输入保险产品，可模糊匹配"
              autoComplete="off"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
            />
            {showProductSuggestions ? (
              <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="修改保险产品候选">
                {editProductSuggestionLoading ? (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载保险产品
                  </div>
                ) : (
                  visibleProductSuggestions.map((suggestion) => (
                    <button
                      key={`${suggestion.company}-${suggestion.productName}`}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          company: suggestion.company,
                          name: suggestion.productName,
                        }));
                        setProductFocused(false);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{renderHighlightedSuggestion(suggestion.productName, productQuery)}</span>
                        <span className="mt-0.5 block truncate text-[11px] font-bold text-slate-400">{suggestion.company}</span>
                      </span>
                      <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="投保人" value={draft.applicant} onChange={(value) => updateDraft('applicant', value)} placeholder="投保人姓名" />
            <TextField label="被保人" value={draft.insured} onChange={(value) => updateDraft('insured', value)} placeholder="被保人姓名" />
          </div>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm font-bold text-slate-700">法定受益人</span>
              <input
                type="checkbox"
                checked={draft.beneficiary === '法定'}
                onChange={(event) => updateDraft('beneficiary', event.target.checked ? '法定' : '')}
                className="h-5 w-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
            </label>
            {draft.beneficiary === '法定' ? (
              <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700">受益人：法定</div>
            ) : (
              <TextField label="受益人姓名" value={draft.beneficiary} onChange={(value) => updateDraft('beneficiary', value)} placeholder="请输入受益人姓名" />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <SelectField label="投保人关系" value={draft.applicantRelation} onChange={(value) => updateDraft('applicantRelation', value)} options={POLICY_RELATION_OPTIONS} />
            <SelectField label="被保人关系" value={draft.insuredRelation} onChange={(value) => updateDraft('insuredRelation', value)} options={POLICY_RELATION_OPTIONS} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="身份证号" value={draft.insuredIdNumber || ''} onChange={(value) => updateDraft('insuredIdNumber', value)} placeholder="被保人证件号" />
            <TextField label="被保人生日" type="date" value={draft.insuredBirthday || ''} onChange={(value) => updateDraft('insuredBirthday', value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="生效日期" type="date" value={draft.date} onChange={(value) => updateDraft('date', value)} />
            <TextField label="保障期间" value={draft.coveragePeriod} onChange={(value) => updateDraft('coveragePeriod', value)} placeholder="如 终身" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="缴费期间" value={draft.paymentPeriod} onChange={(value) => updateDraft('paymentPeriod', value)} placeholder="如 10年交" />
            <TextField label="首期保费 (元)" value={draft.firstPremium} onChange={(value) => updateDraft('firstPremium', value)} inputMode="decimal" placeholder="0.00" />
          </div>
          <TextField label="保障额度 (元)" value={draft.amount} onChange={(value) => updateDraft('amount', value)} inputMode="decimal" placeholder="0.00" />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            className="flex h-12 items-center justify-center rounded-xl bg-slate-100 text-sm font-black text-slate-600 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-500 text-sm font-black text-white shadow-lg shadow-blue-500/25 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
            type="button"
            disabled={loading || !canSave}
            onClick={() => void onSave(draft)}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            保存
          </button>
        </div>
      </section>
    </div>
  );
}

function PolicyDeleteDialog({
  policy,
  loading,
  onClose,
  onConfirm,
}: {
  policy: Policy;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[85] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-red-600">
            <Trash2 size={21} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-black text-slate-950">删除保单</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-slate-500">{policy.name}</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            className="flex h-12 items-center justify-center rounded-xl bg-slate-100 text-sm font-black text-slate-600 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-black text-white shadow-lg shadow-red-600/20 disabled:bg-red-200 disabled:shadow-none"
            type="button"
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
            删除
          </button>
        </div>
      </section>
    </div>
  );
}
