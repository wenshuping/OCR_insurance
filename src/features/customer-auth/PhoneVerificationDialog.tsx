export function PhoneVerificationDialog(props: {
  code: string;
  devCode: string;
  loading: boolean;
  message: string;
  mobile: string;
  onChangeCode: (value: string) => void;
  onChangeMobile: (value: string) => void;
  onClose: () => void;
  onSendCode: () => void;
  onVerify: () => void;
}) {
  const { code, devCode, loading, message, mobile, onChangeCode, onChangeMobile, onClose, onSendCode, onVerify } = props;
  return (
    <div className="fixed inset-0 z-[80] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-black text-slate-950">手机验证码</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">录入或上传保单前需要验证手机号；仅查询保险责任无需验证。</p>
          </div>
          <button className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500" type="button" onClick={onClose}>
            稍后
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-black text-slate-500">手机号</span>
            <input
              value={mobile}
              onChange={(event) => onChangeMobile(event.target.value.replace(/[^\d]/g, '').slice(0, 11))}
              inputMode="tel"
              placeholder="请输入手机号"
              className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-blue-500"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-black text-slate-500">验证码</span>
            <div className="flex gap-2">
              <input
                value={code}
                onChange={(event) => onChangeCode(event.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder="6 位验证码"
                className="h-12 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-blue-500"
              />
              <button
                className="h-12 rounded-xl bg-blue-500 px-4 text-sm font-black text-white shadow-lg shadow-blue-500/20 transition-colors hover:bg-blue-600 disabled:opacity-50"
                type="button"
                disabled={loading || mobile.trim().length !== 11}
                onClick={onSendCode}
              >
                发验证码
              </button>
            </div>
          </label>
        </div>

        <p className="mt-3 rounded-xl bg-blue-50 px-4 py-3 text-sm font-bold leading-6 text-blue-700">{devCode ? `本地验证码：${devCode}` : message}</p>

        <button
          className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-blue-500 text-base font-black text-white shadow-lg shadow-blue-500/25 disabled:opacity-60"
          type="button"
          disabled={loading || mobile.trim().length !== 11 || code.trim().length !== 6}
          onClick={onVerify}
        >
          {loading ? '处理中...' : '验证并继续录入'}
        </button>
      </section>
    </div>
  );
}
