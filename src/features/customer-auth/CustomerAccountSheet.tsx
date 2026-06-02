import {
  CircleUserRound,
  FileText,
  LogOut,
  X,
} from 'lucide-react';

export function CustomerAccountSheet(props: {
  insuredCount: number;
  isLoggedIn: boolean;
  mobile: string;
  onClose: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onOpenPolicies: () => void;
  policyCount: number;
}) {
  const { insuredCount, isLoggedIn, mobile, onClose, onLogin, onLogout, onOpenPolicies, policyCount } = props;
  return (
    <div className="fixed inset-0 z-[75] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-500 text-white shadow-lg shadow-blue-500/25">
              <CircleUserRound size={24} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-950">我的账号</h2>
              <p className="mt-1 truncate text-sm font-semibold text-slate-500">{isLoggedIn ? mobile : '游客模式'}</p>
            </div>
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
            aria-label="关闭账号"
          >
            <X size={18} />
          </button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-black text-slate-400">登录账号</p>
          <p className="mt-2 break-all text-xl font-black text-slate-950">{isLoggedIn ? mobile : '未登录'}</p>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-black text-slate-400">我的保单</p>
            <p className="mt-2 text-2xl font-black text-slate-950">{policyCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-black text-slate-400">被保人</p>
            <p className="mt-2 text-2xl font-black text-slate-950">{insuredCount}</p>
          </div>
        </div>

        <div className="mt-5 grid gap-2">
          <button
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-sm font-black text-slate-700 transition-colors hover:bg-slate-50"
            type="button"
            aria-current="page"
          >
            <CircleUserRound size={18} />
            我的基本信息
          </button>
          <button
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-blue-100 bg-blue-50 text-sm font-black text-blue-700 transition-colors hover:bg-blue-100"
            type="button"
            onClick={onOpenPolicies}
          >
            <FileText size={18} />
            我的保单
          </button>
        </div>

        {isLoggedIn ? (
          <button
            className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 text-sm font-black text-red-600 transition-colors hover:bg-red-100"
            type="button"
            onClick={onLogout}
          >
            <LogOut size={19} />
            退出
          </button>
        ) : (
          <button className="mt-2 flex h-12 w-full items-center justify-center rounded-xl bg-blue-500 text-sm font-black text-white shadow-lg shadow-blue-500/25" type="button" onClick={onLogin}>
            验证手机号
          </button>
        )}
      </section>
    </div>
  );
}
