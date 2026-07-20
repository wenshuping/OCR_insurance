import { useId, useState } from 'react';
import { Shield } from 'lucide-react';
import type { PolicyFormData } from '../api/contracts/policy';
import type { CoverageIndicator, OptionalResponsibility, PolicyProductSuggestion } from '../api/contracts/responsibility';
import {
  policyValidityClassName,
  resolvePolicyValidityStatus,
} from '../policy-validity.mjs';
import {
  isWeChatBrowser,
  isWeChatMiniProgramWebView,
} from './browser-env';
import {
  formatCoverageAmount,
  formatCurrency,
  normalizePolicyPlanRoleLabel,
} from './formatters';
import { resolveIndicatorAmountFromCalculation } from '../indicator-calculation.mjs';
import {
  normalizePolicyPlanList,
  normalizePolicyPlanListWithIndex,
  normalizeDateInputValue,
  planProductDisplayName,
} from './customer-policy-form';

const OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS: Array<{ value: OptionalResponsibility['selectionStatus']; label: string }> = [
  { value: 'selected', label: '已投保' },
  { value: 'not_selected', label: '未投保' },
  { value: 'unknown', label: '不确定' },
];
const PAYMENT_PERIOD_OPTIONS = ['趸交', '1年交', '3年交', '5年交', '10年交', '15年交', '20年交', '30年交', '交至55岁', '交至60岁', '交至65岁', '交至70岁'];
const COVERAGE_PERIOD_OPTIONS = ['1年', '20年', '30年', '至60岁', '至65岁', '至70岁', '至75岁', '至80岁', '终身'];

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

function optionalResponsibilityDisplayName(item: OptionalResponsibility) {
  const liability = String(item.liability || item.coverageType || '').trim();
  if (liability && liability !== '可选责任') return liability;
  const excerpt = String(item.sourceExcerpt || '').replace(/\s+/g, ' ').trim();
  const numberedHeading = excerpt.match(/[（(]\d+[）)]\s*([一-龥A-Za-z0-9（）()]{2,36}?(?:保险金(?!额)|豁免保险费|豁免|年金|津贴))/u);
  if (numberedHeading?.[1]) return numberedHeading[1].trim();
  const inlineHeading = excerpt.match(/可选(?:保险)?责任\s*[一二三四五六七八九十\d]*\s*[:：]?\s*([一-龥A-Za-z0-9（）()]{2,36}?(?:保险金(?!额)|豁免保险费|豁免|年金|津贴))/u);
  if (inlineHeading?.[1]) return inlineHeading[1].trim();
  return liability || '可选责任';
}

