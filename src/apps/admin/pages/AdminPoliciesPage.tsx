import type { Policy } from '../../../api';
import { AdminPolicyDetail } from '../../../features/admin-policy-detail/AdminPolicyDetail';
import { formatCoverageAmount, formatDateLabel } from '../../../shared/formatters';
import { isPolicyReportFailed, isPolicyReportGenerating } from '../../../shared/policy-report-ui';

export function AdminPoliciesPage({
  filteredPolicies,
  selectedAdminUserLabel,
  selectedPolicy,
  retryingPolicyId,
  onClearUserFilter,
  onSelectPolicy,
  onRetryPolicyReport,
}: {
  filteredPolicies: Policy[];
  selectedAdminUserLabel: string;
  selectedPolicy: Policy | null;
  retryingPolicyId: number | null;
  onClearUserFilter: () => void;
  onSelectPolicy: (policy: Policy | null) => void;
  onRetryPolicyReport: (policy: Policy) => void;
}) {
  return (
    <>
      <section className="min-w-0 rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.42)]">
        <div className="mb-4 flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-xl font-black">{selectedAdminUserLabel ? '注册用户保单' : '全部保单'}</h2>
            <p className="mt-1 text-sm text-slate-500">
              {selectedAdminUserLabel ? `当前只看 ${selectedAdminUserLabel} 名下的保单。` : '只读列表，点击查看 OCR 原文和责任解析。'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {selectedAdminUserLabel ? (
              <button
                className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white transition hover:bg-blue-700"
                type="button"
                onClick={onClearUserFilter}
              >
                清除用户筛选
              </button>
            ) : null}
            <span className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-500">{filteredPolicies.length} 条</span>
          </div>
        </div>

        <div className="overflow-hidden rounded-[16px] border border-slate-200">
          <div className="grid grid-cols-[1.05fr_1.45fr_0.9fr_0.85fr_0.8fr_0.8fr] bg-slate-50 px-4 py-3 text-xs font-black text-slate-500 max-[980px]:hidden">
            <div>注册用户</div>
            <div>产品</div>
            <div>被保人</div>
            <div>保司</div>
            <div>保额</div>
            <div>录入时间</div>
          </div>
          <div className="max-h-[calc(100vh-230px)] divide-y divide-slate-100 overflow-auto">
            {filteredPolicies.map((policy) => {
              const reportSummary = isPolicyReportGenerating(policy)
                ? '报告生成中'
                : isPolicyReportFailed(policy)
                  ? policy.reportError || '报告生成失败'
                  : policy.report || `已生成 ${Array.isArray(policy.responsibilities) ? policy.responsibilities.length : 0} 项保险责任`;
              return (
                <button
                  key={policy.id}
                  type="button"
                  onClick={() => onSelectPolicy(policy)}
                  className="grid w-full grid-cols-[1.05fr_1.45fr_0.9fr_0.85fr_0.8fr_0.8fr] items-center px-4 py-3 text-left text-sm transition hover:bg-slate-50 max-[980px]:block"
                >
                  <div className="font-mono font-bold text-slate-600">{formatAdminMobile(policy.userMobile || '')}</div>
                  <div className="min-w-0 pr-3 font-black text-slate-950 max-[980px]:mt-2">
                    <span className="block truncate">{policy.name}</span>
                    <span className="mt-1 block truncate text-xs font-medium text-slate-500">{reportSummary}</span>
                  </div>
                  <div className="truncate pr-3 max-[980px]:mt-2">{policy.insured || '未识别'}</div>
                  <div className="truncate pr-3">{policy.company}</div>
                  <div className="font-bold">{formatCoverageAmount(Number(policy.amount || 0))}</div>
                  <div className="text-slate-500">{formatDateLabel(policy.createdAt)}</div>
                </button>
              );
            })}
            {!filteredPolicies.length ? (
              <div className="px-4 py-12 text-center">
                <p className="text-sm font-black text-slate-500">没有匹配的保单</p>
                <p className="mt-1 text-xs font-medium text-slate-400">可以换一个手机号、被保人或产品关键词搜索。</p>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {selectedPolicy ? (
        <AdminPolicyDetail
          policy={selectedPolicy}
          onClose={() => onSelectPolicy(null)}
          onRetryReport={onRetryPolicyReport}
          retrying={retryingPolicyId === selectedPolicy.id}
        />
      ) : null}
    </>
  );
}

function formatAdminMobile(mobileValue: string) {
  return String(mobileValue || '').trim() || '未绑定手机号';
}
