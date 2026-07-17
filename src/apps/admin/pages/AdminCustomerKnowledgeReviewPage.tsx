import { useMemo, useState } from 'react';
import { Check, ChevronLeft, Image as ImageIcon, Search, X } from 'lucide-react';

import type { KnowledgeRecord } from '../../../api';

type ReviewAction = 'approved' | 'rejected';

function isCustomerUpload(record: KnowledgeRecord) {
  return record.sourceKind === 'customer_policy_photo' || record.sourceKind === 'customer_policy_terms';
}

function statusLabel(status = '') {
  if (status === 'approved') return '已通过';
  if (status === 'rejected') return '已拒绝';
  return '待审核';
}

export function AdminCustomerKnowledgeReviewPage({
  records,
  loading,
  onRefresh,
  onReview,
}: {
  records: KnowledgeRecord[];
  loading: boolean;
  onRefresh: () => void;
  onReview: (record: KnowledgeRecord, action: ReviewAction) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const reviews = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return records
      .filter(isCustomerUpload)
      .filter((record) => !normalizedQuery || `${record.company} ${record.productName} ${record.pageText || ''}`.toLowerCase().includes(normalizedQuery))
      .sort((left, right) => (
        Number((right.reviewStatus || 'pending') === 'pending') - Number((left.reviewStatus || 'pending') === 'pending')
        || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
      ));
  }, [query, records]);
  const selected = reviews.find((record) => Number(record.id) === selectedId) || null;
  const pendingCount = reviews.filter((record) => (record.reviewStatus || 'pending') === 'pending').length;

  if (selected) {
    const images = Array.isArray(selected.uploadImages) ? selected.uploadImages : [];
    const indicators = Array.isArray(selected.reviewIndicators) ? selected.reviewIndicators : [];
    return (
      <section className="space-y-4">
        <button type="button" onClick={() => setSelectedId(null)} className="flex items-center gap-2 text-sm font-black text-blue-700">
          <ChevronLeft size={18} />返回客户产品审核
        </button>
        <div className="rounded-[24px] border border-blue-100 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black text-blue-600">{selected.company}</p>
              <h2 className="mt-1 text-xl font-black text-slate-950">{selected.reviewProductName || '产品名称待确认'}</h2>
              <p className="mt-1 text-xs font-bold text-slate-400">状态：{statusLabel(selected.reviewStatus)}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={loading || selected.reviewStatus === 'approved'} onClick={() => onReview(selected, 'approved')} className="flex items-center gap-1 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white disabled:opacity-40"><Check size={16} />通过并全局生效</button>
              <button type="button" disabled={loading || selected.reviewStatus === 'rejected'} onClick={() => onReview(selected, 'rejected')} className="flex items-center gap-1 rounded-xl bg-rose-50 px-4 py-2 text-sm font-black text-rose-700 disabled:opacity-40"><X size={16} />拒绝</button>
            </div>
          </div>
        </div>

        <div className="rounded-[24px] border border-slate-100 bg-white p-5">
          <h3 className="flex items-center gap-2 text-base font-black text-slate-950"><ImageIcon size={18} />客户上传图片</h3>
          {images.length ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {images.map((image, index) => <img key={`${image.name}-${index}`} src={image.dataUrl} alt={image.name || `客户上传图片 ${index + 1}`} className="max-h-[520px] w-full rounded-2xl bg-slate-50 object-contain ring-1 ring-slate-200" />)}
            </div>
          ) : <p className="mt-3 rounded-xl bg-amber-50 px-3 py-3 text-sm font-bold text-amber-700">历史记录未保存原图；新上传记录会在这里显示图片。</p>}
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-[24px] border border-slate-100 bg-white p-5">
            <h3 className="text-base font-black text-slate-950">OCR 解析的保险责任</h3>
            <pre className="mt-3 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm font-medium leading-6 text-slate-700">{selected.pageText || '未解析到保险责任文本'}</pre>
          </div>
          <div className="rounded-[24px] border border-slate-100 bg-white p-5">
            <h3 className="text-base font-black text-slate-950">结构化保险指标</h3>
            <div className="mt-3 space-y-2">
              {indicators.length ? indicators.map((indicator, index) => (
                <article key={String(indicator.id || index)} className="rounded-2xl bg-slate-50 p-3">
                  <p className="text-xs font-black text-blue-600">{indicator.coverageType || '保险责任'}</p>
                  <p className="mt-1 text-sm font-black text-slate-900">{indicator.liability || '未命名指标'}</p>
                  {indicator.payout || indicator.scenario ? <p className="mt-1 text-xs font-medium leading-5 text-slate-600">{indicator.payout || indicator.scenario}</p> : null}
                  {indicator.sourceExcerpt ? <p className="mt-2 line-clamp-4 text-xs leading-5 text-slate-400">{indicator.sourceExcerpt}</p> : null}
                </article>
              )) : <p className="rounded-xl bg-slate-50 px-3 py-3 text-sm font-bold text-slate-500">暂未生成结构化指标，运营可先依据图片和责任文本审核。</p>}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-[28px] border border-blue-100 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-950">客户产品审核</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">审核客户上传的主险、附加险详情页；通过后才作用于全局知识库。</p>
        </div>
        <div className="flex items-center gap-2"><span className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-black text-amber-700">待审核 {pendingCount}</span><button type="button" onClick={onRefresh} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">刷新</button></div>
      </div>
      <label className="relative mt-4 block"><Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索保险公司或产品名称" className="h-11 w-full rounded-xl border border-slate-200 pl-10 pr-3 text-sm font-semibold" /></label>
      <div className="mt-4 space-y-2">
        {reviews.map((record) => (
          <article key={record.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-100">
            <button type="button" onClick={() => setSelectedId(Number(record.id))} className="min-w-0 flex-1 text-left"><p className="truncate text-sm font-black text-slate-950">产品名称：{record.reviewProductName || '待确认'}</p><p className="mt-1 truncate text-xs font-bold text-slate-500">保险公司：{record.company || '待确认'} · {record.uploadImages?.length || record.uploadNames?.length || 0} 张 · {statusLabel(record.reviewStatus)}</p>{record.productNameNeedsReview ? <p className="mt-1 text-xs font-black text-amber-600">原 OCR 名称不可信，请在详情中核对</p> : null}</button>
            <div className="flex gap-2"><button type="button" disabled={loading || record.reviewStatus === 'approved'} onClick={() => onReview(record, 'approved')} className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 disabled:opacity-40">通过</button><button type="button" disabled={loading || record.reviewStatus === 'rejected'} onClick={() => onReview(record, 'rejected')} className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 disabled:opacity-40">拒绝</button></div>
          </article>
        ))}
        {!reviews.length ? <p className="rounded-2xl bg-slate-50 px-4 py-10 text-center text-sm font-bold text-slate-400">暂无客户上传产品记录</p> : null}
      </div>
    </section>
  );
}