function optionalResponsibilityContentText(item: OptionalResponsibility) {
  return String(item.sourceExcerpt || '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function getWechatUploadLabel() {
  if (isWeChatMiniProgramWebView()) return '系统相册/拍照上传';
  if (isWeChatBrowser()) return '系统拍照/相册上传';
  return '拍照/相册上传';
}

export function normalizeSuggestionQuery(value: string) {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeProductCode(value: unknown) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{1,23}$/u.test(text) ? text : '';
}

function productSuggestionDisplayName(suggestion: PolicyProductSuggestion) {
  const name = String(suggestion.productName || '').trim();
  const code = normalizeProductCode(suggestion.productCode || suggestion.productCodes?.[0]);
  if (!name || !code) return name;
  if (new RegExp(`[（(]\\s*${escapeRegExp(code)}\\s*[)）]`, 'u').test(name)) return name;
  return `${name}（${code}）`;
}

export function renderHighlightedSuggestion(value: string, query: string) {
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

function renderFieldLabel(label: string, required = false) {
  return (
    <span className="mb-1.5 block text-sm font-bold text-slate-700">
      {required ? <span className="mr-1 text-red-500">*</span> : null}
      {label}
    </span>
  );
}

function isSharedPlanPremiumText(value?: string) {
  return /整单合计保费|保单未列逐险种保费/.test(String(value || ''));
}

function planPremiumDisplayText(plan: NonNullable<PolicyFormData['plans']>[number], fallbackPremium: string | number = '') {
  if (fallbackPremium !== '') return formatCurrency(Number(fallbackPremium || 0));
  if (plan.premium) return formatCurrency(Number(plan.premium || 0));
  return isSharedPlanPremiumText(plan.premiumText) ? String(plan.premiumText || '') : formatCurrency(0);
}

function planBenefitRowLabel(row: NonNullable<NonNullable<PolicyFormData['plans']>[number]['benefitRows']>[number]) {
  const parts = [];
  if (row.responsibilityName) parts.push(String(row.responsibilityName));
  if (row.amountText) parts.push(`金额/份数 ${row.amountText}`);
  else if (row.amount) parts.push(`金额 ${formatCoverageAmount(Number(row.amount || 0))}`);
  if (row.premium) parts.push(`保费 ${formatCurrency(Number(row.premium || 0))}`);
  if (row.paymentBasis) parts.push(String(row.paymentBasis));
  if (row.benefitStandard) parts.push(String(row.benefitStandard));
  if (row.deductible) parts.push(`免赔 ${row.deductible}`);
  if (row.ratio) parts.push(`赔付 ${row.ratio}`);
  if (row.coveragePeriod) parts.push(String(row.coveragePeriod));
  if (row.paymentPeriod || row.paymentMode) parts.push(String(row.paymentPeriod || row.paymentMode));
  return parts.join(' / ');
}

function normalizeProductMatchText(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/(?:股份)?有限公司/gu, '')
    .replace(/(?:新华人寿保险|新华保险|中国人寿保险|中国人寿|国寿)/gu, '')
    .replace(/\s+/gu, '')
    .trim();
}

function optionalResponsibilitySemanticKey(item: OptionalResponsibility) {
  return [
    normalizeProductMatchText(item.productName),
    String(item.liability || item.coverageType || '').normalize('NFKC').replace(/\s+/gu, '').trim(),
  ].join('\u001f');
}

function mergeOptionalResponsibilityDisplayItems(items: OptionalResponsibility[]) {
  const byKey = new Map<string, OptionalResponsibility>();
  for (const item of items) {
    const key = optionalResponsibilitySemanticKey(item);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const indicatorIds = [
      ...(Array.isArray(existing.indicatorIds) ? existing.indicatorIds : []),
      ...(Array.isArray(item.indicatorIds) ? item.indicatorIds : []),
    ].filter((id, index, list) => id && list.indexOf(id) === index);
    byKey.set(key, {
      ...existing,
      ...item,
      id: existing.id || item.id,
      selectionStatus: existing.selectionEvidence === 'manual' ? existing.selectionStatus : item.selectionStatus || existing.selectionStatus,
      selectionEvidence: existing.selectionEvidence === 'manual' ? existing.selectionEvidence : item.selectionEvidence || existing.selectionEvidence,
      quantificationStatus: existing.quantificationStatus === 'quantified' ? existing.quantificationStatus : item.quantificationStatus || existing.quantificationStatus,
      indicatorIds,
    });
  }
  return [...byKey.values()];
}

export function optionalResponsibilitiesForProduct(items: OptionalResponsibility[] = [], productName = '') {
  const target = normalizeProductMatchText(productName);
  if (!target) return [];
  const matches = (Array.isArray(items) ? items : []).filter((item) => {
    const source = normalizeProductMatchText(item.productName);
    return source === target || source.includes(target) || target.includes(source);
  });
  return mergeOptionalResponsibilityDisplayItems(matches);
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'tel';
  required?: boolean;
}) {
  const usesDateTextInput = props.type === 'date';
  function handleBlur() {
    if (!usesDateTextInput) return;
    const normalized = normalizeDateInputValue(props.value);
    if (normalized || !props.value.trim()) props.onChange(normalized);
  }
  return (
    <div>
      <label>{renderFieldLabel(props.label, props.required)}</label>
      <input
        type={usesDateTextInput ? 'text' : props.type || 'text'}
        inputMode={usesDateTextInput ? 'numeric' : props.inputMode}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={handleBlur}
        placeholder={usesDateTextInput ? props.placeholder || 'yyyy/mm/dd' : props.placeholder}
        autoComplete={usesDateTextInput ? 'off' : undefined}
        pattern={usesDateTextInput ? '[0-9./年-]*' : undefined}
        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
      />
    </div>
  );
}

export function PeriodField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  presets: string[];
  required?: boolean;
}) {
  const listId = useId();
  return (
    <div>
      <label>{renderFieldLabel(props.label, props.required)}</label>
      <input
        type="text"
        list={listId}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
      />
      <datalist id={listId}>
        {props.presets.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </div>
  );
}

export function PaymentPeriodField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return <PeriodField {...props} presets={PAYMENT_PERIOD_OPTIONS} />;
}

