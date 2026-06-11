import { Crown, RefreshCw, X } from 'lucide-react';

import type { MembershipStatus } from '../../api/contracts/membership';

function priceText(cents: number) {
  return `￥${(cents / 100).toFixed(0)}`;
}

export function MembershipPurchaseDialog(props: {
  loading: boolean;
  message: string;
  membershipStatus: MembershipStatus | null;
  onClose: () => void;
  onPurchase: () => void;
  onRefresh: () => void;
}) {
  const { loading, message, membershipStatus, onClose, onPurchase, onRefresh } = props;
  const price = membershipStatus?.purchase.annualPriceCents ?? 30000;
  const saved = membershipStatus?.quota.savedPolicyCount ?? 0;
  const quota = membershipStatus?.quota.freeQuota ?? 0;
  return (
    <div className="fixed inset-0 z-[90] flex items-end bg-slate-950/40 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg shadow-amber-500/25">
              <Crown size={23} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-950">年费会员</h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">继续录入和保存更多保单</p>
            </div>
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
            aria-label="关闭会员"
          >
            <X size={18} />
          </button>
        </div>
        <div className="mt-5 rounded-2xl border border-amber-100 bg-amber-50 p-4">
          <p className="text-xs font-black text-amber-700">年费</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{priceText(price)}</p>
          <p className="mt-1 text-sm font-bold text-slate-600">有效期 365 天</p>
        </div>
        <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-bold text-slate-600">已保存 {saved}/{quota} 张免费保单</p>
        </div>
        {message ? <p className="mt-3 text-sm font-semibold text-slate-600">{message}</p> : null}
        <button
          className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-amber-500 text-sm font-black text-white shadow-lg shadow-amber-500/25 transition-colors hover:bg-amber-600 disabled:opacity-60"
          type="button"
          onClick={onPurchase}
          disabled={loading}
        >
          {loading ? '处理中...' : `微信支付 ${priceText(price)}`}
        </button>
        <button
          className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-sm font-black text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
          type="button"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw size={17} />
          刷新会员状态
        </button>
      </section>
    </div>
  );
}
