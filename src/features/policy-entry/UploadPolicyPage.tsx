import {
  type ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Camera,
  CheckCircle2,
  ChevronLeft,
  CircleUserRound,
  Copy,
  Download,
  Loader2,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import type { FamilyMember, FamilyProfile } from '../../api/contracts/family';
import type {
  PolicyAnalysisResult,
  PolicyFormData,
  PolicyKnowledgeMatch,
  UploadItem,
} from '../../api/contracts/policy';
import type {
  OptionalResponsibility,
  PolicyCompanySuggestion,
  PolicyProductSuggestion,
} from '../../api/contracts/responsibility';
import {
  downloadReportPdf,
  getReportExportControlText,
  getReportExportControlTitle,
} from '../../features/report-export/report-export';
import {
  areSameParticipantName,
  formatBeneficiaryValue,
  formatCoverageAmount,
  formatCurrency,
  maskMobile,
} from '../../shared/formatters';
import {
  ReportText,
  ResponsibilityCardList,
  buildDraftReportTitle,
  getVisibleResponsibilityCards,
} from '../../shared/policy-report-ui';
import {
  FAMILY_MEMBER_RELATION_OPTIONS,
  normalizePolicyPlanList,
  sanitizeAmount,
} from '../../shared/customer-policy-form';
import {
  CoveragePeriodField,
  PaymentPeriodField,
  OptionalResponsibilityReview,
  PolicyPlanEditor,
  PolicyPlanSummary,
  SelectField,
  TextField,
  getWechatUploadLabel,
  normalizeSuggestionQuery,
  optionalResponsibilitiesForProduct,
  renderHighlightedSuggestion,
} from '../../shared/customer-policy-components';
import { CustomerBottomTabs } from '../customer-navigation/CustomerBottomTabs';

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

function requiredFieldLabel(label: string) {
  return (
    <span className="mb-1.5 block text-sm font-bold text-slate-700">
      <span className="mr-1 text-red-500">*</span>
      {label}
    </span>
  );
}


export function UploadPolicyPage(props: {
  canSubmit: boolean;
  familyProfiles: FamilyProfile[];
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  formData: PolicyFormData;
  formCompanySuggestionLoading: boolean;
  formCompanySuggestions: PolicyCompanySuggestion[];
  formProductSuggestionLoading: boolean;
  formProductSuggestions: PolicyProductSuggestion[];
  formPlanProductSuggestionLoading: boolean;
  formPlanProductSuggestions: PolicyProductSuggestion[];
  formPlanProductSuggestionTargetIndex: number | null;
  isLoggedIn: boolean;
  loading: boolean;
  message: string;
  mobile: string;
  ocrText: string;
  ocrWarnings?: string[];
  productMatchLoading: boolean;
  productMatchMessage: string;
  productMatches: PolicyKnowledgeMatch[];
  optionalResponsibilities?: OptionalResponsibility[];
  selectedFamilyId: number | null;
  selectedFamilyMembers: FamilyMember[];
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onCreateFamily: () => void;
  onOcrTextChange: (value: string) => void;
  onOpenAccount: () => void;
  onOpenFamilies: () => void;
  onScanClick: () => void;
  onSelectFamily: (familyId: number | null) => void;
  onSelectFormCompany: (company: string) => void;
  onSelectFormProduct: (suggestion: PolicyProductSuggestion) => void;
  onSelectPlanProduct: (index: number, suggestion: PolicyProductSuggestion) => void;
  onSelectProductMatch: (match: PolicyKnowledgeMatch) => void;
  onSubmit: () => void;
  onAddPlan: () => void;
  onRemovePlan: (index: number) => void;
  onUpdatePlan: (index: number, key: string, value: string) => void;
  onUpdatePlanProductQuery: (index: number, company: string, q: string) => void;
  onUpdateForm: (key: keyof PolicyFormData, value: PolicyFormData[keyof PolicyFormData]) => void;
  onUpdateOptionalResponsibility: (id: string, status: OptionalResponsibility['selectionStatus']) => void;
  uploadItem: UploadItem | null;
  staleClientDetected?: boolean;
  onReloadForLatestVersion?: () => void;
}) {
  const {
    canSubmit,
    familyProfiles,
    fileInputRef,
    formData,
    formCompanySuggestionLoading,
    formCompanySuggestions,
    formProductSuggestionLoading,
    formProductSuggestions,
    formPlanProductSuggestionLoading,
    formPlanProductSuggestions,
    formPlanProductSuggestionTargetIndex,
    isLoggedIn,
    loading,
    message,
    mobile,
    ocrText,
    ocrWarnings = [],
    productMatchLoading,
    productMatchMessage,
    productMatches,
    optionalResponsibilities = [],
    selectedFamilyId,
    selectedFamilyMembers,
    onFileChange,
    onCreateFamily,
    onOcrTextChange,
    onOpenAccount,
    onOpenFamilies,
    onScanClick,
    onSelectFamily,
    onSelectFormCompany,
    onSelectFormProduct,
    onSelectPlanProduct,
    onSelectProductMatch,
    onSubmit,
    onAddPlan,
    onRemovePlan,
    onUpdatePlan,
    onUpdatePlanProductQuery,
    onUpdateForm,
    onUpdateOptionalResponsibility,
    uploadItem,
    staleClientDetected = false,
    onReloadForLatestVersion,
  } = props;
  const [ocrCopyMessage, setOcrCopyMessage] = useState('');
  const [companyFocused, setCompanyFocused] = useState(false);
  const [productFocused, setProductFocused] = useState(false);
  const companyQuery = formData.company.trim();
  const productQuery = formData.name.trim();
  const selectedFamily = familyProfiles.find((family) => Number(family.id) === Number(selectedFamilyId)) || null;
  const visibleCompanySuggestions = useMemo(() => {
    const normalizedQuery = normalizeSuggestionQuery(companyQuery);
    if (!normalizedQuery) return [];
    return (Array.isArray(formCompanySuggestions) ? formCompanySuggestions : [])
      .filter((suggestion) => normalizeSuggestionQuery(suggestion.company) !== normalizedQuery)
      .slice(0, 8);
  }, [companyQuery, formCompanySuggestions]);
  const visibleProductSuggestions = useMemo(() => {
    if (!normalizeSuggestionQuery(companyQuery)) return [];
    return (Array.isArray(formProductSuggestions) ? formProductSuggestions : [])
      .slice(0, 8);
  }, [companyQuery, formProductSuggestions]);
  const showCompanySuggestions = companyFocused && companyQuery && (formCompanySuggestionLoading || visibleCompanySuggestions.length);
  const showProductSuggestions = productFocused && companyQuery && (formProductSuggestionLoading || visibleProductSuggestions.length);

  function findSingleFamilyMemberByName(name: string) {
    const normalizedName = name.trim();
    if (!normalizedName) return null;
    const matches = selectedFamilyMembers.filter((member) => (
      member.status === 'active' &&
      member.name.trim() === normalizedName
    ));
    return matches.length === 1 ? matches[0] : null;
  }

  function relationForFamilyMember(member: FamilyMember) {
    if (Number(member.id) === Number(selectedFamily?.coreMemberId || 0)) return '本人';
    return member.relationLabel || '待确认';
  }

  function applyParticipantMember(kind: 'applicant' | 'insured', member: FamilyMember | null) {
    const memberIdKey = kind === 'applicant' ? 'applicantMemberId' : 'insuredMemberId';
    const birthdayKey = kind === 'applicant' ? 'applicantBirthday' : 'insuredBirthday';
    if (!member) {
      if (formData[memberIdKey]) onUpdateForm(memberIdKey, null);
      return;
    }
    if (Number(formData[memberIdKey] || 0) !== Number(member.id)) onUpdateForm(memberIdKey, member.id);
    applyParticipantRelation(kind, relationForFamilyMember(member));
    if (member.birthday && !String(formData[birthdayKey] || '').trim()) onUpdateForm(birthdayKey, member.birthday);
  }

  useEffect(() => {
    if (!participantsAreSamePerson()) return;
    const applicantRelation = participantRelation('applicant');
    const insuredRelation = participantRelation('insured');
    const nextRelation = resolveSamePersonRelation(applicantRelation, insuredRelation);
    if (!nextRelation) return;
    if (applicantRelation !== nextRelation) applyParticipantRelation('applicant', nextRelation);
    if (insuredRelation !== nextRelation) applyParticipantRelation('insured', nextRelation);
  }, [
    formData.applicant,
    formData.insured,
    formData.applicantRelation,
    formData.applicantRelationLabel,
    formData.insuredRelation,
    formData.insuredRelationLabel,
    onUpdateForm,
  ]);

  useEffect(() => {
    applyParticipantMember('applicant', findSingleFamilyMemberByName(formData.applicant || ''));
    applyParticipantMember('insured', findSingleFamilyMemberByName(formData.insured || ''));
  }, [
    formData.applicant,
    formData.insured,
    formData.applicantMemberId,
    formData.insuredMemberId,
    selectedFamily?.coreMemberId,
    selectedFamilyMembers,
  ]);

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

  function updateParticipantName(kind: 'applicant' | 'insured', value: string) {
    const nameKey = kind === 'applicant' ? 'applicant' : 'insured';
    onUpdateForm(nameKey, value);
  }

  function participantRelation(kind: 'applicant' | 'insured') {
    if (kind === 'applicant') return formData.applicantRelationLabel || formData.applicantRelation || '待确认';
    return formData.insuredRelationLabel || formData.insuredRelation || '待确认';
  }

  function applyParticipantRelation(kind: 'applicant' | 'insured', value: string) {
    const relation = value || '待确认';
    if (kind === 'applicant') {
      if (formData.applicantRelationLabel !== relation) onUpdateForm('applicantRelationLabel', relation);
      if (formData.applicantRelation !== relation) onUpdateForm('applicantRelation', relation);
      return;
    }
    if (formData.insuredRelationLabel !== relation) onUpdateForm('insuredRelationLabel', relation);
    if (formData.insuredRelation !== relation) onUpdateForm('insuredRelation', relation);
  }

  function participantsAreSamePerson() {
    return areSameParticipantName(formData.applicant, formData.insured);
  }

  function resolveSamePersonRelation(applicantRelation: string, insuredRelation: string) {
    if (applicantRelation === insuredRelation) return applicantRelation;
    if (applicantRelation === '本人' || insuredRelation === '本人') return '本人';
    if (applicantRelation && applicantRelation !== '待确认' && (!insuredRelation || insuredRelation === '待确认')) return applicantRelation;
    if (insuredRelation && insuredRelation !== '待确认' && (!applicantRelation || applicantRelation === '待确认')) return insuredRelation;
    if (!applicantRelation && insuredRelation) return insuredRelation;
    if (!insuredRelation && applicantRelation) return applicantRelation;
    return applicantRelation || insuredRelation || '';
  }

  function updateParticipantRelation(kind: 'applicant' | 'insured', value: string) {
    const relation = value || '待确认';
    if (participantsAreSamePerson()) {
      applyParticipantRelation('applicant', relation);
      applyParticipantRelation('insured', relation);
      return;
    }
    applyParticipantRelation(kind, relation);
  }

  function setParticipantAsCore(kind: 'applicant' | 'insured', checked: boolean) {
    if (participantsAreSamePerson()) {
      updateParticipantRelation(kind, checked ? '本人' : '待确认');
      return;
    }
    if (!checked) {
      updateParticipantRelation(kind, '待确认');
      return;
    }
    updateParticipantRelation(kind, '本人');
  }

  function nonCoreRelationOptions(value: string) {
    const options = FAMILY_MEMBER_RELATION_OPTIONS.filter((relation) => relation !== '本人');
    return value && value !== '本人' && !options.includes(value) ? [value, ...options] : options;
  }

  function familyRelationOptions(value: string) {
    return value && !FAMILY_MEMBER_RELATION_OPTIONS.includes(value) ? [value, ...FAMILY_MEMBER_RELATION_OPTIONS] : FAMILY_MEMBER_RELATION_OPTIONS;
  }

  function renderPolicyPersonFields(kind: 'applicant' | 'insured', label: string) {
    const nameKey = kind === 'applicant' ? 'applicant' : 'insured';
    const birthdayKey = kind === 'applicant' ? 'applicantBirthday' : 'insuredBirthday';
    const samePerson = participantsAreSamePerson();
    const sharesCoreControl = samePerson && kind === 'insured';
    const relation = participantRelation(kind);
    const isCore = relation === '本人';
    return (
      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 shadow-[0_12px_28px_-24px_rgba(15,23,42,0.5)]">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-black text-slate-900">{label}</h3>
          {sharesCoreControl ? (
            <div className="inline-flex h-9 shrink-0 items-center rounded-full bg-slate-50 px-3 text-xs font-black text-slate-500 ring-1 ring-slate-200">
              与投保人为同一人
            </div>
          ) : (
            <label className={`inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 text-xs font-black ring-1 transition ${isCore ? 'bg-blue-50 text-blue-700 ring-blue-200' : 'bg-slate-50 text-slate-600 ring-slate-200'}`}>
              <input
                type="checkbox"
                checked={isCore}
                onChange={(event) => setParticipantAsCore(kind, event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              家庭顶梁柱
            </label>
          )}
        </div>
        <TextField label="姓名" value={String(formData[nameKey] || '')} onChange={(value) => updateParticipantName(kind, value)} placeholder="姓名" required />
        <TextField label={`${label}生日`} value={String(formData[birthdayKey] || '')} onChange={(value) => onUpdateForm(birthdayKey, value)} type="date" />
        {sharesCoreControl ? (
          <div>
            {requiredFieldLabel('与顶梁柱的关系')}
            <div className={`flex h-11 items-center rounded-xl border px-4 text-sm font-black ${isCore ? 'border-blue-100 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
              {relation}
            </div>
            <p className="mt-2 text-xs font-medium text-slate-500">与投保人为同一人，顶梁柱身份和关系随上方同步。</p>
          </div>
        ) : isCore ? (
          <div>
            {requiredFieldLabel('与顶梁柱的关系')}
            <div className="flex h-11 items-center rounded-xl border border-blue-100 bg-blue-50 px-4 text-sm font-black text-blue-700">
              本人
            </div>
          </div>
        ) : (
          <SelectField
            label="与顶梁柱的关系"
            value={relation}
            onChange={(value) => updateParticipantRelation(kind, value)}
            options={nonCoreRelationOptions(relation)}
            placeholder="请选择关系"
            required
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-slate-100 bg-white px-4 py-4">
        <div />
        <h1 className="text-lg font-bold">录入保单</h1>
        <div className="flex justify-end">
          <div className="flex items-center gap-2">
            <button
              className="flex h-10 items-center gap-1.5 rounded-full bg-blue-50 px-3 text-sm font-black text-blue-600 ring-1 ring-blue-100 transition-colors hover:bg-blue-100"
              type="button"
              onClick={onOpenFamilies}
            >
              <Users size={18} />
              <span className="hidden sm:inline">家庭档案</span>
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

      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto pb-32">
        <section className="p-4">
          {staleClientDetected ? (
            <section className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-black text-amber-900">页面已更新</h2>
                  <p className="mt-1 text-xs font-medium leading-5 text-amber-800">
                    你当前这个页面还是旧版本。先刷新一次，再继续录入和保存。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onReloadForLatestVersion}
                  className="shrink-0 rounded-xl bg-amber-500 px-3 py-2 text-xs font-black text-white transition hover:bg-amber-600"
                >
                  刷新页面
                </button>
              </div>
            </section>
          ) : null}
          <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">家庭档案</h2>
                <p className="mt-1 text-xs font-medium text-slate-500">用于把投保人、被保险人归入同一个家庭关系。</p>
              </div>
              <button
                type="button"
                onClick={onCreateFamily}
                className="shrink-0 rounded-xl bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 ring-1 ring-blue-100 transition hover:bg-blue-100"
              >
                新建家庭档案
              </button>
            </div>
            <SelectField
              label="选择家庭档案"
              value={selectedFamilyId ? String(selectedFamilyId) : ''}
              onChange={(value) => onSelectFamily(value ? Number(value) : null)}
              options={familyProfiles.map((family) => ({ value: String(family.id), label: family.familyName || `家庭 ${family.id}` }))}
              placeholder="请选择家庭档案"
              required
            />
            {selectedFamily && !selectedFamily.coreMemberId ? (
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold leading-5 text-amber-700 ring-1 ring-amber-100">
                家庭顶梁柱尚未设置，可先保存保单，稍后再补充顶梁柱。
              </p>
            ) : null}
          </section>
          <div className="mb-3">
            <h2 className="text-lg font-bold">拍照/相册自动识别</h2>
            <p className="mt-1 text-xs text-slate-500">可拍照或从相册选择保单照片，先做 OCR 识别，再按保司和产品生成保险责任</p>
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
            <p className="px-4 text-center text-xs text-blue-400" aria-live="polite">{loading ? '正在读取保单信息' : uploadItem ? 'OCR 已完成，可继续生成保险责任' : '上传保单基本信息页照片或相册图片'}</p>
            <div className="absolute left-3 top-3 h-4 w-4 rounded-tl border-l-2 border-t-2 border-blue-500"></div>
            <div className="absolute right-3 top-3 h-4 w-4 rounded-tr border-r-2 border-t-2 border-blue-500"></div>
            <div className="absolute bottom-3 left-3 h-4 w-4 rounded-bl border-b-2 border-l-2 border-blue-500"></div>
            <div className="absolute bottom-3 right-3 h-4 w-4 rounded-br border-b-2 border-r-2 border-blue-500"></div>
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />

          <div className="mt-4 rounded-xl border border-blue-100 bg-white px-4 py-3 text-sm font-medium text-blue-700">{message}</div>

          {ocrWarnings.length ? (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-800">
              <p>部分 OCR 字段建议确认</p>
              <ul className="mt-2 space-y-1">
                {ocrWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

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
              {requiredFieldLabel('保险公司')}
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
                {requiredFieldLabel('保险名称')}
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {renderPolicyPersonFields('applicant', '投保人')}
            {renderPolicyPersonFields('insured', '被保险人')}
          </div>

          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <label className="flex items-center justify-between gap-3">
              {requiredFieldLabel('法定受益人')}
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
                required
              />
            )}
            <SelectField
              label="与顶梁柱的关系"
              value={formData.beneficiaryRelation || ''}
              onChange={(value) => onUpdateForm('beneficiaryRelation', value)}
              options={familyRelationOptions(formData.beneficiaryRelation || '')}
              placeholder="请选择关系"
            />
            <TextField
              label="受益人生日"
              value={formData.beneficiaryBirthday || ''}
              onChange={(value) => onUpdateForm('beneficiaryBirthday', value)}
              type="date"
            />
          </div>

          <TextField label="投保时间" value={formData.date} onChange={(value) => onUpdateForm('date', value)} type="date" required />

          <div className="grid grid-cols-2 gap-4">
            <PaymentPeriodField label="缴费期间" value={formData.paymentPeriod} onChange={(value) => onUpdateForm('paymentPeriod', value)} placeholder="如 10年交 或 趸交" required />
            <CoveragePeriodField label="保障期间" value={formData.coveragePeriod} onChange={(value) => onUpdateForm('coveragePeriod', value)} placeholder="如 终身、30年、至70岁" required />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <TextField label="保额 (元)" value={formData.amount} onChange={(value) => onUpdateForm('amount', sanitizeAmount(value))} inputMode="decimal" placeholder="0.00" required />
            <TextField
              label="首期保费 (元)"
              value={formData.firstPremium}
              onChange={(value) => onUpdateForm('firstPremium', sanitizeAmount(value))}
              inputMode="decimal"
              placeholder="0.00"
              required
            />
          </div>

          <OptionalResponsibilityReview
            items={optionalResponsibilitiesForProduct(optionalResponsibilities, formData.name)}
            disabled={loading}
            compact
            title="主险可选责任确认"
            description="已按主险匹配产品带出，请按保单页面确认是否投保。"
            onChange={onUpdateOptionalResponsibility}
          />

          <PolicyPlanEditor
            company={formData.company}
            plans={normalizePolicyPlanList(formData.plans, formData.company, { keepEmpty: true })}
            optionalResponsibilities={optionalResponsibilities}
            productSuggestionLoading={formPlanProductSuggestionLoading}
            productSuggestions={formPlanProductSuggestions}
            productSuggestionTargetIndex={formPlanProductSuggestionTargetIndex}
            onAdd={onAddPlan}
            onRemove={onRemovePlan}
            onSelectProduct={onSelectPlanProduct}
            onUpdate={onUpdatePlan}
            onUpdateProductQuery={onUpdatePlanProductQuery}
            onUpdateOptionalResponsibility={onUpdateOptionalResponsibility}
          />

          <button
            onClick={onSubmit}
            disabled={loading || !canSubmit}
            type="button"
            className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-blue-500 px-4 text-sm font-black text-white shadow-lg shadow-blue-500/25 transition hover:bg-blue-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
          >
            <CheckCircle2 size={20} />
            <span>{loading ? '保存中...' : '保存保单'}</span>
          </button>
        </form>
      </main>
      <CustomerBottomTabs activeTab="entry" onChange={(tab) => {
        if (tab === 'families') onOpenFamilies();
      }} />
    </div>
  );
}


export function AnalysisReportPage(props: {
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
  const responsibilityCards = Array.isArray(analysis.responsibilityCards) ? analysis.responsibilityCards : [];
  const optionalResponsibilities = Array.isArray(analysis.optionalResponsibilities) ? analysis.optionalResponsibilities : [];
  const visibleResponsibilityCards = getVisibleResponsibilityCards(responsibilityCards, optionalResponsibilities);
  const responsibilityCount = responsibilityCards.length ? visibleResponsibilityCards.length : responsibilities.length;
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
              <p className="mt-1 text-base font-black">{responsibilityCount} 项</p>
            </div>
          </div>
        </section>

        <section className="print-only print-policy-section">
          <h2>保单信息</h2>
          <div className="print-policy-grid">
            <p><strong>保险公司：</strong>{formData.company || '-'}</p>
            <p><strong>产品名称：</strong>{formData.name || '-'}</p>
            <p><strong>投保人：</strong>{formData.applicant || '-'}</p>
            <p><strong>投保人生日：</strong>{formData.applicantBirthday || '-'}</p>
            <p><strong>受益人：</strong>{formatBeneficiaryValue(formData.beneficiary)}</p>
            <p><strong>受益人与顶梁柱的关系：</strong>{formData.beneficiaryRelation || '-'}</p>
            <p><strong>受益人生日：</strong>{formData.beneficiaryBirthday || '-'}</p>
            <p><strong>投保人与顶梁柱的关系：</strong>{formData.applicantRelation || '-'}</p>
            <p><strong>被保人：</strong>{formData.insured || '-'}</p>
            <p><strong>被保险人生日：</strong>{formData.insuredBirthday || '-'}</p>
            <p><strong>被保险人与顶梁柱的关系：</strong>{formData.insuredRelation || '-'}</p>
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
          paymentPeriod={formData.paymentPeriod}
          coveragePeriod={formData.coveragePeriod}
        />

        <OptionalResponsibilityReview
          items={optionalResponsibilities}
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
              <p className="mt-1 text-xs text-slate-500">保存后请在家庭档案中确认。</p>
            </div>
            <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-600">{responsibilityCount} 项</span>
          </div>

          {responsibilityCards.length ? (
            <ResponsibilityCardList
              cards={responsibilityCards}
              optionalResponsibilities={optionalResponsibilities}
            />
          ) : responsibilities.map((row, index) => (
            <article key={`${row.coverageType}-${index}`} className="rounded-[22px] border border-[#D9E6F4] bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-[#EEF6FF] text-sm font-black text-blue-600">
                  {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-lg font-black leading-7 text-slate-950">{[row.productName, row.coverageType || '保险责任'].filter(Boolean).join(' · ')}</h4>
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


export type UploadPolicyPageProps = Parameters<typeof UploadPolicyPage>[0];
export type AnalysisReportPageProps = Parameters<typeof AnalysisReportPage>[0];
