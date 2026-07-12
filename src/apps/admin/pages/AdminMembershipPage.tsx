import type { AdminMembershipConfig } from '../../../api';

export function AdminMembershipPage({
  config,
  quotaInput,
  familyReportDailyRefreshLimitInput,
  familySalesReviewDailyRefreshLimitInput,
  saving,
  onToggleEnabled,
  onQuotaInputChange,
  onFamilyReportDailyRefreshLimitInputChange,
  onFamilySalesReviewDailyRefreshLimitInputChange,
  onSave,
}: {
  config: AdminMembershipConfig | null;
  quotaInput: string;
  familyReportDailyRefreshLimitInput: string;
  familySalesReviewDailyRefreshLimitInput: string;
  saving: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onQuotaInputChange: (value: string) => void;
  onFamilyReportDailyRefreshLimitInputChange: (value: string) => void;
  onFamilySalesReviewDailyRefreshLimitInputChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <section className="max-w-xl rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
      <div className="mb-5 flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h2 className="text-lg font-black text-slate-950">会员与报告刷新设置</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">控制会员购买、免费保单额度和用户每日主动刷新次数</p>
        </div>
        <span className="rounded-xl bg-blue-50 px-3 py-1.5 text-xs font-black text-blue-700">300 元/年</span>
      </div>
      <label className="flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-slate-50 px-3 py-3">
        <span className="text-sm font-bold text-slate-700">开放会员购买</span>
        <input
          type="checkbox"
          checked={config?.enabled ?? true}
          onChange={(event) => onToggleEnabled(event.target.checked)}
        />
      </label>
      <label className="mt-4 block">
        <span className="text-xs font-black text-slate-400">注册用户免费保存保单数</span>
        <input
          className="mt-1 h-11 w-full rounded-xl border border-blue-100 bg-white px-3 text-sm font-bold text-slate-900 outline-none transition focus:border-blue-400"
          type="number"
          min="0"
          value={quotaInput}
          onChange={(event) => onQuotaInputChange(event.target.value)}
        />
      </label>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-black text-slate-400">家庭保单分析报告每日刷新次数</span>
          <input
            className="mt-1 h-11 w-full rounded-xl border border-blue-100 bg-white px-3 text-sm font-bold text-slate-900 outline-none transition focus:border-blue-400"
            type="number"
            min="0"
            value={familyReportDailyRefreshLimitInput}
            onChange={(event) => onFamilyReportDailyRefreshLimitInputChange(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-xs font-black text-slate-400">营销建议报告每日刷新次数</span>
          <input
            className="mt-1 h-11 w-full rounded-xl border border-blue-100 bg-white px-3 text-sm font-bold text-slate-900 outline-none transition focus:border-blue-400"
            type="number"
            min="0"
            value={familySalesReviewDailyRefreshLimitInput}
            onChange={(event) => onFamilySalesReviewDailyRefreshLimitInputChange(event.target.value)}
          />
        </label>
      </div>
      <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">刷新次数只统计用户在前台主动点击重新生成，不统计后台查看、后台自动修正或系统自动生成。</p>
      <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">年费价格 300 元，有效期 365 天。免费额度只按已成功保存保单数计算。</p>
      <button
        className="mt-4 h-11 w-full rounded-xl bg-blue-600 px-4 text-sm font-black text-white shadow-[0_14px_36px_-24px_rgba(37,99,235,0.75)] transition hover:bg-blue-700 disabled:opacity-60"
        type="button"
        disabled={!config || saving}
        onClick={onSave}
      >
        {saving ? '保存中...' : '保存会员设置'}
      </button>
    </section>
  );
}
