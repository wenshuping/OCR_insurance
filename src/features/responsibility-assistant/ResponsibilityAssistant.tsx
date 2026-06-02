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
  PolicyCompanySuggestion,
  PolicyProductSuggestion,
} from '../../api/contracts/responsibility';
import {
  normalizeSuggestionQuery,
  renderHighlightedSuggestion,
} from '../../shared/customer-policy-components';

export function ResponsibilityAssistant(props: {
  analysis: PolicyAnalysisResult | null;
  anchorClassName?: string;
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
    anchorClassName,
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


export type ResponsibilityAssistantProps = Parameters<typeof ResponsibilityAssistant>[0];
