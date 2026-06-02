import { Sparkles } from 'lucide-react';

import type { AdminOcrConfig } from '../../api';
import {
  formatDateLabel,
  formatOcrModeLabel,
} from '../../shared/formatters';

export function AdminOcrModePanel({
  config,
  loading,
  onRefresh,
  onChange,
}: {
  config: AdminOcrConfig | null;
  loading: boolean;
  onRefresh: () => void;
  onChange: (mode: string) => void;
}) {
  const currentMode = config?.config.mode || '';
  const updatedAt = config?.config.updatedAt ? formatDateLabel(config.config.updatedAt) : '';

  return (
    <section className="rounded-[22px] border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black">
            <Sparkles size={16} />
            OCR 识别方式
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">{config ? config.runtime.providerLabel : '正在读取配置'}</p>
        </div>
        <button className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-50" type="button" disabled={loading} onClick={onRefresh}>
          刷新
        </button>
      </div>

      <div className="space-y-2">
        {(config?.options || []).map((option) => {
          const active = option.value === currentMode;
          return (
            <button
              key={option.value}
              type="button"
              disabled={loading || active || !option.selectable}
              onClick={() => onChange(option.value)}
              className={[
                'w-full rounded-2xl border px-3 py-3 text-left transition disabled:cursor-not-allowed',
                active
                  ? 'border-slate-950 bg-slate-950 text-white'
                  : option.selectable
                    ? 'border-slate-200 bg-slate-50 hover:border-slate-400'
                    : 'border-slate-100 bg-slate-50 text-slate-400',
              ].join(' ')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-black">{formatOcrModeLabel(option.value)}</span>
                <span className={active ? 'text-xs font-black text-white/70' : 'text-xs font-black text-slate-400'}>
                  {active ? '当前' : option.selectable ? '可切换' : '不可用'}
                </span>
              </div>
              <p className={active ? 'mt-1 text-xs font-medium leading-5 text-white/70' : 'mt-1 text-xs font-medium leading-5 text-slate-500'}>{option.description}</p>
            </button>
          );
        })}
        {!config ? <div className="rounded-2xl bg-slate-50 px-3 py-4 text-sm font-bold text-slate-500">{loading ? '加载中...' : '暂无 OCR 配置'}</div> : null}
      </div>

      <p className="mt-3 text-xs font-medium text-slate-400">
        当前模式：{formatOcrModeLabel(currentMode)}
        {updatedAt ? ` · ${updatedAt}` : ''}
      </p>
      {config?.runtime.localVisionFallback ? (
        <p className="mt-2 rounded-2xl bg-blue-50 px-3 py-2 text-xs font-bold leading-5 text-blue-700">
          本地视觉兜底：
          {config.runtime.localVisionFallback.enabled
            ? '已启用（仅图片，不处理 PDF）'
            : '未启用（仅图片，不处理 PDF）'}
        </p>
      ) : null}
    </section>
  );
}
