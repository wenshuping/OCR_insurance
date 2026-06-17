import type { AdminReportCorrection, AdminReportIssue, AdminReportIssueSummary } from '../../../api';
import { formatDateLabel } from '../../../shared/formatters';

export function AdminReportIssuesPage({
  reports,
  selectedReport,
  issues,
  corrections,
  loading,
  onRefresh,
  onOpenReport,
}: {
  reports: AdminReportIssueSummary[];
  selectedReport: AdminReportIssueSummary | null;
  issues: AdminReportIssue[];
  corrections: AdminReportCorrection[];
  loading: boolean;
  onRefresh: () => void;
  onOpenReport: (report: AdminReportIssueSummary) => void;
}) {
  return (
    <div className="grid grid-cols-[420px_minmax(0,1fr)] gap-5 max-[1100px]:grid-cols-1">
      <section className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.42)]">
        <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-xl font-black">报告问题</h2>
            <p className="mt-1 text-sm text-slate-500">只展示已落库的当前有效报告问题</p>
          </div>
          <button type="button" onClick={onRefresh} className="rounded-xl bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 transition hover:bg-blue-100">
            {loading ? '刷新中' : '刷新'}
          </button>
        </div>
        <div className="max-h-[calc(100vh-220px)] space-y-2 overflow-auto pr-1">
          {reports.map((report) => {
            const active = Number(selectedReport?.id || 0) === Number(report.id);
            return (
              <button
                key={report.id}
                type="button"
                onClick={() => onOpenReport(report)}
                className={[
                  'w-full rounded-[16px] border px-4 py-3 text-left transition',
                  active ? 'border-blue-600 bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'border-blue-50 bg-blue-50/60 text-slate-950 hover:border-blue-200 hover:bg-white',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-black">{report.familyName}</p>
                    <p className={active ? 'mt-1 text-xs font-semibold text-white/60' : 'mt-1 text-xs font-semibold text-slate-500'}>
                      {report.memberCount} 成员 · {report.policyCount} 保单 · {formatDateLabel(report.generatedAt)}
                    </p>
                  </div>
                  <span className={active ? 'rounded-full bg-white/10 px-2.5 py-1 text-xs font-black text-white' : 'rounded-full bg-white px-2.5 py-1 text-xs font-black text-slate-500'}>
                    {report.issueCount}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-black">
                  {report.errorCount ? <span className="rounded-full bg-red-50 px-2 py-1 text-red-600">{report.errorCount} 严重</span> : null}
                  {report.warningCount ? <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700">{report.warningCount} 提醒</span> : null}
                  {report.autoAppliedCorrectionCount ? <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700">{report.autoAppliedCorrectionCount} 已修正</span> : null}
                  {report.pendingCorrectionCount ? <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700">{report.pendingCorrectionCount} 待确认</span> : null}
                </div>
              </button>
            );
          })}
          {!reports.length ? <p className="rounded-[16px] bg-slate-50 px-4 py-8 text-center text-sm font-bold text-slate-400">暂无已落库报告问题</p> : null}
        </div>
      </section>

      <section className="min-w-0 rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.42)]">
        <div className="mb-4 border-b border-slate-100 pb-4">
          <h2 className="text-xl font-black">{selectedReport?.familyName || '问题详情'}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {selectedReport ? `${selectedReport.issueCount} 个问题，生成于 ${formatDateLabel(selectedReport.generatedAt)}` : '点击左侧报告查看具体问题'}
          </p>
        </div>
        <div className="space-y-3">
          {issues.map((issue) => {
            const severityClassName = issue.severity === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : issue.severity === 'warning'
                ? 'border-blue-100 bg-blue-50 text-blue-700'
                : 'border-slate-200 bg-slate-50 text-slate-600';
            return (
              <article key={issue.id} className={`rounded-[16px] border p-4 ${severityClassName}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-black">{issue.title}</p>
                    <p className="mt-2 break-words text-sm font-semibold leading-6">{issue.detail}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <span className="rounded-full bg-white/70 px-2.5 py-1 text-xs font-black">{issue.category}</span>
                    {issue.correctionLabel ? <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-black">{issue.correctionLabel}</span> : null}
                  </div>
                </div>
                {issue.suggestion ? <p className="mt-3 break-words rounded-xl bg-white/70 px-3 py-2 text-xs font-bold leading-5">处理建议：{issue.suggestion}</p> : null}
                {issue.correctionReason ? <p className="mt-2 break-words rounded-xl bg-white/70 px-3 py-2 text-xs font-bold leading-5">处理结果：{issue.correctionReason}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold opacity-75">
                  {issue.memberName ? <span>成员：{issue.memberName}</span> : null}
                  {issue.productName ? <span>产品：{issue.productName}</span> : null}
                  {issue.dimension ? <span>维度：{issue.dimension}</span> : null}
                  <span>来源：{issue.source}</span>
                </div>
              </article>
            );
          })}
          {corrections.length ? (
            <div className="rounded-[16px] border border-slate-100 bg-slate-50 p-4">
              <p className="text-sm font-black text-slate-900">修正记录</p>
              <div className="mt-3 space-y-2">
                {corrections.map((correction) => (
                  <div key={correction.id} className="rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{correction.productName || '未定位产品'} · {correction.dimension} · {correction.action}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1">{correction.status}</span>
                    </div>
                    <p className="mt-1 break-words leading-5">{correction.reason}</p>
                    {correction.notAppliedReason ? <p className="mt-1 break-words leading-5 text-blue-700">未自动修正：{correction.notAppliedReason}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {selectedReport && !issues.length ? <p className="rounded-[16px] bg-slate-50 px-4 py-8 text-center text-sm font-bold text-slate-400">正在加载或暂无详情</p> : null}
        </div>
      </section>
    </div>
  );
}
