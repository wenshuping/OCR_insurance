import { useId, useMemo, useState } from 'react';
import { Database } from 'lucide-react';

import type { KnowledgeRecord } from '../../api';
import { AdminPagination } from '../admin-shared/AdminPagination';
import { filterAdminList, getAdminPageWindow } from '../admin-shared/fuzzyList';

const KNOWLEDGE_PAGE_SIZE = 10;
const KNOWLEDGE_SUGGESTION_LIMIT = 10;

export type KnowledgeCrawlForm = {
  company: string;
  name: string;
};

export const emptyKnowledgeCrawlForm: KnowledgeCrawlForm = {
  company: '',
  name: '',
};

export function AdminKnowledgePanel({
  records,
  form,
  loading,
  crawling,
  onChange,
  onRefresh,
  onCrawl,
  onReview,
}: {
  records: KnowledgeRecord[];
  form: KnowledgeCrawlForm;
  loading: boolean;
  crawling: boolean;
  onChange: (form: KnowledgeCrawlForm) => void;
  onRefresh: () => void;
  onCrawl: () => void;
  onReview: (record: KnowledgeRecord, action: 'approved' | 'rejected') => void;
}) {
  const officialCount = records.filter((record) => record.official).length;
  const searchListId = useId();
  const [query, setQuery] = useState('');
  const [requestedPage, setRequestedPage] = useState(1);
  const filteredRecords = useMemo(
    () => filterAdminList(records, query, getKnowledgeSearchFields),
    [records, query],
  );
  const { page, pageCount, startIndex, endIndex } = getAdminPageWindow(filteredRecords.length, requestedPage, KNOWLEDGE_PAGE_SIZE);
  const pageRecords = filteredRecords.slice(startIndex, endIndex);
  const suggestions = filteredRecords.slice(0, KNOWLEDGE_SUGGESTION_LIMIT);

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
      <label className="mt-3 block">
        <span className="sr-only">搜索产品知识库资料</span>
        <input
          type="search"
          list={searchListId}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setRequestedPage(1);
          }}
          placeholder="搜索产品、公司、官网或链接，支持模糊匹配"
          className="h-11 w-full rounded-xl border border-blue-100 bg-blue-50/60 px-3 text-sm font-semibold outline-none transition focus:border-blue-400 focus:bg-white"
        />
        <datalist id={searchListId}>
          {suggestions.map((record) => (
            <option key={`${record.id}-${record.url}`} value={getKnowledgeSuggestionLabel(record)} />
          ))}
        </datalist>
      </label>
      <div className="mt-3 flex items-center justify-between text-xs font-black text-slate-400">
        <span>{filteredRecords.length} / {records.length} 条匹配</span>
        <span>每页 {KNOWLEDGE_PAGE_SIZE} 条</span>
      </div>
      <div className="mt-2 space-y-2">
        {pageRecords.map((record) => {
          const customerPhoto = record.sourceKind === 'customer_policy_photo' || record.sourceKind === 'customer_policy_terms';
          const pendingReview = customerPhoto && record.reviewStatus === 'pending';
          const Wrapper = record.url?.startsWith('http') ? 'a' : 'div';
          return (
          <Wrapper
            key={`${record.id}-${record.url}`}
            className="block rounded-[16px] border border-slate-100 bg-slate-50 px-3 py-2.5 text-sm transition hover:border-blue-100 hover:bg-blue-50"
            {...(Wrapper === 'a' ? { href: record.url, target: '_blank', rel: 'noreferrer' } : {})}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate font-black text-slate-900">{record.productName || record.title}</p>
              <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-500">
                {customerPhoto ? record.reviewStatus || 'pending' : record.sourceType || 'html'}
              </span>
            </div>
            <p className="mt-1 truncate text-xs font-medium text-slate-500">{record.company}</p>
            {customerPhoto ? (
              <p className="mt-1 text-xs font-bold text-amber-600">
                客户补充照片线索，审核通过后才作为全局非官方候选
              </p>
            ) : null}
            {record.pageText && customerPhoto ? (
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{record.pageText}</p>
            ) : null}
            <p className="mt-1 truncate text-xs text-slate-400">{record.url}</p>
            {pendingReview ? (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-black text-emerald-700 ring-1 ring-emerald-100"
                  onClick={(event) => {
                    event.preventDefault();
                    onReview(record, 'approved');
                  }}
                >
                  通过为非官方候选
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-black text-rose-700 ring-1 ring-rose-100"
                  onClick={(event) => {
                    event.preventDefault();
                    onReview(record, 'rejected');
                  }}
                >
                  驳回
                </button>
              </div>
            ) : null}
          </Wrapper>
          );
        })}
        {records.length && !filteredRecords.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-8 text-center text-sm font-bold text-slate-400">没有匹配的知识库资料</p> : null}
        {!records.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无本地知识库资料</p> : null}
      </div>
      <AdminPagination
        page={page}
        pageCount={pageCount}
        totalItems={filteredRecords.length}
        startIndex={startIndex}
        endIndex={endIndex}
        onPageChange={setRequestedPage}
      />
    </section>
  );
}

function getKnowledgeSearchFields(record: KnowledgeRecord) {
  return [
    record.productName,
    record.title,
    record.company,
    record.url,
    record.sourceType,
    record.materialType,
    record.sourceKind,
    record.reviewStatus,
    record.officialDomain,
    record.parser,
  ];
}

function getKnowledgeSuggestionLabel(record: KnowledgeRecord) {
  return `${record.productName || record.title} · ${record.company}`;
}
