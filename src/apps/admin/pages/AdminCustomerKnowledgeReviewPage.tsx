import { useMemo, useState } from 'react';
import { Check, ChevronLeft, Image as ImageIcon, Search, X } from 'lucide-react';

import type { KnowledgeRecord } from '../../../api';

type ReviewAction = 'approved' | 'rejected' | 'pending';
type ReviewUpdates = { company?: string; productName?: string; pageText?: string };

function isCustomerUpload(record: KnowledgeRecord) {
  return record.sourceKind === 'customer_policy_photo' || record.sourceKind === 'customer_policy_terms';
}

function statusLabel(status = '') {
  if (status === 'approved') return '已发布到公共产品库';
  if (status === 'rejected') return '已拒绝 · 未发布';
  return '未发布 · 待运营发布';
}

function statusClassName(status = '') {
  if (status === 'approved') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (status === 'rejected') return 'bg-rose-50 text-rose-700 ring-rose-200';
  return 'bg-amber-50 text-amber-700 ring-amber-200';
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
  onReview: (record: KnowledgeRecord, action: ReviewAction, updates?: ReviewUpdates) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftCompany, setDraftCompany] = useState('');
  const [draftProductName, setDraftProductName] = useState('');
  const [draftPageText, setDraftPageText] = useState('');
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
  const openRecord = (record: KnowledgeRecord) => {
    setSelectedId(Number(record.id));
    setDraftCompany(record.company || '');
    setDraftProductName(record.reviewProductName || record.productName || '');
    setDraftPageText(record.pageText || '');
  };

  if (selected) {
    const isPublished = selected.reviewStatus === 'approved';
    const images = Array.isArray(selected.uploadImages) ? selected.uploadImages : [];
    const indicators = Array.isArray(selected.reviewIndicators) ? selected.reviewIndicators : [];
    const updates = { company: draftCompany.trim(), productName: draftProductName.trim(), pageText: draftPageText.trim() };
    const canSave = Boolean(updates.company && updates.productName && updates.pageText);
    const publishButtonClassName = isPublished
      ? 'bg-white text-emerald-700 ring-1 ring-emerald-200'
      : 'bg-emerald-600 text-white shadow-sm';
    const unpublishButtonClassName = isPublished
      ? 'bg-amber-500 text-white shadow-sm'
      : 'bg-white text-amber-700 ring-1 ring-amber-200';
    return (
      <section className="space-y-4">
        <button type="button" onClick={() => setSelectedId(null)} className="flex items-center gap-2 text-sm font-black text-blue-700">
          <ChevronLeft size={18} />返回客户上传责任审核
        </button>
        <div className="rounded-[24px] border border-blue-100 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black text-blue-600">客户上传保险责任</p>
              <h2 className="mt-1 text-xl font-black text-slate-950">{draftProductName || '产品名称待确认'}</h2>
              <span className={`mt-3 inline-flex rounded-full px-3 py-1.5 text-sm font-black ring-1 ${statusClassName(selected.reviewStatus)}`}>{statusLabel(selected.reviewStatus)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={loading || !canSave} onClick={() => onReview(selected, 'approved', updates)} className={`flex items-center gap-1 rounded-xl px-4 py-2 text-sm font-black disabled:opacity-40 ${publishButtonClassName}`}><Check size={16} />{isPublished ? '保存修改并重新发布' : '发布到公共产品库'}</button>
              <button type="button" disabled={loading || !canSave} onClick={() => onReview(selected, 'pending', updates)} className={`rounded-xl px-4 py-2 text-sm font-black disabled:opacity-40 ${unpublishButtonClassName}`}>保存为未发布</button>
              <button type="button" disabled={loading || selected.reviewStatus === 'rejected'} onClick={() => onReview(selected, 'rejected')} className="flex items-center gap-1 rounded-xl bg-rose-50 px-4 py-2 text-sm font-black text-rose-700 disabled:opacity-40"><X size={16} />拒绝</button>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-black text-slate-500">保险公司<input value={draftCompany} onChange={(event) => setDraftCompany(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-900" /></label>
            <label className="text-xs font-black text-slate-500">产品名称<input value={draftProductName} onChange={(event) => setDraftProductName(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-900" /></label>
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
            <h3 className="text-base font-black text-slate-950">待发布保险责任（可修改）</h3>
            <textarea value={draftPageText} onChange={(event) => setDraftPageText(event.target.value)} rows={18} className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium leading-6 text-slate-700" />
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
        <div className="rounded-[24px] border border-slate-100 bg-white p-5">
          <h3 className="text-base font-black text-slate-950">首次上传 OCR 原文（只读）</h3>
          <p className="mt-1 text-xs font-bold text-slate-400">原保险公司：{selected.originalCompany || selected.company || '待确认'} · 原产品名称：{selected.originalProductName || selected.productName || '待确认'}</p>
          <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm font-medium leading-6 text-slate-600">{selected.originalPageText || selected.pageText || '未保存 OCR 原文'}</pre>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-[28px] border border-blue-100 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-slate-950">客户上传保险责任审核</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">审核客户上传的主险、附加险责任页或合同页；审核通过后才进入公共产品库供其他保单复用。</p>
        </div>
        <div className="flex items-center gap-2"><span className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-black text-amber-700">待审核 {pendingCount}</span><button type="button" onClick={onRefresh} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">刷新</button></div>
      </div>
      <label className="relative mt-4 block"><Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索保险公司或产品名称" className="h-11 w-full rounded-xl border border-slate-200 pl-10 pr-3 text-sm font-semibold" /></label>
      <div className="mt-4 space-y-2">
        {reviews.map((record) => (
          <article key={record.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-100">
            <button type="button" onClick={() => openRecord(record)} className="min-w-0 flex-1 text-left"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-black text-slate-950">产品名称：{record.reviewProductName || record.productName || '待确认'}</p><span className={`rounded-full px-2.5 py-1 text-xs font-black ring-1 ${statusClassName(record.reviewStatus)}`}>{statusLabel(record.reviewStatus)}</span></div><p className="mt-1 truncate text-xs font-bold text-slate-500">保险公司：{record.company || '待确认'} · {record.uploadImages?.length || record.uploadNames?.length || 0} 张</p>{record.productNameNeedsReview ? <p className="mt-1 text-xs font-black text-amber-600">原 OCR 名称不可信，请在详情中核对</p> : null}</button>
            <div className="flex gap-2">{record.reviewStatus === 'approved' ? <button type="button" disabled={loading} onClick={() => onReview(record, 'pending')} className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-black text-amber-700 disabled:opacity-40">撤回</button> : <button type="button" disabled={loading} onClick={() => onReview(record, 'approved')} className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 disabled:opacity-40">发布</button>}<button type="button" disabled={loading || record.reviewStatus === 'rejected'} onClick={() => onReview(record, 'rejected')} className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 disabled:opacity-40">拒绝</button></div>
          </article>
        ))}
        {!reviews.length ? <p className="rounded-2xl bg-slate-50 px-4 py-10 text-center text-sm font-bold text-slate-400">暂无客户上传产品记录</p> : null}
      </div>
    </section>
  );
}
