import { useId, useMemo, useState } from 'react';
import type { OptionalResponsibilityGap } from '../../api';
import { AdminPagination } from '../admin-shared/AdminPagination';
import { filterAdminList, getAdminPageWindow } from '../admin-shared/fuzzyList';

const GAP_PAGE_SIZE = 8;
const GAP_SUGGESTION_LIMIT = 8;

export function AdminOptionalResponsibilityGapPanel({
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
  const searchListId = useId();
  const [query, setQuery] = useState('');
  const [requestedPage, setRequestedPage] = useState(1);
  const filteredGaps = useMemo(
    () => filterAdminList(gaps, query, getGapSearchFields),
    [gaps, query],
  );
  const { page, pageCount, startIndex, endIndex } = getAdminPageWindow(filteredGaps.length, requestedPage, GAP_PAGE_SIZE);
  const pageGaps = filteredGaps.slice(startIndex, endIndex);
  const suggestions = filteredGaps.slice(0, GAP_SUGGESTION_LIMIT);

  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black">可选责任量化缺口</p>
          <p className="mt-1 text-xs font-medium text-slate-400">已识别但未完成结构化指标的可选责任</p>
        </div>
        <button type="button" disabled={loading} onClick={onReextract} className="rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-black text-white transition hover:bg-blue-700 disabled:opacity-50">
          重新拆解
        </button>
      </div>
      <label className="mb-3 block">
        <span className="sr-only">搜索可选责任缺口</span>
        <input
          type="search"
          list={searchListId}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setRequestedPage(1);
          }}
          placeholder="搜索产品、公司或责任，支持模糊匹配"
          className="h-11 w-full rounded-xl border border-blue-100 bg-blue-50/60 px-3 text-sm font-semibold outline-none transition focus:border-blue-400 focus:bg-white"
        />
        <datalist id={searchListId}>
          {suggestions.map((gap) => (
            <option key={gap.id} value={getGapSuggestionLabel(gap)} />
          ))}
        </datalist>
      </label>
      <div className="mb-3 flex items-center justify-between text-xs font-black text-slate-400">
        <span>{filteredGaps.length} / {gaps.length} 条匹配</span>
        <span>每页 {GAP_PAGE_SIZE} 条</span>
      </div>
      <div className="space-y-2">
        {pageGaps.map((gap) => (
          <article key={gap.id} className="rounded-[16px] border border-blue-100 bg-blue-50 px-3 py-2.5 text-xs">
            <p className="font-black text-blue-900">{gap.productName}</p>
            <p className="mt-1 font-semibold text-blue-800">{gap.company} · {gap.liability}</p>
            <p className="mt-1 leading-5 text-blue-700">{gap.quantificationReason}</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="rounded-full bg-white px-2.5 py-1 font-black text-blue-700">{gap.recentPolicyCount} 张相关保单</span>
              <button type="button" disabled={loading} onClick={() => onMarkNotQuantifiable(gap)} className="rounded-full bg-white px-2.5 py-1 font-black text-blue-700 ring-1 ring-blue-100 disabled:opacity-50">
                标记不可量化
              </button>
            </div>
          </article>
        ))}
        {gaps.length && !filteredGaps.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-8 text-center text-sm font-bold text-slate-400">没有匹配的量化缺口</p> : null}
        {!gaps.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无量化缺口</p> : null}
      </div>
      <AdminPagination
        page={page}
        pageCount={pageCount}
        totalItems={filteredGaps.length}
        startIndex={startIndex}
        endIndex={endIndex}
        onPageChange={setRequestedPage}
      />
    </section>
  );
}

function getGapSearchFields(gap: OptionalResponsibilityGap) {
  return [
    gap.productName,
    gap.company,
    gap.liability,
    gap.quantificationReason,
    gap.missingFields?.join(' '),
  ];
}

function getGapSuggestionLabel(gap: OptionalResponsibilityGap) {
  return `${gap.productName} · ${gap.company} · ${gap.liability}`;
}
