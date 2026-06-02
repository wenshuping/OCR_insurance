import { Database } from 'lucide-react';

import type { KnowledgeRecord } from '../../api';

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
