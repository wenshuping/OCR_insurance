import type { AdminOcrScenarioRouting } from '../../../api';

export function AdminOcrRoutingPage({
  routing,
  saving,
  onChange,
  onSave,
}: {
  routing: AdminOcrScenarioRouting | null;
  saving: boolean;
  onChange: (scenario: string, provider: string) => void;
  onSave: () => void;
}) {
  return (
    <section className="max-w-2xl rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
      <h2 className="text-lg font-black text-slate-950">OCR 模型路由</h2>
      <p className="mt-1 text-sm font-semibold text-slate-500">不同业务场景可使用不同模型，保存后新上传请求立即生效。</p>
      <div className="mt-5 space-y-3">
        {(routing?.scenarios || []).map((scenario) => (
          <label key={scenario.key} className="grid gap-2 rounded-[14px] border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[180px_1fr] sm:items-center">
            <span className="text-sm font-black text-slate-700">{scenario.label}</span>
            <select
              className="h-11 rounded-xl border border-blue-100 bg-white px-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-400"
              value={routing?.config.routes[scenario.key] || ''}
              onChange={(event) => onChange(scenario.key, event.target.value)}
            >
              {(routing?.models || []).map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
          </label>
        ))}
      </div>
      <button
        className="mt-5 h-11 w-full rounded-xl bg-blue-600 px-4 text-sm font-black text-white disabled:opacity-60"
        type="button"
        disabled={!routing || saving}
        onClick={onSave}
      >
        {saving ? '保存中...' : '保存 OCR 模型路由'}
      </button>
    </section>
  );
}
