import { useMemo, useState } from 'react';
import {
  Bot,
  Loader2,
  Search,
  SendHorizontal,
  X,
} from 'lucide-react';
import type {
  PolicyAnalysisResult,
  PolicyKnowledgeMatch,
} from '../../api/contracts/policy';
import type {
  CustomerResponsibilitySummary,
  PolicyCompanySuggestion,
  PolicyProductSuggestion,
} from '../../api/contracts/responsibility';
import {
  normalizeSuggestionQuery,
  renderHighlightedSuggestion,
} from '../../shared/customer-policy-components';

function cleanSummaryText(value: string | undefined) {
  return String(value || '').trim();
}

function cleanSummaryList(values: string[] | undefined) {
  return Array.isArray(values) ? values.map((value) => cleanSummaryText(value)).filter(Boolean) : [];
}

function hostFromUrl(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function sourceKindLabel(sourceKind: string | undefined) {
  if (sourceKind === 'jrcpcx') return '金融产品查询平台/中国保险行业协会条款 PDF';
  if (sourceKind === 'insurer_official') return '保险公司官网';
  if (sourceKind === 'customer_policy_terms') return '客户上传保单责任页/合同页';
  if (sourceKind === 'customer_policy_photo') return '客户上传保单照片';
  if (sourceKind === 'legacy_external_reference') return '历史老产品外部线索';
  if (sourceKind === 'open_web_reference') return '外部网页线索';
  return '本地知识库';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function productMatchDisplayName(match: PolicyKnowledgeMatch) {
  const name = match.productName || '';
  const code = String(match.productCode || match.bestSource?.productCode || '').trim();
  if (!name || !code) return name;
  if (new RegExp(`[（(]\\s*${escapeRegExp(code)}\\s*[)）]`, 'u').test(name)) return name;
  return `${name}（${code}）`;
}

function productSuggestionDisplayName(suggestion: PolicyProductSuggestion) {
  const name = suggestion.productName || '';
  const code = String(suggestion.productCode || suggestion.productCodes?.[0] || '').trim();
  if (!name || !code) return name;
  if (new RegExp(`[（(]\\s*${escapeRegExp(code)}\\s*[)）]`, 'u').test(name)) return name;
  return `${name}（${code}）`;
}

function isExternalReferenceMatch(match: PolicyKnowledgeMatch) {
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

function productMatchKey(match: PolicyKnowledgeMatch) {
  return [
    match.company.trim(),
    (match.resolvedProductName || match.productName).trim(),
    match.sourceKind || '',
    match.bestSource?.url || '',
  ].join('\u001f');
}

export function ResponsibilityAssistant(props: {
  analysis: PolicyAnalysisResult | null;
  anchorClassName?: string;
  company: string;
  companySuggestionLoading: boolean;
  companySuggestions: PolicyCompanySuggestion[];
  customerSummary: CustomerResponsibilitySummary | null;
  customerSummaryLoading: boolean;
  customerSummaryMessage: string;
  localSearched: boolean;
  loading: boolean;
  matches: PolicyKnowledgeMatch[];
  message: string;
  name: string;
  productSuggestionLoading: boolean;
  productSuggestions: PolicyProductSuggestion[];
  selectedMatchKey: string;
  onChangeCompany: (value: string) => void;
  onChangeName: (value: string) => void;
  onClose: () => void;
  onOpen: () => void;
  onQuery: () => void;
  onSearchMore: () => void;
  onSelectCompany: (company: string) => void;
  onSelectMatch: (match: PolicyKnowledgeMatch) => void;
  onSelectProduct: (suggestion: PolicyProductSuggestion, displayName?: string) => void;
  open: boolean;
}) {
  const {
    analysis,
    anchorClassName,
    company,
    companySuggestionLoading,
    companySuggestions,
    customerSummary,
    customerSummaryLoading,
    customerSummaryMessage,
    localSearched,
    loading,
    matches,
    message,
    name,
    productSuggestionLoading,
    productSuggestions,
    selectedMatchKey,
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
  const customerSummaryResponsibilities = Array.isArray(customerSummary?.mainResponsibilities)
    ? customerSummary.mainResponsibilities
    : [];
  const officialResponsibilityText = cleanSummaryText(customerSummary?.officialResponsibilityText || analysis?.officialResponsibilityText);
  const customerSummaryBlocks = (Array.isArray(customerSummary?.contentBlocks)
    ? customerSummary.contentBlocks
    : [])
    .map((block) => ({
      blockKey: cleanSummaryText(block?.blockKey),
      title: cleanSummaryText(block?.title),
      enabled: block?.enabled !== false,
      content: cleanSummaryText(block?.content),
      order: Number.isFinite(Number(block?.order)) ? Number(block.order) : 0,
    }))
    .filter((block) => block.enabled && (block.title || block.content))
    .sort((left, right) => left.order - right.order);
  const customerSummaryHasBlocks = customerSummaryBlocks.some((block) => block.content);
  const customerSummaryHasContent = Boolean(
    customerSummary?.headline?.trim()
      || customerSummaryHasBlocks
      || customerSummaryResponsibilities.some((item) => item?.title?.trim() || item?.plainText?.trim() || item?.howItPays?.trim()),
  );
  const customerSummaryRows = customerSummaryResponsibilities
    .map((item) => ({
      title: cleanSummaryText(item?.title),
      plainText: cleanSummaryText(item?.plainText),
      triggerCondition: cleanSummaryText(item?.triggerCondition),
      howItPays: cleanSummaryText(item?.howItPays),
      calculationStatus: cleanSummaryText(item?.calculationStatus),
      requiredPolicyFields: cleanSummaryList(item?.requiredPolicyFields),
      sourceRefs: cleanSummaryList(item?.sourceRefs),
    }))
    .filter((item) => item.title || item.plainText || item.triggerCondition || item.howItPays || item.calculationStatus || item.sourceRefs.length);
  const customerSummaryNotices = cleanSummaryList(customerSummary?.notices);
  const customerSummaryRequiredPolicyFields = cleanSummaryList(customerSummary?.requiredPolicyFields);
  const customerSummarySourceUrls = cleanSummaryList(customerSummary?.sourceUrls);
  const shouldShowOfficialResponsibilityTextFallback = !customerSummaryLoading && !customerSummary && Boolean(officialResponsibilityText);
  const shouldShowResponsibilityRows = !customerSummaryLoading && !customerSummary && !customerSummaryMessage && !shouldShowOfficialResponsibilityTextFallback && responsibilities.length > 0;
  const displayedResponsibilityCount = customerSummaryHasContent
    ? customerSummaryRows.length || customerSummaryBlocks.length
    : shouldShowOfficialResponsibilityTextFallback
      ? 1
    : shouldShowResponsibilityRows
      ? responsibilities.length
      : 0;
  const sources = Array.isArray(analysis?.sources) ? analysis.sources : [];
  const productMatches = Array.isArray(matches) ? matches : [];
  const canQuery = Boolean(company.trim() && name.trim() && !loading);
  const canSearchMore = Boolean(localSearched && company.trim() && name.trim() && !responsibilities.length);
  const companyQuery = company.trim();
  const productQuery = name.trim();
  const responsibilityRows = responsibilities.map((row, index) => (
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
  ));
  const visibleCompanySuggestions = useMemo(() => {
    const normalizedQuery = normalizeSuggestionQuery(companyQuery);
    if (!normalizedQuery) return [];
    return (Array.isArray(companySuggestions) ? companySuggestions : [])
      .filter((suggestion) => normalizeSuggestionQuery(suggestion.company) !== normalizedQuery);
  }, [companyQuery, companySuggestions]);
  const showCompanySuggestions = companyFocused && companyQuery && (companySuggestionLoading || visibleCompanySuggestions.length);
  const visibleProductSuggestions = useMemo(() => {
    if (!normalizeSuggestionQuery(companyQuery)) return [];
    return Array.isArray(productSuggestions) ? productSuggestions : [];
  }, [companyQuery, productSuggestions]);
  const showProductSuggestions = productFocused && Boolean(companyQuery) && (productSuggestionLoading || visibleProductSuggestions.length);
  const rootClassName = anchorClassName
    ? `no-print fixed ${anchorClassName} right-4 z-[70] flex flex-col-reverse items-end sm:right-6`
    : 'no-print fixed bottom-6 right-4 z-[70] flex flex-col-reverse items-end sm:right-6';

  return (
    <div className={rootClassName}>
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
                  <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 max-h-72 overflow-y-auto overscroll-contain rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)] [-webkit-overflow-scrolling:touch]" role="listbox" aria-label="保险公司候选">
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
                  <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 max-h-72 overflow-y-auto overscroll-contain rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)] [-webkit-overflow-scrolling:touch]" role="listbox" aria-label="保险产品候选">
                    {productSuggestionLoading ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在加载保险产品
                      </div>
                    ) : (
                      visibleProductSuggestions.map((suggestion) => {
                        const displayName = productSuggestionDisplayName(suggestion);
                        return (
                          <button
                            key={`${suggestion.company}-${suggestion.productName}`}
                            type="button"
                            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                            role="option"
                            aria-selected={false}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              onSelectProduct(suggestion, displayName);
                              setProductFocused(false);
                            }}
                          >
                            <span className="min-w-0">
                              <span className="block truncate">{renderHighlightedSuggestion(displayName, productQuery)}</span>
                              {suggestion.company !== companyQuery ? (
                                <span className="mt-0.5 block truncate text-[11px] font-bold text-slate-400">{suggestion.company}</span>
                              ) : null}
                            </span>
                            <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                          </button>
                        );
                      })
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
                  {productMatches.map((match, index) => {
                    const selected = Boolean(selectedMatchKey && productMatchKey(match) === selectedMatchKey);
                    const displayName = productMatchDisplayName(match);
                    return (
                    <button
                      key={`${match.company}-${match.productName}-${index}`}
                      type="button"
                      disabled={loading}
                      onClick={() => onSelectMatch(match)}
                      className={[
                        'block w-full rounded-[18px] border p-3.5 text-left shadow-[0_14px_30px_-28px_rgba(15,23,42,0.35)] transition active:scale-[0.99] disabled:opacity-60',
                        selected
                          ? 'border-amber-300 bg-amber-50/80 hover:border-amber-300'
                          : 'border-[#DDE8F5] bg-white hover:border-blue-200 hover:bg-[#F8FBFF]',
                      ].join(' ')}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[11px] font-black text-blue-600">{match.company}</p>
                          <h4 className="mt-1 break-words text-sm font-black leading-6 text-slate-950">{displayName}</h4>
                          <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">
                            {match.bestSource?.title || match.title || match.matchReason}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700">
                            {Math.round(match.score * 100)}%
                          </span>
                          {selected ? (
                            <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-black text-amber-700">
                              已选择
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-black text-slate-400">
                        <span className="rounded-full bg-slate-50 px-2 py-1">{match.matchReason}</span>
                        <span className="rounded-full bg-slate-50 px-2 py-1">{sourceKindLabel(match.sourceKind)}</span>
                        <span className={`rounded-full px-2 py-1 ${
                          isExternalReferenceMatch(match)
                            ? 'bg-amber-50 text-amber-700'
                            : match.sourceKind === 'customer_policy_terms'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-slate-50'
                        }`}>
                          {match.verificationLabel || match.bestSource?.verificationLabel || match.evidenceLabel}
                        </span>
                        <span className="rounded-full bg-slate-50 px-2 py-1">{match.sourceCount} 份资料</span>
                      </div>
                      {isExternalReferenceMatch(match) ? (
                        <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-black leading-5 text-amber-700">
                          {selected ? '已选择为待核实建档线索；' : ''}非官方资料，待保险公司确认；可生成待核实责任，不作为正式理赔依据。
                        </p>
                      ) : null}
                    </button>
                    );
                  })}
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
                  联网查找候选
                </button>
              </section>
            ) : null}

            <section className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-black text-slate-950">保险责任</h3>
                {displayedResponsibilityCount ? (
                  <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-700">{displayedResponsibilityCount} 项</span>
                ) : null}
              </div>
              <div className="space-y-2.5">
                {customerSummaryLoading ? (
                  <div className="flex items-center justify-center gap-2 rounded-[18px] border border-blue-100 bg-blue-50/50 px-4 py-6 text-sm font-black text-blue-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在生成客户可读摘要
                  </div>
                ) : customerSummary && customerSummaryHasContent ? (
                  <div className="space-y-4">
                    <div className="space-y-3 text-sm leading-6 text-slate-700">
                      {customerSummaryHasBlocks ? (
                        customerSummaryBlocks.map((block, index) => (
                          <section key={`${block.blockKey}-${index}`} className="space-y-1">
                            {block.title ? <h4 className="break-words font-black text-slate-950">{block.title}</h4> : null}
                            {block.content ? <p className="whitespace-pre-wrap break-words font-semibold text-slate-600">{block.content}</p> : null}
                          </section>
                        ))
                      ) : cleanSummaryText(customerSummary.headline) ? (
                        <p className="whitespace-pre-wrap break-words font-black text-blue-700">{cleanSummaryText(customerSummary.headline)}</p>
                      ) : null}
                    </div>

                    {customerSummaryRows.length ? (
                      <section className="space-y-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <h4 className="text-sm font-black text-slate-950">责任明细</h4>
                          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-700">{customerSummaryRows.length} 项</span>
                        </div>
                        {customerSummaryRows.map((item, index) => (
                          <article key={`${item.title}-${index}`} className="rounded-[18px] border border-[#DDE8F5] bg-[#F8FBFF] p-3.5">
                            <div className="flex items-start gap-3">
                              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-white text-xs font-black text-blue-600 ring-1 ring-blue-100">
                                {index + 1}
                              </div>
                              <div className="min-w-0 flex-1">
                                {item.title ? <h5 className="break-words text-sm font-black leading-6 text-slate-950">{item.title}</h5> : null}
                                {item.plainText ? <p className="mt-1 whitespace-pre-wrap break-words text-xs font-semibold leading-5 text-slate-600">{item.plainText}</p> : null}
                                {item.triggerCondition ? <p className="mt-2 whitespace-pre-wrap break-words text-xs font-semibold leading-5 text-slate-500">触发条件：{item.triggerCondition}</p> : null}
                                {item.howItPays ? <p className="mt-2 break-words rounded-xl bg-white px-3 py-2 text-xs font-black leading-5 text-blue-700">{item.howItPays}</p> : null}
                                {item.calculationStatus ? <p className="mt-2 break-words text-[11px] font-black leading-5 text-slate-400">calculationStatus: {item.calculationStatus}</p> : null}
                                {item.sourceRefs.length ? (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {item.sourceRefs.map((sourceRef) => (
                                      <span key={sourceRef} className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700 ring-1 ring-blue-100">{sourceRef}</span>
                                    ))}
                                  </div>
                                ) : null}
                                {item.requiredPolicyFields.length ? (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {item.requiredPolicyFields.map((field) => (
                                      <span key={field} className="rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-500 ring-1 ring-slate-200">{field}</span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </article>
                        ))}
                      </section>
                    ) : null}

                    {customerSummaryRequiredPolicyFields.length ? (
                      <section className="rounded-[18px] border border-amber-100 bg-amber-50 px-3 py-3">
                        <h4 className="text-xs font-black text-amber-700">计算金额需要这些保单信息</h4>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {customerSummaryRequiredPolicyFields.map((field) => (
                            <span key={field} className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-amber-700 ring-1 ring-amber-100">{field}</span>
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {customerSummaryNotices.length ? (
                      <section className="space-y-1.5">
                        <h4 className="text-xs font-black text-slate-950">注意事项</h4>
                        {customerSummaryNotices.map((notice) => (
                          <p key={notice} className="break-words text-xs font-semibold leading-5 text-slate-500">{notice}</p>
                        ))}
                      </section>
                    ) : null}

                    {customerSummarySourceUrls.length ? (
                      <section className="space-y-2">
                        <h4 className="text-xs font-black text-slate-950">引用来源</h4>
                        {customerSummarySourceUrls.slice(0, 3).map((url) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="block rounded-[16px] border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-500 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                          >
                            <span className="block truncate">{hostFromUrl(url)}</span>
                            <span className="mt-1 block truncate font-medium text-slate-400">{url}</span>
                          </a>
                        ))}
                      </section>
                    ) : null}
                  </div>
                ) : shouldShowOfficialResponsibilityTextFallback ? (
                  <article className="rounded-[18px] border border-[#DDE8F5] bg-[#F8FBFF] p-3.5">
                    <h4 className="text-sm font-black text-slate-950">保险责任正文</h4>
                    <p className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-xs font-semibold leading-5 text-slate-600">
                      {officialResponsibilityText}
                    </p>
                  </article>
                ) : customerSummaryMessage ? (
                  <div className="rounded-[18px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-bold text-slate-400">
                    {customerSummaryMessage}
                  </div>
                ) : shouldShowResponsibilityRows ? (
                  responsibilityRows
                ) : productMatches.length ? (
                  <div className="rounded-[18px] border border-dashed border-blue-100 bg-blue-50/50 px-4 py-6 text-center text-sm font-bold text-blue-500">
                    点击上方产品后输出保险责任
                  </div>
                ) : localSearched ? (
                  <div className="rounded-[18px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-bold text-slate-400">
                    未找到匹配产品，请核对合同条款名称
                  </div>
                ) : (
                  <div className="rounded-[18px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-bold text-slate-400">
                    暂无查询结果
                  </div>
                )}
              </div>
            </section>

            {officialResponsibilityText && !shouldShowOfficialResponsibilityTextFallback ? (
              <section className="mt-4">
                <details className="group rounded-[18px] border border-slate-200 bg-slate-50">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-sm font-black text-slate-950 [&::-webkit-details-marker]:hidden">
                    <span>保险责任条款</span>
                    <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-blue-700 ring-1 ring-blue-100">
                      <span className="group-open:hidden">展开</span>
                      <span className="hidden group-open:inline">收起</span>
                    </span>
                  </summary>
                  <div className="border-t border-slate-200 px-3 py-3">
                    <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs font-semibold leading-5 text-slate-500">
                      {officialResponsibilityText}
                    </p>
                  </div>
                </details>
              </section>
            ) : null}

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
                        <span className={`shrink-0 rounded-full px-2 py-0.5 font-black ${
                          source.referenceOnly || source.verificationStatus === 'pending_review'
                            ? 'bg-amber-50 text-amber-700'
                            : source.sourceKind === 'customer_policy_terms'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-blue-50 text-blue-700'
                        }`}>
                          {source.verificationLabel || source.evidenceLabel || (source.official ? '官方资料' : '资料')}
                        </span>
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


export type ResponsibilityAssistantProps = Parameters<typeof ResponsibilityAssistant>[0];
