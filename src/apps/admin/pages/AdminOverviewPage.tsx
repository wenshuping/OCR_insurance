import { AlertTriangle, CircleHelp, FileWarning, ListChecks } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AdminOverview, AdminReportIssueSummary, Policy } from '../../../api';
import { AdminStatCard } from '../../../features/admin-shared/AdminStatCard';
import { formatCoverageAmount, formatDateLabel } from '../../../shared/formatters';
import { isPolicyReportFailed } from '../../../shared/policy-report-ui';
import type { AdminPageKey } from '../adminPages';

export function AdminOverviewPage({
  overview,
  reportIssueReports,
  onNavigate,
}: {
  overview: AdminOverview | null;
  reportIssueReports: AdminReportIssueSummary[];
  onNavigate: (page: AdminPageKey) => void;
}) {
  const failedPolicies = (overview?.policies || []).filter(isPolicyReportFailed);
  const optionalGaps = overview?.optionalResponsibilityGaps || [];
  return (
    <div className="space-y-5">
      <section className="grid grid-cols-6 gap-3 max-[1200px]:grid-cols-3 max-[760px]:grid-cols-2">
        <AdminStatCard label="注册账号" value={`${overview?.summary.userCount || 0}`} />
        <AdminStatCard label="家庭数" value={`${overview?.summary.familyCount || 0}`} />
        <AdminStatCard label="被保人数" value={`${overview?.summary.insuredCount || 0}`} />
        <AdminStatCard label="保单总数" value={`${overview?.summary.policyCount || 0}`} />
        <AdminStatCard label="报告问题" value={`${reportIssueReports.length}`} />
        <AdminStatCard label="总保额" value={formatCoverageAmount(overview?.summary.totalCoverage || 0)} />
      </section>

      <section className="grid grid-cols-[1.2fr_0.8fr] gap-5 max-[1100px]:grid-cols-1">
        <QueueCard
          title="报告问题"
          icon={<ListChecks size={18} />}
          count={reportIssueReports.length}
          action="查看报告问题"
          onOpen={() => onNavigate('reportIssues')}
        >
          {reportIssueReports.slice(0, 5).map((report) => (
            <div key={report.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-black text-slate-950">{report.familyName}</p>
                <span className="rounded-full bg-white px-2 py-1 text-xs font-black text-slate-500">{report.issueCount}</span>
              </div>
              <p className="mt-1 text-xs font-semibold text-slate-500">{report.memberCount} 成员 · {report.policyCount} 保单 · {formatDateLabel(report.generatedAt)}</p>
            </div>
          ))}
        </QueueCard>

        <div className="space-y-5">
          <QueueCard
            title="可选责任缺口"
            icon={<CircleHelp size={18} />}
            count={optionalGaps.length}
            action="进入治理"
            onOpen={() => onNavigate('optionalResponsibilities')}
          >
            {optionalGaps.slice(0, 3).map((gap) => (
              <div key={gap.id} className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2.5">
                <p className="truncate text-sm font-black text-blue-900">{gap.productName}</p>
                <p className="mt-1 text-xs font-semibold text-blue-700">{gap.company} · {gap.liability}</p>
              </div>
            ))}
          </QueueCard>

          <QueueCard
            title="报告生成失败"
            icon={<FileWarning size={18} />}
            count={failedPolicies.length}
            action="查看保单"
            onOpen={() => onNavigate('policies')}
          >
            {failedPolicies.slice(0, 3).map((policy: Policy) => (
              <div key={policy.id} className="rounded-xl border border-red-100 bg-red-50 px-3 py-2.5">
                <p className="truncate text-sm font-black text-red-900">{policy.name}</p>
                <p className="mt-1 truncate text-xs font-semibold text-red-700">{policy.reportError || '报告生成失败'}</p>
              </div>
            ))}
          </QueueCard>
        </div>
      </section>
    </div>
  );
}

function QueueCard({
  title,
  icon,
  count,
  action,
  children,
  onOpen,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  action: string;
  children: ReactNode;
  onOpen: () => void;
}) {
  return (
    <section className="rounded-[18px] border border-slate-200 bg-white p-4 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
      <div className="mb-3 flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-base font-black text-slate-950">{title}</h2>
          {count ? <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-black text-slate-500">{count}</span> : null}
        </div>
        <button type="button" className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white transition hover:bg-blue-700" onClick={onOpen}>
          {action}
        </button>
      </div>
      <div className="space-y-2">
        {count ? children : (
          <p className="rounded-xl bg-slate-50 px-3 py-6 text-center text-sm font-bold text-slate-400">
            <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
            暂无待处理事项
          </p>
        )}
      </div>
    </section>
  );
}
