import { useState } from 'react';
import { Shield } from 'lucide-react';
import type { PolicyFormData } from '../api/contracts/policy';
import type { OptionalResponsibility, PolicyProductSuggestion } from '../api/contracts/responsibility';
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
import {
  normalizePolicyPlanList,
  planProductDisplayName,
} from './customer-policy-form';

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

export function getWechatUploadLabel() {
  if (isWeChatMiniProgramWebView()) return '系统相册/拍照上传';
  if (isWeChatBrowser()) return '系统拍照/相册上传';
  return '点击拍照上传';
}

export function normalizeSuggestionQuery(value: string) {
  return value.trim().replace(/\s+/g, '').toLowerCase();
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

export function TextField(props: {
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

export function OptionalResponsibilityReview({
  items = [],
  disabled = false,
  saving = false,
  compact = false,
  title = '可选责任确认',
  description = '未投保或不确定的可选责任不会进入保障金额和现金流计算。',
  onChange,
}: {
  items?: OptionalResponsibility[];
  disabled?: boolean;
  saving?: boolean;
  compact?: boolean;
  title?: string;
  description?: string;
  onChange?: (id: string, status: OptionalResponsibility['selectionStatus']) => void;
}) {
  const visibleItems = (Array.isArray(items) ? items : []).filter((item) => item?.id);
  if (!visibleItems.length) return null;
  const statusOptions = compact
    ? OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS.filter((option) => option.value !== 'unknown')
    : OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS;

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
              {!compact && item.sourceExcerpt ? (
                <p className="mt-2 line-clamp-2 text-xs font-medium leading-5 text-slate-500">{item.sourceExcerpt}</p>
              ) : null}
              {!compact && optionalResponsibilityHasQuantificationGap(item) ? (
                <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-black leading-5 text-amber-700 ring-1 ring-amber-100">
                  该可选责任已确认投保，但尚未完成指标量化，暂不进入家庭报告计算。
                </p>
              ) : null}
              {onChange ? (
                <div className={`mt-3 grid ${compact ? 'grid-cols-2' : 'grid-cols-3'} gap-2`} role="group" aria-label={`${item.liability || item.coverageType || '可选责任'}投保状态`}>
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
  productSuggestionLoading?: boolean;
  productSuggestions?: PolicyProductSuggestion[];
  productSuggestionTargetIndex?: number | null;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onSelectProduct?: (index: number, suggestion: PolicyProductSuggestion) => void;
  onUpdate: (index: number, key: string, value: string) => void;
  onUpdateProductQuery?: (index: number, company: string, q: string) => void;
}) {
  const { company, plans, productSuggestionLoading = false, productSuggestions = [], productSuggestionTargetIndex = null, onAdd, onRemove, onSelectProduct, onUpdate, onUpdateProductQuery } = props;
  const [focusedProductPlanIndex, setFocusedProductPlanIndex] = useState<number | null>(null);
  const editablePlans = plans
    .map((plan, originalIndex) => ({ ...plan, originalIndex }))
    .filter((plan) => String(plan.role || '') !== 'main');
  function productSuggestionsForPlan(plan: NonNullable<PolicyFormData['plans']>[number]) {
    const planCompany = String(plan.company || company || '').trim();
    const productQuery = String(plan.name || '').trim();
    const normalizedCompany = normalizeSuggestionQuery(planCompany);
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
  }
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
                <label className="relative block">
                  <span className="mb-1.5 block text-sm font-bold text-slate-700">险种名称</span>
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
                    <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="附加险产品候选">
                      {productSuggestionLoading ? (
                        <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                          正在加载保险产品
                        </div>
                      ) : (
                        productSuggestionsForPlan(plan).map((suggestion) => (
                          <button
                            key={`${suggestion.company}-${suggestion.productName}`}
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
                              <span className="block truncate">{renderHighlightedSuggestion(suggestion.productName, String(plan.name || ''))}</span>
                              <span className="mt-0.5 block truncate text-[11px] font-bold text-slate-400">{suggestion.company}</span>
                            </span>
                            <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                </label>
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

export function PolicyPlanSummary({
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

export function SelectField(props: {
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
