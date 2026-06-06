import {
  type ChangeEvent,
  useRef,
} from 'react';
import {
  Loader2,
  Plus,
  X,
} from 'lucide-react';
import type {
  CashValueRow,
  CashValueScanResult,
} from '../../api';

export function CashValueDialog(props: {
  editRows: CashValueRow[];
  loading: boolean;
  message: string;
  open: boolean;
  scanResult: CashValueScanResult | null;
  onAddRow: () => void;
  onCancel: () => void;
  onCellEdit: (rowIndex: number, field: 'policyYear' | 'age' | 'cashValue', value: string) => void;
  onConfirm: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveRow: (rowIndex: number) => void;
  onResetForRescan: () => void;
  onStartManualEntry: () => void;
}) {
  const {
    editRows,
    loading,
    message,
    open,
    scanResult,
    onAddRow,
    onCancel,
    onCellEdit,
    onConfirm,
    onFileChange,
    onRemoveRow,
    onResetForRescan,
    onStartManualEntry,
  } = props;
  const cashValueInputRef = useRef<HTMLInputElement | null>(null);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        {!scanResult ? (
          /* Step 1: Upload prompt */
          <div className="text-center">
            <h3 className="mb-2 text-lg font-bold text-slate-800">
              录入保单现金价值
            </h3>
            <p className="mb-5 text-sm text-slate-500">
              从本地照片或拍照上传保单的现金价值页面，系统将自动识别并录入
            </p>
            {message && (
              <p className="mb-3 text-sm text-red-500">{message}</p>
            )}
            {loading && (
              <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-left" aria-live="polite">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-black text-blue-700">现金价值表识别中</span>
                  <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-blue-100"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuetext="正在识别现金价值表"
                >
                  <div className="h-full w-1/2 rounded-full bg-blue-500 animate-[cash-value-progress_1.35s_ease-in-out_infinite]" />
                </div>
              </div>
            )}
            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                className="rounded-lg bg-[#0B72B9] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                disabled={loading}
                onClick={() => cashValueInputRef.current?.click()}
              >
                本地照片上传
              </button>
              <button
                type="button"
                className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                disabled={loading}
                onClick={onStartManualEntry}
              >
                手动录入
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600"
                onClick={onCancel}
              >
                暂时跳过
              </button>
            </div>
          </div>
        ) : (
          /* Step 2: Preview and edit results */
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-slate-800">
                {scanResult.source === 'manual' ? '录入现金价值' : '现金价值表识别结果'}
              </h3>
              <span className="text-xs text-slate-400">
                {scanResult.source === 'manual' ? '手动录入' : scanResult.source === 'macos_vision' ? '本机Vision' : scanResult.source === 'vision_llm' ? 'AI识别' : 'Paddle OCR'}
                {scanResult.confidence != null && ` · 置信度 ${Math.round(scanResult.confidence * 100)}%`}
              </span>
            </div>
            {message && (
              <p className="mb-2 text-sm text-red-500">{message}</p>
            )}
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 ring-1 ring-emerald-100"
                onClick={onAddRow}
              >
                <Plus size={14} />
                添加年度
              </button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="px-2 py-1.5 text-left font-bold text-slate-600">保单年度</th>
                    {scanResult.tableType === 3 && (
                      <th className="px-2 py-1.5 text-left font-bold text-slate-600">年龄</th>
                    )}
                    <th className="px-2 py-1.5 text-left font-bold text-slate-600">现金价值(元)</th>
                    <th className="w-10 px-2 py-1.5 text-right font-bold text-slate-600">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {editRows.map((row, i) => (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="px-1 py-0.5">
                        <input
                          type="text"
                          className="w-16 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                          defaultValue={row.policyYear}
                          onBlur={(e) => onCellEdit(i, 'policyYear', e.target.value)}
                        />
                      </td>
                      {scanResult.tableType === 3 && (
                        <td className="px-1 py-0.5">
                          <input
                            type="text"
                            className="w-14 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                            defaultValue={row.age ?? ''}
                            onBlur={(e) => onCellEdit(i, 'age', e.target.value)}
                          />
                        </td>
                      )}
                      <td className="px-1 py-0.5">
                        <input
                          type="text"
                          className="w-24 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                          defaultValue={row.cashValue.toLocaleString('zh-CN')}
                          onBlur={(e) => onCellEdit(i, 'cashValue', e.target.value)}
                        />
                      </td>
                      <td className="px-1 py-0.5 text-right">
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-50 text-slate-400 active:bg-red-50 active:text-red-500"
                          onClick={() => onRemoveRow(i)}
                          aria-label="删除现金价值行"
                        >
                          <X size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex gap-2 justify-center">
              <button
                type="button"
                className="rounded-lg bg-[#0B72B9] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                disabled={loading || editRows.length === 0}
                onClick={onConfirm}
              >
                确认保存
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 disabled:opacity-50"
                disabled={loading}
                onClick={() => {
                  onResetForRescan();
                  cashValueInputRef.current?.click();
                }}
              >
                {scanResult.source === 'manual' ? '上传照片识别' : '重新上传照片'}
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-400"
                onClick={onCancel}
              >
                取消
              </button>
            </div>
          </div>
        )}
        <input
          ref={cashValueInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFileChange}
        />
      </div>
    </div>
  );
}
