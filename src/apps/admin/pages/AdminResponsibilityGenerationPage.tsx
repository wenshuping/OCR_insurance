import type { AdminResponsibilityGenerationConfig } from '../../../api';

export function AdminResponsibilityGenerationPage({
  config,
  rulesText,
  blockedTitlesText,
  examplesText,
  saving,
  onToggleEnabled,
  onRulesTextChange,
  onBlockedTitlesTextChange,
  onExamplesTextChange,
  onFallbackModeChange,
  onPlannerModeChange,
  onSave,
}: {
  config: AdminResponsibilityGenerationConfig | null;
  rulesText: string;
  blockedTitlesText: string;
  examplesText: string;
  saving: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onRulesTextChange: (value: string) => void;
  onBlockedTitlesTextChange: (value: string) => void;
  onExamplesTextChange: (value: string) => void;
  onFallbackModeChange: (value: AdminResponsibilityGenerationConfig['fallbackMode']) => void;
  onPlannerModeChange: (value: AdminResponsibilityGenerationConfig['plannerMode']) => void;
  onSave: () => void;
}) {
  return (
    <section className="max-w-4xl rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
      <div className="mb-5 flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h2 className="text-lg font-black text-slate-950">保险责任自我修正</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">打开后用于下一次 DeepSeek 责任摘要生成、校验和重试</p>
        </div>
        <span className="rounded-xl bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-700">热生效</span>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-slate-50 px-3 py-3">
        <span className="text-sm font-bold text-slate-700">启用自我修正机制</span>
        <input
          type="checkbox"
          checked={config?.enabled ?? true}
          onChange={(event) => onToggleEnabled(event.target.checked)}
        />
      </label>

      <div className="mt-4 rounded-[14px] border border-slate-200 bg-slate-50 px-3 py-3">
        <p className="text-xs font-black text-slate-400">Planner 模式</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-700 ring-1 ring-slate-100">
            <input
              type="radio"
              checked={(config?.plannerMode || 'auto') === 'auto'}
              onChange={() => onPlannerModeChange('auto')}
            />
            自动
          </label>
          <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-700 ring-1 ring-slate-100">
            <input
              type="radio"
              checked={config?.plannerMode === 'all'}
              onChange={() => onPlannerModeChange('all')}
            />
            全部Planner
          </label>
          <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-700 ring-1 ring-slate-100">
            <input
              type="radio"
              checked={config?.plannerMode === 'off'}
              onChange={() => onPlannerModeChange('off')}
            />
            关闭Planner
          </label>
        </div>
      </div>

      <label className="mt-4 block">
        <span className="text-xs font-black text-slate-400">提示词硬性规则</span>
        <textarea
          className="mt-1 min-h-40 w-full rounded-xl border border-blue-100 bg-white px-3 py-2 text-sm font-semibold leading-6 text-slate-900 outline-none transition focus:border-blue-400"
          value={rulesText}
          onChange={(event) => onRulesTextChange(event.target.value)}
        />
      </label>

      <label className="mt-4 block">
        <span className="text-xs font-black text-slate-400">禁止作为责任标题</span>
        <textarea
          className="mt-1 min-h-28 w-full rounded-xl border border-blue-100 bg-white px-3 py-2 text-sm font-semibold leading-6 text-slate-900 outline-none transition focus:border-blue-400"
          value={blockedTitlesText}
          onChange={(event) => onBlockedTitlesTextChange(event.target.value)}
        />
      </label>

      <label className="mt-4 block">
        <span className="text-xs font-black text-slate-400">失败样例库</span>
        <textarea
          className="mt-1 min-h-36 w-full rounded-xl border border-blue-100 bg-white px-3 py-2 text-sm font-semibold leading-6 text-slate-900 outline-none transition focus:border-blue-400"
          value={examplesText}
          onChange={(event) => onExamplesTextChange(event.target.value)}
        />
      </label>

      <div className="mt-4 rounded-[14px] border border-slate-200 bg-slate-50 px-3 py-3">
        <p className="text-xs font-black text-slate-400">二次失败策略</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-700 ring-1 ring-slate-100">
            <input
              type="radio"
              checked={(config?.fallbackMode || 'official_text_after_second_failure') === 'official_text_after_second_failure'}
              onChange={() => onFallbackModeChange('official_text_after_second_failure')}
            />
            显示保险责任正文
          </label>
          <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-700 ring-1 ring-slate-100">
            <input
              type="radio"
              checked={config?.fallbackMode === 'needs_review'}
              onChange={() => onFallbackModeChange('needs_review')}
            />
            标记人工复核
          </label>
        </div>
      </div>

      <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">
        失败样例每行格式：错误输出 | 失败原因 | 正确处理。关闭后不会注入后台规则、不会回灌失败原因，也不会触发二次失败原文兜底。
      </p>

      <button
        className="mt-4 h-11 w-full rounded-xl bg-blue-600 px-4 text-sm font-black text-white shadow-[0_14px_36px_-24px_rgba(37,99,235,0.75)] transition hover:bg-blue-700 disabled:opacity-60"
        type="button"
        disabled={!config || saving}
        onClick={onSave}
      >
        {saving ? '保存中...' : '保存自我修正设置'}
      </button>
    </section>
  );
}
