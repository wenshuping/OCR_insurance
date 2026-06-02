import type { OptionalResponsibilityGap } from '../../api';

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
  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black">可选责任量化缺口</p>
          <p className="mt-1 text-xs font-medium text-slate-400">已识别但未完成结构化指标的可选责任</p>
        </div>
        <button type="button" disabled={loading} onClick={onReextract} className="rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-black text-white disabled:opacity-50">
          重新拆解
        </button>
      </div>
      <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
        {gaps.map((gap) => (
          <article key={gap.id} className="rounded-[16px] border border-amber-100 bg-amber-50 px-3 py-2.5 text-xs">
            <p className="font-black text-amber-900">{gap.productName}</p>
            <p className="mt-1 font-semibold text-amber-800">{gap.company} · {gap.liability}</p>
            <p className="mt-1 leading-5 text-amber-700">{gap.quantificationReason}</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="rounded-full bg-white px-2.5 py-1 font-black text-amber-700">{gap.recentPolicyCount} 张相关保单</span>
              <button type="button" disabled={loading} onClick={() => onMarkNotQuantifiable(gap)} className="rounded-full bg-white px-2.5 py-1 font-black text-slate-700 ring-1 ring-amber-100 disabled:opacity-50">
                标记不可量化
              </button>
            </div>
          </article>
        ))}
        {!gaps.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无量化缺口</p> : null}
      </div>
    </section>
  );
}