export function CoveragePeriodField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return <PeriodField {...props} presets={COVERAGE_PERIOD_OPTIONS} />;
}

export function OptionalResponsibilityReview({
  items = [],
  indicators = [],
  baseAmount = 0,
  firstPremium = 0,
  paymentPeriod = '',
  disabled = false,
  saving = false,
  compact = false,
  title = '可选责任确认',
  description = '未投保或不确定的可选责任不会进入保障金额和现金流计算。',
  onChange,
}: {
  items?: OptionalResponsibility[];
  indicators?: Array<Partial<CoverageIndicator>>;
  baseAmount?: string | number;
  firstPremium?: string | number;
  paymentPeriod?: string;
  disabled?: boolean;
  saving?: boolean;
  compact?: boolean;
  title?: string;
  description?: string;
  onChange?: (id: string, status: OptionalResponsibility['selectionStatus']) => void;
}) {
  const visibleItems = (Array.isArray(items) ? items : []).filter((item) => item?.id);
  if (!visibleItems.length) return null;
  const statusOptions = OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS;
  const paymentYears = Number(String(paymentPeriod).match(/(\d+(?:\.\d+)?)\s*年/u)?.[1] || (/趸交|一次交清/u.test(paymentPeriod) ? 1 : 0)) || 1;

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
          const displayName = optionalResponsibilityDisplayName(item);
          const contentText = optionalResponsibilityContentText(item);
          const contentClampClass = compact ? 'line-clamp-3' : 'line-clamp-2';
          const indicatorIds = new Set(Array.isArray(item.indicatorIds) ? item.indicatorIds : []);
          const linkedIndicators = indicators.filter((indicator) => indicator.id && indicatorIds.has(indicator.id));
          return (
            <article key={item.id} className="group rounded-[18px] border border-slate-100 bg-slate-50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black leading-6 text-slate-900">
                    {displayName}
                  </p>
                  <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">
                    {[item.productName, item.coverageType].filter(Boolean).join(' · ') || '产品责任'}
                  </p>
                </div>
                {!compact ? (
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
                ) : null}
              </div>
              {contentText ? (
                <p
                  tabIndex={0}
                  title={contentText}
                  className={`${contentClampClass} mt-2 text-xs font-medium leading-5 text-slate-500 group-hover:line-clamp-none focus:line-clamp-none focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500`}
                >
                  {contentText}
                </p>
              ) : null}
              {linkedIndicators.length ? (
                <div className="mt-2 rounded-xl bg-blue-50 px-3 py-2 ring-1 ring-blue-100">
                  <p className="text-[11px] font-black text-blue-700">量化指标（{linkedIndicators.length}项）</p>
                  <div className="mt-1.5 space-y-1">
                    {linkedIndicators.map((indicator) => {
                      const calculation = status === 'selected'
                        ? resolveIndicatorAmountFromCalculation(indicator, { baseAmount, firstPremium, paymentYears })
                        : null;
                      return (
                        <div key={indicator.id} className="text-xs font-bold leading-5 text-slate-600">
                          <p>
                            {indicator.liability || indicator.coverageType || '保险责任'}
                            {indicator.formulaText ? `：${indicator.formulaText}` : ''}
                          </p>
                          {calculation?.resolved ? (
                            <div className="mt-1 rounded-lg bg-cyan-50 px-2.5 py-2 text-cyan-800 ring-1 ring-cyan-100">
                              <p className="font-black">已按本保单计算：{formatCurrency(calculation.amount)}</p>
                              <p className="text-[11px] text-cyan-700">{calculation.calculationText}</p>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {!compact && optionalResponsibilityHasQuantificationGap(item) ? (
                <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-black leading-5 text-amber-700 ring-1 ring-amber-100">
                  该可选责任已确认投保，但尚未完成指标量化，暂不进入家庭报告计算。
                </p>
              ) : null}
              {onChange ? (
                <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label={`${displayName}投保状态`}>
                  {statusOptions.map((option) => {
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

export function PolicyPlanEditor(props: {
  company: string;
  plans: NonNullable<PolicyFormData['plans']>;
  optionalResponsibilities?: OptionalResponsibility[];
  productSuggestionLoading?: boolean;
  productSuggestions?: PolicyProductSuggestion[];
  productSuggestionTargetIndex?: number | null;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onSelectProduct?: (index: number, suggestion: PolicyProductSuggestion) => void;
  onUpdate: (index: number, key: string, value: string) => void;
  onUpdateProductQuery?: (index: number, company: string, q: string) => void;
  onUpdateOptionalResponsibility?: (id: string, status: OptionalResponsibility['selectionStatus']) => void;
  onSupplementClick?: (plan: NonNullable<PolicyFormData['plans']>[number]) => void;
  supplementUploading?: boolean;
  supplementCount?: number;
}) {
  const {
    company,
    plans,
    optionalResponsibilities = [],
    productSuggestionLoading = false,
    productSuggestions = [],
    productSuggestionTargetIndex = null,
    onAdd,
    onRemove,
    onSelectProduct,
    onUpdate,
    onUpdateProductQuery,
    onUpdateOptionalResponsibility,
    onSupplementClick,
    supplementUploading = false,
    supplementCount = 0,
  } = props;
  const [focusedProductPlanIndex, setFocusedProductPlanIndex] = useState<number | null>(null);
  const editablePlans = normalizePolicyPlanListWithIndex(plans, company, { keepEmpty: true })
    .map((plan) => ({ ...plan, originalIndex: plan.__originalIndex }))
    .filter((plan) => String(plan.role || '') !== 'main');
  function productSuggestionsForPlan(plan: NonNullable<PolicyFormData['plans']>[number]) {
    if (!String(plan.company || company || '').trim()) return [];
    return Array.isArray(productSuggestions) ? productSuggestions : [];
  }
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-4 space-y-3">
        <h3 className="text-sm font-black text-slate-900">险种明细</h3>
        <p className="text-xs font-medium leading-5 text-slate-500">附加险或万能账户会按保险公司分别匹配产品。</p>
        <button
          className="flex h-11 w-full items-center justify-center rounded-xl border border-blue-100 bg-blue-50 px-4 text-sm font-black text-blue-700 shadow-sm shadow-blue-100/40 active:bg-blue-100"
          type="button"
          onClick={onAdd}
        >
          手动添加附加险
        </button>
      </div>

      {editablePlans.length ? (
        <div className="space-y-3">
          {editablePlans.map((plan) => (
            <article key={`policy-plan-${plan.originalIndex}`} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
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
                <label className="relative block">
                  {renderFieldLabel('险种名称', true)}
                  <input
                    value={String(plan.name || '')}
                    onChange={(event) => {
                      const value = event.target.value;
                      onUpdate(plan.originalIndex, 'name', value);
                      onUpdateProductQuery?.(plan.originalIndex, String(plan.company || company || ''), value);
                    }}
                    onFocus={() => {
                      setFocusedProductPlanIndex(plan.originalIndex);
                      onUpdateProductQuery?.(plan.originalIndex, String(plan.company || company || ''), String(plan.name || ''));
                    }}
                    onBlur={() => window.setTimeout(() => setFocusedProductPlanIndex((current) => current === plan.originalIndex ? null : current), 120)}
                    placeholder="保单上的险种全称"
                    autoComplete="off"
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
                  />
                  {focusedProductPlanIndex === plan.originalIndex && productSuggestionTargetIndex === plan.originalIndex && (productSuggestionLoading || productSuggestionsForPlan(plan).length) ? (
                    <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 max-h-72 overflow-y-auto overscroll-contain rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)] [-webkit-overflow-scrolling:touch]" role="listbox" aria-label="附加险产品候选">
                      {productSuggestionLoading ? (
                        <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                          正在加载保险产品
                        </div>
                      ) : (
                        productSuggestionsForPlan(plan).map((suggestion) => {
                          const displayName = productSuggestionDisplayName(suggestion);
                          return (
                            <button
                              key={`${suggestion.company}-${suggestion.productName}-${suggestion.productCode || suggestion.productCodes?.[0] || ''}`}
                              type="button"
                              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                              role="option"
                              aria-selected={false}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                onSelectProduct?.(plan.originalIndex, suggestion);
                                setFocusedProductPlanIndex(null);
                              }}
                            >
                              <span className="min-w-0">
                                <span className="block truncate">{renderHighlightedSuggestion(displayName, String(plan.name || ''))}</span>
                                <span className="mt-0.5 block truncate text-[11px] font-bold text-slate-400">{suggestion.company}</span>
                              </span>
                              <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  ) : null}
                </label>
                {plan.matchedProductName ? (
                  <p className="rounded-xl bg-white px-3 py-2 text-xs font-bold leading-5 text-blue-700 ring-1 ring-blue-100">
                    已按 {plan.company || company || '保险公司'} 匹配：{planProductDisplayName(plan)}
                  </p>
                ) : null}
                {!plan.matchedProductName && String(plan.name || '').trim() && onSupplementClick ? (
                  <button
                    type="button"
                    disabled={supplementUploading || supplementCount >= 5}
                    onClick={() => onSupplementClick(plan)}
                    className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-black text-white shadow-sm transition active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {supplementUploading ? '正在识别附加险详细页面' : '上传附加险保单详细信息页'}
                  </button>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <TextField label="保额 (元)" value={String(plan.amount || '')} onChange={(value) => onUpdate(plan.originalIndex, 'amount', value)} inputMode="decimal" placeholder="0.00" required />
                  <TextField label="保费 (元)" value={String(plan.premium || '')} onChange={(value) => onUpdate(plan.originalIndex, 'premium', value)} inputMode="decimal" placeholder="0.00" required={!isSharedPlanPremiumText(plan.premiumText)} />
                </div>
                {isSharedPlanPremiumText(plan.premiumText) && !plan.premium ? (
                  <p className="rounded-xl bg-white px-3 py-2 text-xs font-bold leading-5 text-slate-500 ring-1 ring-slate-100">
                    {plan.premiumText}
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <CoveragePeriodField label="保障期间" value={String(plan.coveragePeriod || '')} onChange={(value) => onUpdate(plan.originalIndex, 'coveragePeriod', value)} placeholder="如 终身、30年、至70岁" required />
                  <PaymentPeriodField label="缴费期间" value={String(plan.paymentPeriod || '')} onChange={(value) => onUpdate(plan.originalIndex, 'paymentPeriod', value)} placeholder="如 10年交 或 趸交" required />
                </div>
                <OptionalResponsibilityReview
                  items={optionalResponsibilitiesForProduct(optionalResponsibilities, String(plan.matchedProductName || plan.name || ''))}
                  disabled={!onUpdateOptionalResponsibility}
                  compact
                  title="附加险可选责任确认"
                  description="已按该附加险匹配产品带出，请按保单页面确认是否投保。"
                  onChange={onUpdateOptionalResponsibility}
                />
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

export function PolicyPlanSummary({
  plans,
  effectiveDate,
  insuredBirthday,
  paymentPeriod = '',
  coveragePeriod = '',
  amount = '',
  firstPremium = '',
}: {
  plans: NonNullable<PolicyFormData['plans']>;
  effectiveDate?: string;
  insuredBirthday?: string;
  paymentPeriod?: string;
  coveragePeriod?: string;
  amount?: string | number;
  firstPremium?: string | number;
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
          const fallbackCoveragePeriod = index === 0 ? coveragePeriod : '';
          const fallbackPaymentPeriod = index === 0 ? paymentPeriod : '';
          const fallbackAmount = index === 0 ? amount : '';
          const fallbackPremium = index === 0 ? firstPremium : '';
          const planCoveragePeriod = plan.coveragePeriod || fallbackCoveragePeriod;
          const planPaymentPeriod = plan.paymentPeriod || plan.paymentMode || fallbackPaymentPeriod;
          const planAmount = fallbackAmount || plan.amount;
          const validityStatus = resolvePolicyValidityStatus(planCoveragePeriod, {
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
                <p>保额：{formatCoverageAmount(Number(planAmount || 0))}</p>
                <p>保费：{planPremiumDisplayText(plan, fallbackPremium)}</p>
                <p>期间：{planCoveragePeriod || '-'}</p>
                <p>缴费：{planPaymentPeriod || '-'}</p>
                <p>
                  状态：
                  <span className={`ml-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-black ring-1 ${validityStatusClassName}`}>
                    {validityStatus.label}
                  </span>
                </p>
              </div>
              {Array.isArray(plan.benefitRows) && plan.benefitRows.length > 1 ? (
                <div className="mt-2 rounded-lg bg-white px-3 py-2 text-xs font-bold leading-5 text-slate-500 ring-1 ring-slate-100">
                  <p className="mb-1 text-[11px] font-black text-slate-700">责任金额明细</p>
                  <ul className="space-y-1">
                    {plan.benefitRows.map((row, rowIndex) => (
                      <li key={`${planProductDisplayName(plan)}-benefit-${rowIndex}`}>{planBenefitRowLabel(row) || '-'}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function SelectField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<string | { value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label>{renderFieldLabel(props.label, props.required)}</label>
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
